// Per-device helper-keys preference (this browser only, never synced through the server),
// mirroring the pattern established by theme.ts and hostPrefs.ts. The stored array is both
// the visibility set and the display order: Settings can list and drag disabled entries too.

export type KeyBarKeyId =
  | "esc"
  | "ctrlC"
  | "up"
  | "down"
  | "tab"
  | "enter"
  | "left"
  | "right"
  | "ctrlV"
  | "shiftTab"
  | "ctrlD"
  | "ctrlZ"
  | "ctrlL"
  | "ctrlA"
  | "ctrlE"
  | "ctrlU"
  | "ctrlW";

export interface KeyBarCatalogEntry {
  id: KeyBarKeyId;
  label: string;
  title: string;
  // Absent only for ctrlV: it triggers the clipboard-read action instead of sending bytes.
  sequence?: string;
  enabledByDefault: boolean;
}

// Order here is the default bar order (for ids with enabledByDefault: true) followed by the
// rest; keep it in the order a first-time user should see them if they enable more later.
export const KEY_BAR_CATALOG: KeyBarCatalogEntry[] = [
  { id: "esc", label: "Esc", title: "Escape", sequence: "\x1b", enabledByDefault: true },
  { id: "tab", label: "Tab", title: "Tab", sequence: "\t", enabledByDefault: true },
  { id: "shiftTab", label: "⇧Tab", title: "Shift+Tab", sequence: "\x1b[Z", enabledByDefault: true },
  { id: "ctrlC", label: "^C", title: "Interrupt (Ctrl+C)", sequence: "\x03", enabledByDefault: true },
  { id: "up", label: "↑", title: "Up", sequence: "\x1b[A", enabledByDefault: true },
  { id: "down", label: "↓", title: "Down", sequence: "\x1b[B", enabledByDefault: true },
  { id: "enter", label: "Enter", title: "Enter", sequence: "\r", enabledByDefault: true },
  { id: "left", label: "←", title: "Left", sequence: "\x1b[D", enabledByDefault: false },
  { id: "right", label: "→", title: "Right", sequence: "\x1b[C", enabledByDefault: false },
  { id: "ctrlV", label: "^V", title: "Paste from clipboard", enabledByDefault: false },
  { id: "ctrlD", label: "^D", title: "Ctrl+D (EOF)", sequence: "\x04", enabledByDefault: false },
  { id: "ctrlZ", label: "^Z", title: "Ctrl+Z (Suspend)", sequence: "\x1a", enabledByDefault: false },
  { id: "ctrlL", label: "^L", title: "Ctrl+L (Clear)", sequence: "\x0c", enabledByDefault: false },
  { id: "ctrlA", label: "^A", title: "Ctrl+A (Start of line)", sequence: "\x01", enabledByDefault: false },
  { id: "ctrlE", label: "^E", title: "Ctrl+E (End of line)", sequence: "\x05", enabledByDefault: false },
  { id: "ctrlU", label: "^U", title: "Ctrl+U (Clear line)", sequence: "\x15", enabledByDefault: false },
  { id: "ctrlW", label: "^W", title: "Ctrl+W (Delete word)", sequence: "\x17", enabledByDefault: false },
];

const KEY_BAR_IDS: readonly KeyBarKeyId[] = KEY_BAR_CATALOG.map((entry) => entry.id);

export interface KeyBarPref {
  id: KeyBarKeyId;
  enabled: boolean;
}

function isKeyBarKeyId(value: unknown): value is KeyBarKeyId {
  return typeof value === "string" && (KEY_BAR_IDS as readonly string[]).includes(value);
}

function defaultKeyBarPrefs(): KeyBarPref[] {
  return KEY_BAR_CATALOG.map((entry) => ({ id: entry.id, enabled: entry.enabledByDefault }));
}

// Discards unknown/duplicate ids from storage, appends (disabled) any catalog id missing
// from it, so a future catalog addition never silently joins a bar the user already curated.
export function normalizeKeyBarPrefs(parsed: unknown): KeyBarPref[] {
  if (!Array.isArray(parsed)) {
    return defaultKeyBarPrefs();
  }
  const seen = new Set<KeyBarKeyId>();
  const normalized: KeyBarPref[] = [];
  for (const entry of parsed) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      isKeyBarKeyId((entry as { id?: unknown }).id) &&
      typeof (entry as { enabled?: unknown }).enabled === "boolean"
    ) {
      const id = (entry as { id: KeyBarKeyId }).id;
      if (!seen.has(id)) {
        seen.add(id);
        normalized.push({ id, enabled: (entry as { enabled: boolean }).enabled });
      }
    }
  }
  if (normalized.length === 0) {
    return defaultKeyBarPrefs();
  }
  for (const entry of KEY_BAR_CATALOG) {
    if (!seen.has(entry.id)) {
      normalized.push({ id: entry.id, enabled: false });
    }
  }
  return normalized;
}

export function reorderById(prefs: KeyBarPref[], activeId: KeyBarKeyId, overId: KeyBarKeyId): KeyBarPref[] {
  if (activeId === overId) {
    return prefs;
  }
  const fromIndex = prefs.findIndex((pref) => pref.id === activeId);
  const toIndex = prefs.findIndex((pref) => pref.id === overId);
  if (fromIndex === -1 || toIndex === -1) {
    return prefs;
  }
  const reordered = prefs.slice();
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  return reordered;
}

const STORAGE_KEY = "ccdash.keyBar";

export function getInitialKeyBarPrefs(): KeyBarPref[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return normalizeKeyBarPrefs(parsed);
  } catch {
    return defaultKeyBarPrefs();
  }
}

export function persistKeyBarPrefs(prefs: KeyBarPref[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
