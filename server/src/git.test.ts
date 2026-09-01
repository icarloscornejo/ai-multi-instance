import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same technique as tmux.test.ts: child_process.execFile carries its own
// util.promisify.custom slot (resolving to {stdout, stderr}), and git.ts's `promisify(execFile)`
// relies on it. Mocking that slot drives the real code path without needing a git binary.
vi.mock("node:child_process", () => {
  const runMock = vi.fn();
  const execFileMock = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: runMock });
  return { execFile: execFileMock };
});

import { execFile } from "node:child_process";
import { GitError, isRemoteUnreachableError, LOCAL_GIT_TIMEOUT_MS, runGit } from "./git";

const promisifyCustomSymbol = Symbol.for("nodejs.util.promisify.custom");
const runGitMock = (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisifyCustomSymbol];

function execError(overrides: {
  message?: string;
  stderr?: string;
  killed?: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}): Error {
  return Object.assign(new Error(overrides.message ?? "git failed"), {
    stderr: overrides.stderr ?? "",
    killed: overrides.killed ?? false,
    code: overrides.code ?? 1,
    signal: overrides.signal ?? null,
  });
}

const originalGitSshCommand = process.env.GIT_SSH_COMMAND;

beforeEach(() => {
  runGitMock.mockReset();
  delete process.env.GIT_SSH_COMMAND;
});

afterEach(() => {
  if (originalGitSshCommand === undefined) {
    delete process.env.GIT_SSH_COMMAND;
  } else {
    process.env.GIT_SSH_COMMAND = originalGitSshCommand;
  }
});

describe("runGit", () => {
  it("prefixes -C <cwd> and passes a timeout plus the hardened env", async () => {
    runGitMock.mockResolvedValue({ stdout: "main\n", stderr: "" });

    const result = await runGit("/repo", ["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(result).toBe("main");
    expect(runGitMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = runGitMock.mock.calls[0];
    expect(command).toBe("git");
    expect(args).toEqual(["-C", "/repo", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(options.timeout).toBe(LOCAL_GIT_TIMEOUT_MS);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(options.env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(options.env.GIT_SSH_COMMAND).toContain("ConnectTimeout=10");
  });

  it("uses the caller-supplied timeout when given one", async () => {
    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });
    await runGit("/repo", ["fetch", "origin", "main"], 120_000);
    expect(runGitMock.mock.calls[0][2].timeout).toBe(120_000);
  });

  it("does not override an existing GIT_SSH_COMMAND in the environment", async () => {
    process.env.GIT_SSH_COMMAND = "ssh -o ProxyJump=bastion";
    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    await runGit("/repo", ["fetch", "origin", "main"]);

    expect(runGitMock.mock.calls[0][2].env.GIT_SSH_COMMAND).toBe("ssh -o ProxyJump=bastion");
  });

  it("wraps failures in a GitError that preserves killed/code/signal", async () => {
    runGitMock.mockRejectedValue(execError({ stderr: "fatal: bad", killed: true, code: 143, signal: "SIGTERM" }));

    await expect(runGit("/repo", ["fetch"])).rejects.toMatchObject({
      name: "GitError",
      message: "fatal: bad",
      killed: true,
      code: 143,
      signal: "SIGTERM",
    });
  });

  it("falls back to the error message when stderr is empty", async () => {
    runGitMock.mockRejectedValue(execError({ stderr: "", message: "Command failed: git fetch" }));
    await expect(runGit("/repo", ["fetch"])).rejects.toThrow("Command failed: git fetch");
  });
});

describe("isRemoteUnreachableError", () => {
  it("is true for a DNS resolution failure (host only reachable over VPN)", () => {
    const error = new GitError(
      "ssh: Could not resolve hostname code.corp.example.com: nodename nor servname provided\n" +
        "fatal: Could not read from remote repository."
    );
    expect(isRemoteUnreachableError(error)).toBe(true);
  });

  it("is true when the network line is buried above git's trailing boilerplate", () => {
    // This is the real message seen off-VPN: the line that names the problem is NOT last.
    const error = new GitError(
      "ssh: connect to host code.corp.example.com port 22: Operation timed out\r\n" +
        "fatal: Could not read from remote repository.\n\n" +
        "Please make sure you have the correct access rights\n" +
        "and the repository exists."
    );
    expect(isRemoteUnreachableError(error)).toBe(true);
  });

  it("is true for a connection timeout", () => {
    expect(isRemoteUnreachableError(new GitError("ssh: connect to host x port 22: Connection timed out"))).toBe(true);
  });

  it("is true for 'Network is unreachable' and 'No route to host'", () => {
    expect(isRemoteUnreachableError(new GitError("ssh: connect to host x port 22: Network is unreachable"))).toBe(true);
    expect(isRemoteUnreachableError(new GitError("ssh: connect to host x port 22: No route to host"))).toBe(true);
  });

  it("is true for a publickey rejection", () => {
    expect(isRemoteUnreachableError(new GitError("git@host: Permission denied (publickey)."))).toBe(true);
  });

  it("is true for a timed-out command (killed) regardless of message", () => {
    expect(isRemoteUnreachableError(new GitError("", true))).toBe(true);
  });

  it("is false for failures that are not network problems", () => {
    expect(isRemoteUnreachableError(new GitError("fatal: not a git repository"))).toBe(false);
    expect(isRemoteUnreachableError(new GitError("error: Your local changes would be overwritten by merge."))).toBe(false);
    expect(isRemoteUnreachableError(new GitError("fatal: A branch named 'x' already exists."))).toBe(false);
  });

  it("is false for anything that is not a GitError", () => {
    expect(isRemoteUnreachableError(new Error("ssh: Could not resolve hostname x"))).toBe(false);
    expect(isRemoteUnreachableError("Could not resolve hostname")).toBe(false);
  });

  it("whole-line match, not a loose substring: a branch name quoting the phrase is not a match", () => {
    // git rejecting a well-formed request whose text merely quotes a branch called
    // "could not resolve hostname" must stay false - the phrase is mid-line, not the whole line.
    const error = new GitError("fatal: A branch named 'could not resolve hostname' already exists.");
    expect(isRemoteUnreachableError(error)).toBe(false);
  });
});
