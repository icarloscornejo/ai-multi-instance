import { useEffect, useRef } from "react";

// Fires onWake whenever the app comes back to the foreground or the network comes back,
// so a caller mid-backoff can retry immediately instead of waiting out the rest of its
// delay. visibilitychange and pageshow cover mobile backgrounding and bfcache restores;
// focus covers switching back to the tab on desktop; online covers the network itself
// coming back regardless of tab visibility.
export function useWakeRetry(onWake: () => void): void {
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  useEffect(() => {
    const wake = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      onWakeRef.current();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, []);
}
