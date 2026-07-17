import { useState } from "react";
import type { Instance } from "../types";
import { Modal } from "./Modal";
import { btnDanger, btnGhost } from "../ui";

interface DeleteConfirmModalProps {
  instance: Instance;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function DeleteConfirmModal({ instance, onConfirm, onClose }: DeleteConfirmModalProps) {
  const [deleting, setDeleting] = useState<boolean>(false);

  const handleConfirm = async (): Promise<void> => {
    if (deleting) {
      return;
    }
    setDeleting(true);
    try {
      await onConfirm();
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
