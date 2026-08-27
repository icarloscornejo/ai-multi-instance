import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  getSessionPresence,
  isSessionInitIncomplete,
  killSession,
  markSessionInitComplete,
  markSessionLaunching,
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

describe("createSession (real tmux)", () => {
  let isolatedSocketDir: string;
  let previousTmuxTmpdir: string | undefined;

  beforeAll(async () => {
    isolatedSocketDir = await mkdtemp(join(tmpdir(), "ccdash-tmux-test-"));
    previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = isolatedSocketDir;
  });

  afterAll(async () => {
    if (previousTmuxTmpdir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = previousTmuxTmpdir;
    }
    await rm(isolatedSocketDir, { recursive: true, force: true });
  });

  it("creates a session AND sets the init marker in the same invocation, then walks it to complete", async () => {
    const sessionName = "ccdash-real-test-session";
    await createSession(sessionName, tmpdir());
    try {
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

  beforeAll(async () => {
    emptySocketDir = await mkdtemp(join(tmpdir(), "ccdash-tmux-noserver-"));
    previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = emptySocketDir;
  });

  afterEach(async () => {
    // Paranoia: if something did spin a server up, kill it so the next assertion still sees
    // the socket-missing case.
    await execFileAsync("tmux", ["kill-server"]).catch(() => undefined);
  });

  afterAll(async () => {
    if (previousTmuxTmpdir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = previousTmuxTmpdir;
    }
    await rm(emptySocketDir, { recursive: true, force: true });
  });

  it("classifies a missing socket as 'absent', not 'unknown' (the deadlock this fix exists for)", async () => {
    expect(await getSessionPresence("ccdash-does-not-exist")).toBe("absent");
  });
});
