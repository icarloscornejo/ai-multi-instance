import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hookScript = fileURLToPath(new URL("../scripts/dashboard-agent-state.sh", import.meta.url));
const INSTANCE_ID = "deadbeef";

// The home lives one level inside the root so a path-traversal write ("../x") would land
// inside the root and be seen by the checks below.
let rootDirectory: string;
let homeDirectory: string;

beforeEach(async () => {
  rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-mi-hook-"));
  homeDirectory = path.join(rootDirectory, "home");
  await fs.mkdir(homeDirectory);
});

afterEach(async () => {
  await fs.chmod(path.join(homeDirectory, "Library", "Application Support", "ai-multi-instance"), 0o700).catch(() => undefined);
  await fs.rm(rootDirectory, { recursive: true, force: true });
});

function cacheDirectory(): string {
  return path.join(homeDirectory, "Library", "Application Support", "ai-multi-instance");
}

function stateFile(instanceId: string = INSTANCE_ID): string {
  return path.join(cacheDirectory(), `${instanceId}.state.json`);
}

// Explicit full env on purpose: no TMUX_PANE, so the instance id comes from the launch variable.
function runHook(stdin: string, env: Record<string, string> = {}) {
  const result = spawnSync("bash", [hookScript], {
    input: stdin,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: homeDirectory,
      AI_MULTI_INSTANCE_ID: INSTANCE_ID,
      ...env,
    },
  });
  return { stdout: result.stdout, status: result.status };
}

async function readState(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(stateFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? listFilesRecursively(full) : [full];
    })
  );
  return nested.flat();
}

const mappedEvents: [string, Record<string, unknown>, string][] = [
  ["PermissionRequest", { hook_event_name: "PermissionRequest", tool_name: "Bash" }, "waiting"],
  ["Notification permission_prompt", { hook_event_name: "Notification", notification_type: "permission_prompt" }, "waiting"],
  ["Notification elicitation_dialog", { hook_event_name: "Notification", notification_type: "elicitation_dialog" }, "waiting"],
  ["Notification agent_needs_input", { hook_event_name: "Notification", notification_type: "agent_needs_input" }, "waiting"],
  ["PreToolUse AskUserQuestion", { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }, "waiting"],
  ["Notification idle_prompt", { hook_event_name: "Notification", notification_type: "idle_prompt" }, "idle"],
  ["UserPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt: "hello" }, "working"],
  ["PostToolUse", { hook_event_name: "PostToolUse", tool_name: "Bash" }, "working"],
  ["PostToolUseFailure", { hook_event_name: "PostToolUseFailure", tool_name: "Bash" }, "working"],
  ["Stop", { hook_event_name: "Stop" }, "idle"],
  ["StopFailure", { hook_event_name: "StopFailure" }, "idle"],
  ["SessionStart startup", { hook_event_name: "SessionStart", source: "startup" }, "idle"],
  ["SessionStart resume", { hook_event_name: "SessionStart", source: "resume" }, "idle"],
  ["SessionStart clear", { hook_event_name: "SessionStart", source: "clear" }, "idle"],
];

describe("agent state hook script: event mapping", () => {
  it.each(mappedEvents)("%s writes the state file and prints nothing", async (_name, payload, expectedState) => {
    const { stdout, status } = runHook(JSON.stringify({ session_id: "sess-1", ...payload }));

    expect(status).toBe(0);
    expect(stdout).toBe("");
    const written = await readState();
    expect(written).not.toBeNull();
    expect(written).toMatchObject({ state: expectedState, sessionId: "sess-1", event: payload.hook_event_name });
    expect(written).toHaveProperty("paneJobPid");
    expect(Number.isNaN(Date.parse(String(written?.updatedAt)))).toBe(false);
  });

  it.each([
    ["an unknown notification type", { hook_event_name: "Notification", notification_type: "auth_success" }],
    ["a compact session start", { hook_event_name: "SessionStart", source: "compact" }],
    ["an unrelated event", { hook_event_name: "SubagentStop" }],
    ["a PreToolUse for another tool", { hook_event_name: "PreToolUse", tool_name: "Bash" }],
  ])("%s writes nothing", async (_name, payload) => {
    const { stdout, status } = runHook(JSON.stringify({ session_id: "sess-1", ...payload }));

    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(await readState()).toBeNull();
  });

  it("keeps the previous state when an ignored event arrives", async () => {
    runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s" }));
    runHook(JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "s" }));

    expect(await readState()).toMatchObject({ state: "working" });
  });

  it("overwrites the previous state with the latest event", async () => {
    runHook(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s" }));
    runHook(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s" }));

    expect(await readState()).toMatchObject({ state: "working", event: "PostToolUse" });
  });

  it("removes the state file on session end and prints nothing", async () => {
    runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    expect(await readState()).not.toBeNull();

    const { stdout, status } = runHook(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s" }));

    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(await readState()).toBeNull();
  });

  it("session end with no file to remove still exits 0 and prints nothing", () => {
    const { stdout, status } = runHook(JSON.stringify({ hook_event_name: "SessionEnd" }));

    expect(status).toBe(0);
    expect(stdout).toBe("");
  });
});

describe("agent state hook script: never blocks or breaks the agent", () => {
  it.each([
    ["empty stdin", ""],
    ["invalid JSON", "{not json"],
    ["JSON that is not an object", "42"],
  ])("exits 0 with empty stdout on %s and writes nothing", async (_name, input) => {
    const { stdout, status } = runHook(input);

    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(await readState()).toBeNull();
  });

  it("exits 0 with empty stdout and writes nothing when there is no instance id", async () => {
    const { stdout, status } = runHook(JSON.stringify({ hook_event_name: "Stop" }), { AI_MULTI_INSTANCE_ID: "" });

    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(await readState()).toBeNull();
  });

  it("exits 0 with empty stdout when the cache directory cannot be created", async () => {
    // A plain file where the Library folder should be makes mkdir -p fail.
    await fs.writeFile(path.join(homeDirectory, "Library"), "not a directory");

    const { stdout, status } = runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));

    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with empty stdout when the cache directory is read-only", async () => {
    await fs.mkdir(cacheDirectory(), { recursive: true });
    await fs.chmod(cacheDirectory(), 0o500);

    const { stdout, status } = runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));

    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it.each(["../x", "../../escape", "a/b", "DEADBEEF", "deadbee", "deadbeef0", "dead beef"])(
    "refuses the instance id %j and writes no state file anywhere",
    async (hostileId) => {
      const { stdout, status } = runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }), {
        AI_MULTI_INSTANCE_ID: hostileId,
      });

      expect(status).toBe(0);
      expect(stdout).toBe("");
      const stateFiles = (await listFilesRecursively(rootDirectory)).filter((file) => file.endsWith(".state.json"));
      expect(stateFiles).toEqual([]);
    }
  );

  it("keeps the state file valid JSON when the payload carries hostile quotes and newlines", async () => {
    const hostile = 'say "hi"\n\\"; echo pwned #\n\t$(touch /tmp/pwned) `x`';
    const { stdout, status } = runHook(
      JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt", session_id: hostile, message: hostile })
    );

    expect(status).toBe(0);
    expect(stdout).toBe("");
    const written = await readState();
    expect(written).toMatchObject({ state: "waiting" });
    expect(Object.keys(written ?? {}).sort()).toEqual(["event", "paneJobPid", "sessionId", "state", "updatedAt"]);
  });

  it("never stores prompt text in any file of the cache directory, log included", async () => {
    const secretPrompt = "UNIQUE-PRIVATE-PROMPT-7f3a9c";
    runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: secretPrompt }));
    // paths that fail and may log: broken JSON containing the text, and a refused id
    runHook(`{"prompt":"${secretPrompt}`);
    runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: secretPrompt }), { AI_MULTI_INSTANCE_ID: "../x" });

    const files = await listFilesRecursively(cacheDirectory());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(await fs.readFile(file, "utf8")).not.toContain(secretPrompt);
    }
  });

  it("leaves no temporary files behind after a write", async () => {
    runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));

    const leftovers = (await fs.readdir(cacheDirectory())).filter((name) => name.startsWith("."));
    expect(leftovers).toEqual([]);
  });

  it("keeps the state directory private to the user, even when it already existed with wider permissions", async () => {
    await fs.mkdir(cacheDirectory(), { recursive: true });
    await fs.chmod(cacheDirectory(), 0o755);

    runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));

    const directoryMode: number = (await fs.stat(cacheDirectory())).mode & 0o777;
    const fileMode: number = (await fs.stat(stateFile())).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode & 0o077).toBe(0);
  });
});
