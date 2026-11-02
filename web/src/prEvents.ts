import type { PrEventsProvider, PrEventsStatus } from "./types";

export const NO_TOKEN_HINT =
  "No GitHub token visible to the server: log in with gh or export GITHUB_TOKEN where the server starts";

type StatusText = { label: string; hint: string | null };

const LABELS: Record<PrEventsStatus, StatusText> = {
  ok: { label: "Watching the pull request", hint: null },
  off: { label: "Off", hint: null },
  paused: { label: "Paused", hint: null },
  "no-token": { label: "No GitHub token", hint: NO_TOKEN_HINT },
  "no-pr": { label: "No open pull request", hint: null },
  unsupported: { label: "Unsupported host, only github.com works", hint: null },
  error: { label: "Could not reach GitHub", hint: null },
};

function gitlabNoTokenHint(host: string | undefined): string {
  const forHost: string = host === undefined ? "" : ` for ${host}`;
  const hostSetting: string = host === undefined ? "GITLAB_HOST" : `GITLAB_HOST=${host}`;
  return (
    `No GitLab token visible to the server${forHost}: add ${host === undefined ? "the" : "this"} host in Settings with the name of the variable that holds its token, ` +
    `set GITLAB_TOKEN together with ${hostSetting}, or log in with glab`
  );
}

function gitlabLabels(host: string | undefined): Record<PrEventsStatus, StatusText> {
  return {
    ok: { label: "Watching the merge request", hint: null },
    off: { label: "Off", hint: null },
    paused: { label: "Paused", hint: null },
    "no-token": { label: "No GitLab token", hint: gitlabNoTokenHint(host) },
    "no-pr": { label: "No open merge request", hint: null },
    unsupported: { label: host === undefined ? "Unsupported GitLab host" : `Unsupported GitLab host ${host}`, hint: null },
    error: { label: "Could not reach GitLab", hint: null },
  };
}

export function prEventsStatusLabel(status: PrEventsStatus, provider?: PrEventsProvider, host?: string): StatusText {
  return provider === "gitlab" ? gitlabLabels(host)[status] : LABELS[status];
}

// Traffic light for the status line: green watching, yellow nothing to watch yet or paused,
// red needs the user (no token, unreachable), grey off or not applicable.
const STATUS_DOT: Record<PrEventsStatus, string> = {
  ok: "bg-diff-added",
  paused: "bg-status-warn",
  "no-pr": "bg-status-warn",
  "no-token": "bg-diff-removed",
  error: "bg-diff-removed",
  off: "bg-txt-dim",
  unsupported: "bg-txt-dim",
};

export function prEventsStatusDot(status: PrEventsStatus): string {
  return STATUS_DOT[status];
}

export function prEventsHeading(provider?: PrEventsProvider): string {
  return provider === "gitlab" ? "GitLab updates" : "GitHub updates";
}

export function prEventsBadgeTitle(provider?: PrEventsProvider): string {
  return `${prEventsHeading(provider)} waiting for the agent`;
}

export function prEventsCheckboxText(provider?: PrEventsProvider): string {
  return provider === "gitlab"
    ? "Send failed jobs and approvals of the merge request to the agent"
    : "Send failed checks and reviews of the pull request to the agent";
}

// Null hides the badge. Capped so a long queue cannot widen the rail.
export function prEventsBadgeText(pending: number | undefined): string | null {
  if (pending === undefined || pending <= 0) return null;
  return pending > 99 ? "99+" : String(pending);
}
