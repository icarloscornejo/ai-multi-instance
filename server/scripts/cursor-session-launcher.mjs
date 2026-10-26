#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaneIdentity } from "./lib/pane-identity.mjs";

const [command, instanceId, cwd, model = ""] = process.argv.slice(2);

try {
  const output = execFileSync(command, ["create-chat"], { cwd, encoding: "utf8" });
  const sessionId = output.trim().split(/\s+/).at(-1);
  if (!sessionId) throw new Error("Cursor Agent did not return a chat ID.");

  // ~/Library/Application Support, not ~/.cache - see scripts/with-writable-tmpdir.mjs's
  // resolveTmuxTmpdir comment: third-party junk cleaners target folders named "cache" anywhere
  // under $HOME.
  const cacheRoot = path.join(os.homedir(), "Library", "Application Support", "ai-multi-instance");
  await fs.mkdir(cacheRoot, { recursive: true });
  // The pane job pid lets the sidebar tell this snapshot belongs to the Cursor process running
  // now, not to an earlier session left in the same pane.
  const identity = await resolvePaneIdentity();
  const snapshotPath = path.join(cacheRoot, `${instanceId}.json`);
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({
      provider: "cursor",
      sessionId,
      cwd,
      ...(model ? { model } : {}),
      idSource: "env",
      ...(identity?.paneJobPid != null ? { paneJobPid: identity.paneJobPid } : {}),
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
