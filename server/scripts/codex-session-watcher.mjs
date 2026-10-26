#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Started by shims/codex: [instanceId, cwd, startedAt (ms), paneJobPid, resumeId].
// The last two are optional so a hand-run watcher (and the older test) keeps working.
const [instanceId, expectedCwd, startedAtRaw, paneJobPidRaw = "", resumeId = ""] = process.argv.slice(2);
const startedAt = Number(startedAtRaw);
const paneJobPid = /^\d+$/.test(paneJobPidRaw) ? Number(paneJobPidRaw) : null;
const MAX_START_AGE_MS = 60_000;
// A wrong unit (seconds instead of ms) or a stale value would make the mtime filter below
// accept every old rollout in the folder, and the oldest one would get claimed.
if (!Number.isFinite(startedAt) || Date.now() - startedAt > MAX_START_AGE_MS) {
  console.error(`[codex-session-watcher] refusing startedAt=${startedAtRaw}`);
  process.exit(1);
}

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const sessionsRoot = path.join(codexHome, "sessions");
// ~/Library/Application Support, not ~/.cache - see scripts/with-writable-tmpdir.mjs's
// resolveTmuxTmpdir comment: third-party junk cleaners target folders named "cache" anywhere
// under $HOME.
const cacheRoot = path.join(os.homedir(), "Library", "Application Support", "ai-multi-instance");
const claimsRoot = path.join(cacheRoot, "codex-claims");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which is still alive.
    return error?.code === "EPERM";
  }
}

async function jsonlFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await jsonlFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
  }
  return files;
}

async function sessionMeta(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const event = JSON.parse(firstLine);
    return event.type === "session_meta" ? event.payload : null;
  } finally {
    await handle.close();
  }
}

// Claims written before paneJobPid existed hold the bare instance id.
function parseClaim(content) {
  try {
    const value = JSON.parse(content);
    if (value !== null && typeof value === "object") {
      return { instanceId: value.instanceId ?? null, paneJobPid: Number.isInteger(value.paneJobPid) ? value.paneJobPid : null };
    }
  } catch {
    // fall through to the legacy plain-text shape
  }
  return { instanceId: content.trim(), paneJobPid: null };
}

// One claim file per rollout, so two instances in the same folder can never share a session.
// A claim can be taken over only when its owner is provably gone (its pane job died) or it is
// this same job / this same instance's legacy claim: that is what lets `codex resume X` by hand
// re-claim X, without letting a second watcher steal a session that is still running.
async function claim(sessionId) {
  await fs.mkdir(claimsRoot, { recursive: true });
  const claimPath = path.join(claimsRoot, `${sessionId}.claim`);
  const mine = JSON.stringify({ instanceId, paneJobPid });
  try {
    const handle = await fs.open(claimPath, "wx");
    await handle.writeFile(mine, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const existing = parseClaim(await fs.readFile(claimPath, "utf8").catch(() => ""));
  const ownerGone = existing.paneJobPid !== null && !isProcessAlive(existing.paneJobPid);
  const sameJob = existing.paneJobPid !== null && existing.paneJobPid === paneJobPid;
  const legacyOwnClaim = existing.paneJobPid === null && existing.instanceId === instanceId;
  if (!ownerGone && !sameJob && !legacyOwnClaim) return false;
  const tempPath = `${claimPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, mine, "utf8");
  await fs.rename(tempPath, claimPath);
  // Two watchers can both decide to take over a dead claim; the rename that landed last wins.
  return parseClaim(await fs.readFile(claimPath, "utf8")).paneJobPid === paneJobPid;
}

async function writeSnapshot(sessionId, filePath, cwd) {
  await fs.mkdir(cacheRoot, { recursive: true });
  const snapshotPath = path.join(cacheRoot, `${instanceId}.json`);
  const snapshot = {
    provider: "codex",
    sessionId,
    sessionFile: filePath,
    cwd,
    ...(paneJobPid !== null ? { paneJobPid } : {}),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(`${snapshotPath}.tmp`, JSON.stringify(snapshot), "utf8");
  await fs.rename(`${snapshotPath}.tmp`, snapshotPath);
}

async function findCandidates() {
  const candidates = [];
  for (const filePath of await jsonlFiles(sessionsRoot)) {
    // `codex resume <id>` names its rollout outright, and a resumed session with no new turn
    // yet has an old mtime, so the freshness filter must not apply to it.
    if (resumeId !== "") {
      if (!filePath.endsWith(`${resumeId}.jsonl`)) continue;
      const meta = await sessionMeta(filePath).catch(() => null);
      if (meta !== null && typeof meta.id === "string") candidates.push({ filePath, meta, mtimeMs: 0 });
      continue;
    }
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats || stats.mtimeMs < startedAt - 2000) continue;
    const meta = await sessionMeta(filePath).catch(() => null);
    if (meta?.cwd === expectedCwd && typeof meta.id === "string") {
      candidates.push({ filePath, meta, mtimeMs: stats.mtimeMs });
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
  return candidates;
}

for (let attempt = 0; attempt < 120; attempt += 1) {
  // The agent this watcher was started for is gone (a resume that failed fast and fell back to
  // a fresh launch, or the user quit): anything written now would point at a dead job.
  if (paneJobPid !== null && !isProcessAlive(paneJobPid)) process.exit(1);
  for (const candidate of await findCandidates()) {
    if (!(await claim(candidate.meta.id))) continue;
    if (paneJobPid !== null && !isProcessAlive(paneJobPid)) process.exit(1);
    await writeSnapshot(candidate.meta.id, candidate.filePath, candidate.meta.cwd ?? expectedCwd);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

process.exit(1);
