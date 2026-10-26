import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getOriginalPanePid } from "./tmux";
import type { AgentProvider } from "./types";

const execFileAsync = promisify(execFile);

export type AgentFound = Extract<PaneAgent, { kind: "agent" }>;

export type DetectableProvider = Exclude<AgentProvider, "custom">;

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  elapsedSeconds: number;
  args: string;
}

// Three-way on purpose, same reasoning as getSessionPresence in tmux.ts: "no agent" is a
// positive claim that makes the sidebar say so, so a failed probe must read as "unknown"
// (callers keep serving the snapshot) and never collapse into "none".
export type PaneAgent =
  | {
      kind: "agent";
      provider: DetectableProvider;
      paneJobPid: number;
      agentPid: number;
      startedAtMs: number;
      resumeId: string | null;
    }
  | { kind: "none" }
  | { kind: "unknown" };

// "[[dd-]hh:]mm:ss", the only format ps -o etime= prints. Used instead of lstart= because
// lstart prints day and month names in the server's locale.
export function parseElapsedSeconds(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

export function parsePsOutput(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const elapsedSeconds: number | null = parseElapsedSeconds(match[5]);
    if (elapsedSeconds === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      elapsedSeconds,
      args: match[6],
    });
  }
  return rows;
}

// An npm-installed CLI runs as "node <script>", cursor-agent as "bash <script>", and
// claude-me/claude-in as a bash wrapper: the process name alone says nothing, so the script
// (or the executable itself when it is not an interpreter) is what gets matched.
const INTERPRETERS: ReadonlySet<string> = new Set(["node", "bash", "sh", "zsh"]);

export function detectProvider(args: string): DetectableProvider | null {
  const tokens: string[] = args.trim().split(/\s+/);
  const executable: string = tokens[0] ?? "";
  const target: string = INTERPRETERS.has(path.basename(executable))
    ? (tokens.slice(1).find((token) => !token.startsWith("-")) ?? "")
    : executable;
  const baseName: string = path.basename(target).replace(/\.(?:m?js|cjs|sh)$/, "");
  if (baseName === "claude" || target.includes("/@anthropic-ai/claude-code/")) return "claude";
  // The npm wrapper starts the real binary as a child named codex-<platform-triple>.
  if (/^codex(?:-|$)/.test(baseName) || target.includes("/@openai/codex/")) return "codex";
  if (baseName === "cursor-agent" || target.includes("/cursor-agent/") || target.endsWith("/.local/bin/agent")) {
    return "cursor";
  }
  return null;
}

const RESUME_ID_PATTERN = /^[\w-]{8,}$/;

export function extractResumeId(args: string): string | null {
  const tokens: string[] = args.trim().split(/\s+/);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token: string = tokens[index];
    if (token === "--resume" || token === "-r" || token === "resume" || token === "--session-id") {
      const candidate: string = tokens[index + 1];
      if (RESUME_ID_PATTERN.test(candidate)) return candidate;
    }
  }
  return null;
}

// Same rule the writers use (see server/scripts/lib/pane-identity.sh): the foreground job of
// the pane is the pane shell itself when it owns the terminal's foreground group (idle prompt,
// or `exec claude`), otherwise its child in that group. Background children of the shell
// (`cmd &`, prompt helpers) have their own process group and are excluded.
export function classifyPane(rows: ProcessRow[], panePid: number, nowMs: number): PaneAgent {
  const paneRow: ProcessRow | undefined = rows.find((row) => row.pid === panePid);
  if (paneRow === undefined || paneRow.tpgid <= 0) return { kind: "unknown" };
  const foregroundGroup: number = paneRow.tpgid;

  const paneJobRow: ProcessRow | undefined =
    paneRow.pgid === foregroundGroup
      ? paneRow
      : rows.find((row) => row.ppid === panePid && row.pgid === foregroundGroup);
  if (paneJobRow === undefined) return { kind: "none" };

  // Breadth-first so a wrapper (claude-me -> claude) resolves to the shallowest match, and the
  // pid reported as the agent is the process whose env and cwd actually describe the session.
  const queue: ProcessRow[] = [paneJobRow];
  const visited: Set<number> = new Set([paneJobRow.pid]);
  for (let head = 0; head < queue.length; head += 1) {
    const current: ProcessRow = queue[head];
    const provider: DetectableProvider | null = detectProvider(current.args);
    if (provider !== null) {
      return {
        kind: "agent",
        provider,
        paneJobPid: paneJobRow.pid,
        agentPid: current.pid,
        startedAtMs: nowMs - current.elapsedSeconds * 1000,
        resumeId: extractResumeId(current.args),
      };
    }
    for (const child of rows) {
      if (child.ppid === current.pid && child.pgid === foregroundGroup && !visited.has(child.pid)) {
        visited.add(child.pid);
        queue.push(child);
      }
    }
  }
  return { kind: "none" };
}

// -ww: piped macOS ps truncates every line to ~79 columns, which cuts the script name off an
// npm-installed agent's command line. LC_ALL=C keeps the numeric columns locale-independent.
export const PS_ARGUMENTS: readonly string[] = ["-A", "-ww", "-o", "pid=,ppid=,pgid=,tpgid=,etime=,args="];

const PROBE_TIMEOUT_MS = 5_000;
// live-status is polled at 1 Hz per open sidebar, and each probe is a tmux call plus a full
// process listing: a short cache keeps several tabs on the same instance from multiplying that.
const CACHE_TTL_MS = 1_500;
const cache: Map<string, { at: number; result: PaneAgent }> = new Map();

export async function findPaneAgent(tmuxSession: string, nowMs: number = Date.now()): Promise<PaneAgent> {
  const cached = cache.get(tmuxSession);
  if (cached !== undefined && nowMs - cached.at < CACHE_TTL_MS) return cached.result;
  let result: PaneAgent;
  try {
    const panePid: number = await getOriginalPanePid(tmuxSession);
    const { stdout } = await execFileAsync("ps", [...PS_ARGUMENTS], {
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024,
    });
    result = classifyPane(parsePsOutput(stdout), panePid, nowMs);
  } catch {
    result = { kind: "unknown" };
  }
  cache.set(tmuxSession, { at: nowMs, result });
  return result;
}
