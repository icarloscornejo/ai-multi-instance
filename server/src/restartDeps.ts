import { promises as fs } from "node:fs";
import path from "node:path";
import { claudeTranscriptExists, pickClaudeTranscript, readAgentArgs, readAgentConfigDir, readAgentCwd } from "./agentFallback";
import { parseAgentStateFile, probePaneAgent, readAgentStateFile } from "./agentState";
import { buildLoaderInvocation } from "./launch";
import { listSiblingSnapshots, ownedSessionIds, persistableSession, snapshotDirectory, type Snapshot } from "./liveStatus";
import { buildProviderLaunchCommand } from "./providers";
import { withSessionLock } from "./sessionLock";
import type { RestartDeps } from "./sessionRestart";
import {
  capturePane,
  clientActivitySeconds,
  getOriginalPaneId,
  getOriginalPanePid,
  getPaneCurrentPath,
  getSessionPresence,
  sendEnterToPane,
  sendKeyToPane,
  sendTextToPane,
  setSessionEnvironment,
  unsetSessionEnvironment,
} from "./tmux";

// The only place the restart flow touches real tmux, ps and the filesystem; tests inject fakes.
export function realRestartDeps(): RestartDeps {
  return {
    getOriginalPaneId,
    getOriginalPanePid,
    getSessionPresence,
    getPaneCurrentPath,
    capturePane,
    sendText: sendTextToPane,
    sendEnter: sendEnterToPane,
    sendKey: sendKeyToPane,
    setEnvironment: setSessionEnvironment,
    unsetEnvironment: unsetSessionEnvironment,
    clientActivitySeconds,
    probePane: probePaneAgent,
    readAgentState: async (instance) => {
      const raw: string | null = await readAgentStateFile(instance.id);
      return raw === null ? null : parseAgentStateFile(raw);
    },
    readAgentCwd,
    readAgentEnvironment: readAgentConfigDir,
    readAgentArgs,
    snapshotSessionId: async (instance) => {
      // No snapshot yet (statusline not configured) is a normal answer, not a failure.
      const snapshot: Snapshot | null = await fs
        .readFile(path.join(snapshotDirectory(), `${instance.id}.json`), "utf8")
        .then((text) => JSON.parse(text) as Snapshot, () => null);
      const agent = await probePaneAgent(instance, { bypassCache: true });
      return persistableSession(instance, snapshot, agent)?.sessionId ?? null;
    },
    transcriptExists: claudeTranscriptExists,
    pickTranscript: pickClaudeTranscript,
    ownedSessionIds: async (instance) => ownedSessionIds(await listSiblingSnapshots(), instance.id, Date.now()),
    buildInstanceCommand: (instance, sessionId) => buildProviderLaunchCommand(instance, sessionId ?? undefined),
    loaderInvocation: buildLoaderInvocation(),
    withPaneTypingLock: withSessionLock,
    sleep: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
  };
}
