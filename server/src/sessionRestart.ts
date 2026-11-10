import path from "node:path";
import { resolveProfileDir, sameProfile, type AgentEnvironmentReading } from "./agentFallback";
import type { ParsedAgentStateFile } from "./agentState";
import { LAUNCH_COMMAND_ENV_NAME, wrapWithFreshFallback } from "./launch";
import type { AgentFound, PaneAgent } from "./paneAgent";
import {
  buildRestartCommand,
  currentMode,
  isAutoModeOn,
  isPromptEmpty,
  isValidSessionId,
  launcherToken,
  looksBusy,
  parseResumeHint,
  sanitizeError,
  stripResumeFlags,
  tokenizeCommandLine,
  versionFromPath,
  type ScreenMode,
} from "./restartCommand";
import type { SessionPresence } from "./tmux";
import type { InstanceRecord } from "./types";
import { quoteForShell } from "./providers";

export type RestartErrorCode =
  | "not-found"
  | "busy"
  | "input-not-empty"
  | "client-active"
  | "session-gone"
  | "restart-in-progress"
  | "shell-is-agent"
  | "no-agent"
  | "missing"
  | "no-state"
  | "exit-timeout"
  | "relaunch-timeout"
  | "relaunch-failed";

export type RestartMissing = "cwd" | "command" | "sessionId";

// Every message is fixed text: the launch command and tmux/ps errors can hold secrets.
export class RestartError extends Error {
  readonly code: RestartErrorCode;
  readonly missing?: RestartMissing[];
  readonly relaunchSent?: boolean;

  constructor(code: RestartErrorCode, message: string, extras: { missing?: RestartMissing[]; relaunchSent?: boolean } = {}) {
    super(message);
    this.name = "RestartError";
    this.code = code;
    if (extras.missing !== undefined) this.missing = extras.missing;
    if (extras.relaunchSent !== undefined) this.relaunchSent = extras.relaunchSent;
  }
}

export interface RestartResult {
  ok: true;
  // null when the session was started fresh.
  sessionId: string | null;
  // "no-conversation": there was nothing to resume. "resume-failed": the resume failed and the shell started fresh.
  startedFresh?: "no-conversation" | "resume-failed";
  hintSessionId?: string;
  replacedSessionId?: string;
  versionBefore: string | null;
  versionAfter: string | null;
  autoMode: "not-applicable" | "on" | "unconfirmed";
  currentMode?: ScreenMode;
  commandSource: "process" | "instance" | "hint";
}

export interface RestartDeps {
  getOriginalPaneId: (session: string) => Promise<string>;
  getOriginalPanePid: (session: string) => Promise<number>;
  getSessionPresence: (session: string) => Promise<SessionPresence>;
  getPaneCurrentPath: (target: string) => Promise<string>;
  capturePane: (target: string, lines: number) => Promise<string>;
  sendText: (target: string, text: string) => Promise<void>;
  sendEnter: (target: string) => Promise<void>;
  sendKey: (target: string, key: "BTab") => Promise<void>;
  setEnvironment: (session: string, name: string, value: string) => Promise<void>;
  unsetEnvironment: (session: string, name: string) => Promise<void>;
  clientActivitySeconds: (session: string) => Promise<number | null>;
  probePane: (instance: InstanceRecord, options: { bypassCache?: boolean }) => Promise<PaneAgent>;
  readAgentState: (instance: InstanceRecord) => Promise<ParsedAgentStateFile | null>;
  readAgentCwd: (agentPid: number) => Promise<string | null>;
  readAgentEnvironment: (agentPid: number) => Promise<AgentEnvironmentReading>;
  readAgentArgs: (agentPid: number) => Promise<string>;
  snapshotSessionId: (instance: InstanceRecord) => Promise<string | null>;
  transcriptExists: (profileDir: string, cwd: string, sessionId: string) => Promise<boolean>;
  pickTranscript: (profileDir: string, cwd: string, ownedSessionIds: ReadonlySet<string>) => Promise<string | null>;
  ownedSessionIds: (instance: InstanceRecord) => Promise<Set<string>>;
  buildInstanceCommand: (instance: InstanceRecord, sessionId: string | null) => string;
  loaderInvocation: string;
  withPaneTypingLock: <T>(session: string, run: () => Promise<T>) => Promise<T>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  // The orchestrator itself never logs: only the handler writes the one fixed line.
  log?: (line: string) => void;
}

const CAPTURE_LINES = 200;
const EXIT_GAP_MS = 200;
const EXIT_POLL_MS = 100;
const EXIT_TIMEOUT_MS = 20_000;
const VERIFY_POLL_MS = 250;
const VERIFY_TIMEOUT_MS = 30_000;
const ALIVE_AFTER_MS = 4_000;
const SCREEN_DRAWN_TIMEOUT_MS = 15_000;
const MAX_MODE_PRESSES = 8;
const MIN_CLIENT_IDLE_SECONDS = 2;
// After a resumed agent vanishes the shell has this long to start the fresh fallback.
const FALLBACK_START_WAIT_MS = 5_000;

const restartsInProgress: Set<string> = new Set();

export function isRestartInProgress(tmuxSession: string): boolean {
  return restartsInProgress.has(tmuxSession);
}

// A stop signal (tsx watch restarts the server on any file change, including edits made by the very
// session being restarted) used to cut the request and could leave a pane half done. Shutdown waits here.
export async function waitForRestartsToFinish(timeoutMs: number, pollMs = 100): Promise<boolean> {
  const deadline: number = Date.now() + timeoutMs;
  while (restartsInProgress.size > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

const STATUS_BY_CODE: Record<RestartErrorCode, number> = {
  "not-found": 404,
  busy: 409,
  "input-not-empty": 409,
  "client-active": 409,
  "session-gone": 409,
  "restart-in-progress": 409,
  "shell-is-agent": 422,
  "no-agent": 422,
  missing: 422,
  "no-state": 422,
  "exit-timeout": 502,
  "relaunch-timeout": 502,
  "relaunch-failed": 502,
};

export function restartErrorStatus(code: RestartErrorCode): number {
  return STATUS_BY_CODE[code];
}

interface CommandPlan {
  source: RestartResult["commandSource"];
  render: (sessionId: string | null) => string;
}

function countExitMarkers(paneText: string): number {
  return paneText.split("/exit").length - 1;
}

function launcherBasename(flatArgs: string): string {
  return path.basename(launcherToken(flatArgs.split(" ")) ?? "");
}

// Source order: the running process's own args, the instance's builder, the hint printed on exit.
function planCommand(
  instance: InstanceRecord,
  flatArgs: string,
  environment: AgentEnvironmentReading,
  hintCommand: string | null,
  deps: RestartDeps
): CommandPlan | null {
  const profile = environment.configDir;
  const configDir: string | undefined = profile.kind === "set" ? profile.dir : undefined;

  const processTokens: string[] | null = tokenizeCommandLine(flatArgs, instance.label);
  if (processTokens !== null) {
    const launcher: string = path.basename(launcherToken(processTokens) ?? "");
    // A bare claude would resume under the default profile, a guess when the profile is unknown.
    const guessesProfile: boolean = profile.kind === "unreadable" && (launcher === "claude" || launcher === "cli.js");
    if (!guessesProfile) {
      const tokens: string[] = stripResumeFlags(processTokens);
      return {
        source: "process",
        render: (sessionId) =>
          buildRestartCommand({ instanceId: instance.id, includeInstanceId: environment.hasInstanceId, configDir, tokens, sessionId }),
      };
    }
  }

  const instanceCommand: string = instance.command.trim();
  if (instanceCommand !== "" && launcherBasename(flatArgs) === path.basename(instanceCommand) && sameProfile(profile, instance.configDir)) {
    return { source: "instance", render: (sessionId) => deps.buildInstanceCommand(instance, sessionId) };
  }

  if (hintCommand !== null && profile.kind !== "unreadable") {
    const hintTokens: string[] | null = tokenizeCommandLine(hintCommand, instance.label);
    if (hintTokens !== null) {
      const tokens: string[] = stripResumeFlags(hintTokens);
      return {
        source: "hint",
        render: (sessionId) => buildRestartCommand({ instanceId: instance.id, includeInstanceId: false, configDir, tokens, sessionId }),
      };
    }
  }
  return null;
}

async function requireSamePane(deps: RestartDeps, session: string, paneId: string): Promise<void> {
  let currentPaneId: string | null = null;
  try {
    currentPaneId = await deps.getOriginalPaneId(session);
  } catch {
    // A missing pane and a failed lookup both mean there is nothing safe to type into.
  }
  if (currentPaneId !== paneId) throw new RestartError("session-gone", "The session or its pane is gone, nothing was changed further.");
}

function requireIdle(state: ParsedAgentStateFile | null, agent: AgentFound): ParsedAgentStateFile {
  if (state === null || state.paneJobPid !== agent.paneJobPid) {
    throw new RestartError("no-state", "This session does not report its state to the dashboard, so it cannot be proven idle.");
  }
  if (state.state !== "idle") throw new RestartError("busy", "The session is working or waiting for you; restart it once it is idle.");
  return state;
}

export async function restartClaudeSession(instance: InstanceRecord, deps: RestartDeps): Promise<RestartResult> {
  try {
    return await runRestart(instance, deps);
  } catch (error) {
    if (error instanceof RestartError) throw error;
    throw new Error(sanitizeError(error));
  }
}

async function runRestart(instance: InstanceRecord, deps: RestartDeps): Promise<RestartResult> {
  const session: string = instance.tmuxSession;

  // A PR delivery already typing holds this key; waiting here lets it finish its paste and Enter
  // before any gate reads the screen.
  await deps.withPaneTypingLock(session, async () => undefined);

  let paneId: string;
  let panePid: number;
  let agent: PaneAgent;
  try {
    paneId = await deps.getOriginalPaneId(session);
    panePid = await deps.getOriginalPanePid(session);
    agent = await deps.probePane(instance, { bypassCache: true });
  } catch {
    // A failed lookup means there is no pane we can safely type into.
    throw new RestartError("session-gone", "The session or its pane is gone, nothing was changed further.");
  }
  if (agent.kind !== "agent" || agent.provider !== "claude") {
    throw new RestartError("no-agent", "No Claude session is running in this pane.");
  }
  // Under `exec claude` the pane shell is the agent: /exit would end the pane itself.
  if (agent.paneJobPid === panePid) {
    throw new RestartError("shell-is-agent", "Claude replaces the pane shell here, so it cannot be restarted in place.");
  }

  const firstState: ParsedAgentStateFile = requireIdle(await deps.readAgentState(instance), agent);
  const beforeScreen: string = await deps.capturePane(paneId, CAPTURE_LINES);
  if (looksBusy(beforeScreen)) throw new RestartError("busy", "The session looks busy; restart it once it is idle.");
  if (!isPromptEmpty(beforeScreen)) {
    throw new RestartError("input-not-empty", "There is text in the prompt; clear it first, /exit would otherwise be sent as a message.");
  }

  const agentCwd: string | null = await deps.readAgentCwd(agent.agentPid);
  if (agentCwd === null) throw new RestartError("missing", "Could not read the session's working directory.", { missing: ["cwd"] });
  const environment: AgentEnvironmentReading = await deps.readAgentEnvironment(agent.agentPid);
  const wasAutoMode: boolean = isAutoModeOn(beforeScreen);
  const flatArgs: string = agent.paneJobArgs ?? "";
  const versionBefore: string | null = versionFromPath(await deps.readAgentArgs(agent.agentPid));

  // Weaker id sources are read now, while the profile and cwd can still be asked of the live agent.
  const stateId: string | null = typeof firstState.sessionId === "string" && isValidSessionId(firstState.sessionId) ? firstState.sessionId : null;
  const profileDir: string | null = resolveProfileDir(environment.configDir);
  let snapshotId: string | null = null;
  let weakId: string | null = null;
  if (stateId === null) {
    const snapshot: string | null = await deps.snapshotSessionId(instance);
    snapshotId = snapshot !== null && isValidSessionId(snapshot) ? snapshot : null;
  }
  if (stateId === null && snapshotId === null) {
    if (instance.sessionId && isValidSessionId(instance.sessionId) && sameProfile(environment.configDir, instance.configDir)) {
      weakId = instance.sessionId;
    } else if (profileDir !== null) {
      const picked: string | null = await deps.pickTranscript(profileDir, agentCwd, await deps.ownedSessionIds(instance));
      weakId = picked !== null && isValidSessionId(picked) ? picked : null;
    }
  }

  let finalStateId: string | null = stateId;
  let candidateId: string | null = null;
  // An unreadable profile cannot be searched, so it counts as "may have one": the shell fallback is the net.
  let candidateHasTranscript = true;
  await deps.withPaneTypingLock(session, async () => {
    const finalState: ParsedAgentStateFile = requireIdle(await deps.readAgentState(instance), agent);
    if (typeof finalState.sessionId === "string" && isValidSessionId(finalState.sessionId)) finalStateId = finalState.sessionId;
    const finalScreen: string = await deps.capturePane(paneId, CAPTURE_LINES);
    if (looksBusy(finalScreen)) throw new RestartError("busy", "The session looks busy; restart it once it is idle.");
    if (!isPromptEmpty(finalScreen)) throw new RestartError("input-not-empty", "There is text in the prompt; clear it first.");
    const idleSeconds: number | null = await deps.clientActivitySeconds(session);
    if (idleSeconds !== null && idleSeconds < MIN_CLIENT_IDLE_SECONDS) {
      throw new RestartError("client-active", "Someone is typing in this session right now; try again in a moment.");
    }
    await requireSamePane(deps, session, paneId);
    // Claude writes no transcript until the first message, and --resume of a missing one fails and exits.
    candidateId = finalStateId ?? snapshotId ?? weakId;
    if (candidateId !== null && profileDir !== null) candidateHasTranscript = await deps.transcriptExists(profileDir, agentCwd, candidateId);
    await deps.sendText(paneId, "/exit");
    // Same pacing as pasteToSession: an Enter sent at once can be swallowed by the input.
    await deps.sleep(EXIT_GAP_MS);
    await deps.sendEnter(paneId);
  });

  const exitDeadline: number = deps.now() + EXIT_TIMEOUT_MS;
  for (;;) {
    const probe: PaneAgent = await deps.probePane(instance, { bypassCache: true });
    // The wrapper can outlive claude; only the shell owning the foreground may receive the loader line.
    if (probe.kind === "none" && probe.shellOwnsForeground === true) break;
    await requireSamePane(deps, session, paneId);
    if (deps.now() >= exitDeadline) {
      throw new RestartError("exit-timeout", "Claude did not exit in time; nothing was relaunched and /exit may still be in the prompt.");
    }
    await deps.sleep(EXIT_POLL_MS);
  }

  const exitScreen: string = await deps.capturePane(paneId, CAPTURE_LINES);
  // A hint only counts when this exit added a marker, so an older /exit in the scrollback is never reused.
  const hint = countExitMarkers(exitScreen) > countExitMarkers(beforeScreen) ? parseResumeHint(exitScreen) : null;

  let sessionId: string | null;
  let hintSessionId: string | undefined;
  let replacedSessionId: string | undefined;
  const strongId: string | null = finalStateId ?? snapshotId;
  if (strongId !== null) {
    sessionId = strongId;
    if (hint !== null && hint.sessionId !== strongId) hintSessionId = hint.sessionId;
  } else if (hint !== null) {
    sessionId = hint.sessionId;
    if (weakId !== null && weakId !== hint.sessionId) replacedSessionId = weakId;
  } else {
    sessionId = weakId;
  }

  // A candidate with no transcript has nothing to resume. Claude prints a hint only when a transcript
  // exists, so a different hint id is a conversation worth keeping.
  let resume: boolean = sessionId === null || sessionId !== candidateId || candidateHasTranscript;
  if (!resume && hint !== null) {
    if (hint.sessionId !== sessionId) {
      replacedSessionId = sessionId ?? undefined;
      hintSessionId = undefined;
      sessionId = hint.sessionId;
    }
    resume = true;
  }
  // With a readable profile, no id and no hint means no conversation; an unreadable one cannot rule it out.
  const startedFresh: boolean = sessionId === null ? profileDir !== null : !resume;

  const plan: CommandPlan | null = planCommand(instance, flatArgs, environment, hint?.command ?? null, deps);
  const missing: RestartMissing[] = [];
  if (plan === null) missing.push("command");
  if (sessionId === null && !startedFresh) missing.push("sessionId");
  if (plan === null || (sessionId === null && !startedFresh)) {
    // Fixed wording per item: the UI shows only the message, and values must never reach it.
    const lacking: string = missing.map((item) => (item === "command" ? "the launch command" : "the session id")).join(" and ");
    throw new RestartError("missing", `Nothing was relaunched: ${lacking} could not be found; start Claude again from the terminal.`, { missing });
  }

  const paneCwd: string = await deps.getPaneCurrentPath(paneId);
  // The shell itself starts fresh if the resume dies at once, so no second keystroke reaches the pane.
  const rendered: string = startedFresh || sessionId === null ? plan.render(null) : wrapWithFreshFallback(plan.render(sessionId), plan.render(null));
  // Braces keep a failed cd from running the first half of the fallback in the wrong directory.
  const launchCommand: string = paneCwd === agentCwd ? rendered : `cd -- ${quoteForShell(agentCwd)} && { ${rendered}; }`;

  await deps.withPaneTypingLock(session, async () => {
    await requireSamePane(deps, session, paneId);
    const dropEnvironment = async (): Promise<void> => {
      await deps.unsetEnvironment(session, LAUNCH_COMMAND_ENV_NAME).catch(() => undefined);
    };
    try {
      await deps.setEnvironment(session, LAUNCH_COMMAND_ENV_NAME, launchCommand);
      await deps.sendText(paneId, deps.loaderInvocation);
    } catch {
      await dropEnvironment();
      throw new RestartError("relaunch-failed", "Could not start the relaunch; the session is at the shell prompt.");
    }
    try {
      await deps.sendEnter(paneId);
    } catch (error) {
      // A timed-out Enter may still have reached the loader, which already read the command.
      if ((error as { killed?: boolean } | null)?.killed === true) return;
      await dropEnvironment();
      throw new RestartError("relaunch-failed", "Could not press Enter for the relaunch; the loader line is still in the prompt.");
    }
  });

  const resumed: boolean = !startedFresh && sessionId !== null;
  const relaunched: AgentFound = await verifyRelaunch(instance, deps, paneId, agent.paneJobPid, resumed);
  const versionAfter: string | null = await deps.readAgentArgs(relaunched.agentPid).then(versionFromPath, () => null);
  // The running process tells which half of the wrapper ran; without its args the resume is assumed to have held.
  const fellBackToFresh: boolean = resumed && relaunched.paneJobArgs !== undefined && !/(^| )--resume( |=)/.test(relaunched.paneJobArgs);

  const result: RestartResult = {
    ok: true,
    sessionId: startedFresh ? null : sessionId,
    versionBefore,
    versionAfter,
    autoMode: "not-applicable",
    commandSource: plan.source,
    ...(startedFresh ? { startedFresh: "no-conversation" as const } : fellBackToFresh ? { startedFresh: "resume-failed" as const } : {}),
    ...(hintSessionId !== undefined ? { hintSessionId } : {}),
    ...(replacedSessionId !== undefined ? { replacedSessionId } : {}),
  };
  if (!wasAutoMode) return result;
  try {
    return { ...result, ...(await restoreAutoMode(instance, deps, paneId, relaunched)) };
  } catch (error) {
    if (error instanceof RestartError) throw error;
    // The session already restarted; a mode-restore fault must not turn that into a 500.
    return { ...result, autoMode: "unconfirmed", currentMode: "unknown" };
  }
}

async function verifyRelaunch(
  instance: InstanceRecord,
  deps: RestartDeps,
  paneId: string,
  previousPaneJobPid: number,
  resumed: boolean
): Promise<AgentFound> {
  const session: string = instance.tmuxSession;
  const deadline: number = deps.now() + VERIFY_TIMEOUT_MS;
  let seen: AgentFound | null = null;
  let seenAtMs = 0;
  let agentsLost = 0;
  let lostAtMs = 0;
  while (deps.now() < deadline) {
    const probe: PaneAgent = await deps.probePane(instance, { bypassCache: true });
    if (probe.kind === "unknown" && (await deps.getSessionPresence(session)) === "absent") {
      throw new RestartError("session-gone", "The session disappeared during the relaunch.");
    }
    await requireSamePane(deps, session, paneId);
    if (probe.kind === "agent" && probe.provider === "claude" && probe.paneJobPid !== previousPaneJobPid) {
      // A new pid means the fallback replaced the resumed process between two polls: start its clock over.
      if (seen === null || seen.paneJobPid !== probe.paneJobPid) {
        seen = probe;
        seenAtMs = deps.now();
      }
      if (deps.now() - seenAtMs >= ALIVE_AFTER_MS) return seen;
    } else if (seen !== null && probe.kind !== "unknown") {
      agentsLost += 1;
      // A resumed agent that dies at once is the shell's cue to start the fresh one; only one such handover exists.
      if (!resumed || agentsLost > 1) {
        throw new RestartError("relaunch-failed", "The relaunched session exited right away; check the conversation id and flags.");
      }
      seen = null;
      lostAtMs = deps.now();
    } else if (agentsLost > 0 && probe.kind === "none" && probe.shellOwnsForeground === true && deps.now() - lostAtMs >= FALLBACK_START_WAIT_MS) {
      throw new RestartError("relaunch-failed", "The relaunched session exited right away and no fresh session followed.");
    }
    await deps.sleep(VERIFY_POLL_MS);
  }
  throw new RestartError("relaunch-timeout", "The relaunch was sent and may be starting; check the terminal before doing anything else.", {
    relaunchSent: true,
  });
}

// Shift+Tab cycles the permission modes; it stops when auto shows, or when the cycle comes back around.
async function restoreAutoMode(
  instance: InstanceRecord,
  deps: RestartDeps,
  paneId: string,
  relaunched: AgentFound
): Promise<Pick<RestartResult, "autoMode" | "currentMode">> {
  const session: string = instance.tmuxSession;
  const drawnDeadline: number = deps.now() + SCREEN_DRAWN_TIMEOUT_MS;
  for (;;) {
    const state: ParsedAgentStateFile | null = await deps.readAgentState(instance);
    if (state !== null && state.paneJobPid === relaunched.paneJobPid) break;
    if (deps.now() >= drawnDeadline) return { autoMode: "unconfirmed", currentMode: "unknown" };
    await deps.sleep(VERIFY_POLL_MS);
  }

  const startingMode: ScreenMode = currentMode(await deps.capturePane(paneId, CAPTURE_LINES));
  if (startingMode === "auto") return { autoMode: "on" };
  if (startingMode === "unknown") return { autoMode: "unconfirmed", currentMode: "unknown" };

  let mode: ScreenMode = startingMode;
  for (let press = 0; press < MAX_MODE_PRESSES; press += 1) {
    await deps.withPaneTypingLock(session, async () => {
      await requireSamePane(deps, session, paneId);
      await deps.sendKey(paneId, "BTab");
    });
    await deps.sleep(VERIFY_POLL_MS);
    mode = currentMode(await deps.capturePane(paneId, CAPTURE_LINES));
    if (mode === "auto") return { autoMode: "on" };
    if (mode === startingMode) break;
  }
  return { autoMode: "unconfirmed", currentMode: mode };
}

export interface RestartHandlerDeps {
  loadInstance: (instanceId: string) => Promise<InstanceRecord | undefined>;
  restart: (instance: InstanceRecord) => Promise<RestartResult>;
  log: (line: string) => void;
}

export interface RestartResponse {
  status: number;
  body: Record<string, unknown>;
}

// Takes no session lock: withSessionLock is not reentrant and the orchestrator uses the plain key.
export async function handleRestartRequest(instanceId: string, deps: RestartHandlerDeps): Promise<RestartResponse> {
  const instance: InstanceRecord | undefined = await deps.loadInstance(instanceId);
  if (instance === undefined) {
    deps.log(`restart ${instanceId} not-found`);
    return { status: 404, body: { code: "not-found", error: "Instance not found." } };
  }
  const session: string = instance.tmuxSession;
  // No await between this check and the add, and the early return sits outside the try so a
  // rejected request never clears the running one's entry.
  if (restartsInProgress.has(session)) {
    deps.log(`restart ${instanceId} restart-in-progress`);
    return { status: 409, body: { code: "restart-in-progress", error: "A restart is already running for this session." } };
  }
  restartsInProgress.add(session);
  try {
    const result: RestartResult = await deps.restart(instance);
    deps.log(`restart ${instanceId} ok`);
    return { status: 200, body: { ...result } };
  } catch (error) {
    if (error instanceof RestartError) {
      deps.log(`restart ${instanceId} ${error.code}`);
      return {
        status: restartErrorStatus(error.code),
        body: {
          code: error.code,
          error: error.message,
          ...(error.missing !== undefined ? { missing: error.missing } : {}),
          ...(error.relaunchSent !== undefined ? { relaunchSent: error.relaunchSent } : {}),
        },
      };
    }
    deps.log(`restart ${instanceId} error`);
    return { status: 500, body: { error: "The restart failed unexpectedly." } };
  } finally {
    restartsInProgress.delete(session);
  }
}
