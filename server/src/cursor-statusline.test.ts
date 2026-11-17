import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../scripts/dashboard-cursor-statusline.mjs", import.meta.url));

// TMUX_PANE is stripped so the run does not pick up the pane the tests themselves run in: the
// identity rules under test are driven only by what each test passes in.
// CLAUDE_CONFIG_DIR is stripped too so the developer's own profile never leaks a user-level cap.
function runStatusline(
  home: string,
  payload: object,
  instanceId: string | null = "cursor-instance",
  envOverride: Record<string, string> = {},
): string {
  const {
    TMUX_PANE: _tmuxPane,
    AI_MULTI_INSTANCE_ID: _instanceId,
    CLAUDE_CONFIG_DIR: _configDir,
    ...inheritedEnv
  } = process.env;
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...inheritedEnv,
      HOME: home,
      ...(instanceId === null ? {} : { AI_MULTI_INSTANCE_ID: instanceId }),
      ...envOverride,
    },
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
      await readFile(path.join(home, "Library", "Application Support", "ai-multi-instance", "cursor-instance.json"), "utf8"),
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
    const cacheDir = path.join(home, "Library", "Application Support", "ai-multi-instance");
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
      await readFile(path.join(home, "Library", "Application Support", "ai-multi-instance", "cursor-instance.json"), "utf8"),
    );
    expect(snapshot).toMatchObject({
      sessionId: "chat-created-before-statusline",
      contextPct: 20,
      contextUsed: 40_000,
      contextSize: 200_000,
    });
  });

  it("writes nothing when it is not running inside a dashboard instance", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-statusline-"));
    runStatusline(home, { session_id: "chat-9", model: { display_name: "GPT" } }, null);
    await expect(
      readFile(path.join(home, "Library", "Application Support", "ai-multi-instance", "cursor-instance.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("does not carry another agent's cost and rate limits into a Cursor snapshot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-statusline-"));
    const cacheDir = path.join(home, "Library", "Application Support", "ai-multi-instance");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, "cursor-instance.json"),
      JSON.stringify({ provider: "claude", sessionId: "claude-session", sessionCostUsd: 93.8, fiveHourPct: 21 }),
    );
    runStatusline(home, { session_id: "chat-1", model: { display_name: "GPT" } });
    const snapshot = JSON.parse(await readFile(path.join(cacheDir, "cursor-instance.json"), "utf8"));
    expect(snapshot).toMatchObject({ provider: "cursor", sessionId: "chat-1", idSource: "env" });
    expect(snapshot.sessionCostUsd).toBeUndefined();
    expect(snapshot.fiveHourPct).toBeUndefined();
  });
});

type Snapshot = Record<string, unknown>;

async function readSnapshot(home: string): Promise<Snapshot> {
  return JSON.parse(
    await readFile(path.join(home, "Library", "Application Support", "ai-multi-instance", "cursor-instance.json"), "utf8"),
  );
}

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cursor-statusline-"));
}

// Writes <directory>/<fileName> (creating parents) with the given raw text.
async function writeRaw(directory: string, fileName: string, rawContent: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), rawContent);
}

async function writeCap(directory: string, fileName: string, cap: unknown): Promise<void> {
  await writeRaw(directory, fileName, JSON.stringify({ autoCompactWindow: cap }));
}

function usedPayload(cwd: string | undefined, usedPercentage: number, contextWindowSize = 1_000_000): object {
  return {
    model: { display_name: "Opus" },
    ...(cwd === undefined ? {} : { workspace: { current_dir: cwd } }),
    context_window: { context_window_size: contextWindowSize, used_percentage: usedPercentage },
  };
}

describe("Cursor dashboard status line auto-compact cap", () => {
  it("given_cap_below_model_window_when_statusline_runs_then_size_is_the_cap_and_pct_is_rescaled", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);

    const output = runStatusline(home, usedPayload(cwd, 16));

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(300_000);
    expect(snapshot.contextUsed).toBe(160_000);
    expect(snapshot.contextPct).toBeCloseTo(53.333, 2);
    expect(output).toContain("53% context");
  });

  it("given_cap_below_model_window_and_remaining_percentage_when_statusline_runs_then_size_is_the_cap", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);

    const output = runStatusline(home, {
      model: { display_name: "Opus" },
      workspace: { current_dir: cwd },
      context_window: { context_window_size: 1_000_000, remaining_percentage: 84 },
    });

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(300_000);
    expect(snapshot.contextUsed).toBe(160_000);
    expect(snapshot.contextPct).toBeCloseTo(53.333, 2);
    expect(output).toContain("53% context");
  });

  it("given_local_and_project_caps_when_statusline_runs_then_the_local_file_wins", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeCap(path.join(cwd, ".claude"), "settings.local.json", 300_000);
    await writeCap(path.join(cwd, ".claude"), "settings.json", 200_000);

    runStatusline(home, usedPayload(cwd, 16));

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_project_and_user_caps_when_statusline_runs_then_the_project_file_wins", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);
    await writeCap(path.join(home, ".claude"), "settings.json", 200_000);

    runStatusline(home, usedPayload(cwd, 16));

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_cap_only_in_claude_config_dir_when_statusline_runs_then_that_user_level_cap_is_used", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    const configDir = await makeHome();
    await writeCap(configDir, "settings.json", 300_000);
    await writeCap(path.join(home, ".claude"), "settings.json", 200_000);

    runStatusline(home, usedPayload(cwd, 16), "cursor-instance", { CLAUDE_CONFIG_DIR: configDir });

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_invalid_local_file_and_valid_project_cap_when_statusline_runs_then_it_falls_through_to_the_project_cap", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeRaw(path.join(cwd, ".claude"), "settings.local.json", "{ not json");
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);

    runStatusline(home, usedPayload(cwd, 16));

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_fractional_cap_when_statusline_runs_then_it_is_floored", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000.5);

    runStatusline(home, usedPayload(cwd, 16));

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_used_above_the_cap_when_statusline_runs_then_pct_is_not_clamped", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);

    runStatusline(home, usedPayload(cwd, 40));

    expect((await readSnapshot(home)).contextPct).toBeCloseTo(133.33, 1);
  });

  it("given_payload_without_cwd_and_user_level_cap_when_statusline_runs_then_the_cap_applies", async () => {
    const home = await makeHome();
    await writeCap(path.join(home, ".claude"), "settings.json", 300_000);

    runStatusline(home, usedPayload(undefined, 16));

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(300_000);
    expect(snapshot.contextPct).toBeCloseTo(53.333, 2);
  });

  it("given_no_settings_anywhere_when_statusline_runs_then_model_window_and_raw_pct_are_kept", async () => {
    const home = await makeHome();
    const cwd = await makeHome();

    const output = runStatusline(home, usedPayload(cwd, 16));

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(1_000_000);
    expect(snapshot.contextPct).toBe(16);
    expect(output).toContain("16% context");
  });

  it("given_cap_above_model_window_when_statusline_runs_then_model_window_is_kept", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 2_000_000);

    runStatusline(home, usedPayload(cwd, 16));

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(1_000_000);
    expect(snapshot.contextPct).toBe(16);
  });

  it.each([
    ["invalid_json", "{ nope"],
    ["array", "[300000]"],
    ["string_value", JSON.stringify({ autoCompactWindow: "300000" })],
    ["null_value", JSON.stringify({ autoCompactWindow: null })],
    ["zero", JSON.stringify({ autoCompactWindow: 0 })],
    ["half", JSON.stringify({ autoCompactWindow: 0.5 })],
    ["negative", JSON.stringify({ autoCompactWindow: -5 })],
  ])("given_invalid_settings_file_%s_when_statusline_runs_then_model_window_is_kept", async (_label, rawContent) => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeRaw(path.join(cwd, ".claude"), "settings.json", rawContent);

    runStatusline(home, usedPayload(cwd, 16));

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(1_000_000);
    expect(snapshot.contextPct).toBe(16);
  });

  it("given_directory_named_settings_json_when_statusline_runs_then_model_window_is_kept", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await mkdir(path.join(cwd, ".claude", "settings.json"), { recursive: true });

    runStatusline(home, usedPayload(cwd, 16));

    expect((await readSnapshot(home)).contextSize).toBe(1_000_000);
  });

  it("given_payload_without_context_window_size_and_a_cap_when_statusline_runs_then_size_and_pct_stay_absent", async () => {
    const home = await makeHome();
    const cwd = await makeHome();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);

    const output = runStatusline(home, {
      model: { display_name: "Opus" },
      workspace: { current_dir: cwd },
      context_window: {},
    });

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBeUndefined();
    expect(snapshot.contextPct).toBeUndefined();
    expect(output).not.toContain("NaN");
  });
});
