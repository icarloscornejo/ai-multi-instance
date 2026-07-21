import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, setUnauthorizedHandler } from "./api";
import { ConnectionLostScreen } from "./components/ConnectionLostScreen";
import { DeleteConfirmModal } from "./components/DeleteConfirmModal";
import { EmptyState } from "./components/EmptyState";
import { GateScreen } from "./components/GateScreen";
import { MobileHome } from "./components/MobileHome";
import { MobileKeyBar } from "./components/MobileKeyBar";
import { MobileTerminalChrome } from "./components/MobileTerminalChrome";
import { NewInstanceModal } from "./components/NewInstanceModal";
import { RequiredUpdateBanner } from "./components/RequiredUpdateBanner";
import { SetupScreen } from "./components/SetupScreen";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalView, type TerminalViewHandle } from "./components/TerminalView";
import { UpdateScreen } from "./components/UpdateScreen";
import { useIsMobile } from "./hooks/useIsMobile";
import { useVisualViewport } from "./hooks/useVisualViewport";
import {
  applyThemePreference,
  getInitialTheme,
  getInitialThemePreference,
  persistThemePreference,
  type Theme,
  type ThemePreference,
} from "./theme";
import type {
  CreateInstancePayload,
  DashboardConfig,
  Instance,
  UpdateInstancePayload,
  UpdateStatus,
} from "./types";

// How long the initial-load retry waits between attempts, and the countdown
// the ConnectionLostScreen ring animates against, kept in lockstep with it
const LOAD_RETRY_DELAY_MS = 3_000;

export function App() {
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [isNewInstanceModalOpen, setIsNewInstanceModalOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [updateViewOpen, setUpdateViewOpen] = useState<boolean>(false);
  const [autoApplyOnOpen, setAutoApplyOnOpen] = useState<boolean>(false);
  const [deleteRequest, setDeleteRequest] = useState<Instance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState<boolean>(false);
  const [loadRetryMsRemaining, setLoadRetryMsRemaining] = useState<number>(LOAD_RETRY_DELAY_MS);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [applyDeadline, setApplyDeadline] = useState<number | null>(null);
  const [countdownMs, setCountdownMs] = useState<number>(0);
  const [applying, setApplying] = useState<boolean>(false);
  const autoApplyFiredRef = useRef<boolean>(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [themePreference, setThemePreference] = useState<ThemePreference>(getInitialThemePreference);
  const isMobile: boolean = useIsMobile();
  const [mobileScreen, setMobileScreen] = useState<"home" | "terminal">("home");
  const [activeAtBottom, setActiveAtBottom] = useState<boolean>(true);
  const terminalHandlesRef = useRef<Map<string, TerminalViewHandle>>(new Map());
  const { keyboardOpen, height: visualViewportHeight } = useVisualViewport();
  const [mobileUpdateSnackbarOpen, setMobileUpdateSnackbarOpen] = useState<boolean>(false);
  // Mirrors TabBar's popover auto-show: opens once per newly-seen remote commit, and
  // re-dismissing with "Later" does not keep popping it back up for the same commit
  const mobileSnackbarShownForCommitRef = useRef<string | null>(null);

  const updateRequired: boolean =
    updateStatus?.requiredUpdate === true && updateStatus.updateAvailable === true;

  // Resolves and applies themePreference (mirroring "system" into the resolved `theme` via
  // onThemeChange), and keeps it synced live as the OS preference changes
  useEffect(() => {
    persistThemePreference(themePreference);
    return applyThemePreference(themePreference, setTheme);
  }, [themePreference]);

  // Any request hitting a 401 (not just the initial load) flips the app into the
  // password gate; the login page IS the app, so nothing else needs to change here
  useEffect(() => {
    setUnauthorizedHandler(() => setGateOpen(true));
    return () => setUnauthorizedHandler(null);
  }, []);

  // The server briefly drops off (tsx watch restarts it) while an update is applying,
  // so a failed initial load keeps retrying instead of stranding the user on a dead end
  useEffect(() => {
    let cancelled: boolean = false;
    let retryTimeoutId: number | undefined;
    let countdownIntervalId: number | undefined;

    const load = (): void => {
      Promise.all([api.getConfig(), api.listInstances()])
        .then(([loadedConfig, loadedInstances]) => {
          if (cancelled) {
            return;
          }
          setLoadError(null);
          setConfig(loadedConfig);
          setInstances(loadedInstances);
          const rememberedId: string | null = localStorage.getItem("ccdash.activeInstanceId");
          const initialInstance: Instance | undefined =
            loadedInstances.find((candidate) => candidate.id === rememberedId) ?? loadedInstances[0];
          setActiveInstanceId(initialInstance?.id ?? null);
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
          setLoadError(error.message);
          const retryStartedAt: number = Date.now();
          setLoadRetryMsRemaining(LOAD_RETRY_DELAY_MS);
          countdownIntervalId = window.setInterval(() => {
            setLoadRetryMsRemaining(Math.max(0, LOAD_RETRY_DELAY_MS - (Date.now() - retryStartedAt)));
          }, 100);
          retryTimeoutId = window.setTimeout(() => {
            window.clearInterval(countdownIntervalId);
            load();
          }, LOAD_RETRY_DELAY_MS);
        });
    };

    load();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimeoutId);
      window.clearInterval(countdownIntervalId);
    };
  }, []);

  // Keeps updateStatus fresh in the background so the toolbar indicator, popover, and
  // mandatory-update banner reflect reality without the user opening the Update screen
  useEffect(() => {
    let cancelled: boolean = false;
    const poll = (): void => {
      api
        .checkForUpdate()
        .then((freshStatus) => {
          if (!cancelled) {
            setUpdateStatus(freshStatus);
          }
        })
        .catch(() => undefined);
    };
    poll();
    const intervalId: number = window.setInterval(poll, 150_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
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

  // Hardware/gesture back and the in-app back button share this one handler:
  // both just call history.back(), so there is a single place that closes the terminal
  useEffect(() => {
    const handlePopState = (): void => setMobileScreen("home");
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Deleting the last-viewed instance (or closing it) can leave activeInstanceId null
  // while still "inside" the terminal screen; fall back to home rather than show nothing
  useEffect(() => {
    if (isMobile && mobileScreen === "terminal" && activeInstanceId === null) {
      setMobileScreen("home");
    }
  }, [isMobile, mobileScreen, activeInstanceId]);

  // Mobile has no toolbar to host the desktop UpdatePopover, so an optional (non-required)
  // update instead surfaces as a bottom snackbar on the home screen
  useEffect(() => {
    if (!isMobile || updateRequired || updateStatus?.updateAvailable !== true || updateStatus.remoteCommit === null) {
      return;
    }
    if (mobileSnackbarShownForCommitRef.current !== updateStatus.remoteCommit) {
      mobileSnackbarShownForCommitRef.current = updateStatus.remoteCommit;
      setMobileUpdateSnackbarOpen(true);
    }
  }, [isMobile, updateRequired, updateStatus]);

  const enterMobileTerminal = useCallback((instanceId: string): void => {
    setActiveInstanceId(instanceId);
    setMobileScreen("terminal");
    window.history.pushState({ mobileScreen: "terminal" }, "");
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

  const scrollActiveTerminalToBottom = useCallback((): void => {
    if (activeInstanceId === null) {
      return;
    }
    terminalHandlesRef.current.get(activeInstanceId)?.scrollToBottom();
  }, [activeInstanceId]);

  const blurActiveTerminal = useCallback((): void => {
    if (activeInstanceId === null) {
      return;
    }
    terminalHandlesRef.current.get(activeInstanceId)?.blurTerminal();
  }, [activeInstanceId]);

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
  if (loadError !== null) {
    return <ConnectionLostScreen msRemaining={loadRetryMsRemaining} totalMs={LOAD_RETRY_DELAY_MS} />;
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
      />
    );
  }
  if (updateViewOpen) {
    return (
      <UpdateScreen
        initialStatus={updateStatus}
        autoApply={autoApplyOnOpen}
        onStatusChange={setUpdateStatus}
        onClose={() => {
          setUpdateViewOpen(false);
          setAutoApplyOnOpen(false);
        }}
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
      {!isMobile && (
        <TabBar
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
                focusOnVisible={!isMobile || mobileScreen === "terminal"}
                onAtBottomChange={instance.id === activeInstanceId ? setActiveAtBottom : undefined}
              />
            ))
          )}
        </div>

        {!isMobile && activeInstance !== undefined && (
          <Sidebar instance={activeInstance} onUpdate={updateInstance} onDeleteRequest={setDeleteRequest} />
        )}

        {isMobile && mobileScreen === "home" && (
          <div className="absolute inset-0 z-10 bg-app">
            <MobileHome
              instances={instances}
              onOpenInstance={enterMobileTerminal}
              onNewInstance={() => setIsNewInstanceModalOpen(true)}
              onSettingsClick={() => setSettingsOpen(true)}
              onDeleteRequest={setDeleteRequest}
            />
            {mobileUpdateSnackbarOpen && updateStatus !== null && (
              <div className="absolute inset-x-[10px] bottom-[calc(10px+env(safe-area-inset-bottom))] z-20 flex items-center gap-[10px] rounded-lg border border-border-strong bg-surface px-[14px] py-[10px] shadow-modal">
                <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-txt-body">
                  Update available · {updateStatus.changelog.length} commits behind
                </span>
                <button
                  type="button"
                  onClick={() => setMobileUpdateSnackbarOpen(false)}
                  className="shrink-0 rounded-sm px-[8px] py-[6px] text-[11.5px] font-semibold text-txt-secondary hover:bg-raised"
                >
                  Later
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMobileUpdateSnackbarOpen(false);
                    openUpdateScreenAndApply();
                  }}
                  className="shrink-0 rounded-sm bg-accent px-[10px] py-[6px] text-[11.5px] font-semibold text-on-accent"
                >
                  Update
                </button>
              </div>
            )}
          </div>
        )}

        {isMobile && mobileScreen === "terminal" && activeInstance !== undefined && !activeAtBottom && (
          <button
            type="button"
            onClick={scrollActiveTerminalToBottom}
            className="absolute bottom-[8px] right-[14px] z-20 flex h-[36px] w-[36px] items-center justify-center rounded-full border border-border-strong bg-surface text-txt-secondary shadow-lg"
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        )}
      </div>

      {isMobile && mobileScreen === "terminal" && activeInstance !== undefined && (
        <MobileKeyBar onSendKey={sendKeyToActiveTerminal} onHideKeyboard={blurActiveTerminal} />
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
