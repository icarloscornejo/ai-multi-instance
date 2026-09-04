import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { verifyEdge, type TunnelStatus } from "./tunnel";

// The opt-in remote-access backend: a Cloudflare Named Tunnel bound to a stable hostname the
// user owns, run as its own launchd LaunchAgent (com.ai-multi-instance.tunnel) that survives
// restarts of this Node process and of the machine. This module never spawns cloudflared
// itself - launchd owns that process and its restarts. All this module does is:
//   - decide whether named mode is active at all (loadNamedTunnelConfig)
//   - express start/stop intent by writing/removing the `enabled` sentinel that the plist's
//     KeepAlive.PathState watches, plus a launchctl kickstart/kill to act on it immediately
//   - report status by reading cloudflared's local /ready endpoint and then verifying the
//     public URL actually serves this app (reusing tunnel.ts's verifyEdge)
//
// Provisioning (creating the tunnel, the DNS route, config.yml and tunnel.json) is done once
// by scripts/setup-named-tunnel.sh; installing the LaunchAgent is scripts/install-tunnel-service.sh.

const dataDirectory: string = path.resolve(import.meta.dirname, "../../data");
const namedTunnelDirectory: string = path.join(dataDirectory, "named-tunnel");
const configFilePath: string = path.join(namedTunnelDirectory, "tunnel.json");
const sentinelFilePath: string = path.join(namedTunnelDirectory, "enabled");

export const LAUNCHD_LABEL = "com.ai-multi-instance.tunnel";

export interface NamedTunnelConfig {
  hostname: string;
  tunnelName: string;
  tunnelId: string;
  credentialsFile: string;
  metricsPort: number;
  protocol: "auto" | "quic" | "http2";
}

// "absent" is the ONLY result that selects quick mode. Every other outcome - malformed JSON,
// a missing field, a bad port, an unreadable file - is a misconfiguration that must fail
// closed as a named-mode error, never silently fall back to spinning up a *different* public
// endpoint (a quick trycloudflare.com URL) the user didn't ask for. This is a deliberate
// departure from auth.ts's loadStoredPassword(), whose catch-all-to-null is correct for an
// absent password and would be dangerous here.
export type NamedTunnelConfigResult =
  | { kind: "absent" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; config: NamedTunnelConfig };

// Read fresh every call, no process-lifetime cache: tunnel.json is a ~280-byte file read only
// from the tunnel status/start/stop paths (polled every 1-5s at most), and reading it live is
// what lets `scripts/setup-named-tunnel.sh` switch the dashboard into named mode without a
// server restart. getTunnelMode() below, which DOES run on every /api request, uses a cheap
// existsSync instead of this full read+parse.
export function loadNamedTunnelConfig(): NamedTunnelConfigResult {
  return readConfig();
}

function readConfig(): NamedTunnelConfigResult {
  let raw: string;
  try {
    raw = readFileSync(configFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    return { kind: "invalid", error: `Could not read ${configFilePath}: ${(error as Error).message}` };
  }
  return validateNamedTunnelConfig(raw);
}

export function validateNamedTunnelConfig(raw: string): NamedTunnelConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", error: "tunnel.json is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "invalid", error: "tunnel.json must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  for (const field of ["hostname", "tunnelName", "tunnelId", "credentialsFile"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      return { kind: "invalid", error: `tunnel.json: "${field}" is missing or empty` };
    }
  }
  const metricsPort = record.metricsPort;
  if (typeof metricsPort !== "number" || !Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535) {
    return { kind: "invalid", error: 'tunnel.json: "metricsPort" must be a valid port number' };
  }
  const protocol = record.protocol;
  if (protocol !== "auto" && protocol !== "quic" && protocol !== "http2") {
    return { kind: "invalid", error: 'tunnel.json: "protocol" must be "auto", "quic", or "http2"' };
  }
  return {
    kind: "ok",
    config: {
      hostname: record.hostname as string,
      tunnelName: record.tunnelName as string,
      tunnelId: record.tunnelId as string,
      credentialsFile: record.credentialsFile as string,
      metricsPort,
      protocol,
    },
  };
}

// Runs on every /api request (routes.ts's fail-closed middleware) and every WS upgrade, so it
// stays a bare existsSync rather than a read+parse. A tunnel.json that exists but is malformed
// still counts as "named" here - loadNamedTunnelConfig() then surfaces the specific error and
// the status/start paths fail closed, which is the whole point of not falling back to quick.
export function getTunnelMode(): "quick" | "named" {
  return existsSync(configFilePath) ? "named" : "quick";
}

// ---- cloudflared /ready ----------------------------------------------------------------

export interface ReadyResult {
  // true once the connector has at least one live edge connection
  ok: boolean;
  readyConnections: number;
}

export function classifyReady(httpStatus: number | undefined, body: string): ReadyResult {
  if (httpStatus !== 200) {
    return { ok: false, readyConnections: 0 };
  }
  try {
    const parsed = JSON.parse(body) as { readyConnections?: unknown };
    const count: number = typeof parsed.readyConnections === "number" ? parsed.readyConnections : 0;
    return { ok: count > 0, readyConnections: count };
  } catch {
    return { ok: false, readyConnections: 0 };
  }
}

const READY_TIMEOUT_MS = 3_000;

async function fetchReady(metricsPort: number): Promise<ReadyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READY_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${metricsPort}/ready`, { signal: controller.signal });
    return classifyReady(response.status, await response.text());
  } catch {
    return { ok: false, readyConnections: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---- launchctl -----------------------------------------------------------------------

function currentUid(): number {
  // process.getuid is absent on Windows; this module is macOS-only (launchd), so the ?? 0
  // is only there to satisfy the type checker.
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

export function buildKickstartArgs(uid: number): string[] {
  return ["kickstart", `gui/${uid}/${LAUNCHD_LABEL}`];
}

export function buildKillArgs(uid: number): string[] {
  return ["kill", "SIGTERM", `gui/${uid}/${LAUNCHD_LABEL}`];
}

const LAUNCHCTL_TIMEOUT_MS = 5_000;

function runLaunchctl(args: string[]): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("launchctl", args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`launchctl ${args[0]} timed out after ${LAUNCHCTL_TIMEOUT_MS}ms`));
    }, LAUNCHCTL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

// ---- sentinel -----------------------------------------------------------------------

async function sentinelExists(): Promise<boolean> {
  try {
    await fs.access(sentinelFilePath);
    return true;
  } catch {
    return false;
  }
}

async function writeSentinel(): Promise<void> {
  await fs.mkdir(namedTunnelDirectory, { recursive: true });
  await fs.writeFile(sentinelFilePath, "", "utf8");
}

async function removeSentinel(): Promise<void> {
  await fs.rm(sentinelFilePath, { force: true });
}

// ---- status / start / stop --------------------------------------------------------------

function namedStatus(
  state: TunnelStatus["state"],
  url: string | null,
  error: string | null,
  warning: string | null
): TunnelStatus {
  return { mode: "named", state, phase: null, url, error, warning };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single-flight guard: overlapping start requests (double-click, a poll racing a click)
// share one in-flight promise instead of each firing their own kickstart.
let startInFlight: Promise<TunnelStatus> | null = null;

export async function getNamedTunnelStatus(): Promise<TunnelStatus> {
  if (startInFlight !== null) {
    return namedStatus("starting", null, null, null);
  }
  return computeStatus();
}

async function computeStatus(): Promise<TunnelStatus> {
  const result: NamedTunnelConfigResult = loadNamedTunnelConfig();
  if (result.kind === "invalid") {
    return namedStatus("error", null, result.error, null);
  }
  if (result.kind === "absent") {
    // Not expected: callers dispatch on getTunnelMode(). Be defensive.
    return namedStatus("stopped", null, null, null);
  }
  const { hostname, metricsPort } = result.config;
  const publicUrl = `https://${hostname}`;

  if (!(await sentinelExists())) {
    return namedStatus("stopped", null, null, null);
  }

  const ready: ReadyResult = await fetchReady(metricsPort);
  if (!ready.ok) {
    // Sentinel is set (someone asked for it up) but the connector has no ready edge
    // connections yet - launchd is (re)starting it, or it can't reach the edge.
    return namedStatus("starting", publicUrl, null, "The connector has no ready edge connections yet.");
  }

  const haWarning: string | null =
    ready.readyConnections < 4 ? `Only ${ready.readyConnections} of 4 edge connections are up.` : null;

  // /ready only proves the connector reached the edge. It says nothing about DNS, ingress,
  // TLS, or whether 127.0.0.1:3001 is actually answering. Verify the public URL serves THIS
  // app, exactly as the quick tunnel does.
  const edge = await verifyEdge(publicUrl, () => undefined);
  if (edge.outcome === "bad-response") {
    return namedStatus(
      "error",
      publicUrl,
      `The public URL isn't serving the dashboard (status ${edge.status ?? "?"}). Check DNS and the tunnel ingress.`,
      null
    );
  }
  if (edge.outcome === "transport-error") {
    return namedStatus(
      "running",
      publicUrl,
      null,
      haWarning ?? "The connector is up, but this machine couldn't reach the public URL. It may still work from other networks."
    );
  }
  return namedStatus("running", publicUrl, null, haWarning);
}

const START_READY_DEADLINE_MS = 15_000;
const STOP_DRAIN_DEADLINE_MS = 10_000;

export async function startNamedTunnel(): Promise<TunnelStatus> {
  if (startInFlight !== null) {
    return startInFlight;
  }
  startInFlight = doStart();
  try {
    return await startInFlight;
  } finally {
    startInFlight = null;
  }
}

async function doStart(): Promise<TunnelStatus> {
  const result: NamedTunnelConfigResult = loadNamedTunnelConfig();
  if (result.kind !== "ok") {
    return computeStatus();
  }
  await writeSentinel();
  try {
    const { code } = await runLaunchctl(buildKickstartArgs(currentUid()));
    if (code !== 0) {
      throw new Error(
        `launchctl kickstart exited ${code}. Is the tunnel service installed? Run: npm run tunnel:install`
      );
    }
  } catch (error) {
    // A failed start must not leave the sentinel behind: with it present, launchd's
    // KeepAlive.PathState would keep trying to run a job that isn't there.
    await removeSentinel();
    return namedStatus("error", null, `Could not start the tunnel: ${(error as Error).message}`, null);
  }

  const deadline: number = Date.now() + START_READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if ((await fetchReady(result.config.metricsPort)).ok) {
      break;
    }
    await sleep(1_000);
  }
  return computeStatus();
}

export async function stopNamedTunnel(): Promise<TunnelStatus> {
  // Remove the sentinel FIRST so KeepAlive.PathState won't immediately relaunch what the
  // kill below is about to terminate. This also makes a UI "stop" persist across reboot -
  // launchd only starts the job while the sentinel exists.
  await removeSentinel();
  try {
    await runLaunchctl(buildKillArgs(currentUid()));
  } catch {
    // kill fails when the job isn't loaded/running, which is the desired end state anyway.
  }

  const result: NamedTunnelConfigResult = loadNamedTunnelConfig();
  if (result.kind === "ok") {
    const deadline: number = Date.now() + STOP_DRAIN_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (!(await fetchReady(result.config.metricsPort)).ok) {
        break;
      }
      await sleep(500);
    }
  }
  return computeStatus();
}
