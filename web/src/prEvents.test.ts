import { describe, expect, it } from "vitest";
import { prEventsBadgeText, prEventsStatusDot, prEventsStatusLabel } from "./prEvents";

describe("prEventsStatusDot", () => {
  it("colors the status like a traffic light", () => {
    expect(prEventsStatusDot("ok")).toBe("bg-diff-added");
    expect(prEventsStatusDot("no-pr")).toBe("bg-status-warn");
    expect(prEventsStatusDot("paused")).toBe("bg-status-warn");
    expect(prEventsStatusDot("no-token")).toBe("bg-diff-removed");
    expect(prEventsStatusDot("error")).toBe("bg-diff-removed");
    expect(prEventsStatusDot("off")).toBe("bg-txt-dim");
    expect(prEventsStatusDot("unsupported")).toBe("bg-txt-dim");
  });
});

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

import {
  prEventsBadgeTitle as badgeTitleFor,
  prEventsCheckboxText as checkboxTextFor,
  prEventsHeading as headingFor,
  prEventsStatusLabel as statusLabelFor,
} from "./prEvents";

describe("provider aware wording", () => {
  const host = "gitlab.example.com";

  it("keeps every GitHub string exactly as before when the provider is absent or github", () => {
    for (const status of STATUSES) {
      expect(statusLabelFor(status, "github")).toEqual(statusLabelFor(status));
      expect(statusLabelFor(status, undefined, undefined)).toEqual(statusLabelFor(status));
    }
    expect(statusLabelFor("no-token").hint).toBe(
      "No GitHub token visible to the server: log in with gh or export GITHUB_TOKEN where the server starts"
    );
    expect(headingFor()).toBe("GitHub updates");
    expect(headingFor("github")).toBe("GitHub updates");
    expect(badgeTitleFor()).toBe("GitHub updates waiting for the agent");
    expect(checkboxTextFor()).toBe("Send failed checks and reviews of the pull request to the agent");
  });

  it("gives every GitLab status a non-empty label, all different", () => {
    const labels: string[] = STATUSES.map((status) => statusLabelFor(status, "gitlab", host).label);

    for (const label of labels) expect(label.trim()).not.toBe("");
    expect(new Set(labels).size).toBe(STATUSES.length);
  });

  it("talks about GitLab and merge requests, never GitHub, for a GitLab instance", () => {
    for (const status of STATUSES) {
      const { label, hint } = statusLabelFor(status, "gitlab", host);
      expect(`${label} ${hint ?? ""}`).not.toMatch(/github|pull request/i);
    }
    expect(statusLabelFor("no-pr", "gitlab", host).label).toMatch(/merge request/i);
    expect(statusLabelFor("ok", "gitlab", host).label).toMatch(/merge request/i);
    expect(statusLabelFor("error", "gitlab", host).label).toMatch(/GitLab/);
  });

  it("names the host in the no-token hint", () => {
    const { label, hint } = statusLabelFor("no-token", "gitlab", host);

    expect(label).toMatch(/token/i);
    expect(hint).toBe(
      "No GitLab token visible to the server for gitlab.example.com: add this host in Settings with the name of the variable that holds its token, set GITLAB_TOKEN together with GITLAB_HOST=gitlab.example.com, or log in with glab"
    );
  });

  it("copes with a GitLab instance whose host is unknown", () => {
    const { hint } = statusLabelFor("no-token", "gitlab");

    expect(hint).toMatch(/GitLab token/);
    expect(hint).not.toMatch(/undefined|null/);
  });

  it("names the host in the unsupported label without claiming only github.com works", () => {
    const { label } = statusLabelFor("unsupported", "gitlab", host);

    expect(label).not.toMatch(/github\.com/i);
  });

  it("carries no hint for the GitLab statuses that need no action", () => {
    for (const status of ["ok", "off", "paused"] as const) expect(statusLabelFor(status, "gitlab", host).hint).toBeNull();
  });

  it("uses GitLab headings, tooltips and checkbox text", () => {
    expect(headingFor("gitlab")).toBe("GitLab updates");
    expect(badgeTitleFor("gitlab")).toBe("GitLab updates waiting for the agent");
    expect(checkboxTextFor("gitlab")).toMatch(/failed jobs/i);
    expect(checkboxTextFor("gitlab")).toMatch(/merge request/i);
    expect(checkboxTextFor("gitlab")).not.toMatch(/github|pull request/i);
  });
});
