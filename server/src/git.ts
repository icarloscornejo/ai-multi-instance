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

// Always passes `-C <cwd>` so callers never have to. `timeoutMs` picks between the two
// constants above based on whether the command touches the network.
export async function runGit(
  cwd: string,
  gitArguments: string[],
  timeoutMs: number = LOCAL_GIT_TIMEOUT_MS
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...gitArguments], {
      timeout: timeoutMs,
      env: hardenedGitEnv(),
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
