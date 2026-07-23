import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { LocationInfo, StaleBranchesResponse } from "../types";
import { Modal } from "./Modal";
import { btnDanger, btnGhost, errorTextClassName, hintTextClassName } from "../ui";

interface CleanupBranchesModalProps {
  location: LocationInfo;
  onClose: () => void;
  onDeleted: () => void;
}

export function CleanupBranchesModal({ location, onClose, onDeleted }: CleanupBranchesModalProps) {
  const [data, setData] = useState<StaleBranchesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [failedBranches, setFailedBranches] = useState<{ branch: string; error: string }[]>([]);

  useEffect(() => {
    let disposed: boolean = false;
    api
      .getStaleBranches(location.path)
      .then((response) => {
        if (disposed) {
          return;
        }
        setData(response);
      })
      .catch((error) => {
        if (!disposed) {
          setLoadError(error instanceof ApiError ? error.message : "Could not scan branches.");
        }
      });
    return () => {
      disposed = true;
    };
  }, [location.path]);

  const toggleBranch = (branch: string): void => {
    setSelected((current) => {
      const next: Set<string> = new Set(current);
      if (next.has(branch)) {
        next.delete(branch);
      } else {
        next.add(branch);
      }
      return next;
    });
  };

  const toggleSelectAll = (): void => {
    if (data === null) {
      return;
    }
    setSelected((current) =>
      current.size === data.candidates.length ? new Set() : new Set(data.candidates.map((candidate) => candidate.branch))
    );
  };

  const handleDelete = async (): Promise<void> => {
    if (selected.size === 0) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    setFailedBranches([]);
    try {
      const result = await api.deleteStaleBranches(location.path, Array.from(selected));
      if (result.failed.length > 0) {
        setFailedBranches(result.failed);
      }
      if (result.deleted.length > 0) {
        onDeleted();
      }
      if (result.failed.length === 0) {
        onClose();
        return;
      }
      const deletedSet: Set<string> = new Set(result.deleted);
      setData((current) =>
        current === null
          ? current
          : { ...current, candidates: current.candidates.filter((candidate) => !deletedSet.has(candidate.branch)) }
      );
      setSelected((current) => new Set(Array.from(current).filter((branch) => !deletedSet.has(branch))));
    } catch (error) {
      setDeleteError(error instanceof ApiError ? error.message : "Could not delete the selected branches.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal title={`Clean up · ${location.folderName}`} onClose={onClose} widthClassName="w-[480px]">
      {loadError !== null && <div className={errorTextClassName}>{loadError}</div>}

      {loadError === null && data === null && (
        <div className="text-[11.5px] text-txt-dimmer">Loading branches...</div>
      )}

      {data !== null && !data.isGitRepo && (
        <div className="text-[11.5px] text-txt-dimmer">Not a git repository.</div>
      )}

      {data !== null && data.isGitRepo && (
        <>
          <div className={hintTextClassName}>
            Pick any branch to delete. main/master/develop/dev are never shown here.
          </div>

          {data.candidates.length === 0 ? (
            <div className="text-[11.5px] text-txt-dimmer">No other local branches here.</div>
          ) : (
            <div className="flex flex-col gap-[2px] rounded-sm border border-border bg-app p-[6px]">
              <label className="flex items-center gap-[8px] px-[6px] py-[4px] text-[11.5px] font-semibold text-txt-secondary">
                <input
                  type="checkbox"
                  checked={selected.size === data.candidates.length}
                  onChange={toggleSelectAll}
                />
                Select all ({data.candidates.length})
              </label>
              {data.candidates.map((candidate) => (
                <label
                  key={candidate.branch}
                  className="flex items-center justify-between gap-[8px] rounded-[5px] px-[6px] py-[5px] hover:bg-raised"
                >
                  <span className="flex items-center gap-[8px]">
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.branch)}
                      onChange={() => toggleBranch(candidate.branch)}
                    />
                    <span className="font-mono text-[12px] text-txt-body">{candidate.branch}</span>
                    {candidate.branch === data.currentBranch && (
                      <span
                        className="shrink-0 whitespace-nowrap rounded-full bg-raised-2 px-[6px] py-[2px] text-[9.5px] font-bold uppercase tracking-[.03em] text-txt-dimmer"
                        title="Checked out here. Deleting it will switch this location to main/master/develop/dev first."
                      >
                        current
                      </span>
                    )}
                    {candidate.worktreePath !== undefined && (
                      <span
                        className="shrink-0 whitespace-nowrap rounded-full bg-raised-2 px-[6px] py-[2px] text-[9.5px] font-bold uppercase tracking-[.03em] text-diff-removed"
                        title={`Checked out in another worktree at ${candidate.worktreePath}. Deleting it will remove that worktree folder, including any uncommitted changes in it.`}
                      >
                        worktree
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}

          {failedBranches.length > 0 && (
            <div className={errorTextClassName}>
              Failed to delete: {failedBranches.map((failure) => failure.branch).join(", ")}
            </div>
          )}
          {deleteError !== null && <div className={errorTextClassName}>{deleteError}</div>}

          <div className="flex justify-end gap-[10px]">
            <button type="button" onClick={onClose} className={btnGhost}>
              Close
            </button>
            {data.candidates.length > 0 && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={selected.size === 0 || deleting}
                className={`${btnDanger} flex items-center gap-[7px]`}
              >
                {deleting && <span className="spinner spinner-on-accent h-[12px] w-[12px]" />}
                {deleting ? "Deleting..." : `Delete ${selected.size} branch${selected.size === 1 ? "" : "es"}`}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
