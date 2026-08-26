// Publishes a Vite build (produced by updateTransaction.ts) into web/dist without ever letting
// Express (server/src/index.ts, express.static(webDistPath)) observe a missing, truncated, or
// half-written file. Two properties make that possible:
//
// 1. Every file is written via a unique temp path in its own destination directory, then
//    fs.renameSync onto the final name. A single-file rename within the same filesystem is
//    atomic: there is no instant where the destination is missing or partially written. This
//    matters even for content-hashed assets (whose name never collides across different builds),
//    because a REPEAT of the same publish - the exact case the reconciliation in updateTransaction
//    triggers after a crash - would otherwise overwrite a live file with itself while a request
//    might be mid-read.
// 2. index.html is written last, and the manifest last of all. By the time the manifest says a
//    commit is published, every asset it references already exists on disk.
//
// This module never runs `vite build` itself - that's updateTransaction.ts's job, holding the
// cross-process lock for the whole transaction. This module only takes a directory that already
// contains a finished build (the staging dir) and moves it into web/dist safely.

import fs from "node:fs";
import path from "node:path";

export const MANIFEST_FILENAME = ".build-manifest.json";

export interface BuildManifest {
  commit: string;
}

export interface PublishOptions {
  stagingDir: string;
  distDir: string;
  commit: string;
}

// A short, unlikely-to-collide suffix is enough: two publishers racing for the exact same
// destination file are already excluded by updateTransaction's cross-process lock, so this only
// has to avoid colliding with itself across the handful of files in one publish.
function tempPathFor(destPath: string): string {
  return `${destPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Writes `data` to `destPath` such that any reader (including a concurrent Express request)
// either sees the old content or the new content in full, never a partial write. `mkdir` is
// `recursive: true` so nested asset directories (there are none in this repo's build today, but
// nothing guarantees that stays true) are created on demand.
function publishFileAtomically(destPath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tempPath: string = tempPathFor(destPath);
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, destPath);
}

// Lists every regular file under `dir`, relative to `dir`, recursively. Vite's own output is flat
// today (web/dist/assets/*, plus root-level files copied from web/public/), but this walks
// subdirectories anyway rather than assuming that stays true.
function listFilesRecursively(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath: string = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(fullPath).map((relative) => path.join(entry.name, relative)));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files;
}

// Publishes every file in `stagingDir` into `distDir`, index.html last, the manifest after that.
// Safe to call twice in a row with the same staging content (the reconciliation-after-crash case):
// every write is a fresh temp file plus rename, so re-publishing the same commit never truncates
// a file a concurrent request might be reading.
export function publishStagingToDist(options: PublishOptions): void {
  const { stagingDir, distDir, commit } = options;
  const relativeFiles: string[] = listFilesRecursively(stagingDir).filter(
    (relativePath) => relativePath !== "index.html"
  );

  for (const relativePath of relativeFiles) {
    const data: Buffer = fs.readFileSync(path.join(stagingDir, relativePath));
    publishFileAtomically(path.join(distDir, relativePath), data);
  }

  // index.html only ever references files that, by this point, already exist under distDir.
  const indexHtmlPath: string = path.join(stagingDir, "index.html");
  publishFileAtomically(path.join(distDir, "index.html"), fs.readFileSync(indexHtmlPath));

  // Last of all: once this exists, index.html and everything it references are already safe to
  // serve. A crash before this point leaves the manifest saying the OLD commit, which is exactly
  // what makes the reconciliation in updateTransaction.ts retry instead of assuming success.
  const manifest: BuildManifest = { commit };
  publishFileAtomically(
    path.join(distDir, MANIFEST_FILENAME),
    Buffer.from(JSON.stringify(manifest), "utf8")
  );
}

// Fail-open by design, same reasoning as ptyCapacity.ts's header comment: a manifest that is
// missing, unreadable, or not valid JSON is treated as "nothing published yet", never as a reason
// to crash the server or throw out of a request path. The caller (updateTransaction.ts's
// reconciliation) reacts to null by publishing again, which is always safe (see the header
// comment on publishStagingToDist).
export function readManifest(distDir: string): BuildManifest | null {
  try {
    const raw: string = fs.readFileSync(path.join(distDir, MANIFEST_FILENAME), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const commit: unknown = (parsed as { commit?: unknown }).commit;
    return typeof commit === "string" && commit.length > 0 ? { commit } : null;
  } catch {
    return null;
  }
}

// Cheap, real-world check that the manifest isn't lying: if it claims a commit but index.html
// itself is missing (e.g. the process died between publishing assets and index.html, an
// impossible ordering per this module but not per a hand-edited or corrupted web/dist), treat it
// as unpublished rather than trusting the manifest blindly.
export function isCommitPublished(distDir: string, commit: string): boolean {
  const manifest: BuildManifest | null = readManifest(distDir);
  if (manifest === null || manifest.commit !== commit) {
    return false;
  }
  return fs.existsSync(path.join(distDir, "index.html"));
}
