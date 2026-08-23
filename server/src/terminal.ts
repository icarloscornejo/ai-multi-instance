import * as nodePty from "@lydell/node-pty";
import type { WebSocket, RawData } from "ws";
import type { AttachBuffer } from "./attachBuffer";
import {
  AttachCancelledError,
  LocationMissingError,
  PtySpawnError,
  TooManyPtysError,
  isRetriableSpawnError,
} from "./attachErrors";
import { buildLaunchCommand } from "./launch";
import { pathExists } from "./paths";
import { createSession, enableMouseMode, hasSession, killSession, sendCommandToSession } from "./tmux";
import type { InstanceRecord } from "./types";

// Re-exported so existing importers of terminal.ts (index.ts) don't need to know these moved
// to attachErrors.ts, which had to be dependency-free (see its header comment) for testing.
export { AttachCancelledError, LocationMissingError, PtySpawnError, TooManyPtysError };

interface ClientControlMessage {
  type: "input" | "resize" | "ping";
  data?: string;
  cols?: number;
  rows?: number;
}

// Answers the client's application-level liveness ping (see the heartbeat in TerminalView.tsx)
// with a single empty binary frame. Binary, not text: the client's onmessage only treats
// string frames as terminal output (see terminal.ts's counterpart), so a binary pong is
// silently invisible to the pty stream instead of needing its own message-type parsing there.
const PONG_FRAME = new Uint8Array(0);

interface InitialSize {
  cols: number;
  rows: number;
}

const FALLBACK_COLS = 120;
const FALLBACK_ROWS = 32;

// macOS caps ptys at kern.tty.ptmx_max (511 by default). Refusing new attaches with a
// readable error well below that is the difference between a clear "too many terminals"
// message and every subsequent spawn silently dying with node-pty's opaque
// "posix_spawnp failed." once the real kernel limit is hit. This only guards against THIS
// process's own pty count; it cannot see pressure from other terminals/processes on the
// machine, which is exactly the case spawnWithRetry below (and the 4006 slow-retry path in
// index.ts/reconnectPolicy.ts) exists to recover from automatically.
const MAX_LIVE_PTYS = 480;
let livePtyCount = 0;

// node-pty's IPty type only declares kill(), which sends SIGHUP but leaves the pty's
// master file descriptor open (see UnixTerminal.prototype.kill vs .destroy in
// unixTerminal.js). Only destroy() closes that fd before signaling the shell, so calling
// kill() here was the source of a slow pty fd leak that eventually exhausted
// kern.tty.ptmx_max. destroy() exists on the runtime UnixTerminal instance but isn't part
// of the public IPty interface, hence the cast. Idempotent and safe to call more than
// once per process (double-release from both the race guard and the close handler).
function releasePty(attachProcess: nodePty.IPty): void {
  if ((attachProcess as { _released?: boolean })._released === true) {
    return;
  }
  (attachProcess as { _released?: boolean })._released = true;
  livePtyCount -= 1;
  const destroyable = attachProcess as unknown as { destroy?: () => void };
  if (typeof destroyable.destroy === "function") {
    destroyable.destroy();
  } else {
    attachProcess.kill();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Most spikes in pty pressure (another terminal closing, an unrelated agent process
// exiting) clear within a second or two; retrying the spawn itself inside the same attach
// absorbs that transient case invisibly instead of surfacing a failure the client would
// have to notice and retry on its own. ~2.6s total ceiling across 4 attempts.
export const SPAWN_RETRY_DELAYS_MS: readonly number[] = [300, 800, 1500];

// Wraps a single pty spawn attempt with retry-on-resource-pressure. `spawnAttempt` is called
// synchronously (node-pty's spawn throws synchronously rather than rejecting a promise) and
// may be called more than once. `isStillWanted` is checked before each retry's sleep - not
// before the first attempt, since the caller is expected to have already checked this right
// before calling spawnWithRetry - so a socket that closed while this was sleeping doesn't
// waste a pty attaching for a client that is already gone.
export async function spawnWithRetry(
  spawnAttempt: () => nodePty.IPty,
  isStillWanted: () => boolean,
  delaysMs: readonly number[] = SPAWN_RETRY_DELAYS_MS
): Promise<nodePty.IPty> {
  const maxAttempts = delaysMs.length + 1;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return spawnAttempt();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetriableSpawnError(lastError)) {
        // Not the diagnosed signature (e.g. tmux missing from PATH, a bad cwd): a real
        // configuration/programming problem retrying can never fix. Propagate immediately,
        // unwrapped, instead of silently retrying (and hiding) it for several seconds.
        throw lastError;
      }
      if (attempt === maxAttempts) {
        break;
      }
      if (!isStillWanted()) {
        throw new AttachCancelledError("Attach cancelled while waiting to retry pty spawn");
      }
      await sleep(delaysMs[attempt - 1]);
    }
  }

  throw new PtySpawnError(lastError?.message ?? "pty spawn failed", maxAttempts);
}

// Guards concurrent attaches for the SAME tmux session (multiple browser tabs on one
// instance, or a client retrying while a previous attempt is still mid-init) from racing
// each other through session creation. Keyed by tmuxSession, not instance id, since that's
// what tmux itself keys on. Set synchronously (no `await` between the map lookup and the
// `.set` call below) so two calls arriving back-to-back can never both see it empty: Node's
// single-threaded event loop only lets one of them run until it yields at an `await`, and by
// then the second caller already finds the first's promise in the map.
const sessionInitInFlight = new Map<string, Promise<void>>();

// The whole "create session, launch the provider" sequence is treated as ONE unit for two
// separate reasons:
//
// 1. Cancellation: createSession (tmux.ts, 4 tmux calls) and the sendCommandToSession that
//    launches the provider (2 more tmux calls) are six tmux invocations spread across two
//    functions. If a cancellation check ran between them, a socket closing mid-sequence
//    would leave a tmux session that exists (hasSession would report it alive) but was
//    never handed a provider - every future attach would then see "session alive", skip
//    straight to enableMouseMode, and the user would be permanently stuck looking at an
//    empty shell. So: no cancellation check anywhere inside this function, only before
//    calling it and after it returns (see bridgeTerminal below).
//
// 2. A per-command timeout (see DEFAULT_TMUX_TIMEOUT_MS in tmux.ts) can ALSO fire mid-
//    sequence, with the exact same alive-but-empty consequence, even with no cancellation
//    involved at all: killing tmux's own client process on timeout does not undo commands
//    the tmux SERVER already applied (new-session already ran; only the later provider
//    launch timed out). That failure mode is handled by the catch below: if anything in
//    this sequence throws after the session started existing, the (now-broken) session is
//    killed before the error propagates, so the next attempt - this same caller retrying,
//    or a concurrent one released from the in-flight map below - recreates it from scratch
//    instead of inheriting the empty state.
async function initializeSession(instance: InstanceRecord): Promise<void> {
  try {
    await createSession(instance.tmuxSession, instance.locationPath);
    if (instance.shellOnly !== true) {
      await sendCommandToSession(
        instance.tmuxSession,
        buildLaunchCommand(instance, { resumeSessionId: instance.sessionId ?? undefined })
      );
    }
  } catch (error) {
    try {
      await killSession(instance.tmuxSession);
    } catch {
      // Best-effort: if the session never actually got created (e.g. the very first
      // tmux call itself failed/timed out before "new-session" ran), this just fails
      // harmlessly and there is nothing to clean up.
    }
    throw error;
  }
}

// Ensures the instance's tmux session exists and, if freshly created, has its provider
// launched - joining an already in-flight attempt for the same session instead of racing
// it (see sessionInitInFlight above). A second concurrent attach that read "session alive"
// while the first attempt was still between new-session and the provider launch would
// otherwise skip straight to enableMouseMode and never notice the provider was never
// started.
export async function ensureSessionReady(instance: InstanceRecord): Promise<void> {
  const existing = sessionInitInFlight.get(instance.tmuxSession);
  if (existing !== undefined) {
    return existing;
  }

  const readyPromise = (async () => {
    const sessionAlive = await hasSession(instance.tmuxSession);
    if (sessionAlive) {
      // Migrate sessions that were alive before this change (createSession already
      // enables it for new ones); set-option is idempotent, no cost in repeating it.
      await enableMouseMode(instance.tmuxSession);
      return;
    }
    await initializeSession(instance);
  })();

  sessionInitInFlight.set(instance.tmuxSession, readyPromise);
  try {
    await readyPromise;
  } finally {
    sessionInitInFlight.delete(instance.tmuxSession);
  }
}

export async function bridgeTerminal(
  socket: WebSocket,
  instance: InstanceRecord,
  initialSize: InitialSize | null,
  attachBuffer: AttachBuffer,
  stopBuffering: () => void
): Promise<void> {
  // Locations are validated at instance-creation time (see routes.ts) but never again;
  // a folder deleted, unmounted, or renamed afterward otherwise surfaces as a raw
  // tmux/pty spawn failure instead of a message that explains what actually happened.
  if (!(await pathExists(instance.locationPath))) {
    throw new LocationMissingError(`Folder no longer exists: ${instance.locationPath}`);
  }

  const isStillWanted = (): boolean => socket.readyState === socket.OPEN;

  // Checkpoint before the non-interruptible unit (see initializeSession's comment for why
  // there is no checkpoint inside it): a socket that already closed while we were awaiting
  // pathExists above gets out now instead of paying for a tmux session nobody will use.
  if (!isStillWanted()) {
    throw new AttachCancelledError("Attach cancelled before session initialization");
  }

  await ensureSessionReady(instance);

  // Checkpoint after the non-interruptible unit: the session is now guaranteed either
  // freshly created-with-provider or already alive, so it's safe for the next attach
  // (this retry, or someone else's) to find it ready regardless of what we do next.
  if (!isStillWanted()) {
    throw new AttachCancelledError("Attach cancelled after session initialization");
  }

  if (livePtyCount >= MAX_LIVE_PTYS) {
    throw new TooManyPtysError(
      "Too many open terminals on the server right now; retrying automatically as capacity frees up."
    );
  }

  const attachProcess = await spawnWithRetry(
    () =>
      nodePty.spawn("tmux", ["attach-session", "-t", instance.tmuxSession], {
        name: "xterm-256color",
        cols: initialSize?.cols ?? FALLBACK_COLS,
        rows: initialSize?.rows ?? FALLBACK_ROWS,
        cwd: instance.locationPath,
        env: process.env as Record<string, string>,
      }),
    isStillWanted
  );
  livePtyCount += 1;

  // Registered immediately, with no await in between: if the WS already closed while we
  // were awaiting ensureSessionReady/spawnWithRetry above, this still catches it
  // and releases the pty instead of leaking it. Re-registered as a no-op-safe handler
  // below once the rest of the bridge is wired up (releasePty is idempotent).
  socket.on("close", () => releasePty(attachProcess));

  if (socket.readyState !== socket.OPEN) {
    releasePty(attachProcess);
    return;
  }

  attachProcess.onData((outputChunk: string) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(outputChunk);
    }
  });

  // If the pty dies (kill-session from outside, tmux crash), the client must be notified
  attachProcess.onExit(() => {
    if (socket.readyState === socket.OPEN) {
      socket.close(4001, "tmux session ended");
    }
  });

  const handleMessage = (rawMessage: RawData): void => {
    let controlMessage: ClientControlMessage;
    try {
      controlMessage = JSON.parse(rawMessage.toString()) as ClientControlMessage;
    } catch {
      return;
    }
    if (controlMessage.type === "input" && typeof controlMessage.data === "string") {
      attachProcess.write(controlMessage.data);
    } else if (
      controlMessage.type === "resize" &&
      typeof controlMessage.cols === "number" &&
      typeof controlMessage.rows === "number" &&
      controlMessage.cols > 0 &&
      controlMessage.rows > 0
    ) {
      attachProcess.resize(controlMessage.cols, controlMessage.rows);
    } else if (controlMessage.type === "ping" && socket.readyState === socket.OPEN) {
      socket.send(PONG_FRAME);
    }
  };

  // The client may send its first "resize" (and even type, and its immediate onopen ping -
  // see TerminalView.tsx) while we are still awaiting ensureSessionReady/spawnWithRetry
  // above; those messages were captured by attachBuffer via the synchronous buffer set up
  // by our caller (see index.ts). stopBuffering() detaches that buffer's listener and, with
  // no await in between, we drain it in order before hooking into live messages - there is
  // no window where a message can be lost. That immediate ping being replayed here as an
  // ordinary "ping" control message is exactly what produces the pong the client is waiting
  // for to mark the bridge ready (see TerminalView.tsx's onopen/onmessage).
  stopBuffering();
  for (const bufferedMessage of attachBuffer.drain()) {
    handleMessage(bufferedMessage);
  }
  socket.on("message", handleMessage);
  // Pty release on socket close is already wired up right after spawn, above, so the
  // tmux session itself stays alive with its output; nothing further to register here.
}
