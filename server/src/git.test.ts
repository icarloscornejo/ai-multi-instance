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
import { branchUpstream, GitError, isRemoteUnreachableError, LOCAL_GIT_TIMEOUT_MS, parseBranchUpstream, runGit } from "./git";

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

// `%(HEAD)`, branch, upstream, push, push:track, push:remotename: what for-each-ref prints
// (measured against real repos under push.default=simple and push.default=current).
function branchLine(...fields: string[]): string {
  return fields.join("\0");
}

describe("parseBranchUpstream", () => {
  it("reports tracking with zero ahead and behind for a branch in sync", () => {
    const output: string = branchLine("*", "feat", "refs/remotes/origin/feat", "refs/remotes/origin/feat", "", "origin");
    expect(parseBranchUpstream(output)).toEqual({
      branch: "feat",
      state: "tracking",
      ahead: 0,
      behind: 0,
      remoteName: "origin",
      pushRef: "refs/remotes/origin/feat",
    });
  });

  it("reads ahead and behind counts", () => {
    const aheadOnly: string = branchLine("*", "feat", "refs/remotes/origin/feat", "refs/remotes/origin/feat", "ahead 2", "origin");
    const both: string = branchLine("*", "feat", "refs/remotes/origin/feat", "refs/remotes/origin/feat", "ahead 2, behind 1", "origin");
    expect(parseBranchUpstream(aheadOnly)).toMatchObject({ state: "tracking", ahead: 2, behind: 0 });
    expect(parseBranchUpstream(both)).toMatchObject({ state: "tracking", ahead: 2, behind: 1 });
  });

  it("is gone only when the vanished ref was the configured upstream", () => {
    const output: string = branchLine("*", "feat", "refs/remotes/origin/feat", "refs/remotes/origin/feat", "gone", "origin");
    expect(parseBranchUpstream(output)).toEqual({ branch: "feat", state: "gone" });
  });

  it("is unpublished when push.default=simple leaves the push ref empty", () => {
    expect(parseBranchUpstream(branchLine("*", "feat", "", "", "", ""))).toEqual({ branch: "feat", state: "unpublished" });
  });

  it("is unpublished for a branch cut from origin/main that has never been pushed", () => {
    // push.default=simple: no push ref at all
    const underSimple: string = branchLine("*", "x", "refs/remotes/origin/main", "", "", "origin");
    // push.default=current: git invents origin/x, which does not exist, so track says gone
    const underCurrent: string = branchLine("*", "x", "refs/remotes/origin/main", "refs/remotes/origin/x", "gone", "origin");
    expect(parseBranchUpstream(underSimple)).toEqual({ branch: "x", state: "unpublished" });
    expect(parseBranchUpstream(underCurrent)).toEqual({ branch: "x", state: "unpublished" });
  });

  it("is unpublished under push.default=current for a new branch with no upstream and no remote", () => {
    const output: string = branchLine("*", "feat1", "", "refs/remotes/origin/feat1", "gone", "");
    expect(parseBranchUpstream(output)).toEqual({ branch: "feat1", state: "unpublished" });
  });

  it("is unpublished when the upstream is a local branch (remote is .)", () => {
    const output: string = branchLine("*", "feat", "refs/heads/main", "refs/heads/main", "", ".");
    expect(parseBranchUpstream(output)).toEqual({ branch: "feat", state: "unpublished" });
  });

  it("is unpublished when the push ref belongs to a differently named remote branch", () => {
    const output: string = branchLine("*", "feat", "refs/remotes/origin/main", "refs/remotes/origin/main", "", "origin");
    expect(parseBranchUpstream(output)).toEqual({ branch: "feat", state: "unpublished" });
  });

  it("handles branch names with slashes and a branch named like a tag", () => {
    const slashed: string = branchLine("*", "jira/RN-1-x", "refs/remotes/origin/jira/RN-1-x", "refs/remotes/origin/jira/RN-1-x", "", "origin");
    expect(parseBranchUpstream(slashed)).toMatchObject({ branch: "jira/RN-1-x", state: "tracking" });
    // refname:lstrip=2 yields the bare name even when a tag v1.2 exists, where :short would say heads/v1.2
    const tagLike: string = branchLine("*", "v1.2", "refs/remotes/origin/v1.2", "refs/remotes/origin/v1.2", "", "origin");
    expect(parseBranchUpstream(tagLike)).toMatchObject({ branch: "v1.2", state: "tracking" });
  });

  it("picks the checked-out line when several branches point at HEAD", () => {
    const output: string = [
      branchLine(" ", "other", "", "", "", ""),
      branchLine("*", "feat", "refs/remotes/origin/feat", "refs/remotes/origin/feat", "ahead 1", "origin"),
    ].join("\n");
    expect(parseBranchUpstream(output)).toMatchObject({ branch: "feat", ahead: 1 });
  });

  it("is null on a detached HEAD or empty output", () => {
    expect(parseBranchUpstream("")).toBeNull();
    expect(parseBranchUpstream(branchLine(" ", "other", "", "", "", ""))).toBeNull();
  });
});

describe("branchUpstream", () => {
  it("asks for-each-ref about the branch at HEAD and parses the checked-out line", async () => {
    runGitMock.mockResolvedValue({
      stdout: `${branchLine("*", "feat", "refs/remotes/origin/feat", "refs/remotes/origin/feat", "ahead 1", "origin")}\n`,
      stderr: "",
    });

    const result = await branchUpstream("/repo");

    expect(result).toMatchObject({ branch: "feat", state: "tracking", ahead: 1 });
    const args: string[] = runGitMock.mock.calls[0][1];
    expect(args.slice(0, 3)).toEqual(["-C", "/repo", "for-each-ref"]);
    expect(args).toContain("--points-at=HEAD");
  });

  it("is null when git fails (not a repo, folder gone)", async () => {
    runGitMock.mockRejectedValue(execError({ stderr: "fatal: not a git repository" }));
    expect(await branchUpstream("/not-a-repo")).toBeNull();
  });
});
