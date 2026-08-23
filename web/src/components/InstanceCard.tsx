import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../api";
import type { Instance } from "../types";

const PROVIDER_LABELS = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  custom: "Custom",
} as const;

const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

interface InstanceCardProps {
  instance: Instance;
  // Only the first row in the list carries the active bar in the approved mock
  // (11-main-mobile.html): it stands in for "most recently opened" since mobile has no
  // persistent tab selection the way desktop does.
  isFirst: boolean;
  onOpen: () => void;
  onLongPress: () => void;
}

export function InstanceCard({ instance, isFirst, onOpen, onLongPress }: InstanceCardProps) {
  const [branch, setBranch] = useState<string | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressFiredRef = useRef<boolean>(false);

  // One-shot lookup, not polled: the card just needs the branch at a glance,
  // not live status (that lives in the desktop Sidebar / future settings sheet)
  useEffect(() => {
    let cancelled: boolean = false;
    api
      .getInstanceGit(instance.id)
      .then((result) => {
        if (!cancelled) {
          setBranch(result.branch ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [instance.id]);

  const clearPressTimer = (): void => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    pressStartRef.current = { x: event.clientX, y: event.clientY };
    longPressFiredRef.current = false;
    pressTimerRef.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const start = pressStartRef.current;
    if (start === null) {
      return;
    }
    const distance: number = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) {
      clearPressTimer();
    }
  };

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearPressTimer}
      onPointerLeave={clearPressTimer}
      onClick={() => {
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false;
          return;
        }
        onOpen();
      }}
      className="relative flex w-full items-center gap-[10px] border-b border-border py-[17px] pl-[14px] pr-[8px] text-left active:bg-raised"
    >
      <span className={`absolute bottom-[18px] left-0 top-[18px] w-[3px] rounded-full ${isFirst ? "bg-accent" : "bg-transparent"}`} />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold tracking-[-.015em] text-txt-bright">{instance.label}</span>
        <div className="mt-[5px] flex flex-col gap-[3px]">
          <span className="text-[11px] text-txt-dim">
            {PROVIDER_LABELS[instance.provider]}
            {instance.model !== null ? ` · ${instance.model}` : ""}
            {instance.effort !== null ? ` · ${instance.effort}` : ""}
          </span>
          {branch !== null && <span className="font-mono text-[11px] text-txt-dim">{branch}</span>}
        </div>
      </div>
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-txt-dim"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  );
}
