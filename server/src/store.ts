import { promises as fs } from "node:fs";
import path from "node:path";
import { isAgentProvider } from "./providers";
import type { AgentProvider, DashboardState, InstanceRecord } from "./types";

const dataDirectory: string = path.resolve(import.meta.dirname, "../../data");
// Exported for tests only, so store.test.ts can seed/inspect the exact paths this module
// reads and writes without duplicating the path.resolve logic above (which would silently
// drift out of sync with it) or - far worse - risking a test touching the real
// server/data/instances.json this process itself would use outside tests. Tests must mock
// "node:fs" entirely rather than pointing these at a scratch directory.
export const stateFilePath: string = path.join(dataDirectory, "instances.json");
// Kept in sync with stateFilePath on every successful, VALIDATED save (see saveState) - never
// written from anything that hasn't already passed isValidDashboardState. This is what makes
// it trustworthy as a restore source when the primary file itself turns out to be corrupt:
// bit rot, a truncated write from outside this process, a manual edit gone wrong.
export const backupFilePath: string = `${stateFilePath}.backup`;
export const quarantineDirectory: string = path.join(dataDirectory, "quarantine");
// Bounds how much of the user's registry history (custom commands, locations, provider
// session ids - see InstanceRecord) accumulates on disk across repeated corruption events.
// Rotation only ever deletes the OLDEST quarantined file once this cap is exceeded, never the
// most recent one or the one about to be written.
const MAX_QUARANTINED_FILES = 5;

const ALL_PROVIDERS: AgentProvider[] = ["claude", "codex", "cursor", "custom"];

function normalizeEnabledProviders(value: unknown): AgentProvider[] {
  if (!Array.isArray(value)) {
    return ALL_PROVIDERS;
  }
  const validProviders: AgentProvider[] = value.filter(isAgentProvider);
  return validProviders.length > 0 ? validProviders : ALL_PROVIDERS;
}

let cachedState: DashboardState | null = null;
let saveQueue: Promise<void> = Promise.resolve();

function emptyState(): DashboardState {
  return { schemaVersion: 2, config: { locations: [], enabledProviders: ALL_PROVIDERS }, instances: [], sessionsByKey: {} };
}

// Previous formats: worktrees per branch -> fixed slots -> plain folder locations
interface LegacyDashboardState {
  schemaVersion?: number;
  config: {
    repoPath?: string | null;
    worktreesDir?: string | null;
    slots?: string[];
    locations?: string[];
    enabledProviders?: string[];
  };
  instances: Array<
    Record<string, unknown> & {
      worktreePath?: string;
      slotPath?: string;
      locationPath?: string;
      branch?: string;
      command?: string;
    }
  >;
  sessionsByKey?: Record<string, string>;
}

// The old state referenced worktrees per branch, then fixed git slots; locations are
// plain folders so there is no way to migrate the config automatically.
// Only the instance list is preserved (renaming/dropping fields) to avoid losing live tmux sessions.
export function migrateLegacyState(rawState: LegacyDashboardState): DashboardState {
  const migratedLocations: string[] = Array.isArray(rawState.config.locations)
    ? rawState.config.locations
    : Array.isArray(rawState.config.slots)
      ? rawState.config.slots
      : [];
  return {
    schemaVersion: 2,
    config: {
      locations: migratedLocations,
      enabledProviders: normalizeEnabledProviders(rawState.config.enabledProviders),
    },
    instances: rawState.instances.map((instance) => {
      const { worktreePath, slotPath, branch, command, ...rest } = instance;
      return {
        ...rest,
        locationPath: instance.locationPath ?? slotPath ?? worktreePath ?? "",
        provider: instance.provider ?? "claude",
        command: command ?? "claude",
      } as unknown as DashboardState["instances"][number];
    }),
    sessionsByKey: Object.fromEntries(
      Object.entries(rawState.sessionsByKey ?? {}).map(([key, value]) => [
        key.startsWith("claude::") || key.startsWith("codex::") || key.startsWith("cursor::") || key.startsWith("custom::")
          ? key
          : `claude::${key}`,
        value,
      ])
    ),
  };
}

function isValidInstanceRecord(value: unknown): value is InstanceRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id !== "" &&
    typeof record.label === "string" &&
    typeof record.locationPath === "string" &&
    typeof record.tmuxSession === "string" &&
    isAgentProvider(record.provider) &&
    typeof record.command === "string" &&
    (record.model === null || typeof record.model === "string") &&
    (record.effort === null || typeof record.effort === "string") &&
    typeof record.fontSize === "number" &&
    typeof record.createdAt === "string"
  );
}

// A successful JSON.parse only proves the bytes were valid JSON, not that they describe a
// usable registry - a truncated write, a hand-edited file, or bytes from some other schema
// entirely can all parse cleanly while being structurally wrong. This is what stands between
// "parsed OK" and "safe to cache, back up, or restore from": nothing downstream (loadState,
// saveState's backup write) is allowed to trust a DashboardState that hasn't passed this,
// which is exactly the gap that used to let a well-formed-but-wrong JSON blob get blessed as
// the last-known-good backup.
export function isValidDashboardState(value: unknown): value is DashboardState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== 2) {
    return false;
  }
  const config = state.config as Record<string, unknown> | undefined;
  if (
    typeof config !== "object" ||
    config === null ||
    !Array.isArray(config.locations) ||
    !config.locations.every((entry) => typeof entry === "string") ||
    !Array.isArray(config.enabledProviders) ||
    !config.enabledProviders.every(isAgentProvider)
  ) {
    return false;
  }
  if (!Array.isArray(state.instances) || !state.instances.every(isValidInstanceRecord)) {
    return false;
  }
  if (
    typeof state.sessionsByKey !== "object" ||
    state.sessionsByKey === null ||
    !Object.values(state.sessionsByKey).every((entry) => typeof entry === "string")
  ) {
    return false;
  }
  return true;
}

// Atomic tmp+rename, shared by every writer of either the primary file or the backup: a
// process dying mid-write must never leave a half-written file where a reader (or a future
// recovery attempt reading the backup itself) could see a truncated, unparseable result.
async function writeStateFileAtomic(filePath: string, serializedState: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryFilePath, serializedState, "utf8");
  await fs.rename(temporaryFilePath, filePath);
}

// Best-effort: a backup that fails to update must never fail the save operation the user is
// actually waiting on (the primary write already succeeded, which is saveState's real
// contract), but it also must not fail SILENTLY - the whole point of the backup is to be
// trustworthy later, and a backup quietly falling behind primary without anyone knowing would
// defeat that the moment it's actually needed.
async function updateBackup(state: DashboardState): Promise<void> {
  try {
    await writeStateFileAtomic(backupFilePath, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error(`[server] failed to update the instance registry backup at ${backupFilePath}:`, (error as Error).message);
  }
}

// Renamed, never deleted: the corrupt bytes are the only evidence of what went wrong, and
// deleting them on the way to recovering would throw away exactly what a human would need to
// diagnose the corruption's cause later.
async function quarantineCorruptPrimary(rawContent: string): Promise<void> {
  await fs.mkdir(quarantineDirectory, { recursive: true });
  const quarantinePath = path.join(quarantineDirectory, `instances.${Date.now()}.${process.pid}.json`);
  await fs.writeFile(quarantinePath, rawContent, "utf8");
  console.error(`[server] instance registry was corrupt; quarantined the original at ${quarantinePath}`);
  await rotateQuarantine();
}

async function rotateQuarantine(): Promise<void> {
  try {
    const entries = await fs.readdir(quarantineDirectory);
    if (entries.length <= MAX_QUARANTINED_FILES) {
      return;
    }
    // Filenames embed Date.now() first, so a plain lexicographic sort is already
    // chronological; no need to stat every file just to find the oldest ones.
    const sortedOldestFirst = entries.sort();
    const staleEntries = sortedOldestFirst.slice(0, sortedOldestFirst.length - MAX_QUARANTINED_FILES);
    await Promise.all(staleEntries.map((entry) => fs.rm(path.join(quarantineDirectory, entry)).catch(() => undefined)));
  } catch {
    // Rotation is pure housekeeping; a failure here must never block or mask the recovery
    // this function is called from.
  }
}

async function readAndValidate(filePath: string): Promise<DashboardState | null> {
  const rawContent = await fs.readFile(filePath, "utf8");
  const parsed: unknown = migrateLegacyState(JSON.parse(rawContent) as LegacyDashboardState);
  return isValidDashboardState(parsed) ? parsed : null;
}

// The recovery sequence, run under loadState's single-flight guard (see below) so it can
// never itself be entered concurrently - closing the exact race the audit flagged: two
// callers both observing corruption, one quarantining the file while the other reads the
// resulting ENOENT and falls through to a fresh-install empty state, silently discarding
// every instance the user had. With this serialized, only one caller ever performs recovery;
// every other caller is just awaiting the same in-flight promise.
async function performLoad(): Promise<DashboardState> {
  let primaryRawContent: string | null = null;
  try {
    primaryRawContent = await fs.readFile(stateFilePath, "utf8");
    const parsed: unknown = migrateLegacyState(JSON.parse(primaryRawContent) as LegacyDashboardState);
    if (isValidDashboardState(parsed)) {
      // Opportunistic sync: covers both a backup that predates this feature and one that
      // fell behind after a failed updateBackup call elsewhere - either way, a successful
      // read of a valid primary is itself proof this snapshot is worth having as a backup.
      await updateBackup(parsed);
      return parsed;
    }
    // Parsed as JSON, migrated cleanly, but failed schema validation: treated identically to
    // a parse failure below - it is not safe to trust, back up, or serve.
    throw new Error("Instance registry failed schema validation");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // No primary file at all. Distinguish a genuine fresh install (no backup either) from
      // one where the primary vanished but a validated backup still exists - restoring from
      // backup there is strictly better than pretending this is a fresh install and handing
      // back an empty registry.
      const backupState = await readAndValidate(backupFilePath).catch(() => null);
      if (backupState !== null) {
        console.error(`[server] instance registry missing at ${stateFilePath}; restored from backup`);
        await writeStateFileAtomic(stateFilePath, JSON.stringify(backupState, null, 2)).catch(() => undefined);
        return backupState;
      }
      return emptyState();
    }

    // Anything else - a JSON parse failure, a failed schema validation, a permission error -
    // is genuine corruption or an unreadable primary. Quarantine what's there (if we managed
    // to read it before failing) and fall back to the backup.
    if (primaryRawContent !== null) {
      await quarantineCorruptPrimary(primaryRawContent).catch((quarantineError: Error) => {
        console.error("[server] failed to quarantine the corrupt instance registry:", quarantineError.message);
      });
    }

    const backupState = await readAndValidate(backupFilePath).catch(() => null);
    if (backupState !== null) {
      console.error(`[server] instance registry at ${stateFilePath} was corrupt; restored from backup`);
      await writeStateFileAtomic(stateFilePath, JSON.stringify(backupState, null, 2)).catch(() => undefined);
      return backupState;
    }

    // Both copies are unusable. Never silently degrade to an empty registry here - that
    // would turn every real instance's uuid into a permanent 4004 for its own terminal (see
    // attachErrors.ts) while looking, to the user, like a clean fresh install. Throwing keeps
    // the server alive (callers - the WS attach path, REST routes - already treat a loadState
    // failure as a recoverable, retryable error, see closeCodeForAttachError) and the failure
    // visible, rather than pretending nothing is wrong.
    throw new Error(
      `Instance registry at ${stateFilePath} is corrupt and no valid backup was found at ${backupFilePath}: ${(error as Error).message}`
    );
  }
}

let loadPromise: Promise<DashboardState> | null = null;

export async function loadState(): Promise<DashboardState> {
  if (cachedState !== null) {
    return cachedState;
  }
  // Single-flight: every concurrent caller (WebSocket attaches, REST routes - see index.ts
  // and routes.ts) before the cache is warm joins the SAME in-flight recovery attempt instead
  // of each independently racing performLoad. Set synchronously, no `await` between the
  // cachedState check above and this assignment, so two calls arriving back-to-back can never
  // both start their own performLoad (same pattern as sessionInitInFlight in terminal.ts).
  if (loadPromise !== null) {
    return loadPromise;
  }
  loadPromise = performLoad()
    .then((state) => {
      cachedState = state;
      return state;
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

export async function saveState(state: DashboardState): Promise<void> {
  const serializedState: string = JSON.stringify(state, null, 2);
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    // cachedState is published ONLY after the durable write succeeds - a failed save must
    // never leave memory claiming a state is committed when it exists in neither the primary
    // file nor the backup. The previous cachedState (and the previous on-disk primary/backup)
    // are left completely untouched if anything below throws.
    await writeStateFileAtomic(stateFilePath, serializedState);
    cachedState = state;
    // Backup update happens after, and is best-effort (see updateBackup) - it must not
    // retroactively fail a save that already committed to the primary file.
    await updateBackup(state);
  });
  await saveQueue;
}

// Test-only escape hatch: cachedState/loadPromise/saveQueue are process-lifetime module
// state, so a test suite that wants a clean slate between cases (a fresh "first load ever"
// each time) needs an explicit reset rather than re-importing the module. Mirrors
// attachErrors.ts's _resetAttachLogStateForTests.
export function _resetStoreStateForTests(): void {
  cachedState = null;
  loadPromise = null;
  saveQueue = Promise.resolve();
}
