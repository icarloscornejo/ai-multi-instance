export const RETRY_BASE_DELAY_MS = 250;
// This is a local dashboard, not a rate-limited third-party API: there's no server to protect
// from a tight retry loop, only a user staring at a stalled terminal. A lower cap means a
// mobile reconnect (already helped along by the liveness watchdog and connect timeout in
// TerminalView.tsx) never sits idle for long even after several attempts in a row.
export const RETRY_MAX_DELAY_MS = 5_000;

// attempt 0 -> 250ms, doubling (500, 1000, 2000, 4000, 8000, ...) until the cap
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
}
