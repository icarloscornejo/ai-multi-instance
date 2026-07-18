import type { InstanceRecord } from "./types";
import { buildProviderLaunchCommand, PROVIDERS } from "./providers";

// A stale/invalid --resume session id fails fast ("No conversation found with session
// ID: ...", exit code 1) rather than hanging or prompting. This threshold only catches
// that fast-failure case: a real session that the user later quits (Ctrl+C, /exit, etc,
// which may also exit non-zero) will have run well past it, so it never falls back.
const RESUME_FAILURE_WINDOW_SECONDS = 3;

export function buildLaunchCommand(
  instance: InstanceRecord,
  options: { resumeSessionId?: string } = {}
): string {
  const freshCommand: string = buildProviderLaunchCommand(instance);
  if (!options.resumeSessionId || !PROVIDERS[instance.provider].capabilities.resume) {
    return freshCommand;
  }

  const resumeCommand: string = buildProviderLaunchCommand(instance, options.resumeSessionId);
  return (
    `__resume_started=$(date +%s); ${resumeCommand}; __resume_code=$?; ` +
    `if [ "$__resume_code" -ne 0 ] && [ "$(($(date +%s) - __resume_started))" -lt ${RESUME_FAILURE_WINDOW_SECONDS} ]; then ` +
    `${freshCommand}; fi`
  );
}
