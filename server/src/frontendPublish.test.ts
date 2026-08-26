import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCommitPublished, MANIFEST_FILENAME, publishStagingToDist, readManifest } from "./frontendPublish";

let workDir: string;
let stagingDir: string;
let distDir: string;

// Real temp directories, not a mocked fs: the property under test is that a rename-based publish
// never leaves a reader observing a partial file, which is exactly the kind of thing a fake
// filesystem can accidentally make look correct.
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-publish-test-"));
  stagingDir = path.join(workDir, "staging");
  distDir = path.join(workDir, "dist");
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeStagingFile(relativePath: string, content: string): void {
  const fullPath: string = path.join(stagingDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe("publishStagingToDist", () => {
  it("publishes assets, index.html, and the manifest, in that order and all readable afterward", () => {
    writeStagingFile("assets/index-abc123.js", "console.log('hi')");
    writeStagingFile("favicon.svg", "<svg></svg>");
    writeStagingFile("index.html", '<script src="/assets/index-abc123.js"></script>');

    publishStagingToDist({ stagingDir, distDir, commit: "commit-a" });

    expect(fs.readFileSync(path.join(distDir, "assets/index-abc123.js"), "utf8")).toBe("console.log('hi')");
    expect(fs.readFileSync(path.join(distDir, "favicon.svg"), "utf8")).toBe("<svg></svg>");
    expect(fs.readFileSync(path.join(distDir, "index.html"), "utf8")).toContain("index-abc123.js");
    expect(readManifest(distDir)).toEqual({ commit: "commit-a" });
    expect(isCommitPublished(distDir, "commit-a")).toBe(true);
  });

  it("is additive: publishing a new build never deletes an old asset with a different hashed name", () => {
    writeStagingFile("assets/index-old111.js", "old");
    writeStagingFile("index.html", '<script src="/assets/index-old111.js"></script>');
    publishStagingToDist({ stagingDir, distDir, commit: "commit-a" });

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    writeStagingFile("assets/index-new222.js", "new");
    writeStagingFile("index.html", '<script src="/assets/index-new222.js"></script>');
    publishStagingToDist({ stagingDir, distDir, commit: "commit-b" });

    // The old hashed asset is still there: a client with the old index.html cached (or a request
    // in flight when the switch happened) can still fetch it.
    expect(fs.readFileSync(path.join(distDir, "assets/index-old111.js"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(distDir, "assets/index-new222.js"), "utf8")).toBe("new");
    expect(readManifest(distDir)).toEqual({ commit: "commit-b" });
  });

  it("repeating the exact same publish (the crash-recovery case) never leaves a truncated file", () => {
    writeStagingFile("assets/index-abc123.js", "x".repeat(50_000));
    writeStagingFile("index.html", '<script src="/assets/index-abc123.js"></script>');

    publishStagingToDist({ stagingDir, distDir, commit: "commit-a" });
    const assetPath: string = path.join(distDir, "assets/index-abc123.js");
    const firstSize: number = fs.statSync(assetPath).size;

    // Simulates the reconciliation in updateTransaction.ts retrying a publish whose manifest
    // write never landed (process died right after index.html but before the manifest).
    publishStagingToDist({ stagingDir, distDir, commit: "commit-a" });
    const secondSize: number = fs.statSync(assetPath).size;

    expect(secondSize).toBe(firstSize);
    expect(fs.readFileSync(assetPath, "utf8")).toBe("x".repeat(50_000));
  });

  it("never leaves a *.tmp-* file behind under distDir after a successful publish", () => {
    writeStagingFile("assets/index-abc123.js", "content");
    writeStagingFile("index.html", "<html></html>");
    publishStagingToDist({ stagingDir, distDir, commit: "commit-a" });

    const leftoverTemps: string[] = fs
      .readdirSync(path.join(distDir, "assets"))
      .filter((name) => name.includes(".tmp-"));
    expect(leftoverTemps).toEqual([]);
  });
});

describe("readManifest", () => {
  it("returns null when the manifest file does not exist", () => {
    expect(readManifest(distDir)).toBeNull();
  });

  it("returns null on invalid JSON rather than throwing", () => {
    fs.writeFileSync(path.join(distDir, MANIFEST_FILENAME), "{not valid json");
    expect(readManifest(distDir)).toBeNull();
  });

  it("returns null when the commit field is missing or not a string", () => {
    fs.writeFileSync(path.join(distDir, MANIFEST_FILENAME), JSON.stringify({ commit: 123 }));
    expect(readManifest(distDir)).toBeNull();
  });
});

describe("isCommitPublished", () => {
  it("is false when the manifest commit does not match", () => {
    writeStagingFile("index.html", "<html></html>");
    publishStagingToDist({ stagingDir, distDir, commit: "commit-a" });
    expect(isCommitPublished(distDir, "commit-b")).toBe(false);
  });

  it("is false when the manifest matches but index.html is missing (manifest lying about reality)", () => {
    fs.writeFileSync(path.join(distDir, MANIFEST_FILENAME), JSON.stringify({ commit: "commit-a" }));
    expect(isCommitPublished(distDir, "commit-a")).toBe(false);
  });
});
