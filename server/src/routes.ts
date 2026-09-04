import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { AUTH_COOKIE_NAME, checkPassword, isAuthEnabled, issueToken, readCookie, requireAuth, setStoredPassword, verifyToken } from "./auth";
import { isAgentProvider, PROVIDERS, sessionKeyFor } from "./providers";
import { pathExists } from "./paths";
import { loadState, saveState } from "./store";
import { exitCopyMode, getPaneCurrentPath, killSession } from "./tmux";
import { isRemoteUnreachableError, NETWORK_GIT_TIMEOUT_MS, runGit } from "./git";
import { LaunchProgress } from "./launchProgress";
import { initializeInstanceSession } from "./terminal";
import { getTunnelStatus, readTunnelLog, startTunnel, stopTunnel } from "./tunnel";
import { getNamedTunnelStatus, getTunnelMode, startNamedTunnel, stopNamedTunnel } from "./namedTunnel";
import { isLocalRequestHost } from "./requestHost";
import { applyUpdate, checkForUpdate, getUpdateStatus, resetToRemote } from "./updater";
import type {
  BranchAction,
  CreateInstancePayload,
  DashboardState,
  InstanceRecord,
  StaleBranchesResponse,
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

// Picks a private IPv4 address other devices on the same LAN can reach (e.g. Wi-Fi at
// home): the first non-internal IPv4 in a standard private range, skipping VPN/virtual
// interfaces that don't route to the physical LAN.
function getLanUrl(): string | null {
  const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        (address.address.startsWith("192.168.") ||
          address.address.startsWith("10.") ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(address.address))
      ) {
        return `http://${address.address}`;
      }
    }
  }
  return null;
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // Not a git repo, git not installed, or the folder does not exist anymore
    return null;
  }
}

async function localBranches(cwd: string): Promise<string[]> {
  const stdout: string = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch !== "");
}

// Long-lived branches: never listed as deletable, and never candidates to switch off of
// when deleting the branch checked out in a location.
const PROTECTED_BRANCH_NAMES: string[] = ["main", "master", "develop", "dev"];

function isProtectedBranchName(branch: string): boolean {
  return PROTECTED_BRANCH_NAMES.includes(branch);
}

// First protected branch name that actually exists locally. Used only as a safe branch to
// switch to when deleting whatever is currently checked out in a location.
function localProtectedBranch(branches: string[]): string | null {
  return PROTECTED_BRANCH_NAMES.find((name) => branches.includes(name)) ?? null;
}

// Branches checked out in *other* worktrees of this repo (the primary worktree, cwd
// itself, is excluded: its checked-out branch is handled like any other candidate, not
// specially skipped, so that a branch you happen to be sitting on can still be cleaned
// up). Maps branch name to that worktree's path, so it can be offered for cleanup
// (removing the worktree along with the branch).
async function branchesCheckedOutInWorktrees(cwd: string): Promise<Map<string, string>> {
  const stdout: string = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  const resolvedCwd: string = path.resolve(cwd);
  const branches: Map<string, string> = new Map();
  let currentWorktreePath: string | null = null;
  for (const line of stdout.split("\n")) {
    const worktreeMatch: RegExpMatchArray | null = line.match(/^worktree (.+)$/);
    if (worktreeMatch) {
      currentWorktreePath = worktreeMatch[1];
      continue;
    }
    const branchMatch: RegExpMatchArray | null = line.match(/^branch refs\/heads\/(.+)$/);
    if (branchMatch && currentWorktreePath !== null && path.resolve(currentWorktreePath) !== resolvedCwd) {
      branches.set(branchMatch[1], currentWorktreePath);
    }
  }
  return branches;
}

// Every local branch except the protected long-lived ones (main/master/develop/dev): no
// merged/squash-merged check, you pick whatever you want to delete. Purely local git
// calls, no network fetch, so this is effectively instant.
async function findStaleBranches(cwd: string): Promise<StaleBranchesResponse> {
  let branches: string[];
  let current: string | null;
  try {
    branches = await localBranches(cwd);
    current = await currentBranch(cwd);
  } catch {
    return { isGitRepo: false, currentBranch: null, candidates: [] };
  }

  const worktreeBranches: Map<string, string> = await branchesCheckedOutInWorktrees(cwd);
  const candidates: { branch: string; worktreePath?: string }[] = branches
    .filter((branch) => !isProtectedBranchName(branch))
    .map((branch) => {
      const worktreePath: string | undefined = worktreeBranches.get(branch);
      return worktreePath !== undefined ? { branch, worktreePath } : { branch };
    });

  return { isGitRepo: true, currentBranch: current, candidates };
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

// Fail closed at the public edge. In named-tunnel mode the cloudflared connector outlives this
// process, so if the password ever disappears (data/auth-password.json deleted, DASHBOARD_PASSWORD
// dropped from the launchd environment) while the connector is still up, isAuthEnabled() goes
// false and every route below - including the terminal API - would answer the public URL with no
// login at all. Reject those requests before they reach anything. Local and LAN paths are
// untouched, which is exactly where the user goes to set a password back. Registered before the
// /auth/* routes on purpose: from the public URL with no password, you cannot even set one - that
// has to be done locally.
apiRouter.use((request: Request, response: Response, next: NextFunction): void => {
  if (getTunnelMode() === "named" && !isAuthEnabled() && !isLocalRequestHost(request.headers.host)) {
    response.status(503).json({
      error: "This dashboard has no password set. Set one from the local network (ai.local) before using the public URL.",
    });
    return;
  }
  next();
});

// The tunnel controls (start/stop/status/logs) must never be usable through the public URL, even
// by an authenticated visitor: whoever finds that URL could otherwise tear down or spin up the
// tunnel, or read the connector log. The UI already hides these off ai.local (SetupScreen.tsx),
// this is the server-side backstop for that policy. Authentication stays a separate, additional
// requirement via requireAuth below.
function requireLocalHost(request: Request, response: Response, next: NextFunction): void {
  if (!isLocalRequestHost(request.headers.host)) {
    response.status(403).json({ error: "Tunnel controls are only available on the local network." });
    return;
  }
  next();
}

// The auth cookie is bearer-equivalent and long-lived (~180 days). Mark it Secure whenever it is
// issued to the public hostname, so a browser will never send it back over plain HTTP to that
// host. ai.local and LAN access are plain HTTP by design (see Caddyfile) and must keep getting a
// non-Secure cookie, so this is conditional on the request host, not unconditional. The decision
// is keyed to the Host header rather than X-Forwarded-Proto because this app sets no `trust proxy`
// and should not start trusting arbitrary forwarded headers for a security decision.
function authCookieOptions(request: Request, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !isLocalRequestHost(request.headers.host),
    maxAge: maxAgeMs,
  };
}

function resolveHomePath(rawPath: string): string {
  return path.resolve(rawPath.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

// Registered before requireAuth below so the gate itself stays reachable
// without a cookie; every route after this line is protected.
apiRouter.post(
  "/auth/login",
  wrapAsync(async (request, response) => {
    if (!isAuthEnabled()) {
      response.json({ ok: true });
      return;
    }
    const { password } = request.body as { password?: unknown };
    if (typeof password !== "string" || !checkPassword(password)) {
      response.status(401).json({ error: "Incorrect password" });
      return;
    }
    const { value, maxAgeMs } = await issueToken();
    response.cookie(AUTH_COOKIE_NAME, value, authCookieOptions(request, maxAgeMs));
    response.json({ ok: true });
  })
);

// Registered before requireAuth for the bootstrap case (no password set yet, e.g. from the
// "Start tunnel" flow); if a password already exists, it requires the caller to already be
// authenticated so a stranger cannot silently overwrite it.
apiRouter.post(
  "/auth/set-password",
  wrapAsync(async (request, response) => {
    const { password } = request.body as { password?: unknown };
    const trimmedPassword: string = typeof password === "string" ? password.trim() : "";
    if (trimmedPassword.length < 8) {
      response.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }
    if (isAuthEnabled()) {
      const token: string | undefined = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
      if (!(await verifyToken(token))) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    setStoredPassword(trimmedPassword);
    const { value, maxAgeMs } = await issueToken();
    response.cookie(AUTH_COOKIE_NAME, value, authCookieOptions(request, maxAgeMs));
    response.json({ ok: true });
  })
);

apiRouter.use(requireAuth);

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

apiRouter.get(
  "/locations/stale-branches",
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
    response.json(await findStaleBranches(locationPath));
  })
);

apiRouter.post(
  "/locations/stale-branches/delete",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const locationPath: string = typeof request.body.path === "string" ? request.body.path.trim() : "";
    const requestedBranches: unknown = request.body.branches;
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
    if (!Array.isArray(requestedBranches) || !requestedBranches.every((branch) => typeof branch === "string")) {
      response.status(400).json({ error: "Provide the branches to delete." });
      return;
    }

    // Recompute candidates now, rather than trusting the client's earlier snapshot: the
    // repo may have changed (new commits, a checkout, a new worktree) between when the
    // list was fetched and when the user clicked delete.
    const { candidates, currentBranch: checkedOutBranch } = await findStaleBranches(locationPath);
    const candidatesByName: Map<string, { branch: string; worktreePath?: string }> = new Map(
      candidates.map((candidate) => [candidate.branch, candidate])
    );
    const invalidBranch: string | undefined = requestedBranches.find((branch) => !candidatesByName.has(branch));
    if (invalidBranch !== undefined) {
      response.status(400).json({ error: `'${invalidBranch}' is no longer a listed branch for this location.` });
      return;
    }

    // Deleting the branch checked out in this location requires switching off it first.
    if (checkedOutBranch !== null && requestedBranches.includes(checkedOutBranch)) {
      const branches: string[] = await localBranches(locationPath).catch(() => []);
      const switchTarget: string | null = localProtectedBranch(branches);
      if (switchTarget === null) {
        response.status(409).json({
          error: `Could not find a local main/master/develop/dev branch to switch to before deleting '${checkedOutBranch}'.`,
        });
        return;
      }
      try {
        await runGit(locationPath, ["checkout", switchTarget]);
      } catch (error) {
        response
          .status(409)
          .json({ error: `Could not switch off '${checkedOutBranch}' before deleting it: ${(error as Error).message}` });
        return;
      }
    }

    const deleted: string[] = [];
    const failed: { branch: string; error: string }[] = [];
    let removedWorktree: boolean = false;
    for (const branch of requestedBranches) {
      const worktreePath: string | undefined = candidatesByName.get(branch)?.worktreePath;
      try {
        if (worktreePath !== undefined) {
          // Checked out elsewhere: force-remove that worktree (discarding any uncommitted
          // changes in it) before the branch itself can be deleted.
          await runGit(locationPath, ["worktree", "remove", "--force", worktreePath]);
          removedWorktree = true;
        }
        await runGit(locationPath, ["branch", "-D", branch]);
        deleted.push(branch);
      } catch (error) {
        failed.push({ branch, error: (error as Error).message });
      }
    }
    if (removedWorktree) {
      try {
        await runGit(locationPath, ["worktree", "prune"]);
      } catch {
        // Best-effort cleanup of any leftover worktree metadata
      }
    }
    response.json({ deleted, failed });
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

apiRouter.post(
  "/update/reset",
  wrapAsync(async (_request, response) => {
    response.json(await resetToRemote());
  })
);

// getTunnelMode() picks the backend: "named" when data/named-tunnel/tunnel.json exists (opt-in,
// written by scripts/setup-named-tunnel.sh), "quick" otherwise (the zero-config default). The
// two share the TunnelStatus shape and this same set of routes.
apiRouter.get(
  "/tunnel",
  requireLocalHost,
  wrapAsync(async (_request, response) => {
    response.json(getTunnelMode() === "named" ? await getNamedTunnelStatus() : getTunnelStatus());
  })
);

apiRouter.post(
  "/tunnel/start",
  requireLocalHost,
  wrapAsync(async (_request, response) => {
    if (!isAuthEnabled()) {
      response.status(409).json({ error: "Set DASHBOARD_PASSWORD before exposing the dashboard to the internet." });
      return;
    }
    response.json(getTunnelMode() === "named" ? await startNamedTunnel() : await startTunnel());
  })
);

apiRouter.post(
  "/tunnel/stop",
  requireLocalHost,
  wrapAsync(async (_request, response) => {
    response.json(getTunnelMode() === "named" ? await stopNamedTunnel() : stopTunnel());
  })
);

// Full cloudflared output for diagnosing failures that only show up after the tunnel already
// reported a URL (edge disconnects, protocol errors), which the short-lived status error field
// never captures. Both modes write to the same data/cloudflared.log (quick via tunnel.ts's own
// append, named via the LaunchAgent's --logfile), so one reader covers both.
apiRouter.get("/tunnel/logs", requireLocalHost, (_request, response) => {
  response.type("text/plain").send(readTunnelLog());
});

// Lets the phone scan a second QR for same-network access (no cloudflared/DNS involved),
// separate from the tunnel: Caddy already rewrites the Host header for any LAN IP (see
// Caddyfile), so this just needs to report an address that reaches this machine.
apiRouter.get("/lan-address", (_request, response) => {
  response.json({ url: getLanUrl() });
});

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

const REMOTE_UNREACHABLE_MESSAGE: string =
  "Could not reach 'origin' to update the base branch. If it is a corporate remote, check the VPN. " +
  "Creating a new branch needs the remote; checking out a branch that already exists locally works offline.";

apiRouter.post(
  "/instances",
  wrapAsync(async (request, response) => {
    const payload = request.body as CreateInstancePayload;
    const state: DashboardState = await loadState();
    const { locations } = state.config;

    // ===================================================================================
    // Phase 1 - validation, no side effects. Everything that can be rejected on the input
    // alone runs here and still answers with its own HTTP status (400/409), exactly as
    // before. The provider checks used to run AFTER the git block, which meant an invalid
    // provider cost a ~15s fetch before the rejection; they are hoisted here now.
    // ===================================================================================
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
    let branchActionBranch = "";
    let branchActionBase = "";
    if (branchAction !== undefined) {
      branchActionBranch = typeof branchAction.branch === "string" ? branchAction.branch.trim() : "";
      if (branchActionBranch === "" || (branchAction.type !== "checkout" && branchAction.type !== "create")) {
        response.status(400).json({ error: "Provide a valid branch action." });
        return;
      }
      if (branchAction.type === "create" && (typeof branchAction.baseBranch !== "string" || branchAction.baseBranch.trim() === "")) {
        response.status(400).json({ error: "Provide the base branch to create from." });
        return;
      }
      branchActionBase = branchAction.type === "create" ? (branchAction.baseBranch as string).trim() : "";
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
    const resumeSessionId: string | undefined =
      payload.resumeSession === false ? undefined : state.sessionsByKey[resumeKey];

    // ===================================================================================
    // Phase 2 - execution, with side effects. The status (kept at 201) and headers are on
    // the wire from flushHeaders() on, so NOTHING below may throw out of the handler: a
    // failure becomes a terminal `error` event, `finally` always ends the response. See
    // index.ts's error middleware for the headersSent guard that backs this up.
    // ===================================================================================
    response.status(201);
    response.setHeader("Content-Type", "application/x-ndjson");
    response.setHeader("Cache-Control", "no-store");
    // Belt and braces against a proxy that might otherwise buffer the whole body.
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    const progress = new LaunchProgress((line) => {
      response.write(line);
    });
    // A client that navigates away or a proxy that drops the connection: stop writing, but
    // never abort the tmux session / agent coming up behind it.
    request.on("close", () => progress.markSinkClosed());
    response.on("error", () => progress.markSinkClosed());

    const sessionStepLabel: Record<"create-session" | "launch-agent", string> = {
      "create-session": "Starting tmux session",
      "launch-agent": shellOnly ? "Opening shell" : `Launching ${instance.command}`,
    };

    let persisted = false;
    try {
      if (resumeSessionId !== undefined) {
        progress.stepStart("prepare-resume", "Preparing session resume");
        instance.sessionId = resumeSessionId;
        const sessionFile: string | undefined =
          provider === "codex" ? await findCodexSessionFile(resumeSessionId) : undefined;
        await writeSessionSnapshot(instance, resumeSessionId, sessionFile ? { sessionFile } : {});
        progress.stepDone("prepare-resume");
      }

      if (branchAction !== undefined) {
        try {
          if (branchAction.type === "checkout") {
            progress.stepStart("checkout-branch", `Checking out ${branchActionBranch}`);
            await runGit(locationPath, ["checkout", branchActionBranch]);
            progress.stepDone("checkout-branch");
          } else {
            progress.stepStart("fetch-base", `Fetching ${branchActionBase} from origin`);
            await runGit(locationPath, ["fetch", "origin", branchActionBase], NETWORK_GIT_TIMEOUT_MS);
            progress.stepDone("fetch-base");

            progress.stepStart("update-base", `Updating ${branchActionBase}`);
            const activeBranch: string | null = await currentBranch(locationPath);
            if (activeBranch === branchActionBase) {
              // The base branch is checked out here: fast-forward it in place, never overwrite local commits
              await runGit(locationPath, ["merge", "--ff-only", `origin/${branchActionBase}`]);
            } else {
              // Not checked out: update its ref directly. A plain (non "+") refspec is fast-forward-only,
              // git refuses on its own if the local base branch has diverged from origin
              await runGit(locationPath, ["fetch", "origin", `${branchActionBase}:${branchActionBase}`], NETWORK_GIT_TIMEOUT_MS);
            }
            progress.stepDone("update-base");

            progress.stepStart("create-branch", `Creating branch ${branchActionBranch}`);
            await runGit(locationPath, ["checkout", "-b", branchActionBranch, branchActionBase]);
            progress.stepDone("create-branch");
          }
        } catch (error) {
          // An unreachable remote (corporate host with no VPN) is the common case here, and
          // the raw git/ssh message does not point at the fix.
          progress.fail(
            isRemoteUnreachableError(error)
              ? REMOTE_UNREACHABLE_MESSAGE
              : `Could not switch branches: ${(error as Error).message}`
          );
          return;
        }
      }

      // Same guarded create+launch sequence the attach path uses (terminal.ts's
      // initializeInstanceSession), with the instance persisted in the hook that fires right
      // after the session exists and BEFORE the provider launch: once the launch may have been
      // applied, a failure must not strand a live agent in a session with no instance record
      // pointing at it (no attach route, no DELETE). `persisted` tells the two failure kinds
      // apart - a create failure before the hook is a real `error` with nothing saved; a
      // post-launch failure keeps `done` (with the instance) plus a `step-warning`, and the
      // user attaches or deletes explicitly.
      try {
        await initializeInstanceSession(
          instance,
          async () => {
            progress.stepStart("persist", "Saving instance");
            state.instances.push(instance);
            await saveState(state);
            persisted = true;
            progress.stepDone("persist");
          },
          (step, phase) => {
            if (phase === "start") {
              progress.stepStart(step, sessionStepLabel[step]);
            } else {
              progress.stepDone(step);
            }
          }
        );
      } catch (error) {
        if (!persisted) {
          progress.fail(`Could not create the instance: ${(error as Error).message}`);
          return;
        }
        console.error(
          `[server] instance ${instance.id}: provider launch did not confirm, keeping the session`,
          (error as Error).message
        );
        progress.stepWarning(
          "launch-agent",
          "The agent launch could not be confirmed. The session is running - attach to check on it."
        );
      }

      progress.done(instance);
    } catch (error) {
      // A failure with no more specific handler (writeSessionSnapshot, an unexpected throw).
      // Never rethrow: headers are already sent.
      progress.fail(`Could not create the instance: ${(error as Error).message}`);
    } finally {
      response.end();
    }
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

apiRouter.post(
  "/instances/:id/scroll-to-bottom",
  wrapAsync(async (request, response) => {
    const state: DashboardState = await loadState();
    const instance = state.instances.find((candidate) => candidate.id === request.params.id);
    if (instance === undefined) {
      response.status(404).json({ error: "Instance not found." });
      return;
    }

    await exitCopyMode(instance.tmuxSession);
    response.json({ ok: true });
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

