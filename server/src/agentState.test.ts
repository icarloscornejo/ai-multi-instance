import { describe, expect, it, vi } from "vitest";
import { parseAgentStateFile, resolveAgentStates, type AgentState } from "./agentState";
import type { PaneAgent } from "./paneAgent";
import type { InstanceRecord } from "./types";

function stateFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: "waiting",
    sessionId: "sess-1",
    paneJobPid: 4242,
    event: "PermissionRequest",
    updatedAt: "2026-11-02T10:00:00Z",
    ...overrides,
  });
}

function instance(id: string, overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id,
    label: id,
    locationPath: "/work/repo",
    tmuxSession: `ccdash-${id}`,
    provider: "claude",
    command: "claude",
    model: null,
    effort: null,
    fontSize: 13,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as InstanceRecord;
}

function agentOf(paneJobPid: number, provider: "claude" | "codex" | "cursor" = "claude"): PaneAgent {
  return { kind: "agent", provider, paneJobPid, agentPid: paneJobPid + 1, startedAtMs: 0, resumeId: null };
}

describe("parseAgentStateFile", () => {
  it.each(["waiting", "working", "idle"] as AgentState[])("accepts the closed value %s", (state) => {
    expect(parseAgentStateFile(stateFile({ state }))).toMatchObject({ state, paneJobPid: 4242, updatedAt: "2026-11-02T10:00:00Z" });
  });

  it("keeps the session id the hook wrote, so a restart can resume the right conversation", () => {
    expect(parseAgentStateFile(stateFile({ sessionId: "0198aaaa-bbbb-4ccc-8ddd-eeeeffff0001" }))).toMatchObject({
      sessionId: "0198aaaa-bbbb-4ccc-8ddd-eeeeffff0001",
    });
  });

  it.each([
    ["missing", stateFile({ sessionId: undefined })],
    ["a number", stateFile({ sessionId: 7 })],
    ["null", stateFile({ sessionId: null })],
  ])("reports a null session id when it is %s, without invalidating the file", (_name, raw) => {
    expect(parseAgentStateFile(raw)).toMatchObject({ state: "waiting", paneJobPid: 4242, sessionId: null });
  });

  it.each([
    ["an unknown state string", stateFile({ state: "blocked" })],
    ["a non-string state", stateFile({ state: 3 })],
    ["a missing state", stateFile({ state: undefined })],
    ["a date that does not parse", stateFile({ updatedAt: "yesterday-ish" })],
    ["a missing date", stateFile({ updatedAt: undefined })],
    ["a missing paneJobPid", stateFile({ paneJobPid: undefined })],
    ["a null paneJobPid", stateFile({ paneJobPid: null })],
    ["a string paneJobPid", stateFile({ paneJobPid: "4242" })],
    ["invalid JSON", "{nope"],
    ["empty content", ""],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
  ])("returns null for %s", (_name, raw) => {
    expect(parseAgentStateFile(raw)).toBeNull();
  });
});

describe("resolveAgentStates", () => {
  it("returns the state and its timestamp for a Claude agent whose pane job matches the file", async () => {
    const result = await resolveAgentStates([instance("aaaa1111")], {
      readState: async () => stateFile({ state: "working" }),
      findAgent: async () => agentOf(4242),
    });

    expect(result).toEqual({ aaaa1111: { state: "working", updatedAt: "2026-11-02T10:00:00Z" } });
  });

  it.each([
    ["the recorded pane job differs from the running one", agentOf(9999)],
    ["no agent is running", { kind: "none" } as PaneAgent],
    ["the probe could not tell", { kind: "unknown" } as PaneAgent],
    ["the detected agent is codex", agentOf(4242, "codex")],
    ["the detected agent is cursor", agentOf(4242, "cursor")],
  ])("omits the instance when %s", async (_name, agent) => {
    const result = await resolveAgentStates([instance("aaaa1111")], {
      readState: async () => stateFile(),
      findAgent: async () => agent,
    });

    expect(result).toEqual({});
  });

  it("counts a hand-started Claude inside a dashboard pane whatever the instance provider is", async () => {
    const result = await resolveAgentStates([instance("aaaa1111", { provider: "custom" })], {
      readState: async () => stateFile(),
      findAgent: async () => agentOf(4242),
    });

    expect(Object.keys(result)).toEqual(["aaaa1111"]);
  });

  it("omits instances with no state file or an invalid one, and never probes the pane for them", async () => {
    const findAgent = vi.fn(async (_instance: InstanceRecord) => agentOf(4242));
    const files: Record<string, string | null> = {
      aaaa1111: null,
      bbbb2222: stateFile({ state: "bogus" }),
      cccc3333: "{broken",
      dddd4444: stateFile(),
    };

    const result = await resolveAgentStates(
      Object.keys(files).map((id) => instance(id)),
      { readState: async (id: string) => files[id], findAgent }
    );

    expect(Object.keys(result)).toEqual(["dddd4444"]);
    expect(findAgent).toHaveBeenCalledTimes(1);
    expect(findAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "dddd4444" }));
  });

  it("asks for the state of registered instances only", async () => {
    const readState = vi.fn(async (_id: string) => null);

    const result = await resolveAgentStates([instance("aaaa1111")], { readState, findAgent: async () => agentOf(1) });

    expect(result).toEqual({});
    expect(readState.mock.calls.map((call) => call[0])).toEqual(["aaaa1111"]);
  });

  it("returns an empty map for no instances", async () => {
    expect(await resolveAgentStates([], { readState: async () => null, findAgent: async () => ({ kind: "none" }) })).toEqual({});
  });
});
