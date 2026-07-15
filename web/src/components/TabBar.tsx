import { useEffect, useRef, useState, type RefObject } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
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
        title="Dashboard updated on disk. Stop npm run dev with Ctrl+C and run it again to apply the new version. Sessions live in tmux, nothing is lost."
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

interface SortableTabProps {
  instance: Instance;
  isActive: boolean;
  isEditing: boolean;
  draftLabel: string;
  editInputRef: RefObject<HTMLInputElement>;
  onSelect: (instanceId: string) => void;
  onStartEditing: (instance: Instance) => void;
  onDraftLabelChange: (value: string) => void;
  onCommitEditing: () => void;
  onCancelEditing: () => void;
  onCloseRequest: (instance: Instance) => void;
}

function SortableTab({
  instance,
  isActive,
  isEditing,
  draftLabel,
  editInputRef,
  onSelect,
  onStartEditing,
  onDraftLabelChange,
  onCommitEditing,
  onCancelEditing,
  onCloseRequest,
}: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: instance.id,
    disabled: isEditing,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...(isEditing ? {} : listeners)}
      onClick={() => onSelect(instance.id)}
      onDoubleClick={() => onStartEditing(instance)}
      className={`group relative mr-[4px] flex h-[30px] shrink-0 items-center gap-[8px] whitespace-nowrap rounded-[6px] border px-[12px] text-[13px] ${
        isActive
          ? "border-border-strong border-b-2 border-b-accent bg-raised font-semibold text-txt-primary"
          : "border-border bg-transparent font-medium text-txt-secondary hover:border-border-strong hover:text-txt-body"
      } ${isDragging ? "z-10 opacity-80" : ""}`}
    >
      {isEditing ? (
        <input
          ref={editInputRef}
          value={draftLabel}
          onChange={(event) => onDraftLabelChange(event.target.value)}
          onBlur={onCommitEditing}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCommitEditing();
            } else if (event.key === "Escape") {
              onCancelEditing();
            }
          }}
          className="w-[110px] bg-transparent text-[13px] outline-none"
        />
      ) : (
        <span className="cursor-text select-none" title="Double-click to rename">
          {instance.label}
        </span>
      )}
      {!isEditing && (
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) {
      return;
    }
    const ids: string[] = instances.map((instance) => instance.id);
    const fromIndex: number = ids.indexOf(String(active.id));
    const toIndex: number = ids.indexOf(String(over.id));
    onReorder(arrayMove(ids, fromIndex, toIndex));
  };

  return (
    <header className="flex h-[46px] shrink-0 items-center border-b border-border bg-app px-[10px]">
      <img src="/claude-ai-icon.svg" alt="" className="mr-[8px] h-[20px] w-[20px] shrink-0" />
      <span className="mr-[14px] shrink-0 text-[13px] font-semibold text-txt-primary">Claude Multi-Instance</span>
      <div className="tab-scroll mr-[10px] flex min-w-0 flex-1 flex-nowrap items-center overflow-x-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={instances.map((instance) => instance.id)} strategy={horizontalListSortingStrategy}>
            {instances.map((instance) => (
              <SortableTab
                key={instance.id}
                instance={instance}
                isActive={instance.id === activeInstanceId}
                isEditing={editingInstanceId === instance.id}
                draftLabel={draftLabel}
                editInputRef={editInputRef}
                onSelect={onSelect}
                onStartEditing={startEditing}
                onDraftLabelChange={setDraftLabel}
                onCommitEditing={commitEditing}
                onCancelEditing={() => setEditingInstanceId(null)}
                onCloseRequest={onCloseRequest}
              />
            ))}
          </SortableContext>
        </DndContext>
        <button
          type="button"
          onClick={onAddClick}
          title="New instance"
          className="ml-[6px] h-[28px] w-[28px] shrink-0 rounded-[6px] border border-border text-[15px] leading-none text-txt-secondary hover:text-txt-body"
        >
          +
        </button>
      </div>
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
