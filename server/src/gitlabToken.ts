import os from "node:os";
import { hardenedGitEnv } from "./git";
import { validShape, type TokenDeps, type TokenResult } from "./githubToken";
import { isValidGitlabHost, isValidTokenEnvName, normalizeGitlabHostKey } from "./prEventsGitlab";

const FOUND_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 5_000;
const ALLOWED_CHILD_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "XDG_CONFIG_HOME",
  "GLAB_CONFIG_DIR",
  "GIT_CONFIG_GLOBAL",
];

// Held only in memory. Never logged, persisted or returned by any route.
const cachedByHost = new Map<string, { result: TokenResult; expiresAt: number }>();
// null means "rejected before any clock was seen": the window starts at the next resolve.
const rejectedUntilByHost = new Map<string, number | null>();
let lastSeenNowMs: number | null = null;

export function _resetGitlabTokenForTests(): void {
  cachedByHost.clear();
  rejectedUntilByHost.clear();
  lastSeenNowMs = null;
}

// After a 401 every source stays blocked for a minute, so a rejected secret is not resent each poll.
export function invalidateGitlabToken(host: string): void {
  cachedByHost.delete(host);
  rejectedUntilByHost.set(host, lastSeenNowMs === null ? null : lastSeenNowMs + MISS_TTL_MS);
}

// Child processes never inherit token variables, only what git and glab need to find their config.
function allowlistedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && (ALLOWED_CHILD_ENV_KEYS.includes(key) || key.startsWith("LC_"))) childEnv[key] = value;
  }
  return childEnv;
}

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (!Object.hasOwn(env, name)) return undefined;
  const value: unknown = env[name];
  return typeof value === "string" ? value : undefined;
}

// GITLAB_HOST may be written as a bare host or as https://host/.
function hostFromGitlabHostVariable(env: NodeJS.ProcessEnv): string | null {
  const raw: string | undefined = envString(env, "GITLAB_HOST");
  if (raw === undefined) return null;
  return normalizeGitlabHostKey(raw.trim().replace(/^https:\/\//i, "").replace(/\/$/, ""));
}

async function fromGlab(host: string, deps: TokenDeps): Promise<string | null> {
  try {
    const { stdout } = await deps.run("glab", ["config", "get", "token", "--host", host], {
      env: allowlistedEnv(deps.env),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    return validShape(stdout);
  } catch {
    return null;
  }
}

async function fromGitCredential(host: string, deps: TokenDeps): Promise<string | null> {
  try {
    const { stdout } = await deps.run("git", ["credential", "fill"], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...hardenedGitEnv(allowlistedEnv(deps.env)), GCM_INTERACTIVE: "never" },
      // Outside any repository, so a repo's own .git/config cannot add a credential helper.
      cwd: os.tmpdir(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const passwordLine: string | undefined = stdout.split("\n").find((line) => line.startsWith("password="));
    return validShape(passwordLine?.slice("password=".length));
  } catch {
    return null;
  }
}

export async function resolveGitlabToken(
  host: string,
  envName: string | undefined,
  configuredHosts: Record<string, string>,
  deps: TokenDeps
): Promise<TokenResult> {
  if (!isValidGitlabHost(host)) return { reason: "no-token" };
  const nowMs: number = deps.now();
  lastSeenNowMs = nowMs;

  if (rejectedUntilByHost.has(host)) {
    const rejectedUntilMs: number = rejectedUntilByHost.get(host) ?? nowMs + MISS_TTL_MS;
    rejectedUntilByHost.set(host, rejectedUntilMs);
    if (nowMs < rejectedUntilMs) return { reason: "no-token" };
    rejectedUntilByHost.delete(host);
  }

  if (envName !== undefined && Object.hasOwn(configuredHosts, host)) {
    if (!isValidTokenEnvName(envName)) return { reason: "no-token" };
    const configuredToken: string | null = validShape(envString(deps.env, envName));
    if (configuredToken !== null) return { token: configuredToken };
  }

  // The generic token only ever goes to the one host the operator named, never to any host that
  // merely serves merge requests.
  if (hostFromGitlabHostVariable(deps.env) === host) {
    const genericToken: string | null = validShape(envString(deps.env, "GITLAB_TOKEN"));
    if (genericToken !== null) return { token: genericToken };
  }

  const cached = cachedByHost.get(host);
  if (cached !== undefined && nowMs < cached.expiresAt) return cached.result;

  const token: string | null = (await fromGlab(host, deps)) ?? (await fromGitCredential(host, deps));
  const result: TokenResult = token === null ? { reason: "no-token" } : { token };
  cachedByHost.set(host, { result, expiresAt: nowMs + (token === null ? MISS_TTL_MS : FOUND_TTL_MS) });
  return result;
}
