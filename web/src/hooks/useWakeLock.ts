import { useEffect } from "react";

// Keeps the screen on while `enabled` is true (e.g. actively viewing a mobile terminal).
// The Wake Lock API releases itself whenever the tab is hidden and does NOT reacquire on
// its own, so this re-requests on every visibilitychange back to visible. Unsupported
// browsers and rejected requests (insecure context, low battery on some platforms) are
// swallowed: this is a nice-to-have, not something the terminal depends on.
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) {
      return;
    }
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = (): void => {
      navigator.wakeLock
        .request("screen")
        .then((newSentinel) => {
          if (cancelled) {
            newSentinel.release().catch(() => {});
            return;
          }
          sentinel = newSentinel;
        })
        .catch(() => {
          // Not fatal: e.g. low battery power-saver mode on some platforms rejects requests
        });
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        acquire();
      }
    };

    acquire();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      sentinel?.release().catch(() => {});
    };
  }, [enabled]);
}
