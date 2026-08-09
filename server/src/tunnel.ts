import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

// Mirrors auth.ts/store.ts's data directory; cloudflared's own stdout+stderr (not just the
// truncated tail this module keeps for parsing the URL) is kept here so a failure that
// happens after the tunnel is already reported "running" (edge disconnects, protocol
// fallback issues, etc.) leaves something inspectable instead of vanishing with the process.
const dataDirectory: string = path.resolve(import.meta.dirname, "../../data");
const logFilePath: string = path.join(dataDirectory, "cloudflared.log");

export type TunnelState = "stopped" | "starting" | "running" | "error";

// Only meaningful while state === "starting"; every terminal transition (running, error,
// stopped) resets this to null so the UI's step list never shows a stale step.
export type TunnelPhase = "checking-caddy" | "launching" | "verifying";

export interface TunnelStatus {
  state: TunnelState;
  phase: TunnelPhase | null;
  url: string | null;
  error: string | null;
  // Set only for the inconclusive edge-verify outcome (see finishRunning): the tunnel is
  // "running" and this is not an error, just something the UI should say without the red
  // error styling. Kept separate from `error` so a real failure and a shrug can't collide
  // in the same field.
  warning: string | null;
}

const TRYCLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// cloudflared writes its startup log (including the assigned URL) to stderr, not stdout
export function extractTunnelUrl(output: string): string | null {
  const match = output.match(TRYCLOUDFLARE_URL_PATTERN);
  return match === null ? null : match[0];
}

const START_TIMEOUT_MS = 20_000;

const status: TunnelStatus = { state: "stopped", phase: null, url: null, error: null, warning: null };
let child: ChildProcess | null = null;
let startPromise: Promise<TunnelStatus> | null = null;

export function getTunnelStatus(): TunnelStatus {
  return { ...status };
}

// Caddy's HTTP listener (see Caddyfile, started by setup.sh). The tunnel points here, not at
// the Express server on PORT/3001: Express only ever serves the (possibly stale) web/dist
// build, while Caddy proxies to Vite, the same upstream the LAN/ai.local path uses. This is
// what keeps a public tunnel visitor and a LAN visitor looking at identical frontend code.
const CADDY_HTTP_PORT: number = Number(process.env.CADDY_HTTP_PORT ?? 80);
const CADDY_PREFLIGHT_TIMEOUT_MS = 2_000;

// If Caddy isn't running, or is running but its upstream (Vite) isn't, cloudflared still
// starts and reports a URL happily; the failure only shows up as a blank/502 page once
// someone actually opens that URL, with nothing in this app's UI pointing at the real cause.
// Check first so startTunnel can fail with an actionable message instead of a "running"
// status that lies. Distinguishing "Caddy down" from "Caddy up, Vite down" from "Caddy up,
// but not proxying to our Vite at all" matters because they point at three different fixes
// (brew services, npm run dev, or a stale/wrong Caddyfile).
type CaddyPreflightResult = "ok" | "caddy-down" | "upstream-down" | "wrong-origin";

const PREFLIGHT_BODY_CAP_BYTES = 8_192;

// Pure so it's testable without sockets: given the raw response status and a body snippet
// (already capped), decide which of the four outcomes this preflight hit. 502/503/504 are
// Caddy's own responses when reverse_proxy can't reach Vite; anything else that isn't a 200
// serving our actual app shell (web/index.html has both markers) means Caddy answered but
// isn't fronting this app's Vite (wrong config, stale build, unrelated service on the port).
export function classifyPreflight(status: number | undefined, bodySnippet: string): CaddyPreflightResult {
  if (status !== undefined && status >= 502 && status <= 504) {
    return "upstream-down";
  }
  if (status === 200 && bodySnippet.includes('<div id="root">') && bodySnippet.includes("/src/main.tsx")) {
    return "ok";
  }
  return "wrong-origin";
}

interface CaddyPreflight {
  result: CaddyPreflightResult;
  status: number | undefined;
  bodySnippet: string;
}

function checkCaddyReachable(): Promise<CaddyPreflight> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CaddyPreflightResult, status?: number, bodySnippet = ""): void => {
      if (settled) return;
      settled = true;
      resolve({ result, status, bodySnippet });
    };

    const request = http.get(
      { host: "127.0.0.1", port: CADDY_HTTP_PORT, path: "/", headers: { Host: "ai.local" } },
      (response) => {
        clearTimeout(connectTimer);
        let body = "";
        response.on("data", (chunk: Buffer) => {
          if (body.length < PREFLIGHT_BODY_CAP_BYTES) {
            body += chunk.toString();
          }
        });
        response.on("end", () => {
          const snippet = body.slice(0, PREFLIGHT_BODY_CAP_BYTES);
          finish(classifyPreflight(response.statusCode, snippet), response.statusCode, snippet);
        });
      }
    );
    // Guards only the connect phase: a Caddy that never accepts the TCP connection reads as
    // caddy-down. Once connected, a slow-to-respond Vite is a real "ok"-or-not answer we want
    // to wait for rather than misreport as caddy-down, so this timer is cleared as soon as the
    // response headers arrive.
    const connectTimer = setTimeout(() => {
      request.destroy();
      finish("caddy-down");
    }, CADDY_PREFLIGHT_TIMEOUT_MS);
    request.on("error", () => {
      clearTimeout(connectTimer);
      finish("caddy-down");
    });
  });
}

// After cloudflared prints a URL, fetch it back before ever reporting "running": the URL is
// registered with the edge as soon as it's printed, but that says nothing about whether the
// edge can actually reach Caddy through this specific tunnel, only that cloudflared connected
// somewhere. Two attempts, not more: cloudflared.log shows the connection can still be
// registering ~1s after the URL is printed, so a single retry absorbs that race, but on a
// machine where this fetch fails (confirmed: 6x "fetch failed" back to back in that same log),
// every extra attempt just re-confirms the same transport error at the cost of real wall-clock
// time on every tunnel start.
const EDGE_VERIFY_ATTEMPT_TIMEOUT_MS = 3_000;
const EDGE_VERIFY_BACKOFFS_MS = [1_500];

type EdgeVerifyResult =
  | { outcome: "ok" }
  | { outcome: "transport-error"; message: string }
  | { outcome: "bad-response"; status: number | undefined; bodySnippet: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyEdgeOnce(url: string): Promise<EdgeVerifyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDGE_VERIFY_ATTEMPT_TIMEOUT_MS);
  try {
    // redirect: "manual" because nothing in this stack (Caddy, Vite) issues a redirect for
    // GET /; an unexpected 3xx should fail verification rather than be silently followed.
    const response = await fetch(url, { redirect: "manual", cache: "no-store", signal: controller.signal });
    const body: string = (await response.text()).slice(0, PREFLIGHT_BODY_CAP_BYTES);
    if (classifyPreflight(response.status, body) === "ok") {
      return { outcome: "ok" };
    }
    return { outcome: "bad-response", status: response.status, bodySnippet: body };
  } catch (error) {
    return { outcome: "transport-error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// A transport error here (DNS not resolved yet, captive portal, this machine's own network
// being flaky) says nothing about whether the tunnel works for anyone else, so it is retried
// and, if still unresolved, treated as inconclusive rather than a failure by the caller. A bad
// HTTP response (wrong status, missing app-shell markers) is definitive and returned immediately.
async function verifyEdge(url: string, log: (line: string) => void): Promise<EdgeVerifyResult> {
  let lastResult: EdgeVerifyResult = { outcome: "transport-error", message: "no attempts made" };
  for (let attempt = 0; attempt <= EDGE_VERIFY_BACKOFFS_MS.length; attempt++) {
    lastResult = await verifyEdgeOnce(url);
    if (lastResult.outcome === "ok") {
      log(`edge verification attempt ${attempt + 1}: ok`);
      return lastResult;
    }
    if (lastResult.outcome === "bad-response") {
      log(`edge verification attempt ${attempt + 1}: bad-response status=${lastResult.status ?? "?"}`);
      return lastResult;
    }
    log(`edge verification attempt ${attempt + 1}: transport-error: ${lastResult.message}`);
    if (attempt < EDGE_VERIFY_BACKOFFS_MS.length) {
      await sleep(EDGE_VERIFY_BACKOFFS_MS[attempt]);
    }
  }
  return lastResult;
}

export async function startTunnel(): Promise<TunnelStatus> {
  if (startPromise !== null) {
    return startPromise;
  }
  if (status.state === "running") {
    return getTunnelStatus();
  }

  status.state = "starting";
  status.phase = "checking-caddy";
  status.url = null;
  status.error = null;
  status.warning = null;

  const caddyPreflight: CaddyPreflight = await checkCaddyReachable();
  if (caddyPreflight.result === "caddy-down") {
    status.state = "error";
    status.phase = null;
    status.error = `Caddy isn't responding on 127.0.0.1:${CADDY_HTTP_PORT}. Start it with: brew services start caddy`;
    return getTunnelStatus();
  }
  if (caddyPreflight.result === "upstream-down") {
    status.state = "error";
    status.phase = null;
    status.error = "Caddy is running but the dashboard's dev server isn't responding behind it. Start it with: npm run dev";
    return getTunnelStatus();
  }
  if (caddyPreflight.result === "wrong-origin") {
    status.state = "error";
    status.phase = null;
    status.error = `Caddy on 127.0.0.1:${CADDY_HTTP_PORT} isn't serving this app (status ${caddyPreflight.status ?? "?"}): ${caddyPreflight.bodySnippet.slice(0, 200)}`;
    return getTunnelStatus();
  }

  status.phase = "launching";

  startPromise = new Promise<TunnelStatus>((resolve) => {
    // QUIC (cloudflared's default) is UDP-based and gets silently blocked or throttled by
    // a lot of mobile-hotspot/carrier NATs; the tunnel then reports a URL but never actually
    // connects, with no error surfaced anywhere (see the finishError/finishRunning split
    // below: cloudflared only fails loudly if it dies before printing a URL). http2 runs
    // over a plain TCP/TLS connection instead, which those networks don't interfere with.
    const cloudflared: ChildProcess = spawn("cloudflared", [
      "tunnel",
      "--protocol",
      "http2",
      // Caddy's ai.local block requires that exact Host header (see Caddyfile); without
      // this, cloudflared forwards its own *.trycloudflare.com Host and falls through to
      // Caddy's catch-all :80 block instead, which happens to work today only because that
      // block also rewrites the Host itself. Pinning it here doesn't depend on the
      // catch-all block continuing to exist.
      "--http-host-header",
      "ai.local",
      "--url",
      `http://localhost:${CADDY_HTTP_PORT}`,
    ]);
    child = cloudflared;
    let stderrTail = "";
    let settled = false;
    let urlSeen = false;

    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(logFilePath, `--- cloudflared started ${new Date().toISOString()} ---\n`);
    const appendToLogFile = (chunk: Buffer): void => {
      try {
        appendFileSync(logFilePath, chunk);
      } catch {
        // Best-effort logging; never let a disk/permission issue take down the tunnel itself
      }
    };
    const appendLogLine = (line: string): void => {
      appendToLogFile(Buffer.from(`${line}\n`));
    };
    cloudflared.stdout?.on("data", appendToLogFile);
    cloudflared.stderr?.on("data", appendToLogFile);

    const finishError = (message: string): void => {
      if (settled) return;
      settled = true;
      status.state = "error";
      status.phase = null;
      status.url = null;
      status.error = message;
      // cloudflared has no reason to keep running once startTunnel reports error: without
      // this it leaks a live tunnel process that stopTunnel can no longer reach (child is
      // about to be nulled below), pointing at a URL nobody knows is still open.
      child?.kill();
      child = null;
      startPromise = null;
      resolve(getTunnelStatus());
    };

    // warning is set when edge verification hit a transport error (can't reach the public
    // edge from this machine) rather than a bad response: inconclusive, not a failure, so the
    // tunnel stays running and the warning goes in its own field, not status.error, so the UI
    // can render it as informational instead of red.
    const finishRunning = (url: string, warning: string | null = null): void => {
      if (settled) return;
      settled = true;
      status.state = "running";
      status.phase = null;
      status.url = url;
      status.error = null;
      status.warning = warning;
      startPromise = null;
      resolve(getTunnelStatus());
    };

    const timer = setTimeout(() => {
      finishError("Timed out waiting for cloudflared to report a tunnel URL.");
    }, START_TIMEOUT_MS);

    cloudflared.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      if (urlSeen) return;
      const url: string | null = extractTunnelUrl(stderrTail);
      if (url === null) return;
      urlSeen = true;
      clearTimeout(timer);
      // Publish the URL as soon as it's known, before verification finishes: the UI can show
      // it (and the QR) during the "verifying" phase instead of waiting for the whole
      // start/verify round trip, and getTunnelStatus() already returns a fresh copy per call.
      status.url = url;
      status.phase = "verifying";
      appendLogLine(`--- tunnel URL detected: ${url}, verifying it actually serves the app ---`);
      void verifyEdge(url, appendLogLine).then((result) => {
        if (settled) return;
        if (result.outcome === "ok") {
          finishRunning(url);
          return;
        }
        if (result.outcome === "transport-error") {
          finishRunning(
            url,
            "The tunnel is active, but this machine could not verify the public URL. It may still work from your phone or another device."
          );
          return;
        }
        finishError(
          `Tunnel started but isn't serving the dashboard (status ${result.status ?? "?"}): ${result.bodySnippet.slice(0, 200)}`
        );
      });
    });

    cloudflared.on("error", (spawnError: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (spawnError.code === "ENOENT") {
        finishError("cloudflared is not installed. Install it with: brew install cloudflared");
      } else {
        finishError(spawnError.message);
      }
    });

    cloudflared.on("exit", (code: number | null) => {
      clearTimeout(timer);
      if (!settled) {
        // Died before ever reporting a URL
        finishError(`cloudflared exited before starting the tunnel (code ${code}). ${stderrTail.slice(-300)}`);
        return;
      }
      // Was running (or edge-verifying) and died on its own (network blip, killed externally,
      // ha-connections:1 dropping on a flaky network, etc.). Keep the reason instead of
      // discarding stderrTail: with only one edge connection, this is the expected way a
      // hotspot disconnect shows up, and the UI has nowhere else to show why.
      child = null;
      status.state = "stopped";
      status.phase = null;
      status.url = null;
      status.error = stderrTail.trim().length > 0 ? `cloudflared exited unexpectedly (code ${code}). ${stderrTail.slice(-300)}` : null;
      status.warning = null;
    });
  });

  return startPromise;
}

export function readTunnelLog(): string {
  try {
    return readFileSync(logFilePath, "utf8");
  } catch {
    return "";
  }
}

export function stopTunnel(): TunnelStatus {
  if (child !== null) {
    child.kill();
    child = null;
  }
  startPromise = null;
  status.state = "stopped";
  status.phase = null;
  status.url = null;
  status.error = null;
  status.warning = null;
  return getTunnelStatus();
}

// Do not leave an orphaned cloudflared process running after the dashboard server exits
process.on("exit", () => {
  child?.kill();
});
