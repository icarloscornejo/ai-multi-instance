import { describe, expect, it } from "vitest";
import { RETRY_MAX_DELAY_MS, SLOW_RETRY_MAX_DELAY_MS } from "./retry";
import { INITIAL_RECONNECT_STATE, reduceConnection, type ReconnectState } from "./reconnectPolicy";

function closeEvent(code: number, reason = "") {
  return { kind: "close" as const, code, reason };
}

describe("reduceConnection", () => {
  // The regression this whole module exists for: TerminalView.tsx's onopen used to reset
  // the ONLY retry counter directly, and since the WebSocket handshake always completes
  // before a pre-bridge attach failure closes it (index.ts's handleUpgrade finishes before
  // bridgeTerminal runs), every 4006 cycle looked like open->close(4006)->open->close(4006)
  // and the backoff computed from a counter freshly reset to 0 every time never grew past
  // 250ms. This test fails against that old behavior and passes only once "open" is wired
  // to leave attachStreak alone.
  it("grows the attach-failure backoff across repeated open -> close(4006) cycles, up to the 30s cap", () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    const observedDelays: (number | null)[] = [];
    for (let cycle = 0; cycle < 9; cycle += 1) {
      ({ state } = reduceConnection(state, { kind: "open" }));
      const result = reduceConnection(state, closeEvent(4006, "posix_spawnp failed."));
      state = result.state;
      observedDelays.push(result.effect.retryDelayMs);
    }
    expect(observedDelays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(state.attachStreak).toBe(9);
  });

  it("resets the attach streak back to 250ms once bridgeReady fires in between", () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    // Build up a streak first
    for (let i = 0; i < 4; i += 1) {
      ({ state } = reduceConnection(state, { kind: "open" }));
      ({ state } = reduceConnection(state, closeEvent(4006)));
    }
    expect(state.attachStreak).toBeGreaterThan(0);

    ({ state } = reduceConnection(state, { kind: "open" }));
    ({ state } = reduceConnection(state, { kind: "bridgeReady" }));
    expect(state.attachStreak).toBe(0);
    expect(state.normalAttempt).toBe(0);

    const nextFailure = reduceConnection(state, closeEvent(4006));
    expect(nextFailure.effect.retryDelayMs).toBe(250);
  });

  it("wake resets only the normal backoff, not the attach streak", () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    ({ state } = reduceConnection(state, { kind: "open" }));
    ({ state } = reduceConnection(state, closeEvent(4006)));
    ({ state } = reduceConnection(state, { kind: "open" }));
    ({ state } = reduceConnection(state, closeEvent(4000))); // a normal drop too
    expect(state.attachStreak).toBe(1);
    expect(state.normalAttempt).toBe(1);

    ({ state } = reduceConnection(state, { kind: "wake" }));
    expect(state.normalAttempt).toBe(0);
    expect(state.attachStreak).toBe(1);
  });

  it("manualReconnect resets both counters and clears fatal/transient state", () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    ({ state } = reduceConnection(state, closeEvent(4006)));
    ({ state } = reduceConnection(state, closeEvent(4007, "overflow")));
    expect(state.attachStreak).toBe(1);
    expect(state.transientNotice).not.toBeNull();

    ({ state } = reduceConnection(state, { kind: "manualReconnect" }));
    expect(state).toEqual(INITIAL_RECONNECT_STATE);
  });

  it("4004 and 4005 set a fatal reason and schedule no retry", () => {
    for (const code of [4004, 4005]) {
      const result = reduceConnection(INITIAL_RECONNECT_STATE, closeEvent(code, "Unknown instance"));
      expect(result.effect.retryDelayMs).toBeNull();
      expect(result.state.fatalReason).toBe("Unknown instance");
    }
  });

  it("a fatal reason is cleared once a fresh attempt opens", () => {
    const { state: afterFatal } = reduceConnection(INITIAL_RECONNECT_STATE, closeEvent(4004, "Unknown instance"));
    expect(afterFatal.fatalReason).not.toBeNull();
    const { state: afterOpen } = reduceConnection(afterFatal, { kind: "open" });
    expect(afterOpen.fatalReason).toBeNull();
  });

  it("4000 and an unlabeled close use the normal 5s cap, not the 30s slow cap", () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    for (let i = 0; i < 10; i += 1) {
      const result = reduceConnection(state, closeEvent(4000));
      state = result.state;
      expect(result.effect.retryDelayMs).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
    }
    const unlabeled = reduceConnection(INITIAL_RECONNECT_STATE, closeEvent(1006));
    expect(unlabeled.effect.retryDelayMs).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
  });

  it("4007 (input overflow) uses the normal backoff, not the attach streak", () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    const result = reduceConnection(state, closeEvent(4007, "Some input was discarded."));
    state = result.state;
    expect(result.effect.retryDelayMs).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
    expect(state.attachStreak).toBe(0);
    expect(state.normalAttempt).toBe(1);
    expect(state.transientNotice).toBe("Some input was discarded.");
  });

  it("transientNotice from a 4007 survives a subsequent open and a subsequent 4006 close, only bridgeReady clears it", () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    ({ state } = reduceConnection(state, closeEvent(4007, "dropped input")));
    expect(state.transientNotice).toBe("dropped input");

    ({ state } = reduceConnection(state, { kind: "open" }));
    expect(state.transientNotice).toBe("dropped input");

    ({ state } = reduceConnection(state, closeEvent(4006)));
    expect(state.transientNotice).toBe("dropped input");

    ({ state } = reduceConnection(state, { kind: "bridgeReady" }));
    expect(state.transientNotice).toBeNull();
  });

  it("interleaving 4006 and 4007 advances each counter independently without cross-contamination", () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    const attachDelay1 = reduceConnection(state, closeEvent(4006)).effect.retryDelayMs;
    ({ state } = reduceConnection(state, closeEvent(4006)));
    const overflowDelay1 = reduceConnection(state, closeEvent(4007)).effect.retryDelayMs;
    ({ state } = reduceConnection(state, closeEvent(4007)));
    const attachDelay2 = reduceConnection(state, closeEvent(4006)).effect.retryDelayMs;

    expect(attachDelay1).toBe(250); // attachStreak was 0
    expect(overflowDelay1).toBe(250); // normalAttempt was 0, independent of attachStreak=1
    expect(attachDelay2).toBe(500); // attachStreak was 1, unaffected by the 4007 in between
  });
});
