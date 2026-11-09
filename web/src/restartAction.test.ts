import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiError";
import { restartBlockReason, restartNotice } from "./restartAction";
import type { RestartResult } from "./types";

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

describe("restartNotice", () => {
  const result: RestartResult = {
    ok: true,
    sessionId: "0198aaaa-bbbb-4ccc-8ddd-eeeeffff0001",
    versionBefore: "2.1.319",
    versionAfter: "2.1.321",
    autoMode: "on",
    commandSource: "process",
  };
  const never = (): Promise<RestartResult> => new Promise<RestartResult>(() => undefined);

  it("reports success with the label and the versions", async () => {
    const notice = await restartNotice("Auto-CC", Promise.resolve(result), 10_000);

    expect(notice.tone).toBe("ok");
    expect(notice.text).toContain("Auto-CC");
    expect(notice.text).toContain("2.1.321");
  });

  it("warns when auto mode could not be confirmed or the flags were rebuilt", async () => {
    expect((await restartNotice("Auto-CC", Promise.resolve({ ...result, autoMode: "unconfirmed" }), 10_000)).tone).toBe("warn");
    expect((await restartNotice("Auto-CC", Promise.resolve({ ...result, commandSource: "hint" }), 10_000)).tone).toBe("warn");
  });

  it("shows the server error text, as a warning when the relaunch was already sent", async () => {
    const failed = await restartNotice("Auto-CC", Promise.reject(new ApiError("There is text in the prompt.", 409)), 10_000);
    const sent = await restartNotice("Auto-CC", Promise.reject(new ApiError("Relaunch may be starting.", 504, true)), 10_000);

    expect(failed).toEqual({ tone: "error", text: "There is text in the prompt." });
    expect(sent.tone).toBe("warn");
  });

  it("stops waiting after the deadline instead of hanging, and says to check the terminal", async () => {
    vi.useFakeTimers();
    try {
      const pending = restartNotice("Auto-CC", never(), 10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      const notice = await pending;

      expect(notice.tone).toBe("warn");
      expect(notice.text).toMatch(/terminal/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
