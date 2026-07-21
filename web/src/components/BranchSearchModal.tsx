import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type { LocationInfo } from "../types";
import { Modal } from "./Modal";
import { btnGhost, inputClassName } from "../ui";

interface SourceSelection {
  location: LocationInfo;
  branch: string | null;
  currentBranch: string | null;
  isGitRepo: boolean;
}

interface ChooseSourceModalProps {
  locations: LocationInfo[];
  onSelect: (selection: SourceSelection) => void;
  onClose: () => void;
}

interface LocationEntry {
  location: LocationInfo;
  isGitRepo: boolean;
  branches: string[];
  currentBranch: string | null;
}

function highlightMatch(text: string, query: string) {
  if (query === "") {
    return text;
  }
  const index: number = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    return text;
  }
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[2px] bg-accent/30 text-inherit">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

export function BranchSearchModal({ locations, onSelect, onClose }: ChooseSourceModalProps) {
  const [search, setSearch] = useState<string>("");
  const [entries, setEntries] = useState<LocationEntry[] | null>(null);

  useEffect(() => {
    let disposed: boolean = false;
    Promise.all(
      locations.map((location) =>
        api
          .getLocationBranches(location.path)
          .then((info) => ({
            location,
            isGitRepo: info.isGitRepo,
            branches: info.branches,
            currentBranch: info.currentBranch,
          }))
          .catch(() => ({ location, isGitRepo: false, branches: [], currentBranch: null }))
      )
    ).then((results) => {
      if (!disposed) {
        setEntries(results);
      }
    });
    return () => {
      disposed = true;
    };
  }, [locations]);

  const trimmedSearch: string = search.trim();

  const selectBranch = (location: LocationInfo, branch: string, currentBranch: string | null): void => {
    onSelect({ location, branch, currentBranch, isGitRepo: true });
    onClose();
  };

  const selectNonGit = (location: LocationInfo): void => {
    onSelect({ location, branch: null, currentBranch: null, isGitRepo: false });
    onClose();
  };

  const visibleEntries: (LocationEntry & { matchingBranches: string[] })[] =
    entries?.map((entry) => {
      const projectMatches: boolean = entry.location.folderName.toLowerCase().includes(trimmedSearch.toLowerCase());
      return {
        ...entry,
        matchingBranches: projectMatches
          ? entry.branches
          : entry.branches.filter((branch) => branch.toLowerCase().includes(trimmedSearch.toLowerCase())),
      };
    }) ?? [];

  const filteredEntries = visibleEntries.filter((entry) => {
    if (trimmedSearch === "") {
      return true;
    }
    if (entry.isGitRepo) {
      return entry.matchingBranches.length > 0;
    }
    return entry.location.folderName.toLowerCase().includes(trimmedSearch.toLowerCase());
  });

  return (
    <Modal title="Choose source" onClose={onClose} widthClassName="w-[560px]">
      <div className="relative">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute left-[10px] top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-txt-dim"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          className={`${inputClassName} pl-[30px]`}
          value={search}
          placeholder="Search or browse..."
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {entries === null && (
        <div className="text-[11.5px] text-txt-dimmer">Searching branches in {locations.length} locations...</div>
      )}

      {entries !== null && (
        <div className="max-h-[480px] overflow-y-auto rounded-sm border border-border bg-app p-[4px]">
          {filteredEntries.map((entry) => (
            <Fragment key={entry.location.path}>
              {entry.isGitRepo ? (
                <>
                  <button
                    type="button"
                    onClick={() => selectBranch(entry.location, entry.currentBranch ?? entry.branches[0], entry.currentBranch)}
                    disabled={entry.currentBranch === null && entry.branches.length === 0}
                    className="flex w-full items-center gap-[5px] rounded-[5px] px-[8px] pb-[2px] pt-[6px] text-left text-[11px] font-bold text-txt-secondary hover:bg-accent-dim hover:text-txt-bright disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-txt-secondary"
                  >
                    ▾ {entry.location.folderName}
                  </button>
                  {(trimmedSearch === "" ? entry.branches : entry.matchingBranches).map((branch) => {
                    const isCurrent: boolean = branch === entry.currentBranch;
                    return (
                      <button
                        key={branch}
                        type="button"
                        onClick={() => selectBranch(entry.location, branch, entry.currentBranch)}
                        className="flex w-full items-center justify-between gap-[8px] rounded-[5px] px-[8px] py-[5px] pl-[22px] text-left font-mono text-[12px] text-txt-body hover:bg-accent-dim hover:text-txt-bright"
                      >
                        <span>{highlightMatch(branch, trimmedSearch)}</span>
                        {isCurrent && (
                          <span className="shrink-0 whitespace-nowrap rounded-full bg-raised-2 px-[6px] py-[2px] font-sans text-[9.5px] font-bold uppercase tracking-[.03em] text-txt-secondary">
                            Checked out
                          </span>
                        )}
                      </button>
                    );
                  })}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => selectNonGit(entry.location)}
                  className="group flex w-full flex-col items-start gap-0 rounded-[5px] px-0 py-0 text-left hover:bg-accent-dim"
                >
                  <span className="px-[8px] pb-[2px] pt-[6px] text-[11px] font-bold text-txt-secondary group-hover:text-txt-bright">
                    ▸ {highlightMatch(entry.location.folderName, trimmedSearch)}
                  </span>
                  <span className="px-[8px] pb-[5px] pl-[22px] text-[12px] font-normal italic text-txt-dimmer group-hover:text-txt-secondary">
                    not a git repo, click to use as-is
                  </span>
                </button>
              )}
            </Fragment>
          ))}
          {entries.length > 0 && filteredEntries.length === 0 && (
            <div className="flex flex-col items-center gap-[10px] px-[16px] py-[34px] text-center">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-[30px] w-[30px] text-txt-dimmer"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <div className="text-[12.5px] font-semibold text-txt-secondary">
                No branches match &quot;{trimmedSearch}&quot;
              </div>
              <div className="text-[11px] leading-[1.5] text-txt-dimmer">
                Try a different name, or check the location list still has the repo you're looking for.
              </div>
            </div>
          )}
          {entries.length === 0 && (
            <div className="px-[9px] py-[8px] text-[11.5px] text-txt-dimmer">No locations configured</div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-[10px]">
        <button type="button" onClick={onClose} className={btnGhost}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

export type { SourceSelection };
