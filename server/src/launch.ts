import path from "node:path";
import type { InstanceRecord } from "./types";
import { buildProviderLaunchCommand, PROVIDERS, quoteForShell } from "./providers";

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

// The name the real launch command travels under in the tmux session's environment - see
// setSessionEnvironment (tmux.ts) and instance-loader.sh, which reads it back out and clears it.
export const LAUNCH_COMMAND_ENV_NAME = "AI_LAUNCH_COMMAND";

const loaderScriptPath: string = path.resolve(import.meta.dirname, "../scripts/instance-loader.sh");

// The short line actually typed into the pane in place of the real launch command (see
// buildLaunchCommand above): sources the loader script, which reads the real command back
// out of the session environment, signals the ready channel, and evaluates it.
export function buildLoaderInvocation(): string {
  return `source ${quoteForShell(loaderScriptPath)}`;
}

// The name the ready-channel travels under in the tmux session's environment - see
// setSessionEnvironment (tmux.ts) and instance-loader.sh, which reads it back out.
export const READY_CHANNEL_ENV_NAME = "AI_LAUNCH_READY_CHANNEL";

// Monotonic, not just Date.now(): two launches of the same instance id can happen within the
// same millisecond (a fast retry after a failed launch), and buildReadyChannelName's whole
// point is that no two launch attempts ever share a channel name.
let readyChannelSequence = 0;

// A fresh, launch-unique tmux "wait-for" channel name (see waitForChannelSignal/signalChannel
// in tmux.ts). Unique per launch attempt, not just per instance id, so a signal from a stale
// or crashed earlier attempt can never be mistaken for the current one's - see
// agentReadiness.ts's markAgentReady, which also checks this against the currently tracked
// channel before transitioning state.
export function buildReadyChannelName(instance: InstanceRecord): string {
  readyChannelSequence += 1;
  return `ccdash-ready-${instance.id}-${Date.now()}-${readyChannelSequence}`;
}

// For a shellOnly instance: there is no real command to hide (no loader to source), but the
// dashboard's HTML boot overlay still needs a signal to know the shell's prompt is up.
export function buildShellOnlyReadyCommand(channelName: string): string {
  return `clear; tmux wait-for -S ${quoteForShell(channelName)}`;
}
