import { describe, expect, it } from "vitest";
import { agentStateLabel, agentStateTone, sortByWaiting } from "./agentState";

type Item = { id: string };
const items: Item[] = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

describe("sortByWaiting", () => {
  it("puts waiting instances first and keeps the stored order inside each group", () => {
    const sorted = sortByWaiting(items, { b: "idle", c: "waiting", d: "working", e: "waiting" });

    expect(sorted.map((item) => item.id)).toEqual(["c", "e", "a", "b", "d"]);
  });

  it("treats an instance with no state as not waiting", () => {
    expect(sortByWaiting(items, {}).map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(sortByWaiting(items, { e: "waiting" }).map((item) => item.id)).toEqual(["e", "a", "b", "c", "d"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...items];

    const sorted = sortByWaiting(items, { e: "waiting" });

    expect(items).toEqual(copy);
    expect(sorted).not.toBe(items);
  });

  it("returns the same elements, not copies", () => {
    expect(sortByWaiting(items, { c: "waiting" })[0]).toBe(items[2]);
  });

  it("handles an empty list", () => {
    expect(sortByWaiting([], { a: "waiting" })).toEqual([]);
  });
});

describe("agentStateLabel and agentStateTone", () => {
  it.each(["waiting", "working", "idle"] as const)("gives %s a non-empty label and a tone", (state) => {
    expect(agentStateLabel(state).length).toBeGreaterThan(0);
    expect(agentStateTone(state)).toBeTruthy();
  });

  it("gives each state a distinct label", () => {
    const labels = (["waiting", "working", "idle"] as const).map(agentStateLabel);
    expect(new Set(labels).size).toBe(3);
  });

  it("marks waiting with a different tone from the other two", () => {
    expect(agentStateTone("waiting")).not.toBe(agentStateTone("working"));
    expect(agentStateTone("waiting")).not.toBe(agentStateTone("idle"));
  });

  it("shows no badge when the state is absent", () => {
    expect(agentStateLabel(undefined)).toBe("");
  });
});
