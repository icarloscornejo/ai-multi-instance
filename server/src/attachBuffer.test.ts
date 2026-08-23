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

describe("createAttachBuffer", () => {
  it("drains messages in the order they were added when under the cap", () => {
    const buffer = createAttachBuffer({ maxInputChars: 1_000 });
    buffer.add(inputMessage("a"));
    buffer.add(pingMessage());
    buffer.add(inputMessage("b"));
    const drained = buffer.drain().map((raw) => JSON.parse(raw.toString()));
    expect(drained).toEqual([{ type: "input", data: "a" }, { type: "ping" }, { type: "input", data: "b" }]);
  });

  it("coalesces resize messages to only the latest one, appended last", () => {
    const buffer = createAttachBuffer({ maxInputChars: 1_000 });
    buffer.add(resizeMessage(80, 24));
    buffer.add(inputMessage("a"));
    buffer.add(resizeMessage(120, 32));
    buffer.add(resizeMessage(100, 40));
    const drained = buffer.drain().map((raw) => JSON.parse(raw.toString()));
    expect(drained).toEqual([{ type: "input", data: "a" }, { type: "resize", cols: 100, rows: 40 }]);
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
    const buffer = createAttachBuffer({ maxInputChars: 10 });
    expect(buffer.add(inputMessage("hello"))).toBe(true); // 5 chars, under cap
    expect(buffer.add(inputMessage("world!"))).toBe(false); // 11 total, over cap: overflow
    // The whole buffer, including the first accepted message, must be gone - never just the
    // overflowing tail, since that would execute an arbitrary suffix of typed input.
    expect(buffer.drain()).toEqual([]);
  });

  it("once overflowed, further adds are no-ops that keep returning false", () => {
    const buffer = createAttachBuffer({ maxInputChars: 5 });
    buffer.add(inputMessage("123456")); // overflow immediately
    expect(buffer.add(inputMessage("more"))).toBe(false);
    expect(buffer.add(resizeMessage(80, 24))).toBe(false);
    expect(buffer.drain()).toEqual([]);
  });

  it("does not count resize or ping messages toward the input cap", () => {
    const buffer = createAttachBuffer({ maxInputChars: 5 });
    for (let i = 0; i < 20; i += 1) {
      expect(buffer.add(resizeMessage(80 + i, 24))).toBe(true);
      expect(buffer.add(pingMessage())).toBe(true);
    }
    const drained = buffer.drain();
    // 20 pings + 1 coalesced resize
    expect(drained.length).toBe(21);
  });

  it("silently ignores unparseable messages without counting them toward the cap or overflowing", () => {
    const buffer = createAttachBuffer({ maxInputChars: 5 });
    expect(buffer.add(Buffer.from("not json"))).toBe(true);
    expect(buffer.add(Buffer.from(JSON.stringify({ type: "unknown-type" })))).toBe(true);
    const drained = buffer.drain();
    expect(drained.length).toBe(2);
  });
});
