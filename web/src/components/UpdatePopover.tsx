import type { UpdateStatus } from "../types";
import { btnGhost, btnPrimary } from "../ui";

interface UpdatePopoverProps {
  status: UpdateStatus;
  applying: boolean;
  onSeeWhatsNew: () => void;
  onLater: () => void;
  onUpdateNow: () => void;
}

export function UpdatePopover({ status, applying, onSeeWhatsNew, onLater, onUpdateNow }: UpdatePopoverProps) {
  const shortHash: string = status.remoteCommit?.slice(0, 7) ?? "";

  return (
    <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-[280px] rounded-lg border border-border-strong bg-surface p-[14px] shadow-modal">
      <div className="absolute -top-[5px] right-[16px] h-[9px] w-[9px] rotate-45 border-l border-t border-border-strong bg-surface" />
      <div className="flex items-center gap-[8px]">
        <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
        <span className="text-[12.5px] font-bold text-txt-bright">Update available · {shortHash}</span>
      </div>
      <div className="mt-[10px] text-[11.5px] leading-[1.5] text-txt-secondary">
        {status.changelog.length} commits behind.{" "}
        <button type="button" onClick={onSeeWhatsNew} className="font-semibold text-accent">
          See what's new
        </button>
      </div>
      <div className="mt-[10px] flex justify-end gap-[8px]">
        <button
          type="button"
          onClick={onLater}
          disabled={applying}
          className={`${btnGhost} px-[12px] py-[6px] text-[11.5px]`}
        >
          Later
        </button>
        <button
          type="button"
          onClick={onUpdateNow}
          disabled={applying}
          className={`${btnPrimary} px-[12px] py-[6px] text-[11.5px]`}
        >
          {applying ? "Updating..." : "Update now"}
        </button>
      </div>
    </div>
  );
}
