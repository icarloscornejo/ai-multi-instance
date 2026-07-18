import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../scripts/dashboard-cursor-statusline.mjs", import.meta.url));

function runStatusline(home: string, payload: object, instanceId = "cursor-instance"): string {
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: home, AI_MULTI_INSTANCE_ID: instanceId },
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("Cursor dashboard status line", () => {
  it("writes Cursor context and token metrics to the instance snapshot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-statusline-"));
    const output = runStatusline(home, {
      session_id: "chat-123",
      model: { display_name: "GPT-5.6 Sol" },
      workspace: { current_dir: "/not-a-git-repository" },
      context_window: {
        used_percentage: 12.5,
        context_window_size: 1_000_000,
        total_input_tokens: 8_000,
        total_output_tokens: 1_200,
      },
    });

    expect(output).toBe("GPT-5.6 Sol · 13% context");
    const snapshot = JSON.parse(
      await readFile(path.join(home, ".cache", "ai-multi-instance", "cursor-instance.json"), "utf8"),
    );
    expect(snapshot).toMatchObject({
      provider: "cursor",
      sessionId: "chat-123",
      model: "GPT-5.6 Sol",
      cwd: "/not-a-git-repository",
      contextUsed: 125_000,
      contextSize: 1_000_000,
      contextPct: 12.5,
      inputTokens: 8_000,
      outputTokens: 1_200,
    });
  });

  it("derives used context from the remaining percentage and preserves a custom status line", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-statusline-"));
    const cursorDir = path.join(home, ".cursor");
    const cacheDir = path.join(home, ".cache", "ai-multi-instance");
    await mkdir(cursorDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, "cursor-instance.json"),
      JSON.stringify({ provider: "cursor", sessionId: "chat-created-before-statusline" }),
    );
    await writeFile(
      path.join(cursorDir, "ai-multi-instance-statusline.json"),
      JSON.stringify({
        statusLine: {
          command: "node -e \"process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('custom status'))\"",
        },
      }),
    );

    const output = runStatusline(home, {
      context_window: { remaining_percentage: 80, context_window_size: 200_000 },
    });

    expect(output).toBe("custom status");
    const snapshot = JSON.parse(
      await readFile(path.join(home, ".cache", "ai-multi-instance", "cursor-instance.json"), "utf8"),
    );
    expect(snapshot).toMatchObject({
      sessionId: "chat-created-before-statusline",
      contextPct: 20,
      contextUsed: 40_000,
      contextSize: 200_000,
    });
  });
});
