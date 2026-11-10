import { ApiError } from "./apiError";
import type { AgentState, RestartResult } from "./types";

// Why Restart is unavailable, or null when it is allowed. A missing state entry covers not
// Claude, not running and no hook reporting: none of those can be proven idle.
export function restartBlockReason(agentState: AgentState | undefined, pending: boolean): string | null {
  if (pending) return "A restart is already running for this session.";
  if (agentState === undefined) return "Only a Claude session that reports its state to the dashboard can be restarted.";
  if (agentState !== "idle") return "Wait until the session is idle; a restart would cut the current turn.";
  return null;
}

export interface RestartNotice {
  tone: "ok" | "warn" | "error";
  text: string;
}

// A late answer may replace only the placeholder it came from, or fill an empty slot, never another restart's notice.
export function shouldApplyLateNotice(shownOwner: string | null, lateOwner: string): boolean {
  return shownOwner === null || shownOwner === lateOwner;
}

// Turns the restart request into a short notice, and never waits past the deadline: a response
// lost between the server and the browser once left the UI stuck on "Restarting..." forever.
// When the real answer comes after the deadline it is handed to onLate, since a fresh start or a
// failed resume takes longer than the deadline and its notice would otherwise be thrown away.
export async function restartNotice(
  label: string,
  request: Promise<RestartResult>,
  deadlineMs: number,
  onLate?: (notice: RestartNotice) => void
): Promise<RestartNotice> {
  let deadlineHit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RestartNotice>((resolve) => {
    timer = setTimeout(() => {
      deadlineHit = true;
      resolve({ tone: "warn", text: `${label}: no answer yet; the restart may still be finishing, check its terminal.` });
    }, deadlineMs);
  });
  const answer: Promise<RestartNotice> = request
    .then(
      (result): RestartNotice => {
        const versions: string = result.versionAfter !== null ? ` on ${result.versionAfter}` : "";
        const notes: string[] = [];
        const warnings: string[] = [];
        if (result.startedFresh === "no-conversation") notes.push("started fresh, there was no conversation yet");
        if (result.startedFresh === "resume-failed") warnings.push("could not resume the conversation, started fresh");
        if (result.autoMode === "unconfirmed") warnings.push("auto mode not confirmed, check the footer");
        if (result.commandSource !== "process") warnings.push("launch flags were rebuilt");
        const details: string[] = [...notes, ...warnings];
        const text = `${label} restarted${versions}${details.length > 0 ? `; ${details.join("; ")}` : ""}.`;
        return { tone: warnings.length > 0 ? "warn" : "ok", text };
      },
      (error: unknown): RestartNotice => {
        if (error instanceof ApiError) return { tone: error.relaunchSent ? "warn" : "error", text: error.message };
        return { tone: "error", text: `${label}: could not restart the session.` };
      }
    )
    .then((notice) => {
      if (deadlineHit) onLate?.(notice);
      return notice;
    });
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
