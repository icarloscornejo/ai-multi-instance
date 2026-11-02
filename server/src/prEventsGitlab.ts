// Pure GitLab pieces of the PR event feed, plus the validators that config and token code share.
// Imports only from prEvents.ts and reviewRequests types, so routes can use it without side effects.

import { asId, asRecord, AUTHOR_PATTERN, sanitizeCheckName, type PrEvent } from "./prEvents";
import type { ReviewRequest } from "./reviewRequests";

export interface GitlabMr {
  host: string;
  projectPath: string;
  iid: number;
}

export interface GitlabCollectRules {
  host: string;
  projectPath: string;
  iid: number;
  headSha: string;
  ownUserId: number | null;
  botLogins: string[];
}

const HOST_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TOKEN_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const GITLAB_NAMED_PATTERN = /^[A-Z0-9_]*GITLAB[A-Z0-9_]*$/;
const PROJECT_SEGMENT_PATTERN =/^[A-Za-z0-9._-]+$/;
const MR_PATH_PATTERN = /^\/(.+)\/-\/merge_requests\/(\d+)$/;
const MAX_PROJECT_SEGMENTS = 8;
const MAX_PROJECT_PATH_LENGTH = 200;
const MAX_HOST_LENGTH = 253;
const CI_AUTHOR = "gitlab-ci";

export function isValidGitlabHost(host: string): boolean {
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
  const labels: string[] = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => label.length <= 63 && HOST_LABEL_PATTERN.test(label))) return false;
  // A final label with a letter rules out dotted IPv4 literals.
  return /[a-z]/.test(labels[labels.length - 1]);
}

// Never goes through new URL().hostname, which would turn user@evil.com into evil.com.
export function normalizeGitlabHostKey(raw: string): string | null {
  const normalized: string = raw.trim().toLowerCase();
  return isValidGitlabHost(normalized) ? normalized : null;
}

// The name must contain GITLAB: otherwise a dashboard writer could map an attacker host to any
// secret variable (an API key, another service token) and have it sent there as a bearer.
export function isValidTokenEnvName(name: string): boolean {
  return (
    TOKEN_ENV_NAME_PATTERN.test(name) &&
    GITLAB_NAMED_PATTERN.test(name) &&
    name !== "DASHBOARD_PASSWORD" &&
    !/^(GITHUB_|GH_)/.test(name)
  );
}

export function isSafeProjectPath(projectPath: string): boolean {
  if (projectPath.length === 0 || projectPath.length > MAX_PROJECT_PATH_LENGTH) return false;
  const segments: string[] = projectPath.split("/");
  return (
    segments.length <= MAX_PROJECT_SEGMENTS &&
    segments.every((segment) => PROJECT_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..")
  );
}

export function parseGitlabMr(review: Extract<ReviewRequest, { state: "found" }>): GitlabMr | null {
  if (review.kind !== "gitlab" || review.url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(review.url);
  } catch {
    return null;
  }
  const isPlain: boolean =
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    parsed.search === "" &&
    parsed.hash === "";
  // The round trip rejects anything the URL parser normalized (case, backslashes, IDN, dot segments).
  if (!isPlain || review.url !== `https://${parsed.hostname}${parsed.pathname}`) return null;
  if (!isValidGitlabHost(parsed.hostname)) return null;
  const match: RegExpExecArray | null = MR_PATH_PATTERN.exec(parsed.pathname);
  if (match === null || Number(match[2]) !== review.number || !isSafeProjectPath(match[1])) return null;
  return { host: parsed.hostname, projectPath: match[1], iid: review.number };
}

function collectJob(raw: unknown, rules: GitlabCollectRules): PrEvent | null {
  const job = asRecord(raw);
  const jobId: number | null = asId(job?.id);
  if (job === null || jobId === null) return null;
  if (job.status !== "failed" || job.allow_failure === true || typeof job.name !== "string") return null;
  return {
    id: `ci:${jobId}`,
    kind: "ci",
    author: CI_AUTHOR,
    link: `https://${rules.host}/${rules.projectPath}/-/jobs/${jobId}`,
    label: `${sanitizeCheckName(job.name)}: failed`,
    sha: rules.headSha,
  };
}

function collectApproval(raw: unknown, rules: GitlabCollectRules): PrEvent | null {
  const user = asRecord(asRecord(raw)?.user);
  const userId: number | null = asId(user?.id);
  const username: unknown = user?.username;
  if (userId === null || typeof username !== "string" || !AUTHOR_PATTERN.test(username)) return null;
  const loweredUsername: string = username.toLowerCase();
  if (rules.ownUserId !== null && rules.ownUserId === userId) return null;
  if (rules.botLogins.some((botLogin) => botLogin.toLowerCase() === loweredUsername)) return null;
  return {
    id: `review:${userId}`,
    kind: "review",
    author: username,
    link: `https://${rules.host}/${rules.projectPath}/-/merge_requests/${rules.iid}`,
    label: "approved",
  };
}

export function collectGitlabEvents(raw: { jobs: unknown[]; approvals: unknown[] }, rules: GitlabCollectRules): PrEvent[] {
  // Links are built from these two strings, so nothing unvalidated may reach them.
  if (!isValidGitlabHost(rules.host) || !isSafeProjectPath(rules.projectPath)) return [];
  const events: PrEvent[] = [];
  for (const job of raw.jobs) {
    const collected: PrEvent | null = collectJob(job, rules);
    if (collected !== null) events.push(collected);
  }
  for (const approval of raw.approvals) {
    const collected: PrEvent | null = collectApproval(approval, rules);
    if (collected !== null) events.push(collected);
  }
  return events;
}
