// Shared by the desktop inspector (Sidebar.tsx) and the mobile instance sheet
// (InstanceSettingsSheet.tsx), which render the same live-status fields in two different
// layouts. Hoisted here instead of duplicated so a label or a usage-severity threshold only
// needs to change in one place.
import type { AgentProvider, LiveStatus } from "./types";

export const PROVIDER_LABELS = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor Agent",
  custom: "Custom command",
} as const;

export const PROVIDER_DEFAULT_COMMANDS = { claude: "claude", codex: "codex", cursor: "agent", custom: "" } as const;

const compactNumberFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value).toLowerCase();
}

// 4-band usage severity, roughly matching common dashboard conventions
// (green below 60%, red at 90%+), with an extra warn band between yellow and red.
export function usagePctColorClass(pct: number): string {
  if (pct >= 90) return "text-diff-removed";
  if (pct >= 80) return "text-status-warn";
  if (pct >= 60) return "text-status-yellow";
  return "text-diff-added";
}

export function formatShortResetTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatLongResetTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatAge(isoTimestamp: string, nowMs: number = Date.now()): string {
  const ageSeconds: number = Math.max(0, Math.round((nowMs - new Date(isoTimestamp).getTime()) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86_400) return `${Math.round(ageSeconds / 3600)}h ago`;
  return `${Math.round(ageSeconds / 86_400)}d ago`;
}

// Past this, a reading was taken before the user last looked away: still the best data there
// is, but it must not be passed off as live.
export const STALE_AFTER_MS = 5 * 60_000;

function isStale(isoTimestamp: string | undefined, nowMs: number): boolean {
  if (isoTimestamp === undefined) return false;
  const timestampMs: number = Date.parse(isoTimestamp);
  return Number.isFinite(timestampMs) && nowMs - timestampMs > STALE_AFTER_MS;
}

export interface LimitView {
  pct: number;
  resetsAt: number | null;
}

// A window whose reset time has passed no longer describes the account: the percentage shown
// would be from the previous window.
function visibleLimit(pct: number | null | undefined, resetsAt: number | null | undefined, nowMs: number): LimitView | null {
  if (pct == null) return null;
  if (resetsAt != null && resetsAt * 1000 <= nowMs) return null;
  return { pct, resetsAt: resetsAt ?? null };
}

export type LiveStatusView =
  | { kind: "loading" }
  | { kind: "empty"; message: string }
  | {
      kind: "data";
      // Set only when the agent in the pane is not the instance's own provider.
      runningProvider: AgentProvider | null;
      fromTranscript: boolean;
      stale: boolean;
      updatedAgo: string | null;
      limitsStale: boolean;
      unreachable: boolean;
      fiveHour: LimitView | null;
      sevenDay: LimitView | null;
    };

export function describeLiveStatus(
  liveStatus: LiveStatus | null,
  instanceProvider: AgentProvider,
  nowMs: number = Date.now()
): LiveStatusView {
  if (liveStatus === null) return { kind: "loading" };
  if (!liveStatus.available) {
    if (liveStatus.reason === "no-agent") return { kind: "empty", message: "No agent running in this instance." };
    if (liveStatus.reason === "no-data") {
      const running: AgentProvider = liveStatus.provider ?? instanceProvider;
      return { kind: "empty", message: `${PROVIDER_LABELS[running]} is running, but no data is available yet.` };
    }
    return {
      kind: "empty",
      message: `No live provider data yet. Session and git information will appear when ${PROVIDER_LABELS[instanceProvider]} exposes it.`,
    };
  }
  return {
    kind: "data",
    runningProvider:
      liveStatus.provider !== undefined && liveStatus.provider !== instanceProvider ? liveStatus.provider : null,
    fromTranscript: liveStatus.live === false,
    stale: isStale(liveStatus.updatedAt, nowMs),
    updatedAgo: liveStatus.updatedAt === undefined ? null : formatAge(liveStatus.updatedAt, nowMs),
    limitsStale: isStale(liveStatus.rateLimitsUpdatedAt ?? liveStatus.updatedAt, nowMs),
    unreachable: liveStatus.unreachable === true,
    fiveHour: visibleLimit(liveStatus.fiveHourPct, liveStatus.fiveHourResetsAt, nowMs),
    sevenDay: visibleLimit(liveStatus.sevenDayPct, liveStatus.sevenDayResetsAt, nowMs),
  };
}
