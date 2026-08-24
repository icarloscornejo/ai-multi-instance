import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, isSessionInitIncomplete, killSession, markSessionInitComplete } from "./tmux";

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

  it("creates a session AND sets the init-incomplete marker in the same invocation", async () => {
    const sessionName = "ccdash-real-test-session";
    await createSession(sessionName, tmpdir());
    try {
      // A wrong separator (see tmux.ts's comment on this exact argv) makes new-session treat
      // the rest of the argv as a doomed shell-command: the session dies immediately and
      // isSessionInitIncomplete can only ever see it as absent, never as "confirmed-incomplete".
      expect(await isSessionInitIncomplete(sessionName)).toBe("confirmed-incomplete");

      await markSessionInitComplete(sessionName);
      expect(await isSessionInitIncomplete(sessionName)).toBe("not-confirmed-incomplete");
    } finally {
      await killSession(sessionName);
    }
  });
});
