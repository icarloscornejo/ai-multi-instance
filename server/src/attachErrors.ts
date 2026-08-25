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

// One retry attempt's outcome, captured by spawnWithRetry (terminal.ts) as it happens - not
// reconstructed after the fact from just the last error's message. This is what makes it
// possible to tell "the first attempt hit EMFILE and the last one came back with the opaque
// posix_spawnp message" apart from "all four attempts were identically opaque": the decisive
// signal is often in an EARLIER attempt, and averaging/discarding down to only the last error
// (what this used to do) throws that away. Deliberately scalar-only fields, matching
// describeError's own whitelist below - no raw Error object, no stack here, so this can be
// logged directly without needing its own defensive-read pass.
export interface SpawnAttemptDetail {
  attemptIndex: number;
  durationMs: number;
  name?: string;
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
}

// Thrown by spawnWithRetry (terminal.ts) once every retry attempt has failed. Carries the
// last raw error's message and the number of attempts made, purely for logging, plus every
// attempt's own outcome (see SpawnAttemptDetail above) so describeError can surface the whole
// retry history, not just the final, often least-informative, failure.
export class PtySpawnError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly attemptDetails: readonly SpawnAttemptDetail[] = []
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

// Maps an error thrown out of the attach pipeline (bridgeTerminal and everything it calls) to
// a WebSocket close code. Every pre-bridge failure - LocationMissingError, PtySpawnError,
// TooManyPtysError, or anything unforeseen - gets the SAME recoverable slow-retry code, because
// the WebSocket handshake always completes before the attach can fail (see index.ts:
// handleUpgrade finishes before bridgeTerminal runs), so ANY pre-bridge error hits the same
// "onopen already reset the fast counter" hazard, not just pty-related ones. See
// web/src/reconnectPolicy.ts for the client side of this split.
//
// LocationMissingError used to get its own non-recoverable code (4005): the reasoning was that
// a folder deleted/unmounted/renamed "never comes back without user action". That reasoning
// was wrong - the folder DOES come back the moment the user remounts the drive or undoes the
// rename, and until this changed, the client just sat there refusing to retry while the fix
// was one Finder action away. LocationMissingError as a TYPE is kept (terminal.ts still throws
// it with a readable message), it just no longer branches the close code.
//
// Tradeoff accepted deliberately: an unforeseen, genuinely permanent bug also falls into the
// recoverable bucket and retries silently instead of surfacing as a hard failure. The
// alternative (treat unknown errors as fatal) would mean the client stops retrying on its
// own for a bug nobody anticipated, which contradicts the "auto-recover without manual
// clicks" requirement this whole fix exists for. What makes this tolerable is that the
// failure is never silent: recordAttachFailure below still logs it (with its message) once
// per minute, including its stack via the caller, so a real bug is visible in the log even
// though the user's terminal keeps quietly retrying instead of getting stuck.
export function closeCodeForAttachError(_error: Error): number {
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

// --- describeError / shortErrorMessage -------------------------------------------------
//
// Two DELIBERATELY separate representations of the same unknown thrown value, because the two
// destinations they feed have opposite requirements. describeError is the rich, whitelisted
// one, meant only for this process's own console: it includes stack, code, errno, syscall, and
// (for PtySpawnError) the full retry history. shortErrorMessage is meant for whatever is on the
// other end of a WebSocket close frame: message only, nothing that could leak a local path,
// a stack trace, or diagnostic detail to a remote client. Neither is derived from the other -
// shortErrorMessage must keep working even if describeError's own construction fails partway
// through (see its own comment below), so a socket can always be closed with SOME reason even
// when the richer console line degrades.
//
// Both are TOTAL by construction: this runs inside handlers that exist specifically because an
// exception during error-handling already crashed the process once before this file existed
// (see closeSocketSafely's header comment in terminal.ts). A hostile getter, a Proxy, a cyclic
// `cause` chain, or a thrown symbol must never escape either function - every property read is
// its own try/catch, not just an event guard around the whole call.

const MAX_FIELD_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_CAUSE_DEPTH = 3;

// Strips CR/LF and other control characters so a hostile or accidental multi-line message can
// never inject fake extra log lines (or corrupt a WebSocket close frame) just by being thrown.
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching raw control bytes
  return value.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ");
}

function truncateField(value: string): string {
  const clean = stripControlChars(value);
  return clean.length > MAX_FIELD_LENGTH ? `${clean.slice(0, MAX_FIELD_LENGTH)}…` : clean;
}

// Reads a single property defensively: a Proxy or a getter defined with Object.defineProperty
// can throw on access alone, before any type check even runs, so the guard has to wrap the
// read itself, not just what's done with the result.
function safeRead(source: unknown, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeReadArray(source: unknown, key: string): unknown[] | undefined {
  const raw = safeRead(source, key);
  return Array.isArray(raw) ? raw : undefined;
}

// Only scalars are ever whitelisted through - an object/function/symbol field is silently
// dropped rather than stringified, so nothing can smuggle its own toString()/Symbol.toPrimitive
// into the log by being assigned to a whitelisted property name.
function safeScalar(value: unknown): string | undefined {
  try {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Same whitelist SpawnAttemptDetail declares, plus the Error-standard/errno/TmuxError fields
// (TmuxError - tmux.ts - is read by duck typing since this file cannot import it, see the
// file's header comment) and PtySpawnError's own `attempts` count.
const WHITELISTED_ERROR_FIELDS = ["name", "message", "code", "errno", "syscall", "path", "killed", "signal", "attempts"] as const;

const SPAWN_ATTEMPT_FIELDS = ["attemptIndex", "durationMs", "name", "message", "code", "errno", "syscall"] as const;

function describeAttemptDetails(attemptDetails: unknown[]): string {
  const summarized = attemptDetails.map((entry, index) => {
    const bits: string[] = [];
    for (const field of SPAWN_ATTEMPT_FIELDS) {
      const scalar = safeScalar(safeRead(entry, field));
      if (scalar !== undefined) {
        bits.push(`${field}=${truncateField(scalar)}`);
      }
    }
    return bits.length > 0 ? `[${bits.join(",")}]` : `[attempt ${index}: unreadable]`;
  });
  return summarized.join(" ");
}

// `seen` guards against a cyclic `cause` chain (error.cause = error, or a longer cycle through
// several objects) turning this into infinite recursion; MAX_CAUSE_DEPTH is a second, cheaper
// backstop for a long-but-not-cyclic chain.
function describeErrorChain(error: unknown, depth: number, seen: WeakSet<object>): string {
  if (depth > MAX_CAUSE_DEPTH) {
    return "…(cause chain truncated)…";
  }
  if (!(error instanceof Error)) {
    const scalar = safeScalar(error);
    return scalar !== undefined ? `non-Error thrown: ${truncateField(scalar)}` : "non-Error thrown (unprintable)";
  }
  if (seen.has(error)) {
    return "…(cause cycle)…";
  }
  seen.add(error);

  const parts: string[] = [];
  for (const field of WHITELISTED_ERROR_FIELDS) {
    const scalar = safeScalar(safeRead(error, field));
    if (scalar !== undefined) {
      parts.push(`${field}=${truncateField(scalar)}`);
    }
  }
  const stack = safeRead(error, "stack");
  if (typeof stack === "string") {
    parts.push(`stack=${truncateField(stack)}`);
  }
  // PtySpawnError-only, read by duck typing (see WHITELISTED_ERROR_FIELDS comment): the whole
  // point of carrying attemptDetails is for it to actually reach the log line.
  const attemptDetails = safeReadArray(error, "attemptDetails");
  if (attemptDetails !== undefined && attemptDetails.length > 0) {
    parts.push(`attempts=${describeAttemptDetails(attemptDetails)}`);
  }

  let described = parts.join(" ");
  const cause = safeRead(error, "cause");
  if (cause !== undefined && cause !== null) {
    described += ` cause=[${describeErrorChain(cause, depth + 1, seen)}]`;
  }
  return described;
}

// Console-only. Never send this to a client - see shortErrorMessage for that.
export function describeError(error: unknown): string {
  try {
    const described = describeErrorChain(error, 0, new WeakSet());
    return described.length > MAX_DESCRIPTION_LENGTH ? `${described.slice(0, MAX_DESCRIPTION_LENGTH)}…` : described;
  } catch {
    // The backstop, not the primary defense (every read above already guards itself) - see
    // this section's header comment for why a diagnostic helper must never itself become the
    // reason an error handler crashes.
    return "error description unavailable";
  }
}

// Safe to hand to a remote client (WebSocket close reason). Deliberately message-only: no
// stack, no code/errno, no cause chain, no attempt history - those are local diagnostic detail,
// not something to leak to whatever is on the other end of the socket. Independent of
// describeError (see this section's header comment) so a close reason is still produced even if
// the richer description fails.
export function shortErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = safeScalar(safeRead(error, "message"));
      return message !== undefined && message.length > 0 ? stripControlChars(message) : "unknown error";
    }
    const scalar = safeScalar(error);
    return scalar !== undefined ? stripControlChars(scalar) : "unknown error";
  } catch {
    return "unknown error";
  }
}

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
//
// buildDetail is an OPTIONAL, LAZY diagnostic-detail provider (see describeError/
// shortErrorMessage in this file, and ptyCapacity.ts for what terminal.ts/index.ts actually
// pass here) - called only once we've already decided this particular failure earns a log
// line, never on a suppressed one. That matters for cost (a snapshot of system pty capacity is
// cheap but not free, and most failures in an outage get suppressed by the throttle) and for
// correctness: by the time buildDetail runs, lastFailureLoggedAt is already committed, so if
// buildDetail itself throws, the function still returns a real line (with a snapshotError note
// instead of the detail) rather than silently consuming the throttle window and returning
// nothing - the worst possible outcome here would be losing 60s of diagnosis to exactly the
// kind of hostile/broken input this detail-gathering exists to survive.
export function recordAttachFailure(
  instanceId: string,
  errorMessage: string,
  clock: Clock = systemClock,
  buildDetail?: () => string
): string | null {
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
  let detailSuffix = "";
  if (buildDetail !== undefined) {
    try {
      const detail = buildDetail();
      if (detail.length > 0) {
        detailSuffix = ` | ${detail}`;
      }
    } catch (detailError) {
      detailSuffix = ` | snapshotError=${detailError instanceof Error ? detailError.message : String(detailError)}`;
    }
  }
  return `instance ${instanceId}: attach failed (${errorMessage}), retrying automatically; further failures silenced for ${
    LOG_WINDOW_MS / 1000
  }s${detailSuffix}`;
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

// The one hard limit ws.close() enforces: the close-frame payload (status code + reason) is
// capped by the WebSocket spec at 125 bytes total, and ws's own Sender.close subtracts the
// 2-byte status code itself, so the reason text's real budget is 123 bytes - see
// ws/lib/sender.js's `if (length > 123) throw new RangeError(...)`. A reason that exceeds it
// makes socket.close() throw, which used to happen INSIDE the same catch block that exists to
// report the original error - turning a recoverable attach failure into an unhandled
// rejection that could take the whole process down. This was hit for real with any error
// message containing a multi-byte path segment (accents, an emoji in a folder name): slicing
// by JS string length (UTF-16 code units) undercounts real byte size for exactly those
// characters, so a 120-*character* slice can still be well over 123 *bytes*.
//
// `Buffer` is a Node global, not an import, so using it here does not break this file's
// deliberate no-dependencies rule (see the header comment) - it still needs no import and
// stays testable without opening a socket.
const MAX_CLOSE_REASON_BYTES = 123;

export function truncateCloseReason(reason: string, maxBytes: number = MAX_CLOSE_REASON_BYTES): string {
  if (Buffer.byteLength(reason, "utf8") <= maxBytes) {
    return reason;
  }
  // Binary-search the largest character-length prefix whose UTF-8 encoding still fits.
  // Character-by-character trimming would also work but is O(n) rescans of a growing buffer
  // for long reasons; this is a handful of iterations regardless of input size. Cutting by
  // JS string index (not raw bytes) guarantees we never split a multi-byte code point, which
  // slicing the encoded Buffer directly could do and produce invalid UTF-8 on the wire.
  let low = 0;
  let high = reason.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(reason.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return reason.slice(0, low);
}
