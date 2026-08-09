#!/usr/bin/env node
// tsx (and other tools) create IPC sockets under os.tmpdir(). On some machines
// TMPDIR is inherited stale (e.g. from a root/sudo session) and points at a
// directory the current user cannot write to, which crashes "npm run dev" with
// an EACCES before the app ever starts. This wrapper resolves a temp dir the
// current user can actually write to, exports it as TMPDIR, and only then
// launches the real command.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function normalize(dir) {
  // os.tmpdir() strips a trailing slash but env.TMPDIR / getconf output may keep
  // one; normalize before comparing so a healthy machine never gets a false warning.
  return dir.length > 1 && dir.endsWith(path.sep) ? dir.slice(0, -1) : dir;
}

function isWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = mkdtempSync(path.join(dir, ".probe-"));
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function darwinUserTempDir() {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolveWritableTmpdir(env = process.env) {
  const candidates = [
    env.TMPDIR,
    os.tmpdir(),
    darwinUserTempDir(),
    path.join(os.homedir(), ".cache", "ai-multi-instance", "tmp"),
    "/tmp",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isWritable(candidate)) return normalize(candidate);
  }
  return undefined;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: with-writable-tmpdir.mjs <command> [args...]");
    process.exit(1);
  }

  const tmpdir = resolveWritableTmpdir();
  if (!tmpdir) {
    console.error(
      "[ai-multi-instance] No writable temp directory found. Diagnose with:\n" +
        `  echo $TMPDIR\n  ls -la "$TMPDIR"`
    );
    process.exit(1);
  }

  if (tmpdir !== normalize(os.tmpdir())) {
    console.warn(
      `[ai-multi-instance] TMPDIR (${os.tmpdir()}) is not writable, using ${tmpdir} instead.`
    );
  }

  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: tmpdir },
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
