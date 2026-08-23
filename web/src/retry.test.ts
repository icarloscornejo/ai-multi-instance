import { describe, expect, it } from "vitest";
import { RETRY_MAX_DELAY_MS, SLOW_RETRY_MAX_DELAY_MS, retryDelayMs } from "./retry";

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

  // Regression guard: App.tsx's initial state-load loop and the normal post-bridge
  // reconnect both rely on the default staying at 5s. Raising it globally to accommodate
  // the slow-retry path would make a plain tsx-watch restart take up to 30s to recover.
  it("keeps the default cap at 5s even for large attempt counts, unaffected by maxDelayMs elsewhere", () => {
    expect(retryDelayMs(10)).toBe(RETRY_MAX_DELAY_MS);
  });

  describe("with an explicit maxDelayMs", () => {
    it("still doubles from the base delay before the cap is reached", () => {
      expect(retryDelayMs(0, SLOW_RETRY_MAX_DELAY_MS)).toBe(250);
      expect(retryDelayMs(1, SLOW_RETRY_MAX_DELAY_MS)).toBe(500);
      expect(retryDelayMs(5, SLOW_RETRY_MAX_DELAY_MS)).toBe(8_000);
      expect(retryDelayMs(6, SLOW_RETRY_MAX_DELAY_MS)).toBe(16_000);
    });

    it("caps at SLOW_RETRY_MAX_DELAY_MS once doubling would exceed it", () => {
      // attempt 7 is the first one where doubling (32_000) would overshoot 30_000
      expect(retryDelayMs(7, SLOW_RETRY_MAX_DELAY_MS)).toBe(SLOW_RETRY_MAX_DELAY_MS);
      expect(retryDelayMs(8, SLOW_RETRY_MAX_DELAY_MS)).toBe(SLOW_RETRY_MAX_DELAY_MS);
    });

    it("stays capped for arbitrarily large attempt counts", () => {
      expect(retryDelayMs(50, SLOW_RETRY_MAX_DELAY_MS)).toBe(SLOW_RETRY_MAX_DELAY_MS);
    });
  });
});
