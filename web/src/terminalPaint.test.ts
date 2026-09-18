import { describe, expect, it } from "vitest";
import { hasVisibleText, type PaintBuffer, type PaintBufferLine } from "./terminalPaint";

function line(text: string): PaintBufferLine {
  return { translateToString: () => text };
}

function buffer(baseY: number, lines: Record<number, PaintBufferLine>): PaintBuffer {
  return {
    baseY,
    getLine: (index) => lines[index],
  };
}

describe("hasVisibleText", () => {
  it("returns false for an empty viewport", () => {
    expect(hasVisibleText(buffer(0, {}), 24)).toBe(false);
  });

  it("returns false when every viewport row is blank or whitespace-only", () => {
    const buf = buffer(0, { 0: line(""), 1: line("   ") });
    expect(hasVisibleText(buf, 24)).toBe(false);
  });

  it("returns true when a viewport row has real text", () => {
    const buf = buffer(0, { 0: line(""), 5: line("  Welcome to Claude Code  ") });
    expect(hasVisibleText(buf, 24)).toBe(true);
  });

  it("ignores text sitting in scrollback, above the current viewport", () => {
    // The `clear` on boot leaves the agent's old prompt scrolled above baseY - it must never
    // count as "painted" just because it is still sitting in the buffer somewhere.
    const buf = buffer(10, { 3: line("old prompt from before clear") });
    expect(hasVisibleText(buf, 24)).toBe(false);
  });
});
