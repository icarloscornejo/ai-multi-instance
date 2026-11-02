import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildProviderLaunchCommand } from "./providers";
import type { InstanceRecord } from "./types";

const scriptsDirectory = fileURLToPath(new URL("../scripts", import.meta.url));
const shimsDirectory = path.join(scriptsDirectory, "shims");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

// A directory with stand-ins for the real binaries: they just report how they were invoked.
async function makeFakeBinaries(names: string[]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-mi-shims-"));
  temporaryDirectories.push(directory);
  for (const name of names) {
    const file = path.join(directory, name);
    await fs.writeFile(file, `#!/bin/bash\necho "FAKE-${name} active=$AI_MULTI_SHIM_ACTIVE real=$AI_MULTI_REAL_CODEX args:$*"\n`);
    await fs.chmod(file, 0o755);
  }
  return directory;
}

function runShim(shim: "claude" | "codex", args: string[], fakeDirectory: string, env: Record<string, string> = {}) {
  const result = spawnSync(path.join(shimsDirectory, shim), args, {
    encoding: "utf8",
    env: {
      PATH: `${shimsDirectory}:${fakeDirectory}:/usr/bin:/bin`,
      HOME: fakeDirectory,
      ...env,
    },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// A fake claude that prints each argument on its own line, so a JSON argument survives intact.
async function makeArgumentPerLineClaude(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-mi-shims-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "claude");
  await fs.writeFile(file, `#!/bin/bash\nfor argument in "$@"; do printf '%s\\n' "$argument"; done\n`);
  await fs.chmod(file, 0o755);
  return directory;
}

function injectedSettings(stdout: string): { hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> } & Record<string, unknown> {
  const lines: string[] = stdout.split("\n");
  const settingsFlagIndex: number = lines.indexOf("--settings");
  expect(settingsFlagIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(lines[settingsFlagIndex + 1]);
}

describe("claude shim hooks", () => {
  const eventNames = [
    "PermissionRequest", "Notification", "PreToolUse", "UserPromptSubmit", "PostToolUse",
    "PostToolUseFailure", "Stop", "StopFailure", "SessionStart", "SessionEnd",
  ];

  it("injects the agent state hooks in the --settings JSON argument", async () => {
    const fake = await makeArgumentPerLineClaude();
    const { stdout, status } = runShim("claude", ["--model", "x"], fake);

    expect(status).toBe(0);
    const settings = injectedSettings(stdout);
    expect(Object.keys(settings.hooks).sort()).toEqual([...eventNames].sort());
    const scriptPath: string = path.join(scriptsDirectory, "dashboard-agent-state.sh");
    for (const eventName of eventNames) {
      expect(settings.hooks[eventName]).toHaveLength(1);
      expect(settings.hooks[eventName][0].hooks).toEqual([{ type: "command", command: scriptPath, timeout: 5 }]);
    }
    expect(settings.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
    expect(settings.statusLine).toBeDefined();
    expect(stdout.split("\n")).toContain("--model");
  });

  it("injects exactly the same hooks as the dashboard launch command", async () => {
    const fake = await makeArgumentPerLineClaude();
    const shimHooks = injectedSettings(runShim("claude", [], fake).stdout).hooks;
    const command: string = buildProviderLaunchCommand({
      id: "instance-1", label: "x", locationPath: "/tmp", tmuxSession: "ccdash-instance-1", provider: "claude",
      command: "claude", model: null, effort: null, fontSize: 13, createdAt: "2026-07-17T00:00:00.000Z",
    } as InstanceRecord);
    const quoted: string = /--settings ('(?:[^']|'\\'')*')/.exec(command)?.[1] ?? "";
    const launchHooks = JSON.parse(spawnSync("bash", ["-c", `printf %s ${quoted}`], { encoding: "utf8" }).stdout).hooks;

    expect(shimHooks).toBeDefined();
    expect(shimHooks).toEqual(launchHooks);
  });

  it.each([
    [["-p", "hi"]],
    [["--print", "hi"]],
    [["mcp", "list"]],
    [["--settings", "{}", "--model", "x"]],
    [["--settings={}"]],
  ])("adds no hooks to %j", async (args) => {
    const fake = await makeArgumentPerLineClaude();
    const { stdout } = runShim("claude", args, fake);

    expect(stdout).not.toContain("dashboard-agent-state.sh");
    expect(stdout.split("\n").filter((line) => line !== "")).toEqual(args);
  });
});

describe("claude shim", () => {
  it("injects the dashboard statusline wrapper and runs the real binary exactly once", async () => {
    const fake = await makeFakeBinaries(["claude"]);
    const { stdout, status } = runShim("claude", ["--model", "x"], fake);
    expect(status).toBe(0);
    expect(stdout.match(/FAKE-claude/g)).toHaveLength(1);
    expect(stdout).toContain(`"command":"${path.join(scriptsDirectory, "dashboard-statusline.sh")}"`);
    expect(stdout).toContain("--model x");
    expect(stdout).toContain("active=1");
  });

  it.each([
    [["-p", "hi"]],
    [["--print", "hi"]],
    [["mcp", "list"]],
    [["update"]],
    [["--settings", "{}", "--model", "x"]],
    [["--settings={}"]],
  ])("leaves %j untouched", async (args) => {
    const fake = await makeFakeBinaries(["claude"]);
    const { stdout } = runShim("claude", args, fake);
    expect(stdout.match(/--settings/g) ?? []).toHaveLength(args.some((argument) => argument.startsWith("--settings")) ? 1 : 0);
  });

  it("passes straight through when it already ran (a wrapper calling claude again)", async () => {
    const fake = await makeFakeBinaries(["claude"]);
    const { stdout } = runShim("claude", ["--model", "x"], fake, { AI_MULTI_SHIM_ACTIVE: "1" });
    expect(stdout).not.toContain("--settings");
    expect(stdout).toContain("--model x");
  });

  it("fails clearly when there is no real claude to run", async () => {
    const fake = await makeFakeBinaries([]);
    const { stderr, status } = runShim("claude", [], fake);
    expect(status).toBe(127);
    expect(stderr).toContain("could not find the real binary");
  });
});

describe("codex shim", () => {
  it("does not call itself when the real codex is just the bare name `codex` with the shims first on PATH", async () => {
    const fake = await makeFakeBinaries(["codex"]);
    const { stdout, status } = runShim("codex", ["--cd", "/tmp"], fake, { AI_MULTI_REAL_CODEX: "codex" });
    expect(status).toBe(0);
    expect(stdout.match(/FAKE-codex/g)).toHaveLength(1);
    // consumed by the shim, so the agent and anything it spawns never see it
    expect(stdout).toContain("real= args");
  });

  it("runs an absolute real binary as given", async () => {
    const fake = await makeFakeBinaries(["codex"]);
    const { stdout } = runShim("codex", ["resume", "abc"], fake, { AI_MULTI_REAL_CODEX: path.join(fake, "codex") });
    expect(stdout).toContain("FAKE-codex");
    expect(stdout).toContain("args:resume abc");
  });

  it.each(["exec", "login", "mcp", "apply"])("passes `codex %s` straight through without marking the shim active", async (subcommand) => {
    const fake = await makeFakeBinaries(["codex"]);
    const { stdout } = runShim("codex", [subcommand, "x"], fake);
    expect(stdout).toContain("active= ");
  });

  it("fails clearly when there is no real codex to run", async () => {
    const fake = await makeFakeBinaries([]);
    expect(runShim("codex", [], fake).status).toBe(127);
  });
});

describe("instance loader", () => {
  const loader = path.join(scriptsDirectory, "instance-loader.sh");

  it.each(["bash", "zsh"])("puts the shims on PATH under %s even when there is no launch command to run", (shell) => {
    // tmux is not on this PATH, so the loader finds no launch command and returns early: the
    // export must already have happened by then.
    const result = spawnSync(shell, ["-c", `source '${loader}' >/dev/null 2>&1; echo "$PATH"`], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: os.tmpdir() },
    });
    expect(result.stdout.trim().split(":")[0]).toBe(shimsDirectory);
  });
});
