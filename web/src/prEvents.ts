import type { PrEventsStatus } from "./types";

export const NO_TOKEN_HINT =
  "No GitHub token visible to the server: log in with gh or export GITHUB_TOKEN where the server starts";

const LABELS: Record<PrEventsStatus, { label: string; hint: string | null }> = {
  ok: { label: "Watching the pull request", hint: null },
  off: { label: "Off", hint: null },
  paused: { label: "Paused", hint: null },
  "no-token": { label: "No GitHub token", hint: NO_TOKEN_HINT },
  "no-pr": { label: "No open pull request", hint: null },
  unsupported: { label: "Unsupported host, only github.com works", hint: null },
  error: { label: "Could not reach GitHub", hint: null },
};

export function prEventsStatusLabel(status: PrEventsStatus): { label: string; hint: string | null } {
  return LABELS[status];
}

// Null hides the badge. Capped so a long queue cannot widen the rail.
export function prEventsBadgeText(pending: number | undefined): string | null {
  if (pending === undefined || pending <= 0) return null;
  return pending > 99 ? "99+" : String(pending);
}
