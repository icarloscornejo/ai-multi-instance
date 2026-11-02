// Same types the server accepts (server/src/pastedImages.ts) and Claude Code reads as images.
const PASTABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Decides whether a paste is an image to upload or ordinary text for xterm.
//
// Copying cells or text in Numbers, Excel, Keynote or Word puts the text AND a picture of the
// selection on the clipboard, and the browser exposes both. That has to paste as text, so an
// image only wins when there is no text at all. Screenshots and "Copy image" carry none.
export function pickPastedImage(files: File[], plainText: string): File | null {
  if (plainText.trim() !== "") {
    return null;
  }
  return files.find((file: File) => PASTABLE_IMAGE_TYPES.has(file.type)) ?? null;
}
