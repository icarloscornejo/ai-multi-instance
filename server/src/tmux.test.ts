import { beforeEach, describe, expect, it, vi } from "vitest";

// child_process.execFile has its own util.promisify.custom implementation (resolving to
// {stdout, stderr} instead of the raw callback args), which is exactly what tmux.ts's
// `promisify(execFile)` relies on. Mocking that custom-promisify slot directly - rather than
// the callback-style execFile itself - is what lets these tests drive the same code path
// tmux.ts actually calls, without needing a real tmux binary installed. The symbol is
// recomputed inside the factory (rather than closed over from an outer variable) because
// vi.mock factories are hoisted above the rest of the file and cannot reference top-level
// variables declared below them.
vi.mock("node:child_process", () => {
  const runMock = vi.fn();
  const execFileMock = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: runMock });
  return { execFile: execFileMock };
});

import { execFile } from "node:child_process";
import {
  TmuxError,
  createSession,
  getSessionPresence,
  isSessionInitIncomplete,
  killSession,
} from "./tmux";

const promisifyCustomSymbol = Symbol.for("nodejs.util.promisify.custom");
const runTmuxMock = (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisifyCustomSymbol];

function execError(overrides: {
  message?: string;
  stderr?: string;
  killed?: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}): Error {
  return Object.assign(new Error(overrides.message ?? "tmux failed"), {
    stderr: overrides.stderr ?? "",
    killed: overrides.killed ?? false,
    code: overrides.code ?? 1,
    signal: overrides.signal ?? null,
  });
}

beforeEach(() => {
  runTmuxMock.mockReset();
});

describe("getSessionPresence", () => {
  it("returns 'present' when has-session succeeds", async () => {
    runTmuxMock.mockResolvedValue({ stdout: "", stderr: "" });
    expect(await getSessionPresence("ccdash-abc")).toBe("present");
  });

  it("returns 'absent' for tmux's definitive 'no such session' answer", async () => {
    runTmuxMock.mockRejectedValue(execError({ stderr: "can't find session: ccdash-abc" }));
    expect(await getSessionPresence("ccdash-abc")).toBe("absent");
  });

  it("returns 'absent' when no tmux server is running at all", async () => {
    runTmuxMock.mockRejectedValue(execError({ stderr: "no server running on /tmp/tmux-501/default" }));
    expect(await getSessionPresence("ccdash-abc")).toBe("absent");
  });

  // This is the exact ambiguity the whole tri-state design exists to preserve: a timeout
  // (killed: true) is NOT proof the session is gone, even though it also produces a non-zero
  // exit like the "definitely absent" case does. Collapsing this into "absent" is what the
  // first (rejected) design attempt did, and it is what would let a merely-stalled tmux
  // server trigger destroying a session that might be perfectly healthy.
  it("returns 'unknown', never 'absent', for a timed-out probe even if stderr happens to be empty", async () => {
    runTmuxMock.mockRejectedValue(execError({ killed: true, stderr: "", message: "Command failed" }));
    expect(await getSessionPresence("ccdash-abc")).toBe("unknown");
  });

  it("returns 'unknown' for an operational failure that isn't the definitive absence message", async () => {
    runTmuxMock.mockRejectedValue(execError({ stderr: "server communication error" }));
    expect(await getSessionPresence("ccdash-abc")).toBe("unknown");
  });
});

describe("isSessionInitIncomplete", () => {
  it("returns 'confirmed-incomplete' only when the marker reads exactly '1'", async () => {
    runTmuxMock.mockResolvedValue({ stdout: "1\n", stderr: "" });
    expect(await isSessionInitIncomplete("ccdash-abc")).toBe("confirmed-incomplete");
  });

  it("returns 'not-confirmed-incomplete' when the marker reads '0' (already complete)", async () => {
    runTmuxMock.mockResolvedValue({ stdout: "0\n", stderr: "" });
    expect(await isSessionInitIncomplete("ccdash-abc")).toBe("not-confirmed-incomplete");
  });

  // The regression this guards: every session that existed before this marker was
  // introduced has never had it set at all. If reading an unset option threw or returned
  // something this function misread as "1", the very first attach after deploying this
  // change would destroy every pre-existing live session on the machine.
  it("returns 'not-confirmed-incomplete' when the marker was never set (a legacy session)", async () => {
    runTmuxMock.mockRejectedValue(execError({ stderr: "unknown option: @ccdash_init_incomplete" }));
    expect(await isSessionInitIncomplete("ccdash-abc")).toBe("not-confirmed-incomplete");
  });

  it("returns 'not-confirmed-incomplete' when the read itself fails operationally (never 'confirmed-incomplete' on ambiguity)", async () => {
    runTmuxMock.mockRejectedValue(execError({ killed: true }));
    expect(await isSessionInitIncomplete("ccdash-abc")).toBe("not-confirmed-incomplete");
  });
});

describe("createSession", () => {
  it("chains the init-incomplete marker into the same tmux invocation that creates the session", async () => {
    runTmuxMock.mockResolvedValue({ stdout: "", stderr: "" });
    await createSession("ccdash-abc", "/tmp/project");
    const firstCallArguments = runTmuxMock.mock.calls[0]?.[1] as string[];
    expect(firstCallArguments).toEqual([
      "new-session",
      "-d",
      "-s",
      "ccdash-abc",
      "-c",
      "/tmp/project",
      "\\;",
      "set-option",
      "-t",
      "ccdash-abc",
      "@ccdash_init_incomplete",
      "1",
    ]);
  });
});

describe("killSession", () => {
  it("succeeds normally when the session exists", async () => {
    runTmuxMock.mockResolvedValue({ stdout: "", stderr: "" });
    await expect(killSession("ccdash-abc")).resolves.toBeUndefined();
  });

  // Idempotency: a caller that already confirmed absence (or one recreating a session that
  // vanished on its own between its own probe and this call) should not have to treat
  // "already gone" as a failure.
  it("treats killing an already-absent session as success, not a thrown error", async () => {
    runTmuxMock.mockRejectedValue(execError({ stderr: "can't find session: ccdash-abc" }));
    await expect(killSession("ccdash-abc")).resolves.toBeUndefined();
  });

  it("still throws for a genuine operational failure (e.g. a timeout), not just an absent session", async () => {
    runTmuxMock.mockRejectedValue(execError({ killed: true, message: "Command failed" }));
    await expect(killSession("ccdash-abc")).rejects.toBeInstanceOf(TmuxError);
  });
});

describe("TmuxError", () => {
  it("preserves killed/code/signal instead of collapsing every failure into a flat message", async () => {
    runTmuxMock.mockRejectedValue(execError({ killed: true, code: null, signal: "SIGTERM", message: "Command failed" }));
    await expect(getSessionPresence("x")).resolves.toBe("unknown");

    runTmuxMock.mockRejectedValue(execError({ killed: true, code: null, signal: "SIGTERM", message: "Command failed" }));
    try {
      await killSession("x");
      expect.unreachable("killSession should have thrown for a timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(TmuxError);
      expect((error as TmuxError).killed).toBe(true);
      expect((error as TmuxError).signal).toBe("SIGTERM");
    }
  });
});
