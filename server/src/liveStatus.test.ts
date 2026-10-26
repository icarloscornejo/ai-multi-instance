import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSnapshotOfAgent,
  ownedSessionIds,
  persistableSession,
  resolveLiveStatus,
  withAccountRateLimits,
  type SiblingSnapshot,
  type Snapshot,
} from "./liveStatus";
import type { AgentFound, PaneAgent } from "./paneAgent";

const NOW = Date.parse("2026-10-25T22:30:00Z");

function agent(overrides: Partial<AgentFound> = {}): AgentFound {
  return {
    kind: "agent",
    provider: "claude",
    paneJobPid: 500,
    agentPid: 501,
    startedAtMs: NOW - 60_000,
    resumeId: null,
    ...overrides,
  };
}

function snapshot(overrides: Snapshot = {}): Snapshot {
  return {
    provider: "claude",
    sessionId: "session-a",
    paneJobPid: 500,
    idSource: "env",
    configDir: "/profiles/me",
    contextUsed: 100,
    updatedAt: "2026-10-25T22:29:00Z",
    ...overrides,
  };
}

describe("isSnapshotOfAgent", () => {
  it("matches by pane job pid", () => {
    expect(isSnapshotOfAgent(snapshot(), agent())).toBe(true);
    expect(isSnapshotOfAgent(snapshot({ paneJobPid: 499 }), agent())).toBe(false);
  });

  it("never matches a snapshot of another provider, even on the same pid", () => {
    expect(isSnapshotOfAgent(snapshot({ provider: "codex" }), agent())).toBe(false);
  });

  it("accepts the server's pre-launch resume snapshot (no pid) when it names the session being resumed", () => {
    const resumeSnapshot = snapshot({ paneJobPid: undefined });
    expect(isSnapshotOfAgent(resumeSnapshot, agent({ resumeId: "session-a" }))).toBe(true);
    expect(isSnapshotOfAgent(resumeSnapshot, agent({ resumeId: "session-z" }))).toBe(false);
    expect(isSnapshotOfAgent(resumeSnapshot, agent())).toBe(false);
  });

  it("rejects an old snapshot that merely names the session being resumed again by hand", () => {
    const threeDaysOld = snapshot({ paneJobPid: undefined, updatedAt: "2026-10-22T23:31:34Z" });
    expect(isSnapshotOfAgent(threeDaysOld, agent({ resumeId: "session-a" }))).toBe(false);
  });
});

describe("persistableSession", () => {
  const instance = { provider: "claude" as const, configDir: undefined as string | undefined };
  const idle: PaneAgent = { kind: "none" };

  it("learns the profile from a dashboard-launched snapshot", () => {
    expect(persistableSession(instance, snapshot(), agent())).toEqual({ sessionId: "session-a", pinConfigDir: "/profiles/me" });
  });

  it("still saves the session once the agent has exited and the pane is idle", () => {
    expect(persistableSession({ ...instance, configDir: "/profiles/me" }, snapshot(), idle)).toEqual({ sessionId: "session-a" });
  });

  it("ignores a hand-run session of another profile (claude-in inside a claude-me instance)", () => {
    const handRun = snapshot({ configDir: "/profiles/in", idSource: "tmux" });
    expect(persistableSession({ ...instance, configDir: "/profiles/me" }, handRun, agent())).toBeNull();
    // ...and must not teach the instance its profile either
    expect(persistableSession(instance, handRun, agent())).toBeNull();
  });

  it("keeps saving for an instance that predates configDir when the snapshot is dashboard-launched", () => {
    expect(persistableSession(instance, snapshot(), idle)?.sessionId).toBe("session-a");
  });

  it("ignores another provider's session in this instance", () => {
    const codexInClaude = snapshot({ provider: "codex", sessionId: "codex-1" });
    expect(persistableSession({ provider: "claude", configDir: "/profiles/me" }, codexInClaude, idle)).toBeNull();
  });

  it("ignores a leftover snapshot while a different agent is alive in the pane", () => {
    expect(persistableSession({ ...instance, configDir: "/profiles/me" }, snapshot(), agent({ paneJobPid: 777 }))).toBeNull();
  });

  it("ignores snapshots with no pane job pid (nothing proves they came from this pane)", () => {
    expect(persistableSession(instance, snapshot({ paneJobPid: undefined }), idle)).toBeNull();
  });

  it("saves a codex session for a codex instance without any profile rule", () => {
    const codex = snapshot({ provider: "codex", sessionId: "codex-1", idSource: undefined, configDir: undefined });
    expect(persistableSession({ provider: "codex", configDir: undefined }, codex, idle)).toEqual({ sessionId: "codex-1" });
  });
});

describe("withAccountRateLimits", () => {
  // Reset times far in the future: an already-reset window is skipped (covered by its own test).
  const limits = { fiveHourPct: 40, fiveHourResetsAt: 2e12, sevenDayPct: 50, sevenDayResetsAt: 2e12 };

  function sibling(id: string, overrides: Snapshot): SiblingSnapshot {
    return { instanceId: id, snapshot: snapshot({ ...limits, ...overrides }) };
  }

  it("borrows the freshest limits from an instance of the same profile", () => {
    const own = snapshot({ updatedAt: "2026-10-25T20:00:00Z" });
    const result = withAccountRateLimits(
      own,
      [sibling("b", { updatedAt: "2026-10-25T22:00:00Z" }), sibling("c", { updatedAt: "2026-10-25T21:00:00Z", fiveHourPct: 1 })],
      "a"
    );
    expect(result).toMatchObject({ fiveHourPct: 40, rateLimitsUpdatedAt: "2026-10-25T22:00:00.000Z" });
  });

  it("keeps its own limits when they are the freshest", () => {
    const own = snapshot({ ...limits, fiveHourPct: 9, updatedAt: "2026-10-25T22:29:00Z" });
    const result = withAccountRateLimits(own, [sibling("b", { updatedAt: "2026-10-25T20:00:00Z" })], "a");
    expect(result).toMatchObject({ fiveHourPct: 9, rateLimitsUpdatedAt: "2026-10-25T22:29:00.000Z" });
  });

  it("takes each window from the freshest reading that has it (a session can report only one)", () => {
    const own = snapshot({ fiveHourPct: undefined, fiveHourResetsAt: undefined, sevenDayPct: 26, sevenDayResetsAt: 2e12, updatedAt: "2026-10-25T22:29:00Z" });
    const result = withAccountRateLimits(own, [sibling("b", { fiveHourPct: 45, fiveHourResetsAt: 2e12, sevenDayPct: 99, sevenDayResetsAt: 2e12, updatedAt: "2026-10-25T22:00:00Z" })], "a", NOW);
    expect(result).toMatchObject({ fiveHourPct: 45, sevenDayPct: 26 });
  });

  it("skips a reading of a window that has already reset", () => {
    const own = snapshot({ fiveHourPct: 10, fiveHourResetsAt: NOW / 1000 + 3600, updatedAt: "2026-10-25T20:00:00Z" });
    const expired = sibling("b", { fiveHourPct: 95, fiveHourResetsAt: NOW / 1000 - 60, updatedAt: "2026-10-25T22:00:00Z" });
    expect(withAccountRateLimits(own, [expired], "a", NOW).fiveHourPct).toBe(10);
  });

  it("does not share across profiles", () => {
    const result = withAccountRateLimits(snapshot(), [sibling("b", { configDir: "/profiles/in" })], "a");
    expect(result.fiveHourPct).toBeUndefined();
  });

  it("does not share when the profile is unknown on either side", () => {
    expect(withAccountRateLimits(snapshot({ configDir: undefined }), [sibling("b", { configDir: undefined })], "a").fiveHourPct).toBeUndefined();
    expect(withAccountRateLimits(snapshot(), [sibling("b", { configDir: undefined })], "a").fiveHourPct).toBeUndefined();
  });

  it("does not share between providers", () => {
    const codexOwn = snapshot({ provider: "codex" });
    expect(withAccountRateLimits(codexOwn, [sibling("b", {})], "a").fiveHourPct).toBeUndefined();
    expect(withAccountRateLimits(snapshot(), [sibling("b", { provider: "codex" })], "a").fiveHourPct).toBeUndefined();
  });

  it("does not borrow from itself", () => {
    expect(withAccountRateLimits(snapshot(), [sibling("a", { updatedAt: "2026-10-25T22:29:59Z" })], "a").fiveHourPct).toBeUndefined();
  });
});

describe("ownedSessionIds", () => {
  it("lists only other instances' recent sessions", () => {
    const siblings: SiblingSnapshot[] = [
      { instanceId: "me", snapshot: snapshot({ sessionId: "mine" }) },
      { instanceId: "b", snapshot: snapshot({ sessionId: "theirs", updatedAt: "2026-10-25T22:29:00Z" }) },
      { instanceId: "c", snapshot: snapshot({ sessionId: "ancient", updatedAt: "2026-10-20T00:00:00Z" }) },
    ];
    expect([...ownedSessionIds(siblings, "me", NOW)]).toEqual(["theirs"]);
  });
});

describe("resolveLiveStatus", () => {
  const instance = { id: "a", provider: "claude" as const, configDir: "/profiles/me" };
  const fallback = vi.fn(async (): Promise<Snapshot | null> => null);
  const enrichCodex = vi.fn(async (value: Snapshot): Promise<Snapshot> => ({ ...value, model: "gpt" }));

  // A queued mockResolvedValueOnce that a test never consumed would otherwise leak into the next.
  beforeEach(() => {
    fallback.mockReset();
  });

  function resolve(agentValue: PaneAgent, snapshotValue: Snapshot | null, fallbackValue: Snapshot | null = null) {
    fallback.mockResolvedValueOnce(fallbackValue);
    return resolveLiveStatus({ instance, agent: agentValue, snapshot: snapshotValue, siblings: [], fallback, enrichCodex });
  }

  it("says no agent when nothing known runs in the foreground, whatever the old snapshot says", async () => {
    const { response } = await resolve({ kind: "none" }, snapshot());
    expect(response).toEqual({ available: false, reason: "no-agent" });
  });

  it("serves the snapshot as before when the probe failed", async () => {
    const { response } = await resolve({ kind: "unknown" }, snapshot());
    expect(response).toMatchObject({ available: true, sessionId: "session-a" });
    expect(response.live).toBeUndefined();
  });

  it("marks the snapshot of the running agent as live", async () => {
    const { response } = await resolve(agent(), snapshot());
    expect(response).toMatchObject({ available: true, live: true, sessionId: "session-a" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to the agent's own files when the snapshot is from an earlier session", async () => {
    const { response } = await resolve(agent(), snapshot({ paneJobPid: 1 }), { provider: "claude", sessionId: "from-transcript" });
    expect(response).toMatchObject({ available: true, live: false, sessionId: "from-transcript" });
  });

  it("never shows an old snapshot as the running agent's data when the fallback finds nothing", async () => {
    const { response } = await resolve(agent(), snapshot({ paneJobPid: 1 }), null);
    expect(response).toEqual({ available: false, reason: "no-data", provider: "claude" });
  });

  it("enriches a codex snapshot by the snapshot's own provider", async () => {
    const { response } = await resolve(agent({ provider: "codex" }), snapshot({ provider: "codex" }));
    expect(response).toMatchObject({ live: true, model: "gpt" });
  });
});
