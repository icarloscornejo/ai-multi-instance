import { describe, expect, it } from "vitest";
import { describeLiveStatus, formatAge, formatReview, formatUpstream, upstreamFor } from "./liveStatusFormatting";
import type { BranchUpstream, LiveStatus } from "./types";

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

function tracking(ahead: number, behind: number): BranchUpstream {
  return { branch: "feat", state: "tracking", ahead, behind, remoteName: "origin", pushRef: "refs/remotes/origin/feat" };
}

describe("formatUpstream", () => {
  it("flags an unpublished branch as a warning", () => {
    expect(formatUpstream({ branch: "feat", state: "unpublished" })).toEqual({ text: "unpublished", colorClass: "text-status-warn" });
  });

  it("says a vanished remote branch is gone, without alarm", () => {
    expect(formatUpstream({ branch: "feat", state: "gone" })).toEqual({ text: "remote gone", colorClass: "text-txt-dim" });
  });

  it("shows up to date when nothing is ahead or behind", () => {
    expect(formatUpstream(tracking(0, 0))).toEqual({ text: "up to date", colorClass: "text-txt-dim" });
  });

  it("warns only when there are unpushed commits", () => {
    expect(formatUpstream(tracking(2, 0))).toEqual({ text: "↑2", colorClass: "text-status-warn" });
    expect(formatUpstream(tracking(2, 1))).toEqual({ text: "↑2 ↓1", colorClass: "text-status-warn" });
    expect(formatUpstream(tracking(0, 3))).toEqual({ text: "↓3", colorClass: "text-txt-dim" });
  });
});

describe("formatReview", () => {
  const checkedAt = "2026-10-26T20:00:00.000Z";

  it("writes a GitLab merge request as !N and a GitHub pull request as #N, linked to the page", () => {
    const merge = formatReview({ state: "found", number: 7, kind: "gitlab", url: "https://h/g/r/-/merge_requests/7", checkedAt, stale: false });
    const pull = formatReview({ state: "found", number: 45, kind: "github", url: "https://github.com/o/r/pull/45", checkedAt, stale: false });
    expect(merge).toEqual({ text: "!7", href: "https://h/g/r/-/merge_requests/7", dimmed: false, title: undefined });
    expect(pull).toMatchObject({ text: "#45", href: "https://github.com/o/r/pull/45" });
  });

  it("shows the number without a link when the server could not build the URL, or it is not https", () => {
    expect(formatReview({ state: "found", number: 7, kind: "gitlab", url: null, checkedAt, stale: false }).href).toBeNull();
    expect(formatReview({ state: "found", number: 7, kind: "gitlab", url: "javascript:alert(1)", checkedAt, stale: false })).toMatchObject({
      text: "!7",
      href: null,
    });
  });

  it("dims a stale answer and says it may be outdated", () => {
    const stale = formatReview({ state: "found", number: 7, kind: "gitlab", url: "https://h/g/r/-/merge_requests/7", checkedAt, stale: true });
    expect(stale.dimmed).toBe(true);
    expect(stale.title).toContain("may be outdated");
    expect(formatReview({ state: "none", checkedAt, stale: true })).toMatchObject({ text: "no MR/PR", dimmed: true });
  });

  it("says there is none, and that it has not been checked yet", () => {
    expect(formatReview({ state: "none", checkedAt, stale: false })).toEqual({ text: "no MR/PR", href: null, dimmed: false, title: undefined });
    expect(formatReview({ state: "unknown" })).toMatchObject({ text: "MR/PR ?", href: null, title: "Not checked yet" });
  });
});

describe("upstreamFor", () => {
  const unpublished: BranchUpstream = { branch: "foo", state: "unpublished" };

  it("returns the upstream state when it names the displayed branch", () => {
    expect(upstreamFor(status({ upstream: unpublished }), "foo")).toEqual(unpublished);
  });

  it("hides it when it describes another branch than the displayed one", () => {
    expect(upstreamFor(status({ upstream: unpublished }), "bar")).toBeNull();
  });

  it("matches a displayed branch that rev-parse printed as heads/<name>", () => {
    expect(upstreamFor(status({ upstream: unpublished }), "heads/foo")).toEqual(unpublished);
  });

  it("is null without a status, a displayed branch or an upstream state", () => {
    expect(upstreamFor(null, "foo")).toBeNull();
    expect(upstreamFor(status({ upstream: unpublished }), undefined)).toBeNull();
    expect(upstreamFor(status(), "foo")).toBeNull();
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
