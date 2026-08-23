import { describe, expect, it } from "vitest";
import { createAttachBuffer } from "./attachBuffer";

function inputMessage(data: string): Buffer {
  return Buffer.from(JSON.stringify({ type: "input", data }));
}

function resizeMessage(cols: number, rows: number): Buffer {
  return Buffer.from(JSON.stringify({ type: "resize", cols, rows }));
}

function pingMessage(): Buffer {
  return Buffer.from(JSON.stringify({ type: "ping" }));
}

const GENEROUS_LIMITS = { maxInputChars: 1_000, maxTotalBytes: 1_000_000 };

describe("createAttachBuffer", () => {
  it("drains input messages in the order they were added, with a coalesced ping appended last", () => {
    const buffer = createAttachBuffer(GENEROUS_LIMITS);
    buffer.add(inputMessage("a"));
    buffer.add(pingMessage());
    buffer.add(inputMessage("b"));
    const drained = buffer.drain().map((raw) => JSON.parse(raw.toString()));
    // Pings are coalesced to a single trailing one (see PING_RAW_MESSAGE's comment): a ping's
    // only effect once replayed is producing a pong, so its position relative to input never
    // mattered, and buffering more than one wastes budget for nothing.
    expect(drained).toEqual([{ type: "input", data: "a" }, { type: "input", data: "b" }, { type: "ping" }]);
  });

  it("coalesces resize messages to only the latest one, appended after a coalesced ping", () => {
    const buffer = createAttachBuffer(GENEROUS_LIMITS);
    buffer.add(resizeMessage(80, 24));
    buffer.add(inputMessage("a"));
    buffer.add(pingMessage());
    buffer.add(resizeMessage(120, 32));
    buffer.add(resizeMessage(100, 40));
    const drained = buffer.drain().map((raw) => JSON.parse(raw.toString()));
    expect(drained).toEqual([
      { type: "input", data: "a" },
      { type: "ping" },
      { type: "resize", cols: 100, rows: 40 },
    ]);
  });

  it("drains empty when nothing was added", () => {
    const buffer = createAttachBuffer();
    expect(buffer.drain()).toEqual([]);
  });

  it("clears its contents after draining, so a second drain is empty", () => {
    const buffer = createAttachBuffer();
    buffer.add(inputMessage("a"));
    buffer.drain();
    expect(buffer.drain()).toEqual([]);
  });

  it("discards the ENTIRE buffer on overflow, never delivering a partial suffix", () => {
    const buffer = createAttachBuffer({ ...GENEROUS_LIMITS, maxInputChars: 10 });
    expect(buffer.add(inputMessage("hello"))).toBe(true); // 5 chars, under cap
    expect(buffer.add(inputMessage("world!"))).toBe(false); // 11 total, over cap: overflow
    // The whole buffer, including the first accepted message, must be gone - never just the
    // overflowing tail, since that would execute an arbitrary suffix of typed input.
    expect(buffer.drain()).toEqual([]);
  });

  it("once overflowed, further adds are no-ops that keep returning false", () => {
    const buffer = createAttachBuffer({ ...GENEROUS_LIMITS, maxInputChars: 5 });
    buffer.add(inputMessage("123456")); // overflow immediately
    expect(buffer.add(inputMessage("more"))).toBe(false);
    expect(buffer.add(resizeMessage(80, 24))).toBe(false);
    expect(buffer.drain()).toEqual([]);
  });

  it("does not count resize or ping messages toward the input char cap", () => {
    const buffer = createAttachBuffer({ ...GENEROUS_LIMITS, maxInputChars: 5 });
    for (let i = 0; i < 20; i += 1) {
      expect(buffer.add(resizeMessage(80 + i, 24))).toBe(true);
      expect(buffer.add(pingMessage())).toBe(true);
    }
    const drained = buffer.drain();
    // Both resize and ping are coalesced: 20 of each still drains to exactly one of each.
    expect(drained.length).toBe(2);
  });

  it("discards unparseable/unrecognized messages entirely, without storing or overflowing", () => {
    const buffer = createAttachBuffer({ ...GENEROUS_LIMITS, maxInputChars: 5 });
    expect(buffer.add(Buffer.from("not json"))).toBe(true);
    expect(buffer.add(Buffer.from(JSON.stringify({ type: "unknown-type" })))).toBe(true);
    // Neither message has any effect once replayed into handleMessage (terminal.ts already
    // silently ignores both there too), so they are dropped rather than buffered at all.
    expect(buffer.drain()).toEqual([]);
  });

  it("overflows once the total buffered bytes exceed maxTotalBytes, even for non-input messages", () => {
    const buffer = createAttachBuffer({ maxInputChars: 1_000_000, maxTotalBytes: 50 });
    // Each resize message alone is well under 50 bytes, but repeatedly flooding them (a
    // stalled attach with a client sending many small control messages) must still be
    // bounded - this is exactly the gap that existed when only "input" counted toward any
    // cap at all.
    let overflowedAt = -1;
    for (let i = 0; i < 20; i += 1) {
      if (!buffer.add(resizeMessage(80 + i, 24))) {
        overflowedAt = i;
        break;
      }
    }
    expect(overflowedAt).toBeGreaterThan(-1);
    expect(buffer.drain()).toEqual([]);
  });

  it("counts a discarded unrecognized message's bytes toward maxTotalBytes too", () => {
    const buffer = createAttachBuffer({ maxInputChars: 1_000_000, maxTotalBytes: 10 });
    const oversizedUnknown = Buffer.from(JSON.stringify({ type: "unknown-type", padding: "x".repeat(100) }));
    expect(buffer.add(oversizedUnknown)).toBe(false);
  });
});
