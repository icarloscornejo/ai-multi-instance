import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectDirName, pickClaudeTranscript, readAgentConfigDir, sameProfile } from "./agentFallback";

const FAKE_TOKEN: string = String("faketoken_for_tests_0123456789abcdef");
const DEFAULT_PROFILE = path.join(os.homedir(), ".claude");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("sameProfile", () => {
  it("matches a set profile against the same directory", () => {
    expect(sameProfile({ kind: "set", dir: "/Users/example/.claude-me" }, "/Users/example/.claude-me")).toBe(true);
    expect(sameProfile({ kind: "set", dir: "/Users/example/.claude-me" }, "/Users/example/.claude-in")).toBe(false);
  });

  it("strips trailing slashes on both sides", () => {
    expect(sameProfile({ kind: "set", dir: "/Users/example/.claude-me/" }, "/Users/example/.claude-me")).toBe(true);
    expect(sameProfile({ kind: "set", dir: "/Users/example/.claude-me" }, "/Users/example/.claude-me//")).toBe(true);
  });

  it("treats an unset profile as the default ~/.claude", () => {
    expect(sameProfile({ kind: "unset" }, DEFAULT_PROFILE)).toBe(true);
    expect(sameProfile({ kind: "unset" }, `${DEFAULT_PROFILE}/`)).toBe(true);
    expect(sameProfile({ kind: "unset" }, "/Users/example/.claude-me")).toBe(false);
  });

  it("never matches an undefined instance config dir", () => {
    expect(sameProfile({ kind: "set", dir: "/Users/example/.claude-me" }, undefined)).toBe(false);
    expect(sameProfile({ kind: "unset" }, undefined)).toBe(false);
  });

  it("never matches an unreadable profile", () => {
    expect(sameProfile({ kind: "unreadable" }, DEFAULT_PROFILE)).toBe(false);
    expect(sameProfile({ kind: "unreadable" }, undefined)).toBe(false);
  });
});

describe("readAgentConfigDir", () => {
  const ARGS = "/Users/example/.local/share/claude/versions/2.1.310 --model x";

  // Fakes the two ps runs by their argv shape; nothing real is executed.
  function psRunner(outputs: { args: string | Error; eww: string | Error }): { run: (argv: string[]) => Promise<string>; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (argv: string[]) => {
        calls.push(argv);
        const output = argv.includes("eww") ? outputs.eww : outputs.args;
        if (output instanceof Error) throw output;
        return output;
      },
    };
  }

  it("reads CLAUDE_CONFIG_DIR from the environment suffix after the args", async () => {
    const fake = psRunner({ args: ARGS, eww: `${ARGS} TERM=xterm CLAUDE_CONFIG_DIR=/Users/example/.claude-me HOME=/Users/example` });

    await expect(readAgentConfigDir(301, fake.run)).resolves.toEqual({ configDir: { kind: "set", dir: "/Users/example/.claude-me" }, hasInstanceId: false });
  });

  it("is unset when the environment is visible and has no CLAUDE_CONFIG_DIR", async () => {
    const fake = psRunner({ args: ARGS, eww: `${ARGS} TERM=xterm HOME=/Users/example` });

    await expect(readAgentConfigDir(301, fake.run)).resolves.toMatchObject({ configDir: { kind: "unset" } });
  });

  it("reports whether AI_MULTI_INSTANCE_ID was in the environment", async () => {
    const fake = psRunner({ args: ARGS, eww: `${ARGS} TERM=xterm AI_MULTI_INSTANCE_ID=abc123` });

    await expect(readAgentConfigDir(301, fake.run)).resolves.toMatchObject({ hasInstanceId: true });
  });

  it("is unreadable when the eww output shows no environment beyond the args", async () => {
    const fake = psRunner({ args: ARGS, eww: ARGS });

    await expect(readAgentConfigDir(301, fake.run)).resolves.toMatchObject({ configDir: { kind: "unreadable" } });
  });

  it("ignores CLAUDE_CONFIG_DIR= text that lives inside the args, such as a -n value", async () => {
    const args = `${ARGS} -n CLAUDE_CONFIG_DIR=/Users/example/.claude-evil`;
    const fake = psRunner({ args, eww: `${args} TERM=xterm HOME=/Users/example` });

    await expect(readAgentConfigDir(301, fake.run)).resolves.toMatchObject({ configDir: { kind: "unset" } });
  });

  it("is unreadable, without leaking the output, when a ps run fails", async () => {
    const failure = Object.assign(new Error("ps failed"), { stdout: `${ARGS} ${FAKE_TOKEN}`, stderr: FAKE_TOKEN });
    const fake = psRunner({ args: ARGS, eww: failure });

    const reading = await readAgentConfigDir(301, fake.run);

    expect(reading.configDir).toEqual({ kind: "unreadable" });
    expect(JSON.stringify(reading)).not.toContain(FAKE_TOKEN);
  });

  it("asks ps about the given pid, fresh each time", async () => {
    const fake = psRunner({ args: ARGS, eww: `${ARGS} TERM=x` });

    await readAgentConfigDir(4321, fake.run);
    await readAgentConfigDir(4321, fake.run);

    expect(fake.calls).toHaveLength(4);
    expect(fake.calls.every((argv) => argv.join(" ").includes("4321"))).toBe(true);
  });
});

describe("pickClaudeTranscript", () => {
  async function profileWithTranscripts(cwd: string, transcripts: { id: string; ageSeconds: number }[]): Promise<string> {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "restart-profile-"));
    temporaryDirectories.push(profile);
    const projectDirectory = path.join(profile, "projects", claudeProjectDirName(cwd));
    await fs.mkdir(projectDirectory, { recursive: true });
    for (const transcript of transcripts) {
      const file = path.join(projectDirectory, `${transcript.id}.jsonl`);
      await fs.writeFile(file, "{}\n");
      const when = new Date(Date.now() - transcript.ageSeconds * 1000);
      await fs.utimes(file, when, when);
    }
    return profile;
  }

  it("returns the newest transcript of the cwd inside the explicit profile dir", async () => {
    const profile = await profileWithTranscripts("/Users/example/repo", [
      { id: "11111111-aaaa-4aaa-8aaa-000000000001", ageSeconds: 600 },
      { id: "22222222-bbbb-4bbb-8bbb-000000000002", ageSeconds: 5 },
    ]);

    await expect(pickClaudeTranscript(profile, "/Users/example/repo", new Set())).resolves.toBe("22222222-bbbb-4bbb-8bbb-000000000002");
  });

  it("skips a transcript that another dashboard session already owns", async () => {
    const profile = await profileWithTranscripts("/Users/example/repo", [
      { id: "11111111-aaaa-4aaa-8aaa-000000000001", ageSeconds: 600 },
      { id: "22222222-bbbb-4bbb-8bbb-000000000002", ageSeconds: 5 },
    ]);

    await expect(pickClaudeTranscript(profile, "/Users/example/repo", new Set(["22222222-bbbb-4bbb-8bbb-000000000002"]))).resolves.toBe(
      "11111111-aaaa-4aaa-8aaa-000000000001"
    );
  });

  it("returns null when the cwd has no transcript in that profile, never looking in another one", async () => {
    const profile = await profileWithTranscripts("/Users/example/other", [{ id: "33333333-cccc-4ccc-8ccc-000000000003", ageSeconds: 5 }]);

    await expect(pickClaudeTranscript(profile, "/Users/example/repo", new Set())).resolves.toBeNull();
  });
});
