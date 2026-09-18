// Minimal shape of xterm.js's IBuffer/IBufferLine - just enough to test this without a real
// Terminal instance (the web tests run under plain node, no jsdom/xterm DOM dependencies).
export interface PaintBufferLine {
  translateToString(trimRight?: boolean): string;
}

export interface PaintBuffer {
  baseY: number;
  getLine(index: number): PaintBufferLine | undefined;
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
