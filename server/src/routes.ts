import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import {
  AUTH_COOKIE_NAME,
  checkPassword,
  isAuthEnabled,
  clearAllFailedLogins,
  isLoginLocked,
  isPasswordFromEnv,
  issueToken,
  issueTrustedDeviceToken,
  readCookie,
  recordFailedLogin,
  requireAuth,
  resetFailedLogins,
  rotateSecret,
  setStoredPassword,
  TRUSTED_DEVICE_COOKIE_NAME,
  verifyToken,
  verifyTrustedDeviceToken,
} from "./auth";
import { clearAgentReadiness, getReadyChannel } from "./agentReadiness";
import { isAgentProvider, PROVIDERS, sessionKeyFor } from "./providers";
import { pathExists } from "./paths";
import { PASTED_IMAGE_EXTENSIONS, savePastedImage } from "./pastedImages";
import { loadState, updateState } from "./store";
import { getPaneCurrentPath, getSessionPresence, killSession, signalChannel } from "./tmux";
import {
  branchUpstream,
  currentBranch,
  isRemoteUnreachableError,
  LOCAL_GIT_TIMEOUT_MS,
  NETWORK_GIT_TIMEOUT_MS,
  runGit,
  worktreeDirFor,
  type BranchUpstream,
} from "./git";
import { reviewRequestFor, type ReviewRequest } from "./reviewRequests";
import { claudeFallback, codexFallback, enrichCodexStatus, findCodexSessionFile } from "./agentFallback";
import {
  listSiblingSnapshots,
  ownedSessionIds,
  persistableSession,
  resolveLiveStatus,
  snapshotDirectory,
  type PersistableSession,
  type Snapshot,
} from "./liveStatus";
import type { PaneAgent } from "./paneAgent";
import { probePaneAgent, readAgentStateFile, resolveAgentStates } from "./agentState";
import { getPrEventsStatus } from "./prEventsPoller";
import { isValidGitlabHost, isValidTokenEnvName, normalizeGitlabHostKey } from "./prEventsGitlab";
import { LaunchProgress } from "./launchProgress";
import { initializeInstanceSession } from "./terminal";
import { withSessionLock } from "./sessionLock";
import { realRestartDeps } from "./restartDeps";
import { handleRestartRequest, restartClaudeSession } from "./sessionRestart";
import { getTunnelStatus, readTunnelLog, startTunnel, stopTunnel } from "./tunnel";
import { getNamedTunnelStatus, getTunnelMode, startNamedTunnel, stopNamedTunnel } from "./namedTunnel";
import { clientAddressOf, isLocalRequest, isLocalRequestHost } from "./requestHost";
import { applyUpdate, checkForUpdate, getUpdateStatus, resetToRemote } from "./updater";
import type {
  BranchAction,
  CreateInstancePayload,
  DashboardState,
  InstanceRecord,
  StaleBranchesResponse,
  UpdateInstancePayload,
} from "./types";

const DEFAULT_FONT_SIZE = 13;

const PASTED_IMAGE_TYPES: string[] = Object.keys(PASTED_IMAGE_EXTENSIONS);
const PASTED_IMAGE_DIRECTORY: string = path.resolve(import.meta.dirname, "../../data/pasted-images");
const parsePastedImageBytes = express.raw({ type: PASTED_IMAGE_TYPES, limit: "20mb" });

type AsyncHandler = (request: Request, response: Response) => Promise<void>;

// Express 4 no propaga errores de handlers async al middleware de errores
function wrapAsync(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}

// body-parser reports an oversized (413) or cut-off (400) upload as an error carrying a status,
// but the app-wide error handler in index.ts answers every error with 500. Answer with the
// parser's own status here instead, and leave that handler alone.
function readPastedImageBody(request: Request, response: Response, next: NextFunction): void {
  parsePastedImageBytes(request, response, (error?: unknown): void => {
    if (error === undefined) {
      next();
      return;
    }
    const status: unknown = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
    if (typeof status === "number" && status >= 400 && status < 500) {
      response.status(status).json({ error: error instanceof Error ? error.message : "Invalid image upload." });
      return;
    }
    next(error);
  });
}

// Thrown from inside a POST /instances updateState mutator when the commit-time revalidation
// (label+locationPath, id, or tmuxSession uniqueness) fails against the LATEST state - not the
// snapshot loaded at the top of the handler. That earlier snapshot only rejects the common
// case cheaply, before paying for git/tmux; this is the one that actually protects the
// invariant, since another request could have inserted a colliding instance in between. Thrown
// (rather than returned) so it propagates out of initializeInstanceSession's onSessionCreated
// hook while `launchMayHaveBeenApplied` is still false, which makes that function's own catch
// kill the tmux session it just created - the request must never succeed with an unregistered
// live session.
class InstanceCommitConflictError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Short backoff between DELETE's kill retries - not a network call, just giving a momentarily
// wedged tmux server (a slow filesystem, a busy socket) a couple of chances to clear before
// this gives up and refuses to touch the registry. Kept short: this runs inline in an HTTP
// response the user is waiting on.
const DELETE_KILL_RETRY_DELAYS_MS: readonly number[] = [300, 900];

// Picks a private IPv4 address other devices on the same LAN can reach (e.g. Wi-Fi at
// home): the first non-internal IPv4 in a standard private range, skipping VPN/virtual
// interfaces that don't route to the physical LAN.
function getLanUrl(): string | null {
  const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        (address.address.startsWith("192.168.") ||
          address.address.startsWith("10.") ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(address.address))
      ) {
        return `http://${address.address}`;
      }
    }
  }
  return null;
}

async function localBranches(cwd: string): Promise<string[]> {
  const stdout: string = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch !== "");
}

// Long-lived branches: never listed as deletable, and never candidates to switch off of
// when deleting the branch checked out in a location.
const PROTECTED_BRANCH_NAMES: string[] = ["main", "master", "develop", "dev"];

function isProtectedBranchName(branch: string): boolean {
  return PROTECTED_BRANCH_NAMES.includes(branch);
}

// First protected branch name that actually exists locally. Used only as a safe branch to
// switch to when deleting whatever is currently checked out in a location.
function localProtectedBranch(branches: string[]): string | null {
  return PROTECTED_BRANCH_NAMES.find((name) => branches.includes(name)) ?? null;
}

// git prints resolved paths while the registry may hold a symlinked one, so compare through
// realpath; a folder that no longer exists falls back to a lexical resolve.
async function resolvedPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    // A folder that no longer exists still sits under a real parent, which may itself be
    // reached through a symlink (macOS /var), so resolve the parent and keep the name.
    const absoluteTarget: string = path.resolve(target);
    try {
      return path.join(await fs.realpath(path.dirname(absoluteTarget)), path.basename(absoluteTarget));
    } catch {
      return absoluteTarget;
    }
  }
}

// Whether `inner` is `outer` itself or lives inside it.
function isSameOrInside(outer: string, inner: string): boolean {
  const relativePath: string = path.relative(outer, inner);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

// One lock for every operation that creates, switches or removes worktrees and branches
// (instance creation, stale-branch delete, instance-close cleanup), so none of them can run
// while another is between "decided" and "done". FIFO, built on the session lock. The holder
// gets a release function because a creation lets go as soon as the instance is persisted
// (agent boot stays parallel), not when its whole handler ends. Never take it inside an
// updateState mutator: creation waits on that queue while holding it.
// ponytail: one global lock serializes all worktree operations, fine for their low frequency; key it per repo if that ever hurts.
const WORKTREE_OPS_LOCK_KEY = "worktree-ops";

function acquireWorktreeOpsLock(): Promise<() => void> {
  return new Promise((resolve) => {
    void withSessionLock(
      WORKTREE_OPS_LOCK_KEY,
      () =>
        new Promise<void>((release) => {
          let released = false;
          resolve(() => {
            if (!released) {
              released = true;
              release();
            }
          });
        })
    );
  });
}

// `ls-files` and `status` on a big repo outgrow Node's 1 MiB default and the child is killed,
// which would read as "could not be checked" and keep every clean worktree forever.
const WORKTREE_CHECK_MAX_BUFFER_BYTES: number = 256 * 1024 * 1024;
const WORKTREE_LIST_CAP = 10;

function capList(items: string[]): string {
  const shown: string = items.slice(0, WORKTREE_LIST_CAP).join(", ");
  return items.length > WORKTREE_LIST_CAP ? `${shown} and ${items.length - WORKTREE_LIST_CAP} more` : shown;
}

function isFileSystemError(error: unknown, ...codes: string[]): boolean {
  return codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  locked: boolean;
  // The first porcelain entry is always the main working tree of the repository.
  isMain: boolean;
}

async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const stdout: string = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  for (const line of stdout.split("\n")) {
    const worktreeMatch: RegExpMatchArray | null = line.match(/^worktree (.+)$/);
    if (worktreeMatch) {
      entries.push({ path: worktreeMatch[1], branch: null, locked: false, isMain: entries.length === 0 });
      continue;
    }
    const latest: WorktreeEntry | undefined = entries[entries.length - 1];
    if (latest === undefined) continue;
    const branchMatch: RegExpMatchArray | null = line.match(/^branch refs\/heads\/(.+)$/);
    if (branchMatch) latest.branch = branchMatch[1];
    if (line === "locked" || line.startsWith("locked ")) latest.locked = true;
  }
  return entries;
}

// Removes a linked worktree without ever deleting anything git does not track. `git worktree
// remove` is not used on a live folder: it also deletes ignored files (.env, local config).
// Instead only tracked files are unlinked, empty parents are rmdir'ed, and the final rmdir
// fails by itself if anything else is there, so ignored and untracked files survive by
// construction. The registration is dropped only once the folder is gone. Returns null when
// the worktree is gone, else why it was kept. Never throws.
// ponytail: a tracked file edited, or a symlink swapped in, in the milliseconds between the
// checks and the unlink is lost (the committed version stays in git); a folder that reappears
// right after the missing check gets a plain `worktree remove`. Park the folder by rename and
// re-check if that ever matters.
async function removeWorktreeSafely(sourcePath: string, worktreeDir: string): Promise<string | null> {
  const keep = (reason: string): string => `The worktree ${worktreeDir} ${reason}, so it was kept.`;
  let deleting = false;
  let savedGitFile: string | null = null;
  try {
    // Only a registered, linked, unlocked worktree of this repository is ever touched.
    const canonicalDir: string = await resolvedPath(worktreeDir);
    const entries: WorktreeEntry[] = await listWorktrees(sourcePath);
    let entry: WorktreeEntry | undefined;
    for (const candidate of entries) {
      if ((await resolvedPath(candidate.path)) === canonicalDir) {
        entry = candidate;
        break;
      }
    }
    if (entry === undefined) return keep("is not a worktree of this repository");
    if (entry.isMain) return keep("is the main checkout");
    if (entry.locked) return keep("is locked");
    const registeredPath: string = entry.path;

    let folderPresent = true;
    try {
      await fs.lstat(worktreeDir);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      folderPresent = false;
    }
    if (!folderPresent) {
      // Dropping the registration also drops a detached HEAD's only reference to its commits.
      if (entry.branch === null) return keep("is missing and was on a detached HEAD, where commits would be lost");
      await runGit(sourcePath, ["worktree", "remove", "--", worktreeDir]);
      return null;
    }

    // The folder must still be this repository's worktree, not something put in its place.
    const identity: string[] = (
      await runGit(worktreeDir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"])
    ).split("\n");
    const sourceCommonDir: string = await runGit(sourcePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (
      (await resolvedPath(identity[0] ?? "")) !== canonicalDir ||
      (await resolvedPath(identity[1] ?? "")) !== (await resolvedPath(sourceCommonDir))
    ) {
      return keep("is no longer this repository's worktree");
    }

    // A detached HEAD (also a stopped rebase) holds commits no branch points at; dropping the
    // registration would drop them with it.
    try {
      await runGit(worktreeDir, ["symbolic-ref", "-q", "HEAD"]);
    } catch {
      return keep("has a detached HEAD (a rebase or a detached checkout), where commits would be lost");
    }

    // fsmonitor and the stat-tolerance settings can make `status` miss an edit, so pin them.
    const statusOutput: string = await runGit(
      worktreeDir,
      [
        "-c", "core.fsmonitor=false", "-c", "core.trustctime=true", "-c", "core.checkStat=default",
        "status", "--porcelain", "--untracked-files=normal", "--ignored=matching", "--ignore-submodules=none",
      ],
      LOCAL_GIT_TIMEOUT_MS,
      WORKTREE_CHECK_MAX_BUFFER_BYTES
    );
    const statusLines: string[] = statusOutput.split("\n").filter((line) => line !== "");
    const ignoredPaths: string[] = statusLines.filter((line) => line.startsWith("!! ")).map((line) => line.slice(3));
    const changedLines: string[] = statusLines.filter((line) => !line.startsWith("!! "));
    if (changedLines.length > 0 || ignoredPaths.length > 0) {
      const parts: string[] = [];
      if (changedLines.length > 0) parts.push("uncommitted changes");
      if (ignoredPaths.length > 0) parts.push(`ignored files (${capList(ignoredPaths)})`);
      return `The worktree ${worktreeDir} has ${parts.join(" and ")}, so it was kept. Remove it yourself when you are done with it.`;
    }

    // Edits git was told to ignore (skip-worktree, assume-unchanged) never show in `status`.
    const taggedOutput: string = await runGit(
      worktreeDir, ["ls-files", "-v", "-z"], LOCAL_GIT_TIMEOUT_MS, WORKTREE_CHECK_MAX_BUFFER_BYTES
    );
    const hiddenEditPaths: string[] = [];
    for (const record of taggedOutput.split("\0")) {
      const tag: string = record.slice(0, 1);
      const trackedPath: string = record.slice(2);
      if (trackedPath === "" || !(tag === "S" || (tag >= "a" && tag <= "z"))) continue;
      // Outside a sparse-checkout cone the file is absent, so there is nothing to lose.
      if (await fs.lstat(path.join(worktreeDir, trackedPath)).then(() => true, () => false)) {
        hiddenEditPaths.push(trackedPath);
      }
    }
    if (hiddenEditPaths.length > 0) {
      return keep(`has files git is told to ignore changes in (${capList(hiddenEditPaths)}) and may hold edits`);
    }

    const stagedOutput: string = await runGit(
      worktreeDir, ["ls-files", "-s", "-z"], LOCAL_GIT_TIMEOUT_MS, WORKTREE_CHECK_MAX_BUFFER_BYTES
    );
    const trackedFiles: string[] = [];
    for (const record of stagedOutput.split("\0")) {
      const tabIndex: number = record.indexOf("\t");
      if (tabIndex < 0) continue;
      if (record.startsWith("160000 ")) return keep("contains submodules; remove it by hand");
      const trackedFile: string = record.slice(tabIndex + 1);
      // Git never writes such paths; a hand-made index could, and unlink would leave the worktree.
      if (path.posix.isAbsolute(trackedFile) || trackedFile.split("/").some((part) => part === "" || part === "." || part === "..")) {
        return keep("has an unexpected tracked path");
      }
      trackedFiles.push(trackedFile);
    }
    const trackedSet: Set<string> = new Set(trackedFiles);
    const trackedDirectories: Set<string> = new Set();
    for (const trackedFile of trackedFiles) {
      for (let directory = path.posix.dirname(trackedFile); directory !== "."; directory = path.posix.dirname(directory)) {
        trackedDirectories.add(directory);
      }
    }

    // `status` never lists empty folders or a symlink standing where a folder was tracked, and
    // either would leave the worktree half emptied. Check everything on disk first.
    const extras: string[] = [];
    const walk = async (relativeDirectory: string): Promise<void> => {
      for (const dirent of await fs.readdir(path.join(worktreeDir, relativeDirectory), { withFileTypes: true })) {
        const relative: string = relativeDirectory === "" ? dirent.name : `${relativeDirectory}/${dirent.name}`;
        if (relativeDirectory === "" && dirent.name === ".git") continue;
        if (dirent.isDirectory()) {
          if (trackedDirectories.has(relative)) await walk(relative);
          else extras.push(`${relative}/`);
        } else if (!trackedSet.has(relative)) {
          extras.push(relative);
        }
      }
    };
    await walk("");
    if (extras.length > 0) {
      return keep(`has files or folders git does not track (${capList(extras)})`);
    }

    // From here on tracked files are deleted; any failure is reported as a partial removal.
    deleting = true;
    for (const trackedFile of trackedFiles) {
      try {
        await fs.unlink(path.join(worktreeDir, trackedFile));
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) throw error;
      }
    }
    const directoriesDeepestFirst: string[] = [...trackedDirectories].sort(
      (first, second) => second.split("/").length - first.split("/").length
    );
    for (const directory of directoriesDeepestFirst) {
      try {
        await fs.rmdir(path.join(worktreeDir, directory));
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT", "ENOTEMPTY")) throw error;
      }
    }
    // The gitlink file at the root is untracked, so it goes last and only if nothing else is left.
    try {
      const remaining: string[] = await fs.readdir(worktreeDir);
      if (remaining.length === 1 && remaining[0] === ".git") {
        const gitFile: string = path.join(worktreeDir, ".git");
        const content: string = await fs.readFile(gitFile, "utf8");
        if (content.startsWith("gitdir:")) {
          savedGitFile = content;
          await fs.unlink(gitFile);
        }
      }
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    let folderRemoved = false;
    try {
      await fs.rmdir(worktreeDir);
      folderRemoved = true;
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        folderRemoved = true;
      } else {
        throw error;
      }
    }
    if (folderRemoved) {
      try {
        await runGit(sourcePath, ["worktree", "remove", "--", worktreeDir]);
      } catch (error) {
        const stillListed: boolean = (await listWorktrees(sourcePath)).some(
          (candidate) => candidate.path === registeredPath
        );
        if (stillListed) {
          return `The worktree folder ${worktreeDir} was removed but git could not unregister it: ${(error as Error).message}`;
        }
      }
    }
    return null;
  } catch (error) {
    if (!deleting) {
      return `The worktree ${worktreeDir} could not be checked and was kept: ${(error as Error).message}`;
    }
    let repairNote = "";
    if (savedGitFile !== null) {
      try {
        await fs.writeFile(path.join(worktreeDir, ".git"), savedGitFile);
      } catch {
        repairNote = ' Its ".git" file could not be restored; run "git worktree repair" from the source repository.';
      }
    }
    let leftBehind = "";
    try {
      const left: string[] = (await fs.readdir(worktreeDir)).filter((name) => name !== ".git");
      leftBehind = left.length > 0 ? ` Left in the folder: ${capList(left)}.` : "";
    } catch {
      // The folder itself is gone; nothing to list.
    }
    return (
      `The worktree ${worktreeDir} was partially removed and kept (${(error as Error).message}). ` +
      `Its tracked files were deleted; restore them with "git restore ." inside it.${leftBehind}${repairNote}`
    );
  }
}

// Removes a worktree the dashboard created, only when nothing in it would be lost (never
// --force). Returns null when it was removed, else the reason it was kept, for the user.
async function removeWorktreeIfClean(
  worktreeDir: string,
  worktree: NonNullable<InstanceRecord["worktree"]>,
  shared: boolean
): Promise<string | null> {
  if (!worktree.created) {
    return `The worktree ${worktreeDir} existed before this instance, so it was kept.`;
  }
  if (shared) {
    return `The worktree ${worktreeDir} is still used by another instance, so it was kept.`;
  }
  return removeWorktreeSafely(worktree.sourcePath, worktreeDir);
}

// Branches checked out in *other* worktrees of this repo, mapped to that worktree's path so
// they can be offered for cleanup. Left out: the working tree of the location itself (found
// through git's own toplevel, not path text, so a symlinked location or one in a subfolder of
// the repo is recognised: its branch is handled like any other candidate so that a branch you
// happen to be sitting on can still be cleaned up) and the repository's main checkout, which
// is never removable.
async function branchesCheckedOutInWorktrees(cwd: string): Promise<Map<string, string>> {
  const ownTopLevel: string = await resolvedPath(await runGit(cwd, ["rev-parse", "--show-toplevel"]));
  const branches: Map<string, string> = new Map();
  for (const entry of await listWorktrees(cwd)) {
    if (entry.branch === null || entry.isMain || (await resolvedPath(entry.path)) === ownTopLevel) continue;
    branches.set(entry.branch, entry.path);
  }
  return branches;
}

// Every local branch except the protected long-lived ones (main/master/develop/dev): no
// merged/squash-merged check, you pick whatever you want to delete. Purely local git
// calls, no network fetch, so this is effectively instant.
async function findStaleBranches(cwd: string, instances: InstanceRecord[]): Promise<StaleBranchesResponse> {
  let branches: string[];
  let current: string | null;
  try {
    branches = await localBranches(cwd);
    current = await currentBranch(cwd);
  } catch {
    return { isGitRepo: false, currentBranch: null, candidates: [] };
  }

  const worktreeBranches: Map<string, string> = await branchesCheckedOutInWorktrees(cwd);
  // A worktree a registered instance works in, or in any folder under it, must never be
  // offered. The repository's main checkout is protected the same way when an instance lives
  // in it (it is never removable, but its branch should not be offered either).
  const instancePaths: string[] = await Promise.all(instances.map((instance) => resolvedPath(instance.locationPath)));
  const hasInstanceInside = async (folder: string): Promise<boolean> => {
    const resolvedFolder: string = await resolvedPath(folder);
    return instancePaths.some((instancePath) => isSameOrInside(resolvedFolder, instancePath));
  };
  const usedBranches: Set<string> = new Set();
  for (const [branch, worktreePath] of worktreeBranches) {
    if (await hasInstanceInside(worktreePath)) {
      usedBranches.add(branch);
    }
  }
  // The location's own working tree stays listed even with an instance in it: deleting its
  // branch is refused with a 409 by the delete route, which explains why.
  const ownTopLevel: string = await resolvedPath(await runGit(cwd, ["rev-parse", "--show-toplevel"]));
  for (const entry of await listWorktrees(cwd)) {
    if (
      entry.isMain &&
      entry.branch !== null &&
      (await resolvedPath(entry.path)) !== ownTopLevel &&
      (await hasInstanceInside(entry.path))
    ) {
      usedBranches.add(entry.branch);
    }
  }
  const candidates: { branch: string; worktreePath?: string }[] = branches
    .filter((branch) => !isProtectedBranchName(branch) && !usedBranches.has(branch))
    .map((branch) => {
      const worktreePath: string | undefined = worktreeBranches.get(branch);
      return worktreePath !== undefined ? { branch, worktreePath } : { branch };
    });

  return { isGitRepo: true, currentBranch: current, candidates };
}

function resolveLiveStatusSnapshotPath(instance: InstanceRecord): string {
  return path.join(snapshotDirectory(), `${instance.id}.json`);
}

async function readInstanceSnapshot(instance: InstanceRecord): Promise<Snapshot | null> {
  try {
    return JSON.parse(await fs.readFile(resolveLiveStatusSnapshotPath(instance), "utf8")) as Snapshot;
  } catch {
    // No statusLine snapshot yet for this directory (not configured, or Claude Code
    // hasn't redrawn its statusline here since this dashboard instance was launched)
    return null;
  }
}

async function readLiveSession(instance: InstanceRecord): Promise<PersistableSession | null> {
  return persistableSession(instance, await readInstanceSnapshot(instance), await probePaneAgent(instance));
}

async function writeSessionSnapshot(
  instance: InstanceRecord,
  sessionId: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const snapshotPath: string = resolveLiveStatusSnapshotPath(instance);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({
      provider: instance.provider,
      sessionId,
      cwd: instance.locationPath,
      model: instance.model ?? undefined,
      ...extra,
      updatedAt: new Date().toISOString(),
    }),
    "utf8"
  );
}

export const apiRouter: Router = express.Router();

// Fail closed at the public edge. In named-tunnel mode the cloudflared connector outlives this
// process, so if the password ever disappears (data/auth-password.json deleted, DASHBOARD_PASSWORD
// dropped from the launchd environment) while the connector is still up, isAuthEnabled() goes
// false and every route below - including the terminal API - would answer the public URL with no
// login at all. Reject those requests before they reach anything. Local and LAN paths are
// untouched, which is exactly where the user goes to set a password back. Registered before the
// /auth/* routes on purpose: from the public URL with no password, you cannot even set one - that
// has to be done locally.
apiRouter.use((request: Request, response: Response, next: NextFunction): void => {
  if (getTunnelMode() === "named" && !isAuthEnabled() && !isLocalRequestHost(request.headers.host)) {
    response.status(503).json({
      error: "This dashboard has no password set. Set one from the local network (ai.local) before using the public URL.",
    });
    return;
  }
  next();
});

// The tunnel controls (start/stop/status/logs) must never be usable through the public URL, even
// by an authenticated visitor: whoever finds that URL could otherwise tear down or spin up the
// tunnel, or read the connector log. The UI already hides these off ai.local (SetupScreen.tsx),
// this is the server-side backstop for that policy. Authentication stays a separate, additional
// requirement via requireAuth below. Also guards revoke-all, for the same reason: a stolen
// session must not be able to sign the owner out, and /update/apply and /update/reset, which can
// restart the server or discard local commits. It keys off isLocalRequest rather than the
// Host alone because the Quick Tunnel rewrites Host to ai.local (see requestHost.ts).
function requireLocalHost(request: Request, response: Response, next: NextFunction): void {
  if (!isLocalRequest(request)) {
    response.status(403).json({ error: "This action is only available on the local network." });
    return;
  }
  next();
}

// The auth cookie is bearer-equivalent and long-lived (~180 days). Mark it Secure whenever it is
// issued to the public hostname, so a browser will never send it back over plain HTTP to that
// host. ai.local and LAN access are plain HTTP by design (see Caddyfile) and must keep getting a
// non-Secure cookie, so this is conditional on the request, not unconditional. The decision uses
// isLocalRequest (Host plus cf-connecting-ip) because the Quick Tunnel rewrites Host to ai.local.
// It is not keyed to X-Forwarded-Proto because this app sets no `trust proxy`. A LAN client that
// forges cf-connecting-ip only gets a Secure cookie its browser will not store, which fails closed.
function authCookieOptions(request: Request, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !isLocalRequest(request),
    maxAge: maxAgeMs,
  };
}

function resolveHomePath(rawPath: string): string {
  return path.resolve(rawPath.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

// Registered before requireAuth below so the gate itself stays reachable
// without a cookie; every route after this line is protected.
apiRouter.post(
  "/auth/login",
  wrapAsync(async (request, response) => {
    if (!isAuthEnabled()) {
      response.json({ ok: true });
      return;
    }
    // Public attempts only: the LAN stays exempt so an attacker hammering the public URL cannot
    // also lock the owner out at home. Checked before checkPassword so a locked-out caller
    // learns nothing, not even from a correct guess.
    const isPublicRequest: boolean = !isLocalRequest(request);
    const clientKey: string = clientAddressOf(request);
    // A device that logged in before is exempt from the GLOBAL ceiling only (its own five
    // failures still lock it, and the password is still required). Resolved here, before the
    // lock check, so nothing async sits between that check and recordFailedLogin below: parallel
    // guesses from one address cannot all pass before the first failure is counted. Any error
    // (a malformed cookie, an unreadable secret) just means "not trusted"; it is logged with a
    // fixed string because the error message names the secret file.
    let isTrustedDevice = false;
    if (isPublicRequest) {
      try {
        isTrustedDevice = await verifyTrustedDeviceToken(readCookie(request.headers.cookie, TRUSTED_DEVICE_COOKIE_NAME));
      } catch {
        console.error("[auth] could not verify the trusted-device cookie, treating the device as untrusted");
      }
    }
    if (isPublicRequest && isLoginLocked(clientKey, Date.now(), isTrustedDevice)) {
      response.status(429).json({ error: "Too many attempts, try again later." });
      return;
    }
    const { password } = request.body as { password?: unknown };
    if (typeof password !== "string" || !checkPassword(password)) {
      if (isPublicRequest) {
        recordFailedLogin(clientKey);
      }
      response.status(401).json({ error: "Incorrect password" });
      return;
    }
    if (isPublicRequest) {
      resetFailedLogins(clientKey);
    } else {
      clearAllFailedLogins();
    }
    const { value, maxAgeMs } = await issueToken();
    // Session cookie first (callers and tests read the first Set-Cookie), then the marker that
    // keeps this browser able to log in while strangers have the global ceiling reached.
    const trustedDevice = await issueTrustedDeviceToken();
    response.cookie(AUTH_COOKIE_NAME, value, authCookieOptions(request, maxAgeMs));
    response.cookie(TRUSTED_DEVICE_COOKIE_NAME, trustedDevice.value, authCookieOptions(request, trustedDevice.maxAgeMs));
    response.json({ ok: true });
  })
);

// Registered before requireAuth for the bootstrap case (no password set yet, e.g. from the
// "Start tunnel" flow); if a password already exists, it requires the caller to already be
// authenticated so a stranger cannot silently overwrite it.
apiRouter.post(
  "/auth/set-password",
  wrapAsync(async (request, response) => {
    const { password } = request.body as { password?: unknown };
    const trimmedPassword: string = typeof password === "string" ? password.trim() : "";
    if (trimmedPassword.length < 8) {
      response.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }
    // Read before setStoredPassword: afterwards auth is always enabled.
    const hadPassword: boolean = isAuthEnabled();
    if (hadPassword) {
      // Changing an existing password now also rotates the secret, which signs everyone out.
      // From the public URL that would let a stolen session lock the owner out and keep the
      // only valid cookie, so it is local-only (the UI only offers it on ai.local anyway).
      if (!isLocalRequest(request)) {
        response.status(403).json({ error: "This action is only available on the local network." });
        return;
      }
      const token: string | undefined = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
      if (!(await verifyToken(token))) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (isPasswordFromEnv()) {
        response.status(409).json({
          error: "DASHBOARD_PASSWORD is set in the environment and overrides this; remove it first.",
        });
        return;
      }
    }
    await setStoredPassword(trimmedPassword);
    // Only an existing password has sessions worth revoking; the bootstrap case has none.
    if (hadPassword) {
      try {
        await rotateSecret();
      } catch (error) {
        console.error("[server] secret rotation failed after password change:", (error as Error).message);
        response.status(500).json({ error: "Password changed but other sessions were NOT signed out." });
        return;
      }
    }
    const { value, maxAgeMs } = await issueToken();
    response.cookie(AUTH_COOKIE_NAME, value, authCookieOptions(request, maxAgeMs));
    response.json({ ok: true });
  })
);

apiRouter.use(requireAuth);

// Killswitch: rotating the signing secret invalidates every cookie and, through the listener
// registered in index.ts, cuts the open terminal sockets. The caller gets a fresh cookie so the
// device that pressed the button stays signed in.
apiRouter.post(
  "/auth/revoke-all",
  requireLocalHost,
  wrapAsync(async (request, response) => {
    await rotateSecret();
    const { value, maxAgeMs } = await issueToken();
    response.cookie(AUTH_COOKIE_NAME, value, authCookieOptions(request, maxAgeMs));
    response.json({ ok: true });
  })
);

// A browser on another machine cannot hand its clipboard image to the agent running here (the
// agent reads the clipboard of THIS machine), so the page uploads it and pastes the saved
// file's path instead: the agent turns a pasted image path into an attachment. This writes to
// disk, hence behind requireAuth, with a size cap and only the image types the agent accepts.
apiRouter.post(
  "/pasted-images",
  readPastedImageBody,
  wrapAsync(async (request, response) => {
    const contentType: string | false | null = request.is(PASTED_IMAGE_TYPES);
    if (typeof contentType !== "string") {
      response.status(415).json({ error: "Only png, jpeg, gif and webp images can be uploaded." });
      return;
    }
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      response.status(400).json({ error: "The image is empty." });
      return;
    }
    const savedPath: string = await savePastedImage(request.body, contentType, PASTED_IMAGE_DIRECTORY);
    response.json({ path: savedPath });
  })
);

apiRouter.get(
  "/config",
  wrapAsync(async (_request, response) => {
    const state: DashboardState = await loadState();
    response.json({ ...state.config, configured: state.config.locations.length > 0 });
  })
);

const MAX_GITLAB_TOKEN_ENV_ENTRIES = 20;

// undefined: field absent, keep the stored map. null: invalid. Only variable NAMES are accepted.
function parseGitlabTokenEnv(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries: Array<[string, unknown]> = Object.entries(value);
  if (entries.length > MAX_GITLAB_TOKEN_ENV_ENTRIES) return null;
  const validEntries: Array<[string, string]> = [];
  for (const [rawHost, envName] of entries) {
    const host: string | null = normalizeGitlabHostKey(rawHost);
    if (host === null || typeof envName !== "string" || !isValidTokenEnvName(envName)) return null;
    validEntries.push([host, envName]);
  }
  return new Set(validEntries.map(([host]) => host)).size === validEntries.length ? Object.fromEntries(validEntries) : null;
}

apiRouter.put(
  "/config",
  wrapAsync(async (request, response) => {
    const { locations, enabledProviders } = request.body as { locations?: unknown; enabledProviders?: unknown };
    if (!Array.isArray(locations) || locations.some((location) => typeof location !== "string")) {
      response.status(400).json({ error: "Provide the list of location paths." });
      return;
    }
    const trimmedLocations: string[] = (locations as string[])
      .map((location) => location.trim())
      .filter((location) => location !== "");
    if (trimmedLocations.length === 0) {
      response.status(400).json({ error: "Add at least one location." });
      return;
    }
    const resolvedLocations: string[] = trimmedLocations.map(resolveHomePath);
    if (new Set(resolvedLocations).size !== resolvedLocations.length) {
      response.status(400).json({ error: "There are duplicate location paths." });
      return;
    }
    for (const locationPath of resolvedLocations) {
      if (!(await pathExists(locationPath))) {
        response.status(400).json({ error: `Folder does not exist: ${locationPath}` });
        return;
      }
    }

    if (
      enabledProviders !== undefined &&
      (!Array.isArray(enabledProviders) || enabledProviders.length === 0 || !enabledProviders.every(isAgentProvider))
    ) {
      response.status(400).json({ error: "Provide at least one valid agent." });
      return;
    }
    const gitlabTokenEnv: Record<string, string> | null | undefined = parseGitlabTokenEnv(
      (request.body as { gitlabTokenEnv?: unknown }).gitlabTokenEnv
    );
    if (gitlabTokenEnv === null) {
      response.status(400).json({ error: "Provide GitLab hosts with the name of the variable that holds each token." });
      return;
    }
    // Through updateState like every other writer: a bare loadState/saveState here could
    // overwrite a create/delete/rename another device committed in between.
    const savedConfig = await updateState(async (draft) => {
      draft.config = {
        ...draft.config,
        locations: resolvedLocations,
        enabledProviders: enabledProviders === undefined ? draft.config.enabledProviders : enabledProviders,
        ...(gitlabTokenEnv !== undefined ? { gitlabTokenEnv } : {}),
      };
      return { result: draft.config, nextState: draft };
    });
    response.json({ ...savedConfig, configured: true });
  })
);

apiRouter.get(
  "/locations/exists",
  wrapAsync(async (request, response) => {
    const locationPath: string = typeof request.query.path === "string" ? request.query.path.trim() : "";
    if (locationPath === "") {
      response.status(400).json({ error: "Provide the location." });
      return;
    }
    response.json({ exists: await pathExists(locationPath) });
  })
);

apiRouter.get(
  "/locations",
  wrapAsync(async (_request, response) => {
    const state: DashboardState = await loadState();
    const locations = state.config.locations.map((locationPath) => ({
      path: locationPath,
      folderName: path.basename(locationPath),
    }));
    response.json(locations);
  })
);

apiRouter.get(
  "/locations/branches",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const locationPath: string = typeof request.query.path === "string" ? request.query.path.trim() : "";
    if (locationPath === "") {
      response.status(400).json({ error: "Provide the location." });
      return;
    }
    if (!state.config.locations.includes(locationPath)) {
      response.status(400).json({ error: `Location ${locationPath} is not configured.` });
      return;
    }
    if (!(await pathExists(locationPath))) {
      response.status(404).json({ error: `Folder does not exist: ${locationPath}` });
      return;
    }

    try {
      const branches: string[] = await localBranches(locationPath);
      response.json({ isGitRepo: true, branches, currentBranch: await currentBranch(locationPath) });
    } catch {
      // Not a git repo, or git not installed
      response.json({ isGitRepo: false, branches: [], currentBranch: null });
    }
  })
);

apiRouter.get(
  "/locations/stale-branches",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const locationPath: string = typeof request.query.path === "string" ? request.query.path.trim() : "";
    if (locationPath === "") {
      response.status(400).json({ error: "Provide the location." });
      return;
    }
    if (!state.config.locations.includes(locationPath)) {
      response.status(400).json({ error: `Location ${locationPath} is not configured.` });
      return;
    }
    if (!(await pathExists(locationPath))) {
      response.status(404).json({ error: `Folder does not exist: ${locationPath}` });
      return;
    }
    response.json(await findStaleBranches(locationPath, state.instances));
  })
);

apiRouter.post(
  "/locations/stale-branches/delete",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const locationPath: string = typeof request.body.path === "string" ? request.body.path.trim() : "";
    const requestedBranches: unknown = request.body.branches;
    if (locationPath === "") {
      response.status(400).json({ error: "Provide the location." });
      return;
    }
    if (!state.config.locations.includes(locationPath)) {
      response.status(400).json({ error: `Location ${locationPath} is not configured.` });
      return;
    }
    if (!(await pathExists(locationPath))) {
      response.status(404).json({ error: `Folder does not exist: ${locationPath}` });
      return;
    }
    if (!Array.isArray(requestedBranches) || !requestedBranches.every((branch) => typeof branch === "string")) {
      response.status(400).json({ error: "Provide the branches to delete." });
      return;
    }

    // Held for the whole operation: a creation that has not persisted yet finishes first and
    // is then seen below, and nothing can start a worktree operation in between.
    const releaseWorktreeOps: () => void = await acquireWorktreeOpsLock();
    try {
      await deleteStaleBranches(locationPath, requestedBranches, response);
    } finally {
      releaseWorktreeOps();
    }
  })
);

// Body of the stale-branch delete; runs under the worktree-ops lock.
async function deleteStaleBranches(locationPath: string, requestedBranches: string[], response: Response): Promise<void> {
  // State is read again here, under the lock: the one read before it can predate an instance
  // that was created while this request waited its turn.
  const freshState: DashboardState = await loadState();

  // Recompute candidates now, rather than trusting the client's earlier snapshot: the
  // repo may have changed (new commits, a checkout, a new worktree) between when the
  // list was fetched and when the user clicked delete.
  const { candidates, currentBranch: checkedOutBranch } = await findStaleBranches(locationPath, freshState.instances);
  const candidatesByName: Map<string, { branch: string; worktreePath?: string }> = new Map(
    candidates.map((candidate) => [candidate.branch, candidate])
  );
  const invalidBranch: string | undefined = requestedBranches.find((branch) => !candidatesByName.has(branch));
  if (invalidBranch !== undefined) {
    response.status(400).json({ error: `'${invalidBranch}' is no longer a listed branch for this location.` });
    return;
  }

  // Deleting the branch checked out in this location requires switching off it first, and a
  // checkout moves the whole working tree: never while an instance works anywhere inside it.
  if (checkedOutBranch !== null && requestedBranches.includes(checkedOutBranch)) {
    const workingTree: string = await resolvedPath(await runGit(locationPath, ["rev-parse", "--show-toplevel"]));
    for (const instance of freshState.instances) {
      if (isSameOrInside(workingTree, await resolvedPath(instance.locationPath))) {
        response.status(409).json({
          error: `'${checkedOutBranch}' is checked out in ${locationPath}, where the instance '${instance.label}' is working. Close that instance first.`,
        });
        return;
      }
    }
    const branches: string[] = await localBranches(locationPath).catch(() => []);
    const switchTarget: string | null = localProtectedBranch(branches);
    if (switchTarget === null) {
      response.status(409).json({
        error: `Could not find a local main/master/develop/dev branch to switch to before deleting '${checkedOutBranch}'.`,
      });
      return;
    }
    try {
      await runGit(locationPath, ["checkout", switchTarget]);
    } catch (error) {
      response
        .status(409)
        .json({ error: `Could not switch off '${checkedOutBranch}' before deleting it: ${(error as Error).message}` });
      return;
    }
  }

  const deleted: string[] = [];
  const failed: { branch: string; error: string }[] = [];
  for (const branch of requestedBranches) {
    const worktreePath: string | undefined = candidatesByName.get(branch)?.worktreePath;
    try {
      if (worktreePath !== undefined) {
        // Checked out elsewhere. Look at the instances once more right before removing, then
        // remove it only if nothing in it would be lost (never --force); otherwise it stays,
        // the branch stays, and the reason is shown.
        const latestInstances: InstanceRecord[] = (await loadState()).instances;
        const resolvedWorktree: string = await resolvedPath(worktreePath);
        let busyInstance: InstanceRecord | undefined;
        for (const instance of latestInstances) {
          if (isSameOrInside(resolvedWorktree, await resolvedPath(instance.locationPath))) {
            busyInstance = instance;
            break;
          }
        }
        if (busyInstance !== undefined) {
          failed.push({
            branch,
            error: `The worktree ${worktreePath} is used by the instance '${busyInstance.label}', so it was kept.`,
          });
          continue;
        }
        const keptReason: string | null = await removeWorktreeSafely(locationPath, worktreePath);
        if (keptReason !== null) {
          failed.push({ branch, error: keptReason });
          continue;
        }
      }
      await runGit(locationPath, ["branch", "-D", branch]);
      deleted.push(branch);
    } catch (error) {
      failed.push({ branch, error: (error as Error).message });
    }
  }
  response.json({ deleted, failed });
}

apiRouter.get("/update-status", (_request, response) => {
  response.json(getUpdateStatus());
});

apiRouter.post(
  "/update/check",
  wrapAsync(async (_request, response) => {
    response.json(await checkForUpdate());
  })
);

apiRouter.post(
  "/update/apply",
  requireLocalHost,
  wrapAsync(async (_request, response) => {
    response.json(await applyUpdate());
  })
);

apiRouter.post(
  "/update/reset",
  requireLocalHost,
  wrapAsync(async (_request, response) => {
    response.json(await resetToRemote());
  })
);

// getTunnelMode() picks the backend: "named" when data/named-tunnel/tunnel.json exists (opt-in,
// written by scripts/setup-named-tunnel.sh), "quick" otherwise (the zero-config default). The
// two share the TunnelStatus shape and this same set of routes.
apiRouter.get(
  "/tunnel",
  requireLocalHost,
  wrapAsync(async (_request, response) => {
    response.json(getTunnelMode() === "named" ? await getNamedTunnelStatus() : getTunnelStatus());
  })
);

apiRouter.post(
  "/tunnel/start",
  requireLocalHost,
  wrapAsync(async (_request, response) => {
    if (!isAuthEnabled()) {
      response.status(409).json({ error: "Set DASHBOARD_PASSWORD before exposing the dashboard to the internet." });
      return;
    }
    response.json(getTunnelMode() === "named" ? await startNamedTunnel() : await startTunnel());
  })
);

apiRouter.post(
  "/tunnel/stop",
  requireLocalHost,
  wrapAsync(async (_request, response) => {
    response.json(getTunnelMode() === "named" ? await stopNamedTunnel() : stopTunnel());
  })
);

// Full cloudflared output for diagnosing failures that only show up after the tunnel already
// reported a URL (edge disconnects, protocol errors), which the short-lived status error field
// never captures. Both modes write to the same data/cloudflared.log (quick via tunnel.ts's own
// append, named via the LaunchAgent's --logfile), so one reader covers both.
apiRouter.get("/tunnel/logs", requireLocalHost, (_request, response) => {
  response.type("text/plain").send(readTunnelLog());
});

// Lets the phone scan a second QR for same-network access (no cloudflared/DNS involved),
// separate from the tunnel: Caddy already rewrites the Host header for any LAN IP (see
// Caddyfile), so this just needs to report an address that reaches this machine.
apiRouter.get("/lan-address", (_request, response) => {
  response.json({ url: getLanUrl() });
});

apiRouter.get(
  "/instances",
  wrapAsync(async (_request, response) => {
    const state: DashboardState = await loadState();
    response.json(state.instances);
  })
);

// Read-only and behind requireAuth only: the phone reads it over the tunnel. State is written
// by the hook script straight to disk, so no route accepts it.
apiRouter.get(
  "/instances/agent-states",
  wrapAsync(async (_request, response) => {
    const state: DashboardState = await loadState();
    response.json(await resolveAgentStates(state.instances, { readState: readAgentStateFile, findAgent: probePaneAgent }));
  })
);

// Reads only the in-memory status the poller keeps: no token lookup and no network here, so the
// phone polling this can never cost a GitHub call.
apiRouter.get(
  "/instances/pr-events",
  wrapAsync(async (_request, response) => {
    const state: DashboardState = await loadState();
    const statuses = getPrEventsStatus();
    const body: Record<string, { enabled: boolean; paused: boolean; pending: number; status: string; provider?: "gitlab"; host?: string }> = {};
    for (const instance of state.instances) {
      const entry: { provider?: unknown; host?: unknown } | undefined = statuses[instance.id];
      const isGitlab: boolean = entry?.provider === "gitlab";
      body[instance.id] = {
        enabled: instance.prEvents?.enabled === true,
        paused: instance.prEvents?.paused === true,
        pending: statuses[instance.id]?.pending ?? 0,
        status: statuses[instance.id]?.status ?? "off",
        // Explicit keys, never a spread of the status entry, and GitHub instances keep four keys.
        ...(isGitlab ? { provider: "gitlab" as const } : {}),
        ...(isGitlab && typeof entry?.host === "string" && isValidGitlabHost(entry.host) ? { host: entry.host } : {}),
      };
    }
    response.json(body);
  })
);

apiRouter.get(
  "/instances/resumable",
  wrapAsync(async (request, response) => {
    const provider = request.query.provider;
    const locationPath: string = typeof request.query.path === "string" ? request.query.path.trim() : "";
    const label: string = typeof request.query.label === "string" ? request.query.label.trim() : "";
    if (!isAgentProvider(provider) || locationPath === "" || label === "") {
      response.status(400).json({ error: "Provide a valid provider, location and label." });
      return;
    }
    const state: DashboardState = await loadState();
    const hasSession: boolean =
      PROVIDERS[provider].capabilities.resume &&
      state.sessionsByKey[sessionKeyFor(provider, locationPath, label)] !== undefined;
    response.json({ hasSession });
  })
);

const REMOTE_UNREACHABLE_MESSAGE: string =
  "Could not reach 'origin' to update the base branch. If it is a corporate remote, check the VPN. " +
  "Creating a new branch needs the remote; checking out a branch that already exists locally works offline.";

apiRouter.post(
  "/instances",
  wrapAsync(async (request, response) => {
    const payload = request.body as CreateInstancePayload;
    const state: DashboardState = await loadState();
    const { locations } = state.config;

    // ===================================================================================
    // Phase 1 - validation, no side effects. Everything that can be rejected on the input
    // alone runs here and still answers with its own HTTP status (400/409), exactly as
    // before. The provider checks used to run AFTER the git block, which meant an invalid
    // provider cost a ~15s fetch before the rejection; they are hoisted here now.
    // ===================================================================================
    if (locations.length === 0) {
      response.status(409).json({ error: "Configure locations first." });
      return;
    }

    const locationPath: string = typeof payload.locationPath === "string" ? payload.locationPath.trim() : "";
    if (locationPath === "") {
      response.status(400).json({ error: "Provide the location." });
      return;
    }
    if (!locations.includes(locationPath)) {
      response.status(400).json({ error: `Location ${locationPath} is not configured.` });
      return;
    }
    if (!(await pathExists(locationPath))) {
      response.status(400).json({ error: `Folder does not exist: ${locationPath}` });
      return;
    }

    const requestedLabel: string =
      typeof payload.label === "string" && payload.label.trim() !== "" ? payload.label.trim() : path.basename(locationPath);
    const nameTaken: boolean = state.instances.some(
      (existing) => existing.locationPath === locationPath && existing.label === requestedLabel
    );
    if (nameTaken) {
      response.status(409).json({ error: `An instance named '${requestedLabel}' is already running here` });
      return;
    }

    const branchAction: BranchAction | undefined = payload.branchAction;
    let branchActionBranch = "";
    let branchActionBase = "";
    if (branchAction !== undefined) {
      branchActionBranch = typeof branchAction.branch === "string" ? branchAction.branch.trim() : "";
      if (branchActionBranch === "" || (branchAction.type !== "checkout" && branchAction.type !== "create")) {
        response.status(400).json({ error: "Provide a valid branch action." });
        return;
      }
      if (branchAction.type === "create" && (typeof branchAction.baseBranch !== "string" || branchAction.baseBranch.trim() === "")) {
        response.status(400).json({ error: "Provide the base branch to create from." });
        return;
      }
      branchActionBase = branchAction.type === "create" ? (branchAction.baseBranch as string).trim() : "";
      // A leading dash would be parsed by git as an option, not a branch name.
      if (branchActionBranch.startsWith("-") || branchActionBase.startsWith("-")) {
        response.status(400).json({ error: "Branch names cannot start with '-'." });
        return;
      }
    }

    const shellOnly: boolean = payload.shellOnly === true;
    if (payload.provider !== undefined && !isAgentProvider(payload.provider)) {
      response.status(400).json({ error: "Provide a valid agent provider." });
      return;
    }
    const provider = isAgentProvider(payload.provider) ? payload.provider : "claude";
    if (!state.config.enabledProviders.includes(provider)) {
      response.status(400).json({ error: "Agent not enabled. Enable it from Settings." });
      return;
    }
    const providerDefinition = PROVIDERS[provider];
    if (
      !shellOnly &&
      provider === "custom" &&
      (typeof payload.command !== "string" || payload.command.trim() === "")
    ) {
      response.status(400).json({ error: "Provide a custom command." });
      return;
    }

    // A short id can collide with an existing instance, whose DELETE may be holding that
    // session's lock while it waits for the worktree-ops lock this request is about to take;
    // drawing a fresh id against the current state closes that cycle for every instance that
    // exists now.
    // ponytail: an id persisted between this draw and the lock is caught by the re-check after the lock is taken; one persisted after that is rejected by the commit check.
    let instanceId: string = randomUUID().slice(0, 8);
    while (state.instances.some((existing) => existing.id === instanceId || existing.tmuxSession === `ccdash-${instanceId}`)) {
      instanceId = randomUUID().slice(0, 8);
    }
    const instance: InstanceRecord = {
      id: instanceId,
      label: requestedLabel,
      locationPath,
      tmuxSession: `ccdash-${instanceId}`,
      provider,
      command:
        typeof payload.command === "string" && payload.command.trim() !== ""
          ? payload.command.trim()
          : providerDefinition.defaultCommand,
      model:
        providerDefinition.capabilities.model && typeof payload.model === "string" && payload.model.trim() !== ""
          ? payload.model.trim()
          : null,
      effort:
        providerDefinition.capabilities.effort && typeof payload.effort === "string" && payload.effort.trim() !== ""
          ? payload.effort.trim()
          : null,
      fontSize: DEFAULT_FONT_SIZE,
      createdAt: new Date().toISOString(),
      ...(shellOnly ? { shellOnly: true } : {}),
    };

    const resumeKey: string = sessionKeyFor(provider, locationPath, requestedLabel);
    let resumeSessionId: string | undefined =
      payload.resumeSession === false ? undefined : state.sessionsByKey[resumeKey];

    // ===================================================================================
    // Phase 2 - execution, with side effects. The status (kept at 201) and headers are on
    // the wire from flushHeaders() on, so NOTHING below may throw out of the handler: a
    // failure becomes a terminal `error` event, `finally` always ends the response. See
    // index.ts's error middleware for the headersSent guard that backs this up.
    // ===================================================================================
    response.status(201);
    response.setHeader("Content-Type", "application/x-ndjson");
    response.setHeader("Cache-Control", "no-store");
    // Belt and braces against a proxy that might otherwise buffer the whole body.
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    const progress = new LaunchProgress((line) => {
      response.write(line);
    });
    // A client that navigates away or a proxy that drops the connection: stop writing, but
    // never abort the tmux session / agent coming up behind it.
    request.on("close", () => progress.markSinkClosed());
    response.on("error", () => progress.markSinkClosed());

    const sessionStepLabel: Record<"create-session" | "launch-agent", string> = {
      "create-session": "Starting tmux session",
      "launch-agent": shellOnly ? "Opening shell" : `Launching ${instance.command}`,
    };

    let persisted = false;
    let createdWorktreeDir: string | null = null;
    let releaseWorktreeOps: (() => void) | null = null;
    // Best-effort and never forced: a failed launch must not leave a worktree behind, but must
    // never discard work either (removeWorktreeSafely keeps it when anything would be lost).
    // A branch created for it stays and is named in the error.
    const removeCreatedWorktree = async (): Promise<string> => {
      if (createdWorktreeDir === null) return "";
      const keptReason: string | null = await removeWorktreeSafely(locationPath, createdWorktreeDir);
      if (keptReason !== null) return ` ${keptReason}`;
      return branchAction?.type === "create" ? ` The new branch '${branchActionBranch}' was left in place.` : "";
    };
    try {
      // Held from here, before any git call or checkout, until the instance is saved in state
      // (or this handler ends): a stale-branch delete or an instance close can then never move a
      // branch or remove a worktree between "decided" and "persisted". Always taken, branch
      // action or not, since even a plain create saves a live instance in this location.
      releaseWorktreeOps = await acquireWorktreeOpsLock();
      // The state read in phase 1 may predate a create that held the lock before this one.
      const currentInstances: InstanceRecord[] = (await loadState()).instances;
      // An id persisted while this request waited would make the session lock below wait on a
      // DELETE that is itself waiting for the lock held here; refuse before taking it.
      if (currentInstances.some((existing) => existing.id === instance.id || existing.tmuxSession === instance.tmuxSession)) {
        progress.fail("Could not register the new instance: id collision, please retry");
        return;
      }

      // Decided before anything touches git or the resume snapshot: a folder with a live session
      // must keep its branch, so the new instance gets a sibling worktree instead.
      let useWorktree = false;
      if (branchAction !== undefined) {
        let folderHasLiveInstance = false;
        for (const existing of currentInstances) {
          if (existing.locationPath === locationPath && (await getSessionPresence(existing.tmuxSession)) !== "absent") {
            folderHasLiveInstance = true;
            break;
          }
        }
        useWorktree =
          folderHasLiveInstance &&
          (branchAction.type === "create" || (await currentBranch(locationPath)) !== branchActionBranch);
      }
      if (useWorktree && resumeSessionId !== undefined) {
        // The saved session belongs to the shared folder, not to the worktree.
        resumeSessionId = undefined;
        progress.stepWarning("prepare-resume", "Session resume skipped: this instance runs in a new worktree.");
      }

      if (resumeSessionId !== undefined) {
        progress.stepStart("prepare-resume", "Preparing session resume");
        instance.sessionId = resumeSessionId;
        const sessionFile: string | undefined =
          provider === "codex" ? await findCodexSessionFile(resumeSessionId) : undefined;
        await writeSessionSnapshot(instance, resumeSessionId, sessionFile ? { sessionFile } : {});
        progress.stepDone("prepare-resume");
      }

      if (branchAction !== undefined && useWorktree) {
        try {
          const worktreeDir: string = worktreeDirFor(locationPath, branchActionBranch);
          let reuseExisting = false;
          if (await pathExists(worktreeDir)) {
            const existingWorktreePath: string | undefined = (await branchesCheckedOutInWorktrees(locationPath)).get(
              branchActionBranch
            );
            reuseExisting =
              branchAction.type === "checkout" &&
              existingWorktreePath !== undefined &&
              (await resolvedPath(existingWorktreePath)) === (await resolvedPath(worktreeDir));
            if (!reuseExisting) {
              progress.fail(
                `${worktreeDir} already exists and is not a worktree on '${branchActionBranch}'. Move or remove it, then try again.`
              );
              return;
            }
          } else if (branchAction.type === "checkout") {
            progress.stepStart("checkout-branch", `Adding worktree for ${branchActionBranch}`);
            await runGit(locationPath, ["worktree", "add", "--", worktreeDir, branchActionBranch]);
            createdWorktreeDir = worktreeDir;
            progress.stepDone("checkout-branch");
          } else {
            progress.stepStart("fetch-base", `Fetching ${branchActionBase} from origin`);
            await runGit(locationPath, ["fetch", "origin", branchActionBase], NETWORK_GIT_TIMEOUT_MS);
            progress.stepDone("fetch-base");

            progress.stepStart("create-branch", `Creating branch ${branchActionBranch} in a new worktree`);
            await runGit(locationPath, [
              "worktree", "add", "--no-track", "-b", branchActionBranch, "--", worktreeDir, `origin/${branchActionBase}`,
            ]);
            createdWorktreeDir = worktreeDir;
            progress.stepDone("create-branch");
          }
          instance.locationPath = worktreeDir;
          instance.worktree = { sourcePath: locationPath, branch: branchActionBranch, created: !reuseExisting };
        } catch (error) {
          progress.fail(
            isRemoteUnreachableError(error)
              ? REMOTE_UNREACHABLE_MESSAGE
              : `Could not create the worktree: ${(error as Error).message}`
          );
          return;
        }
      } else if (branchAction !== undefined) {
        try {
          if (branchAction.type === "checkout") {
            progress.stepStart("checkout-branch", `Checking out ${branchActionBranch}`);
            await runGit(locationPath, ["checkout", branchActionBranch]);
            progress.stepDone("checkout-branch");
          } else {
            progress.stepStart("fetch-base", `Fetching ${branchActionBase} from origin`);
            await runGit(locationPath, ["fetch", "origin", branchActionBase], NETWORK_GIT_TIMEOUT_MS);
            progress.stepDone("fetch-base");

            progress.stepStart("update-base", `Updating ${branchActionBase}`);
            const activeBranch: string | null = await currentBranch(locationPath);
            if (activeBranch === branchActionBase) {
              // The base branch is checked out here: fast-forward it in place, never overwrite local commits
              await runGit(locationPath, ["merge", "--ff-only", `origin/${branchActionBase}`]);
            } else {
              // Not checked out: update its ref directly. A plain (non "+") refspec is fast-forward-only,
              // git refuses on its own if the local base branch has diverged from origin
              await runGit(locationPath, ["fetch", "origin", `${branchActionBase}:${branchActionBase}`], NETWORK_GIT_TIMEOUT_MS);
            }
            progress.stepDone("update-base");

            progress.stepStart("create-branch", `Creating branch ${branchActionBranch}`);
            await runGit(locationPath, ["checkout", "-b", branchActionBranch, branchActionBase]);
            progress.stepDone("create-branch");
          }
        } catch (error) {
          // An unreachable remote (corporate host with no VPN) is the common case here, and
          // the raw git/ssh message does not point at the fix.
          progress.fail(
            isRemoteUnreachableError(error)
              ? REMOTE_UNREACHABLE_MESSAGE
              : `Could not switch branches: ${(error as Error).message}`
          );
          return;
        }
      }

      // Same guarded create+launch sequence the attach path uses (terminal.ts's
      // initializeInstanceSession), with the instance persisted in the hook that fires right
      // after the session exists and BEFORE the provider launch: once the launch may have been
      // applied, a failure must not strand a live agent in a session with no instance record
      // pointing at it (no attach route, no DELETE). `persisted` tells the two failure kinds
      // apart - a create failure before the hook is a real `error` with nothing saved; a
      // post-launch failure keeps `done` (with the instance) plus a `step-warning`, and the
      // user attaches or deletes explicitly.
      try {
        // Locked around the whole create+persist+launch sequence for this tmuxSession - see
        // sessionLock.ts. The name is a fresh random id, so contention here is only a
        // theoretical safeguard, not something expected to actually happen; the lock is held
        // for the SAME reason DELETE holds it (routes.ts's DELETE handler below), for
        // uniformity of "nothing else touches this session name while this is in flight".
        await withSessionLock(instance.tmuxSession, () =>
          initializeInstanceSession(
            instance,
            async () => {
              progress.stepStart("persist", "Saving instance");
              await updateState(async (draft) => {
                const nameCollision: boolean = draft.instances.some(
                  (existing) => existing.locationPath === instance.locationPath && existing.label === requestedLabel
                );
                const idCollision: boolean = draft.instances.some((existing) => existing.id === instance.id);
                const sessionCollision: boolean = draft.instances.some(
                  (existing) => existing.tmuxSession === instance.tmuxSession
                );
                if (nameCollision || idCollision || sessionCollision) {
                  throw new InstanceCommitConflictError(
                    nameCollision
                      ? `An instance named '${requestedLabel}' is already running here`
                      : "Could not register the new instance: id collision, please retry"
                  );
                }
                draft.instances.push(instance);
                return { result: undefined, nextState: draft };
              });
              persisted = true;
              // Saved, so every later worktree operation sees this instance; the rest of the
              // launch (agent boot) no longer needs the lock.
              releaseWorktreeOps?.();
              progress.stepDone("persist");
            },
            (step, phase) => {
              if (phase === "start") {
                progress.stepStart(step, sessionStepLabel[step]);
              } else {
                progress.stepDone(step);
              }
            }
          )
        );
      } catch (error) {
        if (!persisted) {
          progress.fail(`Could not create the instance: ${(error as Error).message}${await removeCreatedWorktree()}`);
          return;
        }
        console.error(
          `[server] instance ${instance.id}: provider launch did not confirm, keeping the session`,
          (error as Error).message
        );
        progress.stepWarning(
          "launch-agent",
          "The agent launch could not be confirmed. The session is running - attach to check on it."
        );
      }

      progress.done(instance);
    } catch (error) {
      // A failure with no more specific handler (writeSessionSnapshot, an unexpected throw).
      // Never rethrow: headers are already sent.
      progress.fail(
        `Could not create the instance: ${(error as Error).message}${persisted ? "" : await removeCreatedWorktree()}`
      );
    } finally {
      releaseWorktreeOps?.();
      response.end();
    }
  })
);

apiRouter.put(
  "/instances/order",
  wrapAsync(async (request, response) => {
    const { order } = request.body as { order?: unknown };
    if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) {
      response.status(400).json({ error: "Provide the new id order." });
      return;
    }
    // The permutation check runs inside the mutator, against the latest committed instances:
    // a create/delete from another device that landed first makes a stale order a 400 here
    // instead of silently dropping or resurrecting an instance.
    const outcome = await updateState(async (draft) => {
      const currentIds: Set<string> = new Set(draft.instances.map((instance) => instance.id));
      const isExactPermutation: boolean =
        order.length === currentIds.size &&
        new Set(order).size === order.length &&
        order.every((id) => currentIds.has(id));
      if (!isExactPermutation) {
        return { result: null };
      }
      const instanceById: Map<string, InstanceRecord> = new Map(
        draft.instances.map((instance) => [instance.id, instance])
      );
      draft.instances = (order as string[]).map((id) => instanceById.get(id) as InstanceRecord);
      return { result: draft.instances, nextState: draft };
    });
    if (outcome === null) {
      response.status(400).json({ error: "The order must include exactly the current instance ids." });
      return;
    }
    response.json(outcome);
  })
);

const BOT_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_.[\]]{0,99}$/;

function parsePrEventsUpdate(raw: unknown): Partial<NonNullable<InstanceRecord["prEvents"]>> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { enabled, paused, botLogins } = raw as Record<string, unknown>;
  const update: Partial<NonNullable<InstanceRecord["prEvents"]>> = {};
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") return null;
    update.enabled = enabled;
  }
  if (paused !== undefined) {
    if (typeof paused !== "boolean") return null;
    update.paused = paused;
  }
  if (botLogins !== undefined) {
    if (!Array.isArray(botLogins) || botLogins.length > 20) return null;
    if (!botLogins.every((login) => typeof login === "string" && BOT_LOGIN_PATTERN.test(login))) return null;
    update.botLogins = botLogins as string[];
  }
  return update;
}

apiRouter.patch(
  "/instances/:id",
  wrapAsync(async (request, response) => {
    const payload = request.body as UpdateInstancePayload;
    // Validated before any write: the bot list later decides whose reviews are ignored.
    const prEventsUpdate = payload.prEvents === undefined ? null : parsePrEventsUpdate(payload.prEvents);
    if (payload.prEvents !== undefined && prEventsUpdate === null) {
      response.status(400).json({ error: "prEvents must be {enabled?, paused?, botLogins?} with booleans and up to 20 valid logins." });
      return;
    }
    // Lookup, name-collision check and mutation all run inside updateState so they see the
    // latest committed instances (a concurrent delete/rename from another device included).
    const outcome = await updateState<
      { instance: InstanceRecord } | { errorStatus: 404 | 409; error: string }
    >(async (draft) => {
      const instance = draft.instances.find((candidate) => candidate.id === request.params.id);
      if (instance === undefined) {
        return { result: { errorStatus: 404, error: "Instance not found." } };
      }
      if (typeof payload.label === "string" && payload.label.trim() !== "") {
        const nextLabel: string = payload.label.trim();
        const nameTaken: boolean = draft.instances.some(
          (candidate) =>
            candidate.id !== instance.id &&
            candidate.locationPath === instance.locationPath &&
            candidate.label === nextLabel
        );
        if (nameTaken) {
          return {
            result: { errorStatus: 409, error: `An instance named '${nextLabel}' is already running here` },
          };
        }
        instance.label = nextLabel;
      }
      if (typeof payload.command === "string" && payload.command.trim() !== "") {
        instance.command = payload.command.trim();
      }
      if (payload.model !== undefined) {
        instance.model =
          typeof payload.model === "string" && payload.model.trim() !== "" ? payload.model.trim() : null;
      }
      if (payload.effort !== undefined) {
        instance.effort =
          typeof payload.effort === "string" && payload.effort.trim() !== "" ? payload.effort.trim() : null;
      }
      if (prEventsUpdate !== null) {
        instance.prEvents = { enabled: false, paused: false, ...instance.prEvents, ...prEventsUpdate };
      }
      return { result: { instance }, nextState: draft };
    });
    if ("errorStatus" in outcome) {
      response.status(outcome.errorStatus).json({ error: outcome.error });
      return;
    }
    response.json(outcome.instance);
  })
);

apiRouter.get(
  "/instances/:id/git",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }

    // Prefer the pane's live directory (reflects `cd`s made inside the terminal);
    // fall back to the stored starting path if the tmux session is gone.
    const cwd: string = await getPaneCurrentPath(instance.tmuxSession).catch(() => instance.locationPath);
    const branch: string | null = await currentBranch(cwd);

    response.json(branch === null ? { cwd } : { cwd, branch });
  })
);

// The handler owns single-flight, the status mapping and the one fixed log line.
apiRouter.post(
  "/instances/:id/restart",
  wrapAsync(async (request, response) => {
    const restartDeps = realRestartDeps();
    const { status, body } = await handleRestartRequest(String(request.params.id), {
      loadInstance: async (instanceId) => (await loadState()).instances.find((candidate) => candidate.id === instanceId),
      restart: (instance) => restartClaudeSession(instance, restartDeps),
      log: (line) => console.log(`[server] ${line}`),
    });
    response.status(status).json(body);
  })
);

apiRouter.get(
  "/instances/:id/live-status",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }

    const [snapshot, agent, siblings] = await Promise.all([
      readInstanceSnapshot(instance),
      probePaneAgent(instance),
      listSiblingSnapshots(),
    ]);
    const now: number = Date.now();
    const owned: Set<string> = ownedSessionIds(siblings, instance.id, now);
    const { response: liveStatus, persist } = await resolveLiveStatus({
      instance,
      agent,
      snapshot,
      siblings,
      fallback: (found) => (found.provider === "codex" ? codexFallback(found, owned) : claudeFallback(found, owned)),
      enrichCodex: enrichCodexStatus,
    }).catch(() => ({ response: { available: false } as Record<string, unknown>, persist: null }));

    if (persist !== null && (instance.sessionId !== persist.sessionId || persist.pinConfigDir !== undefined)) {
      // Re-find the instance inside the transaction: the reads above are async, so a
      // DELETE (or rename) from another device may have committed meanwhile. Saving the
      // pre-read `state` here would resurrect a deleted instance or undo that change.
      await updateState(async (draft) => {
        const current = draft.instances.find((candidate) => candidate.id === instance.id);
        if (current === undefined) return { result: undefined };
        const pinProfile: boolean = persist.pinConfigDir !== undefined && current.configDir === undefined;
        if (current.sessionId === persist.sessionId && !pinProfile) return { result: undefined };
        current.sessionId = persist.sessionId;
        if (pinProfile) current.configDir = persist.pinConfigDir;
        draft.sessionsByKey[sessionKeyFor(current.provider, current.locationPath, current.label)] = persist.sessionId;
        return { result: undefined, nextState: draft };
      });
    }

    // The folder the branch shown in the sidebar came from. A snapshot's own cwd only counts when
    // it also carried a branch: Codex snapshots have a cwd but no branch (the sidebar then shows
    // the pane's), and codexFallback can report "", which `git -C ""` would resolve to this
    // server's own repo.
    const snapshotCwd: string | null =
      typeof liveStatus.cwd === "string" && path.isAbsolute(liveStatus.cwd) && typeof liveStatus.branch === "string"
        ? liveStatus.cwd
        : null;
    const paneCwd: string = snapshotCwd ?? (await getPaneCurrentPath(instance.tmuxSession).catch(() => instance.locationPath));

    // Nothing to show for the agent: still say which branch the pane is on, since the sidebar's
    // own one-time lookup would otherwise stay stuck on whatever it saw when it was opened.
    if (liveStatus.available === false && typeof liveStatus.reason === "string") {
      const branch: string | null = await currentBranch(paneCwd);
      if (branch !== null) liveStatus.branch = branch;
    }

    // Best-effort extra: a git failure here must not turn the whole live-status poll into a 500,
    // which the client would show as every field being unreachable.
    let upstream: BranchUpstream | null = null;
    try {
      upstream = await branchUpstream(paneCwd);
      if (upstream !== null) liveStatus.upstream = upstream;
    } catch (error) {
      console.error("[server] could not read the branch upstream state:", (error as Error).message);
    }
    // Its own try: losing the MR/PR must not also take the push state down with it
    if (upstream !== null) {
      try {
        const review: ReviewRequest | null = await reviewRequestFor(paneCwd, upstream);
        if (review !== null) liveStatus.review = review;
      } catch (error) {
        console.error("[server] could not read the merge request state:", (error as Error).message);
      }
    }
    response.json(liveStatus);
  })
);

apiRouter.delete(
  "/instances/:id",
  wrapAsync(async (request, response) => {
    const instanceId: string = request.params.id;
    const preState: DashboardState = await loadState();
    const preInstance = preState.instances.find((candidate) => candidate.id === instanceId);
    if (preInstance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }

    // Everything below runs under this instance's tmux session lock (sessionLock.ts) - the
    // whole point being to close the race where an attach's ensureSessionReady (terminal.ts)
    // recreates the session in the gap between this killing it and this removing the
    // registry entry, which would produce a fresh orphan through a different path than the
    // one this endpoint itself used to leak through.
    await withSessionLock(preInstance.tmuxSession, async () => {
      // Read the pane's live session id before killing it, so a future instance reusing this
      // exact location+label can pick up the conversation where it left off. Persisted in its
      // OWN transaction, before any kill attempt: it is non-destructive, and losing it would
      // cost a future resume even on the ordinary happy path, so there's no reason to gate it
      // on how the kill goes.
      const liveSession: PersistableSession | null = await readLiveSession(preInstance);
      if (liveSession !== null) {
        const resumeKey: string = sessionKeyFor(preInstance.provider, preInstance.locationPath, preInstance.label);
        await updateState(async (draft) => {
          draft.sessionsByKey[resumeKey] = liveSession.sessionId;
          return { result: undefined, nextState: draft };
        });
      }

      // A pending "tmux wait-for" from watchForAgentReady (terminal.ts) would otherwise sit
      // blocked for its full 20s timeout even though this session - and whatever it was
      // waiting to hear from - is about to be killed. Best-effort: a DELETE must never fail
      // because of this, it is purely a courtesy to let that wait return early.
      const pendingReadyChannel: string | null = getReadyChannel(preInstance.id);
      if (pendingReadyChannel !== null) {
        try {
          await signalChannel(pendingReadyChannel);
        } catch {
          // Nothing left to do about it; the watcher's own timeout still resolves eventually.
        }
      }
      clearAgentReadiness(preInstance.id);

      // killSession (tmux.ts) only returns cleanly on a DEFINITIVE "no such session"; it
      // rethrows for anything unconfirmed (a timeout, a wedged tmux server). Retried a couple
      // of times with short backoff before falling back to a direct presence check - a
      // momentary hiccup should not cost the user a stuck DELETE, but a kill that never
      // confirms must never be treated as if it had.
      let killConfirmed = false;
      let lastKillError: Error | null = null;
      for (let attempt = 0; attempt <= DELETE_KILL_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          await killSession(preInstance.tmuxSession);
          killConfirmed = true;
          break;
        } catch (error) {
          lastKillError = error as Error;
          if (attempt < DELETE_KILL_RETRY_DELAYS_MS.length) {
            await sleep(DELETE_KILL_RETRY_DELAYS_MS[attempt]);
          }
        }
      }

      if (!killConfirmed) {
        // The retries above never got a definitive answer - ask once more, directly, since a
        // session that quietly died on its own between retries still counts as gone.
        const presence = await getSessionPresence(preInstance.tmuxSession);
        killConfirmed = presence === "absent";
      }

      if (!killConfirmed) {
        // Deliberately does NOT touch the registry: the session may still be alive with a
        // live agent inside it. Losing the record here is exactly the bug this whole change
        // exists to close - see the DELETE catch{} this replaced.
        response.status(409).json({
          error: `Could not confirm '${preInstance.label}' stopped: ${lastKillError?.message ?? "unknown tmux error"}. Nothing was deleted; try again.`,
        });
        return;
      }

      const removal = await updateState<{ removedByThisRequest: boolean; shared: boolean }>(async (draft) => {
        const current = draft.instances.find((candidate) => candidate.id === instanceId);
        if (current === undefined) {
          // Already removed by a concurrent DELETE that won the race for this same instance
          // (both held the session lock in turn, sequentially) - idempotent, nothing to save.
          return { result: { removedByThisRequest: false, shared: false } };
        }
        draft.instances = draft.instances.filter((candidate) => candidate.id !== instanceId);
        // Another instance at, or inside, the worktree folder still needs it.
        const shared: boolean = draft.instances.some((other) => isSameOrInside(current.locationPath, other.locationPath));
        return { result: { removedByThisRequest: true, shared }, nextState: draft };
      });

      const worktree = preInstance.worktree;
      if (!removal.removedByThisRequest || worktree === undefined) {
        response.status(204).end();
        return;
      }
      // Under the worktree-ops lock, with a fresh look at the instances: a creation that reused
      // this worktree may have been saved while this request waited for its turn, and `shared`
      // above predates it. Paths are compared resolved, so a symlinked registration counts.
      const releaseWorktreeOps: () => void = await acquireWorktreeOpsLock();
      let warning: string | null;
      try {
        const resolvedWorktree: string = await resolvedPath(preInstance.locationPath);
        let sharedNow: boolean = removal.shared;
        for (const other of (await loadState()).instances) {
          if (isSameOrInside(resolvedWorktree, await resolvedPath(other.locationPath))) {
            sharedNow = true;
            break;
          }
        }
        warning = await removeWorktreeIfClean(preInstance.locationPath, worktree, sharedNow);
      } finally {
        releaseWorktreeOps();
      }
      if (warning === null) {
        response.status(204).end();
      } else {
        response.status(200).json({ warning });
      }
    });
  })
);

