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
  const labelSpanRef = useRef<HTMLSpanElement>(null);
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);

  const startEditing = (): void => {
    // Lock the input to the label's actual rendered width (proportional fonts make a
    // character-count estimate unreliable) so the tab never resizes on double-click
    setLockedWidth(labelSpanRef.current?.offsetWidth ?? null);
    onStartEditing(instance);
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...(isEditing ? {} : listeners)}
      onClick={() => onSelect(instance.id)}
      onDoubleClick={startEditing}
      className={`group relative mr-[6px] flex h-[32px] shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border-none px-[12px] text-[12.5px] font-medium ${
        isActive
          ? "bg-surface font-semibold text-txt-bright shadow-[0_1px_2px_rgba(0,0,0,.06),0_0_0_1px_var(--color-border)]"
          : "bg-transparent text-txt-secondary hover:bg-raised hover:text-txt-body"
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
          style={lockedWidth !== null ? { width: `${lockedWidth}px` } : undefined}
          className="bg-transparent text-[12.5px] outline-none"
        />
      ) : (
        <span ref={labelSpanRef} className="cursor-text select-none" title="Double-click to rename">
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
          className="w-0 overflow-hidden text-[12px] leading-none text-txt-dim opacity-0 transition-[width,opacity] hover:text-diff-removed group-hover:w-[12px] group-hover:opacity-100"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function TabBar({
  instances,
  activeInstanceId,
  updateStatus,
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
      <div className="relative mr-[10px] min-w-0 flex-1">
        <div className="tab-scroll flex flex-nowrap items-center overflow-x-auto">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={instances.map((instance) => instance.id)}
              strategy={horizontalListSortingStrategy}
            >
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
          {/* Right next to the last tab, Chrome-style: scrolls out of view with many tabs */}
          <button
            type="button"
            onClick={onAddClick}
            title="New instance"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-raised text-[16px] leading-none text-txt-secondary hover:bg-border-strong hover:text-txt-bright"
          >
            +
          </button>
        </div>
        {/* Signals horizontal overflow without stealing space from the fixed toolbar */}
        <div className="pointer-events-none absolute right-0 top-0 h-full w-[24px] bg-gradient-to-r from-transparent to-app" />
      </div>
      <div className="flex shrink-0 items-center gap-[2px] border-l border-border pl-[10px]">
        <button
          type="button"
          onClick={onUpdateClick}
          title={
            updateStatus?.pendingRestart === true
              ? "Restart pending: open the update screen for details"
              : updateStatus?.updateAvailable === true
                ? "Update available: open the update screen for details"
                : "Check for dashboard updates"
          }
          className="relative h-[28px] rounded-sm px-[10px] text-[11px] font-semibold text-txt-secondary hover:bg-raised hover:text-txt-body"
        >
          Update
          {(updateStatus?.updateAvailable === true || updateStatus?.pendingRestart === true) && (
            <span className="absolute -right-[2px] -top-[2px] h-[6px] w-[6px] rounded-full bg-accent" />
          )}
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="flex h-[30px] w-[30px] items-center justify-center rounded-sm text-txt-secondary hover:bg-raised hover:text-txt-body"
        >
          {theme === "dark" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={onSettingsClick}
          title="Configure locations"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-sm text-txt-secondary hover:bg-raised hover:text-txt-body"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
