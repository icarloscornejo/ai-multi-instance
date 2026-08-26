import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { isCommitPublished, readManifest } from "./frontendPublish";
import {
  lockTargetPath as transactionLockPath,
  spawnAndAwaitUpdateTransaction,
  spawnUpdateTransaction,
  transactionResultPath,
  webDistDir,
  type TransactionResult,
} from "./updateTransaction";
import fs from "node:fs";

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
  currentVersion: string | null;
  remoteVersion: string | null;
  requiredUpdate: boolean;
  // HEAD is not an ancestor of origin/main and the two commits differ (e.g. after a
  // force-pushed history rewrite upstream)
  diverged: boolean;
  // origin/main..HEAD: commits only reachable locally, shown before a destructive reset
  localOnlyCommits: ChangelogEntry[];
  // true when HEAD's tree differs from origin/main's: a reset would discard real content,
  // not just replay the same tree under different commit hashes
  resetLosesWork: boolean;
  // The commit the frontend actually being served (web/dist) was built from, per its own
  // manifest (frontendPublish.ts) - independent of `currentCommit` (that's just HEAD). These two
  // can differ for a while after HEAD moves: see frontendPublishPending.
  publishedCommit: string | null;
  // True whenever `currentCommit !== publishedCommit`: HEAD has moved (or nothing has ever been
  // published) and the frontend build hasn't caught up yet, whether because a transaction is
  // currently running or because the last one failed. Kept separate from `pendingRestart`/
  // `lastError` (which are about git and server-process state) because publishing the frontend is
  // now an asynchronous step that git being up to date says nothing about.
  frontendPublishPending: boolean;
  // Set from the last failed update-transaction's blockedReason/error (updateTransaction.ts), and
  // NOT cleared just because a later checkForUpdate's git-side polling succeeds: a build or
  // publish failure must stay visible until a transaction actually succeeds, or a real failure
  // would get silently hidden by the very next 30s poll.
  frontendPublishError: string | null;
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
  currentVersion: null,
  remoteVersion: null,
  requiredUpdate: false,
  diverged: false,
  localOnlyCommits: [],
  resetLosesWork: false,
  publishedCommit: null,
  frontendPublishPending: false,
  frontendPublishError: null,
};

// A required update forces auto-install on a countdown with no way to dismiss it, so it
// must only trigger on an intentional major bump, never on a parse hiccup or missing field
export function isMajorBump(localVersion: string | null, remoteVersion: string | null): boolean {
  if (localVersion === null || remoteVersion === null) {
    return false;
  }
  const localMajor: RegExpMatchArray | null = localVersion.match(/^(\d+)\./);
  const remoteMajor: RegExpMatchArray | null = remoteVersion.match(/^(\d+)\./);
  if (localMajor === null || remoteMajor === null) {
    return false;
  }
  return parseInt(remoteMajor[1], 10) > parseInt(localMajor[1], 10);
}

// Three effects a changed path can have, no longer just two: `tsx watch` restarts the server
// process automatically for anything under server/src, with nothing else needed. A change that
// feeds the frontend BUILD (web/src, plus everything else Vite reads to produce it) is also
// unattended, but on a different, asynchronous timeline: LAN/tunnel visitors are served the
// prebuilt web/dist (server/src/index.ts, server/src/tunnel.ts - Caddy proxies to Express, not to
// Vite's dev server), reconstructed by updateTransaction.ts, so "auto" here means "no manual
// relaunch needed", not "already live" - see reconcileFrontendPublish below for what actually
// gates that. Anything else (root package.json, vite.config.ts's own config semantics changing in
// a way a rebuild can't paper over, unrelated root configs) still needs a manual relaunch.
const FRONTEND_BUILD_PREFIXES = ["web/src/", "web/index.html", "web/public/", "web/vite.config.ts", "web/package.json"];
const FRONTEND_BUILD_EXACT_PATHS = ["package-lock.json"];

function affectsFrontendBuild(changedPath: string): boolean {
  return (
    FRONTEND_BUILD_PREFIXES.some((prefix) => changedPath.startsWith(prefix)) ||
    FRONTEND_BUILD_EXACT_PATHS.includes(changedPath)
  );
}

function classifyRestartKind(changedPaths: string[]): RestartKind {
  if (changedPaths.length === 0) {
    return "none";
  }
  const needsManualRestart: boolean = changedPaths.some(
    (changedPath) => !changedPath.startsWith("server/src/") && !affectsFrontendBuild(changedPath)
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

// Distinguishes a divergence that only replays identical content under different commit
// hashes (safe to auto-reset) from one that carries real local-only content (destructive)
async function inspectDivergence(): Promise<{ localOnlyCommits: ChangelogEntry[]; resetLosesWork: boolean }> {
  const localOnlyCommits: ChangelogEntry[] = await getChangelog("origin/main", "HEAD");
  let resetLosesWork = true;
  try {
    await runGit(["diff", "--quiet", "origin/main", "HEAD"]);
    resetLosesWork = false;
  } catch {
    resetLosesWork = true;
  }
  return { localOnlyCommits, resetLosesWork };
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

async function getVersion(ref: "HEAD" | "origin/main"): Promise<string | null> {
  try {
    const packageJson: string = await runGit(["show", `${ref}:package.json`]);
    const parsed: unknown = JSON.parse(packageJson);
    const version: unknown = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

async function refreshVersionStatus(): Promise<void> {
  status.currentVersion = await getVersion("HEAD");
  status.remoteVersion = await getVersion("origin/main");
  status.requiredUpdate = status.updateAvailable && isMajorBump(status.currentVersion, status.remoteVersion);
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
  // A server/src-only change is already live via tsx watch, with no real process restart coming
  // to bump startedAtCommit on its own: track it here instead, or the banner would report a
  // pending restart forever even after the user reloads the page. A change that touches the
  // frontend build is different: it's "auto" in the sense that no MANUAL action is needed, but
  // it is NOT live yet until updateTransaction.ts actually publishes it - reconcileFrontendPublish
  // (called right after this, see checkForUpdate/applyUpdate/resetToRemote) is what clears
  // pendingRestart for that case, once the published commit really matches.
  if (status.restartKind === "auto" && !frontendBuildIsPending(currentCommit)) {
    status.startedAtCommit = currentCommit;
    status.pendingRestart = false;
  }
}

// Cheap, synchronous: true whenever the frontend actually being served hasn't caught up to
// `currentCommit` yet. Shared by refreshRestartStatus (to decide whether "auto" can already be
// considered resolved) and reconcileFrontendPublish (to decide whether to spawn a transaction).
function frontendBuildIsPending(currentCommit: string): boolean {
  return !isCommitPublished(webDistDir, currentCommit);
}

// Brings status.publishedCommit/frontendPublishPending/frontendPublishError in line with reality,
// and spawns a transaction if the frontend is behind and nothing is already working on it.
// Called after every checkForUpdate/applyUpdate/resetToRemote, and once at server startup (see
// index.ts) - see updateTransaction.ts's header comment for why a separate, detached process
// (not this one) does the actual work.
async function reconcileFrontendPublish(currentCommit: string): Promise<void> {
  const manifest = readManifest(webDistDir);
  status.publishedCommit = manifest?.commit ?? null;
  status.frontendPublishPending = frontendBuildIsPending(currentCommit);

  if (!status.frontendPublishPending) {
    status.frontendPublishError = null;
    return;
  }

  // A transaction may already be running (spawned by this reconciliation a moment ago, by
  // applyUpdate's explicit trigger, or by `setup.sh` run by hand) - checking the real
  // cross-process lock, not an in-memory flag, is what makes this safe to call on every poll
  // without piling up redundant child processes (see updateTransaction.ts's header comment on
  // why an in-memory-only guard can't see setup.sh at all).
  const alreadyRunning: boolean = await lockfile
    .check(transactionLockPath)
    .catch(() => false); // lock target may not exist yet on a fresh checkout - not running, not an error
  if (!alreadyRunning) {
    spawnUpdateTransaction();
  }

  try {
    const lastResult = JSON.parse(fs.readFileSync(transactionResultPath, "utf8")) as TransactionResult;
    // Only surface a failure if it's about the commit we're actually waiting on: a stale failure
    // from a past, already-resolved attempt must not haunt the UI forever.
    status.frontendPublishError =
      !lastResult.ok && lastResult.commit === currentCommit ? (lastResult.blockedReason ?? lastResult.error) : null;
  } catch {
    status.frontendPublishError = null;
  }
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status };
}

// Called once at server startup (see index.ts), after httpServer.listen() so Express serves
// whatever is already in web/dist - stale or not - instead of blocking startup on a build. This is
// what lets a transaction interrupted by a `tsx` restart (see updateTransaction.ts's header
// comment) self-heal without any user action: the new process, on its very first reconciliation,
// notices the manifest doesn't match HEAD and spawns a transaction again.
export async function reconcileFrontendPublishOnStartup(): Promise<void> {
  try {
    const currentCommit: string = await runGit(["rev-parse", "HEAD"]);
    await reconcileFrontendPublish(currentCommit);
  } catch (error) {
    // Never let a reconciliation failure at boot take the server down with it - see
    // frontendPublish.ts's header comment on the same principle for its own read path.
    console.error("[updater] frontend publish reconciliation failed at startup:", (error as Error).message);
  }
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
      status.changelog = behindRemote ? await getChangelog(currentCommit, remoteCommit) : [];
      if (behindRemote) {
        status.diverged = false;
        status.localOnlyCommits = [];
        status.resetLosesWork = false;
        status.blockedReason = null;
      } else {
        const divergence = await inspectDivergence();
        status.diverged = true;
        status.localOnlyCommits = divergence.localOnlyCommits;
        status.resetLosesWork = divergence.resetLosesWork;
        status.blockedReason = divergence.resetLosesWork
          ? `Local history diverges from origin/main with ${divergence.localOnlyCommits.length} local ${
              divergence.localOnlyCommits.length === 1 ? "commit" : "commits"
            } not on origin/main.`
          : null;
      }
    } else {
      status.updateAvailable = false;
      status.blockedReason = null;
      status.changelog = [];
      status.diverged = false;
      status.localOnlyCommits = [];
      status.resetLosesWork = false;
    }

    await refreshVersionStatus();
    await refreshRestartStatus(currentCommit);
    await reconcileFrontendPublish(currentCommit);
    status.lastError = null;
  } catch (error) {
    status.lastError = (error as Error).message;
  } finally {
    status.lastCheckAt = new Date().toISOString();
    updateInProgress = false;
  }
  return getUpdateStatus();
}

// Reflects a finished TransactionResult (updateTransaction.ts) into `status`, the same fields the
// old inline git logic used to set directly. Shared by applyUpdate and resetToRemote since both
// now just trigger a transaction and report its outcome, rather than doing git/npm/build
// themselves - see updateTransaction.ts's header comment for why that moved out of this process.
function applyTransactionResult(result: TransactionResult): void {
  if (result.commit !== null) {
    status.currentCommit = result.commit;
  }
  status.blockedReason = result.blockedReason;
  if (result.ok) {
    status.changelog = [];
    status.diverged = false;
    status.localOnlyCommits = [];
    status.resetLosesWork = false;
  }
}

// Applies an update previously reported by checkForUpdate. All the actual work - fetch,
// fast-forward or tagged reset, dependency install, frontend build and publish - runs inside
// updateTransaction.ts under its cross-process lock; this only triggers it and waits for the
// outcome (spawnAndAwaitUpdateTransaction survives this process being restarted mid-flight by
// `tsx`, since the transaction itself runs as a detached child - see that module's header comment).
// A divergence that would discard local content comes back as a blockedReason, same as before;
// resetToRemote below is the explicit, user-confirmed path past that.
async function runAndReportTransaction(options: { forceReset?: boolean } = {}): Promise<UpdateStatus> {
  if (updateInProgress) {
    return getUpdateStatus();
  }
  updateInProgress = true;
  try {
    const result: TransactionResult = await spawnAndAwaitUpdateTransaction(options);
    applyTransactionResult(result);
    const currentCommit: string = result.commit ?? (await runGit(["rev-parse", "HEAD"]));
    const remoteCommit: string = await runGit(["rev-parse", "origin/main"]).catch(() => currentCommit);
    status.remoteCommit = remoteCommit;
    status.currentSubject = await getSubject(currentCommit);
    status.updateAvailable = currentCommit !== remoteCommit;
    await refreshVersionStatus();
    await refreshRestartStatus(currentCommit);
    await reconcileFrontendPublish(currentCommit);
    status.lastError = result.ok ? null : (result.error ?? status.lastError);
  } catch (error) {
    status.lastError = (error as Error).message;
  } finally {
    status.lastCheckAt = new Date().toISOString();
    updateInProgress = false;
  }
  return getUpdateStatus();
}

export async function applyUpdate(): Promise<UpdateStatus> {
  return runAndReportTransaction();
}

// Explicit, user-confirmed recovery for a divergence that would discard local content
// (status.resetLosesWork === true). Goes through the exact same transaction as applyUpdate, with
// forceReset so a real content divergence (not just a content-identical one) is tagged and reset
// instead of blocking - the only difference from the user's perspective is that this path is only
// reached after they explicitly accepted losing the local-only commits already listed in
// status.localOnlyCommits.
export async function resetToRemote(): Promise<UpdateStatus> {
  return runAndReportTransaction({ forceReset: true });
}
