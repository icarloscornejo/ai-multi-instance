import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildLoaderInvocation, buildReadyChannelName, buildShellOnlyReadyCommand, wrapWithFreshFallback } from "./launch";
import type { InstanceRecord } from "./types";

function instance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: "instance-1",
    label: "My Agent",
    locationPath: "/tmp/project",
    tmuxSession: "ccdash-instance-1",
    provider: "claude",
    command: "claude",
    model: null,
    effort: null,
    fontSize: 13,
    createdAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildLoaderInvocation", () => {
  it("sources the loader script and nothing else - no labels, no flags", () => {
    const invocation = buildLoaderInvocation();
    expect(invocation).toMatch(/^source '.*instance-loader\.sh'$/);
    expect(invocation).not.toContain("--settings");
  });
});

describe("buildReadyChannelName", () => {
  it("includes the instance id", () => {
    expect(buildReadyChannelName(instance())).toContain("instance-1");
  });

  it("is unique per call, so a stale watcher can never be mistaken for a fresh launch", () => {
    const first = buildReadyChannelName(instance());
    const second = buildReadyChannelName(instance());
    expect(first).not.toBe(second);
  });
});

describe("buildShellOnlyReadyCommand", () => {
  it("signals the given channel via tmux wait-for", () => {
    const command = buildShellOnlyReadyCommand("ccdash-ready-instance-1-123");
    expect(command).toContain("clear;");
    expect(command).toContain("tmux wait-for -S 'ccdash-ready-instance-1-123'");
  });

  it("puts the agent shims on PATH first, so a hand-started agent in a shell-only instance reports to the sidebar", () => {
    expect(buildShellOnlyReadyCommand("c")).toMatch(/^export PATH='\/.*\/scripts\/shims':"\$PATH"; clear;/);
  });
});

describe("wrapWithFreshFallback", () => {
  const run = (script: string): string => execFileSync("sh", ["-c", script], { encoding: "utf8" });

  it("runs the fresh command when the resume command fails at once", () => {
    expect(run(wrapWithFreshFallback("echo resume; false", "echo fresh")).split("\n").filter(Boolean)).toEqual(["resume", "fresh"]);
  });

  it("does not run the fresh command when the resume command succeeds", () => {
    expect(run(wrapWithFreshFallback("echo resume", "echo fresh")).trim()).toBe("resume");
  });

  it("does not fall back when a failing command ran for longer than the window", () => {
    expect(run(wrapWithFreshFallback("sleep 4; false", "echo fresh")).trim()).toBe("");
  }, 15_000);

  it("runs nothing at all when a cd in front of the grouped wrapper fails", () => {
    expect(run(`cd -- /no/such/dir/for/this/test 2>/dev/null && { ${wrapWithFreshFallback("echo resume", "echo fresh")}; }; true`).trim()).toBe("");
  });
});
