import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
