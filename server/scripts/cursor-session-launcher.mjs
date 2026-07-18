#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const [command, instanceId, cwd, model = ""] = process.argv.slice(2);

try {
  const output = execFileSync(command, ["create-chat"], { cwd, encoding: "utf8" });
  const sessionId = output.trim().split(/\s+/).at(-1);
  if (!sessionId) throw new Error("Cursor Agent did not return a chat ID.");

  const cacheRoot = path.join(os.homedir(), ".cache", "ai-multi-instance");
  await fs.mkdir(cacheRoot, { recursive: true });
  const snapshotPath = path.join(cacheRoot, `${instanceId}.json`);
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({
      provider: "cursor",
      sessionId,
      cwd,
      ...(model ? { model } : {}),
      updatedAt: new Date().toISOString(),
    }),
    "utf8"
  );

  const args = ["--resume", sessionId];
  if (model) args.push("--model", model);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(`[ai-multi-instance] Could not launch Cursor Agent: ${error.message}`);
  process.exit(1);
}
