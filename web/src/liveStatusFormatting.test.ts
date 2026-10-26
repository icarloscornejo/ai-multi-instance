import { describe, expect, it } from "vitest";
import { describeLiveStatus, formatAge } from "./liveStatusFormatting";
import type { LiveStatus } from "./types";

const NOW = Date.parse("2026-10-25T22:30:00Z");
const nowSeconds = NOW / 1000;

function status(overrides: Partial<LiveStatus> = {}): LiveStatus {
  return { available: true, provider: "claude", updatedAt: "2026-10-25T22:29:30Z", ...overrides };
}

describe("formatAge", () => {
  it("scales seconds, minutes, hours and days", () => {
    expect(formatAge("2026-10-25T22:29:30Z", NOW)).toBe("30s ago");
    expect(formatAge("2026-10-25T22:00:00Z", NOW)).toBe("30m ago");
    expect(formatAge("2026-10-25T09:30:00Z", NOW)).toBe("13h ago");
    expect(formatAge("2026-10-22T22:30:00Z", NOW)).toBe("3d ago");
  });
});

describe("describeLiveStatus", () => {
  it("reports loading before the first answer", () => {
    expect(describeLiveStatus(null, "claude", NOW)).toEqual({ kind: "loading" });
  });

  it("says plainly when no agent is running, instead of showing the last session's data", () => {
    expect(describeLiveStatus({ available: false, reason: "no-agent" }, "claude", NOW)).toEqual({
      kind: "empty",
      message: "No agent running in this instance.",
    });
  });

  it("names the agent that is running when it has nothing to read yet", () => {
    expect(describeLiveStatus({ available: false, reason: "no-data", provider: "codex" }, "claude", NOW)).toEqual({
      kind: "empty",
      message: "Codex CLI is running, but no data is available yet.",
    });
  });

  it("keeps the generic message when nothing is known", () => {
    const view = describeLiveStatus({ available: false }, "cursor", NOW);
    expect(view).toMatchObject({ kind: "empty" });
    expect((view as { message: string }).message).toContain("Cursor Agent");
  });

  it("marks fresh live data as fresh", () => {
    expect(describeLiveStatus(status({ live: true }), "claude", NOW)).toMatchObject({
      kind: "data",
      stale: false,
      fromTranscript: false,
      runningProvider: null,
      updatedAgo: "30s ago",
    });
  });

  it("dims data that has not been refreshed for over five minutes", () => {
    expect(describeLiveStatus(status({ updatedAt: "2026-10-25T09:30:00Z" }), "claude", NOW)).toMatchObject({
      stale: true,
      updatedAgo: "13h ago",
    });
  });

  it("labels data recovered from the agent's own files", () => {
    expect(describeLiveStatus(status({ live: false }), "claude", NOW)).toMatchObject({ fromTranscript: true });
  });

  it("shows the agent that is actually running when it is not the instance's provider", () => {
    expect(describeLiveStatus(status({ provider: "codex" }), "claude", NOW)).toMatchObject({ runningProvider: "codex" });
  });

  it("hides a rate-limit window whose reset time already passed", () => {
    const view = describeLiveStatus(
      status({
        fiveHourPct: 80,
        fiveHourResetsAt: nowSeconds - 60,
        sevenDayPct: 26,
        sevenDayResetsAt: nowSeconds + 86_400,
      }),
      "claude",
      NOW
    );
    expect(view).toMatchObject({ fiveHour: null, sevenDay: { pct: 26 } });
  });

  it("judges the limits by when they were reported, not by when the instance last ran", () => {
    const view = describeLiveStatus(
      status({ updatedAt: "2026-10-25T09:30:00Z", rateLimitsUpdatedAt: "2026-10-25T22:29:00Z" }),
      "claude",
      NOW
    );
    expect(view).toMatchObject({ stale: true, limitsStale: false });
  });

  it("carries the unreachable marker", () => {
    expect(describeLiveStatus(status({ unreachable: true }), "claude", NOW)).toMatchObject({ unreachable: true });
  });
});
