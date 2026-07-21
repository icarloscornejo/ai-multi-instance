import { useEffect, type ReactNode } from "react";

// Tracks nested modals so Escape closes only the topmost one instead of the whole stack
const openModalCloseHandlers: (() => void)[] = [];

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  widthClassName?: string;
}

export function Modal({ title, onClose, children, widthClassName = "w-[420px]" }: ModalProps) {
  useEffect(() => {
    openModalCloseHandlers.push(onClose);
    return () => {
      const index: number = openModalCloseHandlers.lastIndexOf(onClose);
      if (index !== -1) {
        openModalCloseHandlers.splice(index, 1);
      }
    };
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && openModalCloseHandlers[openModalCloseHandlers.length - 1] === onClose) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={`flex ${widthClassName} max-h-[85vh] flex-col gap-[14px] overflow-y-auto rounded-[10px] border border-border bg-surface p-[24px]`}
      >
        <h2 className="text-[14px] font-semibold text-txt-bright">{title}</h2>
        {children}
      </div>
    </div>
  );
}
