import { btnDanger, formatCountdown } from "../ui";

interface RequiredUpdateBannerProps {
  countdownMs: number;
  blockedReason: string | null;
  applying: boolean;
  onUpdateNow: () => void;
  onOpenUpdateScreen: () => void;
}

export function RequiredUpdateBanner({
  countdownMs,
  blockedReason,
  applying,
  onUpdateNow,
  onOpenUpdateScreen,
}: RequiredUpdateBannerProps) {
  return (
    <div className="flex shrink-0 items-center gap-[10px] border-b border-diff-removed-border bg-diff-removed-dim px-[14px] py-[8px] text-[12px] text-txt-body">
      <span>⚠</span>
      {blockedReason !== null ? (
        <span>Required update is blocked: {blockedReason}</span>
      ) : (
        <span>
          Required update installs automatically in{" "}
          <b className="font-mono tabular-nums">{formatCountdown(countdownMs)}</b>, save your work.
        </span>
      )}
      <button
        type="button"
        onClick={blockedReason !== null ? onOpenUpdateScreen : onUpdateNow}
        disabled={applying}
        className={`${btnDanger} ml-auto px-[12px] py-[5px] text-[11px]`}
      >
        {blockedReason !== null ? "Open update screen" : applying ? "Updating..." : "Update now"}
      </button>
    </div>
  );
}
