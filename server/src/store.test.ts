import { describe, expect, it } from "vitest";
import { migrateLegacyState } from "./store";

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
