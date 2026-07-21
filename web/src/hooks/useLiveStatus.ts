import { useEffect, useState } from "react";
import { api } from "../api";
import type { LiveStatus } from "../types";

const LIVE_STATUS_POLL_MS = 1000;

export interface LiveStatusResult {
  liveStatus: LiveStatus | null;
  gitBranch: string | null;
}

// Polls the statusLine snapshot the dashboard-statusline.sh wrapper writes, so callers
// mirror the same live model/effort/branch/context/cost data Claude Code's own statusline
// shows, without waiting for a manual refresh. Only polls while enabled, so a mobile sheet
// that is closed does not keep hitting the API in the background.
export function useLiveStatus(instanceId: string, enabled: boolean): LiveStatusResult {
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);

  // Fallback branch lookup: used only while the live statusLine snapshot isn't
  // available (not configured yet, or Claude hasn't redrawn its statusline here).
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled: boolean = false;
    setGitBranch(null);
    api
      .getInstanceGit(instanceId)
      .then((result) => {
        if (!cancelled) {
          setGitBranch(result.branch ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitBranch(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId, enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled: boolean = false;
    setLiveStatus(null);
    const poll = (): void => {
      api
        .getInstanceLiveStatus(instanceId)
        .then((result) => {
          if (!cancelled) {
            setLiveStatus(result);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLiveStatus(null);
          }
        });
    };
    poll();
    const intervalId: ReturnType<typeof setInterval> = setInterval(poll, LIVE_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [instanceId, enabled]);

  return { liveStatus, gitBranch };
}
