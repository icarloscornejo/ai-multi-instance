// Deliberately dependency-free (not even node-pty): index.ts starts listening on the real
// port and arms the WS heartbeat interval as soon as it is imported (see its module-level
// httpServer.listen()/startHeartbeat() calls), so nothing testable can live there. This
// module holds everything about attach-failure classification and close-code mapping that
// needs a unit test without importing index.ts or opening a socket.

// Distinct from TooManyPtysError so index.ts can map both to a close code that tells the
// client not to bother retrying on its own (a missing folder never comes back without user
// action). TooManyPtysError, by contrast, IS treated as recoverable (see
// closeCodeForAttachError below): livePtyCount decrements on its own as sockets close (see
// releasePty in terminal.ts), so the condition clears without a restart.
export class LocationMissingError extends Error {}

export class TooManyPtysError extends Error {}

// Thrown by spawnWithRetry (terminal.ts) once every retry attempt has failed. Carries the
// last raw error's message and the number of attempts made, purely for logging.
export class PtySpawnError extends Error {
  constructor(
    message: string,
    public readonly attempts: number
  ) {
    super(message);
    this.name = "PtySpawnError";
  }
}

// Thrown when the socket that requested this attach closed while a spawn retry was
// sleeping (see spawnWithRetry's isStillWanted check). Deliberately NOT surfaced as a
// close-worthy failure by the caller: the socket is already gone, there is nothing to
// notify and nothing to log (a cancelled attach isn't a failure of anything).
export class AttachCancelledError extends Error {}

// Maps an error thrown out of the attach pipeline (bridgeTerminal and everything it calls)
// to a WebSocket close code. The split is by PHASE, not by error type: a LocationMissingError
// is the one case that will never resolve itself (the folder isn't coming back on retry), so
// it alone gets the non-recoverable code. Every other pre-bridge failure - PtySpawnError,
// TooManyPtysError, or anything unforeseen - gets the recoverable slow-retry code, because
// the WebSocket handshake always completes before the attach can fail (see index.ts:
// handleUpgrade finishes before bridgeTerminal runs), so ANY pre-bridge error hits the same
// "onopen already reset the fast counter" hazard, not just pty-related ones. See
// web/src/reconnectPolicy.ts for the client side of this split.
//
// Tradeoff accepted deliberately: an unforeseen, genuinely permanent bug also falls into the
// recoverable bucket and retries silently instead of surfacing as a hard failure. The
// alternative (treat unknown errors as fatal) would mean the client stops retrying on its
// own for a bug nobody anticipated, which contradicts the "auto-recover without manual
// clicks" requirement this whole fix exists for. What makes this tolerable is that the
// failure is never silent: recordAttachFailure below still logs it (with its message) once
// per minute, including its stack via the caller, so a real bug is visible in the log even
// though the user's terminal keeps quietly retrying instead of getting stuck.
export function closeCodeForAttachError(error: Error): number {
  if (error instanceof LocationMissingError) {
    return 4005;
  }
  return 4006;
}

// Only the diagnosed failure signature is retried automatically inside spawnWithRetry
// (terminal.ts): node-pty's opaque "posix_spawnp failed." (no .code/.errno at all, see
// unixTerminal.js's pty.fork binding) and the standard "too many/no more file descriptors"
// errno codes a real resource-pressure spawn failure could also surface as. Anything else -
// tmux missing from PATH, a bad cwd, a permissions error - is a configuration or programming
// problem that retrying can never fix; it propagates immediately instead of being retried
// and silently swallowed for several seconds first.
const RETRIABLE_SPAWN_ERROR_CODES = new Set(["EMFILE", "ENFILE", "EAGAIN"]);

export function isRetriableSpawnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const errnoCode = (error as NodeJS.ErrnoException).code;
  if (typeof errnoCode === "string" && RETRIABLE_SPAWN_ERROR_CODES.has(errnoCode)) {
    return true;
  }
  return error.message.includes("posix_spawnp failed");
}

// Injectable so tests don't depend on real wall-clock time; production uses Date.now().
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

// A failure line and a recovery line each get their own 60s window: sharing one window
// between them would mean either (a) a normal recovery seconds after a failure gets
// suppressed by the failure's own window, right when the recovery line is most useful, or
// (b) the recovery line escapes the window entirely and two tabs alternating attach
// failure/success on the same instanceId can spam it. Two independent windows fix both.
export const LOG_WINDOW_MS = 60_000;
// Must exceed both windows above: an entry evicted mid-outage (because it merely looks
// idle for one window) would let the very next failure re-log as if it were the first,
// recreating the spam this whole module exists to prevent. A failure/success call always
// refreshes lastTouchedAt (see below), so an ongoing outage with failures spaced closer
// than this TTL is never evicted mid-flight - only a genuinely dead instanceId (no calls at
// all for this long, e.g. one that was deleted from the store) gets swept.
export const LOG_RETENTION_MS = LOG_WINDOW_MS * 3;

interface InstanceLogState {
  // True from the first unlogged-or-logged failure until a matching success. Read by
  // recordAttachSuccess to decide whether a recovery line is warranted at all - an instance
  // that never failed has nothing to "recover" from.
  episodeOpen: boolean;
  failureCount: number;
  lastFailureLoggedAt: number;
  lastRecoveryLoggedAt: number;
  // Bumped on every call (success or failure), independent of episodeOpen. Only this drives
  // eviction (see LOG_RETENTION_MS above); episodeOpen alone was tried and rejected because
  // an instance that fails forever and never recovers would then never be evicted, so a
  // deleted-but-still-failing instanceId would accumulate in the Map for the process's
  // entire lifetime (see server/src/routes.ts for instance deletion).
  lastTouchedAt: number;
}

const logStates = new Map<string, InstanceLogState>();

function evictStale(now: number): void {
  for (const [instanceId, state] of logStates) {
    if (now - state.lastTouchedAt > LOG_RETENTION_MS) {
      logStates.delete(instanceId);
    }
  }
}

function getOrCreateState(instanceId: string, now: number): InstanceLogState {
  let state = logStates.get(instanceId);
  if (state === undefined) {
    state = {
      episodeOpen: false,
      failureCount: 0,
      lastFailureLoggedAt: -Infinity,
      lastRecoveryLoggedAt: -Infinity,
      lastTouchedAt: now,
    };
    logStates.set(instanceId, state);
  }
  return state;
}

// Records a pre-bridge attach failure for this instance. Returns the message to log, or
// null if this failure is inside an already-logged 60s window (still counted toward
// failureCount for the eventual recovery line, just not logged again). Concurrent sockets
// on the same instanceId (multiple browser tabs) are handled implicitly: whichever call
// lands first in a given window logs, the rest are silently suppressed the same way
// repeated failures from one socket would be.
export function recordAttachFailure(instanceId: string, errorMessage: string, clock: Clock = systemClock): string | null {
  const now = clock.now();
  evictStale(now);
  const state = getOrCreateState(instanceId, now);
  state.episodeOpen = true;
  state.failureCount += 1;
  state.lastTouchedAt = now;
  if (now - state.lastFailureLoggedAt < LOG_WINDOW_MS) {
    return null;
  }
  state.lastFailureLoggedAt = now;
  return `instance ${instanceId}: attach failed (${errorMessage}), retrying automatically; further failures silenced for ${
    LOG_WINDOW_MS / 1000
  }s`;
}

// Records a successful attach for this instance. Returns the recovery message to log, or
// null if there was no open failure episode (the common case: most attaches just succeed)
// or the recovery line itself is inside its own 60s window. Crucially, this does NOT touch
// lastFailureLoggedAt: reopening a failure episode right after a success must not reset the
// failure window, or two tabs alternating success/failure on the same instanceId would
// recreate the exact spam this module exists to prevent (see round-2/round-4 review notes
// in the design doc). The reported failureCount can be imprecise under concurrent sockets
// (one tab's success closes an episode that another tab's failures were also feeding); the
// log message is worded to describe THIS attach recovering, not a claim that the instance
// as a whole is now healthy.
export function recordAttachSuccess(instanceId: string, clock: Clock = systemClock): string | null {
  const now = clock.now();
  evictStale(now);
  const state = logStates.get(instanceId);
  if (state === undefined || !state.episodeOpen) {
    if (state !== undefined) {
      state.lastTouchedAt = now;
    }
    return null;
  }
  const failureCount = state.failureCount;
  state.episodeOpen = false;
  state.failureCount = 0;
  state.lastTouchedAt = now;
  if (now - state.lastRecoveryLoggedAt < LOG_WINDOW_MS) {
    return null;
  }
  state.lastRecoveryLoggedAt = now;
  return `instance ${instanceId}: attach succeeded after ${failureCount} failed attempts`;
}

// Test-only escape hatch: vitest resets modules per file but this Map is process-lifetime
// module state, so a test suite that wants a clean slate between cases needs an explicit
// reset rather than re-importing the module.
export function _resetAttachLogStateForTests(): void {
  logStates.clear();
}
