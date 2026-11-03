// Branch and worktree cleanup against REAL git, in throwaway repos only (never a real repo of
// the user). The router runs for real; only the modules that talk to tmux, the tunnel, the
// updater and the state file are replaced. See .doer MI-7 for the cases.
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardState, InstanceRecord } from "./types";

const holder = vi.hoisted(() => ({ state: null as unknown }));

vi.mock("./store", () => ({
  loadState: vi.fn(async () => structuredClone(holder.state)),
  saveState: vi.fn(async (next: unknown) => {
    holder.state = structuredClone(next);
  }),
  updateState: vi.fn(
    async (mutator: (draft: unknown) => Promise<{ result: unknown; nextState?: unknown }>) => {
      const draft = structuredClone(holder.state);
      const outcome = await mutator(draft);
      if (outcome.nextState !== undefined) holder.state = structuredClone(outcome.nextState);
      return outcome.result;
    }
  ),
}));
vi.mock("./terminal", () => ({ initializeInstanceSession: vi.fn() }));
vi.mock("./tmux", () => ({
  getOriginalPanePid: vi.fn(async () => null),
  getPaneCurrentPath: vi.fn(async () => null),
  getSessionPresence: vi.fn(async () => "absent"),
  killSession: vi.fn(async () => undefined),
  signalChannel: vi.fn(async () => undefined),
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
vi.mock("./reviewRequests", () => ({ reviewRequestFor: vi.fn() }));
vi.mock("./prEventsPoller", () => ({ getPrEventsStatus: vi.fn(() => ({})) }));
vi.mock("./githubToken", () => ({ resolveGithubToken: vi.fn(), invalidateToken: vi.fn() }));

import { initializeInstanceSession } from "./terminal";
import { getSessionPresence } from "./tmux";
import { apiRouter } from "./routes";

const initMock = vi.mocked(initializeInstanceSession);
const presenceMock = vi.mocked(getSessionPresence);

let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;
let rootDirectory: string;
let emptyGlobalConfig: string;
const savedEnvironment: Record<string, string | undefined> = {};
const ENVIRONMENT_OVERRIDES: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: process.env }).trim();
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

// Repo with two tracked files, an ignored .env pattern, on branch main.
async function makeRepo(name: string): Promise<string> {
  const repo: string = path.join(testDirectory, name);
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  git(testDirectory, "init", "-q", "-b", "main", repo);
  await fs.writeFile(path.join(repo, ".gitignore"), ".env\nnode_modules/\n");
  await fs.writeFile(path.join(repo, "a.txt"), "a\n");
  await fs.writeFile(path.join(repo, "src", "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

// Sibling worktree on a new branch, named like the dashboard names them.
function addWorktree(repo: string, branch: string): string {
  const directory: string = path.join(path.dirname(repo), `${path.basename(repo)}-${branch.replace(/[^A-Za-z0-9.-]+/g, "-")}`);
  git(repo, "worktree", "add", "-q", "-b", branch, "--", directory);
  return directory;
}

function instance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: "inst0001",
    label: "agent",
    locationPath: "/unset",
    tmuxSession: "ccdash-inst0001",
    provider: "claude",
    command: "claude",
    model: null,
    effort: null,
    fontSize: 13,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as InstanceRecord;
}

function setState(locations: string[], instances: InstanceRecord[] = []): void {
  holder.state = {
    schemaVersion: 2,
    config: { locations, enabledProviders: ["claude", "codex"] },
    instances,
    sessionsByKey: {},
  } as unknown as DashboardState;
}

function stateInstances(): InstanceRecord[] {
  return (holder.state as DashboardState).instances;
}

function staleDelete(locationPath: string, branches: string[]): Promise<Response> {
  return fetch(`${baseUrl}/locations/stale-branches/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: locationPath, branches }),
  });
}

async function listCandidates(locationPath: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/locations/stale-branches?path=${encodeURIComponent(locationPath)}`);
  return ((await response.json()).candidates as { branch: string }[]).map((candidate) => candidate.branch);
}

function createInstance(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shellOnly: true, ...body }),
  });
}

function closeInstance(id: string): Promise<Response> {
  return fetch(`${baseUrl}/instances/${id}`, { method: "DELETE" });
}

type FailedEntry = { branch: string; error: string };

beforeAll(async () => {
  rootDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccdash-cleanup-")));
  emptyGlobalConfig = path.join(rootDirectory, "empty-gitconfig");
  await fs.writeFile(emptyGlobalConfig, "");
  for (const [key, value] of Object.entries({ ...ENVIRONMENT_OVERRIDES, GIT_CONFIG_GLOBAL: emptyGlobalConfig })) {
    savedEnvironment[key] = process.env[key];
    process.env[key] = value;
  }
  const app = express();
  app.use(express.json());
  app.use("/", apiRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(rootDirectory, { recursive: true, force: true });
});

let testDirectory: string;
let releaseHeld: (() => void)[] = [];

beforeEach(async () => {
  // Each test builds its repos under its own folder so worktree siblings never collide.
  testDirectory = await fs.mkdtemp(path.join(rootDirectory, "case-"));
  initMock.mockReset();
  presenceMock.mockReset().mockResolvedValue("absent");
});

afterEach(async () => {
  for (const release of releaseHeld) release();
  releaseHeld = [];
  vi.restoreAllMocks();
});

const repoIn = makeRepo;

describe("stale branch delete never moves a live instance", () => {
  it("1. refuses with 409 and runs no checkout when an instance works in a subfolder of the location", async () => {
    const repo = await repoIn("repo");
    git(repo, "checkout", "-q", "-b", "feature/a");
    setState([repo], [instance({ locationPath: path.join(repo, "src") })]);

    const response = await staleDelete(repo, ["feature/a"]);

    expect(response.status).toBe(409);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/a");
    expect(git(repo, "branch", "--list", "feature/a")).toContain("feature/a");
  });

  it("7. the same through a location configured as a symlink", async () => {
    const repo = await repoIn("repo");
    git(repo, "checkout", "-q", "-b", "feature/a");
    const link: string = path.join(testDirectory, "repo-link");
    await fs.symlink(repo, link);
    setState([link], [instance({ locationPath: path.join(repo, "src") })]);

    const response = await staleDelete(link, ["feature/a"]);

    expect(response.status).toBe(409);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/a");
  });

  it("regression: with no instance it still switches to main and deletes the branch", async () => {
    const repo = await repoIn("repo");
    git(repo, "checkout", "-q", "-b", "feature/c");
    setState([repo]);

    const response = await staleDelete(repo, ["feature/c"]);

    expect(response.status).toBe(200);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo, "branch", "--list", "feature/c")).toBe("");
  });

  it("regression: an unknown branch is still a 400", async () => {
    const repo = await repoIn("repo");
    setState([repo]);
    expect((await staleDelete(repo, ["nope"])).status).toBe(400);
  });
});

describe("stale branch delete never discards work in a worktree", () => {
  it("2. keeps a worktree with uncommitted and untracked changes, and its branch", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    await fs.writeFile(path.join(worktree, "a.txt"), "edited\n");
    await fs.writeFile(path.join(worktree, "untracked.txt"), "keep me\n");
    setState([repo]);

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual([]);
    expect((body.failed as FailedEntry[])[0].error).toMatch(/uncommitted/i);
    expect(await fs.readFile(path.join(worktree, "a.txt"), "utf8")).toBe("edited\n");
    expect(await fs.readFile(path.join(worktree, "untracked.txt"), "utf8")).toBe("keep me\n");
    expect(git(repo, "branch", "--list", "feature/b")).toContain("feature/b");
  });

  it("3. keeps a worktree that holds an ignored .env and names the file", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    await fs.writeFile(path.join(worktree, ".env"), "SECRET=1\n");
    setState([repo]);

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual([]);
    expect((body.failed as FailedEntry[])[0].error).toContain(".env");
    expect(await fs.readFile(path.join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(git(repo, "branch", "--list", "feature/b")).toContain("feature/b");
  });

  it("9. keeps a worktree whose edit is hidden by skip-worktree or assume-unchanged", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    await fs.writeFile(path.join(worktree, "a.txt"), "hidden edit\n");
    git(worktree, "update-index", "--skip-worktree", "a.txt");
    await fs.writeFile(path.join(worktree, "src", "b.txt"), "other hidden edit\n");
    git(worktree, "update-index", "--assume-unchanged", "src/b.txt");
    setState([repo]);

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual([]);
    expect(await fs.readFile(path.join(worktree, "a.txt"), "utf8")).toBe("hidden edit\n");
    expect(await fs.readFile(path.join(worktree, "src", "b.txt"), "utf8")).toBe("other hidden edit\n");
  });

  it("10. keeps a clean worktree that has an empty untracked folder, deleting nothing", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    await fs.mkdir(path.join(worktree, "emptydir"));
    setState([repo]);

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual([]);
    expect((body.failed as FailedEntry[])[0].error).toContain("emptydir");
    expect(await exists(path.join(worktree, "a.txt"))).toBe(true);
    expect(await exists(path.join(worktree, "src", "b.txt"))).toBe(true);
  });

  it("8. an ignored file that appears while tracked files are being removed survives and the worktree stays registered", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    setState([repo]);
    const realUnlink = fs.unlink.bind(fs);
    let injected = false;
    vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (!injected) {
        injected = true;
        await fs.writeFile(path.join(worktree, ".env"), "SECRET=late\n");
      }
      return realUnlink(target);
    });

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(await fs.readFile(path.join(worktree, ".env"), "utf8")).toBe("SECRET=late\n");
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(worktree);
    expect((body.failed as FailedEntry[])[0].error).toContain(".env");
  });

  it("15. a failing unlink in the middle reports a partial removal and leaves a valid worktree", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    setState([repo]);
    const realUnlink = fs.unlink.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      return realUnlink(target);
    });

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual([]);
    expect((body.failed as FailedEntry[])[0].error).toMatch(/partially removed/i);
    expect(await exists(path.join(worktree, ".git"))).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(worktree);
    vi.restoreAllMocks();
    git(worktree, "restore", ".");
    expect(await exists(path.join(worktree, "a.txt"))).toBe(true);
  });

  it("17. a tracked folder replaced by a symlink is kept and nothing outside the worktree is touched", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    const outside: string = path.join(testDirectory, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "b.txt"), "outside\n");
    await fs.rm(path.join(worktree, "src"), { recursive: true });
    await fs.symlink(outside, path.join(worktree, "src"));
    setState([repo]);

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual([]);
    expect(await fs.readFile(path.join(outside, "b.txt"), "utf8")).toBe("outside\n");
  });

  it("11. a locked worktree is kept intact with a locked reason", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    git(repo, "worktree", "lock", worktree);
    setState([repo]);

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual([]);
    expect(await exists(path.join(worktree, "a.txt"))).toBe(true);
    expect(git(repo, "branch", "--list", "feature/b")).toContain("feature/b");
  });

  it("11b. when the location is a linked worktree, the main checkout's branch is not deleted and its files stay", async () => {
    const repo = await repoIn("repo");
    git(repo, "checkout", "-q", "-b", "feature/m");
    const linked = path.join(testDirectory, "repo-linked");
    git(repo, "worktree", "add", "-q", "-b", "feature/loc", "--", linked);
    git(repo, "worktree", "list");
    setState([linked]);

    await staleDelete(linked, ["feature/m"]);

    expect(await exists(path.join(repo, "a.txt"))).toBe(true);
    expect(await exists(path.join(repo, "src", "b.txt"))).toBe(true);
    expect(git(repo, "branch", "--list", "feature/m")).toContain("feature/m");
  });

  it("12. a worktree folder deleted by hand is dropped from the list and its branch is deleted", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    await fs.rm(worktree, { recursive: true });
    setState([repo]);

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual(["feature/b"]);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("feature/b");
    expect(git(repo, "branch", "--list", "feature/b")).toBe("");
  });

  it("12b. a worktree with a submodule is kept untouched", async () => {
    const repo = await repoIn("repo");
    const submoduleSource = await repoIn("sub-source");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSource, "vendor");
    git(repo, "commit", "-q", "-m", "add submodule");
    const worktree = addWorktree(repo, "feature/b");
    setState([repo]);

    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual([]);
    expect(await exists(path.join(worktree, "a.txt"))).toBe(true);
  });

  it("regression: a clean worktree is offered, removed and unregistered, and its branch deleted", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    setState([repo]);

    expect(await listCandidates(repo)).toContain("feature/b");
    const body = await (await staleDelete(repo, ["feature/b"])).json();

    expect(body.deleted).toEqual(["feature/b"]);
    expect(await exists(worktree)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(worktree);
    expect(git(repo, "branch", "--list", "feature/b")).toBe("");
  });
});

describe("listing never offers a worktree a live instance works in", () => {
  it("6. an instance in a subfolder of a worktree protects that worktree's branch", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/c");
    await fs.mkdir(path.join(worktree, "packages", "app"), { recursive: true });
    setState([repo], [instance({ locationPath: path.join(worktree, "packages", "app") })]);

    expect(await listCandidates(repo)).not.toContain("feature/c");
  });
});

describe("closing an instance never discards a worktree's files", () => {
  function worktreeInstance(repo: string, worktree: string, branch: string): InstanceRecord {
    return instance({ locationPath: worktree, worktree: { sourcePath: repo, branch, created: true } });
  }

  it("4. keeps a worktree that holds an ignored .env and warns with the file name", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    await fs.writeFile(path.join(worktree, ".env"), "SECRET=1\n");
    setState([repo], [worktreeInstance(repo, worktree, "feature/b")]);

    const response = await closeInstance("inst0001");

    expect(response.status).toBe(200);
    expect((await response.json()).warning).toContain(".env");
    expect(await fs.readFile(path.join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(stateInstances()).toHaveLength(0);
  });

  it("16. keeps a worktree on a detached HEAD, where commits would be lost", async () => {
    const repo = await repoIn("repo");
    const worktree = path.join(testDirectory, "repo-detached");
    git(repo, "worktree", "add", "-q", "--detach", "--", worktree);
    await fs.writeFile(path.join(worktree, "c.txt"), "c\n");
    git(worktree, "add", "c.txt");
    git(worktree, "commit", "-q", "-m", "work on detached head");
    const commit: string = git(worktree, "rev-parse", "HEAD");
    setState([repo], [worktreeInstance(repo, worktree, "detached")]);

    const response = await closeInstance("inst0001");

    expect((await response.json()).warning).toMatch(/detached/i);
    expect(await exists(worktree)).toBe(true);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(commit);
  });

  it("a failing unlink on close answers 200 with a warning, never a 500", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    setState([repo], [worktreeInstance(repo, worktree, "feature/b")]);
    vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));

    const response = await closeInstance("inst0001");

    expect(response.status).toBe(200);
    expect((await response.json()).warning).toBeTruthy();
  });

  it("keeps the worktree when a second instance reaches it through a symlink", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    const link: string = path.join(testDirectory, "link-to-worktree-src");
    await fs.symlink(path.join(worktree, "src"), link);
    setState(
      [repo],
      [
        worktreeInstance(repo, worktree, "feature/b"),
        instance({ id: "inst0002", label: "other", tmuxSession: "ccdash-inst0002", locationPath: link }),
      ]
    );

    await closeInstance("inst0001");

    expect(await exists(path.join(worktree, "a.txt"))).toBe(true);
  });

  it("regression: a clean worktree is removed and unregistered on close", async () => {
    const repo = await repoIn("repo");
    const worktree = addWorktree(repo, "feature/b");
    setState([repo], [worktreeInstance(repo, worktree, "feature/b")]);

    const response = await closeInstance("inst0001");

    expect(response.status).toBe(204);
    expect(await exists(worktree)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(worktree);
  });
});

describe("a failed launch rolls its new worktree back without discarding files", () => {
  async function runRollback(repo: string, writeFiles: boolean): Promise<{ text: string; worktree: string }> {
    git(repo, "branch", "feature/r");
    const worktree: string = path.join(testDirectory, "repo-feature-r");
    setState([repo], [instance({ locationPath: repo })]);
    presenceMock.mockResolvedValue("present");
    initMock.mockImplementation(async (record) => {
      if (writeFiles) await fs.writeFile(path.join(record.locationPath, ".env"), "SECRET=1\n");
      throw new Error("boom");
    });
    const response = await createInstance({
      locationPath: repo,
      label: "second",
      branchAction: { type: "checkout", branch: "feature/r" },
    });
    return { text: await response.text(), worktree };
  }

  it("5. keeps the worktree and its ignored .env, and names the file in the error", async () => {
    const repo = await repoIn("repo");
    const { text, worktree } = await runRollback(repo, true);

    expect(text).toContain(".env");
    expect(await fs.readFile(path.join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("regression: a clean rollback removes and unregisters the worktree and keeps the branch", async () => {
    const repo = await repoIn("repo");
    const { worktree } = await runRollback(repo, false);

    expect(await exists(worktree)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(worktree);
    expect(git(repo, "branch", "--list", "feature/r")).toContain("feature/r");
  });
});

describe("worktree operations are serialized with instance creation", () => {
  it("13. a stale delete waits behind a create that has not persisted yet, then refuses (409) and moves nothing", async () => {
    const repo = await repoIn("repo");
    git(repo, "checkout", "-q", "-b", "feature/a");
    setState([repo]);
    let persist: (() => Promise<void>) | undefined;
    let letCreateFinish: () => void = () => undefined;
    const createMayFinish = new Promise<void>((resolve) => {
      letCreateFinish = resolve;
    });
    releaseHeld.push(letCreateFinish);
    initMock.mockImplementation(async (_record, onSessionCreated) => {
      persist = onSessionCreated as () => Promise<void>;
      await createMayFinish;
      await persist?.();
    });

    const creating = createInstance({ locationPath: repo, label: "held" });
    await vi.waitFor(() => expect(persist).toBeDefined());
    const deleting = staleDelete(repo, ["feature/a"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/a");

    letCreateFinish();
    await (await creating).text();
    const response = await deleting;

    expect(response.status).toBe(409);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/a");
  });

  it("14. a create rejected in validation does not hold anything up", async () => {
    const repo = await repoIn("repo");
    git(repo, "checkout", "-q", "-b", "feature/c");
    setState([repo]);

    const rejected = await createInstance({ locationPath: repo, branchAction: { type: "checkout", branch: "-x" } });
    expect(rejected.status).toBe(400);
    const response = await staleDelete(repo, ["feature/c"]);

    expect(response.status).toBe(200);
  });
});
