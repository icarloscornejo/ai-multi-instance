import { useEffect, useState, type ReactNode } from "react";
import { useLiveStatus } from "../hooks/useLiveStatus";
import type { Instance, UpdateInstancePayload } from "../types";

const PROVIDER_LABELS = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor Agent",
  custom: "Custom command",
} as const;
const PROVIDER_DEFAULT_COMMANDS = { claude: "claude", codex: "codex", cursor: "agent", custom: "" } as const;

const compactNumberFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value).toLowerCase();
}

function formatShortResetTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatLongResetTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// 4-band usage severity, roughly matching common dashboard conventions
// (green below 60%, red at 90%+), with an extra orange band between yellow and red.
function usagePctColorClass(pct: number): string {
  if (pct >= 90) return "text-diff-removed";
  if (pct >= 80) return "text-status-orange";
  if (pct >= 60) return "text-status-yellow";
  return "text-diff-added";
}

function formatAge(isoTimestamp: string): string {
  const ageSeconds: number = Math.max(0, Math.round((Date.now() - new Date(isoTimestamp).getTime()) / 1000));
  return ageSeconds < 60 ? `${ageSeconds}s ago` : `${Math.round(ageSeconds / 60)}m ago`;
}

// Splits an absolute path into indented tree lines so long paths read top-to-bottom
// instead of wrapping mid-word in the narrow sidebar.
function pathToTreeLines(path: string): { text: string; depth: number }[] {
  const segments: string[] = path.split("/").filter((segment) => segment !== "");
  return [
    { text: "/", depth: 0 },
    ...segments.map((segment, index) => ({ text: `└ ${segment}`, depth: index + 1 })),
  ];
}

interface SidebarProps {
  instance: Instance;
  onUpdate: (instanceId: string, payload: UpdateInstancePayload) => void;
  onDeleteRequest: (instance: Instance) => void;
}

function FieldLabel({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="mb-[4px] flex items-center gap-[6px]">
      <div className="text-[11px] font-semibold uppercase tracking-[.02em] text-txt-bright">{children}</div>
      {action}
    </div>
  );
}

// navigator.clipboard requires a secure context (https, or the special-cased
// "localhost"/127.0.0.1 hosts): it silently throws on plain http://ai.local even
// though that resolves to loopback, so fall back to the legacy execCommand copy there.
async function copyText(value: string): Promise<void> {
  if (window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // fall through to the legacy fallback below
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState<boolean>(false);

  const copy = async (): Promise<void> => {
    try {
      await copyText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error("Copy to clipboard failed", error);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={title}
      aria-label={title}
      className="shrink-0 text-txt-dim hover:text-txt-secondary"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

export function Sidebar({ instance, onUpdate, onDeleteRequest }: SidebarProps) {
  const [commandDraft, setCommandDraft] = useState<string>(instance.command);
  const { liveStatus, gitBranch } = useLiveStatus(instance.id, true);

  // When switching tabs the sidebar shows a different instance: resync the draft
  useEffect(() => {
    setCommandDraft(instance.command);
  }, [instance.id, instance.command]);

  const liveBranch: string | undefined = liveStatus?.available === true ? liveStatus.branch ?? undefined : undefined;

  return (
    <aside className="flex w-[300px] flex-none flex-col gap-[18px] overflow-y-auto border-l border-border bg-surface p-[20px_18px]">
      <div className="border-b border-border pb-[14px] text-[13.5px] font-bold text-txt-bright">{instance.label}</div>

      <div>
        <FieldLabel action={<CopyButton value={instance.locationPath} title="Copy location path" />}>Location</FieldLabel>
        <div className="rounded-sm bg-raised px-[12px] py-[10px] font-mono text-[11.5px] text-txt-secondary">
          {pathToTreeLines(instance.locationPath).map((line, index) => (
            <div key={index} className="break-all" style={{ paddingLeft: line.depth * 10 }}>
              {line.text}
            </div>
          ))}
        </div>
      </div>

      <div>
        <FieldLabel>Provider</FieldLabel>
        <div className="mb-[7px] text-[12px] font-semibold text-txt-body">{PROVIDER_LABELS[instance.provider]}</div>
        <input
          className="note-field font-mono text-[12.5px] text-txt-body"
          value={commandDraft}
          placeholder={PROVIDER_DEFAULT_COMMANDS[instance.provider]}
          onChange={(event) => setCommandDraft(event.target.value)}
          onBlur={() =>
            onUpdate(instance.id, {
              command: commandDraft.trim() === "" ? PROVIDER_DEFAULT_COMMANDS[instance.provider] : commandDraft.trim(),
            })
          }
        />
      </div>

      {liveStatus === null && (
        <div className="text-[11px] text-txt-dimmer">Loading...</div>
      )}
      {liveStatus !== null && !liveStatus.available && (
        <div className="text-[11px] leading-[1.5] text-txt-dimmer">
          No live provider data yet. Session and git information will appear when {PROVIDER_LABELS[instance.provider]} exposes it.
        </div>
      )}

      {(liveBranch !== undefined || gitBranch !== null) && (
        <div>
          <FieldLabel action={<CopyButton value={(liveBranch ?? gitBranch) as string} title="Copy branch name" />}>
            Branch
          </FieldLabel>
          <div className="font-mono text-[12.5px] text-txt-body">
            {liveBranch ?? gitBranch}
            {(liveStatus?.gitAdded ?? 0) + (liveStatus?.gitRemoved ?? 0) > 0 && (
              <span>
                {" "}
                (+{liveStatus?.gitAdded ?? 0} -{liveStatus?.gitRemoved ?? 0})
              </span>
            )}
          </div>
        </div>
      )}

      {liveStatus !== null && liveStatus.available && (
        <>
          {liveStatus.model !== undefined && (
            <div>
              <FieldLabel>Model</FieldLabel>
              <div className="font-mono text-[12.5px] text-txt-body">{liveStatus.model}</div>
            </div>
          )}

          {liveStatus.effort !== undefined && (
            <div>
              <FieldLabel>Effort</FieldLabel>
              <div className="font-mono text-[12.5px] text-txt-body">{liveStatus.effort}</div>
            </div>
          )}

          {liveStatus.contextUsed !== undefined && liveStatus.contextSize !== undefined && (
            <div>
              <FieldLabel>Context</FieldLabel>
              <div className={`font-mono text-[12.5px] ${usagePctColorClass(liveStatus.contextPct ?? 0)}`}>
                {formatCompactNumber(liveStatus.contextUsed)}/{formatCompactNumber(liveStatus.contextSize)} ({Math.round(liveStatus.contextPct ?? 0)}%)
              </div>
            </div>
          )}

          {(liveStatus.inputTokens !== undefined || liveStatus.outputTokens !== undefined) && (
            <div>
              <FieldLabel>Tokens</FieldLabel>
              <div className="font-mono text-[12.5px] text-txt-body">
                {liveStatus.inputTokens !== undefined && `↓${formatCompactNumber(liveStatus.inputTokens)}`}
                {liveStatus.inputTokens !== undefined && liveStatus.outputTokens !== undefined && " "}
                {liveStatus.outputTokens !== undefined && `↑${formatCompactNumber(liveStatus.outputTokens)}`}
              </div>
            </div>
          )}

          {liveStatus.sessionCostUsd !== undefined && (
            <div>
              <FieldLabel>Session cost</FieldLabel>
              <div className="font-mono text-[12.5px] text-txt-body">${liveStatus.sessionCostUsd.toFixed(2)}</div>
            </div>
          )}

          {liveStatus.fiveHourPct != null && (
            <div>
              <FieldLabel>5H LIMIT</FieldLabel>
              <div className="font-mono text-[12.5px] text-txt-body">
                <span className={usagePctColorClass(liveStatus.fiveHourPct)}>{Math.round(liveStatus.fiveHourPct)}%</span>
                {liveStatus.fiveHourResetsAt != null && <span> → {formatShortResetTime(liveStatus.fiveHourResetsAt)}</span>}
              </div>
            </div>
          )}

          {liveStatus.sevenDayPct != null && (
            <div>
              <FieldLabel>7D LIMIT</FieldLabel>
              <div className="font-mono text-[12.5px] text-txt-body">
                <span className={usagePctColorClass(liveStatus.sevenDayPct)}>{Math.round(liveStatus.sevenDayPct)}%</span>
                {liveStatus.sevenDayResetsAt != null && <span> → {formatLongResetTime(liveStatus.sevenDayResetsAt)}</span>}
              </div>
            </div>
          )}

          {liveStatus.extraUsd != null && liveStatus.extraLimitUsd != null && (
            <div>
              <FieldLabel>Extra usage</FieldLabel>
              <div
                className={`font-mono text-[12.5px] ${usagePctColorClass(
                  liveStatus.extraLimitUsd > 0 ? (liveStatus.extraUsd / liveStatus.extraLimitUsd) * 100 : 0,
                )}`}
              >
                ${liveStatus.extraUsd.toFixed(2)}/${liveStatus.extraLimitUsd.toFixed(2)}
              </div>
            </div>
          )}

          {liveStatus.burnPerHour != null && (
            <div>
              <FieldLabel>Burn</FieldLabel>
              <div className="font-mono text-[12.5px] text-txt-body">${liveStatus.burnPerHour.toFixed(2)}/h</div>
            </div>
          )}

          {liveStatus.dayTotalUsd != null && (
            <div>
              <FieldLabel>Today</FieldLabel>
              <div className="font-mono text-[12.5px] text-txt-body">${liveStatus.dayTotalUsd.toFixed(2)}</div>
            </div>
          )}

          {liveStatus.updatedAt !== undefined && (
            <div className="text-[11px] text-txt-dimmer">Updated {formatAge(liveStatus.updatedAt)}</div>
          )}
        </>
      )}

      <div className="mt-auto flex flex-col gap-[2px] border-t border-border pt-[14px]">
        <button
          type="button"
          onClick={() => onDeleteRequest(instance)}
          className="self-start rounded-sm px-[6px] py-[8px] text-[12px] font-semibold text-diff-removed hover:bg-diff-removed-dim"
        >
          ✕ Delete instance
        </button>
      </div>
    </aside>
  );
}
