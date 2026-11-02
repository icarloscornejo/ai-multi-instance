import { describe, expect, it } from "vitest";
import { prEventsBadgeText, prEventsStatusLabel } from "./prEvents";

const STATUSES = ["ok", "off", "paused", "no-token", "no-pr", "unsupported", "error"] as const;

describe("prEventsStatusLabel", () => {
  it.each(STATUSES)("gives %s a non-empty label", (status) => {
    expect(prEventsStatusLabel(status).label.trim()).not.toBe("");
  });

  it("gives every status a different label", () => {
    const labels: string[] = STATUSES.map((status) => prEventsStatusLabel(status).label);

    expect(new Set(labels).size).toBe(STATUSES.length);
  });

  it("explains how to fix a missing token", () => {
    const { label, hint } = prEventsStatusLabel("no-token");

    expect(label).toMatch(/token/i);
    expect(hint).toBe(
      "No GitHub token visible to the server: log in with gh or export GITHUB_TOKEN where the server starts"
    );
  });

  it("names the missing pull request and the unsupported host", () => {
    expect(prEventsStatusLabel("no-pr").label).toMatch(/pull request/i);
    expect(prEventsStatusLabel("unsupported").label).toMatch(/unsupported|github\.com/i);
  });

  it("carries no hint for the statuses that need no action", () => {
    expect(prEventsStatusLabel("ok").hint).toBeNull();
    expect(prEventsStatusLabel("off").hint).toBeNull();
    expect(prEventsStatusLabel("paused").hint).toBeNull();
  });
});

describe("prEventsBadgeText", () => {
  it("shows nothing when no event is pending", () => {
    expect(prEventsBadgeText(0)).toBeNull();
    expect(prEventsBadgeText(undefined)).toBeNull();
  });

  it("shows the count", () => {
    expect(prEventsBadgeText(1)).toBe("1");
    expect(prEventsBadgeText(42)).toBe("42");
  });

  it("caps large counts", () => {
    expect(prEventsBadgeText(99)).toBe("99");
    expect(prEventsBadgeText(100)).toBe("99+");
    expect(prEventsBadgeText(5000)).toBe("99+");
  });
});
