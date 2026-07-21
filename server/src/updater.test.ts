import { describe, expect, it } from "vitest";
import { isMajorBump } from "./updater";

describe("isMajorBump", () => {
  it("detects a real major bump", () => {
    expect(isMajorBump("1.3.0", "2.0.0")).toBe(true);
  });

  it("returns false when the remote major is not ahead", () => {
    expect(isMajorBump("1.3.0", "1.9.9")).toBe(false);
    expect(isMajorBump("2.0.0", "1.9.9")).toBe(false);
  });

  it("returns false when majors are equal", () => {
    expect(isMajorBump("1.3.0", "1.4.0")).toBe(false);
  });

  it("returns false when either version is null", () => {
    expect(isMajorBump(null, "2.0.0")).toBe(false);
    expect(isMajorBump("1.3.0", null)).toBe(false);
    expect(isMajorBump(null, null)).toBe(false);
  });

  it("returns false for unparseable version strings", () => {
    expect(isMajorBump("abc", "2.0.0")).toBe(false);
    expect(isMajorBump("1.3.0", "")).toBe(false);
  });

  it("treats a prerelease bump on the major as a bump", () => {
    expect(isMajorBump("1.9.0", "2.0.0-beta.1")).toBe(true);
  });
});
