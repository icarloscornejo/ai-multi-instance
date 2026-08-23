import { beforeEach, describe, expect, it } from "vitest";
import {
  AttachCancelledError,
  LocationMissingError,
  LOG_WINDOW_MS,
  PtySpawnError,
  TooManyPtysError,
  _resetAttachLogStateForTests,
  closeCodeForAttachError,
  isRetriableSpawnError,
  recordAttachFailure,
  recordAttachSuccess,
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
  it("maps LocationMissingError to 4005 (non-recoverable)", () => {
    expect(closeCodeForAttachError(new LocationMissingError("gone"))).toBe(4005);
  });

  it("maps PtySpawnError, TooManyPtysError, and a generic Error to 4006 (recoverable slow retry)", () => {
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
});
