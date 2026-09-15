import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

// tmux says "there is no such session" in three different, equally definitive shapes, and
// which one you get depends on the tmux VERSION and on whether its server socket exists:
//
//   - "can't find session: <name>"                              server up, this session isn't
//   - "no server running on <path>"                             socket present, server dead
//   - "error connecting to <path> (No such file or directory)"  socket file itself is gone
//
// The third shape is what tmux 3.7+ prints when the socket does not exist (older tmux printed
// "no server running" for that case too - this is a version wording drift, not a bug in our
// logic). All three mean the same thing here: no session, and nothing a user could have work
// in.
//
// Matched as a WHOLE LINE against the LAST non-empty line of the error text, never as a
// substring, for two reasons this classifier was burned by:
//   1. The socket path is interpolated into the message BEFORE the errno string, and the path
//      can come from TMUX_TMPDIR (accident- or attacker-controlled). A substring match on
//      "no such file or directory" - or on "can't find session" / "no server running" - would
//      fire for a path that merely CONTAINS that text while the real errno is "(Permission
//      denied)", which must stay "unknown": "absent" is what authorizes creation and cleanup.
//   2. runTmux surfaces `stderr || execError.message`; with empty stderr, Node's own message
//      is a "Command failed: tmux ..." header line followed by the diagnostic on its own
//      line. Taking the last non-empty line skips the header. A bare `$` anchor on the whole
//      multi-line string would instead fail the match and silently send us back to the
//      deadlock this change exists to fix.
//
// Anything else - a permission error, a spawn failure ("spawn tmux ENOENT" is the BINARY
// missing, not the socket), a timeout - is deliberately NOT matched and stays "unknown".
const NO_SUCH_SESSION_LINE_PATTERNS: readonly RegExp[] = [
  /^can't find session\b.*$/i,
  /^no server running on .+$/i,
  /^error connecting to .+ \(no such file or directory\)$/i,
];

// Only the socket-missing shape: used to decide whether to emit the survived-directory
// warning below. The capture group is the socket path tmux was trying to reach.
const SOCKET_MISSING_LINE_PATTERN = /^error connecting to (.+) \(no such file or directory\)$/i;

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1];
}

function isDefinitivelyNoSuchSession(errorMessage: string): boolean {
  const line = lastNonEmptyLine(errorMessage);
  return line !== undefined && NO_SUCH_SESSION_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

// The socket file is gone but its PARENT directory still exists: something ran a tmux server
// here and the socket (or the server) was removed out from under us. tmux can outlive its
// socket and recreate it on SIGUSR1, so there is a slim chance a server with live sessions is
// still running and we are about to start a second one that shadows it. We still return
// "absent" (blocking on this would reintroduce the deadlock for every ordinary "server died"
// case, which is the common one), but we make noise so a puzzling empty session has a trail.
function warnIfSocketDirectorySurvived(socketPath: string): void {
  try {
    if (existsSync(dirname(socketPath))) {
      console.warn(
        `[server] tmux socket ${socketPath} is missing but its directory survives; treating ` +
          "the session as absent and recreating it. If a tmux server is somehow still running, " +
          "recover its sessions with `tmux kill-server` or a manual socket restore before continuing."
      );
    }
  } catch {
    // A stat failure here must never be what stops us classifying presence.
  }
}

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
    // A timeout (killed: true) is NOT proof the session is gone even though it also exits
    // non-zero - it stays "unknown" so the caller retries rather than risking a destructive
    // decision on a stalled tmux.
    if (!(error instanceof TmuxError) || error.killed || !isDefinitivelyNoSuchSession(error.message)) {
      return "unknown";
    }
    const line = lastNonEmptyLine(error.message);
    const socketMissing = line !== undefined ? SOCKET_MISSING_LINE_PATTERN.exec(line) : null;
    if (socketMissing !== null) {
      warnIfSocketDirectorySurvived(socketMissing[1]);
    }
    return "absent";
  }
}

// Set only via an explicit value, never via mere presence/absence of the option: relying on
// "does this custom option exist at all" is ambiguous across tmux versions for options that
// were simply never set (see this file's own comment on tmux 3.7's "=" prefix behavior for
// precedent on that kind of cross-version fragility), and a legacy session created before this
// marker existed must read the exact same way as one where the read itself merely failed -
// both must default to "preserve, do not destroy" (see isSessionInitIncomplete below).
const SESSION_INIT_MARKER_OPTION = "@ccdash_init_incomplete";

// Three live values, plus two "preserve, never destroy" catch-alls:
//
//   "created"    - session exists, the provider launch has NOT been attempted yet. The ONLY
//                  state safe to destroy-and-recreate: no command was ever sent, so nothing a
//                  user could have work in.
//   "launching"  - the provider launch MAY have been applied. sendCommandToSession delivers
//                  the command text and Enter as two separate tmux calls, and a timeout kills
//                  the tmux CLIENT without undoing what the SERVER already ran - so the agent
//                  may be live. Never destroyed on marker basis.
//   "0"          - fully initialized.
//   "1"          - LEGACY, from before this three-state protocol. A "1" session could be
//                  sitting in the post-launch state with a running agent, so the first attach
//                  after this upgrade must not be what kills it: treated as "0" (preserve).
//   absent / unreadable - legacy session with no marker, or a failed read. Preserve.
const MARKER_CREATED = "created";
const MARKER_LAUNCHING = "launching";
const MARKER_COMPLETE = "0";

export async function createSession(sessionName: string, workingDirectory: string): Promise<void> {
  // The marker is set in the SAME tmux invocation that creates the session (chained with a
  // bare ";"), closing the window where the session could exist with no marker at all - which
  // would otherwise misread as "legacy, preserve" for a session this process itself just
  // created and hasn't finished initializing.
  //
  // Bare ";": runTmux calls execFile directly, with no shell involved, so there is no shell
  // to escape the ";" FROM in the first place. new-session treats any trailing, un-chained
  // argument as its own optional shell-command, so a literal "\;" token here doesn't separate
  // two commands - it gets absorbed as the start of that shell-command, which fails instantly
  // and kills the session with exit code 0 and no stderr, silently.
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
    MARKER_CREATED,
  ]);
  // The tmux status bar is redundant inside the dashboard's embedded terminal
  await runTmux(["set-option", "-t", sessionName, "status", "off"]);
  await disableTmuxMouseAndAltScreen(sessionName);
}

// Moves the marker to "launching" - called right BEFORE sendCommandToSession, so that if the
// launch command is applied by the tmux server but then times out on the client, the marker
// already records "a launch may have happened, do not destroy". Not used for shell-only
// instances (they never launch a provider and go straight from "created" to complete).
export async function markSessionLaunching(sessionName: string): Promise<void> {
  await runTmux(["set-option", "-t", sessionName, SESSION_INIT_MARKER_OPTION, MARKER_LAUNCHING]);
}

// Called once initialization (createSession, and the provider launch for a non-shell-only
// instance) has fully completed - the ONLY thing that sets the marker to "0". Its reading "0"
// is therefore positive proof the session went through a complete init.
export async function markSessionInitComplete(sessionName: string): Promise<void> {
  await runTmux(["set-option", "-t", sessionName, SESSION_INIT_MARKER_OPTION, MARKER_COMPLETE]);
}

export type SessionInitState = "confirmed-incomplete" | "confirmed-launching" | "not-confirmed-incomplete";

// Only "created" authorizes destroy-and-recreate. "launching" is reported separately so the
// caller can preserve it. EVERYTHING else - "0", the legacy "1" (which could be a live
// post-launch session), the option never having been set, or the read itself throwing (a
// timeout, a wedged tmux server) - collapses into "not-confirmed-incomplete". That collapsing
// is deliberate: the invariant this whole mechanism exists to protect is that destroying a
// session must require POSITIVE proof it was left mid-init BEFORE any launch, never the mere
// absence of proof it's ready. Getting this wrong the other way (destroying on ambiguity) is
// what nearly shipped here twice before - see the terminal.ts callers for the full history.
export async function isSessionInitIncomplete(sessionName: string): Promise<SessionInitState> {
  try {
    const value = (await runTmux(["show-options", "-t", sessionName, "-v", SESSION_INIT_MARKER_OPTION])).trim();
    if (value === MARKER_CREATED) {
      return "confirmed-incomplete";
    }
    if (value === MARKER_LAUNCHING) {
      return "confirmed-launching";
    }
    return "not-confirmed-incomplete";
  } catch {
    return "not-confirmed-incomplete";
  }
}

// Native local scroll (xterm.js's own scrollback) needs two tmux defaults reversed:
// - mouse off: with mouse mode on, tmux claims the wheel/touch gesture and encodes it as a
//   report instead of letting it reach the outer client's own scroll; the client's own touch
//   handling still forwards real wheel events to whatever app inside the pane asks for its own
//   mouse tracking (tmux keeps honoring that regardless of this server-wide setting).
// - terminal-overrides smcup@/rmcup@: without this tmux switches the outer client into its
//   alternate screen on attach, which xterm.js never adds to its normal-buffer scrollback
//   (see BufferService.scroll), so the local history would always be empty.
// - terminal-overrides indn@: xterm-256color advertises indn (ESC[nS, multi-line scroll-up);
//   tmux uses it to move several lines at once, but xterm.js 5.5 implements that sequence by
//   discarding the scrolled-off lines instead of appending them to scrollback (see its own
//   InputHandler.scrollUp). Disabling it makes tmux fall back to plain linefeeds, which xterm
//   does push to scrollback, at the cost of one linefeed per line instead of one escape per
//   burst - acceptable since this is local, not over the wire.
// terminal-overrides is set with -s (server-wide, no -t): safe here because this tmux server's
// socket is exclusive to the dashboard (see with-writable-tmpdir.mjs), nothing else shares it.
// Idempotent, so it also migrates sessions that were already alive before this change.
export async function disableTmuxMouseAndAltScreen(sessionName: string): Promise<void> {
  await runTmux(["set-option", "-t", sessionName, "mouse", "off"]);
  await runTmux(["set-option", "-s", "terminal-overrides", "xterm-256color:smcup@:rmcup@:indn@"]);
}

export async function sendCommandToSession(sessionName: string, command: string): Promise<void> {
  // "-l" sends the text literally (without interpreting key names); Enter is sent separately
  await runTmux(["send-keys", "-t", sessionName, "-l", command]);
  await runTmux(["send-keys", "-t", sessionName, "Enter"]);
}

// Hands a value to the session through tmux's own environment instead of typing it into the
// pane - used to smuggle the real (long, flag-heavy) launch command past the interactive shell
// so the pane only ever displays a short "source <loader>" line. Goes through execFile with no
// shell involved (see runTmux), so there is no quoting to worry about here.
export async function setSessionEnvironment(sessionName: string, name: string, value: string): Promise<void> {
  await runTmux(["set-environment", "-t", sessionName, name, value]);
}

// tmux "wait-for" channels are a named, server-side semaphore: "-S" signals a channel (never
// blocks), a bare "wait-for <channel>" blocks until signaled - or returns immediately if the
// channel was already signaled first, so callers on either side of this pair never race each
// other regardless of which one runs first. Used to let the pane's own shell (instance-
// loader.sh) tell the server "the real command now has control of the terminal" without
// printing anything visible or exposing raw bytes to a second attached client - see
// agentReadiness.ts for how the server turns this into the dashboard's HTML loading overlay.
//
// Resolves to false on timeout or any tmux error rather than throwing: an unconfirmed signal
// is not a failure the caller needs to react to specially, just a "give up waiting" result -
// see AGENT_READY_WAIT_TIMEOUT_MS in terminal.ts.
export async function waitForChannelSignal(channelName: string, timeoutMs: number): Promise<boolean> {
  try {
    await runTmux(["wait-for", channelName], timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export async function signalChannel(channelName: string): Promise<void> {
  await runTmux(["wait-for", "-S", channelName]);
}

// tmux's "new-session -s NAME" for a NAME that already exists fails with exactly
// "duplicate session: NAME". A caller's create attempt hitting this is positive proof the
// session was NOT created by that attempt - so its rollback path must NOT kill it (it belongs
// to whoever created it first, possibly with a live agent in it). Kept here, next to the
// other tmux stderr classifiers, so callers never match raw strings themselves.
export function isDuplicateSessionError(error: unknown): boolean {
  return error instanceof TmuxError && /^duplicate session:/i.test(error.message.trim());
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
    if (error instanceof TmuxError && !error.killed && isDefinitivelyNoSuchSession(error.message)) {
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

// TMUX_TMPDIRs the dashboard pinned before the current one (see resolveTmuxTmpdir in
// scripts/with-writable-tmpdir.mjs). Anything ccdash-* still alive there is unreachable from
// this server yet keeps its agent running, and the CLI's own name-collision check (which
// validates the PID is genuinely alive) counts it as a live duplicate.
const HISTORICAL_TMUX_TMPDIRS: readonly string[] = ["/tmp", join(homedir(), ".cache", "ai-multi-instance", "tmux")];

const DASHBOARD_SESSION_NAME_PATTERN = /^ccdash-/;

// Best-effort resolution: a legacy dir that doesn't exist yet must not make a real legacy dir
// further down the list get skipped, so a raw string (not the resolved path) is the fallback
// rather than throwing or dropping the entry.
function resolveDirectoryPath(directoryPath: string): string {
  try {
    return realpathSync(directoryPath);
  } catch {
    return directoryPath;
  }
}

// Kills every ccdash-* session found on each given legacy TMUX_TMPDIR, skipping whichever one
// resolves to the CURRENT TMUX_TMPDIR (that socket is live, not legacy) and de-duplicating by
// resolved path. Never touches a session outside the ccdash- prefix and never runs kill-server:
// /tmp is the user's own default tmux socket and can hold sessions of theirs unrelated to this
// dashboard. Returns "<socketPath>:<sessionName>" for everything it killed.
export async function killOrphanedDashboardSessions(legacyTmuxTmpdirs: readonly string[]): Promise<string[]> {
  const currentTmuxTmpdir = resolveDirectoryPath(process.env.TMUX_TMPDIR ?? "/tmp");
  const seenDirectories = new Set<string>();
  const killed: string[] = [];

  for (const rawLegacyDirectory of legacyTmuxTmpdirs) {
    const resolvedLegacyDirectory = resolveDirectoryPath(rawLegacyDirectory);
    if (resolvedLegacyDirectory === currentTmuxTmpdir || seenDirectories.has(resolvedLegacyDirectory)) {
      continue;
    }
    seenDirectories.add(resolvedLegacyDirectory);

    const socketPath = join(rawLegacyDirectory, `tmux-${process.getuid?.() ?? "0"}`, "default");
    if (!existsSync(socketPath)) {
      continue;
    }

    let sessionNames: string[];
    try {
      const output = await runTmux(["-S", socketPath, "list-sessions", "-F", "#{session_name}"]);
      sessionNames = output.split("\n").filter((line) => line.length > 0);
    } catch {
      // No server on this socket, or it's wedged - nothing this sweep can safely do about it.
      continue;
    }

    for (const sessionName of sessionNames.filter((name) => DASHBOARD_SESSION_NAME_PATTERN.test(name))) {
      try {
        await runTmux(["-S", socketPath, "kill-session", "-t", sessionName]);
        killed.push(`${socketPath}:${sessionName}`);
      } catch (error) {
        console.warn(
          `[server] failed to kill orphaned dashboard session ${sessionName} on ${socketPath}:`,
          (error as Error).message
        );
      }
    }
  }

  return killed;
}

// Sweeps every TMUX_TMPDIR this dashboard is known to have used before the current one - the
// hardcoded historical paths plus whatever the previous start recorded - so an explicit
// TMUX_TMPDIR change (not just an upgrade to a new hardcoded default) also gets reconciled.
// Records the current TMUX_TMPDIR for the next start to read back.
export async function reconcileLegacyTmuxSockets(recordPath: string): Promise<string[]> {
  let previouslyRecordedTmuxTmpdir = "";
  try {
    previouslyRecordedTmuxTmpdir = readFileSync(recordPath, "utf8").trim();
  } catch {
    // No record yet - first start, or the file was never written. Fine either way.
  }

  const legacyTmuxTmpdirs = [...HISTORICAL_TMUX_TMPDIRS, previouslyRecordedTmuxTmpdir].filter(
    (value) => value.length > 0
  );
  const killed = await killOrphanedDashboardSessions(legacyTmuxTmpdirs);

  try {
    writeFileSync(recordPath, process.env.TMUX_TMPDIR ?? "/tmp", "utf8");
  } catch (error) {
    console.warn(`[server] failed to record TMUX_TMPDIR at ${recordPath}:`, (error as Error).message);
  }

  return killed;
}
