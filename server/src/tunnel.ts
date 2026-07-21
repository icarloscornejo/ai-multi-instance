import { spawn, type ChildProcess } from "node:child_process";

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
    const cloudflared: ChildProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`]);
    child = cloudflared;
    let stderrTail = "";
    let settled = false;

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
