import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTmuxTmpdir, resolveWritableTmpdir } from "../../scripts/with-writable-tmpdir.mjs";

describe("resolveWritableTmpdir", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the first writable candidate as-is", () => {
    const writable = mkdtempSync(path.join(os.tmpdir(), "tmpdir-writable-"));
    cleanup.push(writable);

    expect(resolveWritableTmpdir({ TMPDIR: writable })).toBe(writable);
  });

  it("skips an unwritable TMPDIR and falls back to os.tmpdir()", () => {
    const unwritable = mkdtempSync(path.join(os.tmpdir(), "tmpdir-locked-"));
    chmodSync(unwritable, 0o500);
    cleanup.push(unwritable);

    const target = path.join(unwritable, "tsx-502");
    const resolved = resolveWritableTmpdir({ TMPDIR: target });

    expect(resolved).not.toBe(target);
    expect(resolved).toBeTruthy();
  });
});

describe("resolveTmuxTmpdir", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors an explicit writable TMUX_TMPDIR", () => {
    const explicit = mkdtempSync(path.join(os.tmpdir(), "tmux-explicit-"));
    cleanup.push(explicit);

    expect(resolveTmuxTmpdir({ TMUX_TMPDIR: explicit })).toBe(explicit);
  });

  it("falls back to a stable path under $HOME (never /tmp) when TMUX_TMPDIR is unset", () => {
    const resolved = resolveTmuxTmpdir({});

    expect(resolved).toBeTruthy();
    expect(resolved).toContain(os.homedir());
    expect(resolved?.startsWith("/tmp")).toBe(false);
    expect(resolved?.startsWith("/private/tmp")).toBe(false);
  });

  it("ignores an unwritable explicit TMUX_TMPDIR and uses the $HOME fallback", () => {
    const unwritable = mkdtempSync(path.join(os.tmpdir(), "tmux-locked-"));
    chmodSync(unwritable, 0o500);
    cleanup.push(unwritable);

    const resolved = resolveTmuxTmpdir({ TMUX_TMPDIR: path.join(unwritable, "tmux") });

    expect(resolved).toContain(os.homedir());
  });
});
