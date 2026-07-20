import type { AgentProvider } from "./types";

export const PROVIDER_OPTIONS: { value: AgentProvider; label: string; command: string }[] = [
  { value: "claude", label: "Claude Code", command: "claude" },
  { value: "codex", label: "Codex CLI", command: "codex" },
  { value: "cursor", label: "Cursor Agent", command: "agent" },
  { value: "custom", label: "Other agent", command: "" },
];

export function previewCommand(provider: AgentProvider, command: string, model: string, effort: string): string {
  if (provider === "custom") return command || "(enter a command)";
  const parts: string[] = [command || PROVIDER_OPTIONS.find((option) => option.value === provider)?.command || ""];
  if (model) parts.push("--model", `'${model.replace(/'/g, `'\\''`)}'`);
  if (provider === "claude" && effort) parts.push("--effort", effort);
  return parts.join(" ");
}
