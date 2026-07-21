import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DeleteConfirmModal } from "./components/DeleteConfirmModal";
import { EmptyState } from "./components/EmptyState";
import { NewInstanceModal } from "./components/NewInstanceModal";
import { RequiredUpdateBanner } from "./components/RequiredUpdateBanner";
import { SetupScreen } from "./components/SetupScreen";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalView } from "./components/TerminalView";
import { UpdateScreen } from "./components/UpdateScreen";
import { applyTheme, getInitialTheme, type Theme } from "./theme";
import type {
  CreateInstancePayload,
  DashboardConfig,
  Instance,
  UpdateInstancePayload,
  UpdateStatus,
} from "./types";

export function App() {
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [isNewInstanceModalOpen, setIsNewInstanceModalOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [updateViewOpen, setUpdateViewOpen] = useState<boolean>(false);
  const [deleteRequest, setDeleteRequest] = useState<Instance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [applyDeadline, setApplyDeadline] = useState<number | null>(null);
  const [countdownMs, setCountdownMs] = useState<number>(0);
  const [applying, setApplying] = useState<boolean>(false);
  const autoApplyFiredRef = useRef<boolean>(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  const updateRequired: boolean =
    updateStatus?.requiredUpdate === true && updateStatus.updateAvailable === true;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    Promise.all([api.getConfig(), api.listInstances()])
      .then(([loadedConfig, loadedInstances]) => {
        setConfig(loadedConfig);
        setInstances(loadedInstances);
        const rememberedId: string | null = localStorage.getItem("ccdash.activeInstanceId");
        const initialInstance: Instance | undefined =
          loadedInstances.find((candidate) => candidate.id === rememberedId) ?? loadedInstances[0];
        setActiveInstanceId(initialInstance?.id ?? null);
      })
      .catch((error: Error) => setLoadError(error.message));
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

  const createInstance = async (payload: CreateInstancePayload): Promise<void> => {
    const createdInstance: Instance = await api.createInstance(payload);
    setInstances((previousInstances) => [...previousInstances, createdInstance]);
    setActiveInstanceId(createdInstance.id);
    setIsNewInstanceModalOpen(false);
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

  const persistFontSize = useCallback(
    (instanceId: string, fontSize: number): void => {
      updateInstance(instanceId, { fontSize });
    },
    [updateInstance]
  );

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

  if (loadError !== null) {
    return (
      <div className="flex h-screen items-center justify-center text-[13px] text-diff-removed">
        Could not connect to the server: {loadError}
      </div>
    );
  }
  if (config === null) {
    return <div className="flex h-screen items-center justify-center text-[13px] text-txt-dim">Loading...</div>;
  }
  if (!config.configured) {
    return <SetupScreen onConfigured={setConfig} />;
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
      />
    );
  }
  if (updateViewOpen) {
    return (
      <UpdateScreen
        initialStatus={updateStatus}
        onStatusChange={setUpdateStatus}
        onClose={() => setUpdateViewOpen(false)}
      />
    );
  }

  const activeInstance: Instance | undefined = instances.find(
    (candidate) => candidate.id === activeInstanceId
  );

  return (
    <div className="flex h-screen flex-col">
      {updateRequired && (
        <RequiredUpdateBanner
          countdownMs={countdownMs}
          blockedReason={updateStatus?.blockedReason ?? null}
          applying={applying}
          onUpdateNow={() => void applyUpdateNow()}
          onOpenUpdateScreen={() => setUpdateViewOpen(true)}
        />
      )}
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
        onApplyNow={() => void applyUpdateNow()}
        onSettingsClick={() => setSettingsOpen(true)}
        onCloseRequest={setDeleteRequest}
        theme={theme}
        onToggleTheme={() => setTheme((previousTheme) => (previousTheme === "dark" ? "light" : "dark"))}
      />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {instances.length === 0 ? (
            <EmptyState onNewInstance={() => setIsNewInstanceModalOpen(true)} />
          ) : (
            instances.map((instance) => (
              <TerminalView
                key={instance.id}
                instance={instance}
                visible={instance.id === activeInstanceId}
                onPersistFontSize={persistFontSize}
                theme={theme}
              />
            ))
          )}
        </main>

        {activeInstance !== undefined && (
          <Sidebar instance={activeInstance} onUpdate={updateInstance} onDeleteRequest={setDeleteRequest} />
        )}
      </div>

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
  if (payload.fontSize !== undefined) normalized.fontSize = payload.fontSize;
  return normalized;
}
