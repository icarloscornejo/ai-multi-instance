
import http from "node:http";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { AUTH_COOKIE_NAME, isAuthEnabled, readCookie, verifyToken } from "./auth";
import { AttachCancelledError, closeCodeForAttachError, recordAttachFailure, recordAttachSuccess } from "./attachErrors";
import { createAttachBuffer } from "./attachBuffer";
import { registerHeartbeat, startHeartbeat } from "./heartbeat";
import { apiRouter } from "./routes";
import { loadState } from "./store";
import { bridgeTerminal } from "./terminal";
import type { DashboardState } from "./types";

// Close code for "the pre-attach input buffer overflowed" (see attachBuffer.ts). Deliberately
// NOT one of the codes closeCodeForAttachError produces: an overflow is not an attach
// failure - the attach could well have succeeded moments later - so it must not feed the
// client's slow attachStreak backoff (see web/src/reconnectPolicy.ts). It gets the normal
// reconnect cadence instead.
const INPUT_OVERFLOW_CLOSE_CODE = 4007;
const INPUT_OVERFLOW_REASON = "Some input was discarded and could not be sent.";

const serverPort: number = Number(process.env.PORT ?? 3001);
const serverHost: string = process.env.HOST ?? "127.0.0.1";

const app = express();
app.use(express.json());
app.use("/api", apiRouter);

// Fallback only: LAN traffic and the tunnel both go through Caddy -> Vite (see Caddyfile,
// server/src/tunnel.ts), so this pre-built web/dist is reached only by hitting this port
// directly. Kept for that case rather than removed outright; the self-update flow
// (updater.ts) does not rebuild it, so it can go stale.
const webDistPath: string = path.resolve(import.meta.dirname, "../../web/dist");
app.use(express.static(webDistPath));

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  console.error("[server] unhandled error:", error.message);
  response.status(500).json({ error: error.message });
});

const httpServer = http.createServer(app);
const webSocketServer = new WebSocketServer({ noServer: true });

// See heartbeat.ts for what this does and why it MUST be called from the upgrade site below
// (completeUpgrade's handleUpgrade callback) rather than a webSocketServer.on("connection", ...)
// handler: this server is always { noServer: true }, and ws never emits "connection" in that
// mode, so a "connection" handler here would silently never run while wss.clients (populated
// independently via clientTracking) fills up anyway - every socket would then read as dead on
// the first heartbeat sweep and get terminated, regardless of whether it's actually alive.
const WS_HEARTBEAT_INTERVAL_MS = 15_000;
startHeartbeat(webSocketServer, WS_HEARTBEAT_INTERVAL_MS);

httpServer.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const pathMatch = requestUrl.pathname.match(/^\/ws\/terminal\/([\w-]+)$/);
  if (pathMatch === null) {
    socket.destroy();
    return;
  }
  const instanceId: string = pathMatch[1];
  const requestedCols: number = Number(requestUrl.searchParams.get("cols"));
  const requestedRows: number = Number(requestUrl.searchParams.get("rows"));
  const initialSize =
    Number.isInteger(requestedCols) && Number.isInteger(requestedRows) && requestedCols > 0 && requestedRows > 0
      ? { cols: requestedCols, rows: requestedRows }
      : null;

  void (async () => {
    // The WS upgrade is the real attack surface (it reads/writes the terminal
    // directly), so it needs the same cookie check as the REST API even though
    // the static HTML/assets stay open.
    if (isAuthEnabled()) {
      const token: string | undefined = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
      const isValid: boolean = await verifyToken(token);
      if (!isValid) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    completeUpgrade();
  })().catch((error: Error) => {
    console.error("[server] failed to authorize websocket upgrade:", error.message);
    socket.destroy();
  });

  function completeUpgrade(): void {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket: WebSocket) => {
      registerHeartbeat(webSocket);
      // bridgeTerminal performs several awaits (loadState here, and ensureSessionReady/
      // spawnWithRetry inside) before it can hook into live messages; the client may send
      // its initial "resize" (and even type, and its immediate onopen ping - see
      // TerminalView.tsx) throughout that window. "ws" does not buffer messages for an
      // EventEmitter with no listener: without this synchronous buffer (which stays active
      // until stopBuffering below detaches it), that first resize is lost forever and the
      // pty keeps the fallback size (see terminal.ts) until the client triggers the next
      // real resize. attachBuffer also caps how much can accumulate here (see
      // attachBuffer.ts) - unlike the raw array this replaces, an attach stuck for a long
      // time (a hung tmux command, see runTmux's timeout) no longer buffers unbounded input.
      const attachBuffer = createAttachBuffer();
      let bufferingActive = true;
      // Idempotent by design: called from the overflow path below, from the instance-not-
      // found branch, from bridgeTerminal's own success path, AND from the catch below on
      // every failure/cancellation - covering every exit path this attach can take, not
      // just the happy one (a preexisting gap: the old code only removed this listener on
      // success, so a failed attach left it attached and the buffer growing unbounded for
      // as long as the client kept retrying).
      const stopBuffering = (): void => {
        if (bufferingActive) {
          bufferingActive = false;
          webSocket.removeListener("message", bufferMessage);
        }
      };
      const bufferMessage = (rawMessage: RawData): void => {
        const accepted = attachBuffer.add(rawMessage);
        if (!accepted) {
          stopBuffering();
          webSocket.close(INPUT_OVERFLOW_CLOSE_CODE, INPUT_OVERFLOW_REASON);
        }
      };
      webSocket.on("message", bufferMessage);

      void (async () => {
        const state: DashboardState = await loadState();
        const instance = state.instances.find((candidate) => candidate.id === instanceId);
        if (instance === undefined) {
          stopBuffering();
          webSocket.close(4004, "Unknown instance");
          return;
        }
        await bridgeTerminal(webSocket, instance, initialSize, attachBuffer, stopBuffering);
        const recoveryMessage = recordAttachSuccess(instanceId);
        if (recoveryMessage !== null) {
          console.log(`[server] ${recoveryMessage}`);
        }
      })().catch((error: Error) => {
        stopBuffering();
        if (error instanceof AttachCancelledError) {
          // The socket is already gone (this is only thrown once isStillWanted() is
          // false) - typically because the overflow handler above already closed it with
          // its own code/reason. Nothing further to log or close here.
          return;
        }
        // Logged at most once per minute per instance regardless of how many times (or how
        // many concurrent tabs) this fails - see recordAttachFailure in attachErrors.ts.
        const failureMessage = recordAttachFailure(instanceId, error.message);
        if (failureMessage !== null) {
          console.error(`[server] ${failureMessage}`);
        }
        const closeCode = closeCodeForAttachError(error);
        webSocket.close(closeCode, error.message.slice(0, 120));
      });
    });
  }
});

httpServer.listen(serverPort, serverHost, () => {
  console.log(`[server] listening on http://${serverHost}:${serverPort}`);
});
