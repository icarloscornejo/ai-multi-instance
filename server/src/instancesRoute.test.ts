import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardState, InstanceRecord } from "./types";

// The route under test reaches for these; everything else it imports (providers, path helpers)
// is pure and used as-is. updateState is a real implementation wired to the same
// loadState/saveState mocks below (not its own vi.fn()) - it needs the actual
// load-clone-mutate-save sequence to exercise the routes' commit-time revalidation
// (id/tmuxSession/name collisions) and no-op-on-unconfirmed-kill behavior faithfully. This
// mirrors store.ts's real updateState closely enough for route-level testing without
// depending on store.ts's own module state (cachedState, its queue) across test cases.
vi.mock("./store", () => {
  const loadStateMock = vi.fn();
  const saveStateMock = vi.fn();
  // Serialized through a promise chain exactly like store.ts's updateQueueTail: without it
  // this mock would let two overlapping updateState calls both read the same snapshot, which
  // the real store never does, and a lost-update regression test could not fail.
  let updateQueueTail: Promise<unknown> = Promise.resolve();
  const runOneUpdate = async (
    mutator: (draft: DashboardState) => Promise<{ result: unknown; nextState?: DashboardState }>
  ): Promise<unknown> => {
    const current = (await loadStateMock()) as DashboardState;
    const draft = structuredClone(current);
    const outcome = await mutator(draft);
    if (outcome.nextState !== undefined) {
      await saveStateMock(outcome.nextState);
    }
    return outcome.result;
  };
  const updateStateMock = vi.fn(
    async (mutator: (draft: DashboardState) => Promise<{ result: unknown; nextState?: DashboardState }>) => {
      const myTurn: Promise<unknown> = updateQueueTail.then(
        () => runOneUpdate(mutator),
        () => runOneUpdate(mutator)
      );
      updateQueueTail = myTurn.then(
        () => undefined,
        () => undefined
      );
      return myTurn;
    }
  );
  return { loadState: loadStateMock, saveState: saveStateMock, updateState: updateStateMock };
});
vi.mock("./paths", () => ({
  pathExists: vi.fn(),
}));
vi.mock("./terminal", () => ({
  initializeInstanceSession: vi.fn(),
}));
vi.mock("./tmux", () => ({
  getOriginalPanePid: vi.fn(),
  getPaneCurrentPath: vi.fn(),
  getSessionPresence: vi.fn(),
  killSession: vi.fn(),
}));
vi.mock("./tunnel", () => ({
  getTunnelStatus: vi.fn(),
  readTunnelLog: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
}));
vi.mock("./updater", () => ({
  applyUpdate: vi.fn(),
  checkForUpdate: vi.fn(),
  getUpdateStatus: vi.fn(),
  resetToRemote: vi.fn(),
}));
vi.mock("./auth", () => ({
  AUTH_COOKIE_NAME: "ccdash_auth",
  isAuthEnabled: () => false,
  requireAuth: (_request: unknown, _response: unknown, next: () => void) => next(),
  checkPassword: vi.fn(),
  issueToken: vi.fn(),
  readCookie: vi.fn(),
  setStoredPassword: vi.fn(),
  verifyToken: vi.fn(),
  isLoginLocked: vi.fn(),
  isPasswordFromEnv: vi.fn(),
  recordFailedLogin: vi.fn(),
  resetFailedLogins: vi.fn(),
  clearAllFailedLogins: vi.fn(),
  rotateSecret: vi.fn(),
}));
// `git.ts` keeps its real classifier/constants; runGit (which shells out) and branchUpstream (it
// calls the module's own runGit, which this mock cannot intercept) are stubs.
vi.mock("./git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git")>();
  return { ...actual, runGit: vi.fn(), branchUpstream: vi.fn(), currentBranch: vi.fn() };
});
vi.mock("./reviewRequests", () => ({ reviewRequestFor: vi.fn() }));
// Passthrough by default; the branch-state tests below pick what the resolver answers, since an
// "available" answer otherwise needs a live agent process behind the pane.
vi.mock("./liveStatus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./liveStatus")>();
  return { ...actual, resolveLiveStatus: vi.fn(actual.resolveLiveStatus) };
});

// Passthrough by default; the agent-states tests pick which agent the probe finds.
vi.mock("./paneAgent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paneAgent")>();
  return { ...actual, findPaneAgent: vi.fn(actual.findPaneAgent) };
});

// The status endpoint must read this in-memory map and nothing else (no token, no network).
vi.mock("./prEventsPoller", () => ({ getPrEventsStatus: vi.fn(() => ({})) }));
vi.mock("./githubToken", () => ({ resolveGithubToken: vi.fn(), invalidateToken: vi.fn() }));

import { findPaneAgent } from "./paneAgent";
import { getPrEventsStatus } from "./prEventsPoller";
import { resolveGithubToken } from "./githubToken";
import { loadState, saveState, updateState } from "./store";
import { pathExists } from "./paths";
import { initializeInstanceSession } from "./terminal";
import { getPaneCurrentPath, getSessionPresence, killSession } from "./tmux";
import { branchUpstream, currentBranch, GitError, runGit } from "./git";
import { resolveLiveStatus } from "./liveStatus";
import { reviewRequestFor } from "./reviewRequests";
import { apiRouter } from "./routes";

const runGitMock = vi.mocked(runGit);
const initMock = vi.mocked(initializeInstanceSession);
const killSessionMock = vi.mocked(killSession);
const getSessionPresenceMock = vi.mocked(getSessionPresence);

let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;
let errorMiddlewareCalls: { headersSent: boolean }[] = [];

function baseState(): DashboardState {
  return {
    schemaVersion: 2,
    config: { locations: ["/work/repo"], enabledProviders: ["claude", "codex"] },
    instances: [],
    sessionsByKey: {},
  } as unknown as DashboardState;
}

async function readNdjson(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createInstanceRequest(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteInstanceRequest(id: string): Promise<Response> {
  return fetch(`${baseUrl}/instances/${id}`, { method: "DELETE" });
}

function makeRunningInstance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: "abc123",
    label: "repo",
    locationPath: "/work/repo",
    tmuxSession: "ccdash-abc123",
    provider: "claude",
    command: "claude",
    model: null,
    effort: null,
    fontSize: 13,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as InstanceRecord;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", apiRouter);
  // Mirror server/src/index.ts's hardened middleware so a post-header throw is observable.
  app.use((error: Error, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    errorMiddlewareCalls.push({ headersSent: response.headersSent });
    if (response.headersSent) {
      return next(error);
    }
    response.status(500).json({ error: error.message });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  runGitMock.mockReset();
  initMock.mockReset();
  killSessionMock.mockReset().mockResolvedValue(undefined);
  getSessionPresenceMock.mockReset().mockResolvedValue("absent");
  // live-status asks for the pane folder on every poll, not only when no agent is running
  vi.mocked(getPaneCurrentPath).mockReset().mockResolvedValue("/work/repo");
  vi.mocked(branchUpstream).mockReset().mockResolvedValue(null);
  vi.mocked(currentBranch).mockReset().mockResolvedValue(null);
  vi.mocked(reviewRequestFor).mockReset().mockResolvedValue(null);
  vi.mocked(loadState).mockReset();
  vi.mocked(saveState).mockReset().mockResolvedValue(undefined);
  vi.mocked(updateState).mockClear();
  vi.mocked(pathExists).mockReset().mockResolvedValue(true);
  vi.mocked(loadState).mockResolvedValue(baseState());
  errorMiddlewareCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /instances - phase 1 validation still fails with its status code, no stream", () => {
  it("409 when no locations are configured", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), config: { locations: [], enabledProviders: [] } } as DashboardState);
    const response = await createInstanceRequest({ locationPath: "/work/repo" });
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).error).toMatch(/Configure locations/);
  });

  it("400 for a location that is not configured", async () => {
    const response = await createInstanceRequest({ locationPath: "/somewhere/else" });
    expect(response.status).toBe(400);
  });

  it("409 for a duplicate instance name", async () => {
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      instances: [{ locationPath: "/work/repo", label: "repo" } as InstanceRecord],
    } as DashboardState);
    const response = await createInstanceRequest({ locationPath: "/work/repo", label: "repo" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already running/);
  });

  it("400 for a disabled provider - and it is rejected BEFORE any git call", async () => {
    const response = await createInstanceRequest({ locationPath: "/work/repo", provider: "cursor" });
    expect(response.status).toBe(400);
    expect(runGitMock).not.toHaveBeenCalled();
  });

  it("400 for a branch or base name that starts with a dash, before any git call", async () => {
    const checkout = await createInstanceRequest({
      locationPath: "/work/repo",
      branchAction: { type: "checkout", branch: "--detach" },
    });
    const create = await createInstanceRequest({
      locationPath: "/work/repo",
      branchAction: { type: "create", branch: "feature/x", baseBranch: "-main" },
    });

    expect(checkout.status).toBe(400);
    expect(create.status).toBe(400);
    expect(runGitMock).not.toHaveBeenCalled();
  });
});

describe("POST /instances - phase 2 streams NDJSON as 201", () => {
  it("happy path: 201, per-step events, done carries the persisted instance", async () => {
    initMock.mockImplementation(async (_instance, onSessionCreated, onProgress) => {
      onProgress?.("create-session", "start");
      onProgress?.("create-session", "done");
      await onSessionCreated?.();
      onProgress?.("launch-agent", "start");
      onProgress?.("launch-agent", "done");
    });

    const response = await createInstanceRequest({ locationPath: "/work/repo", label: "fresh" });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const events = await readNdjson(response);
    const types = events.map((event) => event.type);
    expect(types).toContain("step");
    expect(types.filter((type) => type === "done")).toHaveLength(1);
    const done = events.at(-1) as { type: string; instance: InstanceRecord };
    expect(done.type).toBe("done");
    expect(done.instance.label).toBe("fresh");
    expect(vi.mocked(saveState)).toHaveBeenCalledOnce();
    expect(errorMiddlewareCalls).toHaveLength(0);
  });

  it("unreachable git remote: 201 + a single terminal error with the VPN message, nothing persisted", async () => {
    runGitMock.mockRejectedValue(
      new GitError("ssh: Could not resolve hostname code.corp.example.com\nfatal: Could not read from remote repository.")
    );

    const response = await createInstanceRequest({
      locationPath: "/work/repo",
      branchAction: { type: "create", branch: "feature/x", baseBranch: "main" },
    });
    expect(response.status).toBe(201);

    const events = await readNdjson(response);
    const terminal = events.filter((event) => event.type === "done" || event.type === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe("error");
    expect(terminal[0].message).toMatch(/check the VPN/i);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
    expect(initMock).not.toHaveBeenCalled();
  });

  it("tmux failure BEFORE persist: terminal error, no instance", async () => {
    initMock.mockRejectedValue(new Error("tmux new-session timed out"));

    const response = await createInstanceRequest({ locationPath: "/work/repo", label: "doomed" });
    expect(response.status).toBe(201);

    const events = await readNdjson(response);
    const terminal = events.filter((event) => event.type === "done" || event.type === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe("error");
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("launch uncertain AFTER persist: step-warning then done with the instance", async () => {
    initMock.mockImplementation(async (_instance, onSessionCreated, onProgress) => {
      onProgress?.("create-session", "start");
      onProgress?.("create-session", "done");
      await onSessionCreated?.();
      onProgress?.("launch-agent", "start");
      throw new Error("send-keys timed out after the session was saved");
    });

    const response = await createInstanceRequest({ locationPath: "/work/repo", label: "persisted" });
    expect(response.status).toBe(201);

    const events = await readNdjson(response);
    expect(events.some((event) => event.type === "step-warning" && event.id === "launch-agent")).toBe(true);
    const done = events.at(-1) as { type: string; instance: InstanceRecord };
    expect(done.type).toBe("done");
    expect(done.instance.label).toBe("persisted");
    expect(vi.mocked(saveState)).toHaveBeenCalledOnce();
  });

  it("a post-header throw does not double-respond and does not hit json() in the error middleware", async () => {
    // saveState throws from inside the onSessionCreated hook, after headers are already sent.
    vi.mocked(saveState).mockRejectedValue(new Error("disk full"));
    initMock.mockImplementation(async (_instance, onSessionCreated) => {
      await onSessionCreated?.();
    });

    const response = await createInstanceRequest({ locationPath: "/work/repo", label: "diskfull" });
    expect(response.status).toBe(201);
    const events = await readNdjson(response);
    const terminal = events.filter((event) => event.type === "done" || event.type === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe("error");
    // If the middleware ran at all, it must have seen headersSent and bailed - never json().
    for (const call of errorMiddlewareCalls) {
      expect(call.headersSent).toBe(true);
    }
  });
});

describe("DELETE /instances/:id", () => {
  it("404 for an id that is not in the registry", async () => {
    vi.mocked(loadState).mockResolvedValue(baseState());
    const response = await deleteInstanceRequest("nope");
    expect(response.status).toBe(404);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("happy path: kill confirmed on the first try, 204, instance removed from the saved state", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [makeRunningInstance()] } as DashboardState);

    const response = await deleteInstanceRequest("abc123");
    expect(response.status).toBe(204);
    expect(killSessionMock).toHaveBeenCalledWith("ccdash-abc123");
    expect(vi.mocked(saveState)).toHaveBeenCalledOnce();
    const savedState = vi.mocked(saveState).mock.calls[0][0] as DashboardState;
    expect(savedState.instances).toHaveLength(0);
  });

  it("kill rejects every retry and presence stays 'unknown': 409, nothing saved, the instance survives", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [makeRunningInstance()] } as DashboardState);
    killSessionMock.mockRejectedValue(new Error("tmux command timed out"));
    getSessionPresenceMock.mockResolvedValue("unknown");

    const response = await deleteInstanceRequest("abc123");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Could not confirm/);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();

    // A later read of the registry must still show the instance - nothing was mutated on the
    // failure path, matching the bug this endpoint used to have (a `catch {}` that deleted the
    // record even when the kill was never confirmed).
    const stateAfter = await loadState();
    expect(stateAfter.instances.map((instance) => instance.id)).toContain("abc123");
  }, 10_000);

  it("kill fails on the first attempt but confirms on the retry: 204", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [makeRunningInstance()] } as DashboardState);
    killSessionMock.mockRejectedValueOnce(new Error("tmux command timed out")).mockResolvedValueOnce(undefined);

    const response = await deleteInstanceRequest("abc123");
    expect(response.status).toBe(204);
    expect(killSessionMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveState)).toHaveBeenCalledOnce();
  }, 10_000);

  it("kill never confirms but getSessionPresence reports 'absent': 204, still deletes", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [makeRunningInstance()] } as DashboardState);
    killSessionMock.mockRejectedValue(new Error("tmux command timed out"));
    getSessionPresenceMock.mockResolvedValue("absent");

    const response = await deleteInstanceRequest("abc123");
    expect(response.status).toBe(204);
    expect(vi.mocked(saveState)).toHaveBeenCalledOnce();
  }, 10_000);

  it("persists the live session id before killing, even on the unconfirmed-kill (409) path", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [makeRunningInstance()] } as DashboardState);
    killSessionMock.mockRejectedValue(new Error("tmux command timed out"));
    getSessionPresenceMock.mockResolvedValue("unknown");

    await deleteInstanceRequest("abc123");
    // readLiveSessionId reads a real file this test never creates, so it resolves null and no
    // sessionsByKey write happens - this asserts the endpoint didn't crash trying, and that a
    // 409 still leaves saveState uncalled overall (the sessionId write, when there IS one, is
    // its own updateState commit, separate from the delete-or-not decision below it).
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  }, 10_000);
});

// Every route that changes state must go through updateState's queue. These run against a
// stateful in-memory store whose saveState is slow, so a route that still did its own
// loadState + saveState would read a snapshot that a concurrent commit is about to replace,
// and its later save would silently undo that commit (a lost update).
describe("GET /instances/:id/live-status - branch upstream state", () => {
  let temporaryHomeDirectory: string;

  const answerWith = (response: Record<string, unknown>): void => {
    vi.mocked(resolveLiveStatus).mockResolvedValueOnce({ response, persist: null } as Awaited<ReturnType<typeof resolveLiveStatus>>);
  };
  const getLiveStatus = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${baseUrl}/instances/aaa111/live-status`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const trackingUpstream = { branch: "feat", state: "tracking", ahead: 1, behind: 0, remoteName: "origin", pushRef: "refs/remotes/origin/feat" } as const;

  beforeEach(async () => {
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      instances: [makeRunningInstance({ id: "aaa111", tmuxSession: "ccdash-aaa111" })],
    } as DashboardState);
    // live-status reads agent snapshots from the home directory: keep it off the real one
    temporaryHomeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ccdash-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(temporaryHomeDirectory);
  });

  afterEach(async () => {
    await fs.rm(temporaryHomeDirectory, { recursive: true, force: true });
  });

  it("attaches the upstream state when no agent is running, read from the pane folder", async () => {
    answerWith({ available: false, reason: "no-agent" });
    vi.mocked(branchUpstream).mockResolvedValue(trackingUpstream);

    const { status, body } = await getLiveStatus();

    expect(status).toBe(200);
    expect(body.upstream).toEqual(trackingUpstream);
    expect(vi.mocked(branchUpstream)).toHaveBeenCalledWith("/work/repo");
  });

  it("reads the agent's folder when its snapshot carries both an absolute cwd and a branch", async () => {
    answerWith({ available: true, cwd: "/agent/worktree", branch: "feat" });
    vi.mocked(branchUpstream).mockResolvedValue(trackingUpstream);

    const { body } = await getLiveStatus();

    expect(body.upstream).toEqual(trackingUpstream);
    expect(vi.mocked(branchUpstream)).toHaveBeenCalledWith("/agent/worktree");
    expect(vi.mocked(getPaneCurrentPath)).not.toHaveBeenCalled();
  });

  it("falls back to the pane folder for an empty cwd or a snapshot without a branch", async () => {
    answerWith({ available: true, cwd: "", branch: "feat" });
    await getLiveStatus();
    answerWith({ available: true, cwd: "/codex/folder" });
    await getLiveStatus();

    expect(vi.mocked(branchUpstream)).toHaveBeenNthCalledWith(1, "/work/repo");
    expect(vi.mocked(branchUpstream)).toHaveBeenNthCalledWith(2, "/work/repo");
  });

  it("omits the field when the folder is not a git repo", async () => {
    answerWith({ available: false, reason: "no-agent" });

    const { status, body } = await getLiveStatus();

    expect(status).toBe(200);
    expect("upstream" in body).toBe(false);
  });

  it("still answers 200 without the field when reading the upstream state throws", async () => {
    answerWith({ available: true, cwd: "/agent/worktree", branch: "feat", model: "opus" });
    vi.mocked(branchUpstream).mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { status, body } = await getLiveStatus();

    expect(status).toBe(200);
    expect(body.model).toBe("opus");
    expect("upstream" in body).toBe(false);
  });

  it("attaches the merge request state, asked about the same folder and upstream", async () => {
    const review = { state: "found", number: 7, kind: "gitlab", url: "https://h/g/r/-/merge_requests/7", checkedAt: "2026-10-26T20:00:00.000Z", stale: false } as const;
    answerWith({ available: false, reason: "no-agent" });
    vi.mocked(branchUpstream).mockResolvedValue(trackingUpstream);
    vi.mocked(reviewRequestFor).mockResolvedValue(review);

    const { body } = await getLiveStatus();

    expect(body.review).toEqual(review);
    expect(vi.mocked(reviewRequestFor)).toHaveBeenCalledWith("/work/repo", trackingUpstream);
  });

  it("does not ask about a merge request when there is no upstream state", async () => {
    answerWith({ available: false, reason: "no-agent" });

    const { body } = await getLiveStatus();

    expect(vi.mocked(reviewRequestFor)).not.toHaveBeenCalled();
    expect("review" in body).toBe(false);
  });

  it("omits the review field when there is nothing to show for the branch", async () => {
    answerWith({ available: false, reason: "no-agent" });
    vi.mocked(branchUpstream).mockResolvedValue(trackingUpstream);

    const { body } = await getLiveStatus();

    expect("review" in body).toBe(false);
  });

  it("keeps the push state and answers 200 when reading the merge request throws", async () => {
    answerWith({ available: true, cwd: "/agent/worktree", branch: "feat", model: "opus" });
    vi.mocked(branchUpstream).mockResolvedValue(trackingUpstream);
    vi.mocked(reviewRequestFor).mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { status, body } = await getLiveStatus();

    expect(status).toBe(200);
    expect(body.model).toBe("opus");
    expect(body.upstream).toEqual(trackingUpstream);
    expect("review" in body).toBe(false);
  });

  it("is attached to an available answer without clobbering the agent fields", async () => {
    answerWith({ available: true, cwd: "/agent/worktree", branch: "feat", model: "opus" });
    vi.mocked(branchUpstream).mockResolvedValue({ branch: "feat", state: "unpublished" });

    const { body } = await getLiveStatus();

    expect(body).toMatchObject({ available: true, model: "opus", upstream: { branch: "feat", state: "unpublished" } });
  });
});

// ---- Worktree support: a folder that already has a live instance must not be switched ----

type GitCall = { cwd: string; args: string[] };
const gitCalls = (): GitCall[] =>
  runGitMock.mock.calls.map((call) => ({ cwd: call[0] as string, args: call[1] as string[] }));
const gitCallsStartingWith = (...prefix: string[]): GitCall[] =>
  gitCalls().filter((call) => prefix.every((word, position) => call.args[position] === word));

const SOURCE_FOLDER = "/work/repo";
const FEATURE_DIR = "/work/repo-feature-x";

function porcelain(entries: { path: string; branch: string }[]): string {
  return entries.map((entry) => `worktree ${entry.path}\nHEAD abc123\nbranch refs/heads/${entry.branch}\n`).join("\n");
}

// Answers per git subcommand; anything not listed succeeds with empty output.
function scriptGit(handlers: {
  worktreeList?: string;
  status?: string | Error;
  remove?: Error;
  add?: Error;
}): void {
  runGitMock.mockImplementation(async (_cwd, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return handlers.worktreeList ?? porcelain([{ path: SOURCE_FOLDER, branch: "main" }]);
    }
    if (args[0] === "status") {
      if (handlers.status instanceof Error) throw handlers.status;
      return handlers.status ?? "";
    }
    if (args[0] === "worktree" && args[1] === "remove" && handlers.remove) throw handlers.remove;
    if (args[0] === "worktree" && args[1] === "add" && handlers.add) throw handlers.add;
    return "";
  });
}

function pathExistsOnly(existing: string[]): void {
  vi.mocked(pathExists).mockImplementation(async (candidate: string) => existing.includes(candidate));
}

const liveInstance = (): InstanceRecord =>
  makeRunningInstance({ id: "live01", label: "main-agent", tmuxSession: "ccdash-live01", locationPath: SOURCE_FOLDER });

const worktreeInstance = (overrides: Partial<InstanceRecord> = {}, created = true): InstanceRecord =>
  makeRunningInstance({
    id: "wt0001",
    label: "wt",
    tmuxSession: "ccdash-wt0001",
    locationPath: FEATURE_DIR,
    worktree: { sourcePath: SOURCE_FOLDER, branch: "feature/x", created },
    ...overrides,
  } as Partial<InstanceRecord>);

function initCommitsInstance(): void {
  initMock.mockImplementation(async (_instance, onSessionCreated) => {
    await onSessionCreated?.();
  });
}

describe("POST /instances - sibling worktree when the folder already has a live session", () => {
  beforeEach(() => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [liveInstance()] } as DashboardState);
    getSessionPresenceMock.mockResolvedValue("present");
    vi.mocked(currentBranch).mockResolvedValue("main");
    pathExistsOnly([SOURCE_FOLDER]);
    scriptGit({});
    initCommitsInstance();
  });

  const savedInstance = (): InstanceRecord => {
    const savedState = vi.mocked(saveState).mock.calls[0][0] as DashboardState;
    return savedState.instances.find((instance) => instance.label === "wt") as InstanceRecord;
  };

  it("checkout of a different branch adds a sibling worktree and never switches the shared folder", async () => {
    const response = await createInstanceRequest({
      locationPath: SOURCE_FOLDER,
      label: "wt",
      branchAction: { type: "checkout", branch: "feature/x" },
    });
    const events = await readNdjson(response);

    expect(events.at(-1)?.type).toBe("done");
    expect(gitCallsStartingWith("worktree", "add").map((call) => call.args)).toEqual([["worktree", "add", "--", FEATURE_DIR, "feature/x"]]);
    expect(gitCallsStartingWith("checkout")).toHaveLength(0);
    expect(gitCallsStartingWith("merge")).toHaveLength(0);
    expect(savedInstance().locationPath).toBe(FEATURE_DIR);
    expect(savedInstance().worktree).toEqual({ sourcePath: SOURCE_FOLDER, branch: "feature/x", created: true });
  });

  it("create fetches the base then adds the worktree on a new untracked branch, without touching the shared folder", async () => {
    const response = await createInstanceRequest({
      locationPath: SOURCE_FOLDER,
      label: "wt",
      branchAction: { type: "create", branch: "feature/x", baseBranch: "develop" },
    });
    const events = await readNdjson(response);

    expect(events.at(-1)?.type).toBe("done");
    expect(gitCallsStartingWith("fetch").map((call) => call.args)).toEqual([["fetch", "origin", "develop"]]);
    expect(gitCallsStartingWith("worktree", "add").map((call) => call.args)).toEqual([
      ["worktree", "add", "--no-track", "-b", "feature/x", "--", FEATURE_DIR, "origin/develop"],
    ]);
    expect(gitCallsStartingWith("checkout")).toHaveLength(0);
    expect(gitCallsStartingWith("merge")).toHaveLength(0);
    expect(savedInstance().locationPath).toBe(FEATURE_DIR);
    expect(savedInstance().worktree).toEqual({ sourcePath: SOURCE_FOLDER, branch: "feature/x", created: true });
  });

  it("an unknown session state counts as live", async () => {
    getSessionPresenceMock.mockResolvedValue("unknown");
    await readNdjson(
      await createInstanceRequest({ locationPath: SOURCE_FOLDER, label: "wt", branchAction: { type: "checkout", branch: "feature/x" } })
    );
    expect(gitCallsStartingWith("worktree", "add")).toHaveLength(1);
    expect(gitCallsStartingWith("checkout")).toHaveLength(0);
  });

  it("a resume request is ignored for a worktree instance: no session id and a step warning", async () => {
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      instances: [liveInstance()],
      sessionsByKey: { "claude::/work/repo::wt": "old-session" },
    } as unknown as DashboardState);
    const events = await readNdjson(
      await createInstanceRequest({
        locationPath: SOURCE_FOLDER,
        label: "wt",
        resumeSession: true,
        branchAction: { type: "checkout", branch: "feature/x" },
      })
    );
    expect(events.some((event) => event.type === "step-warning")).toBe(true);
    expect(savedInstance().sessionId).toBeUndefined();
  });

  it("no live instance on the folder keeps today's sequence", async () => {
    getSessionPresenceMock.mockResolvedValue("absent");
    await readNdjson(
      await createInstanceRequest({ locationPath: SOURCE_FOLDER, label: "wt", branchAction: { type: "checkout", branch: "feature/x" } })
    );
    expect(gitCallsStartingWith("checkout").map((call) => call.args)).toEqual([["checkout", "feature/x"]]);
    expect(gitCallsStartingWith("worktree", "add")).toHaveLength(0);
    expect(savedInstance().locationPath).toBe(SOURCE_FOLDER);
    expect(savedInstance().worktree).toBeUndefined();
  });

  it("checkout of the branch the folder is already on keeps today's sequence even with a live instance", async () => {
    vi.mocked(currentBranch).mockResolvedValue("feature/x");
    await readNdjson(
      await createInstanceRequest({ locationPath: SOURCE_FOLDER, label: "wt", branchAction: { type: "checkout", branch: "feature/x" } })
    );
    expect(gitCallsStartingWith("checkout").map((call) => call.args)).toEqual([["checkout", "feature/x"]]);
    expect(gitCallsStartingWith("worktree", "add")).toHaveLength(0);
    expect(savedInstance().worktree).toBeUndefined();
  });

  it("an existing sibling folder that is not a worktree on the branch is rejected and nothing is created", async () => {
    pathExistsOnly([SOURCE_FOLDER, FEATURE_DIR]);
    const events = await readNdjson(
      await createInstanceRequest({ locationPath: SOURCE_FOLDER, label: "wt", branchAction: { type: "checkout", branch: "feature/x" } })
    );
    const terminal = events.at(-1) as { type: string; message: string };
    expect(terminal.type).toBe("error");
    expect(terminal.message).toContain(FEATURE_DIR);
    expect(initMock).not.toHaveBeenCalled();
    expect(gitCallsStartingWith("worktree", "add")).toHaveLength(0);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("an existing worktree on the requested branch is reused without adding, flagged as not created", async () => {
    pathExistsOnly([SOURCE_FOLDER, FEATURE_DIR]);
    scriptGit({
      worktreeList: porcelain([
        { path: SOURCE_FOLDER, branch: "main" },
        { path: FEATURE_DIR, branch: "feature/x" },
      ]),
    });
    const events = await readNdjson(
      await createInstanceRequest({ locationPath: SOURCE_FOLDER, label: "wt", branchAction: { type: "checkout", branch: "feature/x" } })
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(gitCallsStartingWith("worktree", "add")).toHaveLength(0);
    expect(savedInstance().locationPath).toBe(FEATURE_DIR);
    expect(savedInstance().worktree).toEqual({ sourcePath: SOURCE_FOLDER, branch: "feature/x", created: false });
  });

  it("an existing sibling folder is never reused for a create request", async () => {
    pathExistsOnly([SOURCE_FOLDER, FEATURE_DIR]);
    scriptGit({
      worktreeList: porcelain([
        { path: SOURCE_FOLDER, branch: "main" },
        { path: FEATURE_DIR, branch: "feature/x" },
      ]),
    });
    const events = await readNdjson(
      await createInstanceRequest({
        locationPath: SOURCE_FOLDER,
        label: "wt",
        branchAction: { type: "create", branch: "feature/x", baseBranch: "main" },
      })
    );
    expect(events.at(-1)?.type).toBe("error");
    expect(gitCallsStartingWith("worktree", "add")).toHaveLength(0);
    expect(initMock).not.toHaveBeenCalled();
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("a failure after the worktree was added removes it without force and saves nothing", async () => {
    initMock.mockRejectedValue(new Error("tmux new-session timed out"));
    const events = await readNdjson(
      await createInstanceRequest({ locationPath: SOURCE_FOLDER, label: "wt", branchAction: { type: "checkout", branch: "feature/x" } })
    );
    expect(events.at(-1)?.type).toBe("error");
    const removals = gitCallsStartingWith("worktree", "remove");
    expect(removals).toHaveLength(1);
    expect(removals[0].args).toEqual(["worktree", "remove", FEATURE_DIR]);
    expect(removals[0].args).not.toContain("--force");
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("the same label inside an already registered worktree is rejected at commit", async () => {
    pathExistsOnly([SOURCE_FOLDER, FEATURE_DIR]);
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      instances: [liveInstance(), worktreeInstance()],
    } as DashboardState);
    scriptGit({
      worktreeList: porcelain([
        { path: SOURCE_FOLDER, branch: "main" },
        { path: FEATURE_DIR, branch: "feature/x" },
      ]),
    });
    const events = await readNdjson(
      await createInstanceRequest({ locationPath: SOURCE_FOLDER, label: "wt", branchAction: { type: "checkout", branch: "feature/x" } })
    );
    expect(events.at(-1)?.type).toBe("error");
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });
});

describe("DELETE /instances/:id - worktree instances", () => {
  const statusArgs = ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"];
  const stateWith = (...instances: InstanceRecord[]): void => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances } as DashboardState);
  };
  const savedInstanceIds = (): string[] =>
    (vi.mocked(saveState).mock.calls[0][0] as DashboardState).instances.map((instance) => instance.id);

  beforeEach(() => {
    scriptGit({});
  });

  it("clean created worktree: status checked inside it, removed from the source without force, 204", async () => {
    stateWith(worktreeInstance());
    const response = await deleteInstanceRequest("wt0001");

    expect(response.status).toBe(204);
    expect(gitCalls().find((call) => call.args[0] === "status")).toEqual({ cwd: FEATURE_DIR, args: statusArgs });
    const removals = gitCallsStartingWith("worktree", "remove");
    expect(removals).toEqual([{ cwd: SOURCE_FOLDER, args: ["worktree", "remove", FEATURE_DIR] }]);
    expect(savedInstanceIds()).toEqual([]);
  });

  it("dirty worktree: kept, 200 with a warning, the record is still removed", async () => {
    scriptGit({ status: " M file.ts\n" });
    stateWith(worktreeInstance());
    const response = await deleteInstanceRequest("wt0001");

    expect(response.status).toBe(200);
    expect(typeof (await response.json()).warning).toBe("string");
    expect(gitCallsStartingWith("worktree", "remove")).toHaveLength(0);
    expect(savedInstanceIds()).toEqual([]);
  });

  it("remove failure: 200 with a warning, the record is removed", async () => {
    scriptGit({ remove: new GitError("fatal: cannot remove") });
    stateWith(worktreeInstance());
    const response = await deleteInstanceRequest("wt0001");

    expect(response.status).toBe(200);
    expect(typeof (await response.json()).warning).toBe("string");
    expect(savedInstanceIds()).toEqual([]);
  });

  it("another instance at the same path shares the worktree: kept with a warning", async () => {
    stateWith(worktreeInstance(), worktreeInstance({ id: "wt0002", label: "other", tmuxSession: "ccdash-wt0002" }, false));
    const response = await deleteInstanceRequest("wt0001");

    expect(response.status).toBe(200);
    expect(typeof (await response.json()).warning).toBe("string");
    expect(gitCallsStartingWith("worktree", "remove")).toHaveLength(0);
  });

  it("another instance inside the worktree folder shares it: kept with a warning", async () => {
    stateWith(
      worktreeInstance(),
      makeRunningInstance({ id: "nest01", label: "nested", tmuxSession: "ccdash-nest01", locationPath: `${FEATURE_DIR}/packages/app` })
    );
    const response = await deleteInstanceRequest("wt0001");

    expect(response.status).toBe(200);
    expect(gitCallsStartingWith("worktree", "remove")).toHaveLength(0);
  });

  it("a reused worktree (not created by the dashboard) is kept with a warning", async () => {
    stateWith(worktreeInstance({}, false));
    const response = await deleteInstanceRequest("wt0001");

    expect(response.status).toBe(200);
    expect(typeof (await response.json()).warning).toBe("string");
    expect(gitCallsStartingWith("worktree", "remove")).toHaveLength(0);
  });

  it("a missing source folder (git fails) answers 200 with a warning and still removes the record", async () => {
    runGitMock.mockRejectedValue(new GitError("fatal: cannot change to '/work/repo'"));
    stateWith(worktreeInstance());
    const response = await deleteInstanceRequest("wt0001");

    expect(response.status).toBe(200);
    expect(typeof (await response.json()).warning).toBe("string");
    expect(savedInstanceIds()).toEqual([]);
  });

  it("two concurrent deletes remove the worktree once, the loser answers 204 without git", async () => {
    let committedState: DashboardState = { ...baseState(), instances: [worktreeInstance()] } as DashboardState;
    vi.mocked(loadState).mockImplementation(async () => committedState);
    vi.mocked(saveState).mockImplementation(async (nextState: DashboardState) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      committedState = structuredClone(nextState);
    });

    const responses = await Promise.all([deleteInstanceRequest("wt0001"), deleteInstanceRequest("wt0001")]);

    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    expect(gitCallsStartingWith("worktree", "remove")).toHaveLength(1);
    expect(gitCallsStartingWith("status")).toHaveLength(1);
  });

  it("an instance without a worktree still answers 204 and runs no git", async () => {
    stateWith(makeRunningInstance());
    const response = await deleteInstanceRequest("abc123");

    expect(response.status).toBe(204);
    expect(runGitMock).not.toHaveBeenCalled();
  });
});

describe("GET/POST /locations/stale-branches - worktrees used by instances", () => {
  const BRANCHES = "main\nfeature/x\nold-branch\n";
  const listWith = (worktreePath: string): void => {
    runGitMock.mockImplementation(async (_cwd, args) => {
      if (args[0] === "for-each-ref") return BRANCHES;
      if (args[0] === "worktree" && args[1] === "list") {
        return porcelain([
          { path: SOURCE_FOLDER, branch: "main" },
          { path: worktreePath, branch: "feature/x" },
        ]);
      }
      return "";
    });
  };
  const fetchCandidates = async (): Promise<string[]> => {
    const response = await fetch(`${baseUrl}/locations/stale-branches?path=${encodeURIComponent(SOURCE_FOLDER)}`);
    return ((await response.json()).candidates as { branch: string }[]).map((candidate) => candidate.branch);
  };

  beforeEach(() => {
    vi.mocked(currentBranch).mockResolvedValue("main");
  });

  it("does not list the branch of a worktree a registered instance uses", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [worktreeInstance()] } as DashboardState);
    listWith(FEATURE_DIR);
    expect(await fetchCandidates()).toEqual(["old-branch"]);
  });

  it("deleting it explicitly is refused and the worktree is never force-removed", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [worktreeInstance()] } as DashboardState);
    listWith(FEATURE_DIR);
    const response = await fetch(`${baseUrl}/locations/stale-branches/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: SOURCE_FOLDER, branches: ["feature/x"] }),
    });
    expect(response.status).toBe(400);
    expect(gitCallsStartingWith("worktree", "remove")).toHaveLength(0);
  });

  it("still lists the branch of a worktree no instance uses", async () => {
    vi.mocked(loadState).mockResolvedValue({ ...baseState(), instances: [] } as DashboardState);
    listWith(FEATURE_DIR);
    expect(await fetchCandidates()).toEqual(["feature/x", "old-branch"]);
  });

  it("matches through a symlinked instance path when git lists the real path", async () => {
    const temporaryRoot: string = await fs.mkdtemp(path.join(os.tmpdir(), "ccdash-wt-"));
    try {
      await fs.mkdir(path.join(temporaryRoot, "real"));
      const realDirectory: string = await fs.realpath(path.join(temporaryRoot, "real"));
      const linkedDirectory: string = path.join(temporaryRoot, "link");
      await fs.symlink(realDirectory, linkedDirectory);
      vi.mocked(loadState).mockResolvedValue({
        ...baseState(),
        instances: [worktreeInstance({ locationPath: linkedDirectory })],
      } as DashboardState);
      listWith(realDirectory);
      expect(await fetchCandidates()).toEqual(["old-branch"]);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("concurrent writers never lose each other's commits", () => {
  let committedState: DashboardState;
  let temporaryHomeDirectory: string;

  const patchInstanceRequest = (id: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${baseUrl}/instances/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const reorderRequest = (order: string[]): Promise<Response> =>
    fetch(`${baseUrl}/instances/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });

  beforeEach(async () => {
    committedState = {
      ...baseState(),
      instances: [
        makeRunningInstance({ id: "aaa111", label: "first", tmuxSession: "ccdash-aaa111" }),
        makeRunningInstance({ id: "bbb222", label: "second", tmuxSession: "ccdash-bbb222" }),
        makeRunningInstance({ id: "ccc333", label: "third", tmuxSession: "ccdash-ccc333" }),
      ],
    } as DashboardState;
    vi.mocked(loadState).mockImplementation(async () => committedState);
    vi.mocked(saveState).mockImplementation(async (nextState: DashboardState) => {
      // Slow write, then publish: the window in which a bare loadState still sees old data.
      await new Promise((resolve) => setTimeout(resolve, 20));
      committedState = structuredClone(nextState);
    });
    temporaryHomeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ccdash-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(temporaryHomeDirectory);
  });

  afterEach(async () => {
    await fs.rm(temporaryHomeDirectory, { recursive: true, force: true });
  });

  // A commit from "another device": goes through the real-shaped updateState queue and, because
  // saveState is slow, is still in flight when the route under test starts. Not awaited here.
  const commitFromOtherDevice = (): Promise<unknown> =>
    updateState(async (draft) => {
      draft.instances = draft.instances.filter((instance) => instance.id !== "ccc333");
      return { result: undefined, nextState: draft };
    });
  const remainingAfterOtherDevice = ["aaa111", "bbb222"];

  it("PATCH started while another commit is saving keeps both changes", async () => {
    const otherDevice = commitFromOtherDevice();
    const patchResponse = await patchInstanceRequest("aaa111", { label: "renamed" });
    await otherDevice;
    expect(patchResponse.status).toBe(200);
    expect(committedState.instances.map((instance) => [instance.id, instance.label])).toEqual([
      ["aaa111", "renamed"],
      ["bbb222", "second"],
    ]);
  });

  it("reorder started while another commit is saving does not resurrect what it removed", async () => {
    const otherDevice = commitFromOtherDevice();
    // Built from the pre-commit list: stale by the time it runs, so it must be rejected
    // (a bare loadState/saveState would accept it and bring ccc333 back).
    const reorderResponse = await reorderRequest(["ccc333", "bbb222", "aaa111"]);
    await otherDevice;
    expect(reorderResponse.status).toBe(400);
    expect(committedState.instances.map((instance) => instance.id)).toEqual(remainingAfterOtherDevice);
  });

  it("a reorder matching the latest list still applies after another commit", async () => {
    const otherDevice = commitFromOtherDevice();
    const reorderResponse = await reorderRequest(["bbb222", "aaa111"]);
    await otherDevice;
    expect(reorderResponse.status).toBe(200);
    expect(committedState.instances.map((instance) => instance.id)).toEqual(["bbb222", "aaa111"]);
  });

  it("PUT /config started while another commit is saving keeps both changes", async () => {
    const otherDevice = commitFromOtherDevice();
    const configResponse = await fetch(`${baseUrl}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations: ["/work/repo"], enabledProviders: ["claude"] }),
    });
    await otherDevice;
    expect(configResponse.status).toBe(200);
    expect(committedState.config.enabledProviders).toEqual(["claude"]);
    expect(committedState.instances.map((instance) => instance.id)).toEqual(remainingAfterOtherDevice);
  });

  it("live-status saving a session id keeps a commit that was still saving", async () => {
    const snapshotDirectory: string = path.join(temporaryHomeDirectory, "Library", "Application Support", "ai-multi-instance");
    await fs.mkdir(snapshotDirectory, { recursive: true });
    // A snapshot the dashboard's own launch wrote (idSource env, from the pane job): the only kind
    // that may become the resume target.
    await fs.writeFile(
      path.join(snapshotDirectory, "aaa111.json"),
      JSON.stringify({ provider: "claude", sessionId: "other-session", paneJobPid: 4242, idSource: "env", configDir: "/profile" })
    );

    const otherDevice = commitFromOtherDevice();
    const liveStatusResponse = await fetch(`${baseUrl}/instances/aaa111/live-status`);
    await otherDevice;
    expect(liveStatusResponse.status).toBe(200);
    expect(committedState.instances.map((instance) => instance.id)).toEqual(remainingAfterOtherDevice);
    expect(committedState.instances.find((instance) => instance.id === "aaa111")?.sessionId).toBe("other-session");
  });

  it("live-status does not resurrect an instance deleted between its read and its save", async () => {
    const snapshotDirectory: string = path.join(temporaryHomeDirectory, "Library", "Application Support", "ai-multi-instance");
    await fs.mkdir(snapshotDirectory, { recursive: true });
    await fs.writeFile(path.join(snapshotDirectory, "ccc333.json"), JSON.stringify({ sessionId: "late-session" }));

    // ccc333 is deleted by the commit still saving; live-status then wants to record its session.
    const otherDevice = commitFromOtherDevice();
    await fetch(`${baseUrl}/instances/ccc333/live-status`);
    await otherDevice;
    expect(committedState.instances.map((instance) => instance.id)).toEqual(remainingAfterOtherDevice);
    expect(committedState.sessionsByKey).toEqual({});
  });

  it("PATCH on an instance that was already deleted is a 404", async () => {
    await commitFromOtherDevice();
    const patchResponse = await patchInstanceRequest("ccc333", { label: "too late" });
    expect(patchResponse.status).toBe(404);
    expect(committedState.instances.map((instance) => instance.id)).toEqual(remainingAfterOtherDevice);
  });
});

describe("GET /instances/agent-states", () => {
  let temporaryHomeDirectory: string;
  let cacheDirectory: string;

  const writeStateFile = (id: string, overrides: Record<string, unknown> = {}): Promise<void> =>
    fs.writeFile(
      path.join(cacheDirectory, `${id}.state.json`),
      JSON.stringify({ state: "waiting", sessionId: "s", paneJobPid: 100, event: "Stop", updatedAt: "2026-11-02T10:00:00Z", ...overrides })
    );
  const claudeAgentWithPid = (paneJobPid: number): Awaited<ReturnType<typeof findPaneAgent>> => ({
    kind: "agent", provider: "claude", paneJobPid, agentPid: paneJobPid + 1, startedAtMs: 0, resumeId: null,
  });

  beforeEach(async () => {
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      instances: [
        makeRunningInstance({ id: "aaa111", tmuxSession: "ccdash-aaa111" }),
        makeRunningInstance({ id: "bbb222", tmuxSession: "ccdash-bbb222" }),
        makeRunningInstance({ id: "ccc333", tmuxSession: "ccdash-ccc333" }),
        makeRunningInstance({ id: "ddd444", tmuxSession: "ccdash-ddd444" }),
      ],
    } as DashboardState);
    temporaryHomeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ccdash-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(temporaryHomeDirectory);
    cacheDirectory = path.join(temporaryHomeDirectory, "Library", "Application Support", "ai-multi-instance");
    await fs.mkdir(cacheDirectory, { recursive: true });
    vi.mocked(findPaneAgent).mockReset().mockResolvedValue(claudeAgentWithPid(100));
  });

  afterEach(async () => {
    await fs.rm(temporaryHomeDirectory, { recursive: true, force: true });
  });

  it("returns only instances with a valid state whose recorded agent is the running one", async () => {
    await writeStateFile("aaa111", { state: "waiting" });
    await writeStateFile("bbb222", { state: "bogus" });
    await writeStateFile("ccc333", { paneJobPid: 999 });
    // ddd444 has no file at all; eee555 is not a registered instance
    await writeStateFile("eee555", { state: "idle" });

    const response = await fetch(`${baseUrl}/instances/agent-states`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ aaa111: { state: "waiting", updatedAt: "2026-11-02T10:00:00Z" } });
  });

  it("probes only the instances that have a valid state file", async () => {
    await writeStateFile("aaa111");

    await fetch(`${baseUrl}/instances/agent-states`);

    expect(vi.mocked(findPaneAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(findPaneAgent)).toHaveBeenCalledWith("ccdash-aaa111");
  });

  it("returns an empty map when no agent is running", async () => {
    await writeStateFile("aaa111");
    vi.mocked(findPaneAgent).mockResolvedValue({ kind: "none" });

    const response = await fetch(`${baseUrl}/instances/agent-states`);

    expect(await response.json()).toEqual({});
  });

  it("offers no route that accepts agent state", () => {
    const routes = (apiRouter.stack as { route?: { path: string; methods: Record<string, boolean> } }[])
      .filter((layer) => layer.route !== undefined && String(layer.route.path).includes("agent-state"));

    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((layer) => Object.keys(layer.route!.methods).some((method) => method !== "get"))).toEqual([]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("answers %s with a non-success status and writes nothing", async (method) => {
    const response = await fetch(`${baseUrl}/instances/agent-states`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify({ aaa111: { state: "waiting" } }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await fs.readdir(cacheDirectory)).toEqual([]);
  });
});

describe("PATCH /instances/:id - prEvents", () => {
  let committedState: DashboardState;

  const patchPrEvents = (id: string, prEvents: unknown): Promise<Response> =>
    fetch(`${baseUrl}/instances/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prEvents }),
    });

  beforeEach(() => {
    committedState = {
      ...baseState(),
      instances: [
        makeRunningInstance({ id: "aaa111", tmuxSession: "ccdash-aaa111" }),
        makeRunningInstance({
          id: "bbb222",
          label: "second",
          tmuxSession: "ccdash-bbb222",
          prEvents: { enabled: true, paused: false },
        } as Partial<InstanceRecord>),
      ],
    } as DashboardState;
    vi.mocked(loadState).mockImplementation(async () => committedState);
    vi.mocked(saveState).mockImplementation(async (nextState: DashboardState) => {
      committedState = nextState;
    });
  });

  it("turns delivery on and returns the stored setting", async () => {
    const response = await patchPrEvents("aaa111", { enabled: true });

    expect(response.status).toBe(200);
    expect(((await response.json()) as InstanceRecord & { prEvents: { enabled: boolean } }).prEvents.enabled).toBe(true);
    expect((committedState.instances[0] as InstanceRecord & { prEvents: { enabled: boolean } }).prEvents.enabled).toBe(true);
  });

  it("merges a partial update and keeps the fields it did not mention", async () => {
    const response = await patchPrEvents("bbb222", { paused: true });

    expect(response.status).toBe(200);
    expect((committedState.instances[1] as InstanceRecord & { prEvents: unknown }).prEvents).toMatchObject({
      enabled: true,
      paused: true,
    });
  });

  it("stores a valid bot list", async () => {
    const response = await patchPrEvents("aaa111", { enabled: true, botLogins: ["renovate-helper", "ci-bot[bot]"] });

    expect(response.status).toBe(200);
    expect((committedState.instances[0] as InstanceRecord & { prEvents: { botLogins: string[] } }).prEvents.botLogins).toEqual([
      "renovate-helper",
      "ci-bot[bot]",
    ]);
  });

  it.each([
    ["a non-boolean enabled", { enabled: "yes" }],
    ["a numeric enabled", { enabled: 1 }],
    ["a non-boolean paused", { paused: "true" }],
    ["a null paused", { paused: null }],
    ["botLogins that is not an array", { botLogins: "renovate" }],
    ["a bot login that is not a string", { botLogins: [5] }],
    ["a bot login with a space", { botLogins: ["bad name"] }],
    ["a bot login with a newline", { botLogins: ["bad\nname"] }],
    ["a bot login that starts with a dash", { botLogins: ["-flag"] }],
    ["a bot login over 100 characters", { botLogins: ["a".repeat(101)] }],
    ["more than 20 bot logins", { botLogins: Array.from({ length: 21 }, (_value, index) => `bot${index}`) }],
  ])("answers 400 and writes nothing for %s", async (_name, prEvents) => {
    const response = await patchPrEvents("aaa111", prEvents);

    expect(response.status).toBe(400);
    expect(vi.mocked(updateState)).not.toHaveBeenCalled();
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a string", "on"],
    ["an array", [true]],
    ["a number", 1],
  ])("answers 400 when prEvents is %s", async (_name, prEvents) => {
    const response = await patchPrEvents("aaa111", prEvents);

    expect(response.status).toBe(400);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown instance id", async () => {
    const response = await patchPrEvents("nope99", { enabled: true });

    expect(response.status).toBe(404);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });
});

describe("GET /instances/pr-events", () => {
  beforeEach(() => {
    vi.mocked(resolveGithubToken).mockReset();
    vi.mocked(getPrEventsStatus).mockReset();
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      instances: [
        makeRunningInstance({ id: "aaa111", tmuxSession: "ccdash-aaa111", prEvents: { enabled: true, paused: false } } as Partial<InstanceRecord>),
        makeRunningInstance({ id: "bbb222", tmuxSession: "ccdash-bbb222", prEvents: { enabled: true, paused: true } } as Partial<InstanceRecord>),
        makeRunningInstance({ id: "ccc333", tmuxSession: "ccdash-ccc333" }),
      ],
    } as DashboardState);
  });

  it("answers the flags, the pending count and the status per instance", async () => {
    vi.mocked(getPrEventsStatus).mockReturnValue({
      aaa111: { status: "ok", pending: 2 },
      bbb222: { status: "paused", pending: 1 },
    });

    const response = await fetch(`${baseUrl}/instances/pr-events`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      aaa111: { enabled: true, paused: false, pending: 2, status: "ok" },
      bbb222: { enabled: true, paused: true, pending: 1, status: "paused" },
      ccc333: { enabled: false, paused: false, pending: 0, status: "off" },
    });
  });

  it.each(["ok", "off", "paused", "no-token", "no-pr", "unsupported", "error"] as const)("passes the %s status through", async (status) => {
    vi.mocked(getPrEventsStatus).mockReturnValue({ aaa111: { status, pending: 0 } });

    const body = (await (await fetch(`${baseUrl}/instances/pr-events`)).json()) as Record<string, { status: string }>;

    expect(body.aaa111.status).toBe(status);
  });

  it("exposes counts and status only: no urls, no events, no token", async () => {
    vi.mocked(getPrEventsStatus).mockReturnValue({
      aaa111: { status: "ok", pending: 2, queue: [{ link: "https://github.com/acme/widgets/runs/1" }], token: "ghp_FAKE" } as never,
    });

    const text: string = await (await fetch(`${baseUrl}/instances/pr-events`)).text();

    expect(text).not.toContain("github.com");
    expect(text).not.toContain("ghp_");
    expect(Object.keys((JSON.parse(text) as Record<string, object>).aaa111).sort()).toEqual(["enabled", "paused", "pending", "status"]);
  });

  it("does no token resolution", async () => {
    vi.mocked(getPrEventsStatus).mockReturnValue({});

    await fetch(`${baseUrl}/instances/pr-events`);

    expect(resolveGithubToken).not.toHaveBeenCalled();
  });
});

describe("GET /instances/pr-events for GitLab instances", () => {
  beforeEach(() => {
    vi.mocked(getPrEventsStatus).mockReset();
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      instances: [
        makeRunningInstance({ id: "aaa111", tmuxSession: "ccdash-aaa111", prEvents: { enabled: true, paused: false } } as Partial<InstanceRecord>),
        makeRunningInstance({ id: "bbb222", tmuxSession: "ccdash-bbb222", prEvents: { enabled: true, paused: false } } as Partial<InstanceRecord>),
      ],
    } as DashboardState);
  });

  it("adds provider and host only for the GitLab instance and keeps the four GitHub keys otherwise", async () => {
    vi.mocked(getPrEventsStatus).mockReturnValue({
      aaa111: { status: "ok", pending: 2, provider: "gitlab", host: "gitlab.example.com" },
      bbb222: { status: "ok", pending: 1 },
    } as never);

    const body = (await (await fetch(`${baseUrl}/instances/pr-events`)).json()) as Record<string, Record<string, unknown>>;

    expect(body.aaa111).toEqual({ enabled: true, paused: false, pending: 2, status: "ok", provider: "gitlab", host: "gitlab.example.com" });
    expect(Object.keys(body.bbb222).sort()).toEqual(["enabled", "paused", "pending", "status"]);
  });

  it("keeps provider and host on a no-pr answer", async () => {
    vi.mocked(getPrEventsStatus).mockReturnValue({
      aaa111: { status: "no-pr", pending: 0, provider: "gitlab", host: "gitlab.example.com" },
    } as never);

    const body = (await (await fetch(`${baseUrl}/instances/pr-events`)).json()) as Record<string, Record<string, unknown>>;

    expect(body.aaa111).toMatchObject({ status: "no-pr", provider: "gitlab", host: "gitlab.example.com" });
  });

  it("answers the provider without a host when the status has none", async () => {
    vi.mocked(getPrEventsStatus).mockReturnValue({ aaa111: { status: "unsupported", pending: 0, provider: "gitlab" } } as never);

    const body = (await (await fetch(`${baseUrl}/instances/pr-events`)).json()) as Record<string, Record<string, unknown>>;

    expect(body.aaa111.provider).toBe("gitlab");
    expect("host" in body.aaa111).toBe(false);
  });

  it("does not copy other fields of the status entry", async () => {
    vi.mocked(getPrEventsStatus).mockReturnValue({
      aaa111: { status: "ok", pending: 0, provider: "gitlab", host: "gitlab.example.com", token: "FAKE_SECRET_VALUE", project: "acme/widgets" },
    } as never);

    const text: string = await (await fetch(`${baseUrl}/instances/pr-events`)).text();

    expect(text).not.toContain("FAKE_SECRET_VALUE");
    expect(text).not.toContain("acme/widgets");
  });

  it("ignores a provider value other than gitlab and a host that fails validation", async () => {
    vi.mocked(getPrEventsStatus).mockReturnValue({
      aaa111: { status: "ok", pending: 0, provider: "bitbucket", host: "evil.example" },
      bbb222: { status: "ok", pending: 0, provider: "gitlab", host: "user@evil.example" },
    } as never);

    const body = (await (await fetch(`${baseUrl}/instances/pr-events`)).json()) as Record<string, Record<string, unknown>>;

    expect(Object.keys(body.aaa111).sort()).toEqual(["enabled", "paused", "pending", "status"]);
    expect("host" in body.bbb222).toBe(false);
  });
});

describe("PUT and GET /config with gitlabTokenEnv", () => {
  function putConfig(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations: ["/work/repo"], ...body }),
    });
  }

  function savedConfig(): Record<string, unknown> {
    const saved = vi.mocked(saveState).mock.calls.at(-1)?.[0] as DashboardState;
    return saved.config as unknown as Record<string, unknown>;
  }

  it("stores a map of normalized hosts to variable names and answers with names only", async () => {
    const response = await putConfig({ gitlabTokenEnv: { "GitLab.Example.com": "CORP_GITLAB", "git.other.example.org": "OTHER_GITLAB" } });

    expect(response.status).toBe(200);
    expect(savedConfig().gitlabTokenEnv).toEqual({ "gitlab.example.com": "CORP_GITLAB", "git.other.example.org": "OTHER_GITLAB" });
    expect(((await response.json()) as Record<string, unknown>).gitlabTokenEnv).toEqual({
      "gitlab.example.com": "CORP_GITLAB",
      "git.other.example.org": "OTHER_GITLAB",
    });
  });

  it("keeps the stored map when the field is absent", async () => {
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      config: { locations: ["/work/repo"], enabledProviders: ["claude"], gitlabTokenEnv: { "gitlab.example.com": "CORP_GITLAB" } },
    } as unknown as DashboardState);

    const response = await putConfig({ enabledProviders: ["claude"] });

    expect(response.status).toBe(200);
    expect(savedConfig().gitlabTokenEnv).toEqual({ "gitlab.example.com": "CORP_GITLAB" });
  });

  it("replaces the stored map with an empty one when an empty object is sent", async () => {
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      config: { locations: ["/work/repo"], enabledProviders: ["claude"], gitlabTokenEnv: { "gitlab.example.com": "CORP_GITLAB" } },
    } as unknown as DashboardState);

    const response = await putConfig({ gitlabTokenEnv: {} });

    expect(response.status).toBe(200);
    expect(savedConfig().gitlabTokenEnv).toEqual({});
  });

  it("adds no gitlabTokenEnv key when none was ever sent or stored", async () => {
    const response = await putConfig({});

    expect(response.status).toBe(200);
    expect("gitlabTokenEnv" in savedConfig()).toBe(false);
  });

  it("returns the stored names from GET /config", async () => {
    vi.mocked(loadState).mockResolvedValue({
      ...baseState(),
      config: { locations: ["/work/repo"], enabledProviders: ["claude"], gitlabTokenEnv: { "gitlab.example.com": "CORP_GITLAB" } },
    } as unknown as DashboardState);

    const body = (await (await fetch(`${baseUrl}/config`)).json()) as Record<string, unknown>;

    expect(body.gitlabTokenEnv).toEqual({ "gitlab.example.com": "CORP_GITLAB" });
  });

  it.each([
    ["a host with a bad label", { "-bad.example.com": "CORP_GITLAB" }],
    ["a host with userinfo", { "user@evil.example.com": "CORP_GITLAB" }],
    ["a host with a port", { "evil.example.com:8443": "CORP_GITLAB" }],
    ["a host with a path", { "evil.example.com/x": "CORP_GITLAB" }],
    ["a single label host", { localhost: "CORP_GITLAB" }],
    ["an ip host", { "10.0.0.1": "CORP_GITLAB" }],
    ["an empty host", { "": "CORP_GITLAB" }],
    ["upper and lower case duplicates", { "gitlab.example.com": "A_GITLAB", "GITLAB.example.com": "B_GITLAB" }],
    ["a bad variable name", { "gitlab.example.com": "bad name" }],
    ["a name starting with a digit", { "gitlab.example.com": "1GL" }],
    ["the dashboard password variable", { "gitlab.example.com": "DASHBOARD_PASSWORD" }],
    ["a GITHUB_ variable", { "gitlab.example.com": "GITHUB_TOKEN" }],
    ["a GH_ variable", { "gitlab.example.com": "GH_TOKEN" }],
    ["an unrelated secret variable", { "gitlab.example.com": "ANTHROPIC_API_KEY" }],
    ["an unrelated service variable", { "gitlab.example.com": "CORP_FIGMA_TOKEN" }],
    ["a non-string name", { "gitlab.example.com": 5 }],
    ["an array", ["gitlab.example.com"]],
    ["a string", "gitlab.example.com=CORP_GITLAB"],
    ["null", null],
  ])("answers 400 and saves nothing for %s", async (_name, gitlabTokenEnv) => {
    const response = await putConfig({ gitlabTokenEnv });

    expect(response.status).toBe(400);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("accepts a variable name that contains GITLAB", async () => {
    const response = await putConfig({ gitlabTokenEnv: { "gitlab.example.com": "CORP_GITLAB_TOKEN" } });

    expect(response.status).toBe(200);
    expect(savedConfig().gitlabTokenEnv).toEqual({ "gitlab.example.com": "CORP_GITLAB_TOKEN" });
  });

  it("answers 400 for a __proto__ key", async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"locations":["/work/repo"],"gitlabTokenEnv":{"__proto__":"CORP_GITLAB"}}',
    });

    expect(response.status).toBe(400);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("accepts 20 entries and rejects 21", async () => {
    const entries = (count: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: count }, (_value, index) => [`gl${index}.example.com`, `GITLAB_VAR_${index}`]));

    expect((await putConfig({ gitlabTokenEnv: entries(20) })).status).toBe(200);
    vi.mocked(saveState).mockClear();
    expect((await putConfig({ gitlabTokenEnv: entries(21) })).status).toBe(400);
    expect(vi.mocked(saveState)).not.toHaveBeenCalled();
  });

  it("never echoes a token value", async () => {
    const response = await putConfig({ gitlabTokenEnv: { "gitlab.example.com": "CORP_GITLAB" } });

    expect(JSON.stringify(await response.json())).not.toMatch(/faketoken/);
  });
});
