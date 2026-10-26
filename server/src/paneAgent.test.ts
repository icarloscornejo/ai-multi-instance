import { describe, expect, it } from "vitest";
import { pickOriginalPane } from "./tmux";
import {
  PS_ARGUMENTS,
  classifyPane,
  detectProvider,
  extractResumeId,
  parseElapsedSeconds,
  parsePsOutput,
  type ProcessRow,
} from "./paneAgent";

const NOW_MS = 1_000_000_000;

function row(pid: number, ppid: number, pgid: number, tpgid: number, args: string, elapsedSeconds = 60): ProcessRow {
  return { pid, ppid, pgid, tpgid, elapsedSeconds, args };
}

describe("parsing", () => {
  it("parses etime in every format ps prints", () => {
    expect(parseElapsedSeconds("05:07")).toBe(307);
    expect(parseElapsedSeconds("01:05:07")).toBe(3907);
    expect(parseElapsedSeconds("2-01:05:07")).toBe(176707);
    expect(parseElapsedSeconds("garbage")).toBeNull();
  });

  it("parses ps lines, keeping the whole command line", () => {
    const long = `node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js ${"x".repeat(300)}`;
    const rows = parsePsOutput(`  100     1   100   100       05:07 /bin/zsh\n  200   100   200   200    01:00:00 ${long}\n`);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ pid: 200, ppid: 100, pgid: 200, tpgid: 200, elapsedSeconds: 3600 });
    expect(rows[1].args).toBe(long);
    expect(detectProvider(rows[1].args)).toBe("claude");
  });

  it("asks ps for untruncated lines", () => {
    expect(PS_ARGUMENTS).toContain("-ww");
  });

  it("picks the lowest pane id as the original pane", () => {
    expect(pickOriginalPane("%12 500\n%7 300\n%9 400")).toEqual({ paneId: "%7", panePid: 300 });
    expect(pickOriginalPane("")).toBeNull();
  });
});

describe("detectProvider", () => {
  it.each([
    ["claude --model opusplan --effort medium", "claude"],
    ["/Users/x/.local/share/claude/versions/2.1.310 --resume abc", null],
    ["node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js", "claude"],
    ["/opt/homebrew/Caskroom/codex/0.163.0/bin/codex resume 0198-aaaa", "codex"],
    ["/x/codex-aarch64-apple-darwin", "codex"],
    ["node /usr/lib/node_modules/@openai/codex/bin/codex.js", "codex"],
    ["/bin/bash /Users/x/.local/bin/agent --resume abcdef12", "cursor"],
    ["/Users/x/.local/share/cursor-agent/versions/1/node /Users/x/.local/share/cursor-agent/versions/1/index.js", "cursor"],
    ["/bin/bash /Users/x/bin/claude-me --resume abcdef12", null],
    ["vim notes.txt", null],
  ])("%s -> %s", (args, expected) => {
    expect(detectProvider(args)).toBe(expected);
  });

  it("extracts resume ids for each CLI shape", () => {
    expect(extractResumeId("claude --resume fbdfd0a2-e628-4d39-be7b-4f5633e30f8d --model x")).toBe(
      "fbdfd0a2-e628-4d39-be7b-4f5633e30f8d"
    );
    expect(extractResumeId("codex resume 0198-aaaa-bbbb")).toBe("0198-aaaa-bbbb");
    expect(extractResumeId("claude --model opusplan")).toBeNull();
  });
});

describe("classifyPane", () => {
  const shell = row(100, 1, 100, 300, "-zsh");

  it("reports the agent behind a bash wrapper, not the wrapper", () => {
    const rows = [
      shell,
      row(300, 100, 300, 300, "/bin/bash /Users/x/bin/claude-me --resume abcdef12"),
      row(301, 300, 300, 300, "claude --resume abcdef12", 120),
    ];
    expect(classifyPane(rows, 100, NOW_MS)).toEqual({
      kind: "agent",
      provider: "claude",
      paneJobPid: 300,
      agentPid: 301,
      startedAtMs: NOW_MS - 120_000,
      resumeId: "abcdef12",
    });
  });

  it("finds an npm-installed agent running as node", () => {
    const rows = [
      shell,
      row(300, 100, 300, 300, "node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"),
      row(301, 300, 300, 300, "/x/codex-aarch64-apple-darwin"),
    ];
    expect(classifyPane(rows, 100, NOW_MS)).toMatchObject({ kind: "agent", provider: "codex", agentPid: 300 });
  });

  it("ignores a background child sitting next to the agent", () => {
    const rows = [
      shell,
      row(250, 100, 250, 300, "gitstatusd"),
      row(300, 100, 300, 300, "claude"),
    ];
    expect(classifyPane(rows, 100, NOW_MS)).toMatchObject({ kind: "agent", agentPid: 300, paneJobPid: 300 });
  });

  it("reports none for an idle prompt with a background child", () => {
    const idleShell = row(100, 1, 100, 100, "-zsh");
    expect(classifyPane([idleShell, row(250, 100, 250, 100, "gitstatusd")], 100, NOW_MS)).toEqual({ kind: "none" });
  });

  it("reports none for a non-agent foreground program", () => {
    expect(classifyPane([shell, row(300, 100, 300, 300, "vim notes.txt")], 100, NOW_MS)).toEqual({ kind: "none" });
  });

  it("handles exec claude, where the pane shell itself is the agent", () => {
    const execd = row(100, 1, 100, 100, "claude --model x");
    expect(classifyPane([execd], 100, NOW_MS)).toMatchObject({ kind: "agent", provider: "claude", paneJobPid: 100 });
  });

  it("handles exec claude-me, where the pane shell is the bash wrapper", () => {
    const rows = [row(100, 1, 100, 100, "/bin/bash /Users/x/bin/claude-me"), row(101, 100, 100, 100, "claude")];
    expect(classifyPane(rows, 100, NOW_MS)).toMatchObject({ kind: "agent", paneJobPid: 100, agentPid: 101 });
  });

  it("is unknown when the pane process is not in the listing", () => {
    expect(classifyPane([row(5, 1, 5, 5, "x")], 100, NOW_MS)).toEqual({ kind: "unknown" });
  });
});
