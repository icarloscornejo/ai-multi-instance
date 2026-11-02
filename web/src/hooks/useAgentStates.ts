import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentState } from "../types";

const AGENT_STATES_POLL_MS = 2_000;
// A hung request must not hold the single in-flight slot forever.
const AGENT_STATES_TIMEOUT_MS = 10_000;

// Polls the batch endpoint while the tab is visible. A failed poll keeps the last map, since
// a blip should not make every badge flicker away.
export function useAgentStates(enabled: boolean): Record<string, AgentState> {
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
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
        .getAgentStates(AbortSignal.timeout(AGENT_STATES_TIMEOUT_MS))
        .then((entries) => {
          if (cancelled) {
            return;
          }
          const nextStates: Record<string, AgentState> = {};
          for (const [instanceId, entry] of Object.entries(entries)) {
            nextStates[instanceId] = entry.state;
          }
          setAgentStates(nextStates);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    refresh();
    const intervalId: number = window.setInterval(refresh, AGENT_STATES_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled]);

  return agentStates;
}
