import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sshMock: vi.fn(),
  storeDirectory: { value: "" },
}));

// `ssh -G` goes through child_process; same promisify.custom trick as git.test.ts
vi.mock("node:child_process", () => {
  const execFileMock = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: hoisted.sshMock });
  return { execFile: execFileMock };
});
vi.mock("./git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git")>();
  return { ...actual, runGit: vi.fn() };
});
// A temp directory in place of data/: the cache file must never land in the real one
vi.mock("./store", () => ({
  get stateFilePath() {
    return path.join(hoisted.storeDirectory.value, "instances.json");
  },
  writeStateFileAtomic: async (filePath: string, contents: string) => fs.writeFile(filePath, contents, "utf8"),
}));

import { GitError, runGit, type BranchUpstream } from "./git";
import {
  _resetReviewRequestsForTests,
  _settleReviewRequestsForTests,
  buildReviewUrl,
  parseRemoteUrl,
  parseReviewRefs,
  reviewRequestFor,
} from "./reviewRequests";

const T0 = 1_800_000_000_000;
const SECONDS = 1000;
// Past the 5s answer memo, so every poll in a test really recomputes
const POLL = 6 * SECONDS;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const upstream: Extract<BranchUpstream, { state: "tracking" }> = {
  branch: "feat",
  state: "tracking",
  ahead: 0,
  behind: 0,
  remoteName: "origin",
  pushRef: "refs/remotes/origin/feat",
};

interface Scenario {
  remotes: Record<string, string>;
  // ls-remote output per remote name, or an Error to throw
  listings: Record<string, string | Error>;
  tipSha: string;
  defaultBranchRefs: string;
  ownCommits: string;
}
let scenario: Scenario;

function listing(...lines: [string, string][]): string {
  return lines.map(([sha, ref]) => `${sha}\t${ref}`).join("\n");
}

const unreachable = (): GitError => new GitError("fatal: could not read from remote repository.", false, 128);

function installFakeGit(): void {
  vi.mocked(runGit).mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === "remote" && args[1] === "get-url") return scenario.remotes[args[2]];
    if (args[0] === "remote") return Object.keys(scenario.remotes).join("\n");
    if (args[0] === "for-each-ref") return scenario.defaultBranchRefs;
    if (args[0] === "rev-list") return scenario.ownCommits;
    if (args[0] === "rev-parse") return scenario.tipSha;
    if (args[0] === "ls-remote") {
      const result: string | Error = scenario.listings[args[1]] ?? "";
      if (result instanceof Error) throw result;
      return result;
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });
}

const lsRemoteCalls = (): string[][] => vi.mocked(runGit).mock.calls.filter((call) => call[1][0] === "ls-remote").map((call) => call[1]);

// Polls once, lets the background refresh and disk write finish, like the next real poll would see
async function poll(nowMs: number): ReturnType<typeof reviewRequestFor> {
  const answer = await reviewRequestFor("/repo", upstream, nowMs);
  await _settleReviewRequestsForTests();
  return answer;
}

beforeEach(async () => {
  hoisted.storeDirectory.value = await fs.mkdtemp(path.join(os.tmpdir(), "ccdash-review-"));
  _resetReviewRequestsForTests();
  // Like ssh: an alias maps to its configured HostName, a real hostname resolves to itself
  hoisted.sshMock.mockReset().mockImplementation(async (_command: string, args: string[]) => {
    const alias: string = args[1];
    const hostname: string = alias === "indeed" ? "code.corp.indeed.com" : alias;
    return { stdout: `user git\nhostname ${hostname}\nport 22\n`, stderr: "" };
  });
  scenario = {
    remotes: { origin: "git@indeed:group/repo.git" },
    listings: { origin: listing([SHA_A, "refs/merge-requests/7/head"]) },
    tipSha: SHA_A,
    defaultBranchRefs: "refs/remotes/origin/main\n",
    ownCommits: "3",
  };
  vi.mocked(runGit).mockReset();
  installFakeGit();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(hoisted.storeDirectory.value, { recursive: true, force: true });
});

describe("parseReviewRefs", () => {
  it("reads GitLab merge requests and GitHub pull requests", () => {
    const refs = parseReviewRefs(listing([SHA_A, "refs/merge-requests/12/head"], [SHA_B, "refs/pull/34/head"]));
    expect(refs.get(SHA_A)).toEqual({ number: 12, kind: "gitlab" });
    expect(refs.get(SHA_B)).toEqual({ number: 34, kind: "github" });
  });

  it("keeps the highest number when several requests share a tip", () => {
    const refs = parseReviewRefs(listing([SHA_A, "refs/merge-requests/9/head"], [SHA_A, "refs/merge-requests/12/head"], [SHA_A, "refs/merge-requests/10/head"]));
    expect(refs.get(SHA_A)?.number).toBe(12);
  });

  it("ignores merge refs and anything that is not a request head", () => {
    const refs = parseReviewRefs(listing([SHA_A, "refs/merge-requests/12/merge"], [SHA_B, "refs/heads/main"]) + "\nnoise");
    expect(refs.size).toBe(0);
  });
});

describe("parseRemoteUrl", () => {
  it("drops credentials, port, .git and trailing slashes from every remote shape", () => {
    expect(parseRemoteUrl("git@indeed:group/repo.git")).toEqual({ host: "indeed", path: "group/repo", overSsh: true });
    expect(parseRemoteUrl("ssh://git@h.example.com:2222/g/r.git")).toEqual({ host: "h.example.com", path: "g/r", overSsh: true });
    expect(parseRemoteUrl("https://user:ghp_secret@github.com/o/r.git")).toEqual({ host: "github.com", path: "o/r", overSsh: false });
    expect(parseRemoteUrl("https://github.com/o/r/")).toEqual({ host: "github.com", path: "o/r", overSsh: false });
  });

  it("is null for remotes that are not a hosted repository", () => {
    expect(parseRemoteUrl("/Users/me/repo")).toBeNull();
    expect(parseRemoteUrl("file:///Users/me/repo")).toBeNull();
    expect(parseRemoteUrl("")).toBeNull();
  });
});

describe("buildReviewUrl", () => {
  it("builds the page of each host's request", () => {
    expect(buildReviewUrl("code.corp.indeed.com", "g/sub/r", { number: 7, kind: "gitlab" })).toBe("https://code.corp.indeed.com/g/sub/r/-/merge_requests/7");
    expect(buildReviewUrl("github.com", "o/r", { number: 45, kind: "github" })).toBe("https://github.com/o/r/pull/45");
  });
});

describe("reviewRequestFor", () => {
  it("has nothing to say about a branch that is not tracking a remote", async () => {
    expect(await reviewRequestFor("/repo", { branch: "feat", state: "unpublished" }, T0)).toBeNull();
    expect(lsRemoteCalls()).toHaveLength(0);
  });

  it("does not look up the remote's default branch, whose tip is a merged request's head", async () => {
    const onMain = { ...upstream, branch: "main", pushRef: "refs/remotes/origin/main" };
    expect(await reviewRequestFor("/repo", onMain, T0)).toBeNull();
    expect(lsRemoteCalls()).toHaveLength(0);
  });

  it("does not look up a branch with no commits outside the other remote branches", async () => {
    // feat2 cut from feat1 and pushed unchanged would otherwise inherit feat1's request
    scenario.ownCommits = "0";
    expect(await reviewRequestFor("/repo", upstream, T0)).toBeNull();
    expect(lsRemoteCalls()).toHaveLength(0);
  });

  it("excludes the branch and the remote HEADs when counting its own commits", async () => {
    await poll(T0);
    const revListArgs: string[] = vi.mocked(runGit).mock.calls.map((call) => call[1]).find((args) => args[0] === "rev-list")!;
    expect(revListArgs).toEqual(["rev-list", "--count", "refs/remotes/origin/feat", "--not", "--exclude=*/feat", "--exclude=*/HEAD", "--remotes"]);
  });

  it("answers unknown at once and finds the request on the next poll, resolving the ssh alias", async () => {
    expect(await poll(T0)).toEqual({ state: "unknown" });

    expect(await poll(T0 + POLL)).toEqual({
      state: "found",
      number: 7,
      kind: "gitlab",
      url: "https://code.corp.indeed.com/group/repo/-/merge_requests/7",
      checkedAt: new Date(T0).toISOString(),
      stale: false,
    });
    expect(hoisted.sshMock.mock.calls[0][1]).toEqual(["-G", "indeed"]);
  });

  it("lists with a long network timeout and a buffer large enough for big repos", async () => {
    await poll(T0);
    const call = vi.mocked(runGit).mock.calls.find((entry) => entry[1][0] === "ls-remote")!;
    expect(call[1]).toEqual(["ls-remote", "origin", "refs/merge-requests/*/head", "refs/pull/*/head"]);
    expect(call[2]).toBeGreaterThan(10_000);
    expect(call[3]).toBeGreaterThanOrEqual(32 * 1024 * 1024);
  });

  it("never lets a remote's credentials reach the answer, the ls-remote arguments or the log", async () => {
    scenario.remotes = { origin: "https://user:ghp_secret@github.com/o/r.git" };
    scenario.listings = { origin: listing([SHA_A, "refs/pull/45/head"]) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await poll(T0);
    const answer = await poll(T0 + POLL);

    expect(answer).toMatchObject({ state: "found", number: 45, kind: "github", url: "https://github.com/o/r/pull/45" });
    expect(JSON.stringify(answer)).not.toContain("ghp_secret");
    expect(JSON.stringify(lsRemoteCalls())).not.toContain("ghp_secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("ghp_secret");
  });

  it("finds a request that lives on another remote (a fork pushes to one, the request is on the other)", async () => {
    scenario.remotes = { personal: "git@github.com:me/repo.git", origin: "git@github.com:org/repo.git" };
    scenario.listings = { personal: "", origin: listing([SHA_A, "refs/pull/7/head"]) };
    const pushedToFork = { ...upstream, remoteName: "personal", pushRef: "refs/remotes/personal/feat" };

    await reviewRequestFor("/repo", pushedToFork, T0);
    await _settleReviewRequestsForTests();
    const answer = await reviewRequestFor("/repo", pushedToFork, T0 + POLL);

    expect(answer).toMatchObject({ state: "found", number: 7, url: "https://github.com/org/repo/pull/7" });
  });

  it("is unknown, not 'none', while any remote has never answered", async () => {
    scenario.remotes = { origin: "git@github.com:org/repo.git", vpn: "git@indeed:group/repo.git" };
    scenario.listings = { origin: "", vpn: unreachable() };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await poll(T0);

    expect(await poll(T0 + POLL)).toEqual({ state: "unknown" });
  });

  it("says none only once every remote has answered, flagged stale when one of them is stale", async () => {
    scenario.remotes = { origin: "git@github.com:org/repo.git", vpn: "git@indeed:group/repo.git" };
    scenario.listings = { origin: "", vpn: "" };
    await poll(T0);

    // Restart with the VPN off: the vpn remote only has its saved answer
    _resetReviewRequestsForTests();
    scenario.listings = { origin: "", vpn: unreachable() };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await poll(T0 + 100 * SECONDS);

    const answer = await poll(T0 + 100 * SECONDS + POLL);
    expect(answer).toEqual({ state: "none", checkedAt: new Date(T0).toISOString(), stale: true });
  });

  it("retries a failing listing once a minute, not on every poll", async () => {
    scenario.listings = { origin: unreachable() };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let pollIndex = 0; pollIndex < 10; pollIndex += 1) {
      await poll(T0 + pollIndex * POLL);
    }
    expect(lsRemoteCalls()).toHaveLength(1);

    await poll(T0 + 61 * SECONDS);
    expect(lsRemoteCalls()).toHaveLength(2);
  });

  it("keeps the last good answer, flagged stale with its original time, when a refresh fails", async () => {
    await poll(T0);
    expect(await poll(T0 + POLL)).toMatchObject({ state: "found", stale: false });

    scenario.listings = { origin: unreachable() };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await poll(T0 + 70 * SECONDS);

    expect(await poll(T0 + 70 * SECONDS + POLL)).toMatchObject({
      state: "found",
      number: 7,
      stale: true,
      checkedAt: new Date(T0).toISOString(),
    });
  });

  it("logs why a listing failed without quoting git's message", async () => {
    // A refusal (not a network failure) whose text quotes the credentialed URL
    scenario.listings = { origin: new GitError("fatal: repository 'https://user:ghp_secret@github.com/o/r.git/' not found", false, 128) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await poll(T0);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("git exited with 128");
    expect(String(warn.mock.calls[0][0])).not.toContain("ghp_secret");
  });

  it("looks again within seconds after a push instead of waiting a minute, and keeps showing the request meanwhile", async () => {
    await poll(T0);
    expect(await poll(T0 + POLL)).toMatchObject({ state: "found", number: 7, stale: false });
    expect(lsRemoteCalls()).toHaveLength(1);

    // git push: the tip moves, the host has not updated the request's head yet
    scenario.tipSha = SHA_B;
    const rightAfterPush = await poll(T0 + 20 * SECONDS);
    expect(rightAfterPush).toMatchObject({ state: "found", number: 7, stale: true });
    expect(lsRemoteCalls()).toHaveLength(2);

    // that early listing still had the old head (the host lags): the request must not vanish
    scenario.listings = { origin: listing([SHA_B, "refs/merge-requests/7/head"]) };
    expect(await poll(T0 + 31 * SECONDS)).toMatchObject({ state: "found", number: 7, stale: true });

    // the regular listing after the host caught up confirms it
    await poll(T0 + 85 * SECONDS);
    expect(await poll(T0 + 92 * SECONDS)).toMatchObject({ state: "found", number: 7, stale: false });
  });

  it("drops the remembered request once a listing taken well after the push still lacks the tip", async () => {
    await poll(T0);
    await poll(T0 + POLL);

    scenario.tipSha = SHA_C;
    scenario.listings = { origin: "" };
    // The early listing is inside the host's lag: not proof yet
    expect(await poll(T0 + 20 * SECONDS)).toMatchObject({ state: "found", number: 7, stale: true });

    await poll(T0 + 85 * SECONDS);
    expect(await poll(T0 + 92 * SECONDS)).toMatchObject({ state: "none", stale: false });
  });

  it("serves the saved answer, stale, after a restart with the remote unreachable", async () => {
    await poll(T0);
    await poll(T0 + POLL);

    _resetReviewRequestsForTests();
    scenario.listings = { origin: unreachable() };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await poll(T0 + 500 * SECONDS)).toMatchObject({ state: "found", number: 7, stale: true, checkedAt: new Date(T0).toISOString() });
  });

  it("starts from nothing when the saved file is corrupt, without throwing", async () => {
    await fs.writeFile(path.join(hoisted.storeDirectory.value, "review-requests.json"), "{ not json", "utf8");
    scenario.listings = { origin: unreachable() };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await poll(T0)).toEqual({ state: "unknown" });
  });

  it("keeps the saved file valid and complete when two remotes finish at once", async () => {
    scenario.remotes = { origin: "git@github.com:org/repo.git", other: "git@github.com:org/other.git" };
    scenario.listings = { origin: listing([SHA_A, "refs/pull/1/head"]), other: listing([SHA_B, "refs/pull/2/head"]) };

    await poll(T0);

    const saved = JSON.parse(await fs.readFile(path.join(hoisted.storeDirectory.value, "review-requests.json"), "utf8"));
    expect(Object.keys(saved.entries).sort()).toEqual(["github.com/org/other", "github.com/org/repo"]);
  });

  it("shares one listing between clones and remotes that point at the same repository", async () => {
    scenario.remotes = { origin: "git@github.com:org/repo.git", mirror: "https://github.com/org/repo.git" };

    await poll(T0);

    expect(lsRemoteCalls()).toHaveLength(1);
  });
});
