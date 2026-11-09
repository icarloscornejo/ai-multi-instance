import { promises as fs } from "node:fs";
import path from "node:path";
import { snapshotDirectory } from "./liveStatus";
import { findPaneAgent, type PaneAgent } from "./paneAgent";
import type { InstanceRecord } from "./types";

export type AgentState = "waiting" | "working" | "idle";

export interface ParsedAgentStateFile {
  state: AgentState;
  paneJobPid: number;
  // Optional so hand-built fixtures stay valid; the parser always sets it.
  sessionId?: string | null;
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
  const { state, paneJobPid, updatedAt, sessionId } = parsed as Record<string, unknown>;
  if (typeof state !== "string" || !AGENT_STATES.includes(state)) return null;
  if (typeof paneJobPid !== "number" || !Number.isFinite(paneJobPid)) return null;
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) return null;
  return { state: state as AgentState, paneJobPid, sessionId: typeof sessionId === "string" ? sessionId : null, updatedAt };
}

// A missing file is the normal "no state yet"; anything else is a real fault worth a log line.
export function readAgentStateFile(instanceId: string): Promise<string | null> {
  return fs.readFile(path.join(snapshotDirectory(), `${instanceId}.state.json`), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      console.error(`[server] could not read the agent state of ${instanceId}: ${error.message}`);
    }
    return null;
  });
}

// What the instance's pane is running right now. A custom command is whatever the user typed:
// "no known agent" says nothing about it, so unless a known agent is actually found there it is
// served from its snapshot like before instead of being reported as not running.
export async function probePaneAgent(instance: InstanceRecord, options: { bypassCache?: boolean } = {}): Promise<PaneAgent> {
  const found: PaneAgent = await (options.bypassCache === true
    ? findPaneAgent(instance.tmuxSession, Date.now(), options)
    : findPaneAgent(instance.tmuxSession));
  return instance.provider === "custom" && found.kind !== "agent" ? { kind: "unknown" } : found;
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
