import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, setUnauthorizedHandler } from "./api";
import { ConnectionLostScreen } from "./components/ConnectionLostScreen";
import { DeleteConfirmModal } from "./components/DeleteConfirmModal";
import { EmptyState } from "./components/EmptyState";
import { GateScreen } from "./components/GateScreen";
import { InstanceRail } from "./components/InstanceRail";
import { MobileHome } from "./components/MobileHome";
import { MobileKeyBar } from "./components/MobileKeyBar";
import { MobileTerminalChrome } from "./components/MobileTerminalChrome";
import { NewInstanceModal } from "./components/NewInstanceModal";
import { RequiredUpdateBanner } from "./components/RequiredUpdateBanner";
import { ServerErrorScreen } from "./components/ServerErrorScreen";
import { SetupScreen } from "./components/SetupScreen";
import { Sidebar } from "./components/Sidebar";
import { TerminalView, type TerminalViewHandle } from "./components/TerminalView";
import { UpdateScreen } from "./components/UpdateScreen";
import { useIsMobile } from "./hooks/useIsMobile";
import { useLiveStatus } from "./hooks/useLiveStatus";
import { useVisualViewport } from "./hooks/useVisualViewport";
import { useWakeLock } from "./hooks/useWakeLock";
import { useWakeRetry } from "./hooks/useWakeRetry";
import {
  applyThemePreference,
  getInitialTheme,
  getInitialThemePreference,
  persistThemePreference,
  type Theme,
  type ThemePreference,
} from "./theme";
import { getInitialKeyBarPrefs, persistKeyBarPrefs, type KeyBarPref } from "./keyBar";
import {
  getInitialRestoreTarget,
  persistRestoreTargetToSession,
  resolveRestoredScreen,
  type MobileScreen,
} from "./mobileSession";
import { retryDelayMs } from "./retry";
import type {
  CreateInstancePayload,
  DashboardConfig,
  Instance,
  UpdateInstancePayload,
  UpdateStatus,
} from "./types";

// Most load failures (tsx watch restarting the server during a self-update) resolve on the
// very next retry, well under this delay, so the full-screen ConnectionLostScreen/
// ServerErrorScreen is held back instead of shown immediately: flashing it for a blip that
// clears in a few hundred ms is just noise. A real outage still surfaces it soon enough.
const LOAD_FAILURE_DISPLAY_DELAY_MS = 1_500;

export function App() {
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [isNewInstanceModalOpen, setIsNewInstanceModalOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [updateViewOpen, setUpdateViewOpen] = useState<boolean>(false);
  const [autoApplyOnOpen, setAutoApplyOnOpen] = useState<boolean>(false);
  const [deleteRequest, setDeleteRequest] = useState<Instance | null>(null);
  const [loadFailure, setLoadFailure] = useState<"connection" | "server" | null>(null);
  // Mirrors loadFailure for the wake-retry handler below, which is registered once and
  // would otherwise close over the initial (stale) value instead of the live one.
  const loadFailureRef = useRef<"connection" | "server" | null>(null);
  loadFailureRef.current = loadFailure;
  const loadRetryAttemptRef = useRef<number>(0);
  const loadRetryTimeoutIdRef = useRef<number | undefined>(undefined);
  // See LOAD_FAILURE_DISPLAY_DELAY_MS: holds the pending "show the failure screen" timer so
  // a retry that succeeds before it fires can cancel it instead of the screen flashing on.
  const loadFailureDisplayTimeoutIdRef = useRef<number | undefined>(undefined);
  const loadRef = useRef<() => void>(() => undefined);
  const [gateOpen, setGateOpen] = useState<boolean>(false);
  // Mirrors gateOpen for the pageshow handler below, which is registered once and would
  // otherwise close over the initial (stale) value instead of the live one.
  const gateOpenRef = useRef<boolean>(false);
  gateOpenRef.current = gateOpen;
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [applyDeadline, setApplyDeadline] = useState<number | null>(null);
  const [countdownMs, setCountdownMs] = useState<number>(0);
  const [applying, setApplying] = useState<boolean>(false);
  // Mirror applying/updateViewOpen for the background poll effect below, which has an
  // empty dependency array and would otherwise close over stale (initial) values.
  const applyingRef = useRef<boolean>(false);
  applyingRef.current = applying;
  const updateViewOpenRef = useRef<boolean>(false);
  updateViewOpenRef.current = updateViewOpen;
  const autoApplyFiredRef = useRef<boolean>(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [themePreference, setThemePreference] = useState<ThemePreference>(getInitialThemePreference);
  const [keyBarPrefs, setKeyBarPrefs] = useState<KeyBarPref[]>(getInitialKeyBarPrefs);
  const isMobile: boolean = useIsMobile();
  // Restored synchronously from sessionStorage, but ONLY when the initial isMobile value is
  // true: `isMobile` above is already settled for this render by the time this initializer runs,
  // so a desktop load never picks up a stale "terminal" from a previous mobile session - without
  // that guard, a desktop tab could start hidden-but-"terminal" internally and jump straight into
  // it the moment the window narrows past the mobile breakpoint. Whether this restored screen is
  // still valid (does the remembered instance actually exist) can't be known yet at this point -
  // instances haven't loaded - so that correction happens once load() resolves, see
  // instancesLoaded below.
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>(() =>
    isMobile ? getInitialRestoreTarget().screen : "home"
  );
  // True once the initial instances list has actually loaded (see load()'s success branch
  // below). Gates two things that would otherwise be wrong during the loading window: the
  // terminal-with-no-instance fallback (350ish lines down) and the sessionStorage/history sync
  // effect (just below it) - both need to know the real instance list before they can safely act,
  // or they'd wrongly treat "still loading" the same as "there is no such instance".
  const [instancesLoaded, setInstancesLoaded] = useState<boolean>(false);
  // True while the desktop rail has an inline rename open; suppresses the active terminal's
  // own visibility-focus so a rename on a just-selected row doesn't lose focus to xterm two
  // rAF later (see TerminalView's suppressAutoFocus prop).
  const [railEditingActive, setRailEditingActive] = useState<boolean>(false);
  const terminalHandlesRef = useRef<Map<string, TerminalViewHandle>>(new Map());
  const { keyboardOpen, height: visualViewportHeight } = useVisualViewport();
  useWakeLock(isMobile && mobileScreen === "terminal");

  // Single live-status poll for the active instance, shared by the desktop session bar and
  // the inspector (Sidebar) so both show the same branch/usage snapshot instead of each
  // polling independently. Disabled on mobile: InstanceSettingsSheet runs its own scoped poll
  // only while that sheet is actually open.
  const { liveStatus: activeLiveStatus, gitBranch: activeGitBranch } = useLiveStatus(
    activeInstanceId ?? "",
    !isMobile && activeInstanceId !== null
  );

  const updateRequired: boolean =
    updateStatus?.requiredUpdate === true && updateStatus.updateAvailable === true;

  // Resolves and applies themePreference (mirroring "system" into the resolved `theme` via
  // onThemeChange), and keeps it synced live as the OS preference changes
  useEffect(() => {
    persistThemePreference(themePreference);
    return applyThemePreference(themePreference, setTheme);
  }, [themePreference]);

  useEffect(() => {
    persistKeyBarPrefs(keyBarPrefs);
  }, [keyBarPrefs]);

  // Any request hitting a 401 (not just the initial load) flips the app into the
  // password gate; the login page IS the app, so nothing else needs to change here
  useEffect(() => {
    setUnauthorizedHandler(() => setGateOpen(true));
    return () => setUnauthorizedHandler(null);
  }, []);

  // Mobile back-navigation out of a terminal (history.back()) can land the browser on a
  // bfcache snapshot of this same page frozen from before the post-login reload, replaying
  // a stale gateOpen=true instead of the live (unlocked) state. Forcing a real reload in
  // that specific case is the standard fix: it's exactly what a manual refresh already does.
  // Every other bfcache restore (backgrounding the tab and coming back, the common mobile
  // case) must NOT reload: the React tree and the terminal's xterm buffer survived in
  // memory untouched, so reloading here would only throw away real state (which instance/
  // screen you were on) for no reason.
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent): void => {
      if (event.persisted && gateOpenRef.current) {
        window.location.reload();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  // The server briefly drops off (tsx watch restarts it) while an update is applying,
  // so a failed initial load keeps retrying instead of stranding the user on a dead end
  useEffect(() => {
    let cancelled: boolean = false;

    const load = (): void => {
      Promise.all([api.getConfig(), api.listInstances()])
        .then(([loadedConfig, loadedInstances]) => {
          if (cancelled) {
            return;
          }
          loadRetryAttemptRef.current = 0;
          window.clearTimeout(loadFailureDisplayTimeoutIdRef.current);
          loadFailureDisplayTimeoutIdRef.current = undefined;
          setLoadFailure(null);
          setConfig(loadedConfig);
          setInstances(loadedInstances);
          // On mobile, a per-tab session target (sessionStorage) takes priority over the
          // global "last viewed instance" (localStorage): that's what keeps two mobile tabs on
          // different instances from restoring the same one (see mobileSession.ts's header
          // comment). Desktop never had a session target to begin with, so it always falls
          // through to the global one, unchanged from before.
          const sessionTarget = isMobile ? getInitialRestoreTarget() : null;
          const sessionInstanceExists: boolean =
            sessionTarget?.instanceId !== null &&
            sessionTarget !== null &&
            loadedInstances.some((candidate) => candidate.id === sessionTarget.instanceId);
          const rememberedId: string | null =
            sessionInstanceExists && sessionTarget !== null
              ? sessionTarget.instanceId
              : localStorage.getItem("ccdash.activeInstanceId");
          const rememberedInstance: Instance | undefined = loadedInstances.find(
            (candidate) => candidate.id === rememberedId
          );
          const initialInstance: Instance | undefined = rememberedInstance ?? loadedInstances[0];
          setActiveInstanceId(initialInstance?.id ?? null);
          // Corrects the synchronous, optimistic restoration from mount (mobileScreen's own
          // useState initializer): that one couldn't yet know whether the remembered instance
          // still exists, only what was saved. resolveRestoredScreen degrades to home when it
          // doesn't - a deleted instance is not a terminal worth showing.
          if (sessionTarget !== null) {
            setMobileScreen(resolveRestoredScreen(sessionTarget, sessionInstanceExists));
          }
          setInstancesLoaded(true);
        })
        .catch((error: Error) => {
          if (cancelled) {
            return;
          }
          if (error instanceof ApiError && error.status === 401) {
            // Not a dead server, just a missing/expired auth cookie: the onUnauthorized
            // handler above already opens the gate, so no reconnect-retry loop here
            return;
          }
          // An ApiError means the server responded (even if with a 4xx/5xx); anything else
          // (fetch's TypeError) means the server never answered at all
          const failureType: "connection" | "server" = error instanceof ApiError ? "server" : "connection";
          if (loadFailureRef.current !== null) {
            // Already on-screen (retries have been failing past the delay below): reflect
            // the current failure type immediately instead of waiting out another delay.
            setLoadFailure(failureType);
          } else if (loadFailureDisplayTimeoutIdRef.current === undefined) {
            loadFailureDisplayTimeoutIdRef.current = window.setTimeout(() => {
              loadFailureDisplayTimeoutIdRef.current = undefined;
              setLoadFailure(failureType);
            }, LOAD_FAILURE_DISPLAY_DELAY_MS);
          }
          loadRetryTimeoutIdRef.current = window.setTimeout(load, retryDelayMs(loadRetryAttemptRef.current));
          loadRetryAttemptRef.current += 1;
        });
    };

    loadRef.current = load;
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(loadRetryTimeoutIdRef.current);
      window.clearTimeout(loadFailureDisplayTimeoutIdRef.current);
    };
  }, []);

  // While a load failure is being retried on a backoff timer, coming back to the
  // foreground (or the network coming back) should not have to wait out the rest of
  // that delay: retry immediately and reset the backoff, same as a fresh failure would.
  useWakeRetry(() => {
    if (loadFailureRef.current === null) {
      return;
    }
    window.clearTimeout(loadRetryTimeoutIdRef.current);
    loadRetryAttemptRef.current = 0;
    loadRef.current();
  });

  // Keeps updateStatus fresh in the background so the toolbar indicator, popover, and
  // mandatory-update banner reflect reality without the user opening the Update screen.
  // Skips polling while the tab is hidden (each check runs a git fetch against GitHub, and
  // a forgotten background tab shouldn't burn through rate limits) and fires one right away
  // when the tab becomes visible again instead of waiting out the rest of the interval.
  // Also skips while an apply is in flight or the Update screen is open: applyUpdate() holds
  // a server-side mutex and returns a stale snapshot to concurrent checks, so a poll landing
  // mid-apply could overwrite fresh state with an outdated "update available" for a commit
  // that is, by the time the response arrives, already applied.
  useEffect(() => {
    let cancelled: boolean = false;
    const poll = (): void => {
      if (document.hidden || applyingRef.current || updateViewOpenRef.current) {
        return;
      }
      api
        .checkForUpdate()
        .then((freshStatus) => {
          // A poll already in flight when an apply started isn't stopped by the guard
          // above (that only blocks new polls from firing); re-check here too so its
          // stale response, arriving after the fact, can't overwrite the fresh status.
          if (!cancelled && !applyingRef.current && !updateViewOpenRef.current) {
            setUpdateStatus(freshStatus);
          }
        })
        .catch(() => undefined);
    };
    const handleVisibilityChange = (): void => {
      if (!document.hidden) {
        poll();
      }
    };
    poll();
    const intervalId: number = window.setInterval(poll, 30_000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const applyUpdateNow = useCallback(async (): Promise<void> => {
    if (applying) {
      return;
    }
    setApplying(true);
    autoApplyFiredRef.current = true;
    setApplyDeadline(null);
    try {
      const resultStatus: UpdateStatus = await api.applyUpdate();
      setUpdateStatus(resultStatus);
      if (resultStatus.blockedReason !== null) {
        setUpdateViewOpen(true);
      }
    } catch {
      setUpdateViewOpen(true);
    } finally {
      setApplying(false);
    }
  }, [applying]);

  // "Update now" from the banner or popover should show the update screen applying
  // rather than installing silently in the background
  const openUpdateScreenAndApply = useCallback((): void => {
    setAutoApplyOnOpen(true);
    setUpdateViewOpen(true);
  }, []);

  // Arms a 5-minute deadline the first time a required update appears, and disarms it
  // (re-allowing a future arm) once the requirement clears, e.g. after a successful apply
  useEffect(() => {
    if (updateRequired && applyDeadline === null && !autoApplyFiredRef.current) {
      setApplyDeadline(Date.now() + 5 * 60 * 1000);
    }
    if (!updateRequired) {
      setApplyDeadline(null);
      autoApplyFiredRef.current = false;
    }
  }, [updateRequired, applyDeadline]);

  // Ticks the live countdown and fires the forced install exactly once at zero
  useEffect(() => {
    if (applyDeadline === null) {
      setCountdownMs(0);
      return;
    }
    const tick = (): void => {
      const remainingMs: number = Math.max(0, applyDeadline - Date.now());
      setCountdownMs(remainingMs);
      if (remainingMs === 0 && !autoApplyFiredRef.current) {
        void applyUpdateNow();
      }
    };
    tick();
    const intervalId: number = window.setInterval(tick, 250);
    return () => window.clearInterval(intervalId);
  }, [applyDeadline, applyUpdateNow]);

  useEffect(() => {
    if (activeInstanceId !== null) {
      localStorage.setItem("ccdash.activeInstanceId", activeInstanceId);
    }
  }, [activeInstanceId]);

  // The one place that keeps sessionStorage AND window.history.state in sync with React state,
  // instead of every call site (enterMobileTerminal, MobileTerminalChrome's onSelectInstance,
  // confirmDelete picking a fallback instance, ...) having to remember to do it. Reacting to
  // STATE rather than to specific callbacks is what makes this correct regardless of which of
  // those call sites actually changed activeInstanceId - see mobileSession.ts's header comment
  // for why the target has to include instanceId, not just the screen, and this repo's git
  // history (699ac35 -> this change) for the race this replaces: writing on every render
  // (including the very first, before load() had resolved anything) used to overwrite the real
  // stored target with "home"/null before it was ever read back.
  //
  // Gated on instancesLoaded so it never runs during the ambiguous window between mount and
  // load() resolving: if a crash happens in that window, the next load simply restores whatever
  // was there from the START of this session, which is exactly as good as before this feature
  // existed - never worse.
  useEffect(() => {
    if (!isMobile || !instancesLoaded) {
      return;
    }
    persistRestoreTargetToSession({ screen: mobileScreen, instanceId: activeInstanceId });

    const desiredHistoryState = mobileScreen === "terminal" ? { mobileScreen: "terminal", instanceId: activeInstanceId } : null;
    const currentHistoryState = window.history.state as { mobileScreen?: unknown; instanceId?: unknown } | null;
    if (desiredHistoryState === null) {
      return;
    }
    if (currentHistoryState?.mobileScreen !== "terminal") {
      // Home -> terminal: exactly one new entry, so a single Back always lands on home.
      window.history.pushState(desiredHistoryState, "");
    } else if (currentHistoryState.instanceId !== desiredHistoryState.instanceId) {
      // Already viewing a terminal, just switched instance: update the CURRENT entry instead of
      // pushing another one, or every instance switch would pile up a new Back stop.
      window.history.replaceState(desiredHistoryState, "");
    }
  }, [isMobile, instancesLoaded, mobileScreen, activeInstanceId]);

  // Hardware/gesture back and forward share this one handler. Derives both the screen AND which
  // instance from event.state (pushed/replaced by the effect above) instead of always forcing
  // "home": that old behavior made Forward, after a Back out of a terminal, do nothing useful.
  useEffect(() => {
    const handlePopState = (event: PopStateEvent): void => {
      const state = event.state as { mobileScreen?: unknown; instanceId?: unknown } | null;
      if (state?.mobileScreen === "terminal") {
        setMobileScreen("terminal");
        if (typeof state.instanceId === "string") {
          setActiveInstanceId(state.instanceId);
        }
      } else {
        setMobileScreen("home");
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Deleting the last-viewed instance (or closing it) can leave activeInstanceId null, or
  // pointing at an instance that no longer exists (e.g. popstate restoring a stale entry for one
  // deleted meanwhile), while still "inside" the terminal screen; fall back to home rather than
  // show nothing. Gated on instancesLoaded for the same reason as the sync effect above: during
  // the loading window activeInstanceId is legitimately still settling, not actually invalid.
  useEffect(() => {
    if (!isMobile || !instancesLoaded || mobileScreen !== "terminal") {
      return;
    }
    const activeInstanceStillExists: boolean = instances.some((candidate) => candidate.id === activeInstanceId);
    if (!activeInstanceStillExists) {
      setMobileScreen("home");
    }
  }, [isMobile, instancesLoaded, mobileScreen, activeInstanceId, instances]);

  // Update is not user-reachable on mobile: no toolbar/rail to host a "check for updates"
  // entry point there, and the small screen isn't a good fit for the commit-comparison UI.
  // A required update still applies itself automatically via the countdown effect below,
  // regardless of screen size; only the optional, user-initiated path is unavailable here.

  // History/sessionStorage sync is handled entirely by the effect above, reacting to state - this
  // only needs to set the state itself.
  const enterMobileTerminal = useCallback((instanceId: string): void => {
    setActiveInstanceId(instanceId);
    setMobileScreen("terminal");
  }, []);

  const closeMobileTerminal = useCallback((): void => {
    window.history.back();
  }, []);

  const sendKeyToActiveTerminal = useCallback(
    (data: string): void => {
      if (activeInstanceId === null) {
        return;
      }
      terminalHandlesRef.current.get(activeInstanceId)?.sendInput(data);
    },
    [activeInstanceId]
  );

  const createInstance = async (payload: CreateInstancePayload): Promise<void> => {
    const createdInstance: Instance = await api.createInstance(payload);
    setInstances((previousInstances) => [...previousInstances, createdInstance]);
    setIsNewInstanceModalOpen(false);
    if (isMobile) {
      enterMobileTerminal(createdInstance.id);
    } else {
      setActiveInstanceId(createdInstance.id);
    }
  };

  const updateInstance = useCallback((instanceId: string, payload: UpdateInstancePayload): void => {
    setInstances((previousInstances) =>
      previousInstances.map((candidate) =>
        candidate.id === instanceId ? { ...candidate, ...normalizePayload(candidate, payload) } : candidate
      )
    );
    api.updateInstance(instanceId, payload).catch((error: Error) => {
      console.error("Could not save the change:", error.message);
    });
  }, []);

  const confirmDelete = async (): Promise<void> => {
    if (deleteRequest === null) {
      return;
    }
    const targetInstance: Instance = deleteRequest;
    await api.deleteInstance(targetInstance.id);
    setInstances((previousInstances) => {
      const remainingInstances: Instance[] = previousInstances.filter(
        (candidate) => candidate.id !== targetInstance.id
      );
      if (activeInstanceId === targetInstance.id) {
        setActiveInstanceId(remainingInstances[0]?.id ?? null);
      }
      return remainingInstances;
    });
    setDeleteRequest(null);
  };

  const reorderInstances = (orderedIds: string[]): void => {
    setInstances((previousInstances) => {
      const instanceById: Map<string, Instance> = new Map(
        previousInstances.map((instance) => [instance.id, instance])
      );
      return orderedIds.map((id) => instanceById.get(id) as Instance);
    });
    api.reorderInstances(orderedIds).catch((error: Error) => {
      console.error("Could not save the new order:", error.message);
    });
  };

  if (gateOpen) {
    return <GateScreen onUnlocked={() => window.location.reload()} />;
  }
  if (loadFailure === "connection") {
    return <ConnectionLostScreen />;
  }
  if (loadFailure === "server") {
    return <ServerErrorScreen />;
  }
  if (config === null) {
    return (
      <div className="flex h-dvh-full items-center justify-center text-[13px] text-txt-dim">Loading...</div>
    );
  }
  if (!config.configured) {
    return <SetupScreen onConfigured={setConfig} isMobile={isMobile} />;
  }
  if (settingsOpen) {
    return (
      <SetupScreen
        initialLocations={config.locations}
        initialEnabledProviders={config.enabledProviders}
        onConfigured={(newConfig) => {
          setConfig(newConfig);
          setSettingsOpen(false);
        }}
        onClose={() => setSettingsOpen(false)}
        isMobile={isMobile}
        showThemePicker={isMobile}
        themePreference={themePreference}
        onThemePreferenceChange={setThemePreference}
        showKeyBarPicker={isMobile}
        keyBarPrefs={keyBarPrefs}
        onKeyBarPrefsChange={setKeyBarPrefs}
      />
    );
  }
  const activeInstance: Instance | undefined = instances.find(
    (candidate) => candidate.id === activeInstanceId
  );

  return (
    <div
      className="flex h-dvh-full flex-col"
      // dvh already tracks the native keyboard on Android (interactive-widget=resizes-content
      // in index.html), but iOS Safari never shrinks dvh for the keyboard; pinning to the
      // measured visualViewport height covers that case without needing a fixed/offset
      // MobileKeyBar or any manual padding math.
      style={isMobile && keyboardOpen ? { height: `${visualViewportHeight}px` } : undefined}
    >
      {updateRequired && (
        <RequiredUpdateBanner
          countdownMs={countdownMs}
          blockedReason={updateStatus?.blockedReason ?? null}
          applying={applying}
          onUpdateNow={openUpdateScreenAndApply}
          onOpenUpdateScreen={() => setUpdateViewOpen(true)}
        />
      )}
      {isMobile && mobileScreen === "terminal" && activeInstance !== undefined && (
        <MobileTerminalChrome
          instance={activeInstance}
          instances={instances}
          onBack={closeMobileTerminal}
          onSelectInstance={setActiveInstanceId}
          onNewInstance={() => setIsNewInstanceModalOpen(true)}
          onUpdate={updateInstance}
          onCloseRequest={setDeleteRequest}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {/* Desktop rail and inspector are fixed sibling slots ({!isMobile && ...}), never a
            wrapper the terminal pool itself moves in or out of: see the pool's own comment
            below for why that distinction matters. */}
        {!isMobile && (
          <InstanceRail
            instances={instances}
            activeInstanceId={activeInstanceId}
            updateStatus={updateStatus}
            updateRequired={updateRequired}
            countdownMs={countdownMs}
            applying={applying}
            onSelect={setActiveInstanceId}
            onRename={(instanceId, newLabel) => updateInstance(instanceId, { label: newLabel })}
            onReorder={reorderInstances}
            onAddClick={() => setIsNewInstanceModalOpen(true)}
            onUpdateClick={() => setUpdateViewOpen(true)}
            onApplyNow={openUpdateScreenAndApply}
            onSettingsClick={() => setSettingsOpen(true)}
            onCloseRequest={setDeleteRequest}
            theme={theme}
            onToggleTheme={() => setThemePreference(theme === "dark" ? "light" : "dark")}
            onEditingChange={setRailEditingActive}
          />
        )}

        {/* pt only on desktop: without a session bar above it anymore, the terminal was
            sitting flush against the top edge. Mobile already has its own header
            (MobileTerminalChrome) above the pool, so it doesn't need this. bg-terminal (not
            the app background) so that top margin reads as part of the terminal's own white
            surface instead of a gray strip borrowed from the app chrome behind it. */}
        <div className={`flex min-w-0 flex-1 flex-col ${!isMobile ? "bg-terminal pt-[10px]" : ""}`}>
          <div className="relative flex min-h-0 flex-1">
            {/* The terminal pool: always rendered at this exact tree position, only its
                className toggles, so xterm never remounts when crossing the mobile/desktop
                breakpoint or navigating between the mobile home and terminal screens. */}
            <div
              className={
                isMobile && mobileScreen !== "terminal" ? "hidden" : "flex min-w-0 flex-1 flex-col"
              }
            >
              {instances.length === 0 && !isMobile ? (
                <EmptyState onNewInstance={() => setIsNewInstanceModalOpen(true)} />
              ) : (
                instances.map((instance) => (
                  <TerminalView
                    key={instance.id}
                    ref={(handle) => {
                      if (handle) {
                        terminalHandlesRef.current.set(instance.id, handle);
                      } else {
                        terminalHandlesRef.current.delete(instance.id);
                      }
                    }}
                    instance={instance}
                    visible={instance.id === activeInstanceId}
                    theme={theme}
                    focusOnVisible={!isMobile}
                    suppressAutoFocus={!isMobile && railEditingActive}
                  />
                ))
              )}
            </div>

            {isMobile && mobileScreen === "home" && (
              <div className="absolute inset-0 z-10 bg-app">
                <MobileHome
                  instances={instances}
                  onOpenInstance={enterMobileTerminal}
                  onNewInstance={() => setIsNewInstanceModalOpen(true)}
                  onSettingsClick={() => setSettingsOpen(true)}
                  onDeleteRequest={setDeleteRequest}
                />
              </div>
            )}
          </div>
        </div>

        {!isMobile && activeInstance !== undefined && (
          <Sidebar
            instance={activeInstance}
            liveStatus={activeLiveStatus}
            gitBranch={activeGitBranch}
            onUpdate={updateInstance}
            onDeleteRequest={setDeleteRequest}
          />
        )}
      </div>

      {isMobile && mobileScreen === "terminal" && activeInstance !== undefined && (
        <MobileKeyBar prefs={keyBarPrefs} onSendKey={sendKeyToActiveTerminal} />
      )}

      {isNewInstanceModalOpen && (
        <NewInstanceModal
          instances={instances}
          enabledProviders={config.enabledProviders}
          onCreate={createInstance}
          onClose={() => setIsNewInstanceModalOpen(false)}
        />
      )}

      {deleteRequest !== null && (
        <DeleteConfirmModal
          instance={deleteRequest}
          onConfirm={confirmDelete}
          onClose={() => setDeleteRequest(null)}
        />
      )}

      {/* Approved redesign: Update is an overlay above the current app/terminal context,
          not a full-screen replacement (see the handoff's "Update is an overlay/modal"
          correction). The terminal pool above stays mounted and connected the whole time;
          Modal's useFocusTrap (see Modal.tsx) is what stops a keystroke meant for this dialog
          from still reaching the covered terminal's xterm textarea. */}
      {updateViewOpen && (
        <UpdateScreen
          initialStatus={updateStatus}
          autoApply={autoApplyOnOpen}
          onStatusChange={setUpdateStatus}
          onClose={() => {
            setUpdateViewOpen(false);
            setAutoApplyOnOpen(false);
          }}
        />
      )}
    </div>
  );
}

// PATCH accepts null to clear a field, but local state uses the same types as the API
function normalizePayload(instance: Instance, payload: UpdateInstancePayload): Partial<Instance> {
  const normalized: Partial<Instance> = {};
  if (payload.label !== undefined) normalized.label = payload.label;
  if (payload.command !== undefined) normalized.command = payload.command;
  if (payload.model !== undefined) normalized.model = payload.model;
  if (payload.effort !== undefined) normalized.effort = payload.effort;
  return normalized;
}
