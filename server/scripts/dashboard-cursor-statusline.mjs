#!/usr/bin/env node
// Cursor CLI calls this command with its live status-line payload on stdin. It keeps
// the user's previous status line intact while persisting the structured data for the
// AI Multi-Instance sidebar.
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const input = await readStdin();
const payload = parsePayload(input);

await renderOriginalStatusline(input, payload);

if (payload !== null && process.env.AI_MULTI_INSTANCE_ID) {
  await writeSnapshot(payload, process.env.AI_MULTI_INSTANCE_ID);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

function parsePayload(input) {
  try {
    const value = JSON.parse(input);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

async function renderOriginalStatusline(input, payload) {
  const originalCommand = await readOriginalStatuslineCommand();
  if (originalCommand) {
    try {
      const stdout = await runShellCommand(originalCommand, input);
      process.stdout.write(stdout);
      return;
    } catch {
      // An unavailable custom status line should not disable Cursor's fallback.
    }
  }

  if (payload === null) {
    process.stdout.write("Cursor");
    return;
  }

  const model = stringAt(payload, ["model", "display_name"]) ?? stringAt(payload, ["model", "displayName"]) ?? "Cursor";
  const contextPct = contextPercentage(payload);
  process.stdout.write(contextPct === undefined ? model : `${model} · ${Math.round(contextPct)}% context`);
}

async function readOriginalStatuslineCommand() {
  try {
    const sidecarPath = path.join(os.homedir(), ".cursor", "ai-multi-instance-statusline.json");
    const value = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    return typeof value?.statusLine?.command === "string" && value.statusLine.command.trim() !== ""
      ? value.statusLine.command
      : undefined;
  } catch {
    return undefined;
  }
}

function runShellCommand(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Statusline command exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

async function writeSnapshot(payload, instanceId) {
  const cacheRoot = path.join(os.homedir(), ".cache", "ai-multi-instance");
  const existing = await readSnapshot(cacheRoot, instanceId);
  const cwd = stringAt(payload, ["workspace", "current_dir"]) ?? stringAt(payload, ["cwd"]);
  const contextSize = numberAt(payload, ["context_window", "context_window_size"]);
  const contextPct = contextPercentage(payload);
  const inputTokens =
    numberAt(payload, ["context_window", "total_input_tokens"]) ??
    numberAt(payload, ["context_window", "current_usage", "input_tokens"]);
  const outputTokens = numberAt(payload, ["context_window", "total_output_tokens"]);
  const contextUsed =
    numberAt(payload, ["context_window", "used_tokens"]) ??
    (contextSize !== undefined && contextPct !== undefined ? Math.round((contextSize * contextPct) / 100) : undefined);
  const model =
    stringAt(payload, ["model", "display_name"]) ??
    stringAt(payload, ["model", "displayName"]) ??
    stringAt(payload, ["model", "modelId"]);
  const snapshot = {
    ...existing,
    provider: "cursor",
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(stringAt(payload, ["session_id"]) ? { sessionId: stringAt(payload, ["session_id"]) } : {}),
    ...(contextUsed !== undefined ? { contextUsed } : {}),
    ...(contextSize !== undefined ? { contextSize } : {}),
    ...(contextPct !== undefined ? { contextPct } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cwd ? await gitStatus(cwd) : {}),
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(cacheRoot, { recursive: true });
  const targetPath = path.join(cacheRoot, `${instanceId}.json`);
  const tempPath = path.join(cacheRoot, `.${instanceId}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, JSON.stringify(snapshot), "utf8");
  await fs.rename(tempPath, targetPath);
}

async function readSnapshot(cacheRoot, instanceId) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(cacheRoot, `${instanceId}.json`), "utf8"));
    return value !== null && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function gitStatus(cwd) {
  try {
    const [{ stdout: branch }, { stdout: diff }] = await Promise.all([
      execFileAsync("git", ["-C", cwd, "branch", "--show-current"]),
      execFileAsync("git", ["-C", cwd, "diff", "--numstat"]),
    ]);
    let gitAdded = 0;
    let gitRemoved = 0;
    for (const line of diff.trim().split("\n")) {
      const [added, removed] = line.split("\t");
      gitAdded += Number.parseInt(added, 10) || 0;
      gitRemoved += Number.parseInt(removed, 10) || 0;
    }
    return {
      ...(branch.trim() ? { branch: branch.trim() } : {}),
      gitAdded,
      gitRemoved,
    };
  } catch {
    return {};
  }
}

function contextPercentage(payload) {
  const used = numberAt(payload, ["context_window", "used_percentage"]);
  if (used !== undefined) return used;
  const remaining = numberAt(payload, ["context_window", "remaining_percentage"]);
  return remaining === undefined ? undefined : 100 - remaining;
}

function numberAt(value, keys) {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object" || !(key in current)) return undefined;
    current = current[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function stringAt(value, keys) {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object" || !(key in current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" && current.trim() !== "" ? current : undefined;
}
