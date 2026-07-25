import type { ReactNode } from "react";

const RING_STROKE_WIDTH = 3;

interface RetryRingProps {
  size: number;
  tone: "accent" | "danger";
  children: ReactNode;
}

// Shared indeterminate spinner for the app's auto-retry screens (ConnectionLostScreen,
// ServerErrorScreen, TerminalView's DisconnectedOverlay). All three retry silently in the
// background on a fixed interval, so the ring communicates "in progress" without a countdown.
export function RetryRing({ size, tone, children }: RetryRingProps) {
  const radius: number = size / 2 - RING_STROKE_WIDTH;
  const circumference: number = 2 * Math.PI * radius;
  const center: number = size / 2;
  const strokeColor: string = tone === "danger" ? "var(--color-diff-removed)" : "var(--color-accent)";
  const iconColorClassName: string = tone === "danger" ? "text-diff-removed" : "text-accent";

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="animate-spin" style={{ width: size, height: size }}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--color-border-strong)"
          strokeWidth={RING_STROKE_WIDTH}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={RING_STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.25} ${circumference}`}
        />
      </svg>
      <span className={`absolute flex items-center justify-center ${iconColorClassName}`}>{children}</span>
    </div>
  );
}
