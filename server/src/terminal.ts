import * as nodePty from "@lydell/node-pty";
import type { WebSocket, RawData } from "ws";
import type { AttachBuffer } from "./attachBuffer";
import {
  AttachCancelledError,
  LocationMissingError,
  PtySpawnError,
  TooManyPtysError,
  describeError,
  isRetriableSpawnError,
  recordAttachFailure,
  shortErrorMessage,
  systemClock,
  truncateCloseReason,
  type SpawnAttemptDetail,
} from "./attachErrors";
import { buildLaunchCommand } from "./launch";
import { computeMaxLivePtys, getPtmxMax } from "./ptyCapacity";
import { pathExists } from "./paths";
import {
  TmuxError,
  createSession,
  enableMouseMode,
  getSessionPresence,
  isDuplicateSessionError,
  isSessionInitIncomplete,
  killSession,
  markSessionInitComplete,
  markSessionLaunching,
  sendCommandToSession,
} from "./tmux";
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

// macOS caps ptys at kern.tty.ptmx_max - a SYSTEM-WIDE limit (511 by default), confirmed
// against Apple's own XNU source (bsd/kern/tty_ptmx.c) while chasing this exact bug down:
// every attach that failed with the opaque "posix_spawnp failed." traced back to this pool
// being exhausted machine-wide, not to anything wrong with this process. This gate only ever
// sees THIS process's own pty count - it cannot see pressure from other terminals/processes on
// the machine - so it is deliberately derived from the system's actual ptmx_max (see
// ptyCapacity.ts's computeMaxLivePtys) rather than a fixed constant that would either waste
// headroom (if ptmx_max is later raised) or starve every other terminal app on the machine (the
// previous fixed 480 left only 31 ptys of margin below the 511 default - which is exactly the
// scenario that emptied the pool in the first place). Computed once, at module load - see
// ptyCapacity.ts's own comment on why reading ptmx_max here (a one-time sysctl call at process
// startup, long before the first attach) is fine even though spawning a process to diagnose a
// LIVE spawn failure would not be.
//
// This remains the ONLY gate that actually rejects an attach for pty-capacity reasons. The
// system-wide pty count (ptyCapacity.ts's countSystemDynamicPtys) is informational only, never
// a second gate: it measurably overcounts under normal churn (a pty's /dev node is reclaimed
// when its OWNING PROCESS exits, not when the pty is destroyed - see that module's own
// comment), so treating it as authoritative would reject perfectly good attaches. It exists
// solely to enrich the diagnostic detail when THIS gate fires, or when a spawn genuinely fails
// (see buildFailureDetail in index.ts).
const MAX_LIVE_PTYS = computeMaxLivePtys(getPtmxMax());
let livePtyCount = 0;

// Read-only outside this module: exposed for index.ts's diagnostic detail (see
// buildFailureDetail there), never as a second admission gate - see MAX_LIVE_PTYS's comment.
export function getLivePtyCount(): number {
  return livePtyCount;
}

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

// A single failure must cost one terminal, never the whole process. Closing a socket is
// itself capable of throwing (see truncateCloseReason's header comment: an untruncated,
// multi-byte reason used to make ws's close() throw a RangeError from inside the very catch
// block meant to handle the original failure), so this is the LAST line of defense and must
// not itself be able to escalate: try close(), and only if that throws, fall back to
// terminate() (which drops the TCP connection immediately, no close handshake, but cannot
// itself reject on an oversized reason since it takes none). Any exception from terminate()
// is swallowed - there is nothing further this function can do about a socket that won't even
// tear down cleanly, and letting that exception escape would defeat the entire point.
export function closeSocketSafely(socket: WebSocket, code: number, reason: string): void {
  const truncatedReason = truncateCloseReason(reason);
  try {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close(code, truncatedReason);
    }
  } catch {
    try {
      socket.terminate();
    } catch {
      // Nothing more this process can do about a socket that won't even terminate cleanly;
      // swallowing here is what keeps a broken socket from becoming a process crash.
    }
  }
}

// The one teardown routine every post-bridge failure path (onData, the pty's own "error"
// listener, a malformed control message) funnels through. releasePty is already idempotent
// (see its _released flag above), which is what lets this run safely alongside the "close"
// listener registered right after spawn (bridgeTerminal, below) without ever double-
// decrementing livePtyCount - that count gates MAX_LIVE_PTYS admission, so a drift there would
// be silent and cumulative for the rest of the process's life. releasePty's own destroy()/
// kill() call is wrapped too: this function must be able to absorb a failure in EITHER half
// (pty teardown or socket close) and still attempt the other.
//
// Always logs, throttled through the same recordAttachFailure used for pre-bridge failures
// (attachErrors.ts) - a post-bridge failure being contained (instead of crashing the process)
// must not also mean it becomes invisible. Without this, `npm run dev`'s own terminal would
// show nothing at all for a resize exploit, a broken pipe, or a pty stream error: the user
// would just see a tab quietly reconnect with no way to tell what happened or fix it later.
//
// Takes `unknown`, not a pre-extracted string: every caller below used to convert to
// `.message` before calling this, which threw away code/errno/stack before this function ever
// saw the error - the exact loss this whole diagnostic effort exists to stop. The two
// representations this derives are DELIBERATELY separate and neither depends on the other
// succeeding (see describeError/shortErrorMessage's header comment in attachErrors.ts):
// shortErrorMessage feeds both the visible part of the log line and the WebSocket close
// reason (same as before - this function is not the place that decides to widen what a
// client sees), while describeError's richer detail goes to console only, via
// recordAttachFailure's lazy buildDetail.
function teardownAttach(socket: WebSocket, attachProcess: nodePty.IPty, instanceId: string, code: number, rawError: unknown): void {
  const shortMessage = shortErrorMessage(rawError);
  const failureMessage = recordAttachFailure(instanceId, shortMessage, systemClock, () => describeError(rawError));
  if (failureMessage !== null) {
    console.error(`[server] ${failureMessage}`);
  }
  try {
    releasePty(attachProcess);
  } catch {
    // A pty that won't tear down cleanly must not block closing the socket below - the user
    // still needs to see the terminal go away and reconnect, even if this process is left
    // with a wedged child process (a much smaller problem than a full server crash).
  }
  closeSocketSafely(socket, code, shortMessage);
}

// Post-bridge failures (a pty stream error, a throw while handling a client message) are not
// pre-bridge ATTACH failures - the attach already succeeded once - so they deliberately do not
// reuse 4006/closeCodeForAttachError (that would wrongly feed the client's slow attachStreak
// backoff for something that isn't a repeated attach failure; see reconnectPolicy.ts). 1011 is
// the WebSocket spec's own "server encountered an unexpected condition" code, which falls
// through reconnectPolicy's normal-drop branch: the client reconnects at its ordinary cadence
// and re-runs the full attach pipeline from scratch, same as any other drop.
const POST_BRIDGE_FAILURE_CLOSE_CODE = 1011;

// Shared by the initial-size query string (index.ts) and every live "resize" message
// (handleMessage below) so a client cannot bypass the guard by only exploiting one of the two
// paths - both used to be validated separately (and the initial-size path had no upper bound
// at all). Positive finite integers alone are not enough: axis-only bounds still let through
// a geometry whose PRODUCT is enormous (e.g. one huge axis and one merely-large one), which
// can still blow up tmux's own grid allocation and redraw cost. MAX_AXIS and MAX_CELLS are
// both generous relative to any real xterm.js viewport (a 4K display at a tiny font is still
// only in the low hundreds of columns/rows) while remaining far short of what would let a
// single malicious/buggy resize message meaningfully stress the server.
const MAX_TERMINAL_AXIS = 2_000;
const MAX_TERMINAL_CELLS = 300_000;

export function validateTerminalSize(cols: unknown, rows: unknown): InitialSize | null {
  if (
    typeof cols !== "number" ||
    typeof rows !== "number" ||
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols <= 0 ||
    rows <= 0 ||
    cols > MAX_TERMINAL_AXIS ||
    rows > MAX_TERMINAL_AXIS ||
    cols * rows > MAX_TERMINAL_CELLS
  ) {
    return null;
  }
  return { cols, rows };
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
  // Every failed attempt's own outcome, not just the last one - see SpawnAttemptDetail's
  // header comment in attachErrors.ts for why the decisive signal is often in an EARLIER
  // attempt (e.g. attempt 1 carries a real errno, attempt 4 is the opaque posix_spawnp
  // message), which discarding down to only the last error throws away.
  const attemptDetails: SpawnAttemptDetail[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      return spawnAttempt();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errnoError = lastError as NodeJS.ErrnoException;
      attemptDetails.push({
        attemptIndex: attempt,
        durationMs: Date.now() - attemptStartedAt,
        name: lastError.name,
        message: lastError.message,
        code: errnoError.code,
        errno: errnoError.errno,
        syscall: errnoError.syscall,
      });
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

  throw new PtySpawnError(lastError?.message ?? "pty spawn failed", maxAttempts, attemptDetails);
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
// 1. Cancellation: createSession (tmux.ts, chained new-session + marker set, then 3 more tmux
//    calls) and the sendCommandToSession that launches the provider (2 more tmux calls) are
//    several tmux invocations spread across two functions. If a cancellation check ran
//    between them, a socket closing mid-sequence would leave a tmux session that exists
//    (getSessionPresence would report it "present") but was never handed a provider. So: no
//    cancellation check anywhere inside this function, only before calling it and after it
//    returns (see bridgeTerminal below). The init-incomplete marker (tmux.ts) is what makes
//    this survivable even so: a session left in that state reads as "confirmed incomplete"
//    to the next ensureSessionReady call instead of being silently accepted forever - see
//    that function below for the full mechanism and its history.
//
// 2. A per-command timeout (see DEFAULT_TMUX_TIMEOUT_MS in tmux.ts) can ALSO fire mid-
//    sequence, with the exact same half-initialized consequence, even with no cancellation
//    involved at all: killing tmux's own client process on timeout does not undo commands
//    the tmux SERVER already applied (new-session already ran; only the later provider
//    launch timed out). The catch below cleans that up, but ONLY when it is provably safe:
//
//    - never once the launch command may have been delivered (`launchMayHaveBeenApplied`).
//      sendCommandToSession sends the command text and Enter as two separate tmux calls; a
//      timeout on either kills the client, not the running agent. The flag is set
//      synchronously right after markSessionLaunching's await and before sendCommandToSession,
//      so any failure from the send onward preserves. markSessionLaunching itself failing
//      still cleans up: nothing was launched yet.
//    - never when the error is `duplicate session` - positive proof this call did not create
//      the session, so it is not ours to kill.
//
//    The marker is the complementary guard for the case where THIS process dies before the
//    catch runs: "created" -> a future attach recreates; "launching" -> a future attach
//    preserves. See tmux.ts's isSessionInitIncomplete.
//
//    Residual race, deliberately not closed here: a timeout on new-session itself is
//    ambiguous (applied or not), so with two dashboard PROCESSES one could still kill a
//    session the other just created, via an error that isn't "duplicate session". Closing
//    that needs an ownership token set atomically with new-session and a server-side
//    check-and-kill; out of scope (high complexity, requires concurrent dashboards).
//
// Exported and parameterised with `onSessionCreated` because POST /api/instances (routes.ts)
// needs to run the EXACT same guarded sequence, with one extra step wedged in: it persists
// the instance record right after the session exists and BEFORE the provider launch, so a
// launch that half-applies can never leave a live agent in a session with no instance record
// pointing at it. The attach path (initializeSession below) passes no hook.
export async function initializeInstanceSession(
  instance: InstanceRecord,
  onSessionCreated?: () => Promise<void>
): Promise<void> {
  let launchMayHaveBeenApplied = false;
  try {
    await createSession(instance.tmuxSession, instance.locationPath);
    if (onSessionCreated !== undefined) {
      await onSessionCreated();
    }
    if (instance.shellOnly !== true) {
      await markSessionLaunching(instance.tmuxSession);
      launchMayHaveBeenApplied = true;
      await sendCommandToSession(
        instance.tmuxSession,
        buildLaunchCommand(instance, { resumeSessionId: instance.sessionId ?? undefined })
      );
    }
    await markSessionInitComplete(instance.tmuxSession);
  } catch (error) {
    if (!launchMayHaveBeenApplied && !isDuplicateSessionError(error)) {
      try {
        await killSession(instance.tmuxSession);
      } catch {
        // Best-effort: if the session never actually got created (e.g. the very first
        // tmux call itself failed/timed out before "new-session" ran), this just fails
        // harmlessly and there is nothing to clean up.
      }
    }
    throw error;
  }
}

async function initializeSession(instance: InstanceRecord): Promise<void> {
  await initializeInstanceSession(instance);
}

// Ensures the instance's tmux session exists and is fully initialized - joining an already
// in-flight attempt for the same session instead of racing it (see sessionInitInFlight
// above). This function's shape is the result of getting it wrong twice, in two opposite and
// both destructive directions, so both are recorded here rather than left to be
// rediscovered:
//
//   1. First attempt: an in-memory "poisoned" set that killed-then-recreated a session once
//      cleanup failed. Rejected because tmux's own kill-session REJECTS when the target
//      session doesn't exist, and getSessionPresence collapsing a timeout into the same
//      state as "gone" meant a session that was merely stalled - not actually missing -
//      could get stuck failing forever on the kill step, a permanently dead terminal.
//
//   2. Second attempt: a "ready" marker set only once init completed, treating any session
//      alive WITHOUT that marker as incomplete and recreating it. Rejected because every
//      session that already existed before this marker was introduced has no marker at
//      all - the very first attach after deploying that version would have destroyed every
//      live session on the machine, agents and scrollback included. The README promises
//      the opposite twice over (sessions and their output survive dashboard restarts).
//
// The design that survived: the marker (tmux.ts's SESSION_INIT_MARKER_OPTION) proves
// INCOMPLETENESS, never readiness, and only a "created" reading (this process made it, no
// launch attempted yet) counts as proof it is safe to recreate. A "launching" session (a
// provider launch that may have been applied - a live agent could be in it), a legacy "1"
// session, a session with no marker, a failed marker read, and an already-complete session
// are all preserved untouched. The invariant this exists to protect: destroying a session
// must require positive evidence it was left incomplete BEFORE any launch, never the mere
// absence of evidence it's fine. See tmux.ts's isSessionInitIncomplete/getSessionPresence.
export async function ensureSessionReady(instance: InstanceRecord): Promise<void> {
  const existing = sessionInitInFlight.get(instance.tmuxSession);
  if (existing !== undefined) {
    return existing;
  }

  const readyPromise = (async () => {
    const presence = await getSessionPresence(instance.tmuxSession);

    if (presence === "unknown") {
      // A timeout or a wedged tmux server is not proof the session is gone - it might be
      // perfectly healthy. Surface this as a normal recoverable attach failure (the caller,
      // bridgeTerminal, already treats any thrown error here that way) so the client retries
      // instead of this function risking a destructive decision on ambiguous information.
      throw new TmuxError("Could not confirm the tmux session's state; retrying automatically.");
    }

    if (presence === "absent") {
      await initializeSession(instance);
      return;
    }

    // presence === "present" from here on.
    const initState = await isSessionInitIncomplete(instance.tmuxSession);
    if (initState !== "confirmed-incomplete") {
      // "not-confirmed-incomplete" (legacy session, legacy "1" marker, already-complete
      // session, unreadable marker) OR "confirmed-launching" (a provider launch that may
      // already be running an agent): preserve as-is. Only a "created" marker - set by this
      // version, before any launch - authorizes recreation. Migrate sessions that were alive
      // before mouse mode existed; set-option is idempotent, no cost in repeating it.
      await enableMouseMode(instance.tmuxSession);
      return;
    }

    // Confirmed incomplete: this exact process created this session and never got as far as
    // attempting the provider launch - the marker reading "created" is positive proof no user
    // work could exist in it yet. Safe to recreate from scratch.
    await killSession(instance.tmuxSession).catch(() => {
      // Best-effort: if the session already vanished on its own between the presence check
      // above and here, there is nothing left to clean up.
    });
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

  // node-pty rethrows any stream error that isn't EAGAIN/EIO UNLESS the consumer has
  // registered its own "error" listener (see unixTerminal.js: `if
  // (this.listeners('error').length < 2) { throw err; }` - node-pty's own internal listener
  // is always the first, so ours has to exist for that check to pass). IPty's public type
  // only declares onData/onExit, not a raw "error" event, but Terminal.prototype.on/listeners
  // (terminal.js) delegate directly to the underlying socket's EventEmitter for any event
  // other than "close", which is exactly the listener count node-pty's own check inspects -
  // hence the cast. Without this, a pty stream error after a perfectly successful attach
  // could still throw as an uncaught exception from inside an EventEmitter callback and take
  // the whole server down with it - this listener existing at all, regardless of what it
  // does, is what prevents that.
  (attachProcess as unknown as { on: (event: "error", listener: (error: Error) => void) => void }).on(
    "error",
    (error: Error) => {
      teardownAttach(socket, attachProcess, instance.id, POST_BRIDGE_FAILURE_CLOSE_CODE, error);
    }
  );

  attachProcess.onData((outputChunk: string) => {
    try {
      if (socket.readyState === socket.OPEN) {
        socket.send(outputChunk);
      }
    } catch (error) {
      // socket.send() throwing (a broken pipe, a send after a race with close) must cost
      // only this terminal - see teardownAttach's header comment.
      teardownAttach(socket, attachProcess, instance.id, POST_BRIDGE_FAILURE_CLOSE_CODE, error);
    }
  });

  // If the pty dies (kill-session from outside, tmux crash), the client must be notified
  attachProcess.onExit(() => {
    if (socket.readyState === socket.OPEN) {
      closeSocketSafely(socket, 4001, "tmux session ended");
    }
  });

  const handleMessage = (rawMessage: RawData): void => {
    try {
      let controlMessage: ClientControlMessage;
      try {
        controlMessage = JSON.parse(rawMessage.toString()) as ClientControlMessage;
      } catch {
        return;
      }
      if (controlMessage.type === "input" && typeof controlMessage.data === "string") {
        attachProcess.write(controlMessage.data);
      } else if (controlMessage.type === "resize") {
        // Shared with the initial-size query string in index.ts (see validateTerminalSize's
        // header comment for why): this is the guard that used to accept `Infinity` (typeof
        // Infinity === "number" and Infinity > 0 both pass a naive check) and hand it
        // straight to node-pty's resize(), which throws explicitly for infinite dimensions -
        // an exception any connected tab could trigger on demand, previously uncontained.
        const validatedSize = validateTerminalSize(controlMessage.cols, controlMessage.rows);
        if (validatedSize !== null) {
          attachProcess.resize(validatedSize.cols, validatedSize.rows);
        }
      } else if (controlMessage.type === "ping" && socket.readyState === socket.OPEN) {
        socket.send(PONG_FRAME);
      }
    } catch (error) {
      // Catch-all for the whole handler: a throw from attachProcess.write/resize or
      // socket.send here is a WebSocket "message" EventEmitter callback, so an uncaught
      // exception here would otherwise crash the entire process, not just this terminal.
      teardownAttach(socket, attachProcess, instance.id, POST_BRIDGE_FAILURE_CLOSE_CODE, error);
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
