// Mobile's "where was I" state: which screen (home or terminal) and, if terminal, which
// instance. Lives in sessionStorage, not localStorage, deliberately: it's per-TAB, not per-
// origin, so two mobile tabs open on different instances never stomp each other's destination
// (see App.tsx's old localStorage-based version, which could not make that distinction). It also
// survives a real page reload - the only case this module exists to serve - pull-to-refresh, the
// gate-login reload, or a genuine Chrome tab discard, none of which clear sessionStorage.
//
// `ccdash.activeInstanceId` in localStorage still exists separately, as desktop's own "last
// viewed instance" preference and mobile's fallback when a tab has no session target of its own
// yet (e.g. its very first load).

export type MobileScreen = "home" | "terminal";

export interface RestoreTarget {
  screen: MobileScreen;
  instanceId: string | null;
}

// A storage-shaped interface, not a direct sessionStorage dependency, so this can be unit tested
// with a plain in-memory fake instead of needing jsdom (this repo's vitest config runs in node,
// see web/vite.config.ts) - the same pattern web/src/keyBar.ts uses for the localStorage side of
// this same problem.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function normalizeMobileScreen(raw: unknown): MobileScreen {
  return raw === "terminal" ? "terminal" : "home";
}

// Pure: given what was saved and whether that instance still exists (deleted since, or never
// existed), decides where to land. A saved "terminal" target for an instance that's gone must
// degrade to home rather than show a terminal for nothing.
export function resolveRestoredScreen(saved: RestoreTarget, rememberedInstanceExists: boolean): MobileScreen {
  if (saved.screen === "terminal" && rememberedInstanceExists) {
    return "terminal";
  }
  return "home";
}

const STORAGE_KEY = "ccdash.mobileSession";

function normalizeRestoreTarget(parsed: unknown): RestoreTarget {
  if (typeof parsed !== "object" || parsed === null) {
    return { screen: "home", instanceId: null };
  }
  const record = parsed as { screen?: unknown; instanceId?: unknown };
  return {
    screen: normalizeMobileScreen(record.screen),
    instanceId: typeof record.instanceId === "string" && record.instanceId.length > 0 ? record.instanceId : null,
  };
}

// Fail-open, same reasoning as this repo's other storage readers (e.g. ptyCapacity.ts's header
// comment on why a broken diagnostic must never become a broken feature): corrupt JSON, a
// missing storage, or a storage that throws (private browsing, quota) all just mean "nothing
// saved yet", never a crash.
export function readRestoreTarget(storage: StorageLike): RestoreTarget {
  try {
    return normalizeRestoreTarget(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return { screen: "home", instanceId: null };
  }
}

export function persistRestoreTarget(storage: StorageLike, target: RestoreTarget): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(target));
  } catch {
    // A write failure (quota, private browsing) degrades to "won't restore next time", not a
    // crash - the same fail-open principle as readRestoreTarget above.
  }
}

// Real sessionStorage-backed wrappers for App.tsx. Kept separate from the pure/injectable
// functions above so those stay testable without touching `window` at all.
export function getInitialRestoreTarget(): RestoreTarget {
  return readRestoreTarget(window.sessionStorage);
}

export function persistRestoreTargetToSession(target: RestoreTarget): void {
  persistRestoreTarget(window.sessionStorage, target);
}
