import { useState } from "react";
import { api, ApiError } from "../api";
import type { DashboardConfig } from "../types";

interface SetupScreenProps {
  initialLocations?: string[];
  onConfigured: (config: DashboardConfig) => void;
  onClose?: () => void;
}

const inputClassName: string =
  "w-full rounded-[6px] border border-border bg-app px-[10px] py-[8px] font-mono text-[12.5px] text-txt-body outline-none focus:border-border-strong";

export function SetupScreen({ initialLocations, onConfigured, onClose }: SetupScreenProps) {
  const [locations, setLocations] = useState<string[]>(
    initialLocations !== undefined && initialLocations.length > 0 ? initialLocations : [""]
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  const setLocationAt = (index: number, value: string): void => {
    setLocations((previousLocations) =>
      previousLocations.map((location, locationIndex) => (locationIndex === index ? value : location))
    );
  };

  const removeLocationAt = (index: number): void => {
    setLocations((previousLocations) => previousLocations.filter((_, locationIndex) => locationIndex !== index));
  };

  const addLocation = (): void => {
    setLocations((previousLocations) => [...previousLocations, ""]);
  };

  const handleSave = async (): Promise<void> => {
    const trimmedLocations: string[] = locations.map((location) => location.trim()).filter((location) => location !== "");
    if (trimmedLocations.length === 0 || saving) {
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    try {
      const savedConfig: DashboardConfig = await api.saveConfig({ locations: trimmedLocations });
      onConfigured(savedConfig);
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : "Unexpected error saving.");
      setSaving(false);
    }
  };

  const canSave: boolean = locations.some((location) => location.trim() !== "");

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex w-[480px] flex-col gap-[14px] rounded-[10px] border border-border bg-surface p-[24px]">
        <h1 className="text-[14px] font-semibold text-txt-bright">Locations</h1>
        <p className="text-[12px] leading-[1.5] text-txt-secondary">
          Each location is a folder where terminals open. You can open several instances in the same location at once;
          there is no per-folder limit.
        </p>

        <div className="flex flex-col gap-[8px]">
          {locations.map((location, index) => (
            <div key={index} className="flex items-center gap-[8px]">
              <input
                className={inputClassName}
                value={location}
                placeholder="/Users/your-user/projects/my-repo"
                autoFocus={index === 0}
                onChange={(event) => setLocationAt(index, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleSave();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => removeLocationAt(index)}
                disabled={locations.length === 1}
                title="Remove location"
                className="shrink-0 text-[13px] font-semibold text-txt-dim hover:text-diff-removed disabled:opacity-30"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addLocation}
          className="self-start text-[11px] font-semibold text-txt-dim hover:text-txt-secondary"
        >
          + Add location
        </button>

        {errorMessage !== null && <div className="text-[11.5px] text-diff-removed">{errorMessage}</div>}

        <div className="flex justify-end gap-[10px]">
          {onClose !== undefined && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-[6px] px-[18px] py-[9px] text-[12.5px] font-semibold text-txt-secondary hover:text-txt-body"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave || saving}
            className="rounded-[6px] bg-accent px-[18px] py-[9px] text-[12.5px] font-semibold text-on-accent disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
