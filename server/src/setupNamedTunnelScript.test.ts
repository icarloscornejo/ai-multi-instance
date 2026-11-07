import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptsSourceDirectory: string = fileURLToPath(new URL("../../scripts/", import.meta.url));
const TUNNEL_ID = "11111111-2222-3333-4444-555555555555";
const TUNNEL_NAME = "app";

let rootDirectory: string;

beforeEach(async () => {
  rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-mi-setup-"));
});

afterEach(async () => {
  await fs.rm(rootDirectory, { recursive: true, force: true });
});

// A copy of the script lives in a temp tree so its data/ output lands there, never in the repo.
async function prepareTree(): Promise<{ scriptPath: string; homeDirectory: string; binDirectory: string; tmpDirectory: string }> {
  const scriptsDirectory: string = path.join(rootDirectory, "scripts");
  const homeDirectory: string = path.join(rootDirectory, "home");
  const binDirectory: string = path.join(rootDirectory, "bin");
  const tmpDirectory: string = path.join(rootDirectory, "tmp");
  await fs.mkdir(scriptsDirectory, { recursive: true });
  await fs.mkdir(path.join(homeDirectory, ".cloudflared"), { recursive: true });
  await fs.mkdir(binDirectory);
  await fs.mkdir(tmpDirectory);
  const scriptPath: string = path.join(scriptsDirectory, "setup-named-tunnel.sh");
  await fs.copyFile(path.join(scriptsSourceDirectory, "setup-named-tunnel.sh"), scriptPath);
  await fs.writeFile(path.join(scriptsDirectory, "install-tunnel-service.sh"), "");
  await fs.writeFile(path.join(homeDirectory, ".cloudflared", "cert.pem"), "fake-cert");
  await fs.writeFile(path.join(homeDirectory, ".cloudflared", `${TUNNEL_ID}.json`), "{}");
  const stubCloudflared: string = `#!/bin/bash
if [[ "$1 $2" == "tunnel list" ]]; then
  echo '[{"id":"${TUNNEL_ID}","name":"${TUNNEL_NAME}"}]'
  exit 0
fi
exit 0
`;
  await fs.writeFile(path.join(binDirectory, "cloudflared"), stubCloudflared, { mode: 0o755 });
  return { scriptPath, homeDirectory, binDirectory, tmpDirectory };
}

describe.skipIf(process.platform !== "darwin")("setup-named-tunnel.sh", () => {
  it("given a fresh setup, when the script runs, then config.yml and tunnel.json both use http2 with a UDP reason comment", async () => {
    const jqLookup = spawnSync("bash", ["-c", "command -v jq"], { encoding: "utf8" });
    // Fail loudly instead of skipping so the gate cannot pass vacuously without jq.
    expect(jqLookup.status, "jq must be installed (brew install jq) for this test to run").toBe(0);

    const { scriptPath, homeDirectory, binDirectory, tmpDirectory } = await prepareTree();
    const run = spawnSync("bash", [scriptPath, "app.example.com", "--no-install"], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: homeDirectory,
        TMPDIR: tmpDirectory,
        DASHBOARD_PASSWORD: "unused",
      },
    });
    expect(run.status, `script failed: ${run.stderr}${run.stdout}`).toBe(0);

    const namedDirectory: string = path.join(rootDirectory, "data", "named-tunnel");
    const configLines: string[] = (await fs.readFile(path.join(namedDirectory, "config.yml"), "utf8")).split("\n");
    const protocolIndex: number = configLines.indexOf("protocol: http2");
    expect(protocolIndex).toBeGreaterThan(0);
    const commentLine: string = configLines[protocolIndex - 1];
    expect(commentLine.startsWith("#")).toBe(true);
    expect(commentLine).toMatch(/http2|UDP/i);
    // The heredoc is unquoted, so backticks or $ would be expanded by the shell.
    expect(commentLine).not.toMatch(/[`$]/);

    const tunnelJson = JSON.parse(await fs.readFile(path.join(namedDirectory, "tunnel.json"), "utf8")) as { protocol: string };
    expect(tunnelJson.protocol).toBe("http2");
  });

  it("given the script source, when inspected, then it no longer writes to the shared /tmp error path", async () => {
    const source: string = await fs.readFile(path.join(scriptsSourceDirectory, "setup-named-tunnel.sh"), "utf8");

    expect(source).not.toContain("/tmp/cf-route-dns.err");
  });
});
