import { describe, expect, it, vi } from "vitest";
import {
  hasVisibleText,
  isBackgroundLoss,
  isDomRendererPath,
  recordWebglLoss,
  releaseWebglContexts,
  shouldHoldWebgl,
  WEBGL_LOSS_LIMIT,
  WEBGL_LOSS_WINDOW_MS,
  type PaintBuffer,
  type PaintBufferLine,
  type ReleasableCanvas,
} from "./terminalPaint";

describe("shouldHoldWebgl", () => {
  const normal = { visible: true, pageVisible: true, domRendererPath: false, givenUp: false };

  it("holds WebGL only for a visible instance on a visible page in the normal app", () => {
    expect(shouldHoldWebgl(normal)).toBe(true);
  });

  it("does not hold it for a hidden instance, a hidden page, /dom or after giving up", () => {
    expect(shouldHoldWebgl({ ...normal, visible: false })).toBe(false);
    expect(shouldHoldWebgl({ ...normal, pageVisible: false })).toBe(false);
    expect(shouldHoldWebgl({ ...normal, domRendererPath: true })).toBe(false);
    expect(shouldHoldWebgl({ ...normal, givenUp: true })).toBe(false);
  });
});

describe("isBackgroundLoss", () => {
  it("is a background loss while the page is hidden", () => {
    expect(isBackgroundLoss({ pageVisible: false, lastPageHiddenAtMs: null, attachedAtMs: 1000 })).toBe(true);
  });

  it("is a background loss when the page was hidden after the addon attached", () => {
    expect(isBackgroundLoss({ pageVisible: true, lastPageHiddenAtMs: 2000, attachedAtMs: 1000 })).toBe(true);
  });

  it("is a real loss when the page was only hidden before the addon attached, or never", () => {
    expect(isBackgroundLoss({ pageVisible: true, lastPageHiddenAtMs: 500, attachedAtMs: 1000 })).toBe(false);
    expect(isBackgroundLoss({ pageVisible: true, lastPageHiddenAtMs: null, attachedAtMs: 1000 })).toBe(false);
  });
});

describe("recordWebglLoss", () => {
  it("never gives up on losses spread further apart than the window", () => {
    let lossTimes: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const result = recordWebglLoss(lossTimes, index * (WEBGL_LOSS_WINDOW_MS + 1));
      expect(result.givenUp).toBe(false);
      lossTimes = result.lossTimes;
    }
    expect(lossTimes).toHaveLength(1);
  });

  it("gives up once the limit is reached inside the window", () => {
    let lossTimes: number[] = [];
    let givenUp = false;
    for (let index = 0; index < WEBGL_LOSS_LIMIT; index += 1) {
      ({ lossTimes, givenUp } = recordWebglLoss(lossTimes, 1000 + index * 5000));
      expect(givenUp).toBe(index === WEBGL_LOSS_LIMIT - 1);
    }
  });

  it("drops times that fell out of the window and keeps the recent ones", () => {
    const result = recordWebglLoss([0, 100_000], 100_500);
    expect(result.lossTimes).toEqual([100_000, 100_500]);
    expect(result.givenUp).toBe(false);
  });
});

function fakeCanvas(options: { hasContext?: boolean; hasExtension?: boolean; throws?: boolean } = {}) {
  const { hasContext = true, hasExtension = true, throws = false } = options;
  const loseContext = vi.fn();
  const getContext = vi.fn((_contextId: "webgl2") => {
    if (throws) {
      throw new Error("context unusable");
    }
    if (!hasContext) {
      return null;
    }
    return { getExtension: () => (hasExtension ? { loseContext } : null) };
  });
  return { canvas: { getContext } as ReleasableCanvas, getContext, loseContext };
}

describe("releaseWebglContexts", () => {
  it("asks for a webgl2 context and loses it on every canvas", () => {
    const first = fakeCanvas();
    const second = fakeCanvas();
    releaseWebglContexts([first.canvas, second.canvas]);
    expect(first.getContext).toHaveBeenCalledWith("webgl2");
    expect(first.loseContext).toHaveBeenCalledTimes(1);
    expect(second.loseContext).toHaveBeenCalledTimes(1);
  });

  it("skips a canvas with no webgl2 context, like the addon's 2D link layer", () => {
    const linkLayer = fakeCanvas({ hasContext: false });
    const webgl = fakeCanvas();
    releaseWebglContexts([linkLayer.canvas, webgl.canvas]);
    expect(linkLayer.loseContext).not.toHaveBeenCalled();
    expect(webgl.loseContext).toHaveBeenCalledTimes(1);
  });

  it("keeps going when one canvas lacks the extension or throws", () => {
    const noExtension = fakeCanvas({ hasExtension: false });
    const broken = fakeCanvas({ throws: true });
    const webgl = fakeCanvas();
    releaseWebglContexts([noExtension.canvas, broken.canvas, webgl.canvas]);
    expect(webgl.loseContext).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty list", () => {
    expect(() => releaseWebglContexts([])).not.toThrow();
  });
});

describe("isDomRendererPath", () => {
  it("is true for /dom, with or without a trailing slash", () => {
    expect(isDomRendererPath("/dom")).toBe(true);
    expect(isDomRendererPath("/dom/")).toBe(true);
  });

  it("is false for the normal app and for look-alike paths", () => {
    expect(isDomRendererPath("/")).toBe(false);
    expect(isDomRendererPath("")).toBe(false);
    expect(isDomRendererPath("/domain")).toBe(false);
    expect(isDomRendererPath("/dom/x")).toBe(false);
  });
});

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
