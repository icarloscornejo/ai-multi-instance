import type { InstanceRecord } from "./types";

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Session name understood by "claude -n": lowercase, [a-z0-9-] only, never empty
function slugifyLabel(label: string): string {
  const slug: string = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "instance" : slug;
}

// Mirror of web/src/launchCommand.ts (buildLaunchCommandPreview): keep both in sync
export function buildLaunchCommand(
  instance: Pick<InstanceRecord, "command" | "label" | "model" | "effort">
): string {
  const commandParts: string[] = [instance.command.trim() || "claude"];
  if (instance.model) {
    commandParts.push("--model", quoteForShell(instance.model));
  }
  if (instance.effort) {
    commandParts.push("--effort", quoteForShell(instance.effort));
  }
  commandParts.push("-n", quoteForShell(slugifyLabel(instance.label)));
  return commandParts.join(" ");
}
