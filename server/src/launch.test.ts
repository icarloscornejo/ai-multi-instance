import { describe, expect, it } from "vitest";
import { buildLoaderInvocation, buildReadyChannelName, buildShellOnlyReadyCommand } from "./launch";
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
});
