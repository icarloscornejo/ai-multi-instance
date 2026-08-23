import { RETRY_MAX_DELAY_MS, SLOW_RETRY_MAX_DELAY_MS, retryDelayMs } from "./retry";

// Close code the server sends for the one condition that genuinely never comes back on its
// own: the instance was removed from the registry. instanceId is a uuid, so a deleted
// instance can never return under the same id - auto-retrying against it forever would just
// open a socket every 30s against something that by definition cannot exist again.
//
// 4005 (the instance's folder is missing) used to be fatal too, on the theory that a deleted/
// unmounted/renamed folder "never comes back without user action". That theory was wrong: the
// folder DOES come back the instant the user remounts the drive or undoes the rename, and
// until this changed, the client just sat there refusing to retry while the fix was one
// Finder action away. The current server (closeCodeForAttachError in server/src/attachErrors.ts)
// no longer sends 4005 at all - every pre-bridge failure, LocationMissingError included, comes
// through as plain 4006 now. It stays listed alongside 4006 below purely for
// forward/backward compatibility across a rolling restart of the dashboard itself (an older
// server binary briefly still emitting it against a newer client, or vice versa) - it must
// keep meaning "pre-bridge attach failure, slow retry" even if no currently-running server
// version actually produces it.
const FATAL_CLOSE_CODES = new Set<number>([4004]);

// Pre-bridge attach failure close codes (server/src/index.ts's closeCodeForAttachError, e.g.
// the pty spawn failing because macOS's system-wide pty pool is exhausted). Distinct from a
// plain drop because retrying at the normal 250ms-5s cadence would just hammer a resource
// that is under pressure from OUTSIDE this one connection; see attachStreak below. 4005 is
// included for the compatibility reason documented on FATAL_CLOSE_CODES above, even though no
// currently-running server version sends it.
const ATTACH_FAILURE_CLOSE_CODES = new Set<number>([4006, 4005]);

// The server discarded buffered pre-bridge input because it grew past its cap (see
// server/src/attachBuffer.ts). This is NOT an attach failure: the attach itself may well
// have succeeded moments later, so it must not feed the slow attachStreak backoff (doing
// so would penalize a user for typing a lot while the connection was still opening).
const INPUT_OVERFLOW_CLOSE_CODE = 4007;

const DEFAULT_FATAL_REASON = "This session cannot be restored.";
const DEFAULT_OVERFLOW_REASON = "Some input was discarded and could not be sent.";

export type ConnectionEvent =
  | { kind: "open" }
  | { kind: "bridgeReady" } // first frame received from the server; the only valid proof the bridge is operational
  | { kind: "wake" }
  | { kind: "manualReconnect" }
  | { kind: "close"; code: number; reason: string };

export interface ReconnectState {
  // Counts consecutive drops of an ALREADY-BRIDGED connection (server restart, network
  // blip). Reset by "open" (a fresh handshake is in flight) and by "bridgeReady"/"wake"/
  // "manualReconnect". This is the counter TerminalView.tsx used to reset directly inside
  // onopen; that reset-on-open is exactly what made the original bug (backoff never
  // growing for pre-bridge failures) possible once it was reused for close code 4006.
  normalAttempt: number;
  // Counts consecutive PRE-BRIDGE attach failures (close code 4006). Deliberately NOT
  // reset by "open", since the WebSocket handshake always completes before the server-side
  // attach can fail (see index.ts: handleUpgrade finishes before bridgeTerminal runs) - if
  // this reset on open, the backoff below would never grow past its first step. Only reset
  // by "bridgeReady" (real proof the attach succeeded), "wake", or "manualReconnect".
  attachStreak: number;
  // Set only while a FATAL close is the last thing that happened; cleared by "open" (a
  // fresh attempt is in flight) and "manualReconnect". Read directly by the caller to
  // decide whether to render the fatal/non-retrying state.
  fatalReason: string | null;
  // Set by an INPUT_OVERFLOW_CLOSE_CODE close; deliberately survives "open" (the retry the
  // overflow itself scheduled) so the user has a real chance to see it before it's replaced.
  // Only "bridgeReady" (proof the connection is actually usable again) or "manualReconnect"
  // clear it - clearing it on "open" would let a fast successive overflow erase the first
  // notice before it was ever rendered.
  transientNotice: string | null;
  // The last non-empty close reason from an ATTACH_FAILURE (4006) or otherwise-uncategorized
  // close, surfaced so the UI can show WHY it's retrying instead of just a bare spinner (see
  // TerminalView.tsx's compact reconnect indicator). Deliberately NOT cleared on "open", for
  // the exact same reason attachStreak isn't: the handshake completes before the server's
  // attach can fail, so clearing this on "open" would erase the message right as the user is
  // about to read it. Only "bridgeReady" (real proof the connection recovered) or
  // "manualReconnect" clear it. A 4007 (input overflow) close explicitly clears it instead of
  // setting it - see reduceClose below - so a stale attach-failure message can never sit
  // alongside transientNotice's own, unrelated "input was discarded" text at the same time.
  lastErrorReason: string | null;
}

export interface ReconnectEffect {
  // Milliseconds to wait before the next reconnect attempt, or null when no retry should
  // be scheduled (a fatal close, or a non-close event that doesn't itself trigger one).
  retryDelayMs: number | null;
}

export const INITIAL_RECONNECT_STATE: ReconnectState = {
  normalAttempt: 0,
  attachStreak: 0,
  fatalReason: null,
  transientNotice: null,
  lastErrorReason: null,
};

const NO_EFFECT: ReconnectEffect = { retryDelayMs: null };

export function reduceConnection(
  state: ReconnectState,
  event: ConnectionEvent
): { state: ReconnectState; effect: ReconnectEffect } {
  switch (event.kind) {
    case "open":
      // A fresh handshake is in flight; only the normal-drop counter and fatalReason reset
      // here (mirrors today's onopen behavior, which also clears fatalDisconnectReason).
      // attachStreak and transientNotice are untouched: this event fires before the server
      // has had any chance to prove (or fail) the attach - see attachStreak's own comment.
      return { state: { ...state, normalAttempt: 0, fatalReason: null }, effect: NO_EFFECT };

    case "bridgeReady":
      // The only event that is real proof the attach succeeded: safe to reset everything.
      return { state: { ...INITIAL_RECONNECT_STATE }, effect: NO_EFFECT };

    case "wake":
      // Mirrors today's useWakeRetry: only the normal-drop counter resets, so coming back
      // to a foregrounded tab never inherits an accumulated normal-backoff delay. The
      // attach streak and transientNotice are left alone; a wake does not prove the
      // pending attach recovered.
      return { state: { ...state, normalAttempt: 0 }, effect: NO_EFFECT };

    case "manualReconnect":
      // An explicit user action always gets a clean slate on every axis.
      return { state: { ...INITIAL_RECONNECT_STATE }, effect: NO_EFFECT };

    case "close":
      return reduceClose(state, event.code, event.reason);
  }
}

function reduceClose(
  state: ReconnectState,
  code: number,
  reason: string
): { state: ReconnectState; effect: ReconnectEffect } {
  if (FATAL_CLOSE_CODES.has(code)) {
    return {
      state: { ...state, fatalReason: reason || DEFAULT_FATAL_REASON },
      effect: { retryDelayMs: null },
    };
  }

  if (ATTACH_FAILURE_CLOSE_CODES.has(code)) {
    const delayMs = retryDelayMs(state.attachStreak, SLOW_RETRY_MAX_DELAY_MS);
    return {
      state: {
        ...state,
        attachStreak: state.attachStreak + 1,
        fatalReason: null,
        // reason is effectively always non-empty here (the server truncates but never sends
        // an empty attach-failure message, see closeSocketSafely in server/src/terminal.ts),
        // but the `|| state.lastErrorReason` fallback is kept anyway so a reason-less 4006
        // (should one ever happen) doesn't blank out a message the user hasn't seen yet.
        lastErrorReason: reason || state.lastErrorReason,
      },
      effect: { retryDelayMs: delayMs },
    };
  }

  if (code === INPUT_OVERFLOW_CLOSE_CODE) {
    // Uses normalAttempt, not attachStreak: an overflow is not an attach failure (the
    // connection may have attached fine right up until the buffer overran), so it must not
    // push the user toward the 30s slow-retry ceiling just for having typed a lot.
    const delayMs = retryDelayMs(state.normalAttempt, RETRY_MAX_DELAY_MS);
    return {
      state: {
        ...state,
        normalAttempt: state.normalAttempt + 1,
        fatalReason: null,
        transientNotice: reason || DEFAULT_OVERFLOW_REASON,
        // An overflow is not an attach failure and has its own dedicated notice above; a
        // stale attach-failure message from an earlier 4006 must not keep showing alongside
        // it, which is exactly what would happen if this were left untouched like
        // transientNotice itself is on every other branch.
        lastErrorReason: null,
      },
      effect: { retryDelayMs: delayMs },
    };
  }

  // Everything else (4000, 1006, a plain server restart, a locally-forced close from the
  // connect-timeout/liveness-timeout/wake-stale watchdogs in TerminalView.tsx, ...): today's
  // normal backoff. transientNotice, if any, is intentionally left untouched here too.
  // `reason` for a locally-forced close is populated by TerminalView.tsx BEFORE it calls
  // socket.close() (a plain 1006/no-status close from the browser itself carries no reason at
  // all) - this is what makes it possible to show something more useful than a bare spinner
  // for the most common disconnect of all, one this process caused itself.
  const delayMs = retryDelayMs(state.normalAttempt, RETRY_MAX_DELAY_MS);
  return {
    state: { ...state, normalAttempt: state.normalAttempt + 1, fatalReason: null, lastErrorReason: reason || state.lastErrorReason },
    effect: { retryDelayMs: delayMs },
  };
}
