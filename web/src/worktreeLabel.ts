import type { Instance } from "./types";

export interface WorktreeLabel {
  sourceName: string;
  branch: string;
}

// null for an instance that runs in its own folder, so callers render nothing for it.
export function worktreeLabel(instance: Instance): WorktreeLabel | null {
  if (instance.worktree === undefined) {
    return null;
  }
  const sourceName: string = instance.worktree.sourcePath.split("/").filter((segment) => segment !== "").pop() ?? instance.worktree.sourcePath;
  return { sourceName, branch: instance.worktree.branch };
}
