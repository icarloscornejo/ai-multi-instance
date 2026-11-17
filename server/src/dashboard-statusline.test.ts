import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../scripts/dashboard-statusline.sh", import.meta.url));
const instanceId = "claude-instance";

// TMUX_PANE and CLAUDE_CONFIG_DIR are stripped so the developer's own pane and profile never leak
// in. The payloads carry no rate_limits, which keeps the script off the keychain/curl branch.
function runStatusline(home: string, payload: object, envOverride: Record<string, string> = {}): number | null {
  const { TMUX_PANE: _tmuxPane, CLAUDE_CONFIG_DIR: _configDir, ...inheritedEnv } = process.env;
  const result = spawnSync("bash", [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...inheritedEnv, HOME: home, AI_MULTI_INSTANCE_ID: instanceId, ...envOverride },
  });
  return result.status;
}

async function readSnapshot(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(home, "Library", "Application Support", "ai-multi-instance", `${instanceId}.json`), "utf8"),
  );
}

async function makeDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "dashboard-statusline-"));
}

async function writeRaw(directory: string, fileName: string, rawContent: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), rawContent);
}

async function writeCap(directory: string, fileName: string, cap: unknown): Promise<void> {
  await writeRaw(directory, fileName, JSON.stringify({ autoCompactWindow: cap }));
}

function payloadFor(cwd: string, contextWindowSize: number | undefined = 1_000_000): object {
  return {
    cwd,
    model: { display_name: "Opus" },
    context_window: {
      ...(contextWindowSize === undefined ? {} : { context_window_size: contextWindowSize }),
      current_usage: { input_tokens: 10_000, cache_creation_input_tokens: 50_000, cache_read_input_tokens: 100_000 },
    },
  };
}

describe("Claude dashboard status line auto-compact cap", () => {
  it("given_cap_below_model_window_when_statusline_runs_then_size_is_the_cap", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);

    expect(runStatusline(home, payloadFor(cwd))).toBe(0);

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(300_000);
    expect(snapshot.contextUsed).toBe(160_000);
    expect(snapshot.contextPct).toBe(53);
  });

  it("given_local_and_project_caps_when_statusline_runs_then_the_local_file_wins", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    await writeCap(path.join(cwd, ".claude"), "settings.local.json", 300_000);
    await writeCap(path.join(cwd, ".claude"), "settings.json", 200_000);

    runStatusline(home, payloadFor(cwd));

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_project_and_user_caps_when_statusline_runs_then_the_project_file_wins", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);
    await writeCap(path.join(home, ".claude"), "settings.json", 200_000);

    runStatusline(home, payloadFor(cwd));

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_cap_only_in_claude_config_dir_when_statusline_runs_then_that_user_level_cap_is_used", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    const configDir = await makeDir();
    await writeCap(configDir, "settings.json", 300_000);
    await writeCap(path.join(home, ".claude"), "settings.json", 200_000);

    runStatusline(home, payloadFor(cwd), { CLAUDE_CONFIG_DIR: configDir });

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_invalid_local_file_and_valid_project_cap_when_statusline_runs_then_it_falls_through_to_the_project_cap", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    await writeRaw(path.join(cwd, ".claude"), "settings.local.json", "{ not json");
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000);

    runStatusline(home, payloadFor(cwd));

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_fractional_cap_when_statusline_runs_then_it_is_floored", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 300_000.5);

    runStatusline(home, payloadFor(cwd));

    expect((await readSnapshot(home)).contextSize).toBe(300_000);
  });

  it("given_payload_without_context_window_size_and_a_cap_when_statusline_runs_then_the_cap_applies_to_the_default", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 150_000);

    runStatusline(home, payloadFor(cwd, undefined));

    expect((await readSnapshot(home)).contextSize).toBe(150_000);
  });

  it("given_no_settings_anywhere_when_statusline_runs_then_model_window_is_kept", async () => {
    const home = await makeDir();
    const cwd = await makeDir();

    runStatusline(home, payloadFor(cwd));

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(1_000_000);
    expect(snapshot.contextPct).toBe(16);
  });

  it("given_cap_above_model_window_when_statusline_runs_then_model_window_is_kept", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    await writeCap(path.join(cwd, ".claude"), "settings.json", 2_000_000);

    runStatusline(home, payloadFor(cwd));

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
    ["two_json_values", '{"autoCompactWindow": 300000}\n{"autoCompactWindow": 200000}'],
    ["trailing_junk", '{"autoCompactWindow": 300000} junk'],
  ])("given_invalid_settings_file_%s_when_statusline_runs_then_model_window_is_kept", async (_label, rawContent) => {
    const home = await makeDir();
    const cwd = await makeDir();
    await writeRaw(path.join(cwd, ".claude"), "settings.json", rawContent);

    expect(runStatusline(home, payloadFor(cwd))).toBe(0);

    const snapshot = await readSnapshot(home);
    expect(snapshot.contextSize).toBe(1_000_000);
    expect(snapshot.contextPct).toBe(16);
  });

  it("given_directory_named_settings_json_when_statusline_runs_then_model_window_is_kept", async () => {
    const home = await makeDir();
    const cwd = await makeDir();
    await mkdir(path.join(cwd, ".claude", "settings.json"), { recursive: true });

    expect(runStatusline(home, payloadFor(cwd))).toBe(0);

    expect((await readSnapshot(home)).contextSize).toBe(1_000_000);
  });
});
