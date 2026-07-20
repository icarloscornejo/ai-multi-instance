import { Modal } from "./Modal";
import { btnGhost, btnPrimary } from "../ui";

interface ResumeSessionModalProps {
  label: string;
  onChoose: (resumeSession: boolean) => void;
  onClose: () => void;
}

export function ResumeSessionModal({ label, onChoose, onClose }: ResumeSessionModalProps) {
  return (
    <Modal title="Resume session?" onClose={onClose}>
      <p className="text-[12.5px] leading-[1.5] text-txt-body">
        There is a recent session for <strong className="text-txt-bright">{label}</strong> in this location. Resume
        it, or start a fresh conversation?
      </p>

      <div className="flex justify-end gap-[10px]">
        <button type="button" onClick={() => onChoose(false)} className={btnGhost}>
          Start new
        </button>
        <button type="button" onClick={() => onChoose(true)} className={btnPrimary}>
          Resume session
        </button>
      </div>
    </Modal>
  );
}
