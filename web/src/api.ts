import type {
  AgentProvider,
  CreateInstancePayload,
  DashboardConfig,
  Instance,
  LanAddress,
  LiveStatus,
  LocationBranches,
  LocationInfo,
  StaleBranchesResponse,
  TunnelStatus,
  UpdateInstancePayload,
  UpdateStatus,
} from "./types";
import { ApiError } from "./apiError";
import { consumeLaunchStream, type LaunchEvent } from "./launchSteps";

export { ApiError } from "./apiError";
export type { LaunchEvent } from "./launchSteps";

// App.tsx registers this once at startup so any request (not just the initial load) can
// flip the app into the password-gate screen the moment the auth cookie is missing/expired
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response: Response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (response.status === 401 && !url.endsWith("/auth/login")) {
    onUnauthorized?.();
  }
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
  login: (password: string): Promise<{ ok: boolean }> =>
    requestJson("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),

  setPassword: (password: string): Promise<{ ok: boolean }> =>
    requestJson("/api/auth/set-password", { method: "POST", body: JSON.stringify({ password }) }),

  getConfig: (): Promise<DashboardConfig> => requestJson("/api/config"),

  getUpdateStatus: (): Promise<UpdateStatus> => requestJson("/api/update-status"),

  checkForUpdate: (): Promise<UpdateStatus> => requestJson("/api/update/check", { method: "POST" }),

  applyUpdate: (): Promise<UpdateStatus> => requestJson("/api/update/apply", { method: "POST" }),

  resetToRemote: (): Promise<UpdateStatus> => requestJson("/api/update/reset", { method: "POST" }),

  saveConfig: (payload: { locations: string[]; enabledProviders: AgentProvider[] }): Promise<DashboardConfig> =>
    requestJson("/api/config", { method: "PUT", body: JSON.stringify(payload) }),

  listInstances: (): Promise<Instance[]> => requestJson("/api/instances"),

  getInstanceGit: (instanceId: string): Promise<{ cwd: string; branch?: string }> =>
    requestJson(`/api/instances/${instanceId}/git`),

  scrollTerminalToBottom: (instanceId: string): Promise<{ ok: boolean }> =>
    requestJson(`/api/instances/${instanceId}/scroll-to-bottom`, { method: "POST" }),

  getInstanceLiveStatus: (instanceId: string): Promise<LiveStatus> =>
    requestJson(`/api/instances/${instanceId}/live-status`),

  listLocations: (): Promise<LocationInfo[]> => requestJson("/api/locations"),

  getLocationBranches: (locationPath: string): Promise<LocationBranches> =>
    requestJson(`/api/locations/branches?path=${encodeURIComponent(locationPath)}`),

  getLocationExists: (locationPath: string): Promise<{ exists: boolean }> =>
    requestJson(`/api/locations/exists?path=${encodeURIComponent(locationPath)}`),

  getStaleBranches: (locationPath: string): Promise<StaleBranchesResponse> =>
    requestJson(`/api/locations/stale-branches?path=${encodeURIComponent(locationPath)}`),

  deleteStaleBranches: (
    locationPath: string,
    branches: string[]
  ): Promise<{ deleted: string[]; failed: { branch: string; error: string }[] }> =>
    requestJson("/api/locations/stale-branches/delete", {
      method: "POST",
      body: JSON.stringify({ path: locationPath, branches }),
    }),

  getResumableSession: (provider: AgentProvider, locationPath: string, label: string): Promise<{ hasSession: boolean }> =>
    requestJson(
      `/api/instances/resumable?provider=${encodeURIComponent(provider)}&path=${encodeURIComponent(locationPath)}&label=${encodeURIComponent(label)}`
    ),

  // POST /api/instances streams NDJSON progress (server/src/routes.ts). Phase-1 validation
  // still fails as a normal JSON error with its status code (handled below, before the body
  // is read); phase-2 execution failures arrive as an `error` event inside the 201 body and
  // consumeLaunchStream turns them back into a thrown ApiError.
  createInstance: async (
    payload: CreateInstancePayload,
    onProgress?: (event: LaunchEvent) => void
  ): Promise<Instance> => {
    const response: Response = await fetch("/api/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status === 401) {
      onUnauthorized?.();
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? `Error ${response.status}`, response.status);
    }
    if (response.body === null) {
      // No streaming body available (a proxy or test shim that buffers). Fall back to the
      // plain JSON contract: the server still ends the stream with a `done`/`error` line,
      // and the last non-empty line is what matters.
      const text: string = await response.text();
      const lastLine: string = text.trim().split("\n").filter((line) => line.trim() !== "").pop() ?? "";
      const event = JSON.parse(lastLine) as { type?: string; instance?: Instance; error?: string; message?: string };
      if (event.type === "done" && event.instance !== undefined) {
        return event.instance;
      }
      throw new ApiError(event.message ?? event.error ?? "Instance creation failed.", 500);
    }
    return consumeLaunchStream(response.body, onProgress);
  },

  updateInstance: (instanceId: string, payload: UpdateInstancePayload): Promise<Instance> =>
    requestJson(`/api/instances/${instanceId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  reorderInstances: (order: string[]): Promise<Instance[]> =>
    requestJson("/api/instances/order", { method: "PUT", body: JSON.stringify({ order }) }),

  deleteInstance: (instanceId: string): Promise<void> =>
    requestJson(`/api/instances/${instanceId}`, { method: "DELETE" }),

  getTunnel: (): Promise<TunnelStatus> => requestJson("/api/tunnel"),

  startTunnel: (): Promise<TunnelStatus> => requestJson("/api/tunnel/start", { method: "POST" }),

  stopTunnel: (): Promise<TunnelStatus> => requestJson("/api/tunnel/stop", { method: "POST" }),

  getTunnelLogs: async (): Promise<string> => {
    const response: Response = await fetch("/api/tunnel/logs");
    if (response.status === 401) {
      onUnauthorized?.();
    }
    if (!response.ok) {
      throw new ApiError(`Error ${response.status}`, response.status);
    }
    return response.text();
  },

  getLanAddress: (): Promise<LanAddress> => requestJson("/api/lan-address"),
};
