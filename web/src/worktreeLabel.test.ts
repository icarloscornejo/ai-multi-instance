import { describe, expect, it } from "vitest";
import type { Instance } from "./types";
import { worktreeLabel } from "./worktreeLabel";

const baseInstance = { id: "a1", label: "agent", locationPath: "/work/repo" } as Instance;

describe("worktreeLabel", () => {
  it("is null for a normal instance", () => {
    expect(worktreeLabel(baseInstance)).toBeNull();
  });

  it("gives the source folder name and branch for a worktree instance", () => {
    const instance = {
      ...baseInstance,
      locationPath: "/work/repo-feature-x",
      worktree: { sourcePath: "/work/repo", branch: "feature/x", created: true },
    } as Instance;
    expect(worktreeLabel(instance)).toEqual({ sourceName: "repo", branch: "feature/x" });
  });
});
