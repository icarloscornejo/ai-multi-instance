export interface Instance {
  id: string;
  label: string;
  locationPath: string;
  tmuxSession: string;
  command: string;
  model: string | null;
  effort: string | null;
  fontSize: number;
  createdAt: string;
}

export interface DashboardConfig {
  locations: string[];
  configured: boolean;
}

export interface CreateInstancePayload {
  locationPath: string;
  label?: string;
  command?: string;
  model?: string;
  effort?: string;
}

export interface LocationInfo {
  path: string;
  folderName: string;
}

export type RestartKind = "none" | "auto" | "manual";

export interface UpdateStatus {
  startedAtCommit: string | null;
  currentCommit: string | null;
  remoteCommit: string | null;
  updateAvailable: boolean;
  pendingRestart: boolean;
  restartKind: RestartKind;
  blockedReason: string | null;
  lastCheckAt: string | null;
  lastError: string | null;
}

export interface UpdateInstancePayload {
  label?: string;
  command?: string;
  model?: string | null;
  effort?: string | null;
  fontSize?: number;
}
