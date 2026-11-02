import { promises as fs } from "node:fs";
import path from "node:path";
import { parseAgentStateFile, probePaneAgent, readAgentStateFile, type ParsedAgentStateFile } from "./agentState";
import { branchUpstream } from "./git";
import { invalidateToken, realTokenRun, resolveGithubToken, type TokenResult } from "./githubToken";
import { invalidateGitlabToken, resolveGitlabToken } from "./gitlabToken";
import type { PaneAgent } from "./paneAgent";
import {
  asId,
  canDeliver,
  collectEvents,
  dropStaleCiEvents,
  formatMessage,
  mergeQueue,
  pruneSeenIds,
  type PrEvent,
} from "./prEvents";
import { collectGitlabEvents, isSafeProjectPath, isValidGitlabHost, parseGitlabMr } from "./prEventsGitlab";
import { reviewRequestFor, type ReviewRequest } from "./reviewRequests";
import { withSessionLock } from "./sessionLock";
import { loadState, stateFilePath, writeStateFileAtomic } from "./store";
import { clientActivitySeconds, getPaneCurrentPath, pasteToSession } from "./tmux";
import type { DashboardState, InstanceRecord } from "./types";

export type PrEventsStatus = "ok" | "off" | "paused" | "no-token" | "no-pr" | "unsupported" | "error";

export interface PrEventsEntry {
  prNumber: number;
  headSha: string | null;
  seen: string[];
  queue: PrEvent[];
  // Written only for GitLab entries, so GitHub entries keep their exact shape.
  provider?: "gitlab";
  host?: string;
  project?: string;
}

interface StatusIdentity {
  provider: "gitlab";
  host?: string;
}

type StatusRecord = {
  status: PrEventsStatus;
  pending: number;
  provider?: "gitlab";
  host?: string;
};

export interface PrEventsFile {
  version: 1;
  instances: Record<string, PrEventsEntry>;
}

export interface PrEventsPollerDeps {
  now: () => number;
  loadState: () => Promise<DashboardState>;
  loadStore: () => Promise<unknown>;
  persist: (file: PrEventsFile) => Promise<void>;
  resolveReviewRequest: (instance: InstanceRecord) => Promise<ReviewRequest | null>;
  fetchGithub: (url: string, init: RequestInit) => Promise<Response>;
  resolveToken: () => Promise<TokenResult>;
  invalidateToken: () => void;
  // Optional so a poller built without GitLab support reports such instances as unsupported.
  resolveGitlabToken?: (host: string, envName: string | undefined, configuredHosts: Record<string, string>) => Promise<TokenResult>;
  invalidateGitlabToken?: (host: string) => void;
  readAgentState: (instance: InstanceRecord) => Promise<ParsedAgentStateFile | null>;
  probePane: (instance: InstanceRecord) => Promise<PaneAgent>;
  clientActivity: (tmuxSession: string) => Promise<number | null>;
  paste: (tmuxSession: string, text: string) => Promise<{ submitted: boolean }>;
  withLock: <T>(tmuxSession: string, run: () => Promise<T>) => Promise<T>;
  settleMs?: number;
}

const POLL_INTERVAL_MS = 60_000;
const DELIVER_INTERVAL_MS = 5_000;
const FIRST_POLL_DELAY_MS = 5_000;
const DEFAULT_SETTLE_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 5;
const USER_CACHE_MS = 10 * 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const LOG_THROTTLE_MS = 5 * 60_000;
const API_ORIGIN = "https://api.github.com/";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const PULL_PATH_PATTERN = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/;
const GITLAB_API_PATH = "/api/v4/";

// Module state, all in memory. The store is the single source of truth between the poll and the
// delivery tick: both mutate it synchronously at their commit points, so neither can write back
// a stale copy of what the other just changed (which would re-deliver a pasted event).
let memory: PrEventsFile | null = null;
let persistChain: Promise<void> = Promise.resolve();
const statuses = new Map<string, StatusRecord>();
let pollRunning = false;
let deliverRunning = false;
let backoffUntilMs = 0;
let userCache: { login: string; at: number } | null = null;
// GitLab keeps its own per-host state so one host's limits or rejected token never touch GitHub.
const gitlabBackoffUntilMs = new Map<string, number>();
const gitlabUserCache = new Map<string, { userId: number; at: number }>();
const lastLoggedAt = new Map<string, number>();

export function _resetPrEventsForTests(): void {
  memory = null;
  persistChain = Promise.resolve();
  statuses.clear();
  pollRunning = false;
  deliverRunning = false;
  backoffUntilMs = 0;
  userCache = null;
  gitlabBackoffUntilMs.clear();
  gitlabUserCache.clear();
  lastLoggedAt.clear();
}

export function getPrEventsStatus(): Record<string, StatusRecord> {
  const snapshot: Record<string, StatusRecord> = {};
  for (const [instanceId, entry] of statuses) {
    snapshot[instanceId] = {
      status: entry.status,
      pending: entry.pending,
      ...(entry.provider === "gitlab" ? { provider: "gitlab" as const } : {}),
      ...(entry.provider === "gitlab" && entry.host !== undefined ? { host: entry.host } : {}),
    };
  }
  return snapshot;
}

// Fixed strings only: an error object from fetch or execFile can carry headers, argv or output.
function logFixed(key: string, message: string, nowMs: number): void {
  const previous: number | undefined = lastLoggedAt.get(key);
  if (previous !== undefined && nowMs - previous < LOG_THROTTLE_MS) return;
  lastLoggedAt.set(key, nowMs);
  console.warn(`[server] PR events: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueuedEvent(value: unknown): value is PrEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "ci" || value.kind === "review") &&
    typeof value.author === "string" &&
    typeof value.link === "string" &&
    typeof value.label === "string" &&
    (value.sha === undefined || typeof value.sha === "string")
  );
}

// A corrupt entry counts as missing, so the next poll seeds it instead of queueing old events.
function parseEntry(value: unknown): PrEventsEntry | null {
  if (!isRecord(value)) return null;
  const { prNumber, headSha, seen, queue } = value;
  if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  if (headSha !== null && typeof headSha !== "string") return null;
  if (!Array.isArray(seen) || !seen.every((id) => typeof id === "string")) return null;
  if (!Array.isArray(queue)) return null;
  const base: PrEventsEntry = { prNumber, headSha, seen: seen as string[], queue: queue.filter(isQueuedEvent) };
  if (value.provider === undefined) return base;
  const { provider, host, project } = value;
  const isValidGitlabIdentity: boolean =
    provider === "gitlab" && typeof host === "string" && isValidGitlabHost(host) && typeof project === "string" && isSafeProjectPath(project);
  return isValidGitlabIdentity ? { ...base, provider: "gitlab", host: host as string, project: project as string } : null;
}

function parseStore(raw: unknown): PrEventsFile {
  const file: PrEventsFile = { version: 1, instances: {} };
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.instances)) return file;
  for (const [instanceId, value] of Object.entries(raw.instances)) {
    const entry: PrEventsEntry | null = parseEntry(value);
    if (entry !== null) file.instances[instanceId] = entry;
  }
  return file;
}

async function getFile(deps: PrEventsPollerDeps): Promise<PrEventsFile> {
  if (memory === null) {
    const loaded: PrEventsFile = parseStore(await deps.loadStore());
    memory ??= loaded;
  }
  return memory;
}

function persistMemory(deps: PrEventsPollerDeps): Promise<void> {
  if (memory === null) return persistChain;
  const snapshot: PrEventsFile = structuredClone(memory);
  persistChain = persistChain
    .then(() => deps.persist(snapshot))
    .catch(() => logFixed("persist", "could not save the event queue", deps.now()));
  return persistChain;
}

// identity: undefined keeps what the instance showed before, null clears it (a GitHub round).
function setStatus(instanceId: string, status: PrEventsStatus, pending: number, identity?: StatusIdentity | null): void {
  const shown: { provider?: "gitlab"; host?: string } | undefined | null = identity === undefined ? statuses.get(instanceId) : identity;
  statuses.set(instanceId, {
    status,
    pending,
    ...(shown?.provider === "gitlab" ? { provider: "gitlab" as const } : {}),
    ...(shown?.provider === "gitlab" && shown.host !== undefined ? { host: shown.host } : {}),
  });
}

class GithubFailure extends Error {
  constructor() {
    super("GitHub request failed");
    this.name = "GithubFailure";
  }
}

async function readCappedText(response: Response): Promise<string> {
  const declaredLength: number = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES || response.body === null) throw new GithubFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new GithubFailure();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function nextLink(linkHeader: string | null): string | null {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const target: string | undefined = /<([^>]+)>/.exec(part)?.[1];
    // Only ever follow links that stay on the API host: the bearer token rides on every request.
    if (target !== undefined && target.startsWith(API_ORIGIN)) return target;
  }
  return null;
}

function applyRateLimit(response: Response, nowMs: number): void {
  const resetSeconds: number = Number(response.headers.get("x-ratelimit-reset"));
  const waitMs: number = Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 - nowMs : DEFAULT_BACKOFF_MS;
  backoffUntilMs = nowMs + Math.min(Math.max(waitMs, DEFAULT_BACKOFF_MS), MAX_BACKOFF_MS);
}

async function githubGet(deps: PrEventsPollerDeps, token: string, url: string): Promise<{ body: unknown; next: string | null }> {
  let response: Response;
  try {
    response = await deps.fetchGithub(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-multi-instance-dashboard",
      },
    });
  } catch {
    throw new GithubFailure();
  }
  if (response.status === 401) {
    deps.invalidateToken();
    userCache = null;
    throw new GithubFailure();
  }
  const rateLimited: boolean =
    response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  if (rateLimited) {
    applyRateLimit(response, deps.now());
    throw new GithubFailure();
  }
  if (!response.ok) throw new GithubFailure();
  try {
    return { body: JSON.parse(await readCappedText(response)) as unknown, next: nextLink(response.headers.get("link")) };
  } catch {
    throw new GithubFailure();
  }
}

async function listAll(
  deps: PrEventsPollerDeps,
  token: string,
  firstUrl: string,
  pickItems: (body: unknown) => unknown
): Promise<unknown[]> {
  const items: unknown[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
    const { body, next } = await githubGet(deps, token, url);
    const pageItems: unknown = pickItems(body);
    if (!Array.isArray(pageItems)) throw new GithubFailure();
    items.push(...pageItems);
    url = next;
  }
  return items;
}

// The token owner's login, so their own reviews are not reported back to them. Null on failure:
// reviews are then held back for this round instead of risking an echo.
async function tokenOwnerLogin(deps: PrEventsPollerDeps, token: string): Promise<string | null> {
  const nowMs: number = deps.now();
  if (userCache !== null && nowMs - userCache.at < USER_CACHE_MS) return userCache.login;
  try {
    const { body } = await githubGet(deps, token, `${API_ORIGIN}user`);
    const login: unknown = isRecord(body) ? body.login : undefined;
    if (typeof login !== "string" || login === "" || login.length > 100) return null;
    userCache = { login, at: nowMs };
    return login;
  } catch {
    return null;
  }
}

function parseGithubPull(review: Extract<ReviewRequest, { state: "found" }>): { owner: string; repo: string } | null {
  if (review.kind !== "github" || review.url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(review.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "") return null;
  const match: RegExpExecArray | null = PULL_PATH_PATTERN.exec(parsed.pathname);
  if (match === null || Number(match[3]) !== review.number) return null;
  const [, owner, repo] = match;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { owner, repo };
}

function isPollable(instance: InstanceRecord): boolean {
  return instance.prEvents?.enabled === true && instance.prEvents.paused !== true && instance.shellOnly !== true && instance.provider === "claude";
}

function botLoginsOf(instance: InstanceRecord): string[] {
  const configured: unknown = instance.prEvents?.botLogins;
  return Array.isArray(configured) ? configured.filter((login): login is string => typeof login === "string") : [];
}

interface EntryIdentity {
  provider?: "gitlab";
  host?: string;
  project?: string;
}

// A different number, provider, host or project means a different review: its events are history.
function needsSeed(existing: PrEventsEntry | undefined, prNumber: number, identity: EntryIdentity): boolean {
  return (
    existing === undefined ||
    existing.prNumber !== prNumber ||
    existing.provider !== identity.provider ||
    existing.host !== identity.host ||
    existing.project !== identity.project
  );
}

interface RoundCommit {
  prNumber: number;
  headSha: string;
  identity: EntryIdentity;
  statusIdentity: StatusIdentity | null;
  reviewsUsable: boolean;
  collect: (includeReviews: boolean) => PrEvent[];
}

// Everything the round fetched is already in hand: from here on it is synchronous commits.
function commitRound(file: PrEventsFile, instanceId: string, existing: PrEventsEntry | undefined, round: RoundCommit): boolean {
  const { prNumber, headSha } = round;
  if (existing === undefined || needsSeed(existing, prNumber, round.identity)) {
    // An unusable review list still records every review id at seed time: over-recording is safe.
    const seedEvents: PrEvent[] = round.collect(true);
    file.instances[instanceId] = { prNumber, headSha, seen: seedEvents.map((event) => event.id), queue: [], ...round.identity };
    setStatus(instanceId, "ok", 0, round.statusIdentity);
    return true;
  }
  const events: PrEvent[] = round.collect(round.reviewsUsable);
  const seenIds = new Set<string>(existing.seen);
  const freshEvents: PrEvent[] = events.filter((event) => !seenIds.has(event.id));
  const heldBackReviewIds: string[] = round.reviewsUsable ? [] : existing.seen.filter((id) => id.startsWith("review:"));
  existing.seen = pruneSeenIds([...existing.seen, ...freshEvents.map((event) => event.id)], [
    ...events.map((event) => event.id),
    ...heldBackReviewIds,
  ]);
  existing.queue = mergeQueue(dropStaleCiEvents(existing.queue, headSha), freshEvents);
  existing.headSha = headSha;
  setStatus(instanceId, "ok", existing.queue.length, round.statusIdentity);
  return true;
}

class GitlabFailure extends Error {
  constructor() {
    super("GitLab request failed");
    this.name = "GitlabFailure";
  }
}

// A rejected token is a different problem from a flaky endpoint, so it is never swallowed.
class GitlabAuthFailure extends GitlabFailure {}

function applyGitlabRateLimit(host: string, response: Response, nowMs: number): void {
  const retryAfterSeconds: number = Number(response.headers.get("retry-after"));
  const resetEpochSeconds: number = Number(response.headers.get("ratelimit-reset"));
  let waitMs: number = DEFAULT_BACKOFF_MS;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) waitMs = retryAfterSeconds * 1000;
  else if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) waitMs = resetEpochSeconds * 1000 - nowMs;
  gitlabBackoffUntilMs.set(host, nowMs + Math.min(Math.max(waitMs, DEFAULT_BACKOFF_MS), MAX_BACKOFF_MS));
}

// Separate from githubGet on purpose: the bearer token goes only to https://<host>/api/v4/, one
// request per call, with no pagination and no URL ever taken from a response body or header.
async function gitlabGet(deps: PrEventsPollerDeps, host: string, token: string, relativePath: string): Promise<unknown> {
  const url = `https://${host}${GITLAB_API_PATH}${relativePath}`;
  const parsed = new URL(url);
  if (parsed.origin !== `https://${host}` || !parsed.pathname.startsWith(GITLAB_API_PATH)) throw new GitlabFailure();
  let response: Response;
  try {
    response = await deps.fetchGithub(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "ai-multi-instance-dashboard",
      },
    });
  } catch {
    throw new GitlabFailure();
  }
  if (response.status === 401) {
    deps.invalidateGitlabToken?.(host);
    gitlabUserCache.delete(host);
    throw new GitlabAuthFailure();
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get("retry-after") !== null)) {
    applyGitlabRateLimit(host, response, deps.now());
    throw new GitlabFailure();
  }
  if (!response.ok) throw new GitlabFailure();
  try {
    return JSON.parse(await readCappedText(response)) as unknown;
  } catch {
    throw new GitlabFailure();
  }
}

// Null on failure: approvals are then held back for this round instead of risking an echo.
async function gitlabTokenOwnerId(deps: PrEventsPollerDeps, host: string, token: string): Promise<number | null> {
  const nowMs: number = deps.now();
  const cached = gitlabUserCache.get(host);
  if (cached !== undefined && nowMs - cached.at < USER_CACHE_MS) return cached.userId;
  try {
    const body: unknown = await gitlabGet(deps, host, token, "user");
    const userId: number | null = asId(isRecord(body) ? body.id : undefined);
    if (userId === null) return null;
    gitlabUserCache.set(host, { userId, at: nowMs });
    return userId;
  } catch (error) {
    if (error instanceof GitlabAuthFailure) throw error;
    return null;
  }
}

async function pollGitlab(
  deps: PrEventsPollerDeps,
  file: PrEventsFile,
  instance: InstanceRecord,
  existing: PrEventsEntry | undefined,
  review: Extract<ReviewRequest, { state: "found" }>,
  configuredHosts: Record<string, string>
): Promise<boolean> {
  const queuedCount: number = existing?.queue.length ?? 0;
  const merge = parseGitlabMr(review);
  // The host is shown as soon as it is known and valid, even when nothing can be polled.
  const statusIdentity: StatusIdentity = merge === null ? { provider: "gitlab" } : { provider: "gitlab", host: merge.host };
  // A provisional status carries the identity into any early exit or failure of this round.
  const previous: StatusRecord = statuses.get(instance.id) ?? { status: "error", pending: queuedCount };
  setStatus(instance.id, previous.status, previous.pending, statusIdentity);
  if (merge === null || deps.resolveGitlabToken === undefined) {
    setStatus(instance.id, "unsupported", queuedCount, statusIdentity);
    return false;
  }
  const { host, projectPath, iid } = merge;
  // Checked before any token lookup so a limited host never spawns glab or git.
  if (deps.now() < (gitlabBackoffUntilMs.get(host) ?? 0)) return false;
  const envName: string | undefined = Object.hasOwn(configuredHosts, host) ? configuredHosts[host] : undefined;
  const tokenResult: TokenResult = await deps.resolveGitlabToken(host, envName, configuredHosts);
  if (!("token" in tokenResult)) {
    setStatus(instance.id, "no-token", queuedCount, statusIdentity);
    return false;
  }
  const { token } = tokenResult;
  const projectRef = `projects/${encodeURIComponent(projectPath)}`;

  const mergeRequest: unknown = await gitlabGet(deps, host, token, `${projectRef}/merge_requests/${iid}`);
  if (!isRecord(mergeRequest)) throw new GitlabFailure();
  if (mergeRequest.state !== "opened") {
    setStatus(instance.id, "no-pr", 0, statusIdentity);
    if (existing !== undefined && existing.queue.length > 0) {
      existing.queue = [];
      return true;
    }
    return false;
  }
  const headSha: unknown = mergeRequest.sha;
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) throw new GitlabFailure();

  // No head pipeline means no CI events this round: listing pipelines could pick one of an older head.
  let jobs: unknown[] = [];
  if (mergeRequest.head_pipeline !== null && mergeRequest.head_pipeline !== undefined) {
    const pipelineId: number | null = asId(isRecord(mergeRequest.head_pipeline) ? mergeRequest.head_pipeline.id : undefined);
    if (pipelineId === null) throw new GitlabFailure();
    const jobsBody: unknown = await gitlabGet(deps, host, token, `${projectRef}/pipelines/${pipelineId}/jobs?scope%5B%5D=failed&per_page=100`);
    if (!Array.isArray(jobsBody)) throw new GitlabFailure();
    jobs = jobsBody;
  }

  let approvals: unknown[] = [];
  let ownUserId: number | null = null;
  let approvalsUsable = false;
  try {
    const approvalsBody: unknown = await gitlabGet(deps, host, token, `${projectRef}/merge_requests/${iid}/approvals`);
    const approvedBy: unknown = isRecord(approvalsBody) ? approvalsBody.approved_by : undefined;
    ownUserId = await gitlabTokenOwnerId(deps, host, token);
    if (Array.isArray(approvedBy) && ownUserId !== null) {
      approvals = approvedBy;
      approvalsUsable = true;
    }
  } catch (error) {
    if (error instanceof GitlabAuthFailure) throw error;
  }
  const identity: EntryIdentity = { provider: "gitlab", host, project: projectPath };
  // Seeding without the approvals would queue every existing approval as new on the next round.
  if (!approvalsUsable && needsSeed(existing, iid, identity)) throw new GitlabFailure();

  const rules = { host, projectPath, iid, headSha, ownUserId, botLogins: botLoginsOf(instance) };
  return commitRound(file, instance.id, existing, {
    prNumber: iid,
    headSha,
    identity,
    statusIdentity,
    reviewsUsable: approvalsUsable,
    collect: (includeReviews) => collectGitlabEvents({ jobs, approvals: includeReviews ? approvals : [] }, rules),
  });
}

// Returns true when the persisted file changed.
async function pollInstance(
  deps: PrEventsPollerDeps,
  file: PrEventsFile,
  instance: InstanceRecord,
  configuredHosts: Record<string, string>
): Promise<boolean> {
  const existing: PrEventsEntry | undefined = file.instances[instance.id];
  const queuedCount: number = existing?.queue.length ?? 0;
  if (!isPollable(instance)) {
    const paused: boolean = instance.prEvents?.enabled === true && instance.prEvents.paused === true;
    setStatus(instance.id, paused ? "paused" : "off", queuedCount);
    // A disabled instance with nothing queued forgets its baseline, so enabling it again seeds.
    if (!paused && existing !== undefined && queuedCount === 0) {
      delete file.instances[instance.id];
      return true;
    }
    return false;
  }
  let review: ReviewRequest | null;
  try {
    review = await deps.resolveReviewRequest(instance);
  } catch {
    review = null;
  }
  // An unknown, stale or missing answer says nothing about the pull request: keep what we had.
  if (review === null || review.state === "unknown" || review.stale) return false;
  if (review.state === "none") {
    setStatus(instance.id, "no-pr", queuedCount);
    return false;
  }
  if (review.kind === "gitlab") return pollGitlab(deps, file, instance, existing, review, configuredHosts);
  // The GitHub rate limit pauses GitHub only, so it is checked here and not before the review kind is known.
  if (deps.now() < backoffUntilMs) return false;
  const repository = parseGithubPull(review);
  if (repository === null) {
    setStatus(instance.id, "unsupported", queuedCount, null);
    return false;
  }
  const { owner, repo } = repository;
  const prNumber: number = review.number;

  const tokenResult: TokenResult = await deps.resolveToken();
  if (!("token" in tokenResult)) {
    setStatus(instance.id, "no-token", queuedCount, null);
    return false;
  }
  const { token } = tokenResult;

  const pull = (await githubGet(deps, token, `${API_ORIGIN}repos/${owner}/${repo}/pulls/${prNumber}`)).body;
  if (!isRecord(pull)) throw new GithubFailure();
  if (pull.state !== "open") {
    setStatus(instance.id, "no-pr", 0, null);
    if (existing !== undefined && existing.queue.length > 0) {
      existing.queue = [];
      return true;
    }
    return false;
  }
  const headSha: unknown = isRecord(pull.head) ? pull.head.sha : undefined;
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) throw new GithubFailure();

  const checkRuns: unknown[] = await listAll(
    deps,
    token,
    `${API_ORIGIN}repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
    (body) => (isRecord(body) ? body.check_runs : undefined)
  );
  const reviews: unknown[] = await listAll(
    deps,
    token,
    `${API_ORIGIN}repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
    (body) => body
  );
  const ownLogin: string | null = await tokenOwnerLogin(deps, token);
  const reviewsUsable: boolean = ownLogin !== null;
  const rules = { owner, repo, prNumber, headSha, ownLogin, botLogins: botLoginsOf(instance) };

  return commitRound(file, instance.id, existing, {
    prNumber,
    headSha,
    identity: {},
    statusIdentity: null,
    reviewsUsable,
    collect: (includeReviews) => collectEvents({ checkRuns, reviews: includeReviews ? reviews : [] }, rules),
  });
}

export async function pollSweep(deps: PrEventsPollerDeps): Promise<void> {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const state: DashboardState = await deps.loadState();
    const file: PrEventsFile = await getFile(deps);
    let changed = false;
    const knownIds = new Set<string>(state.instances.map((instance) => instance.id));
    for (const instanceId of Object.keys(file.instances)) {
      if (!knownIds.has(instanceId)) {
        delete file.instances[instanceId];
        changed = true;
      }
    }
    for (const instanceId of statuses.keys()) {
      if (!knownIds.has(instanceId)) statuses.delete(instanceId);
    }
    const configuredHosts: Record<string, string> = state.config?.gitlabTokenEnv ?? {};
    for (const instance of state.instances) {
      try {
        if (await pollInstance(deps, file, instance, configuredHosts)) changed = true;
      } catch {
        setStatus(instance.id, "error", file.instances[instance.id]?.queue.length ?? 0);
      }
    }
    if (changed) await persistMemory(deps);
  } catch {
    logFixed("poll", "a poll round failed", deps.now());
  } finally {
    pollRunning = false;
  }
}

async function deliverOne(deps: PrEventsPollerDeps, instanceId: string, tmuxSession: string): Promise<void> {
  const settleMs: number = deps.settleMs ?? DEFAULT_SETTLE_MS;
  // Every condition is checked again inside the session lock, right before typing: the state the
  // sweep started from can be seconds old, and a paste into the wrong moment is not undoable.
  await deps.withLock(tmuxSession, async () => {
    const fresh: InstanceRecord | undefined = (await deps.loadState()).instances.find((candidate) => candidate.id === instanceId);
    if (fresh === undefined || !isPollable(fresh)) return;
    const entry: PrEventsEntry | undefined = memory?.instances[instanceId];
    if (entry === undefined || entry.queue.length === 0) return;
    const agentState: ParsedAgentStateFile | null = await deps.readAgentState(fresh);
    if (agentState === null) return;
    const agent: PaneAgent = await deps.probePane(fresh);
    const clientIdleSeconds: number | null = await deps.clientActivity(fresh.tmuxSession);
    const allowed: boolean = canDeliver({
      state: agentState.state,
      updatedAt: agentState.updatedAt,
      now: deps.now(),
      settleMs,
      shellOnly: fresh.shellOnly === true,
      provider: fresh.provider,
      paneMatches: agent.kind === "agent" && agent.provider === "claude" && agent.paneJobPid === agentState.paneJobPid,
      recentClientActivity: clientIdleSeconds !== null && clientIdleSeconds * 1000 < settleMs,
    });
    if (!allowed) return;
    const batch: PrEvent[] = [...entry.queue];
    try {
      await deps.paste(fresh.tmuxSession, formatMessage(entry.prNumber, batch, entry.provider ?? "github"));
    } catch {
      logFixed("paste", "could not type into a session, will retry", deps.now());
      return;
    }
    // At most once: a landed paste is final even if Enter failed, and later events stay queued.
    const deliveredIds = new Set<string>(batch.map((event) => event.id));
    entry.queue = entry.queue.filter((event) => !deliveredIds.has(event.id));
    setStatus(instanceId, statuses.get(instanceId)?.status ?? "ok", entry.queue.length);
    await persistMemory(deps);
  });
}

export async function deliverSweep(deps: PrEventsPollerDeps): Promise<void> {
  if (deliverRunning) return;
  deliverRunning = true;
  try {
    const file: PrEventsFile = await getFile(deps);
    if (!Object.values(file.instances).some((entry) => entry.queue.length > 0)) return;
    const state: DashboardState = await deps.loadState();
    for (const instance of state.instances) {
      if ((file.instances[instance.id]?.queue.length ?? 0) === 0 || !isPollable(instance)) continue;
      try {
        await deliverOne(deps, instance.id, instance.tmuxSession);
      } catch {
        logFixed("deliver", "a delivery round failed", deps.now());
      }
    }
  } catch {
    logFixed("deliver", "a delivery round failed", deps.now());
  } finally {
    deliverRunning = false;
  }
}

function storeFilePath(): string {
  return path.join(path.dirname(stateFilePath), "pr-events.json");
}

async function readStoreFile(): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(storeFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function realDeps(): PrEventsPollerDeps {
  return {
    now: () => Date.now(),
    loadState: () => loadState(),
    loadStore: readStoreFile,
    persist: (file) => writeStateFileAtomic(storeFilePath(), JSON.stringify(file)),
    resolveReviewRequest: async (instance) => {
      const cwd: string = await getPaneCurrentPath(instance.tmuxSession).catch(() => instance.locationPath);
      const upstream = await branchUpstream(cwd);
      return upstream === null ? null : reviewRequestFor(cwd, upstream);
    },
    fetchGithub: (url, init) => fetch(url, init),
    resolveToken: () => resolveGithubToken({ env: process.env, run: realTokenRun, now: () => Date.now() }),
    invalidateToken,
    resolveGitlabToken: (host, envName, configuredHosts) =>
      resolveGitlabToken(host, envName, configuredHosts, { env: process.env, run: realTokenRun, now: () => Date.now() }),
    invalidateGitlabToken,
    readAgentState: async (instance) => {
      const raw: string | null = await readAgentStateFile(instance.id);
      return raw === null ? null : parseAgentStateFile(raw);
    },
    probePane: probePaneAgent,
    clientActivity: clientActivitySeconds,
    paste: pasteToSession,
    withLock: withSessionLock,
  };
}

// index.ts exits the whole process on an unhandled rejection, so the sweeps never reject and the
// timers are unref'd so they cannot keep the process alive.
export function startPrEventsPoller(): () => void {
  const deps: PrEventsPollerDeps = realDeps();
  const firstPoll = setTimeout(() => void pollSweep(deps), FIRST_POLL_DELAY_MS);
  const pollTimer = setInterval(() => void pollSweep(deps), POLL_INTERVAL_MS);
  const deliverTimer = setInterval(() => void deliverSweep(deps), DELIVER_INTERVAL_MS);
  firstPoll.unref();
  pollTimer.unref();
  deliverTimer.unref();
  return () => {
    clearTimeout(firstPoll);
    clearInterval(pollTimer);
    clearInterval(deliverTimer);
  };
}
