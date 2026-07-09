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
}

export interface DashboardState {
  config: DashboardConfig;
  instances: InstanceRecord[];
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

export interface UpdateInstancePayload {
  label?: string;
  command?: string;
  model?: string | null;
  effort?: string | null;
  fontSize?: number;
}
