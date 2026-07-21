import { useEffect, useState, type ReactNode } from "react";
import { useLiveStatus } from "../hooks/useLiveStatus";
import type { Instance, UpdateInstancePayload } from "../types";
import { BottomSheet } from "./BottomSheet";

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

// 4-band usage severity, matching the same convention as the desktop Sidebar
function usagePctColorClass(pct: number): string {
  if (pct >= 90) return "text-diff-removed";
  if (pct >= 80) return "text-status-orange";
  if (pct >= 60) return "text-status-yellow";
  return "text-diff-added";
}

interface InstanceSettingsSheetProps {
  instance: Instance;
  onUpdate: (instanceId: string, payload: UpdateInstancePayload) => void;
  onDeleteRequest: (instance: Instance) => void;
  onClose: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-[4px] text-[11px] font-semibold uppercase tracking-[.02em] text-txt-bright">{label}</div>
      {children}
    </div>
  );
}

export function InstanceSettingsSheet({ instance, onUpdate, onDeleteRequest, onClose }: InstanceSettingsSheetProps) {
  const [labelDraft, setLabelDraft] = useState<string>(instance.label);
  const [commandDraft, setCommandDraft] = useState<string>(instance.command);
  // Only polls while this sheet is open, unlike the desktop Sidebar which polls whenever visible
  const { liveStatus, gitBranch } = useLiveStatus(instance.id, true);

  useEffect(() => {
    setLabelDraft(instance.label);
    setCommandDraft(instance.command);
  }, [instance.id, instance.label, instance.command]);

  const liveBranch: string | undefined = liveStatus?.available === true ? liveStatus.branch ?? undefined : undefined;
  const branch: string | undefined = liveBranch ?? gitBranch ?? undefined;

  return (
    <BottomSheet onClose={onClose}>
      <div className="flex max-h-[75vh] flex-col gap-[16px] overflow-y-auto px-[20px] pb-[16px]">
        <Field label="Label">
          <input
            className="w-full rounded-sm border border-border-strong bg-app px-[11px] py-[9px] text-[13px] text-txt-body outline-none focus:border-accent-border"
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            onBlur={() => {
              const trimmed: string = labelDraft.trim();
              if (trimmed !== "" && trimmed !== instance.label) {
                onUpdate(instance.id, { label: trimmed });
              } else {
                setLabelDraft(instance.label);
              }
            }}
          />
        </Field>

        <Field label="Location">
          <div className="break-all rounded-sm bg-raised px-[12px] py-[10px] font-mono text-[11.5px] text-txt-secondary">
            {instance.locationPath}
          </div>
        </Field>

        <Field label="Provider">
          <div className="mb-[7px] text-[12.5px] font-semibold text-txt-body">{PROVIDER_LABELS[instance.provider]}</div>
          <input
            className="w-full rounded-sm border border-border-strong bg-app px-[11px] py-[9px] font-mono text-[12.5px] text-txt-body outline-none focus:border-accent-border"
            value={commandDraft}
            placeholder={PROVIDER_DEFAULT_COMMANDS[instance.provider]}
            onChange={(event) => setCommandDraft(event.target.value)}
            onBlur={() =>
              onUpdate(instance.id, {
                command: commandDraft.trim() === "" ? PROVIDER_DEFAULT_COMMANDS[instance.provider] : commandDraft.trim(),
              })
            }
          />
        </Field>

        {branch !== undefined && (
          <Field label="Branch">
            <div className="font-mono text-[12.5px] text-txt-body">
              {branch}
              {(liveStatus?.gitAdded ?? 0) + (liveStatus?.gitRemoved ?? 0) > 0 && (
                <span>
                  {" "}
                  (+{liveStatus?.gitAdded ?? 0} -{liveStatus?.gitRemoved ?? 0})
                </span>
              )}
            </div>
          </Field>
        )}

        {liveStatus !== null && liveStatus.available && (
          <div className="grid grid-cols-2 gap-[14px]">
            {liveStatus.model !== undefined && (
              <Field label="Model">
                <div className="font-mono text-[12.5px] text-txt-body">{liveStatus.model}</div>
              </Field>
            )}
            {liveStatus.effort !== undefined && (
              <Field label="Effort">
                <div className="font-mono text-[12.5px] text-txt-body">{liveStatus.effort}</div>
              </Field>
            )}
            {liveStatus.contextUsed !== undefined && liveStatus.contextSize !== undefined && (
              <Field label="Context">
                <div className={`font-mono text-[12.5px] ${usagePctColorClass(liveStatus.contextPct ?? 0)}`}>
                  {formatCompactNumber(liveStatus.contextUsed)}/{formatCompactNumber(liveStatus.contextSize)} (
                  {Math.round(liveStatus.contextPct ?? 0)}%)
                </div>
              </Field>
            )}
            {liveStatus.sessionCostUsd !== undefined && (
              <Field label="Session cost">
                <div className="font-mono text-[12.5px] text-txt-body">${liveStatus.sessionCostUsd.toFixed(2)}</div>
              </Field>
            )}
            {liveStatus.fiveHourPct != null && (
              <Field label="5H limit">
                <div className={`font-mono text-[12.5px] ${usagePctColorClass(liveStatus.fiveHourPct)}`}>
                  {Math.round(liveStatus.fiveHourPct)}%
                </div>
              </Field>
            )}
            {liveStatus.sevenDayPct != null && (
              <Field label="7D limit">
                <div className={`font-mono text-[12.5px] ${usagePctColorClass(liveStatus.sevenDayPct)}`}>
                  {Math.round(liveStatus.sevenDayPct)}%
                </div>
              </Field>
            )}
            {liveStatus.burnPerHour != null && (
              <Field label="Burn">
                <div className="font-mono text-[12.5px] text-txt-body">${liveStatus.burnPerHour.toFixed(2)}/h</div>
              </Field>
            )}
            {liveStatus.dayTotalUsd != null && (
              <Field label="Today">
                <div className="font-mono text-[12.5px] text-txt-body">${liveStatus.dayTotalUsd.toFixed(2)}</div>
              </Field>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            onClose();
            onDeleteRequest(instance);
          }}
          className="mt-[4px] self-start rounded-sm border-t border-border px-[6px] py-[10px] text-[13px] font-semibold text-diff-removed hover:bg-diff-removed-dim"
        >
          ✕ Delete instance
        </button>
      </div>
    </BottomSheet>
  );
}
