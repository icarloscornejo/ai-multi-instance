import type { RawData } from "ws";

// Deliberately dependency-free, same reasoning as attachErrors.ts: the buffering logic used
// to live inline inside index.ts's WebSocket upgrade callback, but importing index.ts starts
// the real HTTP server and WS heartbeat interval at module load time, so nothing there can
// be unit-tested without opening a real port. This is the single most safety-sensitive piece
// of the attach-retry fix (it decides whether typed terminal input gets executed, executed
// partially, or discarded), so it gets its own side-effect-free module and its own tests.

export interface AttachBufferLimits {
  // Total combined length (UTF-16 code units - close enough to bytes for this cap's actual
  // purpose, which is bounding memory during a stalled/slow attach, not modeling exact wire
  // size) of "input" message payloads accepted before the buffer refuses more.
  maxInputChars: number;
  // Caps every OTHER way a stalled attach could still accumulate unbounded memory before this
  // was added: only "input" counted toward any limit, so a client (buggy or malicious) could
  // flood "ping"/malformed/unrecognized messages for as long as tmux initialization takes
  // (which can run several seconds, see DEFAULT_TMUX_TIMEOUT_MS in tmux.ts) and grow
  // `orderedMessages` without bound. Total raw bytes across every buffered/received message,
  // counted whether or not the message ends up stored (receiving and parsing the frame
  // already cost something even if its content is then discarded).
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: AttachBufferLimits = {
  maxInputChars: 64 * 1024,
  maxTotalBytes: 256 * 1024,
};

// A raw "ping" control message, synthesized once and reused for every drain() where a ping
// was buffered. Pings are coalesced (see add() below) exactly like "resize" already was:
// their only purpose once replayed into handleMessage (terminal.ts) is to produce a pong that
// tells the client the bridge is alive, and that purpose is served just as well by one ping
// as by a thousand - buffering each one individually would defeat half of maxTotalBytes' point.
const PING_RAW_MESSAGE: RawData = Buffer.from(JSON.stringify({ type: "ping" }));

// RawData from `ws` can arrive as a string, a Buffer, an ArrayBuffer, or (with certain socket
// options) an array of Buffers for a fragmented frame. Buffer.byteLength handles the string
// case directly; the others already expose a byteLength/length that means the same thing.
function rawDataByteLength(raw: RawData): number {
  if (typeof raw === "string") {
    return Buffer.byteLength(raw, "utf8");
  }
  if (Array.isArray(raw)) {
    return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return raw.byteLength;
}

type ParsedControlMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" }
  | { type: "unknown" };

// Mirrors the parsing terminal.ts's handleMessage does once the bridge is live; duplicated
// here (rather than shared) because this only needs to classify a message well enough to
// decide buffering policy, not act on it - the real handling still happens in handleMessage
// once these are drained.
function parseControlMessage(raw: RawData): ParsedControlMessage {
  try {
    const parsed = JSON.parse(raw.toString()) as {
      type?: unknown;
      data?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return { type: "input", data: parsed.data };
    }
    if (
      parsed.type === "resize" &&
      typeof parsed.cols === "number" &&
      typeof parsed.rows === "number" &&
      parsed.cols > 0 &&
      parsed.rows > 0
    ) {
      return { type: "resize", cols: parsed.cols, rows: parsed.rows };
    }
    if (parsed.type === "ping") {
      return { type: "ping" };
    }
  } catch {
    // Same as handleMessage's catch-all: an unparseable message is silently ignored rather
    // than crashing the attach.
  }
  return { type: "unknown" };
}

export interface AttachBuffer {
  // Buffers one raw message. Returns false once the buffer has overflowed (this call or a
  // previous one); the caller must stop adding, drop the buffer, and close the socket with
  // 4007 (see index.ts and web/src/reconnectPolicy.ts) - never drain a buffer that returned
  // false, its contents were already cleared. Safe to keep calling after overflow: it stays
  // false and is a no-op.
  add(raw: RawData): boolean;
  // Drains everything buffered so far, in original arrival order, with a coalesced "ping" (if
  // any arrived) and then the latest "resize" (if any) appended last. Resizing the pty is
  // idempotent regardless of relative order (only the final size matters) and a ping's only
  // purpose is producing a pong once replayed, so replaying both after in-order input messages
  // is safe and avoids tracking their original position. Clears the buffer.
  drain(): RawData[];
}

export function createAttachBuffer(limits: AttachBufferLimits = DEFAULT_LIMITS): AttachBuffer {
  let overflowed = false;
  let inputCharsBuffered = 0;
  let totalBytesBuffered = 0;
  const orderedMessages: RawData[] = [];
  let latestResizeRaw: RawData | null = null;
  let pingPending = false;

  function overflow(): false {
    overflowed = true;
    orderedMessages.length = 0;
    latestResizeRaw = null;
    pingPending = false;
    return false;
  }

  return {
    add(raw: RawData): boolean {
      if (overflowed) {
        return false;
      }

      // Counted regardless of message type or whether it ends up stored below: receiving and
      // parsing a frame already costs memory even if its content is then discarded (a ping or
      // an unrecognized message), which is exactly the gap maxTotalBytes exists to close.
      totalBytesBuffered += rawDataByteLength(raw);
      if (totalBytesBuffered > limits.maxTotalBytes) {
        return overflow();
      }

      const parsed = parseControlMessage(raw);

      if (parsed.type === "resize") {
        // Only the latest survives; earlier ones are simply discarded (not counted toward
        // the cap, and never delivered) since only the final size before the pty exists
        // matters at all.
        latestResizeRaw = raw;
        return true;
      }

      if (parsed.type === "ping") {
        // Coalesced the same way "resize" already was: one buffered ping produces exactly
        // the same pong-triggering effect as a thousand, so there is no reason to store more
        // than a flag - see PING_RAW_MESSAGE's comment.
        pingPending = true;
        return true;
      }

      if (parsed.type === "unknown") {
        // Not stored at all: an unparseable or unrecognized message has no effect once
        // replayed into handleMessage (terminal.ts already silently ignores it there too),
        // so keeping it around only spends buffer budget for nothing.
        return true;
      }

      // parsed.type === "input" from here on.
      inputCharsBuffered += parsed.data.length;
      if (inputCharsBuffered > limits.maxInputChars) {
        // All-or-nothing by design: a cap that evicted only the oldest entries would let
        // an arbitrary SUFFIX of what the user typed still execute, which in a terminal
        // can change a command's meaning destructively (e.g. "rm -rf ./build" surviving
        // while its leading directory changed). Discarding everything and asking the
        // client to reconnect (close code 4007) is the only option that can never
        // execute a partial command.
        return overflow();
      }

      orderedMessages.push(raw);
      return true;
    },

    drain(): RawData[] {
      const drained: RawData[] = [...orderedMessages];
      if (pingPending) {
        drained.push(PING_RAW_MESSAGE);
      }
      if (latestResizeRaw !== null) {
        drained.push(latestResizeRaw);
      }
      orderedMessages.length = 0;
      latestResizeRaw = null;
      pingPending = false;
      totalBytesBuffered = 0;
      return drained;
    },
  };
}
