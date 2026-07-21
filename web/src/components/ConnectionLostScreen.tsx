const RING_RADIUS = 28;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface ConnectionLostScreenProps {
  msRemaining: number;
  totalMs: number;
}

export function ConnectionLostScreen({ msRemaining, totalMs }: ConnectionLostScreenProps) {
  const progress: number = 1 - msRemaining / totalMs;
  const secondsRemaining: number = Math.max(1, Math.ceil(msRemaining / 1000));

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex w-full max-w-[580px] min-h-[320px] flex-col items-center justify-center gap-[18px] rounded-lg border border-border bg-app p-[40px] mx-[16px]">
        <div className="relative flex h-[64px] w-[64px] items-center justify-center">
          <svg viewBox="0 0 64 64" className="h-[64px] w-[64px] -rotate-90">
            <circle cx="32" cy="32" r={RING_RADIUS} fill="none" stroke="var(--color-border-strong)" strokeWidth="3" />
            <circle
              cx="32"
              cy="32"
              r={RING_RADIUS}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
            />
          </svg>
          <span className="absolute flex items-center justify-center text-accent">
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
          </span>
        </div>
        <div className="text-[15px] font-semibold text-txt-bright">Reconnecting to the local server</div>
        <div className="max-w-[380px] text-center text-[12.5px] leading-[1.5] text-txt-dim">
          The connection to the app's local server was lost, likely because it briefly restarted during a
          self-update. Your instances are unaffected, and this will resolve on its own.
        </div>
        <div className="text-[12px] tabular-nums text-txt-dimmer">
          Retrying in <span className="font-semibold text-txt-secondary">{secondsRemaining}</span> seconds...
        </div>
      </div>
    </div>
  );
}
