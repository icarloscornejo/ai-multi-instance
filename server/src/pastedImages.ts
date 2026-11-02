import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// Only the types Claude Code turns into an image attachment when it sees the file's path
// (its own check is /\.(png|jpe?g|gif|webp)$/), so the extension decides whether a pasted
// path becomes [Image #N] or stays plain text.
export const PASTED_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Claude Code has already read the image by the time a later paste could clear it, so old
// files are dead weight.
const PASTED_IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// Best-effort: it runs inside a request that must succeed even if the cleanup cannot. Two
// pastes at once can both pick the same expired file, so a file that vanished between the
// readdir and the unlink is expected, not a failure.
// ponytail: by age only, no cap on total size. Switch to a size limit if this folder ever grows.
async function removeExpiredImages(directory: string): Promise<void> {
  const cutoffMs: number = Date.now() - PASTED_IMAGE_MAX_AGE_MS;
  try {
    for (const fileName of await fs.readdir(directory)) {
      const filePath: string = path.join(directory, fileName);
      try {
        const fileStats = await fs.stat(filePath);
        if (fileStats.mtimeMs < cutoffMs) {
          await fs.unlink(filePath);
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }
  } catch (error) {
    console.warn("[pasted-images] could not clean up old images:", error instanceof Error ? error.message : error);
  }
}

// The file name is always a fresh UUID: nothing the client sends reaches the path, so there is
// nothing to traverse. Returns the absolute path of the saved file.
export async function savePastedImage(imageBytes: Buffer, contentType: string, directory: string): Promise<string> {
  const extension: string | undefined = PASTED_IMAGE_EXTENSIONS[contentType];
  if (extension === undefined) {
    throw new Error(`Unsupported pasted image type: ${contentType}`);
  }
  await fs.mkdir(directory, { recursive: true });
  await removeExpiredImages(directory);
  const filePath: string = path.join(directory, `${randomUUID()}.${extension}`);
  await fs.writeFile(filePath, imageBytes);
  return filePath;
}
