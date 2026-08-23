import { beforeEach, describe, expect, it, vi } from "vitest";

// Full in-memory replacement for node:fs's promises API, keyed by absolute path. This is
// deliberate and not just a convenience: store.ts's data paths (stateFilePath, backupFilePath,
// quarantineDirectory) are fixed, computed once from the module's own location - there is no
// injectable "use a scratch directory" override - so any test that touched the real
// filesystem would be reading and writing this repo's actual server/data/instances.json, the
// user's real instance registry. Mocking "node:fs" entirely makes that impossible regardless
// of what a test does. The in-memory Map lives INSIDE the factory (rather than a top-level
// variable referenced from it) and is exported as `__testFiles` from the mocked module itself
// - vi.mock factories are hoisted above the rest of the file and cannot reference top-level
// variables declared elsewhere in it, so reaching back into the module's own exports (via the
// `fs` import below, after the mock is registered) is the standard way to share this state
// with the tests that need to seed or inspect it.
function enoent(filePath: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

vi.mock("node:fs", () => {
  const files = new Map<string, string>();
  return {
    __testFiles: files,
    promises: {
      readFile: vi.fn(async (filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw enoent(filePath);
        }
        return content;
      }),
      writeFile: vi.fn(async (filePath: string, content: string) => {
        files.set(filePath, content);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        const content = files.get(from);
        if (content === undefined) {
          throw enoent(from);
        }
        files.set(to, content);
        files.delete(from);
      }),
      mkdir: vi.fn(async () => undefined),
      readdir: vi.fn(async (dirPath: string) => {
        const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
        return [...files.keys()]
          .filter((filePath) => filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/"))
          .map((filePath) => filePath.slice(prefix.length));
      }),
      rm: vi.fn(async (filePath: string) => {
        files.delete(filePath);
      }),
    },
  };
});

import * as fs from "node:fs";
import {
  _resetStoreStateForTests,
  backupFilePath,
  isValidDashboardState,
  loadState,
  migrateLegacyState,
  quarantineDirectory,
  saveState,
  stateFilePath,
} from "./store";
import type { DashboardState } from "./types";

const testFiles = (fs as unknown as { __testFiles: Map<string, string> }).__testFiles;

function makeValidState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    schemaVersion: 2,
    config: { locations: ["/repo"], enabledProviders: ["claude", "codex", "cursor", "custom"] },
    instances: [
      {
        id: "abc123",
        label: "main",
        locationPath: "/repo",
        tmuxSession: "ccdash-abc123",
        provider: "claude",
        command: "claude",
        model: null,
        effort: null,
        fontSize: 13,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    sessionsByKey: {},
    ...overrides,
  };
}

beforeEach(() => {
  testFiles.clear();
  _resetStoreStateForTests();
});

describe("state migration", () => {
  it("migrates Claude-only state to schema v2 without losing sessions", () => {
    const migrated = migrateLegacyState({
      config: { locations: ["/repo"] },
      instances: [
        {
          id: "old",
          label: "main",
          locationPath: "/repo",
          tmuxSession: "ccdash-old",
          command: "claude-custom",
          model: null,
          effort: null,
          fontSize: 13,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sessionsByKey: { "/repo::main": "session-1" },
    });

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.instances[0]).toMatchObject({ provider: "claude", command: "claude-custom" });
    expect(migrated.sessionsByKey).toEqual({ "claude::/repo::main": "session-1" });
  });
});

describe("isValidDashboardState", () => {
  it("accepts a well-formed state", () => {
    expect(isValidDashboardState(makeValidState())).toBe(true);
  });

  it("rejects a JSON value that parsed fine but has the wrong shape entirely", () => {
    expect(isValidDashboardState({ hello: "world" })).toBe(false);
    expect(isValidDashboardState([1, 2, 3])).toBe(false);
    expect(isValidDashboardState("just a string")).toBe(false);
    expect(isValidDashboardState(null)).toBe(false);
  });

  it("rejects an instance missing a required field", () => {
    const state = makeValidState();
    // @ts-expect-error deliberately malformed for the test
    delete state.instances[0].tmuxSession;
    expect(isValidDashboardState(state)).toBe(false);
  });

  it("rejects an instance with an invalid provider", () => {
    const state = makeValidState();
    (state.instances[0] as unknown as { provider: string }).provider = "not-a-real-provider";
    expect(isValidDashboardState(state)).toBe(false);
  });

  it("rejects a non-array config.locations or non-array instances", () => {
    expect(isValidDashboardState({ ...makeValidState(), instances: "not an array" })).toBe(false);
    expect(isValidDashboardState({ ...makeValidState(), config: { locations: "nope", enabledProviders: [] } })).toBe(
      false
    );
  });

  it("rejects the wrong schemaVersion", () => {
    expect(isValidDashboardState({ ...makeValidState(), schemaVersion: 99 })).toBe(false);
  });
});

describe("loadState", () => {
  it("returns an empty state on a genuinely fresh install (no primary, no backup)", async () => {
    const state = await loadState();
    expect(state.instances).toEqual([]);
  });

  it("loads and caches the primary file when it is valid", async () => {
    const valid = makeValidState();
    testFiles.set(stateFilePath, JSON.stringify(valid));
    const state = await loadState();
    expect(state.instances[0]?.id).toBe("abc123");
    // Cached: a second call must not re-read the file (proven by clearing it and confirming
    // the same in-memory state is still returned).
    testFiles.delete(stateFilePath);
    expect((await loadState()).instances[0]?.id).toBe("abc123");
  });

  it("opportunistically writes a valid primary read to the backup, even if no backup existed before", async () => {
    testFiles.set(stateFilePath, JSON.stringify(makeValidState()));
    await loadState();
    expect(testFiles.has(backupFilePath)).toBe(true);
  });

  it("restores from a valid backup when the primary file is missing entirely", async () => {
    testFiles.set(backupFilePath, JSON.stringify(makeValidState({ instances: [] })));
    const state = await loadState();
    expect(state).toMatchObject({ instances: [] });
    // Restoration is durable, not just in-memory: a fresh process (simulated by resetting
    // the cache) must be able to load the SAME state straight from the primary file now.
    _resetStoreStateForTests();
    expect(testFiles.has(stateFilePath)).toBe(true);
  });

  // The central invariant of the whole recovery design: corruption must never silently
  // become an empty registry, because that turns every real instance's uuid into a
  // permanent-looking fatal 4004 (see attachErrors.ts) while looking, to the user, like a
  // clean fresh install with nothing wrong.
  it("restores from backup, and quarantines the corrupt primary, when the primary is unparseable JSON", async () => {
    testFiles.set(stateFilePath, "{ this is not valid json");
    const goodBackup = makeValidState();
    testFiles.set(backupFilePath, JSON.stringify(goodBackup));

    const state = await loadState();

    expect(state.instances[0]?.id).toBe("abc123");
    const quarantined = [...testFiles.keys()].filter((key) => key.startsWith(quarantineDirectory));
    expect(quarantined).toHaveLength(1);
    expect(testFiles.get(quarantined[0])).toBe("{ this is not valid json");
  });

  it("restores from backup when the primary parses as JSON but fails schema validation", async () => {
    testFiles.set(stateFilePath, JSON.stringify({ this: "does not match DashboardState at all" }));
    testFiles.set(backupFilePath, JSON.stringify(makeValidState()));

    const state = await loadState();
    expect(state.instances[0]?.id).toBe("abc123");
  });

  it("throws (never silently returns an empty state) when both primary and backup are unusable", async () => {
    testFiles.set(stateFilePath, "{ not json");
    testFiles.set(backupFilePath, "{ also not json");

    await expect(loadState()).rejects.toThrow();
  });

  it("never caches a state after a failed recovery: a later successful load can still recover", async () => {
    testFiles.set(stateFilePath, "{ not json");
    await expect(loadState()).rejects.toThrow();

    // The user (or an admin) fixes the primary file between attempts.
    testFiles.set(stateFilePath, JSON.stringify(makeValidState()));
    const state = await loadState();
    expect(state.instances[0]?.id).toBe("abc123");
  });

  // The exact race the audit flagged: two callers both hitting corruption at once must never
  // let one see the other's in-flight quarantine as an ENOENT and fall through to "fresh
  // install", silently discarding every real instance.
  it("serializes concurrent callers through one recovery attempt instead of racing", async () => {
    testFiles.set(stateFilePath, "{ not valid json");
    testFiles.set(backupFilePath, JSON.stringify(makeValidState()));

    const [first, second, third] = await Promise.all([loadState(), loadState(), loadState()]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first.instances[0]?.id).toBe("abc123");
    // Only one quarantine file, not one per concurrent caller.
    const quarantined = [...testFiles.keys()].filter((key) => key.startsWith(quarantineDirectory));
    expect(quarantined).toHaveLength(1);
  });

  it("rotates quarantine files, keeping only the most recent MAX_QUARANTINED_FILES", async () => {
    testFiles.set(backupFilePath, JSON.stringify(makeValidState()));
    for (let i = 0; i < 8; i += 1) {
      testFiles.set(stateFilePath, `{ corrupt attempt ${i}`);
      await loadState();
      _resetStoreStateForTests();
    }
    const quarantined = [...testFiles.keys()].filter((key) => key.startsWith(quarantineDirectory));
    expect(quarantined.length).toBeLessThanOrEqual(5);
  });
});

describe("saveState", () => {
  it("writes the primary file and updates the backup on success", async () => {
    const state = makeValidState();
    await saveState(state);
    expect(JSON.parse(testFiles.get(stateFilePath) ?? "null")).toMatchObject({ instances: [{ id: "abc123" }] });
    expect(JSON.parse(testFiles.get(backupFilePath) ?? "null")).toMatchObject({ instances: [{ id: "abc123" }] });
  });

  it("publishes cachedState only after the primary write succeeds", async () => {
    const state = makeValidState();
    await saveState(state);
    // Proven by loadState now returning the saved state WITHOUT ever reading the file again:
    // clear the backing file and confirm the cache still serves it.
    testFiles.clear();
    expect((await loadState()).instances[0]?.id).toBe("abc123");
  });

  it("does not publish cachedState when the primary write fails", async () => {
    const fsPromises = (fs as unknown as { promises: { rename: ReturnType<typeof vi.fn> } }).promises;
    fsPromises.rename.mockRejectedValueOnce(new Error("disk full"));

    await expect(saveState(makeValidState())).rejects.toThrow("disk full");

    // Falls through to loadState's own fresh-install path (no primary file was ever
    // committed), proving nothing was cached from the failed save.
    const state = await loadState();
    expect(state.instances).toEqual([]);
  });

  it("a failed backup update does not fail the overall save (primary already committed)", async () => {
    const fsPromises = (fs as unknown as { promises: { writeFile: ReturnType<typeof vi.fn> } }).promises;
    let callCount = 0;
    fsPromises.writeFile.mockImplementation(async (filePath: string, content: string) => {
      callCount += 1;
      // Let the primary's tmp-file write through; only fail the backup's.
      if (callCount > 1 && filePath.includes(".backup")) {
        throw new Error("backup disk full");
      }
      testFiles.set(filePath, content);
    });

    await expect(saveState(makeValidState())).resolves.toBeUndefined();
    expect(testFiles.has(stateFilePath)).toBe(true);
  });
});
