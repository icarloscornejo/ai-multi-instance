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
}

const DEFAULT_LIMITS: AttachBufferLimits = { maxInputChars: 64 * 1024 };

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
  // Drains everything buffered so far, in original arrival order, with the latest "resize"
  // (if any) appended last. Resizing the pty is idempotent regardless of relative order (only
  // the final size matters), so replaying the coalesced resize after in-order input/ping
  // messages is safe and avoids tracking its original position. Clears the buffer.
  drain(): RawData[];
}

export function createAttachBuffer(limits: AttachBufferLimits = DEFAULT_LIMITS): AttachBuffer {
  let overflowed = false;
  let inputCharsBuffered = 0;
  const orderedMessages: RawData[] = [];
  let latestResizeRaw: RawData | null = null;

  return {
    add(raw: RawData): boolean {
      if (overflowed) {
        return false;
      }
      const parsed = parseControlMessage(raw);

      if (parsed.type === "resize") {
        // Only the latest survives; earlier ones are simply discarded (not counted toward
        // the cap, and never delivered) since only the final size before the pty exists
        // matters at all.
        latestResizeRaw = raw;
        return true;
      }

      if (parsed.type === "input") {
        inputCharsBuffered += parsed.data.length;
        if (inputCharsBuffered > limits.maxInputChars) {
          // All-or-nothing by design: a cap that evicted only the oldest entries would let
          // an arbitrary SUFFIX of what the user typed still execute, which in a terminal
          // can change a command's meaning destructively (e.g. "rm -rf ./build" surviving
          // while its leading directory changed). Discarding everything and asking the
          // client to reconnect (close code 4007) is the only option that can never
          // execute a partial command.
          overflowed = true;
          orderedMessages.length = 0;
          latestResizeRaw = null;
          return false;
        }
      }

      // ping and unrecognized/unparseable messages are cheap and harmless to keep in
      // order; only "input" counts toward the cap.
      orderedMessages.push(raw);
      return true;
    },

    drain(): RawData[] {
      const drained: RawData[] = latestResizeRaw !== null ? [...orderedMessages, latestResizeRaw] : [...orderedMessages];
      orderedMessages.length = 0;
      latestResizeRaw = null;
      return drained;
    },
  };
}
