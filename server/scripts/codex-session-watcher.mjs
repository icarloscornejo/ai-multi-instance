#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const [instanceId, expectedCwd, startedAtRaw] = process.argv.slice(2);
const startedAt = Number(startedAtRaw);
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const sessionsRoot = path.join(codexHome, "sessions");
const cacheRoot = path.join(os.homedir(), ".cache", "ai-multi-instance");
const claimsRoot = path.join(cacheRoot, "codex-claims");

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

async function claim(sessionId) {
  await fs.mkdir(claimsRoot, { recursive: true });
  try {
    const handle = await fs.open(path.join(claimsRoot, `${sessionId}.claim`), "wx");
    await handle.writeFile(instanceId, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    return error?.code !== "EEXIST" ? Promise.reject(error) : false;
  }
}

for (let attempt = 0; attempt < 120; attempt += 1) {
  const candidates = [];
  for (const filePath of await jsonlFiles(sessionsRoot)) {
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats || stats.mtimeMs < startedAt - 2000) continue;
    const meta = await sessionMeta(filePath).catch(() => null);
    if (meta?.cwd === expectedCwd && typeof meta.id === "string") {
      candidates.push({ filePath, meta, mtimeMs: stats.mtimeMs });
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const candidate of candidates) {
    if (!(await claim(candidate.meta.id))) continue;
    await fs.mkdir(cacheRoot, { recursive: true });
    const snapshotPath = path.join(cacheRoot, `${instanceId}.json`);
    const snapshot = {
      provider: "codex",
      sessionId: candidate.meta.id,
      sessionFile: candidate.filePath,
      cwd: candidate.meta.cwd,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(`${snapshotPath}.tmp`, JSON.stringify(snapshot), "utf8");
    await fs.rename(`${snapshotPath}.tmp`, snapshotPath);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

process.exit(1);
