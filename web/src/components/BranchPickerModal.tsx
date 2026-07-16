import { useState } from "react";
import type { BranchAction, LocationBranches } from "../types";
import { Modal } from "./Modal";
import { btnGhost, btnPrimary, inputClassName } from "../ui";

interface BranchPickerModalProps {
  branchInfo: LocationBranches;
  onConfirm: (action: BranchAction | null) => void;
  onClose: () => void;
}

type Selection = { kind: "existing"; branch: string } | { kind: "create"; branch: string };

export function BranchPickerModal({ branchInfo, onConfirm, onClose }: BranchPickerModalProps) {
  const [search, setSearch] = useState<string>("");
  const [selection, setSelection] = useState<Selection | null>(
    branchInfo.currentBranch !== null ? { kind: "existing", branch: branchInfo.currentBranch } : null
  );
  const [createBaseBranch, setCreateBaseBranch] = useState<string>(
    branchInfo.currentBranch ?? branchInfo.branches[0] ?? ""
  );

  const trimmedSearch: string = search.trim();
  const filteredBranches: string[] = branchInfo.branches.filter((branch) =>
    branch.toLowerCase().includes(trimmedSearch.toLowerCase())
  );
  const exactMatch: boolean = branchInfo.branches.includes(trimmedSearch);
  const showCreateRow: boolean = trimmedSearch !== "" && !exactMatch;

  const handleConfirm = (): void => {
    if (selection === null) {
      return;
    }
    if (selection.kind === "existing") {
      onConfirm(selection.branch === branchInfo.currentBranch ? null : { type: "checkout", branch: selection.branch });
    } else {
      onConfirm({ type: "create", branch: selection.branch, baseBranch: createBaseBranch });
    }
    onClose();
  };

  const confirmLabel: string =
    selection === null
      ? "Select a branch"
      : selection.kind === "create"
        ? `Create from ${createBaseBranch}`
        : `Use '${selection.branch}'`;

  return (
    <Modal title="Choose branch" onClose={onClose} widthClassName="w-[560px]">
      <input
        className={inputClassName}
        value={search}
        placeholder="Search branches..."
        autoFocus
        onChange={(event) => setSearch(event.target.value)}
      />

      <div className="flex max-h-[260px] flex-col gap-[2px] overflow-y-auto">
        {showCreateRow && (
          <button
            type="button"
            onClick={() => setSelection({ kind: "create", branch: trimmedSearch })}
            className={`flex items-center justify-between rounded-sm px-[9px] py-[8px] text-left font-mono text-[12.5px] ${
              selection?.kind === "create" && selection.branch === trimmedSearch
                ? "bg-accent-dim text-txt-bright"
                : "text-txt-body hover:bg-raised"
            }`}
          >
            Create '{trimmedSearch}'
          </button>
        )}
        {filteredBranches.map((branch) => (
          <button
            key={branch}
            type="button"
            onClick={() => setSelection({ kind: "existing", branch })}
            className={`flex items-center justify-between rounded-sm px-[9px] py-[8px] text-left font-mono text-[12.5px] ${
              selection?.kind === "existing" && selection.branch === branch
                ? "bg-accent-dim text-txt-bright"
                : "text-txt-body hover:bg-raised"
            }`}
          >
            <span>{branch}</span>
            {branch === branchInfo.currentBranch && (
              <span className="font-sans text-[10.5px] text-txt-dim">current, checked out</span>
            )}
          </button>
        ))}
      </div>

      {selection?.kind === "create" && (
        <div className="flex items-center gap-[8px] text-[11.5px] text-txt-body">
          <span className="text-txt-dim">from</span>
          <select
            className="rounded-sm border border-border-strong bg-app px-[8px] py-[6px] font-mono text-[11.5px] text-txt-body"
            value={createBaseBranch}
            onChange={(event) => setCreateBaseBranch(event.target.value)}
          >
            {branchInfo.branches.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="text-[11px] text-txt-dimmer">
        Checking out a different branch changes it in this folder before the instance launches.
      </div>

      <div className="flex justify-end gap-[10px]">
        <button type="button" onClick={onClose} className={btnGhost}>
          Cancel
        </button>
        <button type="button" onClick={handleConfirm} disabled={selection === null} className={btnPrimary}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
