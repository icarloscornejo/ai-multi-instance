// Mirror of server/src/launch.ts buildLaunchCommand: keep both in sync
function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function slugifyLabel(label: string): string {
  const slug: string = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "instance" : slug;
}

interface LaunchCommandInput {
  command: string;
  label: string;
  model: string | null;
  effort: string | null;
}

export function buildLaunchCommandPreview({ command, label, model, effort }: LaunchCommandInput): string {
  const commandParts: string[] = [command.trim() || "claude"];
  if (model) {
    commandParts.push("--model", quoteForShell(model));
  }
  if (effort) {
    commandParts.push("--effort", quoteForShell(effort));
  }
  commandParts.push("-n", quoteForShell(slugifyLabel(label)));
  return commandParts.join(" ");
}
