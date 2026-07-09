import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex w-[420px] max-h-[85vh] flex-col gap-[14px] overflow-y-auto rounded-[10px] border border-border bg-surface p-[24px]">
        <h2 className="text-[14px] font-semibold text-txt-bright">{title}</h2>
        {children}
      </div>
    </div>
  );
}
