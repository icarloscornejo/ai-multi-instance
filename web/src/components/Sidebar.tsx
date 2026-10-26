import { useEffect, useState, type ReactNode } from "react";
import {
  PROVIDER_DEFAULT_COMMANDS,
  PROVIDER_LABELS,
  describeLiveStatus,
  formatCompactNumber,
  formatLongResetTime,
  formatShortResetTime,
  usagePctColorClass,
} from "../liveStatusFormatting";
import type { Instance, LiveStatus, UpdateInstancePayload } from "../types";

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
  // Lifted from a single useLiveStatus call at the desktop workbench level (App.tsx) instead
  // of polled here directly: the session bar above the terminal shows the same branch, and
  // two independent polls would double the request traffic and could show two different
  // snapshots for the same instance.
  liveStatus: LiveStatus | null;
  gitBranch: string | null;
  onUpdate: (instanceId: string, payload: UpdateInstancePayload) => void;
  onDeleteRequest: (instance: Instance) => void;
}

// Each field sits below a top border except the very first one, matching the approved
// inspector's rhythm (see 03-main.html's .inspector-section).
function Section({ children }: { children: ReactNode }) {
  return <div className="border-t border-border pt-[12px] first:border-t-0 first:pt-0">{children}</div>;
}

function Eyebrow({ children }: { children: string }) {
  return <div className="mb-[6px] text-[10px] font-bold uppercase tracking-[.06em] text-txt-dim">{children}</div>;
}

// navigator.clipboard requires a secure context (https, or the special-cased
// "localhost"/127.0.0.1 hosts): it silently throws on plain http://ai.local even
// though that resolves to loopback, so fall back to the legacy execCommand copy there.
export async function copyText(value: string): Promise<void> {
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

export function Sidebar({ instance, liveStatus, gitBranch, onUpdate, onDeleteRequest }: SidebarProps) {
  const [commandDraft, setCommandDraft] = useState<string>(instance.command);

  // When switching tabs the sidebar shows a different instance: resync the draft
  useEffect(() => {
    setCommandDraft(instance.command);
  }, [instance.id, instance.command]);

  // "No agent" / "no data" answers carry the pane's branch too, so it keeps following checkouts
  // made with no agent running.
  const liveBranch: string | undefined = liveStatus?.branch ?? undefined;
  const view = describeLiveStatus(liveStatus, instance.provider);
  const dimmed: string = view.kind === "data" && view.stale ? " opacity-60" : "";
  const limitsDimmed: string = view.kind === "data" && view.limitsStale ? " opacity-60" : "";

  return (
    <aside className="flex w-[286px] flex-none flex-col gap-[14px] overflow-y-auto border-l border-border bg-surface p-[18px_16px]">
      <div className="text-[13px] font-bold text-txt-bright">{instance.label}</div>

      <Section>
        <Eyebrow>Location</Eyebrow>
        <div className="flex items-start gap-[8px]">
          <div className="min-w-0 flex-1 font-mono text-[11px] leading-[1.5] text-txt-secondary">
            {pathToTreeLines(instance.locationPath).map((line, index) => (
              <div key={index} className="break-all" style={{ paddingLeft: line.depth * 10 }}>
                {line.text}
              </div>
            ))}
          </div>
          <CopyButton value={instance.locationPath} title="Copy location path" />
        </div>
      </Section>

      <Section>
        <Eyebrow>Provider</Eyebrow>
        <div className="mb-[5px] text-[12px] font-semibold text-txt-body">{PROVIDER_LABELS[instance.provider]}</div>
        {view.kind === "data" && view.runningProvider !== null && (
          <div className="mb-[5px] text-[11px] text-status-warn">Running: {PROVIDER_LABELS[view.runningProvider]}</div>
        )}
        <input
          className="note-field font-mono text-[12px] text-txt-body"
          value={commandDraft}
          placeholder={PROVIDER_DEFAULT_COMMANDS[instance.provider]}
          onChange={(event) => setCommandDraft(event.target.value)}
          onBlur={() =>
            onUpdate(instance.id, {
              command: commandDraft.trim() === "" ? PROVIDER_DEFAULT_COMMANDS[instance.provider] : commandDraft.trim(),
            })
          }
        />
      </Section>

      {view.kind === "loading" && (
        <Section>
          <div className="text-[11px] text-txt-dimmer">Loading...</div>
        </Section>
      )}
      {view.kind === "empty" && (
        <Section>
          <div className="text-[11px] leading-[1.5] text-txt-dimmer">{view.message}</div>
        </Section>
      )}
      {view.kind === "data" && view.unreachable && (
        <Section>
          <div className="text-[11px] leading-[1.5] text-status-warn">Dashboard unreachable, showing the last data received.</div>
        </Section>
      )}
      {view.kind === "data" && view.fromTranscript && (
        <Section>
          <div className="text-[11px] leading-[1.5] text-txt-dimmer">
            Read from the agent's own files: it has not reported a statusline yet, so its cost is not available.
          </div>
        </Section>
      )}

      {(liveBranch !== undefined || gitBranch !== null) && (
        <Section>
          <div className="mb-[6px] flex items-center justify-between">
            <div className="text-[10px] font-bold uppercase tracking-[.06em] text-txt-dim">Branch</div>
            <CopyButton value={(liveBranch ?? gitBranch) as string} title="Copy branch name" />
          </div>
          <div className="font-mono text-[12px] text-txt-body">
            {liveBranch ?? gitBranch}
            {(liveStatus?.gitAdded ?? 0) + (liveStatus?.gitRemoved ?? 0) > 0 && (
              <span>
                {" "}
                (+{liveStatus?.gitAdded ?? 0} -{liveStatus?.gitRemoved ?? 0})
              </span>
            )}
          </div>
        </Section>
      )}

      {liveStatus !== null && liveStatus.available && view.kind === "data" && (
        <div className={`flex flex-col gap-[14px] border-t border-border pt-[12px]${dimmed}`}>
          {liveStatus.model !== undefined && (
            <Section>
              <Eyebrow>Model</Eyebrow>
              <div className="font-mono text-[12px] text-txt-body">{liveStatus.model}</div>
            </Section>
          )}

          {liveStatus.effort !== undefined && (
            <Section>
              <Eyebrow>Effort</Eyebrow>
              <div className="font-mono text-[12px] text-txt-body">{liveStatus.effort}</div>
            </Section>
          )}

          {liveStatus.contextUsed !== undefined && liveStatus.contextSize !== undefined && (
            <Section>
              <Eyebrow>Context</Eyebrow>
              <div className={`font-mono text-[12px] ${usagePctColorClass(liveStatus.contextPct ?? 0)}`}>
                {formatCompactNumber(liveStatus.contextUsed)}/{formatCompactNumber(liveStatus.contextSize)} ({Math.round(liveStatus.contextPct ?? 0)}%)
              </div>
            </Section>
          )}

          {/* Recovered from a transcript: the window size is unknown, so only the tokens in use. */}
          {liveStatus.contextUsed !== undefined && liveStatus.contextSize === undefined && (
            <Section>
              <Eyebrow>Context</Eyebrow>
              <div className="font-mono text-[12px] text-txt-body">{formatCompactNumber(liveStatus.contextUsed)} tokens</div>
            </Section>
          )}

          {(liveStatus.inputTokens !== undefined || liveStatus.outputTokens !== undefined) && (
            <Section>
              <Eyebrow>Tokens</Eyebrow>
              <div className="font-mono text-[12px] text-txt-body">
                {liveStatus.inputTokens !== undefined && `↓${formatCompactNumber(liveStatus.inputTokens)}`}
                {liveStatus.inputTokens !== undefined && liveStatus.outputTokens !== undefined && " "}
                {liveStatus.outputTokens !== undefined && `↑${formatCompactNumber(liveStatus.outputTokens)}`}
              </div>
            </Section>
          )}

          {liveStatus.sessionCostUsd !== undefined && (
            <Section>
              <Eyebrow>Session cost</Eyebrow>
              <div className="font-mono text-[12px] text-txt-body">${liveStatus.sessionCostUsd.toFixed(2)}</div>
            </Section>
          )}

          {view.fiveHour !== null && (
            <Section>
              <Eyebrow>5H LIMIT</Eyebrow>
              <div className={`font-mono text-[12px] text-txt-body${limitsDimmed}`}>
                <span className={usagePctColorClass(view.fiveHour.pct)}>{Math.round(view.fiveHour.pct)}%</span>
                {view.fiveHour.resetsAt !== null && <span> → {formatShortResetTime(view.fiveHour.resetsAt)}</span>}
              </div>
            </Section>
          )}

          {view.sevenDay !== null && (
            <Section>
              <Eyebrow>7D LIMIT</Eyebrow>
              <div className={`font-mono text-[12px] text-txt-body${limitsDimmed}`}>
                <span className={usagePctColorClass(view.sevenDay.pct)}>{Math.round(view.sevenDay.pct)}%</span>
                {view.sevenDay.resetsAt !== null && <span> → {formatLongResetTime(view.sevenDay.resetsAt)}</span>}
              </div>
            </Section>
          )}

          {liveStatus.extraUsd != null && liveStatus.extraLimitUsd != null && (
            <Section>
              <Eyebrow>Extra usage</Eyebrow>
              <div
                className={`font-mono text-[12px] ${usagePctColorClass(
                  liveStatus.extraLimitUsd > 0 ? (liveStatus.extraUsd / liveStatus.extraLimitUsd) * 100 : 0,
                )}`}
              >
                ${liveStatus.extraUsd.toFixed(2)}/${liveStatus.extraLimitUsd.toFixed(2)}
              </div>
            </Section>
          )}

          {liveStatus.burnPerHour != null && (
            <Section>
              <Eyebrow>Burn</Eyebrow>
              <div className="font-mono text-[12px] text-txt-body">${liveStatus.burnPerHour.toFixed(2)}/h</div>
            </Section>
          )}

          {liveStatus.dayTotalUsd != null && (
            <Section>
              <Eyebrow>Today</Eyebrow>
              <div className="font-mono text-[12px] text-txt-body">${liveStatus.dayTotalUsd.toFixed(2)}</div>
            </Section>
          )}

          {view.updatedAgo !== null && (
            <div className={`text-[11px] ${view.stale ? "text-status-warn" : "text-txt-dimmer"}`}>Updated {view.updatedAgo}</div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => onDeleteRequest(instance)}
        className="mt-auto self-start rounded-sm border-t border-border px-[6px] py-[10px] text-[12px] font-semibold text-diff-removed hover:bg-diff-removed-dim"
      >
        ✕ Delete instance
      </button>
    </aside>
  );
}
