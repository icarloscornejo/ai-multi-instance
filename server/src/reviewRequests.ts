import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { GitError, isRemoteUnreachableError, NETWORK_GIT_TIMEOUT_MS, runGit, type BranchUpstream } from "./git";
import { stateFilePath, writeStateFileAtomic } from "./store";

const execFileAsync = promisify(execFile);

// Finds the merge request / pull request of the checked-out branch without any API token: GitLab
// and GitHub publish every MR/PR head as a plain git ref (refs/merge-requests/N/head,
// refs/pull/N/head), so `git ls-remote` with the same ssh/https auth the user already pushes with
// lists them all. The answer is a number and a link, not the MR state (open/merged/CI): that
// would need the host's API and a token.

export type ReviewKind = "gitlab" | "github";
export interface ReviewRef {
  number: number;
  kind: ReviewKind;
}

export type ReviewRequest =
  | { state: "found"; number: number; kind: ReviewKind; url: string | null; checkedAt: string; stale: boolean }
  | { state: "none"; checkedAt: string; stale: boolean }
  | { state: "unknown" };

// ls-remote on a 1000-MR GitLab took ~3s over the VPN. The ssh ConnectTimeout in git.ts's
// hardened env is what makes an unreachable host fail in ~10s; this is only the ceiling for a
// listing that connected and then wedged.
const LIST_TIMEOUT_MS: number = NETWORK_GIT_TIMEOUT_MS / 4;
// ~80 bytes per ref: 32 MiB holds the refs of a repo with ~400k PRs.
const LIST_MAX_BUFFER_BYTES: number = 32 * 1024 * 1024;
const REFRESH_INTERVAL_MS = 60_000;
// Right after a push the branch tip moves but the cached listing still holds the old MR head:
// look again sooner, once, instead of showing "no MR" for a minute.
const EARLY_REFRESH_INTERVAL_MS = 10_000;
// GitLab moves refs/merge-requests/N/head asynchronously after a push, so a listing taken seconds
// after it can still hold the old head: it only counts as proof the MR is gone after this long.
const HOST_LAG_GRACE_MS = 30_000;
// live-status polls at 1 Hz and answering costs several git processes: reuse the answer briefly.
const ANSWER_MEMO_TTL_MS = 5_000;
// `git remote` + get-url + `ssh -G` per remote; remotes almost never change.
const TARGETS_MEMO_TTL_MS = 30_000;
const SSH_RESOLVE_TIMEOUT_MS = 5_000;

export function parseReviewRefs(lsRemoteOutput: string): Map<string, ReviewRef> {
  const refsBySha: Map<string, ReviewRef> = new Map();
  for (const line of lsRemoteOutput.split("\n")) {
    const match = /^([0-9a-f]{40,64})\trefs\/(merge-requests|pull)\/(\d+)\/head$/.exec(line.trim());
    if (match === null) continue;
    const number: number = Number(match[3]);
    const existing: ReviewRef | undefined = refsBySha.get(match[1]);
    // Two MRs can share a tip (a stacked branch pushed unchanged): the newest is the live one.
    if (existing === undefined || number > existing.number) {
      refsBySha.set(match[1], { number, kind: match[2] === "pull" ? "github" : "gitlab" });
    }
  }
  return refsBySha;
}

// Reduces any remote URL to host + path, dropping what must never reach a response, a log or a
// link: credentials (https://user:token@host/...), the ssh port, ".git" and trailing slashes.
// Null for remotes that are not a hosted repo (a local path, file://).
export function parseRemoteUrl(rawUrl: string): { host: string; path: string; overSsh: boolean } | null {
  const trimmed: string = rawUrl.trim();
  let host: string;
  let repositoryPath: string;
  let overSsh: boolean;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    repositoryPath = parsed.pathname;
    overSsh = parsed.protocol === "ssh:";
  } else {
    // scp-like: [user@]host:path
    const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
    if (scpLike === null) return null;
    host = scpLike[1];
    repositoryPath = scpLike[2];
    overSsh = true;
  }
  const cleanPath: string = repositoryPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return host === "" || cleanPath === "" ? null : { host, path: cleanPath, overSsh };
}

export function buildReviewUrl(host: string, repositoryPath: string, ref: ReviewRef): string {
  const tail: string = ref.kind === "github" ? `pull/${ref.number}` : `-/merge_requests/${ref.number}`;
  return `https://${host}/${repositoryPath}/${tail}`;
}

// `git@indeed:group/repo.git` names an ssh alias, not a web host: ssh's own config knows the
// real HostName. `ssh -G` only prints the resolved config, it never connects.
const sshHostnameByAlias: Map<string, string> = new Map();

async function resolveSshHostname(alias: string): Promise<string> {
  const cached: string | undefined = sshHostnameByAlias.get(alias);
  if (cached !== undefined) return cached;
  let hostname: string = alias;
  // The alias comes from a repo's own config: refuse anything ssh could read as an option
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
    try {
      const { stdout } = await execFileAsync("ssh", ["-G", alias], { timeout: SSH_RESOLVE_TIMEOUT_MS });
      hostname = /^hostname (\S+)$/m.exec(stdout)?.[1] ?? alias;
    } catch {
      // ssh missing or the alias is not parseable: the alias itself is the best host we have
    }
  }
  sshHostnameByAlias.set(alias, hostname);
  return hostname;
}

interface RemoteTarget {
  // host/path: what the cache is keyed by, so clones of one repo (and a repo's several remotes
  // that point at it) share a single listing
  key: string;
  remoteName: string;
  host: string;
  path: string;
}

const targetsMemo: Map<string, { at: number; targets: RemoteTarget[] }> = new Map();

async function listRemoteTargets(cwd: string, nowMs: number): Promise<RemoteTarget[]> {
  const memo = targetsMemo.get(cwd);
  if (memo !== undefined && nowMs - memo.at < TARGETS_MEMO_TTL_MS) return memo.targets;
  const targets: RemoteTarget[] = [];
  const seenKeys: Set<string> = new Set();
  const remoteNames: string[] = (await runGit(cwd, ["remote"])).split("\n").filter((name) => name !== "");
  for (const remoteName of remoteNames) {
    const rawUrl: string | null = await runGit(cwd, ["remote", "get-url", remoteName]).catch(() => null);
    const parsed = rawUrl === null ? null : parseRemoteUrl(rawUrl);
    if (parsed === null) continue;
    const host: string = (parsed.overSsh ? await resolveSshHostname(parsed.host) : parsed.host).toLowerCase();
    const key: string = `${host}/${parsed.path}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    targets.push({ key, remoteName, host, path: parsed.path });
  }
  targetsMemo.set(cwd, { at: nowMs, targets });
  return targets;
}

interface RemoteCache {
  refs: Map<string, ReviewRef>;
  // Last successful listing (null: never listed, nothing to answer from)
  checkedAt: number | null;
  lastAttemptAt: number;
  // False after a failed attempt, and for what was loaded from disk until a refresh succeeds
  lastAttemptOk: boolean;
  // The MR each branch last matched: keeps being shown (as stale) while the listing has not yet
  // caught up with a push, instead of flashing "no MR"
  lastMatchByBranch: Map<string, ReviewRef>;
  // In memory only: when this process first saw each branch at its current tip
  sightings: Map<string, { sha: string; at: number; moved: boolean }>;
  inFlight: Promise<void> | null;
}

const caches: Map<string, RemoteCache> = new Map();
let persistedLoad: Promise<void> | null = null;
let persistChain: Promise<void> = Promise.resolve();
let lastPersistedJson = "";
const answerMemo: Map<string, { at: number; answer: ReviewRequest | null }> = new Map();

function newCache(): RemoteCache {
  return {
    refs: new Map(),
    checkedAt: null,
    lastAttemptAt: 0,
    lastAttemptOk: false,
    lastMatchByBranch: new Map(),
    sightings: new Map(),
    inFlight: null,
  };
}

// Resolved lazily, never at import: instancesRoute.test.ts mocks ./store with a handful of
// exports and a module-level read of anything else would throw while loading this file.
function persistedFilePath(): string {
  return path.join(path.dirname(stateFilePath), "review-requests.json");
}

interface PersistedFile {
  version: 1;
  entries: Record<string, { checkedAt: number; refs: Record<string, ReviewRef>; lastMatchByBranch: Record<string, ReviewRef> }>;
}

// So the "may be outdated" answer survives a server restart: tsx watch, the service restart and
// the updater restart this process often, and without a copy on disk "VPN off + restart" has
// nothing to show.
async function loadPersisted(): Promise<void> {
  let parsed: PersistedFile;
  try {
    parsed = JSON.parse(await fs.readFile(persistedFilePath(), "utf8")) as PersistedFile;
  } catch (error) {
    const code: string | undefined = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[server] ignoring unreadable review request cache: ${(error as Error).name}`);
    }
    return;
  }
  if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) return;
  for (const [key, saved] of Object.entries(parsed.entries)) {
    if (typeof saved?.checkedAt !== "number" || typeof saved.refs !== "object" || saved.refs === null) continue;
    const cache: RemoteCache = newCache();
    cache.checkedAt = saved.checkedAt;
    cache.refs = new Map(Object.entries(saved.refs));
    cache.lastMatchByBranch = new Map(Object.entries(saved.lastMatchByBranch ?? {}));
    caches.set(key, cache);
  }
}

function persist(): void {
  const file: PersistedFile = { version: 1, entries: {} };
  for (const [key, cache] of caches) {
    if (cache.checkedAt === null) continue;
    file.entries[key] = {
      checkedAt: cache.checkedAt,
      refs: Object.fromEntries(cache.refs),
      lastMatchByBranch: Object.fromEntries(cache.lastMatchByBranch),
    };
  }
  // ponytail: whole listing per remote on every change, ~100 KB for 1000 MRs; a repo with tens of
  // thousands of PRs writes megabytes, keep only the refs that were asked about if that hurts.
  const json: string = JSON.stringify(file);
  if (json === lastPersistedJson) return;
  lastPersistedJson = json;
  // One write at a time: two remotes finishing together must not interleave on the same file
  persistChain = persistChain
    .then(() => writeStateFileAtomic(persistedFilePath(), json))
    .catch((error: unknown) => console.warn(`[server] could not save the review request cache: ${(error as Error).message}`));
}

function startRefresh(cache: RemoteCache, target: RemoteTarget, cwd: string, nowMs: number): void {
  cache.lastAttemptAt = nowMs;
  cache.inFlight = (async () => {
    try {
      const output: string = await runGit(
        cwd,
        ["ls-remote", target.remoteName, "refs/merge-requests/*/head", "refs/pull/*/head"],
        LIST_TIMEOUT_MS,
        LIST_MAX_BUFFER_BYTES
      );
      cache.refs = parseReviewRefs(output);
      // When the listing STARTED: a tip that moved while it was in flight is newer than it, and
      // must not count as covered by it
      cache.checkedAt = nowMs;
      cache.lastAttemptOk = true;
      persist();
    } catch (error) {
      cache.lastAttemptOk = false;
      // Never the error text: git quotes the remote URL, which can carry credentials
      const reason: string = isRemoteUnreachableError(error)
        ? "remote unreachable"
        : error instanceof GitError
          ? `git exited with ${error.code ?? "no code"}`
          : "unexpected error";
      console.warn(`[server] could not list the merge requests of ${target.key}: ${reason}`);
    } finally {
      cache.inFlight = null;
    }
  })();
}

type Lookup =
  | { kind: "found"; ref: ReviewRef; stale: boolean; checkedAt: number }
  | { kind: "none"; stale: boolean; checkedAt: number }
  | { kind: "missing" };

function lookup(cache: RemoteCache, branch: string, sha: string): Lookup {
  if (cache.checkedAt === null) return { kind: "missing" };
  const listed: ReviewRef | undefined = cache.refs.get(sha);
  if (listed !== undefined) {
    if (cache.lastMatchByBranch.get(branch)?.number !== listed.number) {
      cache.lastMatchByBranch.set(branch, listed);
      persist();
    }
    return { kind: "found", ref: listed, stale: !cache.lastAttemptOk, checkedAt: cache.checkedAt };
  }
  const remembered: ReviewRef | undefined = cache.lastMatchByBranch.get(branch);
  if (remembered !== undefined) {
    const sighting = cache.sightings.get(branch);
    // A listing taken before this tip, or within the host's lag after it, cannot tell yet whether
    // the MR follows the push
    if (sighting === undefined || cache.checkedAt < sighting.at + HOST_LAG_GRACE_MS) {
      return { kind: "found", ref: remembered, stale: true, checkedAt: cache.checkedAt };
    }
    // A listing taken well after the tip moved still does not have it: the MR is gone
    cache.lastMatchByBranch.delete(branch);
    persist();
  }
  return { kind: "none", stale: !cache.lastAttemptOk, checkedAt: cache.checkedAt };
}

// Branches that cannot own a review request of their own, where matching by commit would credit
// them with someone else's: the remote's default branch (after a fast-forward merge its tip IS
// the merged MR's head) and a branch with no commits outside every other remote branch (a
// stacked branch pushed at its parent's tip).
async function mayOwnReviewRequest(cwd: string, upstream: Extract<BranchUpstream, { state: "tracking" }>): Promise<boolean> {
  const defaultBranchRefs: string[] = (await runGit(cwd, ["for-each-ref", "--format=%(symref)", "refs/remotes/*/HEAD"])).split("\n");
  if (defaultBranchRefs.includes(upstream.pushRef)) return false;
  // --exclude patterns are matched without the refs/remotes/ prefix. "*/<branch>" also drops the
  // same branch on other remotes (a fork's mirror of it), which would otherwise hide every commit.
  const ownCommits: number = Number(
    await runGit(cwd, ["rev-list", "--count", upstream.pushRef, "--not", `--exclude=*/${upstream.branch}`, "--exclude=*/HEAD", "--remotes"])
  );
  return ownCommits > 0;
}

// Null: nothing worth showing (not tracking a remote, or a branch that cannot own a request, or
// no hosted remote). Never waits for the network: a stale or empty answer is returned at once and
// a refresh runs in the background, so the 1 Hz live-status poll stays fast with the VPN off.
export async function reviewRequestFor(cwd: string, upstream: BranchUpstream, nowMs: number = Date.now()): Promise<ReviewRequest | null> {
  if (upstream.state !== "tracking") return null;
  const memoKey = `${cwd}\0${upstream.pushRef}`;
  const memo = answerMemo.get(memoKey);
  if (memo !== undefined && nowMs - memo.at < ANSWER_MEMO_TTL_MS) return memo.answer;

  const answer: ReviewRequest | null = await computeAnswer(cwd, upstream, nowMs);
  answerMemo.set(memoKey, { at: nowMs, answer });
  return answer;
}

async function computeAnswer(cwd: string, upstream: Extract<BranchUpstream, { state: "tracking" }>, nowMs: number): Promise<ReviewRequest | null> {
  if (!(await mayOwnReviewRequest(cwd, upstream))) return null;
  const sha: string = await runGit(cwd, ["rev-parse", upstream.pushRef]);
  // The push remote first: it is where this branch's MR is most likely to live
  const targets: RemoteTarget[] = (await listRemoteTargets(cwd, nowMs)).slice().sort(
    (left, right) => Number(right.remoteName === upstream.remoteName) - Number(left.remoteName === upstream.remoteName)
  );
  if (targets.length === 0) return null;
  persistedLoad ??= loadPersisted();
  await persistedLoad;

  const lookups: { target: RemoteTarget; result: Lookup }[] = targets.map((target) => {
    let cache: RemoteCache | undefined = caches.get(target.key);
    if (cache === undefined) {
      cache = newCache();
      caches.set(target.key, cache);
    }
    const previous = cache.sightings.get(upstream.branch);
    if (previous === undefined || previous.sha !== sha) {
      cache.sightings.set(upstream.branch, { sha, at: nowMs, moved: previous !== undefined });
    }
    const sighting = cache.sightings.get(upstream.branch)!;
    const tipAwaitsListing: boolean = sighting.moved && (cache.checkedAt === null || cache.checkedAt < sighting.at) && !cache.refs.has(sha);
    const interval: number = tipAwaitsListing ? EARLY_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
    if (cache.inFlight === null && nowMs - cache.lastAttemptAt >= interval) {
      startRefresh(cache, target, cwd, nowMs);
    }
    return { target, result: lookup(cache, upstream.branch, sha) };
  });

  const found = lookups.find((entry) => entry.result.kind === "found");
  if (found !== undefined && found.result.kind === "found") {
    return {
      state: "found",
      number: found.result.ref.number,
      kind: found.result.ref.kind,
      url: buildReviewUrl(found.target.host, found.target.path, found.result.ref),
      checkedAt: new Date(found.result.checkedAt).toISOString(),
      stale: found.result.stale,
    };
  }
  // "No MR" is only an answer when every remote has been heard from: with one silent (the VPN
  // one) the MR may well be there.
  const answered = lookups.flatMap((entry) => (entry.result.kind === "none" ? [entry.result] : []));
  if (answered.length < lookups.length) return { state: "unknown" };
  return {
    state: "none",
    checkedAt: new Date(Math.min(...answered.map((entry) => entry.checkedAt))).toISOString(),
    stale: answered.some((entry) => entry.stale),
  };
}

// Tests only
export function _resetReviewRequestsForTests(): void {
  caches.clear();
  answerMemo.clear();
  targetsMemo.clear();
  sshHostnameByAlias.clear();
  persistedLoad = null;
  lastPersistedJson = "";
}

// Tests only: lets a test wait for the background refreshes and the disk writes it triggered
export async function _settleReviewRequestsForTests(): Promise<void> {
  await Promise.all([...caches.values()].map((cache) => cache.inFlight));
  await persistChain;
}
