import { describe, expect, it } from "vitest";
import { KEY_BAR_CATALOG, normalizeKeyBarPrefs, reorderById, type KeyBarPref } from "./keyBar";

const DEFAULT_ENABLED_IDS = ["esc", "tab", "shiftTab", "ctrlC", "up", "down", "enter"];

describe("normalizeKeyBarPrefs", () => {
  it("returns the default set for empty storage", () => {
    const result = normalizeKeyBarPrefs(null);
    expect(result.map((pref) => pref.id)).toEqual(KEY_BAR_CATALOG.map((entry) => entry.id));
    expect(result.filter((pref) => pref.enabled).map((pref) => pref.id)).toEqual(DEFAULT_ENABLED_IDS);
  });

  it("returns the default set for malformed storage", () => {
    expect(normalizeKeyBarPrefs("not an array")).toHaveLength(KEY_BAR_CATALOG.length);
    expect(normalizeKeyBarPrefs({ id: "esc" })).toHaveLength(KEY_BAR_CATALOG.length);
    expect(normalizeKeyBarPrefs([])).toHaveLength(KEY_BAR_CATALOG.length);
  });

  it("discards unknown ids", () => {
    const result = normalizeKeyBarPrefs([{ id: "esc", enabled: true }, { id: "madeUpKey", enabled: true }]);
    expect(result).toHaveLength(KEY_BAR_CATALOG.length);
  });

  it("appends a missing catalog key, disabled, at the end", () => {
    const withoutCtrlW = KEY_BAR_CATALOG.filter((entry) => entry.id !== "ctrlW").map((entry) => ({
      id: entry.id,
      enabled: entry.enabledByDefault,
    }));
    const result = normalizeKeyBarPrefs(withoutCtrlW);
    expect(result[result.length - 1]).toEqual({ id: "ctrlW", enabled: false });
  });

  it("respects the stored order", () => {
    const stored: KeyBarPref[] = [
      { id: "enter", enabled: true },
      { id: "esc", enabled: true },
    ];
    const result = normalizeKeyBarPrefs(stored);
    expect(result[0].id).toBe("enter");
    expect(result[1].id).toBe("esc");
  });

  it("deduplicates repeated ids, keeping the first occurrence", () => {
    const stored: KeyBarPref[] = [
      { id: "esc", enabled: true },
      { id: "esc", enabled: false },
    ];
    const result = normalizeKeyBarPrefs(stored);
    expect(result.filter((pref) => pref.id === "esc")).toHaveLength(1);
    expect(result.find((pref) => pref.id === "esc")?.enabled).toBe(true);
  });
});

describe("reorderById", () => {
  const prefs: KeyBarPref[] = [
    { id: "esc", enabled: true },
    { id: "ctrlC", enabled: true },
    { id: "up", enabled: true },
  ];

  it("moves an entry to another position", () => {
    const result = reorderById(prefs, "esc", "up");
    expect(result.map((pref) => pref.id)).toEqual(["ctrlC", "up", "esc"]);
  });

  it("is a no-op when activeId equals overId", () => {
    expect(reorderById(prefs, "ctrlC", "ctrlC")).toBe(prefs);
  });

  it("is a no-op when an id is not found", () => {
    const result = reorderById(prefs, "esc", "missing" as unknown as KeyBarPref["id"]);
    expect(result).toBe(prefs);
  });
});
