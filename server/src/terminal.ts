import * as nodePty from "@lydell/node-pty";
import type { WebSocket, RawData } from "ws";
import { createSession, enableMouseMode, hasSession } from "./tmux";
import type { InstanceRecord } from "./types";

interface ClientControlMessage {
  type: "input" | "resize";
  data?: string;
  cols?: number;
  rows?: number;
}

interface InitialSize {
  cols: number;
  rows: number;
}

const FALLBACK_COLS = 120;
const FALLBACK_ROWS = 32;

export async function bridgeTerminal(
  socket: WebSocket,
  instance: InstanceRecord,
  initialSize: InitialSize | null,
  pendingMessages: RawData[],
  stopBuffering: () => void
): Promise<void> {
  // The session may have died (machine reboot): recreating it leaves a fresh shell
  // sitting in the folder, ready to relaunch claude
  const sessionAlive: boolean = await hasSession(instance.tmuxSession);
  if (!sessionAlive) {
    await createSession(instance.tmuxSession, instance.locationPath);
  } else {
    // Migrate sessions that were alive before this change (createSession already
    // enables it for new ones); set-option is idempotent, no cost in repeating it
    await enableMouseMode(instance.tmuxSession);
  }

  const attachProcess = nodePty.spawn("tmux", ["attach-session", "-t", instance.tmuxSession], {
    name: "xterm-256color",
    cols: initialSize?.cols ?? FALLBACK_COLS,
    rows: initialSize?.rows ?? FALLBACK_ROWS,
    cwd: instance.locationPath,
    env: process.env as Record<string, string>,
  });

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

  // Closing the WS only kills the attach client: the tmux session stays alive with its output
  socket.on("close", () => {
    attachProcess.kill();
  });
}
