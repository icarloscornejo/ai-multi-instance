import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardState, InstanceRecord } from "./types";

// The route under test reaches for these; everything else it imports (providers, path helpers)
// is pure and used as-is.
vi.mock("./store", () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
}));
vi.mock("./paths", () => ({
  pathExists: vi.fn(),
}));
vi.mock("./terminal", () => ({
  initializeInstanceSession: vi.fn(),
}));
vi.mock("./tmux", () => ({
  exitCopyMode: vi.fn(),
  getPaneCurrentPath: vi.fn(),
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

import { loadState, saveState } from "./store";
import { pathExists } from "./paths";
import { initializeInstanceSession } from "./terminal";
import { GitError, runGit } from "./git";
import { apiRouter } from "./routes";

const runGitMock = vi.mocked(runGit);
const initMock = vi.mocked(initializeInstanceSession);

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
  vi.mocked(loadState).mockReset();
  vi.mocked(saveState).mockReset().mockResolvedValue(undefined);
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
