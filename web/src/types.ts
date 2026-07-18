export type AgentProvider = "claude" | "codex" | "cursor" | "custom";

export interface Instance {
  id: string;
  label: string;
  locationPath: string;
  tmuxSession: string;
  provider: AgentProvider;
  command: string;
  model: string | null;
  effort: string | null;
  sessionId?: string | null;
  fontSize: number;
  createdAt: string;
  shellOnly?: boolean;
}

export interface DashboardConfig {
  locations: string[];
  configured: boolean;
}

export type BranchAction =
  | { type: "checkout"; branch: string }
  | { type: "create"; branch: string; baseBranch: string };

export interface CreateInstancePayload {
  locationPath: string;
  label?: string;
  provider?: AgentProvider;
  command?: string;
  model?: string;
  effort?: string;
  branchAction?: BranchAction;
  shellOnly?: boolean;
}

export interface LocationBranches {
  isGitRepo: boolean;
  branches: string[];
  currentBranch: string | null;
}

export interface LocationInfo {
  path: string;
  folderName: string;
}

export type RestartKind = "none" | "auto" | "manual";

export interface ChangelogEntry {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
}

export interface UpdateStatus {
  startedAtCommit: string | null;
  currentCommit: string | null;
  remoteCommit: string | null;
  currentSubject: string | null;
  remoteSubject: string | null;
  changelog: ChangelogEntry[];
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

export interface LiveStatus {
  available: boolean;
  provider?: AgentProvider;
  model?: string;
  cwd?: string;
  sessionId?: string | null;
  effort?: string;
  branch?: string | null;
  gitAdded?: number;
  gitRemoved?: number;
  contextUsed?: number;
  contextSize?: number;
  contextPct?: number;
  inputTokens?: number;
  outputTokens?: number;
  sessionCostUsd?: number;
  fiveHourPct?: number | null;
  fiveHourResetsAt?: number | null;
  sevenDayPct?: number | null;
  sevenDayResetsAt?: number | null;
  extraUsd?: number | null;
  extraLimitUsd?: number | null;
  dayTotalUsd?: number | null;
  burnPerHour?: number | null;
  updatedAt?: string;
}
