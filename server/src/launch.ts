import path from "node:path";
import type { InstanceRecord } from "./types";

const statuslineScriptPath: string = path.resolve(import.meta.dirname, "../scripts/dashboard-statusline.sh");

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

// A stale/invalid --resume session id fails fast ("No conversation found with session
// ID: ...", exit code 1) rather than hanging or prompting. This threshold only catches
// that fast-failure case: a real session that the user later quits (Ctrl+C, /exit, etc,
// which may also exit non-zero) will have run well past it, so it never falls back.
const RESUME_FAILURE_WINDOW_SECONDS = 3;

// Mirror of web/src/launchCommand.ts (buildLaunchCommandPreview): keep both in sync, except
// this server-side version additionally injects --settings to wire up the dashboard's
// statusline wrapper, and --resume (with a same-shell-line fallback to a fresh launch)
// when a prior session id is known for this location+label (all left out of the preview
// since they're internal plumbing, not something the user configured).
export function buildLaunchCommand(
  instance: Pick<InstanceRecord, "command" | "label" | "model" | "effort">,
  options: { resumeSessionId?: string } = {}
): string {
  const baseParts: string[] = [instance.command.trim() || "claude"];
  if (instance.model) {
    baseParts.push("--model", quoteForShell(instance.model));
  }
  if (instance.effort) {
    baseParts.push("--effort", quoteForShell(instance.effort));
  }
  const settingsOverride: string = JSON.stringify({
    statusLine: { type: "command", command: statuslineScriptPath },
  });
  baseParts.push("--settings", quoteForShell(settingsOverride));
  baseParts.push("-n", quoteForShell(slugifyLabel(instance.label)));

  const freshCommand: string = baseParts.join(" ");
  if (!options.resumeSessionId) {
    return freshCommand;
  }

  const resumeCommand: string = [baseParts[0], "--resume", quoteForShell(options.resumeSessionId), ...baseParts.slice(1)].join(
    " "
  );
  return (
    `__resume_started=$(date +%s); ${resumeCommand}; __resume_code=$?; ` +
    `if [ "$__resume_code" -ne 0 ] && [ "$(($(date +%s) - __resume_started))" -lt ${RESUME_FAILURE_WINDOW_SECONDS} ]; then ` +
    `${freshCommand}; fi`
  );
}
