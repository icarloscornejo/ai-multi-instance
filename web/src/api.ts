import type {
  AgentProvider,
  CreateInstancePayload,
  DashboardConfig,
  Instance,
  LiveStatus,
  LocationBranches,
  LocationInfo,
  UpdateInstancePayload,
  UpdateStatus,
} from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response: Response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(body.error ?? `Error ${response.status}`, response.status);
  }
  return body as T;
}

export const api = {
  getConfig: (): Promise<DashboardConfig> => requestJson("/api/config"),

  getUpdateStatus: (): Promise<UpdateStatus> => requestJson("/api/update-status"),

  checkForUpdate: (): Promise<UpdateStatus> => requestJson("/api/update/check", { method: "POST" }),

  applyUpdate: (): Promise<UpdateStatus> => requestJson("/api/update/apply", { method: "POST" }),

  saveConfig: (payload: { locations: string[]; enabledProviders: AgentProvider[] }): Promise<DashboardConfig> =>
    requestJson("/api/config", { method: "PUT", body: JSON.stringify(payload) }),

  listInstances: (): Promise<Instance[]> => requestJson("/api/instances"),

  getInstanceGit: (instanceId: string): Promise<{ cwd: string; branch?: string }> =>
    requestJson(`/api/instances/${instanceId}/git`),

  getInstanceLiveStatus: (instanceId: string): Promise<LiveStatus> =>
    requestJson(`/api/instances/${instanceId}/live-status`),

  listLocations: (): Promise<LocationInfo[]> => requestJson("/api/locations"),

  getLocationBranches: (locationPath: string): Promise<LocationBranches> =>
    requestJson(`/api/locations/branches?path=${encodeURIComponent(locationPath)}`),

  getLocationExists: (locationPath: string): Promise<{ exists: boolean }> =>
    requestJson(`/api/locations/exists?path=${encodeURIComponent(locationPath)}`),

  getResumableSession: (provider: AgentProvider, locationPath: string, label: string): Promise<{ hasSession: boolean }> =>
    requestJson(
      `/api/instances/resumable?provider=${encodeURIComponent(provider)}&path=${encodeURIComponent(locationPath)}&label=${encodeURIComponent(label)}`
    ),

  createInstance: (payload: CreateInstancePayload): Promise<Instance> =>
    requestJson("/api/instances", { method: "POST", body: JSON.stringify(payload) }),

  updateInstance: (instanceId: string, payload: UpdateInstancePayload): Promise<Instance> =>
    requestJson(`/api/instances/${instanceId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  reorderInstances: (order: string[]): Promise<Instance[]> =>
    requestJson("/api/instances/order", { method: "PUT", body: JSON.stringify({ order }) }),

  deleteInstance: (instanceId: string): Promise<void> =>
    requestJson(`/api/instances/${instanceId}`, { method: "DELETE" }),
};
