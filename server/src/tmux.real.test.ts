import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  getSessionPresence,
  isSessionInitIncomplete,
  killOrphanedDashboardSessions,
  killSession,
  markSessionInitComplete,
  markSessionLaunching,
  reconcileLegacyTmuxSockets,
} from "./tmux";

const execFileAsync = promisify(execFile);

// This file deliberately does NOT mock node:child_process (unlike tmux.test.ts): it runs the
// real tmux binary, which is the only way to actually catch a wrong argv separator like the
// "\;" vs ";" bug that shipped in 2.0.1 - a mocked execFile happily "succeeds" on either one.
//
// Isolated via TMUX_TMPDIR, not "-L"/"-S": tmux.ts's runTmux never takes a socket argument, so
// pointing it at a throwaway socket has to happen through the environment execFile inherits,
// not through the argv this test is trying to verify. A brand-new TMUX_TMPDIR means tmux talks
// to its own private server here, one this test starts and tears down itself - the user's
// default-socket sessions (their real, in-progress agent work) are never touched.
//
// BUT: when no -L/-S is passed, tmux prefers $TMUX over $TMUX_TMPDIR to locate the socket, and
// $TMUX is set inside any tmux pane - exactly where this suite runs when a dashboard agent calls
// `npm test`. Without clearing TMUX (and TMUX_PANE, which tmux commands also read), every
// command below, including this file's own kill-server, silently targets the REAL dashboard
// server instead of the throwaway one, killing the user's live sessions. This is not
// hypothetical: it is the confirmed root cause of the "tmux server dies every 10-40 min" bug.
async function socketPathOf(sessionName: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", sessionName, "#{socket_path}"]);
  return stdout.trim();
}

describe("createSession (real tmux)", () => {
  let isolatedSocketDir: string;
  let previousTmuxTmpdir: string | undefined;
  let previousTmux: string | undefined;
  let previousTmuxPane: string | undefined;

  beforeAll(async () => {
    isolatedSocketDir = await mkdtemp(join(tmpdir(), "ccdash-tmux-test-"));
    previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    previousTmux = process.env.TMUX;
    previousTmuxPane = process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = isolatedSocketDir;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  afterAll(async () => {
    if (previousTmuxTmpdir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = previousTmuxTmpdir;
    }
    if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    if (previousTmuxPane !== undefined) process.env.TMUX_PANE = previousTmuxPane;
    await rm(isolatedSocketDir, { recursive: true, force: true });
  });

  it("creates a session AND sets the init marker in the same invocation, then walks it to complete", async () => {
    const sessionName = "ccdash-real-test-session";
    await createSession(sessionName, tmpdir());
    try {
      // Guard against a broken isolation silently retargeting the real dashboard server: fail
      // loud here, before any kill-session/kill-server below can touch a live session.
      expect(await socketPathOf(sessionName)).toContain(isolatedSocketDir);
      // A wrong separator (see tmux.ts's comment on this exact argv) makes new-session treat
      // the rest of the argv as a doomed shell-command: the session dies immediately and
      // isSessionInitIncomplete can only ever see it as absent, never as "confirmed-incomplete".
      expect(await isSessionInitIncomplete(sessionName)).toBe("confirmed-incomplete");

      await markSessionLaunching(sessionName);
      expect(await isSessionInitIncomplete(sessionName)).toBe("confirmed-launching");

      await markSessionInitComplete(sessionName);
      expect(await isSessionInitIncomplete(sessionName)).toBe("not-confirmed-incomplete");
    } finally {
      await killSession(sessionName);
    }
  });

  // Round-2 audit: a create attempt hitting a session that already exists must reject with
  // "duplicate session" and must NOT run the chained set-option - if it did, it would stomp
  // the marker of a live session it never owned.
  it("rejects a duplicate create without touching the existing session's marker", async () => {
    const sessionName = "ccdash-real-dup-session";
    await createSession(sessionName, tmpdir());
    expect(await socketPathOf(sessionName)).toContain(isolatedSocketDir);
    await markSessionInitComplete(sessionName);
    try {
      await expect(createSession(sessionName, tmpdir())).rejects.toThrow(/duplicate session/i);
      // The chained set-option never ran: the marker is still "0", not back to "created".
      expect(await isSessionInitIncomplete(sessionName)).toBe("not-confirmed-incomplete");
    } finally {
      await killSession(sessionName);
    }
  });

  // Round-3 audit: a session carrying the LEGACY "1" marker could be a live post-launch
  // session. isSessionInitIncomplete must read it as "not-confirmed-incomplete" (preserve),
  // so the first attach after this upgrade does not destroy it.
  it("treats a legacy '1' marker as preserve, never 'confirmed-incomplete'", async () => {
    const sessionName = "ccdash-real-legacy-session";
    await createSession(sessionName, tmpdir());
    expect(await socketPathOf(sessionName)).toContain(isolatedSocketDir);
    try {
      await execFileAsync("tmux", ["set-option", "-t", sessionName, "@ccdash_init_incomplete", "1"]);
      expect(await isSessionInitIncomplete(sessionName)).toBe("not-confirmed-incomplete");
    } finally {
      await killSession(sessionName);
    }
  });
});

// Its OWN fresh TMUX_TMPDIR, and nothing in it ever starts a server: an empty socket dir is
// exactly the ENOENT case getSessionPresence has to classify as "absent". Sharing the dir
// with the describe above would let a server it started answer "can't find session" instead,
// which is also "absent" but for the wrong reason - the test would pass even with the bug.
describe("getSessionPresence with no server (real tmux, ENOENT)", () => {
  let emptySocketDir: string;
  let previousTmuxTmpdir: string | undefined;
  let previousTmux: string | undefined;
  let previousTmuxPane: string | undefined;

  beforeAll(async () => {
    emptySocketDir = await mkdtemp(join(tmpdir(), "ccdash-tmux-noserver-"));
    previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    previousTmux = process.env.TMUX;
    previousTmuxPane = process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = emptySocketDir;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  afterEach(async () => {
    // Paranoia: if something did spin a server up in OUR isolated dir, kill it so the next
    // assertion still sees the socket-missing case. Gated on the socket actually existing in
    // emptySocketDir (never an unqualified kill-server) so this can never reach the real
    // dashboard server even if TMUX/TMUX_TMPDIR isolation above were ever broken again.
    const socketPath = join(emptySocketDir, `tmux-${process.getuid?.() ?? 501}`, "default");
    if (existsSync(socketPath)) {
      await execFileAsync("tmux", ["kill-server"]).catch(() => undefined);
    }
  });

  afterAll(async () => {
    if (previousTmuxTmpdir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = previousTmuxTmpdir;
    }
    if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    if (previousTmuxPane !== undefined) process.env.TMUX_PANE = previousTmuxPane;
    await rm(emptySocketDir, { recursive: true, force: true });
  });

  it("classifies a missing socket as 'absent', not 'unknown' (the deadlock this fix exists for)", async () => {
    expect(await getSessionPresence("ccdash-does-not-exist")).toBe("absent");
  });
});

// Own isolated pair of TMUX_TMPDIRs: the "current" one (never gets a server started in it, so
// killOrphanedDashboardSessions has nothing of its own to accidentally sweep) and a separate
// "legacy" one with a real tmux server holding both a ccdash-* session and a non-dashboard
// session, so the prefix filter and the never-kill-server guarantee are both exercised for real.
describe("killOrphanedDashboardSessions / reconcileLegacyTmuxSockets (real tmux)", () => {
  let currentSocketDir: string;
  let legacySocketDir: string;
  let legacySocketPath: string;
  let previousTmuxTmpdir: string | undefined;
  let previousTmux: string | undefined;
  let previousTmuxPane: string | undefined;

  beforeAll(async () => {
    currentSocketDir = await mkdtemp(join(tmpdir(), "ccdash-tmux-current-"));
    legacySocketDir = await mkdtemp(join(tmpdir(), "ccdash-tmux-legacy-"));
    legacySocketPath = join(legacySocketDir, `tmux-${process.getuid?.() ?? 501}`, "default");
    previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    previousTmux = process.env.TMUX;
    previousTmuxPane = process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = currentSocketDir;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  afterAll(async () => {
    if (previousTmuxTmpdir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = previousTmuxTmpdir;
    }
    if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    if (previousTmuxPane !== undefined) process.env.TMUX_PANE = previousTmuxPane;
    if (existsSync(legacySocketPath)) {
      await execFileAsync("tmux", ["-S", legacySocketPath, "kill-server"]).catch(() => undefined);
    }
    await rm(currentSocketDir, { recursive: true, force: true });
    await rm(legacySocketDir, { recursive: true, force: true });
  });

  // Started via TMUX_TMPDIR (matching how the real dashboard's own createSession launches a
  // server, and how killOrphanedDashboardSessions expects to find one - see tmux.ts), not "-S"
  // with a hand-built path: "-S" treats its argument as the literal socket FILE and never
  // creates a missing parent directory, so a bare "-S <dir>/tmux-<uid>/default" against a
  // fresh mkdtemp silently fails to bind while still reporting success.
  async function startLegacySessions(): Promise<void> {
    const legacyEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: legacySocketDir };
    delete legacyEnv.TMUX;
    delete legacyEnv.TMUX_PANE;
    await execFileAsync("tmux", ["new-session", "-d", "-s", "ccdash-orphan", "-c", tmpdir()], { env: legacyEnv });
    await execFileAsync("tmux", ["new-session", "-d", "-s", "keep-me", "-c", tmpdir()], { env: legacyEnv });
  }

  it("kills only the ccdash-* session on a legacy socket, leaving a non-dashboard session alive", async () => {
    await startLegacySessions();
    try {
      const killed = await killOrphanedDashboardSessions([legacySocketDir]);
      expect(killed).toEqual([`${legacySocketPath}:ccdash-orphan`]);

      await expect(execFileAsync("tmux", ["-S", legacySocketPath, "has-session", "-t", "ccdash-orphan"])).rejects.toThrow();
      await expect(execFileAsync("tmux", ["-S", legacySocketPath, "has-session", "-t", "keep-me"])).resolves.toBeTruthy();
    } finally {
      await execFileAsync("tmux", ["-S", legacySocketPath, "kill-session", "-t", "keep-me"]).catch(() => undefined);
    }
  });

  it("never touches the current TMUX_TMPDIR even if it's also passed as a legacy dir", async () => {
    const killed = await killOrphanedDashboardSessions([currentSocketDir]);
    expect(killed).toEqual([]);
  });

  it("skips a legacy dir that has no socket at all", async () => {
    const nonexistentDirectory = join(legacySocketDir, "never-created");
    const killed = await killOrphanedDashboardSessions([nonexistentDirectory]);
    expect(killed).toEqual([]);
  });

  it("reconcileLegacyTmuxSockets sweeps the recorded prior TMUX_TMPDIR and records the current one", async () => {
    await startLegacySessions();
    const recordPath = join(currentSocketDir, "tmux-tmpdir.txt");
    await writeFile(recordPath, legacySocketDir, "utf8");
    try {
      const killed = await reconcileLegacyTmuxSockets(recordPath);
      expect(killed).toEqual([`${legacySocketPath}:ccdash-orphan`]);
      expect((await readFile(recordPath, "utf8")).trim()).toBe(currentSocketDir);
    } finally {
      await execFileAsync("tmux", ["-S", legacySocketPath, "kill-session", "-t", "keep-me"]).catch(() => undefined);
    }
  });
});
