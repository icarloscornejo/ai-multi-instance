// Mirror of server/src/launch.ts buildLaunchCommand: keep both in sync, except the server
// additionally injects a --settings statusline override, which is internal plumbing and
// intentionally left out of this preview
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

// Groups the command into display lines (flag + its value share a line), for UIs that
// render the command vertically instead of as one long wrapping string.
export function buildLaunchCommandLines({ command, label, model, effort }: LaunchCommandInput): string[] {
  const lines: string[] = [command.trim() || "claude"];
  if (model) {
    lines.push(`--model ${quoteForShell(model)}`);
  }
  if (effort) {
    lines.push(`--effort ${quoteForShell(effort)}`);
  }
  lines.push(`-n ${quoteForShell(slugifyLabel(label))}`);
  return lines;
}

export function buildLaunchCommandPreview(input: LaunchCommandInput): string {
  return buildLaunchCommandLines(input).join(" ");
}
