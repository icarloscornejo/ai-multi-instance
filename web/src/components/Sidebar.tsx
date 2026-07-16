import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { Instance, UpdateInstancePayload } from "../types";

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
  onRelaunch: (instanceId: string) => void;
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
// "localhost"/127.0.0.1 hosts): it silently throws on plain http://claude.local even
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

export function Sidebar({ instance, onUpdate, onRelaunch, onDeleteRequest }: SidebarProps) {
  const [commandDraft, setCommandDraft] = useState<string>(instance.command);
  const [modelDraft, setModelDraft] = useState<string>(instance.model ?? "");
  const [effortDraft, setEffortDraft] = useState<string>(instance.effort ?? "");
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [alive, setAlive] = useState<boolean | null>(null);

  // When switching tabs the sidebar shows a different instance: resync the drafts
  useEffect(() => {
    setCommandDraft(instance.command);
    setModelDraft(instance.model ?? "");
    setEffortDraft(instance.effort ?? "");
  }, [instance.id, instance.command, instance.model, instance.effort]);

  // Mirrors the statusline's behavior: show the branch only when the instance's
  // live directory is actually a git repo, stay silent otherwise.
  useEffect(() => {
    let cancelled = false;
    setGitBranch(null);
    api
      .getInstanceGit(instance.id)
      .then((result) => {
        if (!cancelled) {
          setGitBranch(result.branch ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitBranch(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [instance.id]);

  // Liveness is based only on whether the tmux session still exists, not on whether
  // the claude process inside it is still running: keeps the check cheap and reliable.
  useEffect(() => {
    let cancelled = false;
    setAlive(null);
    api
      .getInstanceStatus(instance.id)
      .then((result) => {
        if (!cancelled) {
          setAlive(result.alive);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAlive(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [instance.id]);

  return (
    <aside className="flex w-[300px] flex-none flex-col gap-[18px] overflow-y-auto border-l border-border bg-surface p-[20px_18px]">
      <div className="flex flex-col gap-[8px] border-b border-border pb-[14px]">
        <div className="text-[13.5px] font-bold text-txt-bright">{instance.label}</div>
        {alive !== null && (
          <div className={`flex items-center gap-[6px] text-[11px] font-semibold ${alive ? "text-diff-added" : "text-txt-dim"}`}>
            <span className={`h-[6px] w-[6px] rounded-full ${alive ? "bg-diff-added" : "bg-txt-dim"}`} />
            {alive ? "Running" : "Stopped"}
          </div>
        )}
      </div>

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

      {gitBranch !== null && (
        <div>
          <FieldLabel action={<CopyButton value={gitBranch} title="Copy branch name" />}>Branch</FieldLabel>
          <div className="font-mono text-[12.5px] text-txt-body">{gitBranch}</div>
        </div>
      )}

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

      <div className="mt-auto flex flex-col gap-[2px] border-t border-border pt-[14px]">
        <button
          type="button"
          onClick={() => onRelaunch(instance.id)}
          title="Resends the saved launch command to the session"
          className="self-start rounded-sm px-[6px] py-[8px] text-[12px] font-semibold text-txt-bright hover:bg-raised"
        >
          ↻ Restart instance
        </button>
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
