// Owns every mutation of the dashboard's own checkout: fetch, merge/reset, `npm install`, the
// frontend build, and publishing it (frontendPublish.ts). Both the server (updater.ts, from an
// HTTP-triggered "Update now") and `setup.sh` (a separate OS process the user runs by hand) go
// through this SAME module and the SAME cross-process lock, because verifying this repo's actual
// update path surfaced two things that make a lighter-weight approach unsafe:
//
// 1. `npm run dev` runs `tsx watch src/index.ts` (server/package.json): the server process itself
//    gets killed and relaunched by tsx whenever a commit touches server/src/. If the mutation
//    logic ran inline inside that process, an update that touches both server/src and web/src
//    could get its build killed mid-flight by its own side effect. Running the transaction as a
//    separate, detached child process (spawnUpdateTransaction below) means a `tsx` restart of the
//    parent never touches it: a detached, unref()'d child is not in the parent's process group and
//    survives the parent's death on POSIX.
// 2. `setup.sh` runs its own `git merge`/`npm install` directly, as an entirely separate OS
//    process, with zero coordination with the server. A lock that only protects the server's own
//    in-memory `updateInProgress` flag (still used for that purpose, see updater.ts) does nothing
//    against that. `proper-lockfile` gives real cross-process mutual exclusion, with staleness
//    judged by the lock file's mtime (which it refreshes periodically while held) rather than by
//    checking whether some remembered PID is still alive - a PID can be reused by an unrelated
//    process, which a home-grown PID-based lock has no way to detect.

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { isCommitPublished, publishStagingToDist } from "./frontendPublish";

const execFileAsync = promisify(execFile);

const dashboardRepoRoot: string = path.resolve(import.meta.dirname, "../..");
// Exported so updater.ts and index.ts reconcile against the exact same path this module publishes
// to, rather than each resolving it independently and risking drift.
export const webDistDir: string = path.join(dashboardRepoRoot, "web", "dist");
const webDistStagingDir: string = path.join(dashboardRepoRoot, "web", "dist-staging");
const updateStateDir: string = path.join(dashboardRepoRoot, ".update-state");
// Exported so updater.ts can ask "is a transaction running right now, anywhere" (via
// lockfile.checkSync) before deciding to spawn another one, without duplicating this path.
export const lockTargetPath: string = path.join(updateStateDir, "transaction.lock");
const dependencyReceiptPath: string = path.join(updateStateDir, "installed-lockfile.json");
// Written by the transaction process (which may be a separate OS process from the server, see
// spawnUpdateTransaction) so the server can observe the outcome without any IPC: it just reads
// this file. Read by updater.ts's reconciliation.
export const transactionResultPath: string = path.join(updateStateDir, "transaction-result.json");

export interface TransactionResult {
  ok: boolean;
  commit: string | null;
  blockedReason: string | null;
  error: string | null;
  finishedAt: string;
}

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

// Same distinction updater.ts's inspectDivergence made: a divergence that only replays identical
// content under different commit hashes (safe to auto-reset, but still tagged first - see the
// preexisting-bug fix below) versus one that carries real local-only content (must block).
async function contentIdenticalDespiteDivergence(): Promise<boolean> {
  try {
    await runGit(["diff", "--quiet", "origin/main", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function ensureUpdateStateDir(): void {
  fs.mkdirSync(updateStateDir, { recursive: true });
}

// proper-lockfile locks an existing file (it creates a `<file>.lock` directory next to it via an
// atomic mkdir); the target itself just needs to exist.
function ensureLockTargetExists(): void {
  ensureUpdateStateDir();
  if (!fs.existsSync(lockTargetPath)) {
    fs.writeFileSync(lockTargetPath, "");
  }
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Pure comparison, pulled out so it's testable without a real git checkout or npm install: the
// actual decision of "does this need a reinstall" is just this one comparison.
export function needsDependencyInstall(currentLockfileHashValue: string, receiptHashValue: string | null): boolean {
  return receiptHashValue !== currentLockfileHashValue;
}

function readDependencyReceipt(): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(dependencyReceiptPath, "utf8"));
    const hash: unknown = (parsed as { lockfileHash?: unknown }).lockfileHash;
    return typeof hash === "string" ? hash : null;
  } catch {
    return null;
  }
}

// temp+rename, same reasoning as frontendPublish.ts: a reader (this same reconciliation, on a
// future run) must never see a half-written receipt.
function writeDependencyReceipt(lockfileHash: string): void {
  ensureUpdateStateDir();
  const tempPath: string = `${dependencyReceiptPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify({ lockfileHash }));
  fs.renameSync(tempPath, dependencyReceiptPath);
}

function currentLockfileHash(): string {
  return sha256(fs.readFileSync(path.join(dashboardRepoRoot, "package-lock.json")));
}

// Preexisting bug, unrelated to the Android reload but fixed here since this is a full rewrite of
// this code path: the old logic ran `git checkout -- package-lock.json` BEFORE checking whether
// the tree was clean, silently discarding a legitimate local edit to the lockfile before the
// clean check ever saw it. This checks the lockfile's own status FIRST, and only ever discards
// churn that npm install itself produces (see reconcileDependencies below), never something that
// was already there when the transaction started.
async function isLockfileDirty(): Promise<boolean> {
  const output: string = await runGit(["status", "--porcelain", "--", "package-lock.json"]);
  return output !== "";
}

async function isWorkingTreeCleanExcludingLockfile(): Promise<boolean> {
  const output: string = await runGit(["status", "--porcelain", "--", ".", ":!package-lock.json"]);
  return output === "";
}

// Installs dependencies only if the lockfile actually changed since the last successful install
// (tracked by the receipt, not by the frontend's own build manifest - see this module's header
// comment on why those two are kept separate). Runs after merge/reset, so it always installs
// against the lockfile that's actually checked out.
async function reconcileDependencies(): Promise<void> {
  const currentHash: string = currentLockfileHash();
  if (!needsDependencyInstall(currentHash, readDependencyReceipt())) {
    return;
  }
  await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dashboardRepoRoot });
  // npm install can itself regenerate lockfile metadata; only discard that self-inflicted churn,
  // and only because we already confirmed above the lockfile had no OTHER pending local edits.
  await runGit(["checkout", "--", "package-lock.json"]).catch(() => undefined);
  writeDependencyReceipt(currentLockfileHash());
}

// Tags the abandoned HEAD before resetting, exactly like updater.ts's old performReset() already
// did - the preexisting bug fixed here is that setup.sh's own `git reset --hard` never did this,
// so a developer Mac with locally-diverged-but-content-identical history (e.g. after an upstream
// force-push) could lose commits with no recovery path. Both callers now go through this one path.
async function tagAndReset(remoteCommit: string): Promise<void> {
  await runGit(["tag", `pre-reset-${Date.now()}`]);
  await runGit(["reset", "--hard", remoteCommit]);
}

async function buildFrontendToStaging(): Promise<void> {
  fs.rmSync(webDistStagingDir, { recursive: true, force: true });
  await execFileAsync(
    "npm",
    ["run", "build", "--workspace", "web", "--", "--outDir", webDistStagingDir, "--emptyOutDir"],
    { cwd: dashboardRepoRoot }
  );
}

export interface RunUpdateTransactionOptions {
  // Set only by updater.ts's resetToRemote() after the user explicitly confirmed they accept
  // losing the local-only commits already listed in status.localOnlyCommits. Without this, a
  // divergence with real local-only content always blocks rather than discarding anything.
  forceReset?: boolean;
}

// The single entry point both updater.ts and setup.sh call. Never throws: every outcome, success
// or failure, is reported via the returned TransactionResult (and mirrored to disk by the CLI
// entry point below), because a thrown error here would otherwise crash whichever process called
// it - fine for setup.sh's foreground script, fatal for the server.
export async function runUpdateTransaction(options: RunUpdateTransactionOptions = {}): Promise<TransactionResult> {
  ensureLockTargetExists();
  let release: (() => Promise<void>) | null = null;
  try {
    // A short backoff, not a long wait: if another transaction is genuinely in flight (the server
    // and a manually-run setup.sh racing), this attempt just gives up and does nothing. The next
    // poll or the next setup.sh run will try again, no data is lost by skipping a cycle.
    release = await lockfile.lock(lockTargetPath, {
      stale: 10 * 60 * 1000, // long enough to cover a slow npm install + vite build
      retries: { retries: 3, minTimeout: 300, maxTimeout: 2000 },
    });
  } catch {
    return {
      ok: false,
      commit: null,
      blockedReason: null,
      error: "Another update transaction is already running.",
      finishedAt: new Date().toISOString(),
    };
  }

  try {
    // Checked FIRST, unconditionally - not only inside the "there's a new commit" branch below.
    // reconcileDependencies() (further down) can run `git checkout -- package-lock.json` to
    // discard npm's own regeneration churn EVEN when currentCommit already equals remoteCommit
    // (nothing to merge, but the lockfile itself changed locally, e.g. a dependency added by
    // hand). Gating this check on a commit divergence that might not exist would let exactly that
    // legitimate local edit get silently discarded the moment reconcileDependencies runs - this
    // was caught by dogfooding this exact code path while building it: adding `proper-lockfile`
    // itself as a real dependency got reverted this way before this check was hoisted here.
    if (await isLockfileDirty()) {
      return finish({
        ok: false,
        commit: null,
        blockedReason: "package-lock.json has uncommitted local changes; resolve or commit them first.",
        error: null,
      });
    }

    await runGit(["fetch", "--quiet", "origin", "main"]);
    const remoteCommit: string = await runGit(["rev-parse", "origin/main"]);
    let currentCommit: string = await runGit(["rev-parse", "HEAD"]);

    if (currentCommit !== remoteCommit) {
      const workingTreeClean: boolean = await isWorkingTreeCleanExcludingLockfile();
      if (!workingTreeClean) {
        return finish({
          ok: false,
          commit: currentCommit,
          blockedReason: "There are uncommitted local changes in the dashboard folder.",
          error: null,
        });
      }

      const behindRemote: boolean = await isBehindRemote();
      if (behindRemote) {
        await runGit(["merge", "--ff-only", "origin/main"]);
        currentCommit = remoteCommit;
      } else if ((await contentIdenticalDespiteDivergence()) || options.forceReset === true) {
        await tagAndReset(remoteCommit);
        currentCommit = remoteCommit;
      } else {
        return finish({
          ok: false,
          commit: currentCommit,
          blockedReason: "Local history diverges from origin/main with local commits not on origin/main.",
          error: null,
        });
      }
    }

    await reconcileDependencies();

    if (!isCommitPublished(webDistDir, currentCommit)) {
      await buildFrontendToStaging();
      publishStagingToDist({ stagingDir: webDistStagingDir, distDir: webDistDir, commit: currentCommit });
    }

    return finish({ ok: true, commit: currentCommit, blockedReason: null, error: null });
  } catch (error) {
    return finish({
      ok: false,
      commit: null,
      blockedReason: null,
      error: (error as Error).message,
    });
  } finally {
    // Staging is scratch space, not the published artifact - always safe to clear, whether this
    // attempt succeeded or not, so the next attempt never inherits a half-finished build.
    fs.rmSync(webDistStagingDir, { recursive: true, force: true });
    if (release !== null) {
      await release();
    }
  }
}

function finish(partial: Omit<TransactionResult, "finishedAt">): TransactionResult {
  return { ...partial, finishedAt: new Date().toISOString() };
}

function spawnTransactionChild(options: RunUpdateTransactionOptions) {
  const args: string[] = ["--import", "tsx", path.join(import.meta.dirname, "updateTransaction.ts"), "--run"];
  if (options.forceReset === true) {
    args.push("--force-reset");
  }
  return spawn(process.execPath, args, { cwd: dashboardRepoRoot, detached: true, stdio: "ignore" });
}

// Fire-and-forget from inside the tsx-watched server process: spawns this same file as a detached
// child (own process group, unref()'d) so a `tsx` restart of the caller never kills it - see this
// module's header comment for why that matters. The caller does not await completion; it should
// poll transactionResultPath or re-check frontendPublish.readManifest() later (updater.ts's
// reconciliation already does this on every checkForUpdate/applyUpdate call).
export function spawnUpdateTransaction(): void {
  spawnTransactionChild({}).unref();
}

// Same spawn, but for a caller (applyUpdate's HTTP handler) that wants to report the outcome of
// THIS attempt back to the user, not just kick it off. Still detached: if the awaiting process
// itself gets killed by a `tsx` restart partway through, the child keeps running and finishes on
// its own regardless of who was waiting on it - only this particular await is abandoned, not the
// transaction.
export async function spawnAndAwaitUpdateTransaction(
  options: RunUpdateTransactionOptions = {}
): Promise<TransactionResult> {
  const child = spawnTransactionChild(options);
  child.unref();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    return JSON.parse(fs.readFileSync(transactionResultPath, "utf8")) as TransactionResult;
  } catch {
    return {
      ok: false,
      commit: null,
      blockedReason: null,
      error: "Update transaction exited without reporting a result.",
      finishedAt: new Date().toISOString(),
    };
  }
}

// CLI entry point: `setup.sh` and spawnUpdateTransaction() both invoke this file directly rather
// than importing it, so both go through the exact same code path with no separate "script mode"
// logic to drift out of sync with the in-process one.
if (process.argv.includes("--run")) {
  const result: TransactionResult = await runUpdateTransaction({
    forceReset: process.argv.includes("--force-reset"),
  });
  ensureUpdateStateDir();
  fs.writeFileSync(transactionResultPath, JSON.stringify(result));
  if (!result.ok) {
    console.error("[update-transaction]", result.blockedReason ?? result.error);
  }
  process.exit(result.ok ? 0 : 1);
}
