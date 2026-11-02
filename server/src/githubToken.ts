import { execFile } from "node:child_process";
import { hardenedGitEnv } from "./git";

export interface TokenRunOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  cwd?: string;
}

export interface TokenDeps {
  env: NodeJS.ProcessEnv;
  run: (file: string, args: string[], options: TokenRunOptions) => Promise<{ stdout: string }>;
  now: () => number;
}

export type TokenResult = { token: string } | { reason: "no-token" };

export const TOKEN_SHAPE = /^[A-Za-z0-9_.-]{20,255}$/;
const FOUND_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
const GH_TIMEOUT_MS = 5_000;
const CREDENTIAL_REQUEST = "protocol=https\nhost=github.com\n\n";

// Held only in memory. Never logged, persisted or returned by any route.
let cached: { result: TokenResult; expiresAt: number } | null = null;

export function invalidateToken(): void {
  cached = null;
}

export function _resetGithubTokenForTests(): void {
  cached = null;
}

export function validShape(candidate: string | undefined): string | null {
  const trimmed: string = (candidate ?? "").trim();
  return TOKEN_SHAPE.test(trimmed) ? trimmed : null;
}

// Callback-style execFile so the request can be written to the child's stdin. Every error
// object is dropped: it can carry stdout, stderr and argv, which may contain the credential.
export function realTokenRun(file: string, args: string[], options: TokenRunOptions): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 64 * 1024,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("token command failed"));
          return;
        }
        resolve({ stdout: String(stdout) });
      }
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
}

async function fromGh(deps: TokenDeps): Promise<string | null> {
  try {
    const { stdout } = await deps.run("gh", ["auth", "token", "--hostname", "github.com"], { timeoutMs: GH_TIMEOUT_MS });
    return validShape(stdout);
  } catch {
    return null;
  }
}

async function fromGitCredential(deps: TokenDeps): Promise<string | null> {
  try {
    const { stdout } = await deps.run("git", ["credential", "fill"], {
      input: CREDENTIAL_REQUEST,
      env: { ...hardenedGitEnv(), GCM_INTERACTIVE: "never" },
      timeoutMs: 5000,
    });
    const passwordLine: string | undefined = stdout.split("\n").find((line) => line.startsWith("password="));
    return validShape(passwordLine?.slice("password=".length));
  } catch {
    return null;
  }
}

export async function resolveGithubToken(deps: TokenDeps): Promise<TokenResult> {
  const fromEnv: string | null = validShape(deps.env.GITHUB_TOKEN);
  if (fromEnv !== null) return { token: fromEnv };

  const nowMs: number = deps.now();
  if (cached !== null && nowMs < cached.expiresAt) return cached.result;

  const token: string | null = (await fromGh(deps)) ?? (await fromGitCredential(deps));
  const result: TokenResult = token === null ? { reason: "no-token" } : { token };
  cached = { result, expiresAt: nowMs + (token === null ? MISS_TTL_MS : FOUND_TTL_MS) };
  return result;
}
