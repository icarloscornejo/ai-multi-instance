import { promises as fs } from "node:fs";
import path from "node:path";
import type { DashboardState } from "./types";

const dataDirectory: string = path.resolve(import.meta.dirname, "../../data");
const stateFilePath: string = path.join(dataDirectory, "instances.json");

let cachedState: DashboardState | null = null;
let saveQueue: Promise<void> = Promise.resolve();

function emptyState(): DashboardState {
  return { schemaVersion: 2, config: { locations: [] }, instances: [], sessionsByKey: {} };
}

// Previous formats: worktrees per branch -> fixed slots -> plain folder locations
interface LegacyDashboardState {
  schemaVersion?: number;
  config: { repoPath?: string | null; worktreesDir?: string | null; slots?: string[]; locations?: string[] };
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
    config: { locations: migratedLocations },
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

export async function loadState(): Promise<DashboardState> {
  if (cachedState !== null) {
    return cachedState;
  }
  try {
    const rawContent: string = await fs.readFile(stateFilePath, "utf8");
    cachedState = migrateLegacyState(JSON.parse(rawContent) as LegacyDashboardState);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cachedState = emptyState();
    } else {
      throw new Error(
        `Could not read the instance registry at ${stateFilePath}: ${(error as Error).message}`
      );
    }
  }
  return cachedState;
}

export async function saveState(state: DashboardState): Promise<void> {
  cachedState = state;
  const serializedState: string = JSON.stringify(state, null, 2);
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    // Atomic write (tmp + rename) to avoid corrupting the registry if the process dies mid-write.
    const temporaryFilePath: string = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryFilePath, serializedState, "utf8");
    await fs.rename(temporaryFilePath, stateFilePath);
  });
  await saveQueue;
}
