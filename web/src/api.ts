import type {
  CreateInstancePayload,
  DashboardConfig,
  Instance,
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

  runUpdate: (): Promise<UpdateStatus> => requestJson("/api/update", { method: "POST" }),

  saveConfig: (payload: { locations: string[] }): Promise<DashboardConfig> =>
    requestJson("/api/config", { method: "PUT", body: JSON.stringify(payload) }),

  listInstances: (): Promise<Instance[]> => requestJson("/api/instances"),

  listLocations: (): Promise<LocationInfo[]> => requestJson("/api/locations"),

  createInstance: (payload: CreateInstancePayload): Promise<Instance> =>
    requestJson("/api/instances", { method: "POST", body: JSON.stringify(payload) }),

  updateInstance: (instanceId: string, payload: UpdateInstancePayload): Promise<Instance> =>
    requestJson(`/api/instances/${instanceId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  reorderInstances: (order: string[]): Promise<Instance[]> =>
    requestJson("/api/instances/order", { method: "PUT", body: JSON.stringify({ order }) }),

  deleteInstance: (instanceId: string): Promise<void> =>
    requestJson(`/api/instances/${instanceId}`, { method: "DELETE" }),

  relaunchInstance: (instanceId: string): Promise<void> =>
    requestJson(`/api/instances/${instanceId}/relaunch`, { method: "POST" }),
};
