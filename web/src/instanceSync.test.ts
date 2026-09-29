import { describe, expect, it } from "vitest";
import { reconcileFetchedInstances, shouldApplyRefresh } from "./instanceSync";
import type { Instance } from "./types";

function makeInstance(id: string, label: string = id): Instance {
  return { id, label } as Instance;
}

describe("reconcileFetchedInstances", () => {
  it("returns the same array reference when the fetched list is identical", () => {
    const previous: Instance[] = [makeInstance("a"), makeInstance("b")];
    const result = reconcileFetchedInstances(previous, [makeInstance("a"), makeInstance("b")], "a");
    expect(result.instances).toBe(previous);
    expect(result.activeInstanceId).toBe("a");
    expect(result.activeRemoved).toBe(false);
  });

  it("adopts a new, renamed or reordered list and keeps the active instance when it still exists", () => {
    const previous: Instance[] = [makeInstance("a"), makeInstance("b")];
    const fetched: Instance[] = [makeInstance("b", "renamed"), makeInstance("a"), makeInstance("c")];
    const result = reconcileFetchedInstances(previous, fetched, "a");
    expect(result.instances).toBe(fetched);
    expect(result.activeInstanceId).toBe("a");
    expect(result.activeRemoved).toBe(false);
  });

  it("clears the selection instead of jumping to another instance when the active one was deleted", () => {
    const result = reconcileFetchedInstances(
      [makeInstance("a"), makeInstance("b")],
      [makeInstance("b")],
      "a"
    );
    expect(result.activeInstanceId).toBeNull();
    expect(result.activeRemoved).toBe(true);
  });

  it("reports the removal when the last instance is deleted", () => {
    const result = reconcileFetchedInstances([makeInstance("a")], [], "a");
    expect(result.instances).toEqual([]);
    expect(result.activeInstanceId).toBeNull();
    expect(result.activeRemoved).toBe(true);
  });

  it("does not select anything on its own when nothing was selected", () => {
    const result = reconcileFetchedInstances([], [makeInstance("a")], null);
    expect(result.activeInstanceId).toBeNull();
    expect(result.activeRemoved).toBe(false);
  });
});

describe("shouldApplyRefresh", () => {
  it("applies a response when nothing local happened while it was in flight", () => {
    expect(shouldApplyRefresh(4, 4, 0)).toBe(true);
  });

  it("drops a response while a local mutation is still pending", () => {
    expect(shouldApplyRefresh(4, 4, 1)).toBe(false);
  });

  it("drops a response captured before a mutation started", () => {
    expect(shouldApplyRefresh(4, 5, 1)).toBe(false);
  });

  // The ordering that needs the generation bump on mutation END, not just on start: the
  // mutation starts (gen 1), the refresh starts (captures gen 2), the server answers the GET
  // before it commits the mutation, then the mutation finishes (gen 3, pending 0) and only
  // afterwards does the old GET response arrive. Pending is 0 again, so only the generation
  // can tell this response is stale.
  it("drops a stale response that arrives after the mutation that raced it already finished", () => {
    let generation = 0;
    let pending = 0;
    generation += 1; // mutation starts
    pending += 1;
    generation += 1; // refresh starts (skipped in practice while pending, but a wake event can race)
    const capturedGeneration: number = generation;
    pending -= 1; // mutation finishes
    generation += 1;
    expect(shouldApplyRefresh(capturedGeneration, generation, pending)).toBe(false);
  });
});
