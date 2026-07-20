import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { AgentProvider, BranchAction, CreateInstancePayload, Instance, LocationBranches, LocationInfo } from "../types";
import { Modal } from "./Modal";
import { BranchPickerModal } from "./BranchPickerModal";
import { ResumeSessionModal } from "./ResumeSessionModal";
import { btnGhost, btnPrimary, errorTextClassName, fieldLabelClassName, hintTextClassName, inputClassName, inputErrorClassName } from "../ui";
import { previewCommand, PROVIDER_OPTIONS } from "../providerOptions";

const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

interface NewInstanceModalProps {
  instances: Instance[];
  enabledProviders: AgentProvider[];
  onCreate: (payload: CreateInstancePayload) => Promise<void>;
  onClose: () => void;
}

function describeBranch(branchInfo: LocationBranches, branchAction: BranchAction | null): string {
  if (branchAction !== null) {
    return branchAction.type === "create" ? `${branchAction.branch} (new)` : branchAction.branch;
  }
  return branchInfo.currentBranch ?? "";
}

export function NewInstanceModal({ instances, enabledProviders, onCreate, onClose }: NewInstanceModalProps) {
  const visibleProviders = PROVIDER_OPTIONS.filter((option) => enabledProviders.includes(option.value));
  const initialProvider: AgentProvider = enabledProviders[0] ?? "claude";

  const [locations, setLocations] = useState<LocationInfo[] | null>(null);
  const [locationPath, setLocationPath] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [labelEditedManually, setLabelEditedManually] = useState<boolean>(false);
  const [provider, setProvider] = useState<AgentProvider>(initialProvider);
  const [command, setCommand] = useState<string>(
    PROVIDER_OPTIONS.find((option) => option.value === initialProvider)?.command ?? ""
  );
  const [model, setModel] = useState<string>(initialProvider === "claude" ? "opusplan" : "");
  const [effort, setEffort] = useState<string>(initialProvider === "claude" ? "high" : "");
  const [shellOnly, setShellOnly] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [branchInfo, setBranchInfo] = useState<LocationBranches | null>(null);
  const [branchAction, setBranchAction] = useState<BranchAction | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState<boolean>(false);
  const [resumePromptOpen, setResumePromptOpen] = useState<boolean>(false);

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

  const launchInstance = async (resumeSession?: boolean): Promise<void> => {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onCreate({
        locationPath: locationPath.trim(),
        label: trimmedLabel,
        provider,
        command: shellOnly ? undefined : command.trim() === "" ? undefined : command.trim(),
        model: shellOnly ? undefined : model === "" ? undefined : model,
        effort: shellOnly ? undefined : effort === "" ? undefined : effort,
        branchAction: branchAction ?? undefined,
        shellOnly: shellOnly || undefined,
        resumeSession,
      });
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : "Unexpected error creating the instance.");
      setSubmitting(false);
    }
  };

  const handleResumeChoice = (resumeSession: boolean): void => {
    setResumePromptOpen(false);
    void launchInstance(resumeSession);
  };

  const handleSubmit = async (): Promise<void> => {
    if (
      locationPath.trim() === "" ||
      trimmedLabel === "" ||
      nameTaken ||
      submitting ||
      (!shellOnly && command.trim() === "")
    ) {
      return;
    }
    if (shellOnly) {
      await launchInstance();
      return;
    }
    setSubmitting(true);
    try {
      const { hasSession } = await api.getResumableSession(provider, locationPath.trim(), trimmedLabel);
      if (hasSession) {
        setSubmitting(false);
        setResumePromptOpen(true);
        return;
      }
    } catch {
      // Couldn't check for a resumable session; fall through and launch fresh as usual
    }
    await launchInstance();
  };

  const noLocations: boolean = locations !== null && locations.length === 0;
  const providerLabel: string = PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;
  const launchPreview: string = shellOnly ? "(shell only)" : previewCommand(provider, command, model, effort);

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

        {visibleProviders.length > 1 && (
          <div>
            <label className={fieldLabelClassName}>Agent</label>
            <div className="grid grid-cols-2 gap-[8px]">
              {visibleProviders.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={shellOnly}
                  onClick={() => {
                    setProvider(option.value);
                    setCommand(option.command);
                    setModel(option.value === "claude" ? "opusplan" : "");
                    setEffort(option.value === "claude" ? "high" : "");
                  }}
                  className={`rounded-sm border px-[10px] py-[9px] text-left text-[12px] ${
                    provider === option.value
                      ? "border-accent bg-accent/10 font-semibold text-txt-bright"
                      : "border-border-strong bg-app text-txt-secondary hover:bg-raised"
                  } disabled:opacity-40`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="flex items-center gap-[8px] text-[12px] text-txt-body">
          <input type="checkbox" checked={shellOnly} onChange={(event) => setShellOnly(event.target.checked)} />
          Open shell only
        </label>

        {!shellOnly && (
          <div className="border-t border-border pt-[14px]">
            <div className="text-[11.5px] font-semibold text-txt-secondary">Advanced launch options</div>
            <div className="mt-[12px] flex flex-col gap-[12px]">
              <div>
                <label className={fieldLabelClassName}>{provider === "custom" ? "Command" : `${providerLabel} executable`}</label>
                <input
                  className={inputClassName}
                  value={command}
                  placeholder={provider === "custom" ? "your-cli --interactive" : PROVIDER_OPTIONS.find((option) => option.value === provider)?.command}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleSubmit();
                    }
                  }}
                />
                <div className={hintTextClassName}>
                  {provider === "custom"
                    ? "Executed exactly as entered; AI Multi-Instance will not add flags."
                    : "Use an executable name from PATH or an absolute path."}
                </div>
              </div>
              {provider !== "custom" && <div className="flex gap-[10px]">
                <div className="flex-1">
                  <label className={fieldLabelClassName}>Model</label>
                  <input
                    className={inputClassName}
                    value={model}
                    placeholder="Inherit from CLI config"
                    onChange={(event) => setModel(event.target.value)}
                  />
                </div>
                {provider === "claude" && <div className="flex-1">
                  <label className={fieldLabelClassName}>Effort</label>
                  <select
                    className={inputClassName}
                    value={effort}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    {EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>}
              </div>}
              <div>
                <label className={fieldLabelClassName}>Launch preview</label>
                <div className="break-all rounded-sm bg-raised px-[10px] py-[8px] font-mono text-[11px] text-txt-secondary">
                  {launchPreview}
                </div>
              </div>
            </div>
          </div>
        )}

        {errorMessage !== null && <div className={errorTextClassName}>{errorMessage}</div>}

        <div className="flex justify-end gap-[10px]">
          <button type="button" onClick={onClose} className={btnGhost}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              locationPath.trim() === "" ||
              trimmedLabel === "" ||
              nameTaken ||
              submitting ||
              noLocations ||
              (!shellOnly && command.trim() === "")
            }
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

      {resumePromptOpen && (
        <ResumeSessionModal
          label={trimmedLabel}
          onChoose={handleResumeChoice}
          onClose={() => setResumePromptOpen(false)}
        />
      )}
    </>
  );
}
