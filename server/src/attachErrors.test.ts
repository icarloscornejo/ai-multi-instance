import { beforeEach, describe, expect, it } from "vitest";
import {
  AttachCancelledError,
  LocationMissingError,
  LOG_WINDOW_MS,
  PtySpawnError,
  TooManyPtysError,
  _resetAttachLogStateForTests,
  closeCodeForAttachError,
  describeError,
  isRetriableSpawnError,
  recordAttachFailure,
  recordAttachSuccess,
  shortErrorMessage,
  truncateCloseReason,
  type Clock,
} from "./attachErrors";

function fakeClock(startAt = 0): Clock & { advance: (ms: number) => void; set: (ms: number) => void } {
  let current = startAt;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

beforeEach(() => {
  _resetAttachLogStateForTests();
});

describe("closeCodeForAttachError", () => {
  // LocationMissingError used to get its own non-recoverable code (4005): a folder deleted,
  // unmounted, or renamed was assumed to "never come back without user action". That
  // assumption was wrong - remounting the drive or undoing the rename fixes it with zero
  // client-side action - so it now gets the same recoverable code as everything else.
  it("maps every pre-bridge error, including LocationMissingError, to 4006 (recoverable slow retry)", () => {
    expect(closeCodeForAttachError(new LocationMissingError("gone"))).toBe(4006);
    expect(closeCodeForAttachError(new PtySpawnError("posix_spawnp failed.", 4))).toBe(4006);
    expect(closeCodeForAttachError(new TooManyPtysError("too many ptys"))).toBe(4006);
    expect(closeCodeForAttachError(new Error("something nobody anticipated"))).toBe(4006);
  });
});

describe("isRetriableSpawnError", () => {
  it("retries the diagnosed node-pty spawn failure message", () => {
    expect(isRetriableSpawnError(new Error("posix_spawnp failed."))).toBe(true);
  });

  it("retries known resource-exhaustion errno codes", () => {
    for (const code of ["EMFILE", "ENFILE", "EAGAIN"]) {
      const error = new Error("spawn failed") as NodeJS.ErrnoException;
      error.code = code;
      expect(isRetriableSpawnError(error)).toBe(true);
    }
  });

  it("does not retry an unrelated error", () => {
    expect(isRetriableSpawnError(new Error("spawn tmux ENOENT"))).toBe(false);
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    expect(isRetriableSpawnError(error)).toBe(false);
  });

  it("does not retry non-Error values", () => {
    expect(isRetriableSpawnError("posix_spawnp failed.")).toBe(false);
    expect(isRetriableSpawnError(null)).toBe(false);
  });
});

describe("attach failure/recovery logging", () => {
  it("logs the first failure and suppresses further failures within the window", () => {
    const clock = fakeClock();
    const first = recordAttachFailure("abc123", "posix_spawnp failed.", clock);
    expect(first).not.toBeNull();
    expect(first).toContain("abc123");
    expect(first).toContain("posix_spawnp failed.");

    clock.advance(1_000);
    expect(recordAttachFailure("abc123", "posix_spawnp failed.", clock)).toBeNull();
    clock.advance(LOG_WINDOW_MS - 2_000);
    expect(recordAttachFailure("abc123", "posix_spawnp failed.", clock)).toBeNull();
  });

  it("logs again once the failure window has passed", () => {
    const clock = fakeClock();
    recordAttachFailure("abc123", "posix_spawnp failed.", clock);
    clock.advance(LOG_WINDOW_MS + 1);
    expect(recordAttachFailure("abc123", "posix_spawnp failed.", clock)).not.toBeNull();
  });

  it("logs a recovery line once, after a failure episode", () => {
    const clock = fakeClock();
    recordAttachFailure("abc123", "x", clock);
    recordAttachFailure("abc123", "x", clock);
    const recovery = recordAttachSuccess("abc123", clock);
    expect(recovery).not.toBeNull();
    expect(recovery).toContain("2 failed attempts");
  });

  it("a success with no open episode logs nothing", () => {
    const clock = fakeClock();
    expect(recordAttachSuccess("never-failed", clock)).toBeNull();
  });

  it("a recovery immediately after a failure IS logged (recovery has its own window, not suppressed by the failure's)", () => {
    const clock = fakeClock();
    recordAttachFailure("abc123", "x", clock);
    clock.advance(5); // a few ms later, well inside the failure's own 60s window
    expect(recordAttachSuccess("abc123", clock)).not.toBeNull();
  });

  it("success never clears the failure window: reopening an episode right after a success does not re-log within the window", () => {
    const clock = fakeClock();
    recordAttachFailure("abc123", "x", clock); // logs (1st in window)
    recordAttachSuccess("abc123", clock); // recovers
    clock.advance(1_000);
    // A fresh failure inside the ORIGINAL 60s window must stay suppressed - this is what
    // stops two tabs alternating failure/success on the same instanceId from spamming.
    expect(recordAttachFailure("abc123", "x", clock)).toBeNull();
  });

  it("interleaved failure(A) -> success(B) -> failure(A) on the same instanceId logs exactly one failure and one recovery within the window", () => {
    // Models two concurrent sockets for the same instance: one keeps failing while another
    // succeeds moments later. The success must not cause the later failure to re-log.
    const clock = fakeClock();
    const firstFailure = recordAttachFailure("shared", "x", clock);
    const recovery = recordAttachSuccess("shared", clock);
    clock.advance(2_000);
    const secondFailure = recordAttachFailure("shared", "x", clock);

    expect(firstFailure).not.toBeNull();
    expect(recovery).not.toBeNull();
    expect(secondFailure).toBeNull();
  });

  it("evicts entries that only ever failed once the retention window has passed, without producing duplicate logs within a 60s window across eviction", () => {
    const clock = fakeClock();
    for (let i = 0; i < 50; i += 1) {
      recordAttachFailure(`only-fails-${i}`, "x", clock);
    }
    clock.advance(LOG_WINDOW_MS * 4); // past LOG_RETENTION_MS, and these IDs never touched again
    // Trigger a sweep via any call
    recordAttachFailure("trigger-sweep", "x", clock);

    // Re-failing a previously-evicted, always-failing ID must log again (a genuinely fresh
    // episode after real silence), and must not somehow log twice within the new window.
    const relogged = recordAttachFailure("only-fails-0", "x", clock);
    expect(relogged).not.toBeNull();
    clock.advance(1_000);
    expect(recordAttachFailure("only-fails-0", "x", clock)).toBeNull();
  });

  it("appends buildDetail's output only when a line is actually emitted, never on a suppressed failure", () => {
    const clock = fakeClock();
    let calls = 0;
    const buildDetail = () => {
      calls += 1;
      return "detail-1";
    };
    const first = recordAttachFailure("abc123", "x", clock, buildDetail);
    expect(first).toContain("detail-1");
    expect(calls).toBe(1);

    // Suppressed by the throttle - buildDetail must not even run (cost, and correctness: a
    // suppressed failure has no log line to append the detail to).
    clock.advance(1_000);
    recordAttachFailure("abc123", "x", clock, buildDetail);
    expect(calls).toBe(1);
  });

  it("still emits the failure line, with a snapshotError note, when buildDetail itself throws", () => {
    // The worst possible outcome here would be consuming the throttle window and returning
    // null anyway - losing 60s of diagnosis to exactly the kind of hostile/broken input this
    // detail-gathering exists to survive.
    const clock = fakeClock();
    const line = recordAttachFailure("abc123", "posix_spawnp failed.", clock, () => {
      throw new Error("snapshot blew up");
    });
    expect(line).not.toBeNull();
    expect(line).toContain("posix_spawnp failed.");
    expect(line).toContain("snapshotError=snapshot blew up");
  });

  it("does not evict an ongoing outage: continued failures inside the retention window keep refreshing lastTouchedAt", () => {
    const clock = fakeClock();
    recordAttachFailure("ongoing", "x", clock); // logs
    // Keep failing at an interval shorter than LOG_RETENTION_MS, well past LOG_WINDOW_MS
    // total, so the failure line itself would re-log, but the entry must never be evicted
    // mid-outage (only true silence for LOG_RETENTION_MS should evict it).
    for (let i = 0; i < 5; i += 1) {
      clock.advance(LOG_WINDOW_MS);
      recordAttachFailure("ongoing", "x", clock);
    }
    // Still the same continuous episode: a success now must report a recovery (proves the
    // entry, and its episodeOpen state, survived the whole stretch without being evicted).
    expect(recordAttachSuccess("ongoing", clock)).not.toBeNull();
  });
});

describe("error classes", () => {
  it("AttachCancelledError and friends are plain Error subclasses usable with instanceof", () => {
    expect(new AttachCancelledError("cancelled")).toBeInstanceOf(Error);
    expect(new PtySpawnError("x", 3).attempts).toBe(3);
  });

  it("PtySpawnError carries the per-attempt history, defaulting to empty for old-style callers", () => {
    expect(new PtySpawnError("x", 3).attemptDetails).toEqual([]);
    const detail = { attemptIndex: 1, durationMs: 5, message: "EMFILE", code: "EMFILE" };
    expect(new PtySpawnError("x", 1, [detail]).attemptDetails).toEqual([detail]);
  });
});

describe("describeError", () => {
  it("includes the whitelisted fields of a plain Error, including stack", () => {
    const error = new Error("boom");
    const described = describeError(error);
    expect(described).toContain("message=boom");
    expect(described).toContain("stack=");
  });

  it("includes errno-style fields (code, errno, syscall, path)", () => {
    const error = new Error("spawn failed") as NodeJS.ErrnoException;
    error.code = "EMFILE";
    error.errno = -24;
    error.syscall = "spawn";
    error.path = "/usr/bin/tmux";
    const described = describeError(error);
    expect(described).toContain("code=EMFILE");
    expect(described).toContain("errno=-24");
    expect(described).toContain("syscall=spawn");
    expect(described).toContain("path=/usr/bin/tmux");
  });

  it("includes a PtySpawnError's full attempt history, not just the final message", () => {
    const error = new PtySpawnError("posix_spawnp failed.", 2, [
      { attemptIndex: 1, durationMs: 10, message: "EMFILE", code: "EMFILE" },
      { attemptIndex: 2, durationMs: 12, message: "posix_spawnp failed." },
    ]);
    const described = describeError(error);
    expect(described).toContain("attemptIndex=1");
    expect(described).toContain("code=EMFILE");
    expect(described).toContain("attemptIndex=2");
  });

  it("walks a cause chain up to its depth limit", () => {
    const root = new Error("root cause");
    const middle = new Error("middle", { cause: root });
    const top = new Error("top", { cause: middle });
    const described = describeError(top);
    expect(described).toContain("message=top");
    expect(described).toContain("message=middle");
    expect(described).toContain("message=root cause");
  });

  it("never throws and never recurses forever on a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(() => describeError(a)).not.toThrow();
    expect(describeError(a).length).toBeGreaterThan(0);
  });

  it("never throws when a property getter on the error itself throws", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(() => describeError(hostile)).not.toThrow();
    expect(describeError(hostile)).toContain("message=hostile");
  });

  it("never throws for a Proxy whose property access always throws", () => {
    const hostile = new Proxy(new Error("proxied"), {
      get() {
        throw new Error("proxy trap exploded");
      },
    });
    expect(() => describeError(hostile)).not.toThrow();
  });

  it("never throws and produces something readable for non-Error thrown values", () => {
    expect(() => describeError("a plain string")).not.toThrow();
    expect(() => describeError(42)).not.toThrow();
    expect(() => describeError(null)).not.toThrow();
    expect(() => describeError(undefined)).not.toThrow();
    expect(() => describeError(Symbol("weird"))).not.toThrow();
    expect(describeError("a plain string")).toContain("a plain string");
  });

  it("strips CR/LF so a hostile message cannot inject fake extra log lines", () => {
    const error = new Error("line one\nFAKE LOG LINE\r\nline three");
    const described = describeError(error);
    expect(described).not.toContain("\n");
    expect(described).not.toContain("\r");
  });

  it("truncates an enormous stack instead of producing an unbounded log line", () => {
    const error = new Error("boom");
    error.stack = "x".repeat(100_000);
    const described = describeError(error);
    expect(described.length).toBeLessThan(10_000);
  });
});

describe("shortErrorMessage", () => {
  it("returns an Error's message", () => {
    expect(shortErrorMessage(new Error("posix_spawnp failed."))).toBe("posix_spawnp failed.");
  });

  it("never includes stack, code, or cause - only the message", () => {
    const error = new Error("boom") as NodeJS.ErrnoException;
    error.code = "EMFILE";
    const short = shortErrorMessage(error);
    expect(short).toBe("boom");
    expect(short).not.toContain("EMFILE");
    expect(short).not.toContain("at ");
  });

  it("never throws for a Proxy whose message getter throws, falling back to a safe default", () => {
    const hostile = new Proxy(new Error("real message"), {
      get(target, prop) {
        if (prop === "message") {
          throw new Error("exploded");
        }
        return Reflect.get(target, prop);
      },
    });
    expect(() => shortErrorMessage(hostile)).not.toThrow();
  });

  it("strips CR/LF from the message", () => {
    expect(shortErrorMessage(new Error("line one\nline two"))).not.toContain("\n");
  });

  it("falls back to a safe default for non-Error values", () => {
    expect(shortErrorMessage(null)).toBe("unknown error");
    expect(shortErrorMessage(Symbol("weird"))).toBe("unknown error");
  });
});

describe("truncateCloseReason", () => {
  it("returns a short ASCII reason unchanged", () => {
    expect(truncateCloseReason("tmux session ended")).toBe("tmux session ended");
  });

  it("truncates a plain-ASCII reason over the byte budget to exactly the budget", () => {
    const longReason = "x".repeat(200);
    const truncated = truncateCloseReason(longReason, 123);
    expect(Buffer.byteLength(truncated, "utf8")).toBe(123);
  });

  // The bug this exists to fix: slicing by JS string length (UTF-16 code units) undercounts
  // real byte size for accented/multi-byte characters, so a 120-*character* slice could still
  // be well over the 123-*byte* limit `ws` enforces on close(), which used to make close()
  // itself throw from inside the very catch block meant to report the original error.
  it("stays within the byte budget for a reason full of multi-byte accented characters", () => {
    const accentedReason = "No se pudo abrir la carpeta: /Users/usuario/Área de Trabajo/ñoño".repeat(3);
    const truncated = truncateCloseReason(accentedReason, 123);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(123);
  });

  it("stays within the byte budget for a reason containing emoji (surrogate pairs, 4 bytes each)", () => {
    const emojiReason = "folder gone 📁🔥💥 " .repeat(10);
    const truncated = truncateCloseReason(emojiReason, 123);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(123);
  });

  it("never splits a multi-byte code point in half, producing only valid UTF-8", () => {
    // 61 copies of a 2-byte character is 122 bytes - one more character (2 more bytes) tips
    // it to 124, one over budget, forcing a truncation that must land BETWEEN characters.
    const reason = "ñ".repeat(62);
    const truncated = truncateCloseReason(reason, 123);
    // Buffer.from(...).toString("utf8") replaces any split/invalid code point with U+FFFD;
    // re-encoding a clean truncation must round-trip to the exact same byte length, while a
    // split one would shrink (the replacement character encodes differently) or otherwise
    // fail to round-trip.
    const roundTripped = Buffer.from(truncated, "utf8").toString("utf8");
    expect(roundTripped).toBe(truncated);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(123);
  });

  it("respects a custom maxBytes argument", () => {
    expect(Buffer.byteLength(truncateCloseReason("hello world", 5), "utf8")).toBeLessThanOrEqual(5);
  });
});
