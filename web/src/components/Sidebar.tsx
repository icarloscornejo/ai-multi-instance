import { useEffect, useState } from "react";
import type { Instance, UpdateInstancePayload } from "../types";
import { buildLaunchCommandPreview } from "../launchCommand";

interface SidebarProps {
  instance: Instance;
  onUpdate: (instanceId: string, payload: UpdateInstancePayload) => void;
  onRelaunch: (instanceId: string) => void;
  onDeleteRequest: (instance: Instance) => void;
}

function FieldLabel({ children }: { children: string }) {
  return <div className="mb-[4px] text-[11px] text-txt-dim">{children}</div>;
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState<boolean>(false);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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

export function Sidebar({ instance, onUpdate, onRelaunch, onDeleteRequest }: SidebarProps) {
  const [commandDraft, setCommandDraft] = useState<string>(instance.command);
  const [modelDraft, setModelDraft] = useState<string>(instance.model ?? "");
  const [effortDraft, setEffortDraft] = useState<string>(instance.effort ?? "");

  // When switching tabs the sidebar shows a different instance: resync the drafts
  useEffect(() => {
    setCommandDraft(instance.command);
    setModelDraft(instance.model ?? "");
    setEffortDraft(instance.effort ?? "");
  }, [instance.id, instance.command, instance.model, instance.effort]);

  const launchCommandPreview = buildLaunchCommandPreview({
    command: commandDraft,
    label: instance.label,
    model: modelDraft.trim() === "" ? null : modelDraft.trim(),
    effort: effortDraft.trim() === "" ? null : effortDraft.trim(),
  });

  return (
    <aside className="flex w-[300px] flex-none flex-col gap-[16px] overflow-y-auto border-l border-border bg-app p-[20px_18px]">
      <div className="text-[11px] font-bold text-txt-secondary">Instance notes</div>

      <div>
        <FieldLabel>Location</FieldLabel>
        <div className="flex items-center gap-[8px]">
          <div className="break-all font-mono text-[12px] text-txt-secondary">{instance.locationPath}</div>
          <CopyButton value={instance.locationPath} title="Copy location path" />
        </div>
      </div>

      <div>
        <FieldLabel>Claude</FieldLabel>
        <input
          className="note-field font-mono text-[12.5px] text-txt-body"
          value={commandDraft}
          placeholder="claude"
          onChange={(event) => setCommandDraft(event.target.value)}
          onBlur={() => onUpdate(instance.id, { command: commandDraft.trim() === "" ? "claude" : commandDraft.trim() })}
        />
      </div>

      <div>
        <FieldLabel>Model</FieldLabel>
        <input
          className="note-field font-mono text-[12.5px] text-txt-body"
          value={modelDraft}
          placeholder="default"
          onChange={(event) => setModelDraft(event.target.value)}
          onBlur={() => onUpdate(instance.id, { model: modelDraft.trim() === "" ? null : modelDraft.trim() })}
        />
      </div>

      <div>
        <FieldLabel>Effort</FieldLabel>
        <input
          className="note-field font-mono text-[12.5px] text-txt-body"
          value={effortDraft}
          placeholder="default"
          onChange={(event) => setEffortDraft(event.target.value)}
          onBlur={() => onUpdate(instance.id, { effort: effortDraft.trim() === "" ? null : effortDraft.trim() })}
        />
      </div>

      <div>
        <FieldLabel>Command</FieldLabel>
        <div className="flex items-center gap-[8px]">
          <div className="break-all font-mono text-[12px] text-txt-secondary">{launchCommandPreview}</div>
          <CopyButton value={launchCommandPreview} title="Copy full command" />
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-[8px] pt-[16px]">
        <button
          type="button"
          onClick={() => onRelaunch(instance.id)}
          title="Resends the saved launch command to the session"
          className="self-start text-[11px] font-semibold text-txt-dim hover:text-txt-secondary"
        >
          Restart instance
        </button>
        <button
          type="button"
          onClick={() => onDeleteRequest(instance)}
          className="self-start text-[11px] font-semibold text-txt-dim hover:text-diff-removed"
        >
          Delete instance
        </button>
      </div>
    </aside>
  );
}
