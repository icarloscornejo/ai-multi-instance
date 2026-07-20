import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { buildLaunchCommand } from "./launch";
import { isAgentProvider, PROVIDERS, sessionKeyFor } from "./providers";
import { loadState, saveState } from "./store";
import { createSession, getPaneCurrentPath, killSession, sendCommandToSession } from "./tmux";
import { applyUpdate, checkForUpdate, getUpdateStatus } from "./updater";
import type {
  BranchAction,
  CreateInstancePayload,
  DashboardState,
  InstanceRecord,
  UpdateInstancePayload,
} from "./types";

const DEFAULT_FONT_SIZE = 13;

type AsyncHandler = (request: Request, response: Response) => Promise<void>;

// Express 4 no propaga errores de handlers async al middleware de errores
function wrapAsync(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
  } catch {
    // Not a git repo, git not installed, or the folder does not exist anymore
    return null;
  }
}

async function localBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch !== "");
}

function resolveLiveStatusSnapshotPath(instance: InstanceRecord): string {
  return path.join(os.homedir(), ".cache", "ai-multi-instance", `${instance.id}.json`);
}

async function readLiveSessionId(instance: InstanceRecord): Promise<string | null> {
  try {
    const snapshotPath: string = resolveLiveStatusSnapshotPath(instance);
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as { sessionId?: string | null };
    return typeof snapshot.sessionId === "string" && snapshot.sessionId !== "" ? snapshot.sessionId : null;
  } catch {
    // No statusLine snapshot yet for this directory (not configured, or Claude Code
    // hasn't redrawn its statusline here since this dashboard instance was launched)
    return null;
  }
}

async function writeSessionSnapshot(
  instance: InstanceRecord,
  sessionId: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const snapshotPath: string = resolveLiveStatusSnapshotPath(instance);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({
      provider: instance.provider,
      sessionId,
      cwd: instance.locationPath,
      model: instance.model ?? undefined,
      ...extra,
      updatedAt: new Date().toISOString(),
    }),
    "utf8"
  );
}

async function findCodexSessionFile(sessionId: string): Promise<string | undefined> {
  const sessionsRoot: string = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  try {
    const entries = await fs.readdir(sessionsRoot, { recursive: true });
    const relativePath: string | undefined = entries.find(
      (entry) => typeof entry === "string" && entry.endsWith(`${sessionId}.jsonl`)
    );
    return relativePath === undefined ? undefined : path.join(sessionsRoot, relativePath);
  } catch {
    return undefined;
  }
}

async function enrichCodexStatus(snapshot: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof snapshot.sessionFile !== "string") return snapshot;
  try {
    const content: string = await fs.readFile(snapshot.sessionFile, "utf8");
    let model: string | undefined;
    let effort: string | undefined;
    let tokenInfo: Record<string, unknown> | null = null;
    let rateLimits: Record<string, unknown> | null = null;
    for (const line of content.trim().split("\n")) {
      const event = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      if (event.type === "turn_context") {
        if (typeof event.payload?.model === "string") model = event.payload.model;
        const collaboration = event.payload?.collaboration_mode as { settings?: { reasoning_effort?: string } } | undefined;
        if (typeof collaboration?.settings?.reasoning_effort === "string") effort = collaboration.settings.reasoning_effort;
      }
      if (event.type === "event_msg" && event.payload?.type === "token_count") {
        tokenInfo = (event.payload.info as Record<string, unknown> | null) ?? null;
        rateLimits = (event.payload.rate_limits as Record<string, unknown> | null) ?? null;
      }
    }
    const totalUsage = tokenInfo?.total_token_usage as { total_tokens?: number } | undefined;
    const contextSize = tokenInfo?.model_context_window;
    const primary = rateLimits?.primary as { used_percent?: number; resets_at?: number } | undefined;
    const secondary = rateLimits?.secondary as { used_percent?: number; resets_at?: number } | undefined;
    const contextUsed: number | undefined = totalUsage?.total_tokens;
    return {
      ...snapshot,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(typeof contextUsed === "number" ? { contextUsed } : {}),
      ...(typeof contextSize === "number"
        ? {
            contextSize,
            contextPct: contextUsed === undefined ? 0 : (contextUsed / contextSize) * 100,
          }
        : {}),
      ...(typeof primary?.used_percent === "number" ? { fiveHourPct: primary.used_percent } : {}),
      ...(typeof primary?.resets_at === "number" ? { fiveHourResetsAt: primary.resets_at } : {}),
      ...(typeof secondary?.used_percent === "number" ? { sevenDayPct: secondary.used_percent } : {}),
      ...(typeof secondary?.resets_at === "number" ? { sevenDayResetsAt: secondary.resets_at } : {}),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return snapshot;
  }
}

export const apiRouter: Router = express.Router();

function resolveHomePath(rawPath: string): string {
  return path.resolve(rawPath.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

apiRouter.get(
  "/config",
  wrapAsync(async (_request, response) => {
    const state: DashboardState = await loadState();
    response.json({ ...state.config, configured: state.config.locations.length > 0 });
  })
);

apiRouter.put(
  "/config",
  wrapAsync(async (request, response) => {
    const { locations, enabledProviders } = request.body as { locations?: unknown; enabledProviders?: unknown };
    if (!Array.isArray(locations) || locations.some((location) => typeof location !== "string")) {
      response.status(400).json({ error: "Provide the list of location paths." });
      return;
    }
    const trimmedLocations: string[] = (locations as string[])
      .map((location) => location.trim())
      .filter((location) => location !== "");
    if (trimmedLocations.length === 0) {
      response.status(400).json({ error: "Add at least one location." });
      return;
    }
    const resolvedLocations: string[] = trimmedLocations.map(resolveHomePath);
    if (new Set(resolvedLocations).size !== resolvedLocations.length) {
      response.status(400).json({ error: "There are duplicate location paths." });
      return;
    }
    for (const locationPath of resolvedLocations) {
      if (!(await pathExists(locationPath))) {
        response.status(400).json({ error: `Folder does not exist: ${locationPath}` });
        return;
      }
    }

    const state: DashboardState = await loadState();
    let resolvedEnabledProviders = state.config.enabledProviders;
    if (enabledProviders !== undefined) {
      if (!Array.isArray(enabledProviders) || enabledProviders.length === 0 || !enabledProviders.every(isAgentProvider)) {
        response.status(400).json({ error: "Provide at least one valid agent." });
        return;
      }
      resolvedEnabledProviders = enabledProviders;
    }
    state.config = { locations: resolvedLocations, enabledProviders: resolvedEnabledProviders };
    await saveState(state);
    response.json({ ...state.config, configured: true });
  })
);

apiRouter.get(
  "/locations/exists",
  wrapAsync(async (request, response) => {
    const locationPath: string = typeof request.query.path === "string" ? request.query.path.trim() : "";
    if (locationPath === "") {
      response.status(400).json({ error: "Provide the location." });
      return;
    }
    response.json({ exists: await pathExists(locationPath) });
  })
);

apiRouter.get(
  "/locations",
  wrapAsync(async (_request, response) => {
    const state: DashboardState = await loadState();
    const locations = state.config.locations.map((locationPath) => ({
      path: locationPath,
      folderName: path.basename(locationPath),
    }));
    response.json(locations);
  })
);

apiRouter.get(
  "/locations/branches",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const locationPath: string = typeof request.query.path === "string" ? request.query.path.trim() : "";
    if (locationPath === "") {
      response.status(400).json({ error: "Provide the location." });
      return;
    }
    if (!state.config.locations.includes(locationPath)) {
      response.status(400).json({ error: `Location ${locationPath} is not configured.` });
      return;
    }
    if (!(await pathExists(locationPath))) {
      response.status(404).json({ error: `Folder does not exist: ${locationPath}` });
      return;
    }

    try {
      const branches: string[] = await localBranches(locationPath);
      response.json({ isGitRepo: true, branches, currentBranch: await currentBranch(locationPath) });
    } catch {
      // Not a git repo, or git not installed
      response.json({ isGitRepo: false, branches: [], currentBranch: null });
    }
  })
);

apiRouter.get("/update-status", (_request, response) => {
  response.json(getUpdateStatus());
});

apiRouter.post(
  "/update/check",
  wrapAsync(async (_request, response) => {
    response.json(await checkForUpdate());
  })
);

apiRouter.post(
  "/update/apply",
  wrapAsync(async (_request, response) => {
    response.json(await applyUpdate());
  })
);

apiRouter.get(
  "/instances",
  wrapAsync(async (_request, response) => {
    const state: DashboardState = await loadState();
    response.json(state.instances);
  })
);

apiRouter.get(
  "/instances/resumable",
  wrapAsync(async (request, response) => {
    const provider = request.query.provider;
    const locationPath: string = typeof request.query.path === "string" ? request.query.path.trim() : "";
    const label: string = typeof request.query.label === "string" ? request.query.label.trim() : "";
    if (!isAgentProvider(provider) || locationPath === "" || label === "") {
      response.status(400).json({ error: "Provide a valid provider, location and label." });
      return;
    }
    const state: DashboardState = await loadState();
    const hasSession: boolean =
      PROVIDERS[provider].capabilities.resume &&
      state.sessionsByKey[sessionKeyFor(provider, locationPath, label)] !== undefined;
    response.json({ hasSession });
  })
);

apiRouter.post(
  "/instances",
  wrapAsync(async (request, response) => {
    const payload = request.body as CreateInstancePayload;
    const state: DashboardState = await loadState();
    const { locations } = state.config;

    if (locations.length === 0) {
      response.status(409).json({ error: "Configure locations first." });
      return;
    }

    const locationPath: string = typeof payload.locationPath === "string" ? payload.locationPath.trim() : "";
    if (locationPath === "") {
      response.status(400).json({ error: "Provide the location." });
      return;
    }
    if (!locations.includes(locationPath)) {
      response.status(400).json({ error: `Location ${locationPath} is not configured.` });
      return;
    }
    if (!(await pathExists(locationPath))) {
      response.status(400).json({ error: `Folder does not exist: ${locationPath}` });
      return;
    }

    const requestedLabel: string =
      typeof payload.label === "string" && payload.label.trim() !== "" ? payload.label.trim() : path.basename(locationPath);
    const nameTaken: boolean = state.instances.some(
      (existing) => existing.locationPath === locationPath && existing.label === requestedLabel
    );
    if (nameTaken) {
      response.status(409).json({ error: `An instance named '${requestedLabel}' is already running here` });
      return;
    }

    const branchAction: BranchAction | undefined = payload.branchAction;
    if (branchAction !== undefined) {
      const branch: string = typeof branchAction.branch === "string" ? branchAction.branch.trim() : "";
      if (branch === "" || (branchAction.type !== "checkout" && branchAction.type !== "create")) {
        response.status(400).json({ error: "Provide a valid branch action." });
        return;
      }
      if (branchAction.type === "create" && (typeof branchAction.baseBranch !== "string" || branchAction.baseBranch.trim() === "")) {
        response.status(400).json({ error: "Provide the base branch to create from." });
        return;
      }
      try {
        if (branchAction.type === "checkout") {
          await execFileAsync("git", ["-C", locationPath, "checkout", branch]);
        } else {
          const baseBranch: string = branchAction.baseBranch.trim();
          await execFileAsync("git", ["-C", locationPath, "fetch", "origin", baseBranch]);
          const activeBranch: string | null = await currentBranch(locationPath);
          if (activeBranch === baseBranch) {
            // The base branch is checked out here: fast-forward it in place, never overwrite local commits
            await execFileAsync("git", ["-C", locationPath, "merge", "--ff-only", `origin/${baseBranch}`]);
          } else {
            // Not checked out: update its ref directly. A plain (non "+") refspec is fast-forward-only,
            // git refuses on its own if the local base branch has diverged from origin
            await execFileAsync("git", ["-C", locationPath, "fetch", "origin", `${baseBranch}:${baseBranch}`]);
          }
          await execFileAsync("git", ["-C", locationPath, "checkout", "-b", branch, baseBranch]);
        }
      } catch (error) {
        response.status(409).json({ error: `Could not switch branches: ${(error as Error).message}` });
        return;
      }
    }

    const shellOnly: boolean = payload.shellOnly === true;
    if (payload.provider !== undefined && !isAgentProvider(payload.provider)) {
      response.status(400).json({ error: "Provide a valid agent provider." });
      return;
    }
    const provider = isAgentProvider(payload.provider) ? payload.provider : "claude";
    if (!state.config.enabledProviders.includes(provider)) {
      response.status(400).json({ error: "Agent not enabled. Enable it from Settings." });
      return;
    }
    const providerDefinition = PROVIDERS[provider];
    if (
      !shellOnly &&
      provider === "custom" &&
      (typeof payload.command !== "string" || payload.command.trim() === "")
    ) {
      response.status(400).json({ error: "Provide a custom command." });
      return;
    }
    const instanceId: string = randomUUID().slice(0, 8);
    const instance: InstanceRecord = {
      id: instanceId,
      label: requestedLabel,
      locationPath,
      tmuxSession: `ccdash-${instanceId}`,
      provider,
      command:
        typeof payload.command === "string" && payload.command.trim() !== ""
          ? payload.command.trim()
          : providerDefinition.defaultCommand,
      model:
        providerDefinition.capabilities.model && typeof payload.model === "string" && payload.model.trim() !== ""
          ? payload.model.trim()
          : null,
      effort:
        providerDefinition.capabilities.effort && typeof payload.effort === "string" && payload.effort.trim() !== ""
          ? payload.effort.trim()
          : null,
      fontSize: DEFAULT_FONT_SIZE,
      createdAt: new Date().toISOString(),
      ...(shellOnly ? { shellOnly: true } : {}),
    };

    const resumeKey: string = sessionKeyFor(provider, locationPath, requestedLabel);
    let resumeSessionId: string | undefined =
      payload.resumeSession === false ? undefined : state.sessionsByKey[resumeKey];
    if (resumeSessionId !== undefined) {
      instance.sessionId = resumeSessionId;
      const sessionFile: string | undefined =
        provider === "codex" ? await findCodexSessionFile(resumeSessionId) : undefined;
      await writeSessionSnapshot(instance, resumeSessionId, sessionFile ? { sessionFile } : {});
    }

    try {
      await createSession(instance.tmuxSession, instance.locationPath);
      if (!shellOnly) {
        await sendCommandToSession(instance.tmuxSession, buildLaunchCommand(instance, { resumeSessionId }));
      }
    } catch (error) {
      // The location is a permanent user folder: only the session is cleaned up, not the disk
      await killSession(instance.tmuxSession).catch(() => undefined);
      throw error;
    }

    state.instances.push(instance);
    await saveState(state);
    response.status(201).json(instance);
  })
);

apiRouter.put(
  "/instances/order",
  wrapAsync(async (request, response) => {
    const { order } = request.body as { order?: unknown };
    if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) {
      response.status(400).json({ error: "Provide the new id order." });
      return;
    }
    const state: DashboardState = await loadState();
    const currentIds: Set<string> = new Set(state.instances.map((instance) => instance.id));
    const isExactPermutation: boolean =
      order.length === currentIds.size && new Set(order).size === order.length && order.every((id) => currentIds.has(id));
    if (!isExactPermutation) {
      response.status(400).json({ error: "The order must include exactly the current instance ids." });
      return;
    }
    const instanceById: Map<string, InstanceRecord> = new Map(
      state.instances.map((instance) => [instance.id, instance])
    );
    state.instances = (order as string[]).map((id) => instanceById.get(id) as InstanceRecord);
    await saveState(state);
    response.json(state.instances);
  })
);

apiRouter.patch(
  "/instances/:id",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }
    const payload = request.body as UpdateInstancePayload;
    if (typeof payload.label === "string" && payload.label.trim() !== "") {
      const nextLabel: string = payload.label.trim();
      const nameTaken: boolean = state.instances.some(
        (candidate) =>
          candidate.id !== instance.id &&
          candidate.locationPath === instance.locationPath &&
          candidate.label === nextLabel
      );
      if (nameTaken) {
        response.status(409).json({ error: `An instance named '${nextLabel}' is already running here` });
        return;
      }
      instance.label = nextLabel;
    }
    if (typeof payload.command === "string" && payload.command.trim() !== "") {
      instance.command = payload.command.trim();
    }
    if (payload.model !== undefined) {
      instance.model = typeof payload.model === "string" && payload.model.trim() !== "" ? payload.model.trim() : null;
    }
    if (payload.effort !== undefined) {
      instance.effort =
        typeof payload.effort === "string" && payload.effort.trim() !== "" ? payload.effort.trim() : null;
    }
    if (typeof payload.fontSize === "number" && payload.fontSize >= 10 && payload.fontSize <= 18) {
      instance.fontSize = payload.fontSize;
    }
    await saveState(state);
    response.json(instance);
  })
);

apiRouter.get(
  "/instances/:id/git",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }

    // Prefer the pane's live directory (reflects `cd`s made inside the terminal);
    // fall back to the stored starting path if the tmux session is gone.
    const cwd: string = await getPaneCurrentPath(instance.tmuxSession).catch(() => instance.locationPath);
    const branch: string | null = await currentBranch(cwd);

    response.json(branch === null ? { cwd } : { cwd, branch });
  })
);

apiRouter.get(
  "/instances/:id/live-status",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }

    const snapshotPath: string = resolveLiveStatusSnapshotPath(instance);

    try {
      let snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
      if (instance.provider === "codex") {
        snapshot = await enrichCodexStatus(snapshot);
      }
      const sessionId: unknown = snapshot.sessionId;
      if (typeof sessionId === "string" && sessionId !== "" && instance.sessionId !== sessionId) {
        instance.sessionId = sessionId;
        state.sessionsByKey[sessionKeyFor(instance.provider, instance.locationPath, instance.label)] = sessionId;
        await saveState(state);
      }
      response.json({ available: true, ...snapshot });
    } catch {
      // No statusLine snapshot yet for this directory (not configured, or Claude Code
      // hasn't redrawn its statusline here since this dashboard instance was launched)
      response.json({ available: false });
    }
  })
);

apiRouter.delete(
  "/instances/:id",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }

    // Read the pane's live session id before killing it, so a future instance reusing
    // this exact location+label can pick up the conversation where it left off.
    const liveSessionId: string | null = await readLiveSessionId(instance);
    if (liveSessionId !== null) {
      state.sessionsByKey[sessionKeyFor(instance.provider, instance.locationPath, instance.label)] = liveSessionId;
    }

    try {
      await killSession(instance.tmuxSession);
    } catch {
      // The session may have died already (reboot); does not block deletion
    }

    // The location is a permanent user folder: deleting the instance only closes
    // its terminal, it never touches the disk
    state.instances = state.instances.filter((candidate) => candidate.id !== instance.id);
    await saveState(state);
    response.status(204).end();
  })
);

