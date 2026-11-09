import { describe, expect, it } from "vitest";
import { restartBlockReason } from "./restartAction";

describe("restartBlockReason", () => {
  it("allows a restart for an idle session with no request pending", () => {
    expect(restartBlockReason("idle", false)).toBeNull();
  });

  it("blocks a session with no state entry, which covers not Claude, not running and no hooks", () => {
    const reason = restartBlockReason(undefined, false);

    expect(reason).not.toBeNull();
    expect(reason).toMatch(/\S/);
  });

  it.each(["working", "waiting"] as const)("blocks a %s session so a turn is never cut off", (state) => {
    expect(restartBlockReason(state, false)).toMatch(/\S/);
  });

  it("blocks while a restart request is already pending in this client, even when the state reads idle", () => {
    expect(restartBlockReason("idle", true)).toMatch(/\S/);
  });

  it("blocks while pending even when there is no state entry, because the state file vanishes after /exit", () => {
    expect(restartBlockReason(undefined, true)).toMatch(/\S/);
  });

  it("gives different reasons for a missing state, a busy session and a pending request", () => {
    const reasons = new Set([restartBlockReason(undefined, false), restartBlockReason("working", false), restartBlockReason("idle", true)]);

    expect(reasons.size).toBe(3);
  });
});
