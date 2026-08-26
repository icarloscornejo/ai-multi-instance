import { describe, expect, it } from "vitest";
import {
  normalizeMobileScreen,
  persistRestoreTarget,
  readRestoreTarget,
  resolveRestoredScreen,
  type StorageLike,
} from "./mobileSession";

// A plain in-memory fake, not jsdom's sessionStorage: this repo's vitest config runs in node
// (see web/vite.config.ts, no `test.environment` set), so touching `window` isn't an option here.
function createFakeStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

describe("normalizeMobileScreen", () => {
  it("passes through 'terminal'", () => {
    expect(normalizeMobileScreen("terminal")).toBe("terminal");
  });

  it("defaults anything else (including 'home', garbage, undefined) to 'home'", () => {
    expect(normalizeMobileScreen("home")).toBe("home");
    expect(normalizeMobileScreen("garbage")).toBe("home");
    expect(normalizeMobileScreen(undefined)).toBe("home");
    expect(normalizeMobileScreen(null)).toBe("home");
    expect(normalizeMobileScreen(42)).toBe("home");
  });
});

describe("resolveRestoredScreen", () => {
  it("restores terminal when saved as terminal and the instance still exists", () => {
    expect(resolveRestoredScreen({ screen: "terminal", instanceId: "abc" }, true)).toBe("terminal");
  });

  it("degrades to home when saved as terminal but the instance no longer exists", () => {
    expect(resolveRestoredScreen({ screen: "terminal", instanceId: "abc" }, false)).toBe("home");
  });

  it("stays home when saved as home, regardless of instance existence", () => {
    expect(resolveRestoredScreen({ screen: "home", instanceId: null }, true)).toBe("home");
    expect(resolveRestoredScreen({ screen: "home", instanceId: null }, false)).toBe("home");
  });
});

describe("readRestoreTarget / persistRestoreTarget round-trip", () => {
  it("round-trips a full {screen, instanceId} target", () => {
    const storage = createFakeStorage();
    persistRestoreTarget(storage, { screen: "terminal", instanceId: "instance-a" });
    expect(readRestoreTarget(storage)).toEqual({ screen: "terminal", instanceId: "instance-a" });
  });

  it("returns home/null when nothing was ever saved", () => {
    const storage = createFakeStorage();
    expect(readRestoreTarget(storage)).toEqual({ screen: "home", instanceId: null });
  });

  it("two independent storages (simulating two tabs) never see each other's target", () => {
    const tabA = createFakeStorage();
    const tabB = createFakeStorage();
    persistRestoreTarget(tabA, { screen: "terminal", instanceId: "instance-a" });
    persistRestoreTarget(tabB, { screen: "terminal", instanceId: "instance-b" });
    expect(readRestoreTarget(tabA)).toEqual({ screen: "terminal", instanceId: "instance-a" });
    expect(readRestoreTarget(tabB)).toEqual({ screen: "terminal", instanceId: "instance-b" });
  });

  it("persisting a changed instance (A -> C) overwrites the previous target for that tab", () => {
    const storage = createFakeStorage();
    persistRestoreTarget(storage, { screen: "terminal", instanceId: "instance-a" });
    persistRestoreTarget(storage, { screen: "terminal", instanceId: "instance-c" });
    expect(readRestoreTarget(storage)).toEqual({ screen: "terminal", instanceId: "instance-c" });
  });

  it("falls back to home/null on corrupt JSON instead of throwing", () => {
    const storage = createFakeStorage({ "ccdash.mobileSession": "{not valid json" });
    expect(readRestoreTarget(storage)).toEqual({ screen: "home", instanceId: null });
  });

  it("falls back to home/null when the stored value isn't an object", () => {
    const storage = createFakeStorage({ "ccdash.mobileSession": '"just a string"' });
    expect(readRestoreTarget(storage)).toEqual({ screen: "home", instanceId: null });
  });

  it("normalizes a garbage instanceId (non-string, empty string) to null", () => {
    const storage = createFakeStorage({ "ccdash.mobileSession": JSON.stringify({ screen: "terminal", instanceId: 123 }) });
    expect(readRestoreTarget(storage)).toEqual({ screen: "terminal", instanceId: null });

    const storageEmpty = createFakeStorage({
      "ccdash.mobileSession": JSON.stringify({ screen: "terminal", instanceId: "" }),
    });
    expect(readRestoreTarget(storageEmpty)).toEqual({ screen: "terminal", instanceId: null });
  });

  it("never throws when storage itself throws (private browsing, quota)", () => {
    const throwingStorage: StorageLike = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(readRestoreTarget(throwingStorage)).toEqual({ screen: "home", instanceId: null });
    expect(() => persistRestoreTarget(throwingStorage, { screen: "terminal", instanceId: "x" })).not.toThrow();
  });
});
