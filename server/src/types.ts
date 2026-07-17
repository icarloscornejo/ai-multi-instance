export interface DashboardConfig {
  locations: string[];
}

export interface InstanceRecord {
  id: string;
  label: string;
  locationPath: string;
  tmuxSession: string;
  command: string;
  model: string | null;
  effort: string | null;
  fontSize: number;
  createdAt: string;
  shellOnly?: boolean;
}

export interface DashboardState {
  config: DashboardConfig;
  instances: InstanceRecord[];
  // Last known Claude Code session id per "<locationPath>::<label>", captured when an
  // instance is deleted so a future instance reusing the same location+label can
  // resume that exact conversation instead of starting a new one.
  sessionsByKey: Record<string, string>;
}

export type BranchAction =
  | { type: "checkout"; branch: string }
  | { type: "create"; branch: string; baseBranch: string };

export interface CreateInstancePayload {
  locationPath: string;
  label?: string;
  command?: string;
  model?: string;
  effort?: string;
  branchAction?: BranchAction;
  shellOnly?: boolean;
}

export interface LocationInfo {
  path: string;
  folderName: string;
}

export interface LocationBranches {
  isGitRepo: boolean;
  branches: string[];
  currentBranch: string | null;
}

export interface UpdateInstancePayload {
  label?: string;
  command?: string;
  model?: string | null;
  effort?: string | null;
  fontSize?: number;
}
