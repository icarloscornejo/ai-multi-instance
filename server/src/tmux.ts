import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Preserves what execFile's error actually carried (killed/code/signal) instead of the flat
// message-only Error this used to be. That distinction is what lets callers tell "tmux said
// no" (a real, definitive answer) apart from "the command never finished" (a timeout, killed:
// true) or "the process died from a signal" - collapsing all three into one opaque message
// used to make a transient tmux stall indistinguishable from tmux confidently reporting a
// session doesn't exist, which is exactly the ambiguity that made it unsafe to ever destroy a
// session based on a probe result (see terminal.ts's ensureSessionReady for where this
// matters most).
export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly killed: boolean = false,
    public readonly code: number | null = null,
    public readonly signal: NodeJS.Signals | null = null
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

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
    const execError = error as NodeJS.ErrnoException & {
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    const stderr: string = (execError.stderr ?? "").trim();
    throw new TmuxError(
      stderr || execError.message,
      execError.killed === true,
      typeof execError.code === "number" ? execError.code : null,
      execError.signal ?? null
    );
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

// tmux's own, unambiguous way of saying "no such session" - both when a session with this
// name never existed and when the whole tmux server isn't even running (nothing has ever
// been created on this socket yet). Matched against stderr rather than exit code alone
// because execFile's timeout rejection (killed: true) also produces a non-zero exit, and that
// case must NOT be read as "absent" - see getSessionPresence below for why the distinction is
// load-bearing, not cosmetic.
const DEFINITELY_NO_SUCH_SESSION_PATTERN = /can't find session|no server running/i;

export type SessionPresence = "present" | "absent" | "unknown";

// Tri-state on purpose: hasSession()'s plain boolean collapses "confirmed gone" and "could
// not confirm either way" (a timeout, a wedged tmux server) into the same `false`, which is
// exactly what made it unsafe for ensureSessionReady (terminal.ts) to ever act on - a
// momentary stall would read as "session doesn't exist" and could trigger destroying a
// perfectly healthy session with the user's real work in it. "unknown" is the escape hatch:
// callers that must never destroy on ambiguous information check for it explicitly instead of
// this collapsing into "absent" the way hasSession's boolean does.
export async function getSessionPresence(sessionName: string): Promise<SessionPresence> {
  try {
    await runTmux(["has-session", "-t", sessionName]);
    return "present";
  } catch (error) {
    if (error instanceof TmuxError && !error.killed && DEFINITELY_NO_SUCH_SESSION_PATTERN.test(error.message)) {
      return "absent";
    }
    return "unknown";
  }
}

// Set only via a value ("1"/"0"), never via mere presence/absence of the option: relying on
// "does this custom option exist at all" is ambiguous across tmux versions for options that
// were simply never set (see this file's own comment on tmux 3.7's "=" prefix behavior for
// precedent on that kind of cross-version fragility), and a legacy session created before this
// marker existed must read the exact same way as one where the read itself merely failed -
// both must default to "preserve, do not destroy" (see isSessionInitIncomplete below).
const SESSION_INIT_MARKER_OPTION = "@ccdash_init_incomplete";

export async function createSession(sessionName: string, workingDirectory: string): Promise<void> {
  // The marker is set in the SAME tmux invocation that creates the session (chained with a
  // bare ";"), closing the window where the session could exist with no marker at all - which
  // would otherwise misread as "legacy, preserve" for a session this process itself just
  // created and hasn't finished initializing.
  //
  // Bare ";", not "\;" like reduceScrollStep below: runTmux calls execFile directly, with no
  // shell involved, so there is no shell to escape the ";" FROM in the first place. new-session
  // treats any trailing, un-chained argument as its own optional shell-command, so a literal
  // "\;" token here doesn't separate two commands - it gets absorbed as the start of that
  // shell-command, which fails instantly and kills the session with exit code 0 and no stderr,
  // silently. reduceScrollStep's "\;" is correct there because bind-key's own action argument
  // is re-parsed as a command sequence at KEYPRESS time, a wholly different parse than the one
  // this new-session invocation goes through right now - the two are not the same technique.
  //
  // tmux starts the user's default shell as a login shell, so Vertex env vars
  // arrive from .zprofile/.zshrc just as they would in a regular terminal
  await runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    workingDirectory,
    ";",
    "set-option",
    "-t",
    sessionName,
    SESSION_INIT_MARKER_OPTION,
    "1",
  ]);
  // The tmux status bar is redundant inside the dashboard's embedded terminal
  await runTmux(["set-option", "-t", sessionName, "status", "off"]);
  await enableMouseMode(sessionName);
  await reduceScrollStep();
}

// Called once initialization (createSession, and the provider launch for a non-shell-only
// instance) has fully completed - the ONLY thing that clears the marker. Its being cleared is
// therefore positive proof the session went through a complete init, which is what lets
// isSessionInitIncomplete safely distinguish "confirmed still mid-init" (marker reads "1")
// from every other case, including one this process cannot tell apart from "confirmed done":
// a legacy session, a read that failed outright, or one already marked complete.
export async function markSessionInitComplete(sessionName: string): Promise<void> {
  await runTmux(["set-option", "-t", sessionName, SESSION_INIT_MARKER_OPTION, "0"]);
}

export type SessionInitState = "confirmed-incomplete" | "not-confirmed-incomplete";

// Only an explicit "1" proves incompleteness. Every other outcome - the option reading "0",
// the option never having been set (a legacy session predating this marker), or the read
// itself throwing (a timeout, a wedged tmux server) - collapses into the SAME
// "not-confirmed-incomplete" result. That collapsing is deliberate, not a shortcut: the
// invariant this whole mechanism exists to protect is that destroying a session must require
// POSITIVE proof it was left incomplete, never the mere absence of proof it's ready. Getting
// this wrong the other way (destroying on ambiguity) is what nearly shipped here twice before
// landing on this design - see the terminal.ts callers for the full history.
export async function isSessionInitIncomplete(sessionName: string): Promise<SessionInitState> {
  try {
    const value = await runTmux(["show-options", "-t", sessionName, "-v", SESSION_INIT_MARKER_OPTION]);
    return value.trim() === "1" ? "confirmed-incomplete" : "not-confirmed-incomplete";
  } catch {
    return "not-confirmed-incomplete";
  }
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

// Idempotent: killing a session that's already gone is treated as success, not failure - a
// caller that already confirmed absence via getSessionPresence, or one recreating a session
// that vanished on its own between its own probe and this call, should not have to
// special-case "well, actually, it's fine" every time. Every existing caller already wraps
// this in a best-effort .catch() of its own for other operational failures, so this only
// narrows what counts as a failure at all - it does not change what callers do with one.
export async function killSession(sessionName: string): Promise<void> {
  try {
    await runTmux(["kill-session", "-t", sessionName]);
  } catch (error) {
    if (error instanceof TmuxError && !error.killed && DEFINITELY_NO_SUCH_SESSION_PATTERN.test(error.message)) {
      return;
    }
    throw error;
  }
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
