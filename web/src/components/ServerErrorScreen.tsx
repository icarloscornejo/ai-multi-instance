import { RetryRing } from "./RetryRing";

export function ServerErrorScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex w-full max-w-[580px] min-h-[320px] flex-col items-center justify-center gap-[18px] rounded-lg border border-border bg-app p-[40px] mx-[16px]">
        <RetryRing size={64} tone="danger">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[22px] w-[22px]"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </RetryRing>
        <div className="text-[15px] font-semibold text-txt-bright">Something went wrong on the server</div>
        <div className="max-w-[400px] text-center text-[12.5px] leading-[1.5] text-txt-dim">
          The local server ran into an unexpected error while loading your instances. Retrying automatically...
        </div>
      </div>
    </div>
  );
}
