import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceRecord } from "./types";

vi.mock("./tmux", () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  enableMouseMode: vi.fn(),
  sendCommandToSession: vi.fn(),
  killSession: vi.fn(),
}));

import * as tmux from "./tmux";
import { AttachCancelledError, PtySpawnError, ensureSessionReady, spawnWithRetry } from "./terminal";

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
  it("only enables mouse mode when the session already exists, without touching createSession", async () => {
    vi.mocked(tmux.hasSession).mockResolvedValue(true);
    await ensureSessionReady(makeInstance());
    expect(tmux.enableMouseMode).toHaveBeenCalledWith("ccdash-abc123");
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.sendCommandToSession).not.toHaveBeenCalled();
  });

  it("creates the session and launches the provider when it does not exist yet", async () => {
    vi.mocked(tmux.hasSession).mockResolvedValue(false);
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    vi.mocked(tmux.sendCommandToSession).mockResolvedValue(undefined);
    await ensureSessionReady(makeInstance({ shellOnly: false }));
    expect(tmux.createSession).toHaveBeenCalledWith("ccdash-abc123", "/tmp/test-instance");
    expect(tmux.sendCommandToSession).toHaveBeenCalledTimes(1);
  });

  it("skips the provider launch for a shell-only instance", async () => {
    vi.mocked(tmux.hasSession).mockResolvedValue(false);
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    await ensureSessionReady(makeInstance({ shellOnly: true }));
    expect(tmux.sendCommandToSession).not.toHaveBeenCalled();
  });

  // The round-4 review finding this guards against: a timeout (or any failure) firing
  // between new-session and the provider launch used to leave a session that "exists" but
  // was never handed a provider, and every future attach would see hasSession=true and
  // silently accept the empty session forever.
  it("kills a session that failed mid-initialization, so the next attempt recreates it fully instead of finding it half-done", async () => {
    vi.mocked(tmux.hasSession).mockResolvedValue(false);
    vi.mocked(tmux.createSession).mockResolvedValue(undefined);
    vi.mocked(tmux.sendCommandToSession).mockRejectedValueOnce(new Error("tmux command timed out"));

    await expect(ensureSessionReady(makeInstance({ shellOnly: false }))).rejects.toThrow("tmux command timed out");
    expect(tmux.killSession).toHaveBeenCalledWith("ccdash-abc123");

    // Simulate the kill having worked: hasSession now reports the session gone, and the
    // next attempt succeeds cleanly, recreating it (and this time launching the provider)
    // from scratch rather than inheriting the half-initialized state.
    vi.mocked(tmux.sendCommandToSession).mockResolvedValueOnce(undefined);
    await ensureSessionReady(makeInstance({ shellOnly: false }));
    expect(tmux.createSession).toHaveBeenCalledTimes(2);
    expect(tmux.sendCommandToSession).toHaveBeenCalledTimes(2);
  });

  it("best-effort cleanup: a killSession failure after an init failure does not mask the original error", async () => {
    vi.mocked(tmux.hasSession).mockResolvedValue(false);
    vi.mocked(tmux.createSession).mockRejectedValueOnce(new Error("new-session failed"));
    vi.mocked(tmux.killSession).mockRejectedValueOnce(new Error("kill-session also failed"));

    await expect(ensureSessionReady(makeInstance())).rejects.toThrow("new-session failed");
  });

  it("a second concurrent call for the same tmux session joins the first instead of re-running hasSession/createSession", async () => {
    vi.mocked(tmux.hasSession).mockResolvedValue(false);
    const createDeferredResult = createDeferred<void>();
    vi.mocked(tmux.createSession).mockReturnValue(createDeferredResult.promise);

    const instance = makeInstance({ shellOnly: true });
    const first = ensureSessionReady(instance);
    // Fired synchronously, before hasSession/createSession's promises have even resolved:
    // this is exactly the race the in-flight map (set synchronously, before any await) has
    // to survive.
    const second = ensureSessionReady(instance);

    createDeferredResult.resolve();
    await Promise.all([first, second]);

    expect(tmux.hasSession).toHaveBeenCalledTimes(1);
    expect(tmux.createSession).toHaveBeenCalledTimes(1);
  });

  it("a call after the in-flight one has settled starts a fresh check, not a stale join", async () => {
    vi.mocked(tmux.hasSession).mockResolvedValue(true);
    const instance = makeInstance();
    await ensureSessionReady(instance);
    await ensureSessionReady(instance);
    expect(tmux.hasSession).toHaveBeenCalledTimes(2);
  });
});
