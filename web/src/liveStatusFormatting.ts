// Shared by the desktop inspector (Sidebar.tsx) and the mobile instance sheet
// (InstanceSettingsSheet.tsx), which render the same live-status fields in two different
// layouts. Hoisted here instead of duplicated so a label or a usage-severity threshold only
// needs to change in one place.
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
