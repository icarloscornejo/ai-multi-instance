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
  onOpen: () => void;
  onLongPress: () => void;
}

export function InstanceCard({ instance, onOpen, onLongPress }: InstanceCardProps) {
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
      className="flex w-full items-center gap-[12px] rounded-lg border border-border bg-surface px-[16px] py-[14px] text-left active:bg-raised"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
        <span className="truncate text-[14px] font-semibold text-txt-bright">{instance.label}</span>
        <div className="flex flex-wrap items-center gap-[6px]">
          <span className="rounded-full border border-border-strong px-[8px] py-[2px] text-[11px] text-txt-dim">
            {PROVIDER_LABELS[instance.provider]}
            {instance.model !== null ? ` · ${instance.model}` : ""}
            {instance.effort !== null ? ` · ${instance.effort}` : ""}
          </span>
          {branch !== null && (
            <span className="rounded-full border border-border-strong px-[8px] py-[2px] font-mono text-[11px] text-txt-dim">
              {branch}
            </span>
          )}
        </div>
      </div>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-txt-dim"
      >
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  );
}
