import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { DeleteConfirmModal } from "./components/DeleteConfirmModal";
import { EmptyState } from "./components/EmptyState";
import { NewInstanceModal } from "./components/NewInstanceModal";
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
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

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

  // Restore the "relaunch" banner if an update was already applied in this server run
  useEffect(() => {
    api
      .getUpdateStatus()
      .then((restoredStatus) => {
        if (restoredStatus.lastCheckAt !== null) {
          setUpdateStatus(restoredStatus);
        }
      })
      .catch(() => undefined);
  }, []);

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

  const relaunchInstance = (instanceId: string): void => {
    api.relaunchInstance(instanceId).catch((error: Error) => {
      console.error("Could not relaunch the command:", error.message);
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
      <TabBar
        instances={instances}
        activeInstanceId={activeInstanceId}
        updateStatus={updateStatus}
        onSelect={setActiveInstanceId}
        onRename={(instanceId, newLabel) => updateInstance(instanceId, { label: newLabel })}
        onReorder={reorderInstances}
        onAddClick={() => setIsNewInstanceModalOpen(true)}
        onUpdateClick={() => setUpdateViewOpen(true)}
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
          <Sidebar
            instance={activeInstance}
            onUpdate={updateInstance}
            onRelaunch={relaunchInstance}
            onDeleteRequest={setDeleteRequest}
          />
        )}
      </div>

      {isNewInstanceModalOpen && (
        <NewInstanceModal instances={instances} onCreate={createInstance} onClose={() => setIsNewInstanceModalOpen(false)} />
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
