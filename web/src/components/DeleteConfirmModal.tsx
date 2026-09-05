import { useState } from "react";
import { ApiError } from "../api";
import type { Instance } from "../types";
import { Modal } from "./Modal";
import { btnDanger, btnGhost, errorTextClassName } from "../ui";

interface DeleteConfirmModalProps {
  instance: Instance;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function DeleteConfirmModal({ instance, onConfirm, onClose }: DeleteConfirmModalProps) {
  const [deleting, setDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleConfirm = async (): Promise<void> => {
    if (deleting) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await onConfirm();
    } catch (error) {
      // A 409 lands here when the server could not confirm the tmux session actually died
      // (routes.ts's DELETE handler) - the instance was deliberately left in the registry, so
      // the modal must stay open and say why, instead of the confirmDelete caller silently
      // swallowing it as an unhandled rejection (see App.tsx's confirmDelete).
      setDeleteError(error instanceof ApiError ? error.message : "Could not delete the instance.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal title="Delete instance" onClose={onClose}>
      <p className="text-[12.5px] leading-[1.5] text-txt-body">
        The tmux session for <strong className="text-txt-bright">{instance.label}</strong> will be closed. The folder{" "}
        <span className="break-all font-mono">{instance.locationPath}</span> and its contents are untouched.
      </p>

      {deleteError !== null && <div className={errorTextClassName}>{deleteError}</div>}

      <div className="flex justify-end gap-[10px]">
        <button type="button" onClick={onClose} className={btnGhost}>
          Cancel
        </button>
        <button type="button" onClick={() => void handleConfirm()} disabled={deleting} className={btnDanger}>
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
