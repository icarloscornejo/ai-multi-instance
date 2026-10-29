// Minimal shape of xterm.js's IBuffer/IBufferLine - just enough to test this without a real
// Terminal instance (the web tests run under plain node, no jsdom/xterm DOM dependencies).
export interface PaintBufferLine {
  translateToString(trimRight?: boolean): string;
}

export interface PaintBuffer {
  baseY: number;
  getLine(index: number): PaintBufferLine | undefined;
}

// Opening the app at /dom draws every terminal with xterm's DOM renderer instead of WebGL. It is
// a diagnostic switch: when a device's GPU cannot draw the WebGL canvas (the terminal area fails
// while the rest of the page works), this is the quickest way to tell. The trailing slash is
// tolerated because the server answers /dom/ too.
export function isDomRendererPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === "/dom";
}

// WebGL is held only by the terminal the user is looking at: every instance stays mounted, and
// one GL context per mounted terminal exceeds what mobile Chrome allows per page (about 8), so
// it evicts the oldest ones and their canvas dies. A hidden page cannot hold a context either:
// phones reclaim it on backgrounding, so creating one then only produces another loss.
export function shouldHoldWebgl(state: {
  visible: boolean;
  pageVisible: boolean;
  domRendererPath: boolean;
  givenUp: boolean;
}): boolean {
  return state.visible && state.pageVisible && !state.domRendererPath && !state.givenUp;
}

// Backgrounding the app makes the phone reclaim the GL context, which is normal and must never
// count toward giving up WebGL. Compares against when the page was last hidden rather than a
// time margin, because Android usually dispatches the loss after the page is back in view and
// the addon reports it 3 s later.
export function isBackgroundLoss(state: {
  pageVisible: boolean;
  lastPageHiddenAtMs: number | null;
  attachedAtMs: number;
}): boolean {
  if (!state.pageVisible) {
    return true;
  }
  return state.lastPageHiddenAtMs !== null && state.lastPageHiddenAtMs >= state.attachedAtMs;
}

export const WEBGL_LOSS_LIMIT = 3;
export const WEBGL_LOSS_WINDOW_MS = 60_000;

// Only repeated real losses in a short window mean the GPU cannot keep a context; a few spread
// over a long session do not. Returns the pruned list to keep for the next call.
export function recordWebglLoss(
  lossTimes: readonly number[],
  nowMs: number
): { lossTimes: number[]; givenUp: boolean } {
  const recent = lossTimes.filter((lossMs) => nowMs - lossMs < WEBGL_LOSS_WINDOW_MS);
  recent.push(nowMs);
  return { lossTimes: recent, givenUp: recent.length >= WEBGL_LOSS_LIMIT };
}

// Minimal shape of a canvas and of the context-loss extension, for the same no-DOM testing reason.
export interface ReleasableCanvas {
  getContext(contextId: "webgl2"): { getExtension(name: "WEBGL_lose_context"): { loseContext(): void } | null } | null;
}

// Chromium does not free a WebGL context when the xterm addon is disposed (xterm.js #6068), so
// each dispose-and-recreate keeps consuming the page's limited contexts and evicts other
// terminals. Losing the context explicitly is what releases it. A canvas with no WebGL2 context
// (the addon's 2D link layer) is skipped, and one failing never stops the rest.
export function releaseWebglContexts(canvases: readonly ReleasableCanvas[]): void {
  for (const canvas of canvases) {
    try {
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // A canvas whose context is already gone or unusable has nothing left to release.
    }
  }
}

// Only the current viewport (baseY..baseY+rows-1), never the scrollback: a `clear` leaves the
// agent's old prompt sitting above the viewport, and that old text must not count as "painted".
export function hasVisibleText(buffer: PaintBuffer, rows: number): boolean {
  for (let row = 0; row < rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    if (line !== undefined && line.translateToString(true).trim() !== "") {
      return true;
    }
  }
  return false;
}
