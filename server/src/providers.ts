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
const codexWatcherPath: string = path.resolve(import.meta.dirname, "../scripts/codex-session-watcher.mjs");
const cursorLauncherPath: string = path.resolve(import.meta.dirname, "../scripts/cursor-session-launcher.mjs");

export function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function slugifyLabel(label: string): string {
  const slug: string = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "instance" : slug;
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
  parts.push("-n", quoteForShell(slugifyLabel(instance.label)));
  return parts.join(" ");
}

function buildCodexCommand(instance: InstanceRecord, sessionId?: string): string {
  const cliParts: string[] = [quoteForShell(executable(instance))];
  if (sessionId) cliParts.push("resume", quoteForShell(sessionId));
  if (instance.model) cliParts.push("--model", quoteForShell(instance.model));
  if (!sessionId) {
    cliParts.push("--cd", quoteForShell(instance.locationPath));
  }
  if (sessionId) {
    return `AI_MULTI_INSTANCE_ID=${quoteForShell(instance.id)} ${cliParts.join(" ")}`;
  }
  const watcher: string = [
    "node",
    quoteForShell(codexWatcherPath),
    quoteForShell(instance.id),
    quoteForShell(instance.locationPath),
    quoteForShell(String(Date.now())),
    "&",
  ].join(" ");
  return `AI_MULTI_INSTANCE_ID=${quoteForShell(instance.id)} ${watcher} ${cliParts.join(" ")}`;
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
