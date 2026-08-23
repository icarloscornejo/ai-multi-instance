import { RETRY_MAX_DELAY_MS, SLOW_RETRY_MAX_DELAY_MS, retryDelayMs } from "./retry";

// Close codes the server sends for conditions that will never clear on their own: the
// instance was removed from the registry, or its folder is gone. Auto-retrying against
// these just repeats the same failure, so the UI stops and asks for a manual reconnect.
const FATAL_CLOSE_CODES = new Set<number>([4004, 4005]);

// A pre-bridge attach failure (server/src/index.ts's closeCodeForAttachError, e.g. the
// pty spawn failing because macOS's system-wide pty pool is exhausted). Distinct from a
// plain drop because retrying it at the normal 250ms-5s cadence would just hammer a
// resource that is under pressure from OUTSIDE this one connection; see attachStreak below.
const ATTACH_FAILURE_CLOSE_CODE = 4006;

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

  if (code === ATTACH_FAILURE_CLOSE_CODE) {
    const delayMs = retryDelayMs(state.attachStreak, SLOW_RETRY_MAX_DELAY_MS);
    return {
      state: { ...state, attachStreak: state.attachStreak + 1, fatalReason: null },
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
      },
      effect: { retryDelayMs: delayMs },
    };
  }

  // Everything else (4000, 1006, a plain server restart, ...): today's normal backoff.
  // transientNotice, if any, is intentionally left untouched here too.
  const delayMs = retryDelayMs(state.normalAttempt, RETRY_MAX_DELAY_MS);
  return {
    state: { ...state, normalAttempt: state.normalAttempt + 1, fatalReason: null },
    effect: { retryDelayMs: delayMs },
  };
}
