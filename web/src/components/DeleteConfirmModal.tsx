import { useEffect, useState } from "react";
import { api } from "../api";
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
  const [alive, setAlive] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getInstanceStatus(instance.id)
      .then((result) => {
        if (!cancelled) {
          setAlive(result.alive);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAlive(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [instance.id]);

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

      {alive === true && (
        <div className="flex gap-[8px] rounded-sm border border-diff-removed-border bg-diff-removed-dim px-[12px] py-[10px] text-[11.5px] leading-[1.45] text-txt-body">
          ⚠ Claude is currently running in this instance. Any unsaved output in the terminal will be lost.
        </div>
      )}

      <div className="flex justify-end gap-[10px]">
        <button type="button" onClick={onClose} className={btnGhost}>
          Cancel
        </button>
        <button type="button" onClick={() => void handleConfirm()} disabled={deleting} className={btnDanger}>
          {deleting ? "Deleting..." : alive === true ? "Delete anyway" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
