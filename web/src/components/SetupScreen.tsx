import { useEffect, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { api, ApiError } from "../api";
import { PROVIDER_OPTIONS } from "../providerOptions";
import type { ThemePreference } from "../theme";
import type { AgentProvider, DashboardConfig } from "../types";
import { btnGhost, btnOutline, btnPrimary, cardClassName, errorTextClassName, inputClassName, inputErrorClassName } from "../ui";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

interface SetupScreenProps {
  initialLocations?: string[];
  initialEnabledProviders?: AgentProvider[];
  onConfigured: (config: DashboardConfig) => void;
  onClose?: () => void;
  // Only the mobile Settings screen shows this (Decision D): the desktop toggle stays binary
  showThemePicker?: boolean;
  themePreference?: ThemePreference;
  onThemePreferenceChange?: (preference: ThemePreference) => void;
}

interface LocationRow {
  id: string;
  value: string;
}

function makeRowId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function rowsFromInitial(initialLocations?: string[]): LocationRow[] {
  return (initialLocations !== undefined && initialLocations.length > 0 ? initialLocations : [""]).map((value) => ({
    id: makeRowId(),
    value,
  }));
}

interface SortableRowProps {
  row: LocationRow;
  errorText: string | null;
  onChange: (id: string, value: string) => void;
  onRemove: (id: string) => void;
  onEnter: () => void;
  autoFocus: boolean;
}

function SortableRow({ row, errorText, onChange, onRemove, onEnter, autoFocus }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex flex-col gap-[5px] ${isDragging ? "z-10 opacity-80" : ""}`}
    >
      <div className="flex items-center gap-[8px]">
        <span {...attributes} {...listeners} className="w-[14px] shrink-0 cursor-grab text-center text-[13px] text-txt-dimmer">
          ⋮⋮
        </span>
        <input
          className={errorText !== null ? inputErrorClassName : inputClassName}
          value={row.value}
          placeholder="/Users/your-user/projects/my-repo"
          autoFocus={autoFocus}
          onChange={(event) => onChange(row.id, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onEnter();
            }
          }}
        />
        <button
          type="button"
          onClick={() => onRemove(row.id)}
          title="Remove location"
          className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-sm text-[13px] text-txt-dim hover:bg-diff-removed-dim hover:text-diff-removed"
        >
          ✕
        </button>
      </div>
      {errorText !== null && <div className={`${errorTextClassName} ml-[22px]`}>⚠ {errorText}</div>}
    </div>
  );
}

export function SetupScreen({
  initialLocations,
  initialEnabledProviders,
  onConfigured,
  onClose,
  showThemePicker = false,
  themePreference,
  onThemePreferenceChange,
}: SetupScreenProps) {
  const [locations, setLocations] = useState<LocationRow[]>(() => rowsFromInitial(initialLocations));
  const [existsMap, setExistsMap] = useState<Record<string, boolean>>({});
  const [enabledProviders, setEnabledProviders] = useState<AgentProvider[]>(
    initialEnabledProviders ?? PROVIDER_OPTIONS.map((option) => option.value)
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const toggleProvider = (value: AgentProvider): void => {
    setEnabledProviders((previous) => {
      if (previous.includes(value)) {
        return previous.length === 1 ? previous : previous.filter((provider) => provider !== value);
      }
      return [...previous, value];
    });
  };

  // Debounced folder-existence check: only asks about paths we haven't already resolved,
  // so typing across several rows doesn't spam the server on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      locations.forEach((row) => {
        const trimmedValue: string = row.value.trim();
        if (trimmedValue !== "" && existsMap[trimmedValue] === undefined) {
          api
            .getLocationExists(trimmedValue)
            .then((result) => setExistsMap((previous) => ({ ...previous, [trimmedValue]: result.exists })))
            .catch(() => undefined);
        }
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [locations, existsMap]);

  const setLocationAt = (id: string, value: string): void => {
    setLocations((previousLocations) => previousLocations.map((row) => (row.id === id ? { ...row, value } : row)));
  };

  const removeLocationAt = (id: string): void => {
    setLocations((previousLocations) => previousLocations.filter((row) => row.id !== id));
  };

  const addLocation = (): void => {
    setLocations((previousLocations) => [...previousLocations, { id: makeRowId(), value: "" }]);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) {
      return;
    }
    const ids: string[] = locations.map((row) => row.id);
    const fromIndex: number = ids.indexOf(String(active.id));
    const toIndex: number = ids.indexOf(String(over.id));
    setLocations((previousLocations) => arrayMove(previousLocations, fromIndex, toIndex));
  };

  const trimmedValues: string[] = locations.map((row) => row.value.trim());
  const rowError = (row: LocationRow): string | null => {
    const trimmedValue: string = row.value.trim();
    if (trimmedValue === "") {
      return null;
    }
    const firstIndexWithSameValue: number = trimmedValues.findIndex((value) => value === trimmedValue);
    const isDuplicate: boolean = locations.findIndex((candidate) => candidate.id === row.id) !== firstIndexWithSameValue;
    if (isDuplicate) {
      return "Already added, remove one of the duplicates";
    }
    if (existsMap[trimmedValue] === false) {
      return "Folder not found, check the path or remove it";
    }
    return null;
  };
  const errorCount: number = locations.filter((row) => rowError(row) !== null).length;
  const canSave: boolean = locations.some((row) => row.value.trim() !== "") && errorCount === 0;

  const handleSave = async (): Promise<void> => {
    const trimmedLocations: string[] = locations.map((row) => row.value.trim()).filter((value) => value !== "");
    if (!canSave || saving) {
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    try {
      const savedConfig: DashboardConfig = await api.saveConfig({ locations: trimmedLocations, enabledProviders });
      onConfigured(savedConfig);
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : "Unexpected error saving.");
      setSaving(false);
    }
  };

  if (locations.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center px-[16px]">
        <div className="flex w-full max-w-[480px] flex-col items-center gap-[10px] rounded-lg border border-dashed border-border-strong p-[32px] text-center">
          <div className="flex h-[36px] w-[36px] items-center justify-center rounded-sm border border-border-strong text-[16px] text-txt-dim">
            +
          </div>
          <div className="text-[12.5px] font-semibold text-txt-bright">No locations yet</div>
          <div className="max-w-[320px] text-[11.5px] leading-[1.5] text-txt-dim">
            Add a folder to start opening Claude instances in it. You can add as many as you like.
          </div>
          <button type="button" onClick={addLocation} className={`${btnOutline} mt-[6px]`}>
            Add your first location
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center px-[16px]">
      <div className={`w-full max-w-[520px] max-h-[90vh] overflow-y-auto ${cardClassName}`}>
        <div className="flex flex-col gap-[4px]">
          <h1 className="text-[15px] font-bold text-txt-bright">Locations</h1>
          <p className="text-[12.5px] leading-[1.55] text-txt-secondary">
            Each location is a folder where terminals open. Open multiple instances in the same location at once.
            There's no per-folder limit.
          </p>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={handleDragEnd}>
          <SortableContext items={locations.map((row) => row.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-[10px]">
              {locations.map((row, index) => (
                <SortableRow
                  key={row.id}
                  row={row}
                  errorText={rowError(row)}
                  onChange={setLocationAt}
                  onRemove={removeLocationAt}
                  onEnter={() => void handleSave()}
                  autoFocus={index === 0}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <button
          type="button"
          onClick={addLocation}
          className="w-full rounded-sm border border-dashed border-border-strong py-[10px] text-[12px] font-semibold text-txt-secondary hover:border-accent-border hover:text-accent"
        >
          + Add location
        </button>

        {showThemePicker && themePreference !== undefined && onThemePreferenceChange !== undefined && (
          <div className="flex flex-col gap-[8px] border-t border-border pt-[14px]">
            <h2 className="text-[12.5px] font-semibold text-txt-bright">Appearance</h2>
            <div className="flex gap-[4px] rounded-sm border border-border-strong bg-app p-[3px]">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onThemePreferenceChange(option.value)}
                  className={`flex-1 rounded-sm py-[7px] text-[12px] font-semibold ${
                    themePreference === option.value
                      ? "bg-raised-2 text-txt-bright"
                      : "text-txt-secondary hover:text-txt-body"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-[4px] border-t border-border pt-[14px]">
          <h2 className="text-[12.5px] font-semibold text-txt-bright">Agents</h2>
          <p className="text-[11.5px] leading-[1.5] text-txt-secondary">
            Agents shown when launching a new instance. At least one must stay enabled.
          </p>
        </div>
        <div className="flex flex-col gap-[8px]">
          {PROVIDER_OPTIONS.map((option) => {
            const checked: boolean = enabledProviders.includes(option.value);
            const isLastEnabled: boolean = checked && enabledProviders.length === 1;
            return (
              <label
                key={option.value}
                className={`flex items-center gap-[8px] text-[12px] text-txt-body ${isLastEnabled ? "opacity-50" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isLastEnabled}
                  onChange={() => toggleProvider(option.value)}
                />
                {option.label}
              </label>
            );
          })}
        </div>

        {errorMessage !== null && <div className={errorTextClassName}>{errorMessage}</div>}

        <div className="flex items-center justify-between gap-[10px]">
          {errorCount > 0 && (
            <span className="text-[11px] text-diff-removed">
              Fix the {errorCount} error{errorCount === 1 ? "" : "s"} above to save
            </span>
          )}
          <div className="ml-auto flex gap-[10px]">
            {onClose !== undefined && (
              <button type="button" onClick={onClose} className={btnGhost}>
                Cancel
              </button>
            )}
            <button type="button" onClick={() => void handleSave()} disabled={!canSave || saving} className={btnPrimary}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
