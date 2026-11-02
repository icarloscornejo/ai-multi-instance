// OSC 52 is how a program (here Claude Code, through `tmux load-buffer -w`) asks the outer
// terminal to put text on the system clipboard. The payload xterm hands to the parser is
// `<selection>;<base64>`, e.g. `c;aG9sYQ==`. The selection field (c, p, s, ...) is ignored: a
// browser has a single clipboard.
//
// Returns the text to copy, or null when there is nothing safe to copy:
// - `?` is a query asking the terminal to REPORT the clipboard; it is never answered, so a
//   program inside the pane can never read what the user has copied.
// - an empty payload means "clear the clipboard"; ignored so a stray sequence cannot wipe it.
// - invalid base64 or invalid UTF-8 is dropped instead of copying garbage.
export function decodeOsc52Payload(payload: string): string | null {
  const separatorIndex: number = payload.indexOf(";");
  if (separatorIndex === -1) {
    return null;
  }
  const base64Text: string = payload.slice(separatorIndex + 1);
  if (base64Text === "" || base64Text === "?") {
    return null;
  }
  try {
    const binaryText: string = atob(base64Text);
    const bytes: Uint8Array = Uint8Array.from(binaryText, (character: string) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // atob throws InvalidCharacterError on bad base64, TextDecoder throws TypeError on bad UTF-8
    return null;
  }
}
