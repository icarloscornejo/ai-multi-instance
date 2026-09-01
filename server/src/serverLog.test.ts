import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCrashLine, trimLogIfOversized } from "./serverLog";

describe("formatCrashLine", () => {
  it("includes the full stack for a real Error, not just its message", () => {
    const error = new Error("boom");
    const line = formatCrashLine("uncaughtException", error);
    expect(line).toContain("Error: boom");
    expect(line).toContain(error.stack?.split("\n")[1]?.trim() ?? "at ");
  });

  it("produces something useful for a thrown string", () => {
    const line = formatCrashLine("unhandledRejection", "rejected with a plain string");
    expect(line).toContain("rejected with a plain string");
  });

  it("produces something useful for a thrown plain object", () => {
    const line = formatCrashLine("unhandledRejection", { code: "EXPLODED", detail: "nested" });
    expect(line).toContain("EXPLODED");
    expect(line).toContain("nested");
  });

  it("produces something useful for undefined", () => {
    const line = formatCrashLine("unhandledRejection", undefined);
    expect(line).toContain("unhandledRejection");
    expect(line).toContain("undefined");
  });
});

describe("trimLogIfOversized", () => {
  // An injected path into a real temp directory, rather than vi.mock("node:fs"): tunnel.test.ts
  // mocks fs specifically to avoid clobbering the real cloudflared.log, but that would also mean
  // never actually exercising the trim's read/write logic. A real temp file gets isolation without
  // giving that up.
  let tempDirectory: string;

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("leaves a file under the cap untouched", () => {
    tempDirectory = mkdtempSync(path.join(os.tmpdir(), "server-log-test-"));
    const logPath = path.join(tempDirectory, "server.log");
    writeFileSync(logPath, "small content\n");

    trimLogIfOversized(logPath, 1024, 256);

    expect(readFileSync(logPath, "utf8")).toBe("small content\n");
  });

  it("trims an oversized file down to its tail, keeping the most recent bytes", () => {
    tempDirectory = mkdtempSync(path.join(os.tmpdir(), "server-log-test-"));
    const logPath = path.join(tempDirectory, "server.log");
    const oldPart = "A".repeat(2000);
    const recentPart = "B".repeat(500);
    writeFileSync(logPath, oldPart + recentPart);

    trimLogIfOversized(logPath, 1000, 500);

    const result = readFileSync(logPath, "utf8");
    expect(result).toContain("--- trimmed");
    expect(result).toContain(recentPart);
    expect(result).not.toContain(oldPart);
    expect(statSync(logPath).size).toBeLessThan(2500);
  });

  it("does nothing when the file does not exist yet", () => {
    tempDirectory = mkdtempSync(path.join(os.tmpdir(), "server-log-test-"));
    const logPath = path.join(tempDirectory, "does-not-exist.log");

    expect(() => trimLogIfOversized(logPath, 1024, 256)).not.toThrow();
  });
});
