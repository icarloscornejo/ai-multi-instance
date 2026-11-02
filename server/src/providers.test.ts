import { execSync } from "node:child_process";
import path from "node:path";
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

const HOOK_EVENTS = [
  "PermissionRequest",
  "Notification",
  "PreToolUse",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SessionStart",
  "SessionEnd",
];

// The --settings value as the shell hands it to claude: run through the shell's own un-quoting.
function injectedSettings(command: string): { hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> } & Record<string, unknown> {
  const quoted: string | undefined = /--settings ('(?:[^']|'\\'')*')/.exec(command)?.[1];
  expect(quoted).toBeDefined();
  return JSON.parse(execSync(`printf %s ${quoted}`, { encoding: "utf8" }));
}

describe("provider launch commands", () => {
  it("injects the agent state hooks through --settings for Claude", () => {
    const settings = injectedSettings(buildProviderLaunchCommand(instance("claude")));

    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    const scriptPath: string = (settings.hooks.Stop[0].hooks[0] as { command: string }).command;
    expect(path.isAbsolute(scriptPath)).toBe(true);
    expect(path.basename(scriptPath)).toBe("dashboard-agent-state.sh");
    for (const eventName of HOOK_EVENTS) {
      const groups = settings.hooks[eventName];
      expect(groups).toHaveLength(1);
      expect(groups[0].hooks).toEqual([{ type: "command", command: scriptPath, timeout: 5 }]);
      // only PreToolUse is narrowed to one tool
      if (eventName === "PreToolUse") expect(groups[0].matcher).toBe("AskUserQuestion");
      else expect(groups[0].matcher).toBeUndefined();
    }
    expect(settings.statusLine).toBeDefined();
  });

  it.each(["codex", "cursor"] as const)("injects no hooks for %s", (provider) => {
    const command = buildProviderLaunchCommand(instance(provider));
    expect(command).not.toContain("hooks");
    expect(command).not.toContain("dashboard-agent-state.sh");
  });

  it("injects no hooks into a custom command", () => {
    const custom = "my-cli --flag";
    expect(buildProviderLaunchCommand(instance("custom", { command: custom, model: null }))).not.toContain("dashboard-agent-state.sh");
  });

  it("adds only Claude-specific flags to Claude", () => {
    const command = buildProviderLaunchCommand(instance("claude"), "claude-session");
    expect(command).toContain("'claude' --resume 'claude-session'");
    expect(command).toContain("--settings");
    expect(command).toContain("-n 'My Agent'");
    expect(command).toContain("--effort 'high'");
  });

  it("uses the Codex resume subcommand without Claude flags", () => {
    const command = buildProviderLaunchCommand(instance("codex"), "codex-session");
    expect(command).toContain("scripts/shims/codex' resume 'codex-session' --model 'test-model'");
    expect(command).not.toContain("--settings");
    expect(command).not.toContain(" -n ");
    expect(command).not.toContain("--effort");
  });

  it("launches Codex through the shim by absolute path, passing the real executable, for fresh and resumed sessions", () => {
    // An absolute user-edited command must not bypass the shim (and with it the session watcher).
    const custom = instance("codex", { command: "/opt/homebrew/bin/codex" });
    for (const command of [buildProviderLaunchCommand(custom), buildProviderLaunchCommand(custom, "codex-session")]) {
      expect(command).toMatch(/^AI_MULTI_INSTANCE_ID='instance-1' AI_MULTI_REAL_CODEX='\/opt\/homebrew\/bin\/codex' '\/.*\/scripts\/shims\/codex'/);
      expect(command).not.toContain("codex-session-watcher");
    }
  });

  it("builds a Codex command with no syntax errors", () => {
    execSync(`zsh -n -c ${quoteForShell(buildProviderLaunchCommand(instance("codex")))}`);
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
