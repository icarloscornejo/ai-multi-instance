import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Root of the dashboard repo itself (not to be confused with the user's own project repo)
const dashboardRepoRoot: string = path.resolve(import.meta.dirname, "../..");

export type RestartKind = "none" | "auto" | "manual";

export interface ChangelogEntry {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
}

export interface UpdateStatus {
  startedAtCommit: string | null;
  currentCommit: string | null;
  remoteCommit: string | null;
  currentSubject: string | null;
  remoteSubject: string | null;
  changelog: ChangelogEntry[];
  updateAvailable: boolean;
  pendingRestart: boolean;
  restartKind: RestartKind;
  blockedReason: string | null;
  lastCheckAt: string | null;
  lastError: string | null;
}

const status: UpdateStatus = {
  startedAtCommit: null,
  currentCommit: null,
  remoteCommit: null,
  currentSubject: null,
  remoteSubject: null,
  changelog: [],
  updateAvailable: false,
  pendingRestart: false,
  restartKind: "none",
  blockedReason: null,
  lastCheckAt: null,
  lastError: null,
};

// tsx watch restarts the server automatically for changes under server/src, and vite
// hot-reloads web/src in the browser: those paths need no manual relaunch from the user.
// Any other path (package.json, root configs, vite.config, etc.) does require one.
function classifyRestartKind(changedPaths: string[]): RestartKind {
  if (changedPaths.length === 0) {
    return "none";
  }
  const needsManualRestart: boolean = changedPaths.some(
    (changedPath) => !changedPath.startsWith("server/src/") && !changedPath.startsWith("web/src/")
  );
  return needsManualRestart ? "manual" : "auto";
}

let updateInProgress = false;

async function runGit(gitArguments: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dashboardRepoRoot, ...gitArguments]);
  return stdout.trim();
}

async function isBehindRemote(): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
    return true;
  } catch {
    return false;
  }
}

async function getSubject(ref: string): Promise<string> {
  return runGit(["log", "-1", "--format=%s", ref]);
}

async function getChangelog(fromRef: string, toRef: string): Promise<ChangelogEntry[]> {
  const log: string = await runGit(["log", "--format=%H%x09%h%x09%ad%x09%s", "--date=short", `${fromRef}..${toRef}`]);
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const parts: string[] = line.split("\t");
      return {
        hash: parts[0],
        shortHash: parts[1],
        date: parts[2],
        // %s could itself contain a tab; keep everything past the third field
        subject: parts.slice(3).join("\t"),
      };
    });
}

async function refreshRestartStatus(currentCommit: string): Promise<void> {
  // The running process is behind the code on disk: a relaunch is needed
  status.pendingRestart = status.startedAtCommit !== null && currentCommit !== status.startedAtCommit;
  status.restartKind = status.pendingRestart
    ? classifyRestartKind(
        (await runGit(["diff", "--name-only", status.startedAtCommit as string, currentCommit]))
          .split("\n")
          .filter((changedPath) => changedPath !== "")
      )
    : "none";
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status };
}

// Triggered on demand from the UI: fetches origin/main, compares against HEAD, and
// reports the incoming changelog without applying anything
export async function checkForUpdate(): Promise<UpdateStatus> {
  if (updateInProgress) {
    return getUpdateStatus();
  }
  updateInProgress = true;
  try {
    if (status.startedAtCommit === null) {
      status.startedAtCommit = await runGit(["rev-parse", "HEAD"]);
    }
    await runGit(["fetch", "--quiet", "origin", "main"]);
    const remoteCommit: string = await runGit(["rev-parse", "origin/main"]);
    const currentCommit: string = await runGit(["rev-parse", "HEAD"]);
    status.currentCommit = currentCommit;
    status.remoteCommit = remoteCommit;
    status.currentSubject = await getSubject(currentCommit);
    status.remoteSubject = await getSubject(remoteCommit);

    if (currentCommit !== remoteCommit) {
      const behindRemote: boolean = await isBehindRemote();
      status.updateAvailable = behindRemote;
      status.blockedReason = behindRemote ? null : "Local history diverges from origin/main. Update manually.";
      status.changelog = behindRemote ? await getChangelog(currentCommit, remoteCommit) : [];
    } else {
      status.updateAvailable = false;
      status.blockedReason = null;
      status.changelog = [];
    }

    await refreshRestartStatus(currentCommit);
    status.lastError = null;
  } catch (error) {
    status.lastError = (error as Error).message;
  } finally {
    status.lastCheckAt = new Date().toISOString();
    updateInProgress = false;
  }
  return getUpdateStatus();
}

// Applies an update previously reported by checkForUpdate: fast-forwards onto
// origin/main and syncs dependencies, but only if the repo is behind and clean
export async function applyUpdate(): Promise<UpdateStatus> {
  if (updateInProgress) {
    return getUpdateStatus();
  }
  updateInProgress = true;
  try {
    await runGit(["fetch", "--quiet", "origin", "main"]);
    const remoteCommit: string = await runGit(["rev-parse", "origin/main"]);
    let currentCommit: string = await runGit(["rev-parse", "HEAD"]);
    status.remoteCommit = remoteCommit;

    if (currentCommit !== remoteCommit) {
      const behindRemote: boolean = await isBehindRemote();
      // npm install regenerates package-lock metadata depending on the npm version;
      // that local noise is not a user change and must not block updates
      await runGit(["checkout", "--", "package-lock.json"]).catch(() => undefined);
      const workingTreeClean: boolean = (await runGit(["status", "--porcelain"])) === "";
      if (behindRemote && workingTreeClean) {
        // Fast-forward only: never overwrite local commits or uncommitted changes
        await runGit(["merge", "--ff-only", "origin/main"]);
        // The update may have brought a new package-lock: sync dependencies
        await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dashboardRepoRoot });
        // Discard any churn that npm install may have left in the lockfile
        await runGit(["checkout", "--", "package-lock.json"]).catch(() => undefined);
        currentCommit = remoteCommit;
        status.blockedReason = null;
        status.changelog = [];
      } else {
        status.blockedReason = workingTreeClean
          ? "Local history diverges from origin/main. Update manually."
          : "There are uncommitted local changes in the dashboard folder.";
      }
    } else {
      status.blockedReason = null;
    }

    status.currentCommit = currentCommit;
    status.currentSubject = await getSubject(currentCommit);
    status.updateAvailable = currentCommit !== remoteCommit;
    await refreshRestartStatus(currentCommit);
    status.lastError = null;
  } catch (error) {
    status.lastError = (error as Error).message;
  } finally {
    status.lastCheckAt = new Date().toISOString();
    updateInProgress = false;
  }
  return getUpdateStatus();
}
