import { describe, expect, it } from "vitest";
import { buildProviderLaunchCommand, PROVIDERS, quoteForShell, sessionKeyFor } from "./providers";
import type { AgentProvider, InstanceRecord } from "./types";

function instance(provider: AgentProvider, overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: "instance-1",
    label: "My Agent",
    locationPath: "/tmp/project with space",
    tmuxSession: "ccdash-instance-1",
    provider,
    command: provider === "cursor" ? "agent" : provider,
    model: "test-model",
    effort: provider === "claude" ? "high" : null,
    fontSize: 13,
    createdAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("provider launch commands", () => {
  it("adds only Claude-specific flags to Claude", () => {
    const command = buildProviderLaunchCommand(instance("claude"), "claude-session");
    expect(command).toContain("'claude' --resume 'claude-session'");
    expect(command).toContain("--settings");
    expect(command).toContain("-n 'my-agent'");
    expect(command).toContain("--effort 'high'");
  });

  it("uses the Codex resume subcommand without Claude flags", () => {
    const command = buildProviderLaunchCommand(instance("codex"), "codex-session");
    expect(command).toContain("'codex' resume 'codex-session' --model 'test-model'");
    expect(command).not.toContain("--settings");
    expect(command).not.toContain(" -n ");
    expect(command).not.toContain("--effort");
  });

  it("resumes Cursor with its chat ID", () => {
    const command = buildProviderLaunchCommand(instance("cursor"), "cursor-chat");
    expect(command).toContain("'agent' --resume 'cursor-chat' --model 'test-model'");
    expect(command).not.toContain("--settings");
  });

  it("uses the Cursor launcher to allocate and persist a fresh chat", () => {
    const command = buildProviderLaunchCommand(instance("cursor"));
    expect(command).toContain("cursor-session-launcher.mjs");
    expect(command).toContain("AI_MULTI_INSTANCE_ID='instance-1'");
    expect(command).toContain("'agent' 'instance-1'");
  });

  it("exposes live metrics for Cursor", () => {
    expect(PROVIDERS.cursor.capabilities.liveMetrics).toBe(true);
  });

  it("returns a custom command byte-for-byte", () => {
    const custom = "my-cli --flag 'already quoted'";
    expect(buildProviderLaunchCommand(instance("custom", { command: custom, model: null }))).toBe(custom);
  });

  it("quotes shell values and namespaces session keys", () => {
    expect(quoteForShell("it's safe")).toBe("'it'\\''s safe'");
    expect(sessionKeyFor("codex", "/repo", "main")).toBe("codex::/repo::main");
  });
});
