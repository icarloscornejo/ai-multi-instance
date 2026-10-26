import path from "node:path";
import type { AgentProvider, InstanceRecord } from "./types";

export interface ProviderCapabilities {
  model: boolean;
  effort: boolean;
  resume: boolean;
  liveMetrics: boolean;
}

export interface AgentProviderDefinition {
  id: AgentProvider;
  label: string;
  defaultCommand: string;
  capabilities: ProviderCapabilities;
}

export const PROVIDERS: Record<AgentProvider, AgentProviderDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    defaultCommand: "claude",
    capabilities: { model: true, effort: true, resume: true, liveMetrics: true },
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    defaultCommand: "codex",
    capabilities: { model: true, effort: false, resume: true, liveMetrics: true },
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    defaultCommand: "agent",
    capabilities: { model: true, effort: false, resume: true, liveMetrics: true },
  },
  custom: {
    id: "custom",
    label: "Custom command",
    defaultCommand: "",
    capabilities: { model: false, effort: false, resume: false, liveMetrics: false },
  },
};

const statuslineScriptPath: string = path.resolve(import.meta.dirname, "../scripts/dashboard-statusline.sh");
const codexShimPath: string = path.resolve(import.meta.dirname, "../scripts/shims/codex");
const cursorLauncherPath: string = path.resolve(import.meta.dirname, "../scripts/cursor-session-launcher.mjs");

export function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function executable(instance: InstanceRecord): string {
  return instance.command.trim() || PROVIDERS[instance.provider].defaultCommand;
}

function buildClaudeCommand(instance: InstanceRecord, sessionId?: string): string {
  const parts: string[] = [
    `AI_MULTI_INSTANCE_ID=${quoteForShell(instance.id)}`,
    quoteForShell(executable(instance)),
  ];
  if (sessionId) parts.push("--resume", quoteForShell(sessionId));
  if (instance.model) parts.push("--model", quoteForShell(instance.model));
  if (instance.effort) parts.push("--effort", quoteForShell(instance.effort));
  const settingsOverride: string = JSON.stringify({
    statusLine: { type: "command", command: statuslineScriptPath },
  });
  parts.push("--settings", quoteForShell(settingsOverride));
  parts.push("-n", quoteForShell(instance.label));
  return parts.join(" ");
}

// Goes through the codex shim by absolute path (not through PATH lookup of `codex`) so a
// user-edited absolute `command` still gets the session watcher: the shim is the one place that
// starts it, for this launch and for codex sessions started by hand in the pane alike. The shim
// backgrounds the watcher inside a subshell, so its exit produces no "[1] done" job notice in
// the pane that would expose the command line the loader script exists to hide.
function buildCodexCommand(instance: InstanceRecord, sessionId?: string): string {
  const cliParts: string[] = [
    `AI_MULTI_INSTANCE_ID=${quoteForShell(instance.id)}`,
    `AI_MULTI_REAL_CODEX=${quoteForShell(executable(instance))}`,
    quoteForShell(codexShimPath),
  ];
  if (sessionId) cliParts.push("resume", quoteForShell(sessionId));
  if (instance.model) cliParts.push("--model", quoteForShell(instance.model));
  if (!sessionId) {
    cliParts.push("--cd", quoteForShell(instance.locationPath));
  }
  return cliParts.join(" ");
}

function buildCursorCommand(instance: InstanceRecord, sessionId?: string): string {
  if (!sessionId) {
    return [
      `AI_MULTI_INSTANCE_ID=${quoteForShell(instance.id)}`,
      "node",
      quoteForShell(cursorLauncherPath),
      quoteForShell(executable(instance)),
      quoteForShell(instance.id),
      quoteForShell(instance.locationPath),
      quoteForShell(instance.model ?? ""),
    ].join(" ");
  }
  const parts: string[] = [
    `AI_MULTI_INSTANCE_ID=${quoteForShell(instance.id)}`,
    quoteForShell(executable(instance)),
  ];
  if (sessionId) parts.push("--resume", quoteForShell(sessionId));
  if (instance.model) parts.push("--model", quoteForShell(instance.model));
  return parts.join(" ");
}

export function buildProviderLaunchCommand(instance: InstanceRecord, sessionId?: string): string {
  switch (instance.provider) {
    case "claude":
      return buildClaudeCommand(instance, sessionId);
    case "codex":
      return buildCodexCommand(instance, sessionId);
    case "cursor":
      return buildCursorCommand(instance, sessionId);
    case "custom":
      return instance.command;
  }
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "claude" || value === "codex" || value === "cursor" || value === "custom";
}

export function sessionKeyFor(provider: AgentProvider, locationPath: string, label: string): string {
  return `${provider}::${locationPath}::${label}`;
}
