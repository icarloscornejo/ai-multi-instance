import { useState } from "react";
import type { ChangelogEntry } from "../types";
import { Modal } from "./Modal";
import { btnDanger, btnGhost } from "../ui";

interface ResetConfirmModalProps {
  localOnlyCommits: ChangelogEntry[];
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ResetConfirmModal({ localOnlyCommits, onConfirm, onClose }: ResetConfirmModalProps) {
  const [resetting, setResetting] = useState<boolean>(false);

  const handleConfirm = async (): Promise<void> => {
    if (resetting) {
      return;
    }
    setResetting(true);
    try {
      await onConfirm();
    } finally {
      setResetting(false);
    }
  };

  return (
    <Modal title="Reset to origin/main" onClose={onClose}>
      <p className="text-[12.5px] leading-[1.5] text-txt-body">
        Local history diverges from <span className="font-mono">origin/main</span> with real content not on the
        remote. The following {localOnlyCommits.length === 1 ? "commit" : "commits"} will be discarded:
      </p>

      <div className="max-h-[170px] overflow-y-auto rounded-md border border-border">
        {localOnlyCommits.map((entry) => (
          <div key={entry.hash} className="flex gap-[10px] items-baseline border-b border-border px-[12px] py-[9px] last:border-b-0">
            <span className="shrink-0 font-mono text-[11.5px] text-txt-dim">{entry.shortHash}</span>
            <span className="text-[12px] text-txt-body">{entry.subject}</span>
          </div>
        ))}
      </div>

      <p className="text-[11.5px] leading-[1.5] text-txt-secondary">
        Before resetting, a local backup tag (<span className="font-mono">pre-reset-*</span>) is created at the
        current HEAD, so this can be undone with <span className="font-mono">git reset --hard &lt;tag&gt;</span>.
      </p>

      <div className="flex justify-end gap-[10px]">
        <button type="button" onClick={onClose} className={btnGhost}>
          Cancel
        </button>
        <button type="button" onClick={() => void handleConfirm()} disabled={resetting} className={btnDanger}>
          {resetting ? "Resetting..." : "Discard and reset"}
        </button>
      </div>
    </Modal>
  );
}
