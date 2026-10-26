import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { currentBranch } from "./git";
import type { AgentFound } from "./paneAgent";
import type { Snapshot } from "./liveStatus";

const execFileAsync = promisify(execFile);

// What the sidebar shows when the agent running in the pane never reported to the dashboard (it
// was started around the shim, e.g. by absolute path): read it from the agent's own files
// instead. Less data than a statusline snapshot (no cost, no rate limits), but never wrong.

export async function findCodexSessionFile(sessionId: string): Promise<string | undefined> {
  const sessionsRoot: string = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  try {
    const entries = await fs.readdir(sessionsRoot, { recursive: true });
    const relativePath: string | undefined = entries.find(
      (entry) => typeof entry === "string" && entry.endsWith(`${sessionId}.jsonl`)
    );
    return relativePath === undefined ? undefined : path.join(sessionsRoot, relativePath);
  } catch {
    return undefined;
  }
}

export async function enrichCodexStatus(snapshot: Snapshot): Promise<Snapshot> {
  if (typeof snapshot.sessionFile !== "string") return snapshot;
  try {
    const content: string = await fs.readFile(snapshot.sessionFile, "utf8");
    // The rollout's own mtime is the last time this session did anything, which is what the
    // sidebar's "stale" check needs; stamping "now" here made every Codex session look fresh.
    const modifiedAt: Date = (await fs.stat(snapshot.sessionFile)).mtime;
    let model: string | undefined;
    let effort: string | undefined;
    let tokenInfo: Record<string, unknown> | null = null;
    let rateLimits: Record<string, unknown> | null = null;
    for (const line of content.trim().split("\n")) {
      const event = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      if (event.type === "turn_context") {
        if (typeof event.payload?.model === "string") model = event.payload.model;
        const collaboration = event.payload?.collaboration_mode as { settings?: { reasoning_effort?: string } } | undefined;
        if (typeof collaboration?.settings?.reasoning_effort === "string") effort = collaboration.settings.reasoning_effort;
      }
      if (event.type === "event_msg" && event.payload?.type === "token_count") {
        tokenInfo = (event.payload.info as Record<string, unknown> | null) ?? null;
        rateLimits = (event.payload.rate_limits as Record<string, unknown> | null) ?? null;
      }
    }
    const totalUsage = tokenInfo?.total_token_usage as { total_tokens?: number } | undefined;
    const contextSize = tokenInfo?.model_context_window;
    const primary = rateLimits?.primary as { used_percent?: number; resets_at?: number } | undefined;
    const secondary = rateLimits?.secondary as { used_percent?: number; resets_at?: number } | undefined;
    const contextUsed: number | undefined = totalUsage?.total_tokens;
    return {
      ...snapshot,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(typeof contextUsed === "number" ? { contextUsed } : {}),
      ...(typeof contextSize === "number"
        ? {
            contextSize,
            contextPct: contextUsed === undefined ? 0 : (contextUsed / contextSize) * 100,
          }
        : {}),
      ...(typeof primary?.used_percent === "number" ? { fiveHourPct: primary.used_percent } : {}),
      ...(typeof primary?.resets_at === "number" ? { fiveHourResetsAt: primary.resets_at } : {}),
      ...(typeof secondary?.used_percent === "number" ? { sevenDayPct: secondary.used_percent } : {}),
      ...(typeof secondary?.resets_at === "number" ? { sevenDayResetsAt: secondary.resets_at } : {}),
      updatedAt: modifiedAt.toISOString(),
    };
  } catch {
    return snapshot;
  }
}

interface AgentEnvironment {
  configDir: string | null;
  cwd: string | null;
}

// Keyed by pid plus a coarse start time (startedAt is derived from etime and wobbles by a
// second between probes), so a reused pid never inherits a previous process's answer.
const environmentCache: Map<string, AgentEnvironment> = new Map();

function agentCacheKey(agent: AgentFound): string {
  return `${agent.agentPid}:${Math.round(agent.startedAtMs / 10_000)}`;
}

async function readAgentEnvironment(agent: AgentFound): Promise<AgentEnvironment> {
  const key: string = agentCacheKey(agent);
  const cached = environmentCache.get(key);
  if (cached !== undefined) return cached;
  let configDir: string | null = null;
  let cwd: string | null = null;
  try {
    // ps eww appends the process's environment to its command line, which is how the profile a
    // bash wrapper (claude-me, claude-in) exported ends up visible on the claude process.
    const { stdout } = await execFileAsync("ps", ["eww", "-o", "command=", "-p", String(agent.agentPid)], {
      timeout: 5_000,
    });
    const match = / CLAUDE_CONFIG_DIR=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|\s*$)/.exec(stdout);
    configDir = match === null ? null : match[1].replace(/\/+$/, "");
  } catch {
    // leave null: the caller falls back to the default profile
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-Fn", "-p", String(agent.agentPid)], {
      timeout: 5_000,
    });
    cwd = stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
  } catch {
    // leave null
  }
  const environment: AgentEnvironment = { configDir, cwd };
  // A probe that found nothing is not cached: the process may simply not have been readable yet.
  if (cwd !== null) environmentCache.set(key, environment);
  return environment;
}

// Claude names a project's transcript folder after the launch cwd with every character that is
// not alphanumeric replaced by "-" (so "AORUM Strategies" becomes "AORUM-Strategies").
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 50;

interface TranscriptPick {
  file: string;
  sessionId: string;
  mtimeMs: number;
}

const transcriptPickCache: Map<string, { dirMtimeMs: number; pick: TranscriptPick | null }> = new Map();

async function pickClaudeTranscript(
  projectDir: string,
  agent: AgentFound,
  ownedSessionIds: ReadonlySet<string>
): Promise<TranscriptPick | null> {
  const cacheKey: string = `${agentCacheKey(agent)}:${projectDir}`;
  const dirStat = await fs.stat(projectDir).catch(() => null);
  if (dirStat === null) return null;
  const cached = transcriptPickCache.get(cacheKey);
  // A new transcript file (a /clear, a fresh session) changes the folder's mtime; appending to
  // the current one does not, so the pick only needs redoing when the folder changed.
  if (cached !== undefined && cached.dirMtimeMs === dirStat.mtimeMs) return cached.pick;

  const names: string[] = (await fs.readdir(projectDir)).filter((name) => name.endsWith(".jsonl"));
  let best: TranscriptPick | null = null;
  for (const name of names) {
    const sessionId: string = name.slice(0, -".jsonl".length);
    if (ownedSessionIds.has(sessionId)) continue;
    const stats = await fs.stat(path.join(projectDir, name)).catch(() => null);
    if (stats === null || stats.mtimeMs < agent.startedAtMs - 2_000) continue;
    if (best === null || stats.mtimeMs > best.mtimeMs) {
      best = { file: path.join(projectDir, name), sessionId, mtimeMs: stats.mtimeMs };
    }
  }
  // `--resume <id>` before its first new turn: the named transcript predates this process.
  if (best === null && agent.resumeId !== null && !ownedSessionIds.has(agent.resumeId)) {
    const file: string = path.join(projectDir, `${agent.resumeId}.jsonl`);
    const stats = await fs.stat(file).catch(() => null);
    if (stats !== null) best = { file, sessionId: agent.resumeId, mtimeMs: stats.mtimeMs };
  }
  transcriptPickCache.set(cacheKey, { dirMtimeMs: dirStat.mtimeMs, pick: best });
  return best;
}

interface TranscriptFacts {
  model?: string;
  contextUsed?: number;
}

const transcriptFactsCache: Map<string, TranscriptFacts> = new Map();

async function readTranscriptTail(pick: TranscriptPick): Promise<TranscriptFacts> {
  const stats = await fs.stat(pick.file);
  const cacheKey: string = `${pick.file}:${stats.mtimeMs}:${stats.size}`;
  const cached = transcriptFactsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const handle = await fs.open(pick.file, "r");
  let text: string;
  try {
    const length: number = Math.min(stats.size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    text = buffer.toString("utf8");
  } finally {
    await handle.close();
  }
  const facts: TranscriptFacts = {};
  const lines: string[] = text.split("\n");
  // The first line of a tail read is usually cut mid-record.
  for (const line of lines.slice(stats.size > TRANSCRIPT_TAIL_BYTES ? 1 : 0).reverse()) {
    if (!line.includes('"type":"assistant"')) continue;
    try {
      const entry = JSON.parse(line) as {
        isSidechain?: boolean;
        message?: { model?: string; usage?: Record<string, number> };
      };
      // A subagent's turns live in the same file with their own model and a much smaller context.
      if (entry.isSidechain === true) continue;
      const usage = entry.message?.usage;
      if (usage === undefined || typeof usage.input_tokens !== "number") continue;
      facts.model = entry.message?.model;
      facts.contextUsed =
        usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      break;
    } catch {
      // a partial or non-JSON line: keep looking further back
    }
  }
  if (transcriptFactsCache.size >= MAX_CACHE_ENTRIES) transcriptFactsCache.clear();
  transcriptFactsCache.set(cacheKey, facts);
  return facts;
}

// The statusline shows "Sonnet 5.5" where a transcript records "claude-sonnet-5-5": render the
// same name so a session does not change how it reads depending on where the data came from.
export function displayModelName(modelId: string): string {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/.exec(modelId);
  return match === null ? modelId : `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}`;
}

export async function claudeFallback(agent: AgentFound, ownedSessionIds: ReadonlySet<string>): Promise<Snapshot | null> {
  const { configDir: detectedConfigDir, cwd } = await readAgentEnvironment(agent);
  if (cwd === null) return null;
  const configDir: string = detectedConfigDir ?? path.join(os.homedir(), ".claude");
  const pick = await pickClaudeTranscript(
    path.join(configDir, "projects", claudeProjectDirName(cwd)),
    agent,
    ownedSessionIds
  );
  if (pick === null) return null;
  const facts: TranscriptFacts = await readTranscriptTail(pick).catch(() => ({}));
  const branch: string | null = await currentBranch(cwd).catch(() => null);
  return {
    provider: "claude",
    sessionId: pick.sessionId,
    cwd,
    configDir,
    ...(facts.model !== undefined ? { model: displayModelName(facts.model) } : {}),
    // No contextSize: the transcript does not say which window the session runs with, and a
    // guessed one would put a wrong percentage in the sidebar.
    ...(facts.contextUsed !== undefined ? { contextUsed: facts.contextUsed } : {}),
    ...(branch !== null ? { branch } : {}),
    updatedAt: new Date(pick.mtimeMs).toISOString(),
  };
}

async function readCodexMeta(filePath: string): Promise<{ id?: string; cwd?: string } | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const event = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]) as {
      type?: string;
      payload?: { id?: string; cwd?: string };
    };
    return event.type === "session_meta" ? (event.payload ?? null) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

// Codex keeps rollouts under sessions/YYYY/MM/DD, so only the days since the process started
// need scanning instead of the whole history.
async function codexRolloutDays(startedAtMs: number, nowMs: number): Promise<string[]> {
  const sessionsRoot: string = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  const days: string[] = [];
  for (let dayMs = new Date(startedAtMs).setHours(0, 0, 0, 0); dayMs <= nowMs; dayMs += 86_400_000) {
    const day = new Date(dayMs);
    days.push(
      path.join(
        sessionsRoot,
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, "0"),
        String(day.getDate()).padStart(2, "0")
      )
    );
  }
  return days;
}

export async function codexFallback(
  agent: AgentFound,
  ownedSessionIds: ReadonlySet<string>,
  nowMs: number = Date.now()
): Promise<Snapshot | null> {
  let chosen: { file: string; id: string; cwd: string } | null = null;
  if (agent.resumeId !== null && !ownedSessionIds.has(agent.resumeId)) {
    const file: string | undefined = await findCodexSessionFile(agent.resumeId);
    const meta = file === undefined ? null : await readCodexMeta(file);
    if (file !== undefined && meta?.id !== undefined) chosen = { file, id: meta.id, cwd: meta.cwd ?? "" };
  }
  if (chosen === null) {
    const { cwd } = await readAgentEnvironment(agent);
    if (cwd === null) return null;
    let bestMtimeMs = -1;
    for (const dayDir of await codexRolloutDays(agent.startedAtMs, nowMs)) {
      const names: string[] = await fs.readdir(dayDir).catch(() => []);
      for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
        const file: string = path.join(dayDir, name);
        const stats = await fs.stat(file).catch(() => null);
        if (stats === null || stats.mtimeMs < agent.startedAtMs - 2_000 || stats.mtimeMs <= bestMtimeMs) continue;
        const meta = await readCodexMeta(file);
        if (meta?.cwd !== cwd || typeof meta.id !== "string" || ownedSessionIds.has(meta.id)) continue;
        bestMtimeMs = stats.mtimeMs;
        chosen = { file, id: meta.id, cwd };
      }
    }
  }
  if (chosen === null) return null;
  return enrichCodexStatus({
    provider: "codex",
    sessionId: chosen.id,
    sessionFile: chosen.file,
    cwd: chosen.cwd,
    updatedAt: new Date().toISOString(),
  });
}
