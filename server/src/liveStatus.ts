import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaneAgent, AgentFound } from "./paneAgent";
import type { InstanceRecord } from "./types";

export type Snapshot = Record<string, unknown>;

export function snapshotDirectory(): string {
  // ~/Library/Application Support, not ~/.cache - see with-writable-tmpdir.mjs's
  // resolveTmuxTmpdir comment: a folder literally named "cache" anywhere under $HOME is a
  // target for third-party junk cleaners (CleanMyMac and similar), which have deleted files
  // out from under this app before. Application Support is the macOS convention these tools
  // are built to leave alone.
  return path.join(os.homedir(), "Library", "Application Support", "ai-multi-instance");
}

export interface SiblingSnapshot {
  instanceId: string;
  snapshot: Snapshot;
}

const SNAPSHOT_FILE_PATTERN = /^([0-9a-f]{8})\.json$/;
const SIBLINGS_TTL_MS = 5_000;
let siblingsCache: { at: number; siblings: SiblingSnapshot[] } | null = null;

// Every instance's snapshot, re-read at most every few seconds: the rate limits of an account
// are shared by all its instances, and live-status is polled at 1 Hz per open sidebar.
export async function listSiblingSnapshots(nowMs: number = Date.now()): Promise<SiblingSnapshot[]> {
  if (siblingsCache !== null && nowMs - siblingsCache.at < SIBLINGS_TTL_MS) return siblingsCache.siblings;
  const siblings: SiblingSnapshot[] = [];
  const directory: string = snapshotDirectory();
  const names: string[] = await fs.readdir(directory).catch(() => []);
  for (const name of names) {
    const match = SNAPSHOT_FILE_PATTERN.exec(name);
    if (match === null) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        siblings.push({ instanceId: match[1], snapshot: parsed as Snapshot });
      }
    } catch {
      // a snapshot being rewritten right now, or a corrupt one: it simply does not count
    }
  }
  siblingsCache = { at: nowMs, siblings };
  return siblings;
}

const RECENT_SESSION_WINDOW_MS = 15 * 60_000;

// Sessions other instances are reporting right now: a transcript or rollout carrying one of
// these ids is theirs, not the agent being looked up.
export function ownedSessionIds(siblings: SiblingSnapshot[], instanceId: string, nowMs: number): Set<string> {
  const owned: Set<string> = new Set();
  for (const sibling of siblings) {
    if (sibling.instanceId === instanceId) continue;
    const sessionId: unknown = sibling.snapshot.sessionId;
    const updatedAtMs: number = Date.parse(String(sibling.snapshot.updatedAt));
    if (typeof sessionId === "string" && nowMs - updatedAtMs < RECENT_SESSION_WINDOW_MS) owned.add(sessionId);
  }
  return owned;
}

const LIMIT_WINDOWS = [
  { pct: "fiveHourPct", resetsAt: "fiveHourResetsAt" },
  { pct: "sevenDayPct", resetsAt: "sevenDayResetsAt" },
] as const;

function normalizedConfigDir(snapshot: Snapshot): string | null {
  return typeof snapshot.configDir === "string" && snapshot.configDir !== "" ? snapshot.configDir.replace(/\/+$/, "") : null;
}

// The 5h/7d windows belong to the account, not to the instance, yet only an instance that just
// had a turn has them fresh (and a session can report one window and not the other). So each
// window is taken, on its own, from the most recent reading among the instances of the same
// Claude profile, skipping readings of a window that has already reset. Never across providers,
// and never without a known profile: two snapshots that merely both lack a configDir say
// nothing about being the same account.
export function withAccountRateLimits(
  snapshot: Snapshot,
  siblings: SiblingSnapshot[],
  instanceId: string,
  nowMs: number = Date.now()
): Snapshot {
  if (snapshot.provider !== "claude") return snapshot;
  const configDir: string | null = normalizedConfigDir(snapshot);
  const sources: Snapshot[] = [snapshot];
  if (configDir !== null) {
    for (const sibling of siblings) {
      if (sibling.instanceId === instanceId) continue;
      if (sibling.snapshot.provider === "claude" && normalizedConfigDir(sibling.snapshot) === configDir) {
        sources.push(sibling.snapshot);
      }
    }
  }

  const result: Snapshot = { ...snapshot };
  let freshestReportedMs = Number.NEGATIVE_INFINITY;
  for (const window of LIMIT_WINDOWS) {
    let best: { source: Snapshot; updatedAtMs: number } | null = null;
    for (const source of sources) {
      if (typeof source[window.pct] !== "number") continue;
      const resetsAt: unknown = source[window.resetsAt];
      if (typeof resetsAt === "number" && resetsAt * 1000 <= nowMs) continue;
      const updatedAtMs: number = Date.parse(String(source.updatedAt));
      if (Number.isFinite(updatedAtMs) && (best === null || updatedAtMs > best.updatedAtMs)) {
        best = { source, updatedAtMs };
      }
    }
    if (best === null) continue;
    result[window.pct] = best.source[window.pct];
    result[window.resetsAt] = best.source[window.resetsAt] ?? null;
    freshestReportedMs = Math.max(freshestReportedMs, best.updatedAtMs);
  }
  if (Number.isFinite(freshestReportedMs)) result.rateLimitsUpdatedAt = new Date(freshestReportedMs).toISOString();
  return result;
}

// Does this snapshot describe the agent that is running in the pane right now? Every writer
// stamps the pane job pid it ran under. The one snapshot with no pid the dashboard itself
// writes (a resume, before the agent has started) is recognised by the session id the agent
// was told to resume.
export function isSnapshotOfAgent(snapshot: Snapshot | null, agent: PaneAgent): boolean {
  if (snapshot === null || agent.kind !== "agent" || snapshot.provider !== agent.provider) return false;
  if (typeof snapshot.paneJobPid === "number") return snapshot.paneJobPid === agent.paneJobPid;
  if (agent.resumeId === null || snapshot.sessionId !== agent.resumeId) return false;
  // The server writes that snapshot right before it launches the agent, so it can only be
  // recent. An old one that merely names the same session belongs to an earlier run of it
  // (the user resumed the same conversation by hand days later).
  return Date.parse(String(snapshot.updatedAt)) >= agent.startedAtMs - PRE_LAUNCH_SNAPSHOT_WINDOW_MS;
}

const PRE_LAUNCH_SNAPSHOT_WINDOW_MS = 2 * 60_000;

export interface PersistableSession {
  sessionId: string;
  // Set when this instance's Claude profile is learned from a snapshot the dashboard launched.
  pinConfigDir?: string;
}

// May this snapshot's session id become the instance's resume target? Only the instance's own
// provider, only a session that reported from this pane, and only the profile the dashboard
// launched it with: a hand-run `claude-in` inside a `claude-me` instance, or a codex session in
// a claude instance, would otherwise overwrite the real resume point with an id the next
// relaunch cannot resume (it fails within seconds and silently starts a fresh session).
export function persistableSession(
  instance: Pick<InstanceRecord, "provider" | "configDir">,
  snapshot: Snapshot | null,
  agent: PaneAgent
): PersistableSession | null {
  if (snapshot === null || snapshot.provider !== instance.provider) return null;
  if (typeof snapshot.paneJobPid !== "number" || typeof snapshot.sessionId !== "string" || snapshot.sessionId === "") {
    return null;
  }
  // Another agent is alive in the pane and this snapshot is a leftover of an earlier one.
  if (agent.kind === "agent" && agent.paneJobPid !== snapshot.paneJobPid) return null;
  if (instance.provider !== "claude") return { sessionId: snapshot.sessionId };

  const configDir: string | null = normalizedConfigDir(snapshot);
  if (instance.configDir !== undefined) {
    return configDir === instance.configDir ? { sessionId: snapshot.sessionId } : null;
  }
  // Profile not learned yet (an instance created before this existed): only a session the
  // dashboard's own launch command started can teach it.
  if (snapshot.idSource !== "env") return null;
  return { sessionId: snapshot.sessionId, ...(configDir !== null ? { pinConfigDir: configDir } : {}) };
}

export interface LiveStatusInputs {
  instance: Pick<InstanceRecord, "id" | "provider" | "configDir">;
  agent: PaneAgent;
  snapshot: Snapshot | null;
  siblings: SiblingSnapshot[];
  fallback: (agent: AgentFound) => Promise<Snapshot | null>;
  enrichCodex: (snapshot: Snapshot) => Promise<Snapshot>;
}

export interface LiveStatusResolution {
  response: Snapshot;
  persist: PersistableSession | null;
}

export async function resolveLiveStatus(inputs: LiveStatusInputs): Promise<LiveStatusResolution> {
  const { instance, agent, snapshot, siblings } = inputs;
  const persist: PersistableSession | null = persistableSession(instance, snapshot, agent);
  const finalize = async (source: Snapshot): Promise<Snapshot> =>
    withAccountRateLimits(source.provider === "codex" ? await inputs.enrichCodex(source) : source, siblings, instance.id);

  if (agent.kind === "none") return { response: { available: false, reason: "no-agent" }, persist };

  // Cannot tell what is running (a failed probe) or there is nothing to detect (a custom
  // command): serve whatever the snapshot says, as before, rather than claim anything.
  if (agent.kind === "unknown") {
    return snapshot === null
      ? { response: { available: false }, persist }
      : { response: { available: true, ...(await finalize(snapshot)) }, persist };
  }

  if (isSnapshotOfAgent(snapshot, agent)) {
    return { response: { available: true, ...(await finalize(snapshot as Snapshot)), live: true }, persist };
  }

  const recovered: Snapshot | null = await inputs.fallback(agent);
  if (recovered !== null) {
    return { response: { available: true, ...(await finalize(recovered)), live: false }, persist };
  }
  return { response: { available: false, reason: "no-data", provider: agent.provider }, persist };
}
