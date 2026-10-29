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
