import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { BranchAction, CreateInstancePayload, Instance, LocationBranches, LocationInfo } from "../types";
import { Modal } from "./Modal";
import { BranchPickerModal } from "./BranchPickerModal";
import { btnGhost, btnPrimary, errorTextClassName, fieldLabelClassName, hintTextClassName, inputClassName, inputErrorClassName } from "../ui";

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
  instances: Instance[];
  onCreate: (payload: CreateInstancePayload) => Promise<void>;
  onClose: () => void;
}

function describeBranch(branchInfo: LocationBranches, branchAction: BranchAction | null): string {
  if (branchAction !== null) {
    return branchAction.type === "create" ? `${branchAction.branch} (new)` : branchAction.branch;
  }
  return branchInfo.currentBranch ?? "";
}

export function NewInstanceModal({ instances, onCreate, onClose }: NewInstanceModalProps) {
  const [locations, setLocations] = useState<LocationInfo[] | null>(null);
  const [locationPath, setLocationPath] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [labelEditedManually, setLabelEditedManually] = useState<boolean>(false);
  const [command, setCommand] = useState<string>(DEFAULT_COMMAND);
  const [model, setModel] = useState<string>("opusplan");
  const [effort, setEffort] = useState<string>("high");
  const [shellOnly, setShellOnly] = useState<boolean>(false);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [branchInfo, setBranchInfo] = useState<LocationBranches | null>(null);
  const [branchAction, setBranchAction] = useState<BranchAction | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState<boolean>(false);

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

  useEffect(() => {
    setBranchAction(null);
    if (locationPath === "") {
      setBranchInfo(null);
      return;
    }
    api
      .getLocationBranches(locationPath)
      .then(setBranchInfo)
      .catch(() => setBranchInfo(null));
  }, [locationPath]);

  const handleLocationChange = (newLocationPath: string): void => {
    setLocationPath(newLocationPath);
    if (!labelEditedManually) {
      const matchingLocation: LocationInfo | undefined = (locations ?? []).find(
        (location) => location.path === newLocationPath
      );
      setLabel(matchingLocation?.folderName ?? "");
    }
  };

  const trimmedLabel: string = label.trim();
  const nameTaken: boolean = instances.some(
    (existing) => existing.locationPath === locationPath && existing.label === trimmedLabel
  );

  const handleSubmit = async (): Promise<void> => {
    if (locationPath.trim() === "" || trimmedLabel === "" || nameTaken || submitting) {
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onCreate({
        locationPath: locationPath.trim(),
        label: trimmedLabel,
        command: shellOnly ? undefined : command.trim() === "" ? undefined : command.trim(),
        model: shellOnly ? undefined : model === "" ? undefined : model,
        effort: shellOnly ? undefined : effort === "" ? undefined : effort,
        branchAction: branchAction ?? undefined,
        shellOnly: shellOnly || undefined,
      });
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : "Unexpected error creating the instance.");
      setSubmitting(false);
    }
  };

  const noLocations: boolean = locations !== null && locations.length === 0;

  return (
    <>
      <Modal title="New instance" onClose={onClose} widthClassName="w-[560px]">
        <div>
          <label className={fieldLabelClassName}>Location</label>
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
          {noLocations && <div className={hintTextClassName}>No locations configured. Add them from Settings.</div>}
        </div>

        {branchInfo?.isGitRepo === true && (
          <div>
            <label className={fieldLabelClassName}>Branch</label>
            <button
              type="button"
              onClick={() => setBranchPickerOpen(true)}
              className="flex w-full items-center justify-between rounded-sm border border-border-strong bg-app px-[10px] py-[9px]"
            >
              <span className="font-mono text-[12.5px] text-txt-bright">{describeBranch(branchInfo, branchAction)}</span>
              <span className="text-[11px] text-txt-dim">Change ⌄</span>
            </button>
          </div>
        )}
        {branchInfo?.isGitRepo === false && (
          <div className={hintTextClassName}>Not a git repository. The instance will launch without branch checkout.</div>
        )}

        <div>
          <label className={fieldLabelClassName}>Name</label>
          <input
            className={nameTaken ? inputErrorClassName : inputClassName}
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
          {nameTaken && <div className={errorTextClassName}>An instance named '{trimmedLabel}' is already running here</div>}
        </div>

        <label className="flex items-center gap-[8px] text-[12px] text-txt-body">
          <input type="checkbox" checked={shellOnly} onChange={(event) => setShellOnly(event.target.checked)} />
          Shell only, don't launch Claude
        </label>

        <div className="border-t border-border pt-[14px]">
          <button
            type="button"
            onClick={() => setAdvancedOpen((previous) => !previous)}
            className="flex w-full items-center justify-between text-[11.5px] font-semibold text-txt-secondary"
          >
            <span>Advanced launch options</span>
            <span className="text-txt-dim">{advancedOpen ? "⌃" : "⌄"}</span>
          </button>
          {advancedOpen && (
            <div className="mt-[12px] flex flex-col gap-[12px]">
              <div>
                <label className={fieldLabelClassName}>Claude binary</label>
                <input
                  className={inputClassName}
                  value={command}
                  placeholder={DEFAULT_COMMAND}
                  disabled={shellOnly}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleSubmit();
                    }
                  }}
                />
                <div className={hintTextClassName}>
                  Defaults to <span className="font-mono">claude</span>. Enter another binary name if you have one on
                  your PATH.
                </div>
              </div>
              <div className="flex gap-[10px]">
                <div className="flex-1">
                  <label className={fieldLabelClassName}>Model</label>
                  <select
                    className={inputClassName}
                    value={model}
                    disabled={shellOnly}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {MODEL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className={fieldLabelClassName}>Effort</label>
                  <select
                    className={inputClassName}
                    value={effort}
                    disabled={shellOnly}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    {EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>

        {errorMessage !== null && <div className={errorTextClassName}>{errorMessage}</div>}

        <div className="flex justify-end gap-[10px]">
          <button type="button" onClick={onClose} className={btnGhost}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={locationPath.trim() === "" || trimmedLabel === "" || nameTaken || submitting || noLocations}
            title={noLocations ? "No locations configured" : undefined}
            className={btnPrimary}
          >
            {submitting ? "Launching..." : "Launch"}
          </button>
        </div>
      </Modal>

      {branchPickerOpen && branchInfo !== null && (
        <BranchPickerModal
          branchInfo={branchInfo}
          onConfirm={setBranchAction}
          onClose={() => setBranchPickerOpen(false)}
        />
      )}
    </>
  );
}
