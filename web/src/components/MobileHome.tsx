import { useState } from "react";
import type { Instance } from "../types";
import { btnPrimary } from "../ui";
import { ActionSheet } from "./ActionSheet";
import { InstanceCard } from "./InstanceCard";

interface MobileHomeProps {
  instances: Instance[];
  onOpenInstance: (instanceId: string) => void;
  onNewInstance: () => void;
  onSettingsClick: () => void;
  onDeleteRequest: (instance: Instance) => void;
}

export function MobileHome({
  instances,
  onOpenInstance,
  onNewInstance,
  onSettingsClick,
  onDeleteRequest,
}: MobileHomeProps) {
  const [longPressedInstance, setLongPressedInstance] = useState<Instance | null>(null);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[64px] shrink-0 items-center gap-[8px] px-[20px]">
        <span className="flex-1 truncate text-[20px] font-bold tracking-[-.03em] text-txt-bright">AI Multi-Instance</span>
        <button
          type="button"
          onClick={onSettingsClick}
          title="Settings"
          className="flex h-[38px] w-[38px] items-center justify-center rounded-md bg-raised text-txt-secondary hover:text-txt-body"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-[14px] pb-[96px]">
        {instances.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-[16px]">
            <span className="text-[14px] text-txt-dim">No active instances</span>
            <button type="button" onClick={onNewInstance} className={btnPrimary}>
              New instance
            </button>
          </div>
        ) : (
          instances.map((instance, index) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              isFirst={index === 0}
              onOpen={() => onOpenInstance(instance.id)}
              onLongPress={() => setLongPressedInstance(instance)}
            />
          ))
        )}
      </div>

      {instances.length > 0 && (
        <button
          type="button"
          onClick={onNewInstance}
          title="New instance"
          className="fixed bottom-[calc(22px+env(safe-area-inset-bottom))] right-[18px] flex h-[52px] w-[52px] items-center justify-center rounded-lg bg-accent text-[24px] font-semibold leading-none text-on-accent shadow-modal"
        >
          +
        </button>
      )}

      {longPressedInstance !== null && (
        <ActionSheet
          title={longPressedInstance.label}
          onClose={() => setLongPressedInstance(null)}
          actions={[
            {
              label: "Delete",
              danger: true,
              onSelect: () => onDeleteRequest(longPressedInstance),
            },
          ]}
        />
      )}
    </div>
  );
}
