
import http from "node:http";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { AUTH_COOKIE_NAME, isAuthEnabled, readCookie, verifyToken } from "./auth";
import {
  AttachCancelledError,
  PtySpawnError,
  TooManyPtysError,
  closeCodeForAttachError,
  describeError,
  recordAttachFailure,
  recordAttachSuccess,
  shortErrorMessage,
  systemClock,
} from "./attachErrors";
import { createAttachBuffer } from "./attachBuffer";
import { registerHeartbeat, startHeartbeat } from "./heartbeat";
import { countSystemDynamicPtys, getPtmxMax } from "./ptyCapacity";
import { apiRouter } from "./routes";
import { loadState } from "./store";
import { reconcileFrontendPublishOnStartup } from "./updater";
import { bridgeTerminal, closeSocketSafely, getLivePtyCount, validateTerminalSize } from "./terminal";
import type { DashboardState } from "./types";

// Extra diagnostic context appended ONLY to the console line (via recordAttachFailure's lazy
// buildDetail - see attachErrors.ts), never to anything sent to a client - see
// describeError/shortErrorMessage's header comment there for why those two stay separate. The
// system-wide pty snapshot is only worth attaching for the two error shapes it can actually
// explain (PtySpawnError, TooManyPtysError) - appending it to every unrelated failure would
// just be noise. See ptyCapacity.ts for why this snapshot is informational only, never a gate.
function buildFailureDetail(error: unknown): string {
  const parts = [describeError(error)];
  if (error instanceof PtySpawnError || error instanceof TooManyPtysError) {
    const systemDynamicPtys = countSystemDynamicPtys();
    parts.push(
      `systemDynamicPtys=${systemDynamicPtys ?? "unknown"} ptmxMax=${getPtmxMax()} livePtyCount=${getLivePtyCount()}`
    );
  }
  return parts.join(" ");
}

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

// The one frontend pipeline for LAN and tunnel visitors: Caddy proxies straight to this Express
// server (see Caddyfile), which serves whatever updateTransaction.ts most recently published here.
// There is deliberately no Vite dev server in this path anymore - that used to be what LAN/tunnel
// visitors got (Caddy -> Vite), and its client-side HMR reload-on-reconnect is exactly what caused
// a Chrome Android tab to fully reload instead of just reattaching its terminal WebSocket after
// coming back from the background. `localhost:5173` (Vite's own dev server) is still available
// for local development with HMR intact; it is simply no longer what LAN/tunnel requests reach.
const webDistPath: string = path.resolve(import.meta.dirname, "../../web/dist");
app.use(express.static(webDistPath));

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  console.error("[server] unhandled error:", error.message);
  response.status(500).json({ error: error.message });
});

// Default is 100 MiB (ws has no cap of its own by default); a single connected tab could
// otherwise allocate an arbitrarily large frame and exhaust the process's memory well before
// any application-level buffering (attachBuffer.ts) even gets a chance to look at it. 1 MiB is
// generous for terminal I/O and JSON control messages - real traffic here is orders of
// magnitude smaller - while bounding the worst case per frame.
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;

const httpServer = http.createServer(app);
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

// EventEmitter contract: an "error" event with no listener throws as an uncaught exception
// instead of just emitting (see Node's EventEmitter docs). Neither of these two servers had
// one, so a bind failure (EADDRINUSE) or an internal ws server error used to be able to crash
// the whole process outright. httpServer's failure mode gets an explicit policy instead of
// silent tolerance: a process that failed to bind its port but kept running would look alive
// to a supervisor (or npm run dev) while serving nothing, which is worse than a clean crash a
// supervisor can actually restart from.
httpServer.on("error", (error: Error) => {
  console.error("[server] fatal http server error:", error.message);
  process.exit(1);
});
webSocketServer.on("error", (error: Error) => {
  console.error("[server] websocket server error:", error.message);
});

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
  // Shared with every live "resize" message (see validateTerminalSize in terminal.ts): this
  // used to only reject non-finite values (Number.isInteger(Infinity) is false, so that half
  // was already safe) but had no upper bound at all, so an attacker/buggy client could still
  // request an enormous initial pty geometry straight into nodePty.spawn.
  const initialSize = validateTerminalSize(
    Number(requestUrl.searchParams.get("cols")),
    Number(requestUrl.searchParams.get("rows"))
  );

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
      // ws's own EventEmitter throws an uncaught exception for an "error" event with no
      // listener (see MAX_WS_PAYLOAD_BYTES's comment above and Node's EventEmitter docs).
      // Registered here, at the earliest point a socket is guaranteed to exist (same
      // reasoning as registerHeartbeat right above), so it covers failures during the whole
      // rest of this callback, not just once bridgeTerminal is running. This handler does
      // NOT attempt its own recovery: ws already emits "close" right after any "error" (see
      // emitErrorAndClose in ws/lib/websocket.js), and that "close" is what already drives
      // stopBuffering above and pty release inside bridgeTerminal - its only job is to exist,
      // so the event has a listener and Node does not escalate it to a process crash, plus
      // leave one throttled log line so a real bug is still visible.
      webSocket.on("error", (error: Error) => {
        const failureMessage = recordAttachFailure(instanceId, shortErrorMessage(error), systemClock, () =>
          describeError(error)
        );
        if (failureMessage !== null) {
          console.error(`[server] ${failureMessage}`);
        }
      });
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
          closeSocketSafely(webSocket, INPUT_OVERFLOW_CLOSE_CODE, INPUT_OVERFLOW_REASON);
        }
      };
      webSocket.on("message", bufferMessage);

      void (async () => {
        const state: DashboardState = await loadState();
        const instance = state.instances.find((candidate) => candidate.id === instanceId);
        if (instance === undefined) {
          stopBuffering();
          closeSocketSafely(webSocket, 4004, "Unknown instance");
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
        // many concurrent tabs) this fails - see recordAttachFailure in attachErrors.ts. The
        // short message is what both the visible log line and the close reason use;
        // buildFailureDetail's richer output (stack, code, attempt history, and - for a
        // PtySpawnError/TooManyPtysError - the system-wide pty snapshot) is console-only, see
        // its own comment above.
        const shortMessage = shortErrorMessage(error);
        const failureMessage = recordAttachFailure(instanceId, shortMessage, systemClock, () => buildFailureDetail(error));
        if (failureMessage !== null) {
          console.error(`[server] ${failureMessage}`);
        }
        const closeCode = closeCodeForAttachError(error);
        // closeSocketSafely truncates by UTF-8 bytes, not JS string length - see its comment
        // in attachErrors.ts for why a plain slice() here used to be able to make close()
        // itself throw (RangeError from ws) for any error message containing a multi-byte
        // path segment, turning this recoverable-failure handler into an unhandled rejection.
        closeSocketSafely(webSocket, closeCode, shortMessage);
      });
    });
  }
});

httpServer.listen(serverPort, serverHost, () => {
  console.log(`[server] listening on http://${serverHost}:${serverPort}`);
  // Deliberately AFTER listen(), not before: Express must start accepting requests against
  // whatever is already in web/dist - stale or not - rather than block startup on a build. This is
  // also what makes a transaction interrupted by a `tsx` restart self-heal with no user action:
  // see updateTransaction.ts's header comment and updater.ts's reconcileFrontendPublishOnStartup.
  void reconcileFrontendPublishOnStartup();
});
