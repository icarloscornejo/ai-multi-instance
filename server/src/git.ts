import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Mirrors TmuxError in tmux.ts: preserves what execFile's error actually carried (killed/code/
// signal) instead of collapsing every failure into a message-only Error. That distinction is
// what lets callers tell "git said no" (a real, definitive answer) apart from "the command
// never finished" (a timeout, killed: true) - which is exactly the ambiguity that let a
// network-unreachable `git fetch` hang a request handler forever (see routes.ts).
export class GitError extends Error {
  constructor(
    message: string,
    public readonly killed: boolean = false,
    public readonly code: number | null = null,
    public readonly signal: NodeJS.Signals | null = null
  ) {
    super(message);
    this.name = "GitError";
  }
}

// Local git operations (rev-parse, for-each-ref, worktree list, checkout, branch -D) should
// take milliseconds. 10s only ever covers a stray index.lock or a slow disk - anything longer
// is a bug, not slowness, and the caller is better served by a fast failure than a stalled
// request.
export const LOCAL_GIT_TIMEOUT_MS = 10_000;

// `git fetch` against a real remote over VPN, in a 1.2 GB repo, can legitimately take a while,
// so this is deliberately generous. It is NOT what makes an unreachable remote fail fast - the
// ssh ConnectTimeout below does that in ~10s. This is only the hard ceiling against a fetch
// that connected, started transferring, and then wedged mid-stream.
export const NETWORK_GIT_TIMEOUT_MS = 120_000;

// Every git invocation gets this env, and it is the real fix for the hang: without it, a fetch
// against a remote the machine cannot reach (corporate host, no VPN) never returns.
//   - GIT_TERMINAL_PROMPT=0: there is no tty here, so a credential prompt would just block on
//     stdin forever - another way to hang. Fail instead.
//   - GIT_SSH_COMMAND: BatchMode=yes disables ssh's own interactive prompts; ConnectTimeout=10
//     makes ssh give up on an unreachable host in ~10s instead of waiting out the OS default
//     TCP connect timeout (which is what produced the 45s+ hang that motivated this).
// An existing GIT_SSH_COMMAND in the environment wins: the user may have configured a specific
// ssh wrapper (a jump host, a custom identity) and we must not silently override that. We only
// supply the default when nothing is set.
function hardenedGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: baseEnv.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
  };
}

export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // Not a git repo, git not installed, or the folder does not exist anymore
    return null;
  }
}

// Whether the checked-out branch has been published, judged by where `git push` would send it
// and not by `@{upstream}`: a branch cut with `git checkout -b feat origin/main` has upstream
// origin/main but was never pushed anywhere. `branch` rides along so the client can check it is
// describing the same branch it is displaying.
export type BranchUpstream = { branch: string } & (
  | { state: "unpublished" }
  | { state: "gone" }
  | { state: "tracking"; ahead: number; behind: number; remoteName: string; pushRef: string }
);

// Fields separated by NUL, one branch per line, `%(HEAD)` is `*` on the checked-out one.
//   %(upstream) is the configured upstream, %(push) where `git push` would send the branch,
//   %(push:track) how far the push ref is ahead/behind ("gone" when it no longer exists).
// `refname:lstrip=2` and not `:short`: short returns "heads/<name>" when a tag shares the name.
const BRANCH_UPSTREAM_FORMAT: string =
  "%(HEAD)%00%(refname:lstrip=2)%00%(upstream)%00%(push)%00%(push:track,nobracket)%00%(push:remotename)";

// Pure so the push.default quirks below are testable without a repo. Takes the raw output of
// `for-each-ref --points-at=HEAD` because several branches can point at the same commit and only
// the line marked `*` is the checked-out one.
export function parseBranchUpstream(forEachRefOutput: string): BranchUpstream | null {
  const checkedOutLine: string | undefined = forEachRefOutput.split("\n").find((line) => line.startsWith("*"));
  if (checkedOutLine === undefined) {
    // Detached HEAD: no branch to describe
    return null;
  }
  const [, branch = "", upstreamRef = "", pushRef = "", pushTrack = "", remoteName = ""] = checkedOutLine.split("\0");
  const remoteBranchPrefix: string = `refs/remotes/${remoteName}/`;

  // push.default=simple leaves %(push) empty for a branch that was never pushed. A remote of "."
  // means the push target is another local branch. A remote branch with another name is not this
  // branch's own publication (checkout -b feat origin/main, then push would go to origin/feat).
  if (pushRef === "" || remoteName === "" || remoteName === "." || pushRef !== `${remoteBranchPrefix}${branch}`) {
    return { branch, state: "unpublished" };
  }
  if (pushTrack === "gone") {
    // push.default=current|matching builds %(push) even when that ref never existed, which also
    // reads as "gone". It only really was published when it was this branch's configured upstream.
    return { branch, state: upstreamRef === pushRef ? "gone" : "unpublished" };
  }
  const ahead: number = Number(/ahead (\d+)/.exec(pushTrack)?.[1] ?? 0);
  const behind: number = Number(/behind (\d+)/.exec(pushTrack)?.[1] ?? 0);
  return { branch, state: "tracking", ahead, behind, remoteName, pushRef };
}

// Local only (no fetch): a `git push` updates the remote-tracking ref, so "unpublished" and
// "ahead N" are exact; "behind" and "gone" are as fresh as the last fetch.
export async function branchUpstream(cwd: string): Promise<BranchUpstream | null> {
  try {
    const output: string = await runGit(cwd, ["for-each-ref", "--points-at=HEAD", `--format=${BRANCH_UPSTREAM_FORMAT}`, "refs/heads"]);
    return parseBranchUpstream(output);
  } catch (error) {
    if (error instanceof GitError) {
      // Not a git repo, git not installed, or the folder does not exist anymore
      return null;
    }
    throw error;
  }
}

// Always passes `-C <cwd>` so callers never have to. `timeoutMs` picks between the two
// constants above based on whether the command touches the network. `maxBufferBytes` only
// matters for commands with unbounded output (ls-remote on a repo with tens of thousands of
// PRs): past Node's 1 MiB default execFile kills the child, which would read as a timeout.
export async function runGit(
  cwd: string,
  gitArguments: string[],
  timeoutMs: number = LOCAL_GIT_TIMEOUT_MS,
  maxBufferBytes?: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...gitArguments], {
      timeout: timeoutMs,
      env: hardenedGitEnv(),
      ...(maxBufferBytes !== undefined ? { maxBuffer: maxBufferBytes } : {}),
    });
    return stdout.trim();
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    const stderr: string = (execError.stderr ?? "").trim();
    throw new GitError(
      stderr || execError.message,
      execError.killed === true,
      typeof execError.code === "number" ? execError.code : null,
      execError.signal ?? null
    );
  }
}

// The shapes git/ssh use to report "I could not reach the remote". Each is matched as a WHOLE
// LINE (^...$) against every line of the error, never as a loose substring over the whole
// blob. Whole-line anchoring is the safeguard tmux.ts's NO_SUCH_SESSION_LINE_PATTERNS uses too:
// git interpolates the remote URL, host and branch names into its messages, so a bare
// substring test could fire on a branch called "could not resolve hostname" while the real
// failure is unrelated (a merge conflict, "not a git repository"). We scan ALL lines rather
// than just the last one because git's remote errors are multi-line and end with boilerplate
// ("Please make sure you have the correct access rights / and the repository exists."), so the
// diagnostic line that actually names the network problem is never the last one. A branch name
// cannot contain a newline, so whole-line matching over multi-line output stays robust.
const REMOTE_UNREACHABLE_LINE_PATTERNS: readonly RegExp[] = [
  /^ssh: could not resolve hostname\b.*$/i,
  /^fatal: could not read from remote repository\.?$/i,
  /^fatal: unable to access '.*': (could not resolve host|failed to connect|operation timed out).*$/i,
  /^ssh: connect to host .* port \d+: .*$/i,
  /^.*: connection timed out$/i,
  /^.*: network is unreachable$/i,
  /^.*: no route to host$/i,
  /^.*: operation timed out$/i,
  /^connection closed by remote host$/i,
  /^kex_exchange_identification:.*$/i,
  /^.*permission denied \(publickey.*\)\.?$/i,
];

// True when the failure is "could not reach the remote" (so the caller can surface an
// actionable "check the VPN" message) rather than git rejecting a well-formed request. A
// timeout (killed: true) counts: a fetch that never returned is, for our purposes here, the
// same unreachable-remote situation.
export function isRemoteUnreachableError(error: unknown): boolean {
  if (!(error instanceof GitError)) {
    return false;
  }
  if (error.killed) {
    return true;
  }
  const lines = error.message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.some((line) => REMOTE_UNREACHABLE_LINE_PATTERNS.some((pattern) => pattern.test(line)));
}
