import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

// Mirrors auth.ts/store.ts's data directory; cloudflared's own stdout+stderr (not just the
// truncated tail this module keeps for parsing the URL) is kept here so a failure that
// happens after the tunnel is already reported "running" (edge disconnects, protocol
// fallback issues, etc.) leaves something inspectable instead of vanishing with the process.
const dataDirectory: string = path.resolve(import.meta.dirname, "../../data");
const logFilePath: string = path.join(dataDirectory, "cloudflared.log");

export type TunnelState = "stopped" | "starting" | "running" | "error";

export interface TunnelStatus {
  state: TunnelState;
  url: string | null;
  error: string | null;
}

const TRYCLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// cloudflared writes its startup log (including the assigned URL) to stderr, not stdout
export function extractTunnelUrl(output: string): string | null {
  const match = output.match(TRYCLOUDFLARE_URL_PATTERN);
  return match === null ? null : match[0];
}

const START_TIMEOUT_MS = 20_000;

const status: TunnelStatus = { state: "stopped", url: null, error: null };
let child: ChildProcess | null = null;
let startPromise: Promise<TunnelStatus> | null = null;

export function getTunnelStatus(): TunnelStatus {
  return { ...status };
}

export function startTunnel(port: number): Promise<TunnelStatus> {
  if (startPromise !== null) {
    return startPromise;
  }
  if (status.state === "running") {
    return Promise.resolve(getTunnelStatus());
  }

  status.state = "starting";
  status.url = null;
  status.error = null;

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
      "--url",
      `http://localhost:${port}`,
    ]);
    child = cloudflared;
    let stderrTail = "";
    let settled = false;

    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(logFilePath, `--- cloudflared started ${new Date().toISOString()} ---\n`);
    const appendToLogFile = (chunk: Buffer): void => {
      try {
        appendFileSync(logFilePath, chunk);
      } catch {
        // Best-effort logging; never let a disk/permission issue take down the tunnel itself
      }
    };
    cloudflared.stdout?.on("data", appendToLogFile);
    cloudflared.stderr?.on("data", appendToLogFile);

    const finishError = (message: string): void => {
      if (settled) return;
      settled = true;
      status.state = "error";
      status.url = null;
      status.error = message;
      child = null;
      startPromise = null;
      resolve(getTunnelStatus());
    };

    const finishRunning = (url: string): void => {
      if (settled) return;
      settled = true;
      status.state = "running";
      status.url = url;
      status.error = null;
      startPromise = null;
      resolve(getTunnelStatus());
    };

    const timer = setTimeout(() => {
      finishError("Timed out waiting for cloudflared to report a tunnel URL.");
    }, START_TIMEOUT_MS);

    cloudflared.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      const url: string | null = extractTunnelUrl(stderrTail);
      if (url !== null) {
        clearTimeout(timer);
        finishRunning(url);
      }
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
      // Was running and died on its own (network blip, killed externally, etc.)
      child = null;
      status.state = "stopped";
      status.url = null;
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
  status.url = null;
  status.error = null;
  return getTunnelStatus();
}

// Do not leave an orphaned cloudflared process running after the dashboard server exits
process.on("exit", () => {
  child?.kill();
});
