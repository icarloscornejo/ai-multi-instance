import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeFallback, claudeProjectDirName, displayModelName } from "./agentFallback";
import type { AgentFound } from "./paneAgent";

const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function assistantLine(sessionId: string, model: string, usage: Record<string, number>): string {
  return `${JSON.stringify({ type: "assistant", sessionId, message: { model, usage } })}\n`;
}

// A stand-in for the claude process: only its environment and cwd matter to the fallback, and
// both are read from the live process the same way they would be from the real one.
async function startFakeAgent(configDir: string, cwd: string): Promise<AgentFound> {
  // node, not sleep: ps will not show the environment of SIP-protected system binaries.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    stdio: "ignore",
  });
  children.push(child);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { kind: "agent", provider: "claude", paneJobPid: child.pid!, agentPid: child.pid!, startedAtMs: Date.now() - 5_000, resumeId: null };
}

async function setup(projectName: string) {
  // realpath: macOS reports /private/var for tmp dirs, and lsof prints the real path.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-mi-fallback-")));
  temporaryDirectories.push(root);
  const cwd = path.join(root, projectName);
  await fs.mkdir(cwd, { recursive: true });
  const configDir = path.join(root, "profile with space");
  const projectDir = path.join(configDir, "projects", claudeProjectDirName(cwd));
  await fs.mkdir(projectDir, { recursive: true });
  return { cwd, configDir, projectDir };
}

describe("claudeProjectDirName", () => {
  it("replaces every non-alphanumeric character, not only slashes and dots", () => {
    expect(claudeProjectDirName("/Users/x/Desktop/Work/AORUM Strategies")).toBe("-Users-x-Desktop-Work-AORUM-Strategies");
    expect(claudeProjectDirName("/a/my_repo.v2")).toBe("-a-my-repo-v2");
  });
});

describe("displayModelName", () => {
  it("renders transcript model ids the way the statusline names them", () => {
    expect(displayModelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(displayModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(displayModelName("some-other-model")).toBe("some-other-model");
  });
});

describe("claudeFallback", () => {
  it("reads model and context from the transcript of the session the agent is running", async () => {
    const { cwd, configDir, projectDir } = await setup("my_project");
    await fs.writeFile(
      path.join(projectDir, "session-new.jsonl"),
      assistantLine("session-new", "claude-opus-5-5", { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 })
    );
    const agent = await startFakeAgent(configDir, cwd);

    const result = await claudeFallback(agent, new Set());
    expect(result).toMatchObject({
      provider: "claude",
      sessionId: "session-new",
      cwd,
      configDir,
      model: "Opus 5.5",
      contextUsed: 1002,
    });
    expect(result?.contextSize).toBeUndefined();
  });

  it("ignores a subagent's turns when reading the session's model and context", async () => {
    const { cwd, configDir, projectDir } = await setup("sidechain");
    const subagentTurn = JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: { model: "claude-haiku-5-5", usage: { input_tokens: 3 } },
    });
    await fs.writeFile(
      path.join(projectDir, "session-x.jsonl"),
      assistantLine("session-x", "claude-opus-5-5", { input_tokens: 900 }) + `${subagentTurn}\n`
    );
    const result = await claudeFallback(await startFakeAgent(configDir, cwd), new Set());
    expect(result).toMatchObject({ model: "Opus 5.5", contextUsed: 900 });
  });

  it("skips a transcript another instance reports and one that predates the process", async () => {
    const { cwd, configDir, projectDir } = await setup("shared");
    const old = path.join(projectDir, "session-old.jsonl");
    await fs.writeFile(old, assistantLine("session-old", "m", { input_tokens: 1 }));
    await fs.utimes(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await fs.writeFile(path.join(projectDir, "session-theirs.jsonl"), assistantLine("session-theirs", "m", { input_tokens: 1 }));
    await fs.writeFile(path.join(projectDir, "session-mine.jsonl"), assistantLine("session-mine", "m", { input_tokens: 7 }));
    const agent = await startFakeAgent(configDir, cwd);

    const result = await claudeFallback(agent, new Set(["session-theirs"]));
    expect(result?.sessionId).toBe("session-mine");
  });

  it("follows a /clear: a newer transcript appearing switches the session", async () => {
    const { cwd, configDir, projectDir } = await setup("clear");
    await fs.writeFile(path.join(projectDir, "session-1.jsonl"), assistantLine("session-1", "m", { input_tokens: 1 }));
    const agent = await startFakeAgent(configDir, cwd);
    expect((await claudeFallback(agent, new Set()))?.sessionId).toBe("session-1");

    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.writeFile(path.join(projectDir, "session-2.jsonl"), assistantLine("session-2", "m", { input_tokens: 5 }));
    expect((await claudeFallback(agent, new Set()))?.sessionId).toBe("session-2");
  });

  it("returns null when the session has no transcript yet", async () => {
    const { cwd, configDir } = await setup("empty");
    expect(await claudeFallback(await startFakeAgent(configDir, cwd), new Set())).toBeNull();
  });
});
