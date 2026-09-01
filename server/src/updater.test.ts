import { describe, expect, it } from "vitest";
import { classifyRestartKind, isMajorBump } from "./updater";

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

describe("classifyRestartKind", () => {
  it("returns none for no changed paths", () => {
    expect(classifyRestartKind([], false)).toBe("none");
    expect(classifyRestartKind([], true)).toBe("none");
  });

  it("unsupervised: a server/src/-only change is auto, tsx watch already restarted it", () => {
    expect(classifyRestartKind(["server/src/index.ts", "server/src/routes.ts"], false)).toBe("auto");
  });

  it("supervised: the same server/src/-only change is manual, tsx watch is not running", () => {
    expect(classifyRestartKind(["server/src/index.ts", "server/src/routes.ts"], true)).toBe("manual");
  });

  it("unsupervised: a frontend-build-only change is auto", () => {
    expect(classifyRestartKind(["web/src/App.tsx"], false)).toBe("auto");
  });

  it("supervised: a frontend-build-only change stays auto, it never touched server/src", () => {
    expect(classifyRestartKind(["web/src/App.tsx"], true)).toBe("auto");
  });

  it("supervised: a mixed server/src and frontend change is manual", () => {
    expect(classifyRestartKind(["server/src/index.ts", "web/src/App.tsx"], true)).toBe("manual");
  });

  it("any change outside server/src and the frontend build is manual, in both modes", () => {
    expect(classifyRestartKind(["package.json"], false)).toBe("manual");
    expect(classifyRestartKind(["package.json"], true)).toBe("manual");
  });

  it("defaults to the real environment's supervised state when omitted", () => {
    const previous = process.env.AI_MULTI_INSTANCE_SUPERVISED;
    try {
      delete process.env.AI_MULTI_INSTANCE_SUPERVISED;
      expect(classifyRestartKind(["server/src/index.ts"])).toBe("auto");
      process.env.AI_MULTI_INSTANCE_SUPERVISED = "1";
      expect(classifyRestartKind(["server/src/index.ts"])).toBe("manual");
    } finally {
      if (previous === undefined) {
        delete process.env.AI_MULTI_INSTANCE_SUPERVISED;
      } else {
        process.env.AI_MULTI_INSTANCE_SUPERVISED = previous;
      }
    }
  });
});
