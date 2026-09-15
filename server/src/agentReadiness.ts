// Tracks, per instance, whether the underlying agent (or plain shell) has actually started -
// independent of any specific browser WebSocket connection. This exists because the HTTP
// response that creates an instance (POST /api/instances, routes.ts) already waits for the
// launch command to be sent to tmux before it returns, so by the time a browser mounts
// TerminalView and opens its own WebSocket, a fast-booting agent may already be running: any
// readiness signal observed only on that browser's own pty stream would arrive too late (see
// terminal.ts's watchForAgentReady, which is what actually flips this state via tmux's
// "wait-for" channel, not a fresh attach reading screen contents).
//
// Dependency-free on purpose (no tmux, no node-pty) so it can be unit tested directly.

export type AgentReadinessState = "booting" | "ready";

interface ReadinessEntry {
  state: AgentReadinessState;
  channelName: string;
}

const entriesByInstanceId = new Map<string, ReadinessEntry>();
const waitersByInstanceId = new Map<string, Set<() => void>>();

export function markAgentBooting(instanceId: string, channelName: string): void {
  entriesByInstanceId.set(instanceId, { state: "booting", channelName });
}

// Only transitions if channelName matches the entry currently tracked for instanceId. A
// watcher belongs to exactly one launch attempt (see buildReadyChannelName in launch.ts,
// which mints a fresh channel per attempt); without this check, a watcher from an earlier
// attempt - still waiting when the session vanished and got recreated under the same
// instance id, or resolving after a DELETE already cleared the entry - could mark a LATER
// launch ready before it actually is. A mismatched or missing entry is a silent no-op: the
// resolution belongs to a launch that is no longer the one being tracked.
export function markAgentReady(instanceId: string, channelName: string): void {
  const entry = entriesByInstanceId.get(instanceId);
  if (entry === undefined || entry.channelName !== channelName) {
    return;
  }
  entriesByInstanceId.set(instanceId, { state: "ready", channelName });
  const waiters = waitersByInstanceId.get(instanceId);
  waitersByInstanceId.delete(instanceId);
  if (waiters !== undefined) {
    for (const listener of waiters) {
      listener();
    }
  }
}

// Defaults to true for any instance id this module never tracked (or has since forgotten):
// a server restart, an instance created before this feature existed, or one already resolved
// and cleared. The safe default is always "show the terminal", never "leave it hidden".
export function isAgentReady(instanceId: string): boolean {
  return entriesByInstanceId.get(instanceId)?.state !== "booting";
}

// Registers a one-shot listener for when instanceId transitions to ready. If it is already
// ready (or untracked), the listener fires synchronously before this returns. Always returns
// an unsubscribe function, safe to call more than once.
export function onAgentReady(instanceId: string, listener: () => void): () => void {
  if (isAgentReady(instanceId)) {
    listener();
    return () => {};
  }
  let waiters = waitersByInstanceId.get(instanceId);
  if (waiters === undefined) {
    waiters = new Set();
    waitersByInstanceId.set(instanceId, waiters);
  }
  waiters.add(listener);
  return () => {
    waiters?.delete(listener);
  };
}

export function getReadyChannel(instanceId: string): string | null {
  return entriesByInstanceId.get(instanceId)?.channelName ?? null;
}

export function clearAgentReadiness(instanceId: string): void {
  entriesByInstanceId.delete(instanceId);
  waitersByInstanceId.delete(instanceId);
}
