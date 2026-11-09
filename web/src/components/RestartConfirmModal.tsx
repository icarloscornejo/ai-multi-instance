import type { Instance } from "../types";
import { Modal } from "./Modal";
import { btnGhost, btnPrimary } from "../ui";

interface RestartConfirmModalProps {
  instance: Instance;
  // Starts the restart in the background; the outcome shows as a notice, not in this dialog.
  onConfirm: () => void;
  onClose: () => void;
}

export function RestartConfirmModal({ instance, onConfirm, onClose }: RestartConfirmModalProps) {
  return (
    <Modal title="Restart session" onClose={onClose}>
      <p className="text-[12.5px] leading-[1.5] text-txt-body">
        This ends the running process of <strong className="text-txt-bright">{instance.label}</strong> and starts it again,
        keeping the conversation. A draft typed in the prompt blocks the restart, so clear it first.
      </p>

      <div className="flex justify-end gap-[10px]">
        <button type="button" onClick={onClose} className={btnGhost}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className={btnPrimary}>
          Restart
        </button>
      </div>
    </Modal>
  );
}
