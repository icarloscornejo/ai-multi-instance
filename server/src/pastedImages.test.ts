import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePastedImage } from "./pastedImages";

const UUID_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pasted-images-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("savePastedImage", () => {
  it("saves the bytes under a server-chosen UUID name with the right extension", async () => {
    const imageBytes: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const savedPath: string = await savePastedImage(imageBytes, "image/png", directory);

    expect(path.dirname(savedPath)).toBe(directory);
    expect(path.basename(savedPath)).toMatch(UUID_FILE_NAME);
    expect(await fs.readFile(savedPath)).toEqual(imageBytes);
  });

  it("creates the directory when it does not exist yet", async () => {
    const nestedDirectory: string = path.join(directory, "not", "there", "yet");

    const savedPath: string = await savePastedImage(Buffer.from("x"), "image/jpeg", nestedDirectory);

    expect(savedPath.endsWith(".jpg")).toBe(true);
    expect((await fs.stat(savedPath)).isFile()).toBe(true);
  });

  it("rejects a type Claude Code would not read as an image", async () => {
    await expect(savePastedImage(Buffer.from("x"), "image/tiff", directory)).rejects.toThrow(/Unsupported/);
  });

  it("deletes only files older than 7 days", async () => {
    const oldPath: string = path.join(directory, "old.png");
    const recentPath: string = path.join(directory, "recent.png");
    await fs.writeFile(oldPath, "old");
    await fs.writeFile(recentPath, "recent");
    const eightDaysAgo: Date = new Date(Date.now() - EIGHT_DAYS_MS);
    await fs.utimes(oldPath, eightDaysAgo, eightDaysAgo);

    await savePastedImage(Buffer.from("x"), "image/png", directory);

    await expect(fs.stat(oldPath)).rejects.toThrow();
    expect((await fs.stat(recentPath)).isFile()).toBe(true);
  });

  it("still saves the image when another paste already deleted the expired file", async () => {
    const oldPath: string = path.join(directory, "old.png");
    await fs.writeFile(oldPath, "old");
    const eightDaysAgo: Date = new Date(Date.now() - EIGHT_DAYS_MS);
    await fs.utimes(oldPath, eightDaysAgo, eightDaysAgo);
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));

    const savedPath: string = await savePastedImage(Buffer.from("x"), "image/png", directory);

    expect((await fs.stat(savedPath)).isFile()).toBe(true);
  });

  it("still saves the image when the cleanup fails for another reason", async () => {
    const oldPath: string = path.join(directory, "old.png");
    await fs.writeFile(oldPath, "old");
    const eightDaysAgo: Date = new Date(Date.now() - EIGHT_DAYS_MS);
    await fs.utimes(oldPath, eightDaysAgo, eightDaysAgo);
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const savedPath: string = await savePastedImage(Buffer.from("x"), "image/png", directory);

    expect((await fs.stat(savedPath)).isFile()).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
