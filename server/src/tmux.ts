import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class TmuxError extends Error {}

// Note: the "=" exact-match prefix is not used because in tmux 3.7 several commands
// (set-option, send-keys) do not resolve it. The ccdash-<id> names never collide on
// prefix with each other, and tmux always prefers the exact name match.
async function runTmux(tmuxArguments: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tmux", tmuxArguments);
    return stdout.trim();
  } catch (error) {
    const stderr: string = ((error as { stderr?: string }).stderr ?? "").trim();
    throw new TmuxError(stderr || (error as Error).message);
  }
}

export async function hasSession(sessionName: string): Promise<boolean> {
  try {
    await runTmux(["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(sessionName: string, workingDirectory: string): Promise<void> {
  // tmux starts the user's default shell as a login shell, so Vertex env vars
  // arrive from .zprofile/.zshrc just as they would in a regular terminal
  await runTmux(["new-session", "-d", "-s", sessionName, "-c", workingDirectory]);
  // The tmux status bar is redundant inside the dashboard's embedded terminal
  await runTmux(["set-option", "-t", sessionName, "status", "off"]);
  await enableMouseMode(sessionName);
}

// Without this tmux does not report the mouse wheel: xterm translates it into arrow
// keys and the native scroll of the session (or Claude Code) never receives it.
// Idempotent, so it also migrates sessions that were already alive before this change.
export async function enableMouseMode(sessionName: string): Promise<void> {
  await runTmux(["set-option", "-t", sessionName, "mouse", "on"]);
}

export async function sendCommandToSession(sessionName: string, command: string): Promise<void> {
  // "-l" sends the text literally (without interpreting key names); Enter is sent separately
  await runTmux(["send-keys", "-t", sessionName, "-l", command]);
  await runTmux(["send-keys", "-t", sessionName, "Enter"]);
}

export async function killSession(sessionName: string): Promise<void> {
  await runTmux(["kill-session", "-t", sessionName]);
}
