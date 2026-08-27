import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceRecord } from "./types";

vi.mock("./tmux", () => ({
  // A real (if minimal) Error subclass, not a vi.fn(): terminal.ts's ensureSessionReady does
  // `new TmuxError(...)` and `error instanceof TmuxError`-style narrowing, neither of which a
  // mock function stand-in could satisfy.
  TmuxError: class TmuxError extends Error {
    constructor(
      message: string,
      public readonly killed = false,
      public readonly code: number | null = null,
      public readonly signal: string | null = null
    ) {
      super(message);
      this.name = "TmuxError";
    }
  },
  hasSession: vi.fn(),
  createSession: vi.fn(),
  enableMouseMode: vi.fn(),
  sendCommandToSession: vi.fn(),
  killSession: vi.fn(),
  getSessionPresence: vi.fn(),
  isSessionInitIncomplete: vi.fn(),
  markSessionLaunching: vi.fn(),
  markSessionInitComplete: vi.fn(),
  // A plain predicate, not stateful: real impl in tmux.ts matches "duplicate session:" in the
  // error message. Tests that need it truthy set it per-case; the default (undefined ->
  // falsy) means "not a duplicate", the common path.
  isDuplicateSessionError: vi.fn(),
}));

vi.mock("@lydell/node-pty", () => ({
  spawn: vi.fn(),
}));

import * as nodePty from "@lydell/node-pty";
import * as tmux from "./tmux";
import {
  AttachCancelledError,
  PtySpawnError,
  bridgeTerminal,
  closeSocketSafely,
  ensureSessionReady,
  initializeInstanceSession,
  spawnWithRetry,
  validateTerminalSize,
} from "./terminal";
import type { AttachBuffer } from "./attachBuffer";

// Minimal stand-in for node-pty's IPty, exposing only what terminal.ts actually calls, plus
// `_emit*` helpers the tests use to drive it - onData/onExit are node-pty's own IEvent
// wrappers (subscribe-only), and the raw "error" listener is registered via the same
// EventEmitter-style `.on()` terminal.ts uses (see terminal.ts's cast comment for why).
function makeFakePty() {
  const dataListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<() => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  return {
    onData: vi.fn((callback: (chunk: string) => void) => {
      dataListeners.push(callback);
    }),
    onExit: vi.fn((callback: () => void) => {
      exitListeners.push(callback);
    }),
    on: vi.fn((event: string, callback: (error: Error) => void) => {
      if (event === "error") {
        errorListeners.push(callback);
      }
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    destroy: vi.fn(),
    _emitData(chunk: string): void {
      dataListeners.forEach((callback) => callback(chunk));
    },
    _emitExit(): void {
      exitListeners.forEach((callback) => callback());
    },
    _emitError(error: Error): void {
      errorListeners.forEach((callback) => callback(error));
    },
  };
}

// Minimal stand-in for a `ws` WebSocket: only readyState/send/close/terminate/on("message"|
// "close") are exercised by bridgeTerminal.
function makeFakeSocket() {
  const messageListeners: Array<(raw: unknown) => void> = [];
  const closeListeners: Array<() => void> = [];
  return {
    OPEN: 1,
    CONNECTING: 0,
    CLOSED: 3,
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn((event: string, callback: (...args: never[]) => void) => {
      if (event === "message") {
        messageListeners.push(callback as (raw: unknown) => void);
      } else if (event === "close") {
        closeListeners.push(callback as () => void);
      }
    }),
    _emitMessage(raw: unknown): void {
      messageListeners.forEach((callback) => callback(raw));
    },
  };
}

function makeNoopAttachBuffer(): AttachBuffer {
  return {
    add: () => true,
    drain: () => [],
  };
}

function makeInstance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: "abc123",
    label: "test",
    locationPath: "/tmp/test-instance",
    tmuxSession: "ccdash-abc123",
    provider: "claude",
    command: "claude",
    model: null,
    effort: null,
    fontSize: 13,
    createdAt: new Date().toISOString(),
    shellOnly: true,
    ...overrides,
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(tmux.hasSession).mockReset();
  vi.mocked(tmux.createSession).mockReset();
  vi.mocked(tmux.enableMouseMode).mockReset();
  vi.mocked(tmux.sendCommandToSession).mockReset();
  vi.mocked(tmux.killSession).mockReset();
  vi.mocked(tmux.getSessionPresence).mockReset();
  vi.mocked(tmux.isSessionInitIncomplete).mockReset();
  vi.mocked(tmux.markSessionLaunching).mockReset();
  vi.mocked(tmux.markSessionInitComplete).mockReset();
  vi.mocked(tmux.isDuplicateSessionError).mockReset();
  vi.mocked(nodePty.spawn).mockReset();
});

describe("spawnWithRetry", () => {
  it("returns immediately on success, without any delay or retry", async () => {
    const fakePty = { marker: "pty" } as unknown as import("@lydell/node-pty").IPty;
    const spawnAttempt = vi.fn().mockReturnValue(fakePty);
    const result = await spawnWithRetry(spawnAttempt, () => true, [1, 1, 1]);
    expect(result).toBe(fakePty);
    expect(spawnAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries the diagnosed error signature and succeeds once it clears", async () => {
    const fakePty = { marker: "pty" } as unknown as import("@lydell/node-pty").IPty;
    let calls = 0;
    const spawnAttempt = vi.fn(() => {
      calls += 1;
      if (calls < 3) {
        throw new Error("posix_spawnp failed.");
      }
      return fakePty;
    });
    const result = await spawnWithRetry(spawnAttempt, () => true, [1, 1, 1]);
    expect(result).toBe(fakePty);
    expect(spawnAttempt).toHaveBeenCalledTimes(3);
  });

  it("throws PtySpawnError with the last error's message and the attempt count once every retry is exhausted", async () => {
    const spawnAttempt = vi.fn(() => {
      throw new Error("posix_spawnp failed.");
    });
    const delays = [1, 1, 1];
    await expect(spawnWithRetry(spawnAttempt, () => true, delays)).rejects.toMatchObject({
      message: "posix_spawnp failed.",
      attempts: delays.length + 1,
    });
    expect(spawnAttempt).toHaveBeenCalledTimes(delays.length + 1);
  });

  // The decisive signal is often in an EARLIER attempt, not the last one - see
  // SpawnAttemptDetail's header comment in attachErrors.ts. This is the regression test for
  // that: attempt 1 carries a real errno the final, opaque posix_spawnp message does not.
  it("carries every attempt's own outcome, not just the final one", async () => {
    let calls = 0;
    const spawnAttempt = vi.fn(() => {
      calls += 1;
      const error = new Error(calls === 1 ? "spawn failed" : "posix_spawnp failed.") as NodeJS.ErrnoException;
      if (calls === 1) {
        error.code = "EMFILE";
      }
      throw error;
    });
    const delays = [1, 1, 1];
    let caught: unknown;
    try {
      await spawnWithRetry(spawnAttempt, () => true, delays);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PtySpawnError);
    const attemptDetails = (caught as PtySpawnError).attemptDetails;
    expect(attemptDetails).toHaveLength(delays.length + 1);
    expect(attemptDetails[0]).toMatchObject({ attemptIndex: 1, message: "spawn failed", code: "EMFILE" });
    expect(attemptDetails[attemptDetails.length - 1]).toMatchObject({
      attemptIndex: delays.length + 1,
      message: "posix_spawnp failed.",
    });
  });

  it("propagates a non-retriable error immediately, unwrapped, without retrying", async () => {
    const spawnAttempt = vi.fn(() => {
      throw new Error("spawn tmux ENOENT");
    });
    await expect(spawnWithRetry(spawnAttempt, () => true, [1, 1, 1])).rejects.toThrow("spawn tmux ENOENT");
    expect(spawnAttempt).toHaveBeenCalledTimes(1);
  });

  it("stops retrying and throws AttachCancelledError once isStillWanted turns false, without spawning again", async () => {
    // isStillWanted is checked once per failed-and-retriable attempt, right before the
    // sleep; returning true on its first call lets one retry happen, then false on the
    // second call cancels before a third attempt is made.
    let checks = 0;
    const isStillWanted = vi.fn(() => {
      checks += 1;
      return checks === 1;
    });
    const spawnAttempt = vi.fn(() => {
      throw new Error("posix_spawnp failed.");
    });
    await expect(spawnWithRetry(spawnAttempt, isStillWanted, [1, 1, 1])).rejects.toBeInstanceOf(AttachCancelledError);
    // First attempt fails, isStillWanted allows one retry, second attempt fails, isStillWanted
    // denies further retries: exactly two spawn attempts, never a third.
    expect(spawnAttempt).toHaveBeenCalledTimes(2);
  });
});

describe("ensureSessionReady", () => {
  it("preserves an existing session with a 'not-confirmed-incomplete' marker (the legacy/already-ready case), touching only enableMouseMode", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("present");
    vi.mocked(tmux.isSessionInitIncomplete).mockResolvedValue("not-confirmed-incomplete");
    await ensureSessionReady(makeInstance());
    expect(tmux.enableMouseMode).toHaveBeenCalledWith("ccdash-abc123");
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.sendCommandToSession).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  // This is the regression test for the disaster the second design attempt would have
  // caused: a session that already existed before the init marker was introduced has no
  // marker at all, which reads as "not-confirmed-incomplete" - same as a legacy session -
  // and must be preserved exactly like one, never destroyed on that basis alone.
  it("never touches an existing session merely because its init-completeness could not be confirmed", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("present");
    vi.mocked(tmux.isSessionInitIncomplete).mockResolvedValue("not-confirmed-incomplete");
    await ensureSessionReady(makeInstance());
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("creates the session and launches the provider, then marks init complete, when it does not exist yet", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    vi.mocked(tmux.sendCommandToSession).mockResolvedValue(undefined);
    await ensureSessionReady(makeInstance({ shellOnly: false }));
    expect(tmux.createSession).toHaveBeenCalledWith("ccdash-abc123", "/tmp/test-instance");
    expect(tmux.sendCommandToSession).toHaveBeenCalledTimes(1);
    expect(tmux.markSessionInitComplete).toHaveBeenCalledWith("ccdash-abc123");
  });

  it("skips the provider launch for a shell-only instance but still marks init complete", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    await ensureSessionReady(makeInstance({ shellOnly: true }));
    expect(tmux.sendCommandToSession).not.toHaveBeenCalled();
    expect(tmux.markSessionInitComplete).toHaveBeenCalledWith("ccdash-abc123");
  });

  // Inverted from its previous form on purpose (round-2 audit finding): sendCommandToSession
  // delivers the command text and Enter as two separate tmux calls, and a timeout on either
  // kills the tmux CLIENT while the SERVER may already have run it - the agent may be live.
  // Killing the session in that state destroys real work, so the catch must NOT kill once the
  // launch point was passed. initializeSession moves the marker to "launching" first
  // (markSessionLaunching), so a future attach also preserves it (see the "confirmed-launching"
  // test below).
  it("does NOT kill a session when the provider launch may already have been applied (send failed after markSessionLaunching)", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    vi.mocked(tmux.markSessionLaunching).mockResolvedValue(undefined);
    vi.mocked(tmux.sendCommandToSession).mockRejectedValueOnce(new Error("tmux command timed out"));

    await expect(ensureSessionReady(makeInstance({ shellOnly: false }))).rejects.toThrow("tmux command timed out");
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.markSessionInitComplete).not.toHaveBeenCalled();
  });

  it("marks the session 'launching' BEFORE sending the launch command, never after", async () => {
    const calls: string[] = [];
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    vi.mocked(tmux.createSession).mockImplementation(async () => {
      calls.push("createSession");
    });
    vi.mocked(tmux.markSessionLaunching).mockImplementation(async () => {
      calls.push("markSessionLaunching");
    });
    vi.mocked(tmux.sendCommandToSession).mockImplementation(async () => {
      calls.push("sendCommandToSession");
    });

    await ensureSessionReady(makeInstance({ shellOnly: false }));
    expect(calls).toEqual(["createSession", "markSessionLaunching", "sendCommandToSession"]);
  });

  it("still cleans up when markSessionLaunching fails - nothing was launched yet - and never sends the command", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    vi.mocked(tmux.markSessionLaunching).mockRejectedValueOnce(new Error("tmux command timed out"));

    await expect(ensureSessionReady(makeInstance({ shellOnly: false }))).rejects.toThrow("tmux command timed out");
    expect(tmux.sendCommandToSession).not.toHaveBeenCalled();
    expect(tmux.killSession).toHaveBeenCalledWith("ccdash-abc123");
  });

  it("does NOT kill a session when createSession fails with 'duplicate session' - this call did not create it", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    vi.mocked(tmux.createSession).mockRejectedValueOnce(new Error("duplicate session: ccdash-abc123"));
    vi.mocked(tmux.isDuplicateSessionError).mockReturnValue(true);

    await expect(ensureSessionReady(makeInstance())).rejects.toThrow("duplicate session");
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it("DOES kill on a genuine (non-duplicate) createSession failure - the legitimate rollback still works", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    vi.mocked(tmux.createSession).mockRejectedValueOnce(new Error("new-session failed: bad cwd"));
    vi.mocked(tmux.isDuplicateSessionError).mockReturnValue(false);

    await expect(ensureSessionReady(makeInstance())).rejects.toThrow("new-session failed");
    expect(tmux.killSession).toHaveBeenCalledWith("ccdash-abc123");
  });

  it("preserves a session whose marker reads 'launching' - a provider launch that may be live", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("present");
    vi.mocked(tmux.isSessionInitIncomplete).mockResolvedValue("confirmed-launching");
    await ensureSessionReady(makeInstance({ shellOnly: false }));
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.enableMouseMode).toHaveBeenCalledWith("ccdash-abc123");
  });

  it("recreates a session confirmed incomplete (marker reads 'created'), killing it first", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("present");
    vi.mocked(tmux.isSessionInitIncomplete).mockResolvedValue("confirmed-incomplete");
    vi.mocked(tmux.killSession).mockResolvedValue(undefined);
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);

    await ensureSessionReady(makeInstance({ shellOnly: true }));

    expect(tmux.killSession).toHaveBeenCalledWith("ccdash-abc123");
    expect(tmux.createSession).toHaveBeenCalledWith("ccdash-abc123", "/tmp/test-instance");
    expect(tmux.markSessionInitComplete).toHaveBeenCalledWith("ccdash-abc123");
  });

  it("still recreates a confirmed-incomplete session even if it vanished on its own before the kill (killSession throwing is tolerated)", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("present");
    vi.mocked(tmux.isSessionInitIncomplete).mockResolvedValue("confirmed-incomplete");
    vi.mocked(tmux.killSession).mockRejectedValueOnce(new Error("no such session"));
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);

    await expect(ensureSessionReady(makeInstance({ shellOnly: true }))).resolves.toBeUndefined();
    expect(tmux.createSession).toHaveBeenCalledTimes(1);
  });

  // The core safety invariant this whole mechanism exists to protect: a probe that could not
  // definitively confirm the session's state must NEVER be treated as license to destroy it -
  // this is what the first (rejected) design attempt got wrong, and it must surface as an
  // ordinary recoverable attach failure instead (the caller retries; see closeCodeForAttachError).
  it("never kills or recreates when session presence itself could not be confirmed - surfaces as a recoverable error instead", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("unknown");

    await expect(ensureSessionReady(makeInstance())).rejects.toThrow();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("best-effort cleanup: a killSession failure after an init failure does not mask the original error", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    vi.mocked(tmux.createSession).mockRejectedValueOnce(new Error("new-session failed"));
    vi.mocked(tmux.killSession).mockRejectedValueOnce(new Error("kill-session also failed"));

    await expect(ensureSessionReady(makeInstance())).rejects.toThrow("new-session failed");
  });

  it("a second concurrent call for the same tmux session joins the first instead of re-running getSessionPresence/createSession", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("absent");
    const createDeferredResult = createDeferred<void>();
    vi.mocked(tmux.createSession).mockReturnValue(createDeferredResult.promise);

    const instance = makeInstance({ shellOnly: true });
    const first = ensureSessionReady(instance);
    // Fired synchronously, before getSessionPresence/createSession's promises have even
    // resolved: this is exactly the race the in-flight map (set synchronously, before any
    // await) has to survive.
    const second = ensureSessionReady(instance);

    createDeferredResult.resolve();
    await Promise.all([first, second]);

    expect(tmux.getSessionPresence).toHaveBeenCalledTimes(1);
    expect(tmux.createSession).toHaveBeenCalledTimes(1);
  });

  it("a call after the in-flight one has settled starts a fresh check, not a stale join", async () => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("present");
    vi.mocked(tmux.isSessionInitIncomplete).mockResolvedValue("not-confirmed-incomplete");
    const instance = makeInstance();
    await ensureSessionReady(instance);
    await ensureSessionReady(instance);
    expect(tmux.getSessionPresence).toHaveBeenCalledTimes(2);
  });
});

// The parameterised sequence POST /api/instances (routes.ts) reuses. The attach path exercises
// it via ensureSessionReady above; these cover the `onSessionCreated` hook routes.ts wedges in
// to persist the instance between "session exists" and "provider launched".
describe("initializeInstanceSession (onSessionCreated hook)", () => {
  it("runs the hook after createSession and before markSessionLaunching / sendCommandToSession", async () => {
    const calls: string[] = [];
    vi.mocked(tmux.createSession).mockImplementation(async () => {
      calls.push("createSession");
    });
    vi.mocked(tmux.markSessionLaunching).mockImplementation(async () => {
      calls.push("markSessionLaunching");
    });
    vi.mocked(tmux.sendCommandToSession).mockImplementation(async () => {
      calls.push("sendCommandToSession");
    });

    await initializeInstanceSession(makeInstance({ shellOnly: false }), async () => {
      calls.push("hook");
    });
    expect(calls).toEqual(["createSession", "hook", "markSessionLaunching", "sendCommandToSession"]);
  });

  it("treats a hook failure as a pre-launch failure: kills the session and propagates", async () => {
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    vi.mocked(tmux.isDuplicateSessionError).mockReturnValue(false);

    await expect(
      initializeInstanceSession(makeInstance({ shellOnly: false }), async () => {
        throw new Error("saveState failed");
      })
    ).rejects.toThrow("saveState failed");
    expect(tmux.killSession).toHaveBeenCalledWith("ccdash-abc123");
    expect(tmux.sendCommandToSession).not.toHaveBeenCalled();
  });

  it("does NOT kill when the launch fails after the hook already ran (a live agent may be in the session)", async () => {
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    vi.mocked(tmux.markSessionLaunching).mockResolvedValue(undefined);
    vi.mocked(tmux.sendCommandToSession).mockRejectedValueOnce(new Error("tmux command timed out"));
    const hook = vi.fn(async () => {});

    await expect(initializeInstanceSession(makeInstance({ shellOnly: false }), hook)).rejects.toThrow(
      "tmux command timed out"
    );
    expect(hook).toHaveBeenCalledTimes(1);
    expect(tmux.killSession).not.toHaveBeenCalled();
  });
});

describe("validateTerminalSize", () => {
  it("accepts ordinary positive integer dimensions", () => {
    expect(validateTerminalSize(120, 32)).toEqual({ cols: 120, rows: 32 });
  });

  it("accepts a large but realistic xterm.js viewport", () => {
    // A 4K display at a very small font is still nowhere close to the per-axis or
    // cell-count cap; this is the case A4's fix must not regress while closing off Infinity.
    expect(validateTerminalSize(600, 200)).toEqual({ cols: 600, rows: 200 });
  });

  // This is the exact exploit: typeof Infinity === "number" and Infinity > 0 both pass a
  // naive check, and node-pty's UnixTerminal.prototype.resize throws explicitly for it -
  // an exception any connected tab could previously trigger on demand, uncontained.
  it("rejects Infinity on either axis", () => {
    expect(validateTerminalSize(Infinity, 24)).toBeNull();
    expect(validateTerminalSize(80, Infinity)).toBeNull();
  });

  it("rejects NaN, zero, negative, and non-integer values", () => {
    expect(validateTerminalSize(NaN, 24)).toBeNull();
    expect(validateTerminalSize(80, 0)).toBeNull();
    expect(validateTerminalSize(-10, 24)).toBeNull();
    expect(validateTerminalSize(80.5, 24)).toBeNull();
  });

  it("rejects non-number types", () => {
    expect(validateTerminalSize("80", 24)).toBeNull();
    expect(validateTerminalSize(undefined, 24)).toBeNull();
    expect(validateTerminalSize(null, 24)).toBeNull();
  });

  it("rejects a single axis over the per-axis cap even when the other axis is tiny", () => {
    expect(validateTerminalSize(1_000_000, 1)).toBeNull();
  });

  // The bound this specifically guards against: two individually-plausible axes whose
  // PRODUCT is still enormous (100 million cells), which axis-only caps would let through
  // straight into tmux's own grid allocation and redraw cost.
  it("rejects a geometry whose cell count exceeds the budget even when both axes individually pass", () => {
    expect(validateTerminalSize(1_999, 1_999)).toBeNull();
  });
});

describe("closeSocketSafely", () => {
  function fakeSocket(overrides: Partial<{ readyState: number; close: () => void; terminate: () => void }> = {}) {
    return {
      OPEN: 1,
      CONNECTING: 0,
      CLOSED: 3,
      readyState: 1,
      close: vi.fn(),
      terminate: vi.fn(),
      ...overrides,
    };
  }

  it("closes an open socket with the given code and reason", () => {
    const socket = fakeSocket();
    closeSocketSafely(socket as never, 4001, "tmux session ended");
    expect(socket.close).toHaveBeenCalledWith(4001, "tmux session ended");
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("does nothing to a socket that is already closed", () => {
    const socket = fakeSocket({ readyState: 3 });
    closeSocketSafely(socket as never, 4001, "reason");
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  // The bug this exists to prevent: `ws` throws a RangeError from close() when the reason
  // exceeds its 123-byte budget (see truncateCloseReason in attachErrors.ts), which used to
  // happen INSIDE the catch block that existed to report the original failure, turning a
  // recoverable attach error into an unhandled rejection capable of crashing the process.
  it("truncates an oversized reason so close() never throws on the reason's length", () => {
    const socket = fakeSocket({
      close: vi.fn(() => {
        throw new RangeError("The message must not be greater than 123 bytes");
      }),
    });
    expect(() => closeSocketSafely(socket as never, 4006, "x".repeat(500))).not.toThrow();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("falls back to terminate() when close() throws for any other reason, and swallows a terminate() failure too", () => {
    const socket = fakeSocket({
      close: vi.fn(() => {
        throw new Error("already closing");
      }),
      terminate: vi.fn(() => {
        throw new Error("terminate also failed");
      }),
    });
    // Must never throw out to the caller: this is the last line of defense against a single
    // broken socket taking down the whole process.
    expect(() => closeSocketSafely(socket as never, 1011, "reason")).not.toThrow();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("bridgeTerminal", () => {
  // A session that already exists and is not confirmed incomplete is the simplest path
  // through bridgeTerminal: it skips createSession/sendCommandToSession entirely and goes
  // straight to spawning the pty, which is all these tests care about. locationPath must be a
  // real, existing directory - pathExists() is not mocked here (unlike ./tmux and
  // @lydell/node-pty), so os.tmpdir() stands in for "the folder exists" without needing a
  // filesystem mock.
  function makeReadyInstance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
    return makeInstance({ locationPath: os.tmpdir(), shellOnly: true, ...overrides });
  }

  beforeEach(() => {
    vi.mocked(tmux.getSessionPresence).mockResolvedValue("present");
    vi.mocked(tmux.isSessionInitIncomplete).mockResolvedValue("not-confirmed-incomplete");
    vi.mocked(tmux.enableMouseMode).mockResolvedValue(undefined);
  });

  // This is the regression test the audit called out by name (round 2, finding "the proposed
  // integration test does not actually exercise the PTY error requirement"): the crash this
  // guards against originates from node-pty's OWN internal stream-error rethrow (see
  // unixTerminal.js), not from anything socket-related, so forcing a socket-level error would
  // pass even with the pty "error" listener missing entirely. This drives the pty's real
  // internal error path instead.
  it("contains a post-bridge pty stream error: closes only this socket, releases the pty, survives", async () => {
    const fakePty = makeFakePty();
    vi.mocked(nodePty.spawn).mockReturnValue(fakePty as never);
    const socket = makeFakeSocket();
    const instance = makeReadyInstance();

    await bridgeTerminal(socket as never, instance, null, makeNoopAttachBuffer(), () => {});

    fakePty._emitError(new Error("EIO: input/output error, read"));

    expect(socket.close).toHaveBeenCalledWith(1011, "EIO: input/output error, read");
    expect(fakePty.destroy).toHaveBeenCalledTimes(1);
  });

  // Strict separation between what console sees and what the client sees (see teardownAttach's
  // header comment): the close reason must stay message-only, while the console line carries
  // the richer describeError detail (here, the stack) that must never reach the socket.
  it("keeps the WebSocket close reason short while the console log carries the full stack detail", async () => {
    const fakePty = makeFakePty();
    vi.mocked(nodePty.spawn).mockReturnValue(fakePty as never);
    const socket = makeFakeSocket();
    // A distinct instance id, not shared with any other test in this file: attachErrors.ts's
    // failure-throttle state is module-level (see recordAttachFailure), so reusing an id another
    // test already failed for within the same 60s window would silently suppress this line.
    const instance = makeReadyInstance({ id: "stack-detail-separation-test" });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await bridgeTerminal(socket as never, instance, null, makeNoopAttachBuffer(), () => {});
    const error = new Error("EIO: input/output error, read");
    fakePty._emitError(error);

    const [, closeReason] = socket.close.mock.calls[0] as [number, string];
    expect(closeReason).toBe("EIO: input/output error, read");
    expect(closeReason).not.toContain("at ");

    const loggedLine = consoleErrorSpy.mock.calls.map((args) => String(args.join(" "))).join("\n");
    expect(loggedLine).toContain("stack=");
    consoleErrorSpy.mockRestore();
  });

  it("contains a malformed live resize (Infinity) instead of letting it reach node-pty's resize()", async () => {
    const fakePty = makeFakePty();
    vi.mocked(nodePty.spawn).mockReturnValue(fakePty as never);
    const socket = makeFakeSocket();
    const instance = makeReadyInstance();

    await bridgeTerminal(socket as never, instance, null, makeNoopAttachBuffer(), () => {});

    // The exact exploit: typeof Infinity === "number" and Infinity > 0 both passed the old
    // guard, and node-pty's resize() throws explicitly for infinite dimensions.
    socket._emitMessage(JSON.stringify({ type: "resize", cols: Infinity, rows: 24 }));

    // Silently rejected by validateTerminalSize before ever reaching attachProcess.resize():
    // the terminal is neither resized nor torn down over an invalid resize message alone.
    expect(fakePty.resize).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("contains a throw from attachProcess.resize() itself without crashing the process", async () => {
    const fakePty = makeFakePty();
    fakePty.resize.mockImplementation(() => {
      throw new Error("resizing must be done using positive cols and rows");
    });
    vi.mocked(nodePty.spawn).mockReturnValue(fakePty as never);
    const socket = makeFakeSocket();
    const instance = makeReadyInstance();

    await bridgeTerminal(socket as never, instance, null, makeNoopAttachBuffer(), () => {});

    expect(() => socket._emitMessage(JSON.stringify({ type: "resize", cols: 80, rows: 24 }))).not.toThrow();
    expect(socket.close).toHaveBeenCalledWith(1011, "resizing must be done using positive cols and rows");
    expect(fakePty.destroy).toHaveBeenCalledTimes(1);
  });

  it("contains a throw from socket.send() inside the pty's onData callback", async () => {
    const fakePty = makeFakePty();
    vi.mocked(nodePty.spawn).mockReturnValue(fakePty as never);
    const socket = makeFakeSocket();
    socket.send.mockImplementation(() => {
      throw new Error("write after end");
    });
    const instance = makeReadyInstance();

    await bridgeTerminal(socket as never, instance, null, makeNoopAttachBuffer(), () => {});

    expect(() => fakePty._emitData("output chunk")).not.toThrow();
    expect(socket.close).toHaveBeenCalledWith(1011, "write after end");
    expect(fakePty.destroy).toHaveBeenCalledTimes(1);
  });

  it("delivers ordinary input and a valid resize normally, unaffected by the new guards", async () => {
    const fakePty = makeFakePty();
    vi.mocked(nodePty.spawn).mockReturnValue(fakePty as never);
    const socket = makeFakeSocket();
    const instance = makeReadyInstance();

    await bridgeTerminal(socket as never, instance, null, makeNoopAttachBuffer(), () => {});

    socket._emitMessage(JSON.stringify({ type: "input", data: "ls\n" }));
    socket._emitMessage(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));

    expect(fakePty.write).toHaveBeenCalledWith("ls\n");
    expect(fakePty.resize).toHaveBeenCalledWith(100, 40);
    expect(socket.close).not.toHaveBeenCalled();
  });
});
