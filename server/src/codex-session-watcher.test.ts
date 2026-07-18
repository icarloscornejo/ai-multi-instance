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

function runWatcher(script: string, env: NodeJS.ProcessEnv, instanceId: string, cwd: string, startedAt: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, instanceId, cwd, String(startedAt)], { env, stdio: "ignore" });
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
        JSON.parse(await fs.readFile(path.join(home, ".cache", "ai-multi-instance", `${instanceId}.json`), "utf8"))
      )
    );
    expect(new Set(snapshots.map((snapshot) => snapshot.sessionId))).toEqual(new Set(ids));
  }, 10_000);
});
