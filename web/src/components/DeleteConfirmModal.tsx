import { useState } from "react";
import type { Instance } from "../types";
import { Modal } from "./Modal";

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
        The tmux session for this instance will be closed. The folder{" "}
        <span className="break-all font-mono">{instance.locationPath}</span> and its contents are untouched.
      </p>

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
          onClick={() => void handleConfirm()}
          disabled={deleting}
          className="rounded-[6px] bg-diff-removed px-[18px] py-[9px] text-[12.5px] font-semibold text-on-accent disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
