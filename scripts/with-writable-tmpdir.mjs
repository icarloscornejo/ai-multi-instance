#!/usr/bin/env node
// tsx (and other tools) create IPC sockets under os.tmpdir(). On some machines
// TMPDIR is inherited stale (e.g. from a root/sudo session) and points at a
// directory the current user cannot write to, which crashes "npm run dev" with
// an EACCES before the app ever starts. This wrapper resolves a temp dir the
// current user can actually write to, exports it as TMPDIR, and only then
// launches the real command.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Same data/ directory server/src/serverLog.ts derives from import.meta.dirname; this script
// lives one level up, at the repo root's scripts/, so it needs its own relative resolution.
const dataDirectory = path.resolve(import.meta.dirname, "..", "data");

// The one place in the whole system that can observe an abnormal exit of the process tree this
// wraps (`npm start` under launchd, or `npm run dev` by hand): serverLog.ts's uncaughtException/
// unhandledRejection handlers only run for a JS-level crash, never for a SIGSEGV/SIGKILL/OOM in
// the native node-pty addon, which kills the process outright with no handler ever running (see
// serverLog.ts's "muertes por señal" comment). Appended synchronously, before this script's own
// exit/re-signal below, so it lands even though this process is about to terminate itself.
// Caveat worth knowing: the direct child observed here is `npm` (or `concurrently`), not the
// innermost tsx/node process a few levels down - npm does not always forward a grandchild's exact
// termination signal, so `signal` may read null here even for a genuine native crash further
// down. Still strictly better than the previous state, which recorded nothing at all.
function logChildExit(supervised, code, signal) {
  const logPath = path.join(dataDirectory, supervised ? "server.log" : "server-dev.log");
  const line = `[${new Date().toISOString()}] child process exited code=${code ?? "null"} signal=${signal ?? "null"}\n`;
  try {
    mkdirSync(dataDirectory, { recursive: true });
    appendFileSync(logPath, line);
  } catch {
    // Best-effort, matches serverLog.ts's tolerance for a disk/permission failure here.
  }
}

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
    logChildExit(process.env.AI_MULTI_INSTANCE_SUPERVISED === "1", code, signal);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
