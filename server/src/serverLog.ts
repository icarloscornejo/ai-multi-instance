import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

// Mirrors tunnel.ts's dataDirectory derivation - server.log/server-dev.log live alongside
// cloudflared.log, auth-secret.txt, and instances.json.
const dataDirectory: string = path.resolve(import.meta.dirname, "../../data");

// Two files, two owners, never the same one at the same time (see index.ts's wiring):
// server.log belongs to the launchd-supervised process, server-dev.log to a manually-run
// `npm run dev`. Splitting them removes the window where an accidental `npm run dev` against an
// already-running service could trim/rewrite the log the service is actively writing - EADDRINUSE
// is only detected once `listen()` runs (index.ts), well after this module has already started.
const SUPERVISED_LOG_PATH: string = path.join(dataDirectory, "server.log");
const DEV_LOG_PATH: string = path.join(dataDirectory, "server-dev.log");

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB
const KEEP_TAIL_BYTES = 512 * 1024; // 512 KiB
const TRIM_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly, for a long-lived process

export function isSupervised(): boolean {
  return process.env.AI_MULTI_INSTANCE_SUPERVISED === "1";
}

export function resolveLogPath(supervised: boolean): string {
  return supervised ? SUPERVISED_LOG_PATH : DEV_LOG_PATH;
}

export function formatCrashLine(kind: "uncaughtException" | "unhandledRejection", error: unknown): string {
  // Prefer the real stack: a bare String(error) on a non-Error throw (a string, a plain object,
  // undefined) would silently discard exactly the information this exists to preserve.
  const body: string =
    error instanceof Error && typeof error.stack === "string" ? error.stack : inspect(error, { depth: 5 });
  return `${kind}: ${body}`;
}

function appendBestEffort(logPath: string, text: string): void {
  try {
    appendFileSync(logPath, text);
  } catch {
    // Best-effort logging, mirrors tunnel.ts's appendToLogFile: a disk/permission problem here
    // must never take the server down with it.
  }
}

// Rewritten IN PLACE, never renamed. Safe only because this process is server.log's sole writer
// in supervised mode (the console tee below stops forwarding to launchd's own stderr file, see
// installConsoleTee) - unlike launchd-stderr.log, which launchd itself holds an fd open on and
// therefore must be rotated by rename from setup.sh instead (see that script's launchd section).
// Exported so serverLog.test.ts can exercise it against an injected temp path, isolated from the
// real data directory.
export function trimLogIfOversized(
  logPath: string,
  maxBytes: number = MAX_LOG_BYTES,
  keepTailBytes: number = KEEP_TAIL_BYTES
): void {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return; // doesn't exist yet - nothing to trim
  }
  if (size <= maxBytes) {
    return;
  }
  const contents = readFileSync(logPath);
  // Keep the TAIL, not truncate to zero (unlike tunnel.ts's cloudflared.log): launchd restarts
  // the process *after* a crash, so truncating on startup would erase the very stack trace that
  // motivated the restart.
  const tail = contents.subarray(contents.length - keepTailBytes);
  const header = Buffer.from(`--- trimmed ${new Date().toISOString()}, earlier lines dropped ---\n`);
  writeFileSync(logPath, Buffer.concat([header, tail]));
}

function hardenPermissions(logPath: string): void {
  try {
    mkdirSync(dataDirectory, { recursive: true });
    // chmod, not just mkdir's mode: mkdirSync's mode option has no effect on a directory that
    // already exists, and on a real checkout data/ already exists at 0755 - a mode-only mkdir
    // would silently leave that installation unfixed.
    chmodSync(dataDirectory, 0o700);
    if (!existsSync(logPath)) {
      writeFileSync(logPath, "", { mode: 0o600 });
    }
    chmodSync(logPath, 0o600);
  } catch {
    // Best-effort: a permissions problem here must never block startup.
  }
}

function installConsoleTee(logPath: string, supervised: boolean): void {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const formatArguments = (args: unknown[]): string =>
    args.map((argument) => (typeof argument === "string" ? argument : inspect(argument))).join(" ");

  const tee =
    (originalMethod: (...args: unknown[]) => void, level: string) =>
    (...args: unknown[]): void => {
      appendBestEffort(logPath, `[${new Date().toISOString()}] ${level} ${formatArguments(args)}\n`);
      // In supervised mode this process is server.log's only writer: forwarding to the original
      // console method would ALSO land in launchd-stderr.log via StandardErrorPath, turning a file
      // meant to stay empty (see setup.sh's launchd section) into a duplicate of every console.*
      // call in server/src. In dev mode there is no launchd on the other end, so forwarding just
      // keeps the terminal you're already watching alive.
      if (!supervised) {
        originalMethod(...args);
      }
    };

  console.log = tee(original.log, "LOG");
  console.warn = tee(original.warn, "WARN");
  console.error = tee(original.error, "ERROR");
}

let started = false;

// Must be the very first statement index.ts executes, before express() and before the process
// handlers it installs right after this. Contract: a failure during ESM evaluation of a static
// import (index.ts's own imports run before ANY of its body, including this call) can never reach
// server.log - those land in data/launchd-stderr.log instead (see setup.sh's launchd section).
// Documented, not engineered around: a bootstrap preloader with a dynamic import would be
// structural complexity for a case the other log already covers.
export function startServerLog(): void {
  if (started) {
    return; // idempotent - guards against being called more than once
  }
  started = true;

  const supervised = isSupervised();
  const logPath = resolveLogPath(supervised);

  hardenPermissions(logPath);

  if (supervised) {
    // Trim only in supervised mode: this file is only ever this process's own, so trimming here
    // can never race a sibling process the way trimming server.log from a `npm run dev` process
    // could (that risk is exactly why server-dev.log is a separate file in the first place).
    trimLogIfOversized(logPath);
    const trimInterval = setInterval(() => trimLogIfOversized(logPath), TRIM_CHECK_INTERVAL_MS);
    trimInterval.unref();
  }

  appendBestEffort(
    logPath,
    `--- server started ${new Date().toISOString()} pid=${process.pid} node=${process.version} supervised=${supervised} ---\n`
  );

  installConsoleTee(logPath, supervised);
}
