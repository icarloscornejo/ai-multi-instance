import { RetryRing } from "./RetryRing";

export function ConnectionLostScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex w-full max-w-[580px] min-h-[320px] flex-col items-center justify-center gap-[18px] rounded-lg border border-border bg-app p-[40px] mx-[16px]">
        <RetryRing size={64} tone="accent">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[22px] w-[22px]"
          >
            <path d="M1 9a16 16 0 0 1 22 0M5 13a10.5 10.5 0 0 1 14 0M8.5 17a5.5 5.5 0 0 1 7 0" />
            <line x1="12" y1="21" x2="12.01" y2="21" />
          </svg>
        </RetryRing>
        <div className="text-[15px] font-semibold text-txt-bright">Reconnecting to the local server</div>
        <div className="max-w-[380px] text-center text-[12.5px] leading-[1.5] text-txt-dim">
          The connection to the app's local server was lost, likely because it briefly restarted during a
          self-update. Your instances are unaffected, and this will resolve on its own.
        </div>
      </div>
    </div>
  );
}
