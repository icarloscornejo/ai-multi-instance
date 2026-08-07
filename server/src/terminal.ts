import * as nodePty from "@lydell/node-pty";
import type { WebSocket, RawData } from "ws";
import { buildLaunchCommand } from "./launch";
import { pathExists } from "./paths";
import { createSession, enableMouseMode, hasSession, sendCommandToSession } from "./tmux";
import type { InstanceRecord } from "./types";

interface ClientControlMessage {
  type: "input" | "resize" | "ping";
  data?: string;
  cols?: number;
  rows?: number;
}

// Answers the client's application-level liveness ping (see the heartbeat in TerminalView.tsx)
// with a single empty binary frame. Binary, not text: the client's onmessage only treats
// string frames as terminal output (see terminal.ts's counterpart), so a binary pong is
// silently invisible to the pty stream instead of needing its own message-type parsing there.
const PONG_FRAME = new Uint8Array(0);

interface InitialSize {
  cols: number;
  rows: number;
}

const FALLBACK_COLS = 120;
const FALLBACK_ROWS = 32;

// macOS caps ptys at kern.tty.ptmx_max (511 by default). Refusing new attaches with a
// readable error well below that is the difference between a clear "too many terminals"
// message and every subsequent spawn silently dying with node-pty's opaque
// "posix_spawnp failed." once the real kernel limit is hit.
const MAX_LIVE_PTYS = 480;
let livePtyCount = 0;
let loggedPtyLimitCrossing = false;

export class TooManyPtysError extends Error {}

// Distinct from TooManyPtysError so index.ts can map both to a close code that tells the
// client not to bother retrying: neither condition resolves itself without user action
// (restarting the server, or restoring/reconfiguring the folder).
export class LocationMissingError extends Error {}

// node-pty's IPty type only declares kill(), which sends SIGHUP but leaves the pty's
// master file descriptor open (see UnixTerminal.prototype.kill vs .destroy in
// unixTerminal.js). Only destroy() closes that fd before signaling the shell, so calling
// kill() here was the source of a slow pty fd leak that eventually exhausted
// kern.tty.ptmx_max. destroy() exists on the runtime UnixTerminal instance but isn't part
// of the public IPty interface, hence the cast. Idempotent and safe to call more than
// once per process (double-release from both the race guard and the close handler).
function releasePty(attachProcess: nodePty.IPty): void {
  if ((attachProcess as { _released?: boolean })._released === true) {
    return;
  }
  (attachProcess as { _released?: boolean })._released = true;
  livePtyCount -= 1;
  const destroyable = attachProcess as unknown as { destroy?: () => void };
  if (typeof destroyable.destroy === "function") {
    destroyable.destroy();
  } else {
    attachProcess.kill();
  }
}

export async function bridgeTerminal(
  socket: WebSocket,
  instance: InstanceRecord,
  initialSize: InitialSize | null,
  pendingMessages: RawData[],
  stopBuffering: () => void
): Promise<void> {
  // Locations are validated at instance-creation time (see routes.ts) but never again;
  // a folder deleted, unmounted, or renamed afterward otherwise surfaces as a raw
  // tmux/pty spawn failure instead of a message that explains what actually happened.
  if (!(await pathExists(instance.locationPath))) {
    throw new LocationMissingError(`Folder no longer exists: ${instance.locationPath}`);
  }

  // Recreate a lost tmux session and restore the provider conversation when possible.
  const sessionAlive: boolean = await hasSession(instance.tmuxSession);
  if (!sessionAlive) {
    await createSession(instance.tmuxSession, instance.locationPath);
    if (instance.shellOnly !== true) {
      await sendCommandToSession(
        instance.tmuxSession,
        buildLaunchCommand(instance, { resumeSessionId: instance.sessionId ?? undefined })
      );
    }
  } else {
    // Migrate sessions that were alive before this change (createSession already
    // enables it for new ones); set-option is idempotent, no cost in repeating it
    await enableMouseMode(instance.tmuxSession);
  }

  if (livePtyCount >= MAX_LIVE_PTYS) {
    if (!loggedPtyLimitCrossing) {
      loggedPtyLimitCrossing = true;
      console.error(`[terminal] live pty count reached ${MAX_LIVE_PTYS}, refusing new attaches`);
    }
    throw new TooManyPtysError(
      "Too many open terminals on the server; restart the dashboard server to recover."
    );
  }
  loggedPtyLimitCrossing = false;

  const attachProcess = nodePty.spawn("tmux", ["attach-session", "-t", instance.tmuxSession], {
    name: "xterm-256color",
    cols: initialSize?.cols ?? FALLBACK_COLS,
    rows: initialSize?.rows ?? FALLBACK_ROWS,
    cwd: instance.locationPath,
    env: process.env as Record<string, string>,
  });
  livePtyCount += 1;

  // Registered immediately, with no await in between: if the WS already closed while we
  // were awaiting hasSession/createSession/enableMouseMode above, this still catches it
  // and releases the pty instead of leaking it. Re-registered as a no-op-safe handler
  // below once the rest of the bridge is wired up (releasePty is idempotent).
  socket.on("close", () => releasePty(attachProcess));

  if (socket.readyState !== socket.OPEN) {
    releasePty(attachProcess);
    return;
  }

  attachProcess.onData((outputChunk: string) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(outputChunk);
    }
  });

  // If the pty dies (kill-session from outside, tmux crash), the client must be notified
  attachProcess.onExit(() => {
    if (socket.readyState === socket.OPEN) {
      socket.close(4001, "tmux session ended");
    }
  });

  const handleMessage = (rawMessage: RawData): void => {
    let controlMessage: ClientControlMessage;
    try {
      controlMessage = JSON.parse(rawMessage.toString()) as ClientControlMessage;
    } catch {
      return;
    }
    if (controlMessage.type === "input" && typeof controlMessage.data === "string") {
      attachProcess.write(controlMessage.data);
    } else if (
      controlMessage.type === "resize" &&
      typeof controlMessage.cols === "number" &&
      typeof controlMessage.rows === "number" &&
      controlMessage.cols > 0 &&
      controlMessage.rows > 0
    ) {
      attachProcess.resize(controlMessage.cols, controlMessage.rows);
    } else if (controlMessage.type === "ping" && socket.readyState === socket.OPEN) {
      socket.send(PONG_FRAME);
    }
  };

  // The client may send its first "resize" (and even type) while we are still
  // awaiting hasSession/createSession/enableMouseMode above; those messages were
  // captured in pendingMessages by the synchronous buffer set up by our caller
  // (see index.ts). stopBuffering() detaches that buffer and, with no await in
  // between, we drain the queue in order before hooking into live messages —
  // there is no window where a message can be lost.
  stopBuffering();
  for (const bufferedMessage of pendingMessages) {
    handleMessage(bufferedMessage);
  }
  socket.on("message", handleMessage);
  // Pty release on socket close is already wired up right after spawn, above, so the
  // tmux session itself stays alive with its output; nothing further to register here.
}
