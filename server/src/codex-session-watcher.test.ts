import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function runWatcher(
  script: string,
  env: NodeJS.ProcessEnv,
  instanceId: string,
  cwd: string,
  startedAt: number,
  extraArguments: string[] = []
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, instanceId, cwd, String(startedAt), ...extraArguments], { env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`watcher exited ${code}`))));
  });
}

describe("Codex session watcher", () => {
  it("assigns distinct sessions to simultaneous instances in one directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-mi-watcher-"));
    temporaryDirectories.push(home);
    const codexHome = path.join(home, "codex");
    const sessions = path.join(codexHome, "sessions", "2026", "07", "17");
    await fs.mkdir(sessions, { recursive: true });
    const cwd = "/tmp/shared-project";
    const startedAt = Date.now() - 100;
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    await Promise.all(
      ids.map((id, index) =>
        fs.writeFile(
          path.join(sessions, `rollout-${index}-${id}.jsonl`),
          `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`,
          "utf8"
        )
      )
    );

    const script = fileURLToPath(new URL("../scripts/codex-session-watcher.mjs", import.meta.url));
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
    await Promise.all([
      runWatcher(script, env, "instance-a", cwd, startedAt),
      runWatcher(script, env, "instance-b", cwd, startedAt),
    ]);

    const snapshots = await Promise.all(
      ["instance-a", "instance-b"].map(async (instanceId) =>
        JSON.parse(await fs.readFile(path.join(home, "Library", "Application Support", "ai-multi-instance", `${instanceId}.json`), "utf8"))
      )
    );
    expect(new Set(snapshots.map((snapshot) => snapshot.sessionId))).toEqual(new Set(ids));
  }, 10_000);

  async function setup() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-mi-watcher-"));
    temporaryDirectories.push(home);
    const codexHome = path.join(home, "codex");
    const sessions = path.join(codexHome, "sessions", "2026", "07", "17");
    await fs.mkdir(sessions, { recursive: true });
    const script = fileURLToPath(new URL("../scripts/codex-session-watcher.mjs", import.meta.url));
    const cacheRoot = path.join(home, "Library", "Application Support", "ai-multi-instance");
    return {
      home,
      sessions,
      script,
      cacheRoot,
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      async writeRollout(id: string, cwd: string, ageMs = 0) {
        const file = path.join(sessions, `rollout-${id}.jsonl`);
        await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`, "utf8");
        const when = new Date(Date.now() - ageMs);
        await fs.utimes(file, when, when);
        return file;
      },
      async snapshot(instanceId: string) {
        return JSON.parse(await fs.readFile(path.join(cacheRoot, `${instanceId}.json`), "utf8"));
      },
    };
  }

  it("records the pane job pid the shim passed in, even though the watcher itself runs orphaned", async () => {
    const t = await setup();
    await t.writeRollout("33333333-3333-4333-8333-333333333333", "/tmp/p");
    await runWatcher(t.script, t.env, "instance-a", "/tmp/p", Date.now() - 100, [String(process.pid)]);
    expect((await t.snapshot("instance-a")).paneJobPid).toBe(process.pid);
  }, 10_000);

  it("refuses a startedAt in the wrong unit instead of claiming an old rollout", async () => {
    const t = await setup();
    await t.writeRollout("44444444-4444-4444-8444-444444444444", "/tmp/p", 3 * 24 * 3600 * 1000);
    await expect(runWatcher(t.script, t.env, "instance-a", "/tmp/p", Math.floor(Date.now() / 1000))).rejects.toThrow();
  }, 10_000);

  it("claims a resumed session by id even when its rollout is old", async () => {
    const t = await setup();
    const resumed = "55555555-5555-4555-8555-555555555555";
    await t.writeRollout(resumed, "/tmp/p", 3 * 24 * 3600 * 1000);
    await t.writeRollout("66666666-6666-4666-8666-666666666666", "/tmp/p");
    await runWatcher(t.script, t.env, "instance-a", "/tmp/p", Date.now() - 100, [String(process.pid), resumed]);
    expect((await t.snapshot("instance-a")).sessionId).toBe(resumed);
  }, 10_000);

  it("does not steal a session claimed by a live job, but takes over one whose job died", async () => {
    const t = await setup();
    const sessionId = "77777777-7777-4777-8777-777777777777";
    await t.writeRollout(sessionId, "/tmp/p");
    const claims = path.join(t.cacheRoot, "codex-claims");
    await fs.mkdir(claims, { recursive: true });
    await fs.writeFile(path.join(claims, `${sessionId}.claim`), JSON.stringify({ instanceId: "other", paneJobPid: process.pid }));
    // The only candidate is claimed by a live job: the watcher must keep waiting, so give it a
    // short window and expect no snapshot.
    // A different job that is alive (the test runner's parent), so the watcher neither exits
    // for a dead job nor matches the claim's own pid.
    const child = spawn(process.execPath, [t.script, "instance-a", "/tmp/p", String(Date.now() - 100), String(process.ppid)], { env: t.env, stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(child.exitCode).toBeNull();
    child.kill();
    await exited;
    await expect(t.snapshot("instance-a")).rejects.toThrow();

    // Owner gone (pid that cannot exist) -> a new job may take it.
    await fs.writeFile(path.join(claims, `${sessionId}.claim`), JSON.stringify({ instanceId: "other", paneJobPid: 2147483000 }));
    await runWatcher(t.script, t.env, "instance-a", "/tmp/p", Date.now() - 100, [String(process.pid)]);
    expect((await t.snapshot("instance-a")).sessionId).toBe(sessionId);
  }, 15_000);

  it("re-claims its own legacy plain-text claim", async () => {
    const t = await setup();
    const sessionId = "88888888-8888-4888-8888-888888888888";
    await t.writeRollout(sessionId, "/tmp/p");
    const claims = path.join(t.cacheRoot, "codex-claims");
    await fs.mkdir(claims, { recursive: true });
    await fs.writeFile(path.join(claims, `${sessionId}.claim`), "instance-a");
    await runWatcher(t.script, t.env, "instance-a", "/tmp/p", Date.now() - 100, [String(process.pid)]);
    expect((await t.snapshot("instance-a")).sessionId).toBe(sessionId);
  }, 10_000);
});
