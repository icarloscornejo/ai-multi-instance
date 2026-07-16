import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { buildLaunchCommand } from "./launch";
import { loadState, saveState } from "./store";
import { createSession, getPaneCurrentPath, hasSession, killSession, sendCommandToSession } from "./tmux";
import { applyUpdate, checkForUpdate, getUpdateStatus } from "./updater";
import type {
  BranchAction,
  CreateInstancePayload,
  DashboardState,
  InstanceRecord,
  UpdateInstancePayload,
} from "./types";

const DEFAULT_FONT_SIZE = 13;
const DEFAULT_COMMAND = "claude";

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
    const { locations } = request.body as { locations?: unknown };
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
    state.config = { locations: resolvedLocations };
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
          await execFileAsync("git", ["-C", locationPath, "checkout", "-b", branch, branchAction.baseBranch.trim()]);
        }
      } catch (error) {
        response.status(409).json({ error: `Could not switch branches: ${(error as Error).message}` });
        return;
      }
    }

    const shellOnly: boolean = payload.shellOnly === true;
    const instanceId: string = randomUUID().slice(0, 8);
    const instance: InstanceRecord = {
      id: instanceId,
      label: requestedLabel,
      locationPath,
      tmuxSession: `ccdash-${instanceId}`,
      command:
        typeof payload.command === "string" && payload.command.trim() !== ""
          ? payload.command.trim()
          : DEFAULT_COMMAND,
      model: typeof payload.model === "string" && payload.model.trim() !== "" ? payload.model.trim() : null,
      effort: typeof payload.effort === "string" && payload.effort.trim() !== "" ? payload.effort.trim() : null,
      fontSize: DEFAULT_FONT_SIZE,
      createdAt: new Date().toISOString(),
      ...(shellOnly ? { shellOnly: true } : {}),
    };

    try {
      await createSession(instance.tmuxSession, instance.locationPath);
      if (!shellOnly) {
        await sendCommandToSession(instance.tmuxSession, buildLaunchCommand(instance));
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

apiRouter.get(
  "/instances/:id/status",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }
    response.json({ alive: await hasSession(instance.tmuxSession) });
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
      instance.label = payload.label.trim();
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

apiRouter.delete(
  "/instances/:id",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
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

apiRouter.post(
  "/instances/:id/relaunch",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }
    if (!(await hasSession(instance.tmuxSession))) {
      await createSession(instance.tmuxSession, instance.locationPath);
    }
    if (!instance.shellOnly) {
      await sendCommandToSession(instance.tmuxSession, buildLaunchCommand(instance));
    }
    response.status(204).end();
  })
);
