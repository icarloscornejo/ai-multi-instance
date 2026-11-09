import type { AgentState } from "./types";

// Why Restart is unavailable, or null when it is allowed. A missing state entry covers not
// Claude, not running and no hook reporting: none of those can be proven idle.
export function restartBlockReason(agentState: AgentState | undefined, pending: boolean): string | null {
  if (pending) return "A restart is already running for this session.";
  if (agentState === undefined) return "Only a Claude session that reports its state to the dashboard can be restarted.";
  if (agentState !== "idle") return "Wait until the session is idle; a restart would cut the current turn.";
  return null;
}
