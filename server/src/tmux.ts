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
  await reduceScrollStep();
}

// Without this tmux does not report the mouse wheel: xterm translates it into arrow
// keys and the native scroll of the session (or Claude Code) never receives it.
// Idempotent, so it also migrates sessions that were already alive before this change.
export async function enableMouseMode(sessionName: string): Promise<void> {
  await runTmux(["set-option", "-t", sessionName, "mouse", "on"]);
}

// tmux's default wheel binding scrolls 5 lines per tick, which feels like a jump
// instead of a smooth scroll. Rebinding to 3 lines balances feel (less jumpy than 5)
// against effort (1-2 lines per tick required too many ticks to cover any distance).
// bind-key is a server-wide setting (this app runs on the default tmux
// socket, not a dedicated one), so this affects every tmux session on the machine —
// acceptable here since this dashboard is the only tmux user. Idempotent.
async function reduceScrollStep(): Promise<void> {
  // "\;" (not a bare ";") is required: tmux's own argv parser splits on a bare ";"
  // into two separate top-level commands even without a shell involved, which would
  // run send-keys immediately instead of chaining it into the bind-key action.
  for (const keyTable of ["copy-mode", "copy-mode-vi"]) {
    await runTmux(["bind-key", "-T", keyTable, "WheelUpPane", "select-pane", "\\;", "send-keys", "-X", "-N", "3", "scroll-up"]);
    await runTmux(["bind-key", "-T", keyTable, "WheelDownPane", "select-pane", "\\;", "send-keys", "-X", "-N", "3", "scroll-down"]);
  }
}

export async function sendCommandToSession(sessionName: string, command: string): Promise<void> {
  // "-l" sends the text literally (without interpreting key names); Enter is sent separately
  await runTmux(["send-keys", "-t", sessionName, "-l", command]);
  await runTmux(["send-keys", "-t", sessionName, "Enter"]);
}

export async function killSession(sessionName: string): Promise<void> {
  await runTmux(["kill-session", "-t", sessionName]);
}
