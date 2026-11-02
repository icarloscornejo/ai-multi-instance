import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PrEventsResponse } from "../types";

const PR_EVENTS_POLL_MS = 5_000;
// A hung request must not hold the single in-flight slot forever.
const PR_EVENTS_TIMEOUT_MS = 10_000;

// Same shape as useAgentStates, slower: the server only refreshes this once a minute. A failed
// poll keeps the last map so a blip does not make the badges flicker away.
export function usePrEvents(enabled: boolean): PrEventsResponse {
  const [prEvents, setPrEvents] = useState<PrEventsResponse>({});
  const inFlightRef = useRef<boolean>(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled: boolean = false;
    const refresh = (): void => {
      if (document.hidden || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      api
        .getPrEvents(AbortSignal.timeout(PR_EVENTS_TIMEOUT_MS))
        .then((entries) => {
          if (!cancelled) {
            setPrEvents(entries);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    refresh();
    const intervalId: number = window.setInterval(refresh, PR_EVENTS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled]);

  return prEvents;
}
