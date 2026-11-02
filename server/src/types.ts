export type AgentProvider = "claude" | "codex" | "cursor" | "custom";

export interface DashboardConfig {
  locations: string[];
  enabledProviders: AgentProvider[];
  // GitLab host to the NAME of the environment variable holding its token. Never a token value.
  gitlabTokenEnv?: Record<string, string>;
}

export interface InstanceRecord {
  id: string;
  label: string;
  locationPath: string;
  tmuxSession: string;
  provider: AgentProvider;
  command: string;
  model: string | null;
  effort: string | null;
  sessionId?: string | null;
  // Claude profile (CLAUDE_CONFIG_DIR) the dashboard launched this instance with, learned from
  // its first dashboard-launched snapshot. Only sessions of this profile may become the resume
  // target (see persistableSession in liveStatus.ts).
  configDir?: string;
  fontSize: number;
  createdAt: string;
  shellOnly?: boolean;
  // Set when locationPath is a sibling git worktree made because the source folder already had a
  // live session. `created` is false for a worktree that already existed: it is never auto-removed.
  worktree?: { sourcePath: string; branch: string; created: boolean };
  // Opt-in delivery of GitHub PR updates into the agent session. Absent means off.
  prEvents?: PrEventsSetting;
}

export interface PrEventsSetting {
  enabled: boolean;
  paused: boolean;
  botLogins?: string[];
}

export interface DashboardState {
  schemaVersion: 2;
  config: DashboardConfig;
  instances: InstanceRecord[];
  // Last known provider session id per "<provider>::<locationPath>::<label>".
  sessionsByKey: Record<string, string>;
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
  resumeSession?: boolean;
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

export interface StaleBranchesResponse {
  isGitRepo: boolean;
  currentBranch: string | null;
  candidates: { branch: string; worktreePath?: string }[];
}

export interface UpdateInstancePayload {
  label?: string;
  command?: string;
  model?: string | null;
  effort?: string | null;
  prEvents?: Partial<PrEventsSetting>;
}
