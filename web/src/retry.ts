export const RETRY_BASE_DELAY_MS = 250;
// This is a local dashboard, not a rate-limited third-party API: there's no server to protect
// from a tight retry loop, only a user staring at a stalled terminal. A lower cap means a
// mobile reconnect (already helped along by the liveness watchdog and connect timeout in
// TerminalView.tsx) never sits idle for long even after several attempts in a row.
export const RETRY_MAX_DELAY_MS = 5_000;

// Used only for the pre-bridge attach-failure backoff (close code 4006, see reconnectPolicy.ts
// and server/src/index.ts): those failures are often caused by system-wide resource pressure
// (e.g. macOS's global pty limit) that many concurrent dashboard tabs/instances all hammering
// every few seconds would only make worse. Deliberately NOT used as the default: raising
// RETRY_MAX_DELAY_MS itself would also slow down App.tsx's initial state-load retry and the
// normal post-bridge reconnect (server restart from tsx watch), which recover in a few
// seconds today and should keep doing so.
export const SLOW_RETRY_MAX_DELAY_MS = 30_000;

// attempt 0 -> 250ms, doubling (500, 1000, 2000, 4000, 8000, ...) until maxDelayMs
export function retryDelayMs(attempt: number, maxDelayMs: number = RETRY_MAX_DELAY_MS): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, maxDelayMs);
}
