import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { CreateInstancePayload, LocationInfo } from "../types";
import { Modal } from "./Modal";

const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Inherit" },
  { value: "fable", label: "fable" },
  { value: "opus", label: "opus" },
  { value: "opusplan", label: "opusplan" },
  { value: "sonnet", label: "sonnet" },
  { value: "haiku", label: "haiku" },
];

const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

const DEFAULT_COMMAND = "claude";

interface NewInstanceModalProps {
  onCreate: (payload: CreateInstancePayload) => Promise<void>;
  onClose: () => void;
}

const inputClassName: string =
  "w-full rounded-[6px] border border-border bg-app px-[10px] py-[8px] font-mono text-[12.5px] text-txt-body outline-none focus:border-border-strong";

export function NewInstanceModal({ onCreate, onClose }: NewInstanceModalProps) {
  const [locations, setLocations] = useState<LocationInfo[] | null>(null);
  const [locationPath, setLocationPath] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [labelEditedManually, setLabelEditedManually] = useState<boolean>(false);
  const [command, setCommand] = useState<string>(DEFAULT_COMMAND);
  const [model, setModel] = useState<string>("opusplan");
  const [effort, setEffort] = useState<string>("high");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    api
      .listLocations()
      .then((loadedLocations) => {
        setLocations(loadedLocations);
        const firstLocation: LocationInfo | undefined = loadedLocations[0];
        setLocationPath(firstLocation?.path ?? "");
        if (!labelEditedManually) {
          setLabel(firstLocation?.folderName ?? "");
        }
      })
      .catch(() => setLocations([]));
  }, []);

  const handleLocationChange = (newLocationPath: string): void => {
    setLocationPath(newLocationPath);
    if (!labelEditedManually) {
      const matchingLocation: LocationInfo | undefined = (locations ?? []).find(
        (location) => location.path === newLocationPath
      );
      setLabel(matchingLocation?.folderName ?? "");
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (locationPath.trim() === "" || submitting) {
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onCreate({
        locationPath: locationPath.trim(),
        label: label.trim(),
        command: command.trim() === "" ? undefined : command.trim(),
        model: model === "" ? undefined : model,
        effort: effort === "" ? undefined : effort,
      });
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : "Unexpected error creating the instance.");
      setSubmitting(false);
    }
  };

  const noLocations: boolean = locations !== null && locations.length === 0;

  return (
    <Modal title="New instance" onClose={onClose}>
      <div>
        <label className="mb-[6px] block text-[11px] text-txt-dim">Location</label>
        <select
          className={inputClassName}
          value={locationPath}
          onChange={(event) => handleLocationChange(event.target.value)}
          disabled={locations === null || noLocations}
        >
          {(locations ?? []).map((location) => (
            <option key={location.path} value={location.path}>
              {location.folderName}
            </option>
          ))}
        </select>
        {noLocations && (
          <div className="mt-[5px] text-[10.5px] text-txt-dimmer">
            No locations configured. Add them from Settings.
          </div>
        )}
      </div>

      <div>
        <label className="mb-[6px] block text-[11px] text-txt-dim">Name</label>
        <input
          className={inputClassName}
          value={label}
          placeholder="instance-name"
          autoFocus
          onChange={(event) => {
            setLabel(event.target.value);
            setLabelEditedManually(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void handleSubmit();
            }
          }}
        />
      </div>

      <div>
        <label className="mb-[3px] block text-[11px] text-txt-dim">Claude</label>
        <div className="mb-[6px] text-[10.5px] text-txt-dimmer">
          Defaults to <span className="font-mono">claude</span>. If you have other Claude binaries on your PATH (e.g.{" "}
          <span className="font-mono">claude-work</span>, <span className="font-mono">claude-enterprise-1</span>), enter
          that name here.
        </div>
        <input
          className={inputClassName}
          value={command}
          placeholder={DEFAULT_COMMAND}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void handleSubmit();
            }
          }}
        />
      </div>

      <div className="flex gap-[12px] pt-[6px]">
        <div className="flex-1">
          <label className="mb-[6px] block text-[11px] text-txt-dim">Model (optional)</label>
          <select className={inputClassName} value={model} onChange={(event) => setModel(event.target.value)}>
            {MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="mb-[6px] block text-[11px] text-txt-dim">Effort (optional)</label>
          <select className={inputClassName} value={effort} onChange={(event) => setEffort(event.target.value)}>
            {EFFORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {errorMessage !== null && <div className="text-[11.5px] text-diff-removed">{errorMessage}</div>}

      <div className="flex justify-end gap-[10px]">
        <button
          type="button"
          onClick={onClose}
          className="rounded-[6px] px-[18px] py-[9px] text-[12.5px] font-semibold text-txt-secondary hover:text-txt-body"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={locationPath.trim() === "" || submitting || noLocations}
          title={noLocations ? "No locations configured" : undefined}
          className="rounded-[6px] bg-accent px-[18px] py-[9px] text-[12.5px] font-semibold text-on-accent disabled:opacity-50"
        >
          {submitting ? "Launching..." : "Launch"}
        </button>
      </div>
    </Modal>
  );
}
