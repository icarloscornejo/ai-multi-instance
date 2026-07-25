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

// Caddy's HTTP listener (see Caddyfile, started by setup.sh). The tunnel points here, not at
// the Express server on PORT/3001: Express only ever serves the (possibly stale) web/dist
// build, while Caddy proxies to Vite, the same upstream the LAN/ai.local path uses. This is
// what keeps a public tunnel visitor and a LAN visitor looking at identical frontend code.
const CADDY_HTTP_PORT: number = Number(process.env.CADDY_HTTP_PORT ?? 80);
const CADDY_PREFLIGHT_TIMEOUT_MS = 2_000;

// If Caddy isn't running, cloudflared still starts and reports a URL happily; the failure
// only shows up as a 502 once someone actually opens that URL, with nothing in this app's UI
// pointing at the real cause. Check first so startTunnel can fail with an actionable message
// instead of a "running" status that lies.
function checkCaddyReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port: CADDY_HTTP_PORT, path: "/", headers: { Host: "ai.local" }, timeout: CADDY_PREFLIGHT_TIMEOUT_MS },
      (response) => {
        response.resume();
        resolve(true);
      }
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => {
      resolve(false);
    });
  });
}

export async function startTunnel(): Promise<TunnelStatus> {
  if (startPromise !== null) {
    return startPromise;
  }
  if (status.state === "running") {
    return getTunnelStatus();
  }

  status.state = "starting";
  status.url = null;
  status.error = null;

  const caddyReachable: boolean = await checkCaddyReachable();
  if (!caddyReachable) {
    status.state = "error";
    status.error = `Caddy isn't responding on 127.0.0.1:${CADDY_HTTP_PORT}. Start it with: brew services start caddy`;
    return getTunnelStatus();
  }

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
