import type { AgentState } from "./types";

const LABELS: Record<AgentState, string> = {
  waiting: "Waiting",
  working: "Working",
  idle: "Idle",
};

// Only waiting uses the warn color; working and idle stay muted so the accent keeps meaning
// "selected" and a waiting instance is the one thing that stands out.
const TONES: Record<AgentState, string> = {
  waiting: "text-status-warn",
  working: "text-txt-secondary",
  idle: "text-txt-dim",
};

export function agentStateLabel(state: AgentState | undefined): string {
  return state === undefined ? "" : LABELS[state];
}

export function agentStateTone(state: AgentState): string {
  return TONES[state];
}

// Display order only: callers keep the stored order and never write this result back.
// Array.prototype.sort is stable, so each group keeps its stored order.
export function sortByWaiting<T extends { id: string }>(items: T[], states: Record<string, AgentState>): T[] {
  const rank = (item: T): number => (states[item.id] === "waiting" ? 0 : 1);
  return [...items].sort((first, second) => rank(first) - rank(second));
}
