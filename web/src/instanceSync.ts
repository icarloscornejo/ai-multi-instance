import type { Instance } from "./types";

// Pure decisions behind the background instance-list refresh (App.tsx), split out so the
// tricky ordering rules can be tested without rendering the app. Every device talks to the
// same server, so the server's list is the truth; the job here is applying it to a browser
// tab without ever clobbering something the user just did in that same tab.

export interface ReconciledInstances {
  // The exact `previous` array when nothing changed, so setInstances can be skipped (no
  // re-render, no terminal churn) on the many polls where nothing happened elsewhere.
  instances: Instance[];
  activeInstanceId: string | null;
  // The instance this tab had selected no longer exists on the server (deleted from another
  // device). The caller decides what that means per platform: mobile goes back to home.
  activeRemoved: boolean;
}

export function reconcileFetchedInstances(
  previous: Instance[],
  fetched: Instance[],
  activeInstanceId: string | null
): ReconciledInstances {
  const unchanged: boolean = JSON.stringify(previous) === JSON.stringify(fetched);
  const activeRemoved: boolean =
    activeInstanceId !== null && !fetched.some((candidate) => candidate.id === activeInstanceId);
  return {
    instances: unchanged ? previous : fetched,
    // Deliberately null, never "the first remaining instance": on desktop a newly visible
    // terminal is auto-focused (TerminalView's focusOnVisible), so silently switching would
    // send whatever the user is typing to an agent they did not choose.
    activeInstanceId: activeRemoved ? null : activeInstanceId,
    activeRemoved,
  };
}

// A fetched list is only trustworthy if it cannot predate a local change. `generation` is
// bumped whenever a refresh or a local mutation starts AND when a mutation ends, and
// `pendingMutations` counts in-flight mutations: a response captured before any of those
// (the GET raced a PATCH/DELETE/create and the server answered first) must be dropped, and the
// next poll reconciles from fresh state.
export function shouldApplyRefresh(
  capturedGeneration: number,
  currentGeneration: number,
  pendingMutations: number
): boolean {
  return capturedGeneration === currentGeneration && pendingMutations === 0;
}
