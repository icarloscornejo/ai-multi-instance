import type { PaneAgent } from "./paneAgent";
import type { InstanceRecord } from "./types";

export type AgentState = "waiting" | "working" | "idle";

export interface ParsedAgentStateFile {
  state: AgentState;
  paneJobPid: number;
  updatedAt: string;
}

export interface AgentStateEntry {
  state: AgentState;
  updatedAt: string;
}

export interface AgentStateDeps {
  readState: (instanceId: string) => Promise<string | null>;
  findAgent: (instance: InstanceRecord) => Promise<PaneAgent>;
}

const AGENT_STATES: readonly string[] = ["waiting", "working", "idle"];

// The file is written by a hook script outside our control, so every read re-validates it
// against the closed values instead of trusting what the writer was supposed to produce.
export function parseAgentStateFile(raw: string): ParsedAgentStateFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { state, paneJobPid, updatedAt } = parsed as Record<string, unknown>;
  if (typeof state !== "string" || !AGENT_STATES.includes(state)) return null;
  if (typeof paneJobPid !== "number" || !Number.isFinite(paneJobPid)) return null;
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) return null;
  return { state: state as AgentState, paneJobPid, updatedAt };
}

// Reads the file first and probes the pane only when it is valid, since the probe costs a
// tmux and ps call per instance.
export async function resolveAgentStates(
  instances: InstanceRecord[],
  deps: AgentStateDeps
): Promise<Record<string, AgentStateEntry>> {
  const resolved: Record<string, AgentStateEntry> = {};
  await Promise.all(
    instances.map(async (instance) => {
      const raw: string | null = await deps.readState(instance.id);
      if (raw === null) return;
      const parsed: ParsedAgentStateFile | null = parseAgentStateFile(raw);
      if (parsed === null) return;
      const agent: PaneAgent = await deps.findAgent(instance);
      if (agent.kind !== "agent" || agent.provider !== "claude" || agent.paneJobPid !== parsed.paneJobPid) return;
      resolved[instance.id] = { state: parsed.state, updatedAt: parsed.updatedAt };
    })
  );
  return resolved;
}
