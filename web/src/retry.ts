export const RETRY_BASE_DELAY_MS = 250;
export const RETRY_MAX_DELAY_MS = 15_000;

// attempt 0 -> 250ms, doubling (500, 1000, 2000, 4000, 8000, ...) until the cap
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
}
