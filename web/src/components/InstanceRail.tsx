import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
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
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import type { Instance, UpdateStatus } from "../types";
import type { Theme } from "../theme";
import { getHostRailWidth, setHostRailWidth } from "../hostPrefs";
import { formatCountdown } from "../ui";
import { UpdatePopover } from "./UpdatePopover";

const DEFAULT_RAIL_WIDTH = 228;
const MIN_RAIL_WIDTH = 180;
const MAX_RAIL_WIDTH = 440;

// The former TabBar.tsx, reshaped from a horizontal tab strip into the desktop rail of the
// Sidebar Workbench layout (see the approved redesign in
// ~/Downloads/ai-multi-instance-claude-code-handoff/03-main.html). Selection, drag reorder,
// inline rename, close, and the update popover/dedupe logic are unchanged from TabBar; only
// their axis and presentation moved from horizontal to vertical.
interface InstanceRailProps {
  instances: Instance[];
  activeInstanceId: string | null;
  updateStatus: UpdateStatus | null;
  updateRequired: boolean;
  countdownMs: number;
  applying: boolean;
  onSelect: (instanceId: string) => void;
  onRename: (instanceId: string, newLabel: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onAddClick: () => void;
  onUpdateClick: () => void;
  onApplyNow: () => void;
  onSettingsClick: () => void;
  onCloseRequest: (instance: Instance) => void;
  theme: Theme;
  onToggleTheme: () => void;
  // Lets the shell suppress the terminal's own visibility-focus while a rename is open, so
  // selecting-then-double-clicking an inactive row doesn't lose the rename input to the
  // newly-visible terminal (see TerminalView's suppressAutoFocus prop for the full story).
  onEditingChange: (isEditing: boolean) => void;
}

interface RailRowProps {
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

function RailRow({
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
}: RailRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: instance.id,
    disabled: isEditing,
  });
  const labelSpanRef = useRef<HTMLSpanElement>(null);
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);

  const startEditing = (): void => {
    // Lock the input to the label's actual rendered width (proportional fonts make a
    // character-count estimate unreliable) so the row's text never resizes on double-click
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
      className={`group relative flex h-[38px] w-full shrink-0 items-center gap-[8px] rounded-md px-[10px] text-[13px] ${
        isActive ? "bg-soft font-semibold text-txt-bright" : "text-txt-secondary hover:bg-soft hover:text-txt-body"
      } ${isDragging ? "z-10 opacity-80" : ""}`}
    >
      <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${isActive ? "bg-accent" : "bg-transparent"}`} />
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
          className="min-w-0 bg-transparent text-[13px] outline-none"
        />
      ) : (
        <span
          ref={labelSpanRef}
          className="min-w-0 flex-1 truncate cursor-text select-none"
          title="Double-click to rename"
        >
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
          className="w-0 shrink-0 overflow-hidden text-[12px] leading-none text-txt-dim opacity-0 transition-[width,opacity] hover:text-diff-removed group-hover:w-[12px] group-hover:opacity-100"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function InstanceRail({
  instances,
  activeInstanceId,
  updateStatus,
  updateRequired,
  countdownMs,
  applying,
  onSelect,
  onRename,
  onReorder,
  onAddClick,
  onUpdateClick,
  onApplyNow,
  onSettingsClick,
  onCloseRequest,
  theme,
  onToggleTheme,
  onEditingChange,
}: InstanceRailProps) {
  const [editingInstanceId, setEditingInstanceId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState<string>("");
  const [popoverOpen, setPopoverOpen] = useState<boolean>(false);
  const [width, setWidth] = useState<number>(() => getHostRailWidth(DEFAULT_RAIL_WIDTH));
  const editInputRef = useRef<HTMLInputElement>(null);
  const updateContainerRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Drag-resize handle on the right edge. Width is applied directly on every pointermove (no
  // CSS transition) so the terminal's own ResizeObserver-driven fit() tracks the live width
  // instead of racing a transition; only the final width is persisted, on pointer release.
  const dragStartRef = useRef<{ pointerX: number; startWidth: number } | null>(null);
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragStartRef.current = { pointerX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragStartRef.current;
    if (drag === null) {
      return;
    }
    const nextWidth: number = Math.min(
      MAX_RAIL_WIDTH,
      Math.max(MIN_RAIL_WIDTH, drag.startWidth + (event.clientX - drag.pointerX))
    );
    setWidth(nextWidth);
  };
  const handlePointerUp = (): void => {
    if (dragStartRef.current === null) {
      return;
    }
    dragStartRef.current = null;
    setHostRailWidth(width);
  };
  // Tracks which remote commit we already auto-opened the popover for, so a poll refresh
  // (or the user re-dismissing with Later) does not keep popping it back up on its own.
  // Persisted to localStorage (not just a plain ref) so a full page reload, e.g. right
  // after an update applies, does not forget a commit it already showed and reopen it.
  const autoShownForCommitRef = useRef<string | null>(localStorage.getItem("ccdash.updatePopoverShownCommit"));

  useEffect(() => {
    if (updateRequired || updateStatus?.updateAvailable !== true || updateStatus.remoteCommit === null) {
      return;
    }
    if (autoShownForCommitRef.current !== updateStatus.remoteCommit) {
      autoShownForCommitRef.current = updateStatus.remoteCommit;
      localStorage.setItem("ccdash.updatePopoverShownCommit", updateStatus.remoteCommit);
      setPopoverOpen(true);
    }
  }, [updateRequired, updateStatus]);

  useEffect(() => {
    if (!popoverOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (!updateContainerRef.current?.contains(event.target as Node)) {
        setPopoverOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPopoverOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [popoverOpen]);

  const handleUpdateButtonClick = (): void => {
    if (updateRequired) {
      onUpdateClick();
    } else if (updateStatus?.updateAvailable === true) {
      setPopoverOpen((previousOpen) => !previousOpen);
    } else {
      onUpdateClick();
    }
  };

  useEffect(() => {
    if (editingInstanceId !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingInstanceId]);

  useEffect(() => {
    onEditingChange(editingInstanceId !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <aside
      className="relative flex shrink-0 flex-col border-r border-border bg-surface p-[14px_12px]"
      style={{ width: `${width}px` }}
    >
      {/* Absolutely positioned and centered on the border-r above, not a flex sibling: a
          real layout-width handle stacked next to that 1px border reads as one thick,
          always-visible bar instead of the thin hairline the rest of the app uses. This
          way only the hover state (a wider hit target than the visible line) is wider. */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title="Drag to resize"
        className="absolute -right-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize touch-none bg-transparent hover:bg-accent-border/40 active:bg-accent-border/40"
      />
      <div className="flex h-[38px] items-center px-[8px] pb-[12px] text-[13px] font-bold text-txt-primary">
        AI Multi-Instance
      </div>

      <div className="px-[8px] pb-[7px] pt-[12px] text-[10px] font-bold uppercase tracking-[.08em] text-txt-dim">
        Instances
      </div>
      <div className="rail-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={instances.map((instance) => instance.id)} strategy={verticalListSortingStrategy}>
            {instances.map((instance) => (
              <RailRow
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
      </div>

      {/* Pinned under the list, not scrolling with it: unlike the old horizontal strip
          (Chrome-style, scrolled out of view with many tabs), a vertical rail with many
          instances would otherwise push this below the fold. */}
      <button
        type="button"
        onClick={onAddClick}
        title="New instance"
        className="mt-[6px] flex h-[36px] shrink-0 items-center gap-[8px] rounded-md border border-border bg-raised px-[10px] text-[13px] text-txt-secondary hover:bg-raised-2 hover:text-txt-bright"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New instance
      </button>

      <div className="mt-[10px] flex flex-col gap-[2px] border-t border-border pt-[10px]">
        <div ref={updateContainerRef} className="relative">
          <button
            type="button"
            onClick={handleUpdateButtonClick}
            title={
              updateRequired
                ? updateStatus?.blockedReason !== null && updateStatus?.blockedReason !== undefined
                  ? "Required update blocked: open the update screen for details"
                  : "Required update: open the update screen for details"
                : updateStatus?.pendingRestart === true
                  ? "Restart pending: open the update screen for details"
                  : updateStatus?.updateAvailable === true
                    ? "Update available: click for details"
                    : "Check for dashboard updates"
            }
            className={
              updateRequired
                ? "flex h-[36px] w-full items-center gap-[8px] rounded-md bg-diff-removed px-[9px] text-[12px] font-semibold tabular-nums text-on-accent hover:brightness-[1.08]"
                : "relative flex h-[36px] w-full items-center gap-[8px] rounded-md px-[9px] text-[12px] text-txt-secondary hover:bg-soft"
            }
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6v5h-5" />
              <path d="M19 11a7 7 0 1 0 1 4" />
            </svg>
            {updateRequired
              ? updateStatus?.blockedReason !== null && updateStatus?.blockedReason !== undefined
                ? "Update blocked"
                : `Updating in ${formatCountdown(countdownMs)}`
              : "Update"}
            {!updateRequired && updateStatus?.updateAvailable === true && (
              <span className="absolute right-[10px] top-[9px] h-[5px] w-[5px] rounded-full bg-accent" />
            )}
          </button>
          {popoverOpen && updateStatus !== null && updateStatus.updateAvailable && (
            <UpdatePopover
              status={updateStatus}
              applying={applying}
              onSeeWhatsNew={() => {
                setPopoverOpen(false);
                onUpdateClick();
              }}
              onLater={() => setPopoverOpen(false)}
              onUpdateNow={() => {
                setPopoverOpen(false);
                onApplyNow();
              }}
            />
          )}
        </div>
        <button
          type="button"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="flex h-[36px] w-full items-center gap-[8px] rounded-md px-[9px] text-[12px] text-txt-secondary hover:bg-soft"
        >
          {theme === "dark" ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
          Appearance
        </button>
        <button
          type="button"
          onClick={onSettingsClick}
          title="Configure locations"
          className="flex h-[36px] w-full items-center gap-[8px] rounded-md px-[9px] text-[12px] text-txt-secondary hover:bg-soft"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
        </button>
      </div>
    </aside>
  );
}
