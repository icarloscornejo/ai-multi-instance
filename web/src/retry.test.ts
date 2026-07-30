import { describe, expect, it } from "vitest";
import { RETRY_MAX_DELAY_MS, retryDelayMs } from "./retry";

describe("retryDelayMs", () => {
  it("doubles from the base delay for each successive attempt", () => {
    expect(retryDelayMs(0)).toBe(250);
    expect(retryDelayMs(1)).toBe(500);
    expect(retryDelayMs(2)).toBe(1_000);
    expect(retryDelayMs(3)).toBe(2_000);
    expect(retryDelayMs(4)).toBe(4_000);
  });

  it("caps at RETRY_MAX_DELAY_MS once doubling would exceed it", () => {
    // attempt 5 is the first one where doubling (8_000) would overshoot the cap
    expect(retryDelayMs(5)).toBe(RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(6)).toBe(RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(7)).toBe(RETRY_MAX_DELAY_MS);
  });

  it("stays capped for arbitrarily large attempt counts", () => {
    expect(retryDelayMs(50)).toBe(RETRY_MAX_DELAY_MS);
  });
});
