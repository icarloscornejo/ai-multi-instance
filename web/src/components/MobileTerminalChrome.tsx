import { useState } from "react";
import type { Instance, UpdateInstancePayload } from "../types";
import { ActionSheet } from "./ActionSheet";
import { BottomSheet } from "./BottomSheet";
import { InstanceSettingsSheet } from "./InstanceSettingsSheet";

interface MobileTerminalChromeProps {
  instance: Instance;
  instances: Instance[];
  onBack: () => void;
  onSelectInstance: (instanceId: string) => void;
  onNewInstance: () => void;
  onUpdate: (instanceId: string, payload: UpdateInstancePayload) => void;
  onCloseRequest: (instance: Instance) => void;
}

export function MobileTerminalChrome({
  instance,
  instances,
  onBack,
  onSelectInstance,
  onNewInstance,
  onUpdate,
  onCloseRequest,
}: MobileTerminalChromeProps) {
  const [switcherOpen, setSwitcherOpen] = useState<boolean>(false);
  const [overflowOpen, setOverflowOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  return (
    <>
      <header className="flex h-[46px] shrink-0 items-center gap-[4px] border-b border-border bg-app px-[10px]">
        <button
          type="button"
          onClick={onBack}
          title="Back"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-sm text-txt-secondary hover:bg-raised hover:text-txt-body"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="min-w-0 flex-1 truncate px-[4px] text-[13.5px] font-semibold text-txt-bright">
          {instance.label}
        </span>
        <button
          type="button"
          onClick={() => setSwitcherOpen(true)}
          title="Switch instance"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-sm text-txt-secondary hover:bg-raised hover:text-txt-body"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="6" rx="1.5" />
            <rect x="3" y="14" width="18" height="6" rx="1.5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setOverflowOpen(true)}
          title="More"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-sm text-txt-secondary hover:bg-raised hover:text-txt-body"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      </header>

      {switcherOpen && (
        <BottomSheet onClose={() => setSwitcherOpen(false)}>
          <div className="px-[20px] pb-[10px] text-[13px] font-semibold text-txt-bright">Instances</div>
          <div className="flex max-h-[50vh] flex-col overflow-y-auto pb-[6px]">
            {instances.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => {
                  onSelectInstance(candidate.id);
                  setSwitcherOpen(false);
                }}
                className={`px-[20px] py-[12px] text-left text-[14px] hover:bg-raised ${
                  candidate.id === instance.id ? "font-semibold text-txt-bright" : "text-txt-secondary"
                }`}
              >
                {candidate.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setSwitcherOpen(false);
                onNewInstance();
              }}
              className="border-t border-border px-[20px] py-[12px] text-left text-[14px] text-txt-dim hover:bg-raised"
            >
              + New instance
            </button>
          </div>
        </BottomSheet>
      )}

      {overflowOpen && (
        <ActionSheet
          onClose={() => setOverflowOpen(false)}
          actions={[
            { label: "Instance settings", onSelect: () => setSettingsOpen(true) },
            { label: "Close instance", danger: true, onSelect: () => onCloseRequest(instance) },
          ]}
        />
      )}

      {settingsOpen && (
        <InstanceSettingsSheet
          instance={instance}
          onUpdate={onUpdate}
          onDeleteRequest={onCloseRequest}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}
