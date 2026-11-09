import path from "node:path";
import { quoteForShell } from "./providers";

// Pure helpers for restarting a Claude session: nothing here does I/O, and nothing returns
// raw screen text or the command line, which can carry the settings JSON and env values.

export type ScreenMode = "default" | "accept-edits" | "plan" | "bypass" | "auto" | "unknown";

const SESSION_ID_PATTERN = /^(?!-)[\w-]{8,}$/;
const INTERPRETERS = new Set(["bash", "sh", "zsh", "node"]);
const VALUE_FLAGS = new Set(["--model", "--effort", "--settings", "--permission-mode", "--add-dir", "--mcp-config"]);
const NAME_FLAGS = new Set(["-n", "--name"]);
const RESUME_VALUE_FLAGS = new Set(["--resume", "-r", "--session-id"]);
const RESUME_EQUALS_PREFIXES = ["--resume=", "--session-id="];
const RESUME_BARE_FLAGS = new Set(["--continue", "-c"]);
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const RULE_PATTERN = /^\s*─{10,}\s*$/;
const BUSY_LINES_ABOVE_BOX = 3;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

// The launcher is the first token, or the one after an interpreter (bash <script>, node <script>).
export function launcherToken(tokens: string[]): string | undefined {
  return INTERPRETERS.has(path.basename(tokens[0] ?? "")) ? tokens[1] : tokens[0];
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

// Joins the space-split pieces of a JSON value back together, ignoring braces inside strings.
function joinBalanced(pieces: string[], startIndex: number): { value: string; nextIndex: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let value = "";
  for (let index = startIndex; index < pieces.length; index += 1) {
    value = index === startIndex ? pieces[index] : `${value} ${pieces[index]}`;
    const scanned = index === startIndex ? pieces[index] : ` ${pieces[index]}`;
    for (const character of scanned) {
      if (escaped) escaped = false;
      else if (inString && character === "\\") escaped = true;
      else if (character === '"') inString = !inString;
      else if (!inString && (character === "{" || character === "[")) depth += 1;
      else if (!inString && (character === "}" || character === "]")) depth -= 1;
    }
    if (depth === 0 && !inString) return { value, nextIndex: index + 1 };
  }
  return null;
}

/**
 * Rebuilds argv from what `ps` prints (no quoting survives). Returns null instead of guessing
 * whenever the line is ambiguous, so an initial prompt is never replayed as a new turn.
 */
export function tokenizeCommandLine(flat: string, knownLabel?: string): string[] | null {
  if (/\s{2,}|[\t\n]/.test(flat) || flat !== flat.trim()) return null;
  const pieces = flat.split(" ");
  const tokens: string[] = [];
  let index = 0;

  const head: string[] = [];
  while (index < pieces.length && !isFlag(pieces[index])) {
    head.push(pieces[index]);
    index += 1;
  }
  const launcherIsValid =
    (head.length === 1 || (head.length === 2 && INTERPRETERS.has(path.basename(head[0])))) && /^claude[\w.-]*$|^cli\.js$/.test(path.basename(head[head.length - 1]));
  if (!launcherIsValid) return null;
  tokens.push(...head);

  while (index < pieces.length) {
    const flag = pieces[index];
    if (!isFlag(flag)) return null;
    tokens.push(flag);
    index += 1;
    const next = pieces[index];
    if (VALUE_FLAGS.has(flag)) {
      if (next === undefined || isFlag(next)) return null;
      if (next.startsWith("{") || next.startsWith("[")) {
        const joined = joinBalanced(pieces, index);
        if (!joined) return null;
        tokens.push(joined.value);
        index = joined.nextIndex;
      } else {
        tokens.push(next);
        index += 1;
      }
    } else if (NAME_FLAGS.has(flag)) {
      const words: string[] = [];
      while (index < pieces.length && !isFlag(pieces[index])) {
        words.push(pieces[index]);
        index += 1;
      }
      const name = words.join(" ");
      if (words.length === 0 || (words.length > 1 && name !== knownLabel)) return null;
      tokens.push(name);
    } else if (RESUME_VALUE_FLAGS.has(flag)) {
      if (next !== undefined && !isFlag(next)) {
        if (!SESSION_ID_PATTERN.test(next)) return null;
        tokens.push(next);
        index += 1;
      }
    } else {
      const prefix = RESUME_EQUALS_PREFIXES.find((candidate) => flag.startsWith(candidate));
      if (prefix && !SESSION_ID_PATTERN.test(flag.slice(prefix.length))) return null;
    }
  }
  return tokens.join(" ") === flat ? tokens : null;
}

export function stripResumeFlags(tokens: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (RESUME_BARE_FLAGS.has(token) || RESUME_EQUALS_PREFIXES.some((prefix) => token.startsWith(prefix))) continue;
    if (RESUME_VALUE_FLAGS.has(token)) {
      if (index + 1 < tokens.length && SESSION_ID_PATTERN.test(tokens[index + 1])) index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept;
}

export function buildRestartCommand(options: {
  instanceId: string;
  includeInstanceId: boolean;
  configDir: string | undefined;
  tokens: string[];
  sessionId: string;
}): string {
  if (!SESSION_ID_PATTERN.test(options.sessionId)) throw new Error("Invalid session id");
  const parts: string[] = [];
  if (options.includeInstanceId) parts.push(`AI_MULTI_INSTANCE_ID=${quoteForShell(options.instanceId)}`);
  if (options.configDir) parts.push(`CLAUDE_CONFIG_DIR=${quoteForShell(options.configDir)}`);
  parts.push(...options.tokens.map(quoteForShell), "--resume", quoteForShell(options.sessionId));
  return parts.join(" ");
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// Only text after the last /exit counts, so a hint from an earlier exit is never reused.
export function parseResumeHint(joinedPaneText: string): { sessionId: string; command: string | null } | null {
  const text = stripAnsi(joinedPaneText);
  const markerIndex = text.lastIndexOf("/exit");
  if (markerIndex === -1) return null;
  for (const line of text.slice(markerIndex).split("\n")) {
    const match = /^\s*(.*?)\s*--resume\s+(\S+)\s*$/.exec(line);
    if (match && SESSION_ID_PATTERN.test(match[2])) return { sessionId: match[2], command: match[1] || null };
  }
  return null;
}

interface ScreenWindow {
  lines: string[];
  topBorder: number;
  bottomBorder: number;
}

// Anchored on the last input box so conversation text above it never matches.
function screenWindow(paneText: string): ScreenWindow | null {
  const lines = paneText.split("\n");
  const borders: number[] = [];
  lines.forEach((line, lineIndex) => {
    if (RULE_PATTERN.test(line)) borders.push(lineIndex);
  });
  if (borders.length < 2) return null;
  return { lines, topBorder: borders[borders.length - 2], bottomBorder: borders[borders.length - 1] };
}

export function isPromptEmpty(paneText: string): boolean {
  const window = screenWindow(paneText);
  if (!window) return false;
  const inputLines = window.lines.slice(window.topBorder + 1, window.bottomBorder);
  return inputLines.length > 0 && /^\s*[❯>]\s*$/.test(inputLines[0]);
}

export function currentMode(paneText: string): ScreenMode {
  const window = screenWindow(paneText);
  if (!window) return "unknown";
  const footer = window.lines.slice(window.bottomBorder + 1).join("\n");
  if (/auto mode on/i.test(footer)) return "auto";
  if (/accept edits on/i.test(footer)) return "accept-edits";
  if (/plan mode on/i.test(footer)) return "plan";
  if (/bypass permissions on/i.test(footer)) return "bypass";
  if (/\? for shortcuts/i.test(footer)) return "default";
  return "unknown";
}

export function isAutoModeOn(paneText: string): boolean {
  return currentMode(paneText) === "auto";
}

// Claude draws its spinner and interrupt hint just above the input box.
export function looksBusy(paneText: string): boolean {
  const window = screenWindow(paneText);
  if (!window) return false;
  const nearBox = window.lines.slice(Math.max(0, window.topBorder - BUSY_LINES_ABOVE_BOX));
  return nearBox.some((line) => /esc to interrupt/i.test(line));
}

export function versionFromPath(args: string): string | null {
  return /\/versions\/(\d+\.\d+\.\d+)/.exec(args)?.[1] ?? null;
}

// Tmux, ps and shell errors can echo argv (settings JSON, env values), so none is forwarded.
export function sanitizeError(_error: unknown): string {
  return "The restart step failed; details are withheld because they can contain the launch command.";
}
