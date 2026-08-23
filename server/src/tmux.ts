import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class TmuxError extends Error {}

// A tmux command hanging forever (a wedged tmux server, a slow filesystem the shell's
// startup files touch) used to hold a WebSocket attach open indefinitely: the client's own
// watchdog would eventually give up (see LIVENESS_TIMEOUT_MS in TerminalView.tsx) and start
// a fresh attach on top of the still-running one, accumulating orphaned tmux child
// processes across reconnects. Deliberately well under that 25s client timeout so a hung
// command is killed and surfaces as a normal recoverable failure (see
// closeCodeForAttachError) long before the client would otherwise abandon the socket.
const DEFAULT_TMUX_TIMEOUT_MS = 10_000;

// Note: the "=" exact-match prefix is not used because in tmux 3.7 several commands
// (set-option, send-keys) do not resolve it. The ccdash-<id> names never collide on
// prefix with each other, and tmux always prefers the exact name match.
async function runTmux(tmuxArguments: string[], timeoutMs: number = DEFAULT_TMUX_TIMEOUT_MS): Promise<string> {
  try {
    // execFile's own `timeout` option sends SIGTERM to the child once it elapses and
    // rejects the promise; Node reports this as an ETIMEDOUT-ish error with `killed: true`
    // rather than a distinct error class, but that's fine here - it's caught below and
    // wrapped in TmuxError like any other tmux failure, which the attach path already
    // treats as recoverable (see closeCodeForAttachError in attachErrors.ts).
    const { stdout } = await execFileAsync("tmux", tmuxArguments, { timeout: timeoutMs });
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

// The instance's cwd can drift from its stored locationPath if the user `cd`s inside
// the terminal; this reads the pane's live directory instead of the one it started in.
export async function getPaneCurrentPath(sessionName: string): Promise<string> {
  return runTmux(["display-message", "-p", "-t", sessionName, "#{pane_current_path}"]);
}

// Scrolling up (mouse wheel or touch) puts the pane into copy-mode; "scroll to bottom"
// means leaving it. No need to check pane_in_mode first: send-keys -X on a pane that
// isn't in a mode fails outright ("not in a mode", verified against a live tmux server)
// rather than being misread as a literal keystroke by whatever the pane is running, so
// the no-op case is just a rejected command, safe to swallow. "cancel" is bound the same
// way in both the copy-mode and copy-mode-vi tables, so this doesn't depend on the host's
// mode-keys setting. Skipping the pre-check also halves this action's latency (one tmux
// process spawn instead of two sequential ones).
export async function exitCopyMode(sessionName: string): Promise<void> {
  try {
    await runTmux(["send-keys", "-X", "-t", sessionName, "cancel"]);
  } catch (error) {
    if (error instanceof TmuxError && error.message.includes("not in a mode")) {
      return;
    }
    throw error;
  }
}
