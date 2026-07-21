import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useModalEscapeStack } from "./Modal";

const DISMISS_THRESHOLD_PX = 80;

interface BottomSheetProps {
  onClose: () => void;
  children: ReactNode;
}

export function BottomSheet({ onClose, children }: BottomSheetProps) {
  useModalEscapeStack(onClose);
  const [dragOffset, setDragOffset] = useState<number>(0);
  const dragStartYRef = useRef<number | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragStartYRef.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragStartYRef.current === null) {
      return;
    }
    setDragOffset(Math.max(0, event.clientY - dragStartYRef.current));
  };

  const handlePointerUp = (): void => {
    if (dragOffset > DISMISS_THRESHOLD_PX) {
      onClose();
    } else {
      setDragOffset(0);
    }
    dragStartYRef.current = null;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="flex w-full max-w-[520px] flex-col rounded-t-2xl border-t border-border bg-surface pb-safe"
        style={{ transform: `translateY(${dragOffset}px)`, transition: dragOffset === 0 ? "transform 0.15s ease-out" : "none" }}
      >
        <div
          className="flex cursor-grab touch-none justify-center py-[10px]"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div className="h-[4px] w-[36px] rounded-full bg-border-strong" />
        </div>
        {children}
      </div>
    </div>
  );
}
