import { useState } from "react";
import { ApiError } from "../api";
import type { Instance, RestartResult } from "../types";
import { Modal } from "./Modal";
import { btnGhost, btnPrimary, errorTextClassName } from "../ui";

interface RestartConfirmModalProps {
  instance: Instance;
  onConfirm: () => Promise<RestartResult>;
  onClose: () => void;
}

const AUTO_MODE_TEXT: Record<RestartResult["autoMode"], string | null> = {
  "not-applicable": null,
  on: "Auto mode is on again.",
  unconfirmed: "Auto mode could not be confirmed after the restart; check the footer.",
};

export function RestartConfirmModal({ instance, onConfirm, onClose }: RestartConfirmModalProps) {
  const [restarting, setRestarting] = useState<boolean>(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  // The relaunch was already typed: the session may still come up, so this is not a failure.
  const [restartWarning, setRestartWarning] = useState<string | null>(null);
  const [restartResult, setRestartResult] = useState<RestartResult | null>(null);

  const handleConfirm = async (): Promise<void> => {
    if (restarting) {
      return;
    }
    setRestarting(true);
    setRestartError(null);
    setRestartWarning(null);
    try {
      setRestartResult(await onConfirm());
    } catch (error) {
      const message: string = error instanceof ApiError ? error.message : "Could not restart the session.";
      if (error instanceof ApiError && error.relaunchSent) {
        setRestartWarning(message);
      } else {
        setRestartError(message);
      }
    } finally {
      setRestarting(false);
    }
  };

  const finished: boolean = restartResult !== null || restartWarning !== null;

  return (
    <Modal title="Restart session" onClose={onClose}>
      {restartResult !== null ? (
        <div className="flex flex-col gap-[6px] text-[12.5px] leading-[1.5] text-txt-body">
          <p>
            <strong className="text-txt-bright">{instance.label}</strong> was restarted and resumed its conversation.
          </p>
          {(restartResult.versionBefore !== null || restartResult.versionAfter !== null) && (
            <p>
              Version: <span className="font-mono">{restartResult.versionBefore ?? "unknown"}</span> to{" "}
              <span className="font-mono">{restartResult.versionAfter ?? "unknown"}</span>
            </p>
          )}
          {AUTO_MODE_TEXT[restartResult.autoMode] !== null && <p>{AUTO_MODE_TEXT[restartResult.autoMode]}</p>}
          {restartResult.commandSource !== "process" && (
            <p className="text-status-warn">The launch flags were rebuilt, so they may differ from the original ones.</p>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] leading-[1.5] text-txt-body">
          This ends the running process of <strong className="text-txt-bright">{instance.label}</strong> and starts it again,
          keeping the conversation. A draft typed in the prompt blocks the restart, so clear it first.
        </p>
      )}

      {restartWarning !== null && <div className="text-[11px] text-status-warn">{restartWarning}</div>}
      {restartError !== null && <div className={errorTextClassName}>{restartError}</div>}

      <div className="flex justify-end gap-[10px]">
        {finished ? (
          <button type="button" onClick={onClose} className={btnGhost}>
            Close
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} className={btnGhost}>
              Cancel
            </button>
            <button type="button" onClick={() => void handleConfirm()} disabled={restarting} className={btnPrimary}>
              {restarting ? "Restarting..." : "Restart"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
