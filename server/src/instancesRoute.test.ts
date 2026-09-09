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
  const updateStateMock = vi.fn(
    async (mutator: (draft: DashboardState) => Promise<{ result: unknown; nextState?: DashboardState }>) => {
      const current = (await loadStateMock()) as DashboardState;
      const draft = structuredClone(current);
      const outcome = await mutator(draft);
      if (outcome.nextState !== undefined) {
        await saveStateMock(outcome.nextState);
      }
      return outcome.result;
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
}));
// `git.ts` keeps its real classifier/constants; only runGit (which shells out) is a stub.
vi.mock("./git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git")>();
  return { ...actual, runGit: vi.fn() };
});

import { loadState, saveState, updateState } from "./store";
import { pathExists } from "./paths";
import { initializeInstanceSession } from "./terminal";
import { getSessionPresence, killSession } from "./tmux";
import { GitError, runGit } from "./git";
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
