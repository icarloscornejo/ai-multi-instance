import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Instance, UpdateStatus } from "../types";
import type { Theme } from "../theme";

interface TabBarProps {
  instances: Instance[];
  activeInstanceId: string | null;
  updateStatus: UpdateStatus | null;
  updating: boolean;
  onSelect: (instanceId: string) => void;
  onRename: (instanceId: string, newLabel: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onAddClick: () => void;
  onUpdateClick: () => void;
  onSettingsClick: () => void;
  onCloseRequest: (instance: Instance) => void;
  theme: Theme;
  onToggleTheme: () => void;
}

function UpdateResultNotice({ updateStatus }: { updateStatus: UpdateStatus | null }) {
  if (updateStatus === null || updateStatus.lastCheckAt === null) {
    return null;
  }
  if (updateStatus.pendingRestart && updateStatus.restartKind === "manual") {
    return (
      <span
        className="mr-[10px] text-[11px] font-semibold text-accent"
        title="Dashboard updated on disk. Stop npm run dev with Ctrl+C and run it again to apply the new version. Sessions live in tmux — nothing is lost."
      >
        Updated · restart dashboard
      </span>
    );
  }
  if (updateStatus.pendingRestart && updateStatus.restartKind === "auto") {
    return (
      <span
        className="mr-[10px] text-[11px] font-semibold text-accent"
        title="The change only touched server/web code: tsx watch and vite already hot-reloaded it, no restart needed."
      >
        Updated · hot-reloaded
      </span>
    );
  }
  if (updateStatus.lastError !== null) {
    return (
      <span className="mr-[10px] text-[11px] text-txt-dim" title={updateStatus.lastError}>
        Update failed
      </span>
    );
  }
  if (updateStatus.blockedReason !== null) {
    return (
      <span className="mr-[10px] text-[11px] text-txt-dim" title={updateStatus.blockedReason}>
        Update blocked
      </span>
    );
  }
  return <span className="mr-[10px] text-[11px] text-txt-dim">Up to date</span>;
}

export function TabBar({
  instances,
  activeInstanceId,
  updateStatus,
  updating,
  onSelect,
  onRename,
  onReorder,
  onAddClick,
  onUpdateClick,
  onSettingsClick,
  onCloseRequest,
  theme,
  onToggleTheme,
}: TabBarProps) {
  const [editingInstanceId, setEditingInstanceId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState<string>("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

  useEffect(() => {
    if (editingInstanceId !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingInstanceId]);

  const startEditing = (instance: Instance): void => {
    setEditingInstanceId(instance.id);
    setDraftLabel(instance.label);
  };

  const commitEditing = (): void => {
    if (editingInstanceId !== null && draftLabel.trim() !== "") {
      onRename(editingInstanceId, draftLabel.trim());
    }
    setEditingInstanceId(null);
  };

  const clearDragState = (): void => {
    setDraggedId(null);
    setDropTargetIndex(null);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, index: number): void => {
    if (draggedId === null) {
      return;
    }
    event.preventDefault();
    const tabBounds: DOMRect = event.currentTarget.getBoundingClientRect();
    const isOverLeftHalf: boolean = event.clientX - tabBounds.left < tabBounds.width / 2;
    setDropTargetIndex(isOverLeftHalf ? index : index + 1);
  };

  const handleDrop = (): void => {
    if (draggedId === null || dropTargetIndex === null) {
      clearDragState();
      return;
    }
    const ids: string[] = instances.map((instance) => instance.id);
    const fromIndex: number = ids.indexOf(draggedId);
    const toIndex: number = fromIndex < dropTargetIndex ? dropTargetIndex - 1 : dropTargetIndex;
    if (fromIndex !== toIndex) {
      ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, draggedId);
      onReorder(ids);
    }
    clearDragState();
  };

  return (
    <header className="flex h-[46px] shrink-0 items-center border-b border-border bg-app px-[10px]">
      <img src="/claude-ai-icon.svg" alt="" className="mr-[8px] h-[20px] w-[20px] shrink-0" />
      <span className="mr-[14px] shrink-0 text-[13px] font-semibold text-txt-primary">Claude Multi-Instance</span>
      {instances.map((instance, index) => {
        const isActive: boolean = instance.id === activeInstanceId;
        return (
          <div
            key={instance.id}
            draggable={editingInstanceId !== instance.id}
            onDragStart={(event) => {
              setDraggedId(instance.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => handleDragOver(event, index)}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop();
            }}
            onDragEnd={clearDragState}
            onClick={() => onSelect(instance.id)}
            onDoubleClick={() => startEditing(instance)}
            className={`group relative mr-[4px] flex h-[30px] items-center gap-[8px] rounded-[6px] border px-[12px] text-[13px] ${
              isActive
                ? "border-border-strong border-b-2 border-b-accent bg-raised font-semibold text-txt-primary"
                : "border-border bg-transparent font-medium text-txt-secondary hover:border-border-strong hover:text-txt-body"
            } ${draggedId === instance.id ? "opacity-40" : ""} ${
              dropTargetIndex === index && draggedId !== null && draggedId !== instance.id
                ? "border-l-2 border-l-accent"
                : ""
            } ${
              dropTargetIndex === index + 1 &&
              draggedId !== null &&
              draggedId !== instance.id &&
              (index === instances.length - 1 || instances[index + 1]?.id !== draggedId)
                ? "border-r-2 border-r-accent"
                : ""
            }`}
          >
            {editingInstanceId === instance.id ? (
              <input
                ref={editInputRef}
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value)}
                onBlur={commitEditing}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitEditing();
                  } else if (event.key === "Escape") {
                    setEditingInstanceId(null);
                  }
                }}
                className="w-[110px] bg-transparent text-[13px] outline-none"
              />
            ) : (
              <span className="cursor-text select-none" title="Double-click to rename">
                {instance.label}
              </span>
            )}
            {editingInstanceId !== instance.id && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseRequest(instance);
                }}
                title="Close instance"
                className="rounded-[4px] px-[4px] text-[13px] leading-none text-txt-dim opacity-0 hover:text-diff-removed group-hover:opacity-100"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAddClick}
        title="New instance"
        className="ml-[6px] h-[28px] w-[28px] rounded-[6px] border border-border text-[15px] leading-none text-txt-secondary hover:text-txt-body"
      >
        +
      </button>
      <div className="flex-1" />
      <UpdateResultNotice updateStatus={updateStatus} />
      <button
        type="button"
        onClick={onUpdateClick}
        disabled={updating}
        title="Checks for the latest version of the dashboard on GitHub and applies it if there are no local changes"
        className="mr-[8px] h-[28px] rounded-[6px] border border-border px-[10px] text-[11px] font-semibold text-txt-secondary hover:text-txt-body disabled:opacity-50"
      >
        {updating ? "Checking..." : "Update"}
      </button>
      <button
        type="button"
        onClick={onToggleTheme}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        className="mr-[8px] h-[28px] rounded-[6px] border border-border px-[10px] text-[11px] font-semibold text-txt-secondary hover:text-txt-body"
      >
        {theme === "dark" ? "Light" : "Dark"}
      </button>
      <button
        type="button"
        onClick={onSettingsClick}
        title="Configure locations"
        className="h-[28px] rounded-[6px] border border-border px-[10px] text-[11px] font-semibold text-txt-secondary hover:text-txt-body"
      >
        Settings
      </button>
    </header>
  );
}
