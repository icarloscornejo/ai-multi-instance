import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsDependencyInstall } from "./updateTransaction";

describe("needsDependencyInstall", () => {
  it("needs install when there is no receipt yet", () => {
    expect(needsDependencyInstall("hash-a", null)).toBe(true);
  });

  it("needs install when the lockfile hash changed since the receipt", () => {
    expect(needsDependencyInstall("hash-b", "hash-a")).toBe(true);
  });

  it("skips install when the receipt already matches the current lockfile", () => {
    expect(needsDependencyInstall("hash-a", "hash-a")).toBe(false);
  });
});

// Exercises the actual `proper-lockfile` package with the same shape of options
// runUpdateTransaction uses (short retries here only to keep the test fast), against a real temp
// file - this is precisely the primitive rounds 6-7 of review doubted a hand-rolled PID-based lock
// could get right, so it's worth confirming the real dependency behaves as assumed rather than
// trusting the plan's description of it.
describe("proper-lockfile concurrency (the primitive updateTransaction.ts relies on)", () => {
  let lockTarget: string;

  beforeEach(() => {
    const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), "update-transaction-lock-test-"));
    lockTarget = path.join(dir, "transaction.lock");
    fs.writeFileSync(lockTarget, "");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(lockTarget), { recursive: true, force: true });
  });

  it("a second acquisition attempt fails while the first holder still has it locked", async () => {
    const release = await lockfile.lock(lockTarget, { stale: 5000 });
    await expect(lockfile.lock(lockTarget, { retries: 0 })).rejects.toThrow();
    await release();
  });

  it("a second attempt succeeds once the first holder releases", async () => {
    const release = await lockfile.lock(lockTarget, { stale: 5000 });
    await release();
    const secondRelease = await lockfile.lock(lockTarget, { retries: 0 });
    await secondRelease();
  });

  it("a lock left behind by a crashed holder is reclaimed via staleness, not held forever", async () => {
    // Simulates the crash case directly, instead of trying to wait it out in-process: proper-
    // lockfile's own auto-refresh timer has a hard-coded 1000ms floor
    // (`options.update = Math.max(Math.min(options.update, options.stale / 2), 1000)` in
    // lib/lockfile.js) that keeps a live holder's lock fresh no matter how large an `update` value
    // is requested, so a real holder in this same test process can never be made to go stale just
    // by waiting - only a holder that is well and truly gone (no timer left running) can. This
    // creates the lock directory by hand with a backdated mtime, exactly what's left on disk after
    // a process dies mid-transaction without ever calling release().
    const lockDir = `${lockTarget}.lock`;
    fs.mkdirSync(lockDir);
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, longAgo, longAgo);

    // proper-lockfile also floors `stale` itself at 2000ms regardless of what's passed in
    // (`options.stale = Math.max(options.stale || 0, 2000)`), so a lock backdated by a full minute
    // is unambiguously stale under any configuration.
    const release = await lockfile.lock(lockTarget, { stale: 2000 });
    await release();
  });
});
