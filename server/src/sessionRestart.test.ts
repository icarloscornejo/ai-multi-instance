import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEnvironmentReading } from "./agentFallback";
import type { ParsedAgentStateFile } from "./agentState";
import type { PaneAgent } from "./paneAgent";
import type { ScreenMode } from "./restartCommand";
import { withSessionLock } from "./sessionLock";
import {
  RestartError,
  handleRestartRequest,
  isRestartInProgress,
  restartClaudeSession,
  restartErrorStatus,
  type RestartDeps,
  type RestartErrorCode,
  type RestartResult,
} from "./sessionRestart";
import type { InstanceRecord } from "./types";

// ---------------------------------------------------------------------------------------------
// A fake world: one tmux session with an original pane and an active split of another cwd, a
// clock that only moves when the code sleeps, and a Claude process that exits and relaunches on
// the fake timeline. No real tmux, ps, lsof, claude or home directory is ever touched.
// ---------------------------------------------------------------------------------------------

const FAKE_TOKEN: string = String("faketoken_for_tests_0123456789abcdef");
const SESSION = "ccdash-abc123";
const PANE = "%3";
const SPLIT_PANE = "%9";
const CWD = "/Users/example/repo";
const PROFILE = "/Users/example/.claude-me";
const STATE_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const INSTANCE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const TRANSCRIPT_ID = "44444444-4444-4444-8444-444444444444";
const HINT_ID = "55555555-5555-4555-8555-555555555555";
const OLD_HINT_ID = "66666666-6666-4666-8666-666666666666";
const LOADER_LINE = "source /Users/example/scripts/instance-loader.sh";
const SETTINGS = String.raw`{"statusLine":{"type":"command","command":"/Users/example/line.sh"},"env":{"API_KEY":"${FAKE_TOKEN}"},"hooks":{"Stop":[{"command":"say \"hi {x}\" now"}]}}`;
const PS_ARGS = `/bin/bash /Users/example/bin/claude-me --model opusplan --effort medium --settings ${SETTINGS} -n Auto-MI`;

const RULE = "─".repeat(72);
const FOOTERS: Record<Exclude<ScreenMode, "unknown">, string> = {
  default: "  ? for shortcuts",
  "accept-edits": "  ⏵⏵ accept edits on (shift+tab to cycle)",
  plan: "  ⏸ plan mode on (shift+tab to cycle)",
  bypass: "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle)",
};

function screen(mode: ScreenMode, options: { above?: string[]; input?: string } = {}): string {
  const footer = mode === "unknown" ? "  something unrelated in the footer" : FOOTERS[mode];
  return [...(options.above ?? ["● Done with the change."]), RULE, options.input ?? "❯ ", RULE, footer, "  statusline one", "  statusline two", ""].join("\n");
}

function exitWithHint(hintLine: string): string {
  return `${screen("default")}\n❯ /exit\n  ⎿  Bye!\n\nResume this session with:\n${hintLine}\n$ `;
}

interface World {
  instance?: Partial<InstanceRecord>;
  paneJobArgs?: string;
  provider?: "claude" | "codex";
  paneJobPid?: number;
  originalPanePid?: number;
  state?: ParsedAgentStateFile | null | ((readNumber: number) => ParsedAgentStateFile | null);
  stateSessionId?: string | null;
  preMode?: ScreenMode;
  preScreen?: string;
  exitScreen?: string;
  exitDelayMs?: number;
  startDelayMs?: number;
  dieAfterMs?: number;
  unknownProbeMs?: number;
  lingeringWrapper?: boolean;
  environment?: AgentEnvironmentReading;
  cwd?: string | null;
  paneCwd?: string;
  snapshotId?: string | null;
  transcriptId?: string | null;
  startMode?: ScreenMode;
  btabSequence?: ScreenMode[];
  clientActivity?: number | null;
  presence?: "present" | "absent" | "unknown";
  paneIdAfterExit?: string;
  paneIdAfterRelaunch?: string;
  failSetEnvironment?: Error;
  failLoaderText?: Error;
  failLoaderEnter?: Error;
  deps?: Partial<RestartDeps>;
}

function baseInstance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: "abc123",
    label: "Auto-MI",
    locationPath: CWD,
    tmuxSession: SESSION,
    provider: "claude",
    command: "claude-me",
    model: null,
    effort: null,
    fontSize: 13,
    createdAt: "2026-01-01T00:00:00.000Z",
    configDir: PROFILE,
    ...overrides,
  } as InstanceRecord;
}

function harness(world: World = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const texts: string[] = [];
  const keys: string[] = [];
  const envSets: { name: string; value: string }[] = [];
  const unsets: string[] = [];
  const probeOptions: unknown[] = [];
  const targets: string[] = [];
  const cwdPids: number[] = [];
  let clock = 1_000_000;
  let enters = 0;
  let textCalls = 0;
  let stateReads = 0;
  let presses = 0;
  let exitEnterAt: number | null = null;
  let relaunchAt: number | null = null;

  const instance = baseInstance(world.instance);
  const paneJobPid = world.paneJobPid ?? 300;
  const exitDelayMs = world.exitDelayMs ?? 700;
  const startDelayMs = world.startDelayMs ?? 500;
  const sequence: ScreenMode[] = world.btabSequence ?? ["accept-edits", "auto"];

  const oldAgent: PaneAgent = {
    kind: "agent",
    provider: world.provider ?? "claude",
    paneJobPid,
    agentPid: paneJobPid + 1,
    startedAtMs: 0,
    resumeId: null,
    paneJobArgs: world.paneJobArgs ?? PS_ARGS,
  } as PaneAgent;
  const newAgent: PaneAgent = { kind: "agent", provider: "claude", paneJobPid: 400, agentPid: 401, startedAtMs: 0, resumeId: null, paneJobArgs: PS_ARGS } as PaneAgent;
  const preScreen: string = world.preScreen ?? screen(world.preMode ?? "default");

  function modeNow(): ScreenMode {
    return presses === 0 ? (world.startMode ?? "default") : sequence[Math.min(presses - 1, sequence.length - 1)];
  }

  function stateFile(pid: number): ParsedAgentStateFile {
    return { state: "idle", paneJobPid: pid, sessionId: world.stateSessionId === undefined ? STATE_ID : world.stateSessionId, updatedAt: "2026-11-09T10:00:00Z" } as ParsedAgentStateFile;
  }

  const lock = <T>(session: string, run: () => Promise<T>): Promise<T> =>
    withSessionLock(session, async () => {
      events.push("lock+");
      try {
        return await run();
      } finally {
        events.push("lock-");
      }
    });

  const deps: RestartDeps = {
    getOriginalPaneId: async () => {
      if (relaunchAt !== null && world.paneIdAfterRelaunch !== undefined) return world.paneIdAfterRelaunch;
      if (exitEnterAt !== null && relaunchAt === null && world.paneIdAfterExit !== undefined) return world.paneIdAfterExit;
      return PANE;
    },
    getOriginalPanePid: async () => world.originalPanePid ?? 100,
    getSessionPresence: async () => world.presence ?? "present",
    getPaneCurrentPath: async (target) => {
      targets.push(target);
      return world.paneCwd ?? CWD;
    },
    capturePane: async (target) => {
      events.push("capture");
      targets.push(target);
      if (relaunchAt !== null) return screen(modeNow());
      if (exitEnterAt !== null) return world.exitScreen ?? `${preScreen}\n❯ /exit\n$ `;
      return preScreen;
    },
    sendText: async (target, text) => {
      textCalls += 1;
      events.push(`text:${text}`);
      targets.push(target);
      texts.push(text);
      if (textCalls === 2 && world.failLoaderText !== undefined) throw world.failLoaderText;
    },
    sendEnter: async (target) => {
      enters += 1;
      events.push("enter");
      targets.push(target);
      if (enters === 1) exitEnterAt = clock;
      if (enters === 2) {
        if (world.failLoaderEnter !== undefined) {
          if ((world.failLoaderEnter as Error & { killed?: boolean }).killed === true) relaunchAt = clock;
          throw world.failLoaderEnter;
        }
        relaunchAt = clock;
      }
    },
    sendKey: async (target, key) => {
      events.push(`key:${key}`);
      targets.push(target);
      keys.push(key);
      presses += 1;
    },
    setEnvironment: async (_session, name, value) => {
      events.push(`setenv:${name}`);
      if (world.failSetEnvironment !== undefined) throw world.failSetEnvironment;
      envSets.push({ name, value });
    },
    unsetEnvironment: async (_session, name) => {
      events.push(`unsetenv:${name}`);
      unsets.push(name);
    },
    clientActivitySeconds: async () => {
      events.push("clients");
      return world.clientActivity ?? null;
    },
    probePane: async (_instance, options) => {
      events.push("probe");
      probeOptions.push(options);
      if (relaunchAt !== null) {
        const since = clock - relaunchAt;
        if (since < (world.unknownProbeMs ?? 0)) return { kind: "unknown" } as PaneAgent;
        if (since >= startDelayMs && (world.dieAfterMs === undefined || since < startDelayMs + world.dieAfterMs)) return newAgent;
        return { kind: "none", shellOwnsForeground: true } as PaneAgent;
      }
      if (exitEnterAt !== null && clock >= exitEnterAt + exitDelayMs) {
        return { kind: "none", shellOwnsForeground: world.lingeringWrapper !== true } as PaneAgent;
      }
      return oldAgent;
    },
    readAgentState: async () => {
      events.push("state");
      stateReads += 1;
      if (relaunchAt !== null) return clock - relaunchAt >= startDelayMs ? stateFile(400) : null;
      if (exitEnterAt !== null) return null;
      if (typeof world.state === "function") return world.state(stateReads);
      if (world.state !== undefined) return world.state;
      return stateFile(paneJobPid);
    },
    readAgentCwd: async (pid) => {
      cwdPids.push(pid);
      return world.cwd === undefined ? CWD : world.cwd;
    },
    readAgentEnvironment: async () => world.environment ?? { configDir: { kind: "set", dir: PROFILE }, hasInstanceId: true },
    readAgentArgs: async (pid) => (pid === 401 ? "/Users/example/.local/share/claude/versions/2.1.311" : "/Users/example/.local/share/claude/versions/2.1.310"),
    snapshotSessionId: async () => world.snapshotId ?? null,
    pickTranscript: vi.fn(async () => world.transcriptId ?? null),
    ownedSessionIds: async () => new Set<string>(),
    buildInstanceCommand: (_instance, sessionId) => `INSTANCE_BUILDER ${sessionId}`,
    loaderInvocation: LOADER_LINE,
    withPaneTypingLock: lock,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      clock += milliseconds;
      await Promise.resolve();
    },
    now: () => clock,
    log: (line) => {
      logs.push(line);
    },
    ...world.deps,
  };

  return {
    instance,
    deps,
    events,
    logs,
    texts,
    keys,
    envSets,
    unsets,
    probeOptions,
    targets,
    cwdPids,
    pickTranscript: deps.pickTranscript as unknown as ReturnType<typeof vi.fn>,
    clock: () => clock,
    relaunchAt: () => relaunchAt,
    nothingSent: () => texts.length === 0 && enters === 0 && keys.length === 0 && envSets.length === 0,
    noRelaunch: () => envSets.length === 0 && texts.every((text) => text === "/exit"),
  };
}

type Harness = ReturnType<typeof harness>;

async function outcome(world: World = {}): Promise<{ h: Harness; result: RestartResult | null; error: (Error & Partial<RestartError>) | null }> {
  const h = harness(world);
  try {
    return { h, result: await restartClaudeSession(h.instance, h.deps), error: null };
  } catch (caught) {
    return { h, result: null, error: caught as Error & Partial<RestartError> };
  }
}

async function succeeds(world: World = {}): Promise<{ h: Harness; result: RestartResult }> {
  const { h, result, error } = await outcome(world);
  if (result === null) throw new Error(`expected success, got ${error?.code ?? "unknown error"}`);
  return { h, result };
}

async function refused(world: World, code: RestartErrorCode): Promise<{ h: Harness; error: Error & Partial<RestartError> }> {
  const { h, result, error } = await outcome(world);
  expect(result).toBeNull();
  expect(error).toBeInstanceOf(RestartError);
  expect(error?.code).toBe(code);
  return { h, error: error as Error & Partial<RestartError> };
}

function lockSections(events: string[]): string[][] {
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const event of events) {
    if (event === "lock+") current = [];
    else if (event === "lock-") {
      if (current !== null) sections.push(current);
      current = null;
    } else if (current !== null) current.push(event);
  }
  return sections;
}

function firstIndex(events: string[], predicate: (event: string) => boolean): number {
  return events.findIndex(predicate);
}

function workingState(state: "working" | "waiting", pid = 300): ParsedAgentStateFile {
  return { state, paneJobPid: pid, sessionId: STATE_ID, updatedAt: "2026-11-09T10:00:00Z" } as ParsedAgentStateFile;
}

// ---------------------------------------------------------------------------------------------

describe("restartClaudeSession: refusing to restart", () => {
  it("given_a_running_codex_agent_when_restart_requested_then_refused_and_no_keys_sent", async () => {
    const { h } = await refused({ provider: "codex" }, "no-agent");
    expect(h.nothingSent()).toBe(true);
  });

  it("given_no_running_agent_when_restart_requested_then_refused_and_no_keys_sent", async () => {
    const { h } = await refused({ deps: { probePane: async () => ({ kind: "none", shellOwnsForeground: true }) as PaneAgent } }, "no-agent");
    expect(h.nothingSent()).toBe(true);
  });

  it("given_exec_claude_where_the_pane_shell_is_the_agent_when_restart_requested_then_refused_and_no_keys_sent", async () => {
    const { h } = await refused({ paneJobPid: 100, originalPanePid: 100 }, "shell-is-agent");
    expect(h.nothingSent()).toBe(true);
  });

  it.each([
    ["working", workingState("working"), "busy"],
    ["waiting", workingState("waiting"), "busy"],
    ["missing", null, "no-state"],
    ["recorded for another pid", { ...workingState("working"), state: "idle", paneJobPid: 999 } as ParsedAgentStateFile, "no-state"],
  ] as const)("given_state_%s_when_restart_requested_then_refused_and_no_keys_sent", async (_name, state, code) => {
    const { h } = await refused({ state }, code);
    expect(h.nothingSent()).toBe(true);
  });

  it("given_a_busy_screen_with_an_idle_state_when_restart_requested_then_refused_and_no_keys_sent", async () => {
    const preScreen = screen("default", { above: ["● Reading files", "✻ Pondering… (12s · esc to interrupt)"] });

    const { h } = await refused({ preScreen }, "busy");

    expect(h.nothingSent()).toBe(true);
  });

  it("given_a_draft_in_the_prompt_when_restart_requested_then_refused_and_no_keys_sent", async () => {
    const { h } = await refused({ preScreen: screen("default", { input: "❯ fix the failing test" }) }, "input-not-empty");
    expect(h.nothingSent()).toBe(true);
  });

  it("given_state_flipping_to_working_on_the_final_reread_when_restart_requested_then_refused_and_no_keys_sent", async () => {
    const state = (readNumber: number): ParsedAgentStateFile | null =>
      readNumber === 1 ? ({ ...workingState("working"), state: "idle" } as ParsedAgentStateFile) : workingState("working");

    const { h } = await refused({ state }, "busy");

    expect(h.nothingSent()).toBe(true);
  });

  it("given_a_client_that_typed_one_second_ago_when_restart_requested_then_refused_and_no_keys_sent", async () => {
    const { h } = await refused({ clientActivity: 1 }, "client-active");
    expect(h.nothingSent()).toBe(true);
  });

  it("given_an_attached_client_idle_for_a_minute_when_restart_requested_then_it_proceeds", async () => {
    const { result } = await succeeds({ clientActivity: 60 });
    expect(result.ok).toBe(true);
  });

  it("given_no_agent_cwd_when_restart_requested_then_refused_before_exit_with_cwd_missing", async () => {
    const { h, error } = await refused({ cwd: null }, "missing");

    expect(error.missing).toEqual(["cwd"]);
    expect(h.nothingSent()).toBe(true);
  });

  it("given_the_probe_when_restart_requested_then_the_probe_cache_is_always_bypassed", async () => {
    const { h } = await succeeds();

    expect(h.probeOptions.length).toBeGreaterThan(2);
    expect(h.probeOptions.every((options) => (options as { bypassCache?: boolean }).bypassCache === true)).toBe(true);
  });
});

describe("restartClaudeSession: the happy path and its ordering", () => {
  it("given_an_idle_claude_session_when_restart_requested_then_it_exits_relaunches_through_the_loader_and_reports_success", async () => {
    const { h, result } = await succeeds();

    expect(result).toMatchObject({ ok: true, sessionId: STATE_ID, versionBefore: "2.1.310", versionAfter: "2.1.311", autoMode: "not-applicable", commandSource: "process" });
    expect(result).not.toHaveProperty("command");
    expect(h.texts).toEqual(["/exit", LOADER_LINE]);
    expect(h.envSets).toHaveLength(1);
    expect(h.envSets[0].name).toBe("AI_LAUNCH_COMMAND");
    expect(h.envSets[0].value).toContain(`--resume '${STATE_ID}'`);
    expect(h.envSets[0].value).toContain("CLAUDE_CONFIG_DIR='/Users/example/.claude-me'");
    expect(h.envSets[0].value).toContain("AI_MULTI_INSTANCE_ID='abc123'");
  });

  it("given_a_restart_when_it_runs_then_calls_happen_in_order_gates_exit_gap_enter_wait_relaunch_verify", async () => {
    const { h } = await succeeds();
    const events = h.events;

    const stateRead = firstIndex(events, (event) => event === "state");
    const exitText = firstIndex(events, (event) => event === "text:/exit");
    const gap = firstIndex(events, (event) => event === "sleep:200");
    const firstEnter = firstIndex(events, (event) => event === "enter");
    const wait = firstIndex(events.slice(firstEnter), (event) => event === "probe") + firstEnter;
    const setEnvironment = firstIndex(events, (event) => event.startsWith("setenv:"));
    const loaderText = firstIndex(events, (event) => event === `text:${LOADER_LINE}`);
    const loaderEnter = events.indexOf("enter", firstEnter + 1);
    const verify = firstIndex(events.slice(loaderEnter), (event) => event === "probe") + loaderEnter;

    expect(stateRead).toBeGreaterThanOrEqual(0);
    expect(stateRead).toBeLessThan(exitText);
    expect(exitText).toBeLessThan(gap);
    expect(gap).toBeLessThan(firstEnter);
    expect(firstEnter).toBeLessThan(wait);
    expect(wait).toBeLessThan(setEnvironment);
    expect(setEnvironment).toBeLessThan(loaderText);
    expect(loaderText).toBeLessThan(loaderEnter);
    expect(loaderEnter).toBeLessThan(verify);
  });

  it("given_a_restart_when_it_runs_then_only_short_plain_key_sections_are_locked_and_never_a_poll", async () => {
    const { h } = await succeeds();

    const sections = lockSections(h.events);

    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual([]);
    expect(sections[1]).toEqual(expect.arrayContaining(["text:/exit", "sleep:200", "enter"]));
    expect(sections[2]).toEqual(expect.arrayContaining(["enter", `text:${LOADER_LINE}`]));
    for (const section of sections) {
      expect(section).not.toContain("probe");
      expect(section).not.toContain("sleep:100");
    }
  });

  it("given_a_delivery_holding_the_plain_key_when_restart_starts_then_gates_and_exit_wait_until_its_paste_and_enter_finish", async () => {
    const h = harness();
    const delivery = h.deps.withPaneTypingLock(SESSION, async () => {
      h.events.push("paste");
      await Promise.resolve();
      await Promise.resolve();
      h.events.push("paste-enter");
    });
    const restart = restartClaudeSession(h.instance, h.deps);

    await Promise.all([delivery, restart]);

    const pasteEnter = h.events.indexOf("paste-enter");
    expect(pasteEnter).toBeGreaterThanOrEqual(0);
    expect(firstIndex(h.events, (event) => event === "state")).toBeGreaterThan(pasteEnter);
    expect(h.events.indexOf("text:/exit")).toBeGreaterThan(pasteEnter);
  });

  it("given_an_original_pane_and_an_active_split_when_restart_runs_then_every_tmux_call_targets_the_original_pane_id", async () => {
    const { h } = await succeeds({ paneCwd: CWD });

    expect(h.targets.length).toBeGreaterThan(4);
    expect(new Set(h.targets)).toEqual(new Set([PANE]));
    expect(h.targets).not.toContain(SPLIT_PANE);
  });

  it("given_an_agent_cwd_from_lsof_when_restart_runs_then_it_reads_the_agent_process_not_the_active_pane", async () => {
    const { h } = await succeeds({ cwd: "/Users/example/repo" });

    expect(h.cwdPids).toContain(301);
  });

  it("given_the_pane_shell_in_another_directory_when_relaunching_then_the_command_is_prefixed_with_a_cd", async () => {
    const { h } = await succeeds({ paneCwd: "/Users/example/elsewhere" });

    expect(h.envSets[0].value.startsWith(`cd -- '${CWD}' && `)).toBe(true);
  });

  it("given_the_pane_shell_already_in_the_agent_cwd_when_relaunching_then_no_cd_is_added", async () => {
    const { h } = await succeeds({ paneCwd: CWD });

    expect(h.envSets[0].value).not.toContain("cd --");
  });

  it("given_a_settings_json_when_relaunching_then_no_typed_text_contains_it_and_it_travels_only_through_the_environment", async () => {
    const { h } = await succeeds();

    for (const text of h.texts) {
      expect(text).not.toContain("statusLine");
      expect(text).not.toContain(FAKE_TOKEN);
    }
    expect(h.envSets[0].value).toContain(SETTINGS.replace(/'/g, "'\\''"));
  });

  it("given_a_session_without_hook_state_when_restart_requested_then_no_state_is_reported_with_zero_keys", async () => {
    const { h } = await refused({ state: null }, "no-state");
    expect(h.nothingSent()).toBe(true);
  });
});

describe("restartClaudeSession: session id precedence", () => {
  const ids = { snapshotId: SNAPSHOT_ID, transcriptId: TRANSCRIPT_ID, instance: { sessionId: INSTANCE_SESSION_ID } };

  it("given_every_source_when_resolving_then_the_state_file_id_wins", async () => {
    const { result, h } = await succeeds({ ...ids });

    expect(result.sessionId).toBe(STATE_ID);
    expect(h.envSets[0].value).toContain(STATE_ID);
  });

  it("given_no_state_file_id_when_resolving_then_the_live_snapshot_wins", async () => {
    const { result } = await succeeds({ ...ids, stateSessionId: null });
    expect(result.sessionId).toBe(SNAPSHOT_ID);
  });

  it("given_no_snapshot_when_resolving_then_the_instance_id_is_used_only_for_the_same_profile", async () => {
    const { result } = await succeeds({ ...ids, stateSessionId: null, snapshotId: null });
    expect(result.sessionId).toBe(INSTANCE_SESSION_ID);
  });

  it("given_an_instance_id_of_another_profile_when_resolving_then_it_is_skipped_for_the_transcript", async () => {
    const { result } = await succeeds({
      ...ids,
      stateSessionId: null,
      snapshotId: null,
      instance: { sessionId: INSTANCE_SESSION_ID, configDir: "/Users/example/.claude-in" },
      paneJobArgs: PS_ARGS,
    });
    expect(result.sessionId).toBe(TRANSCRIPT_ID);
  });

  it("given_an_instance_without_a_config_dir_when_resolving_then_its_id_never_matches_the_profile", async () => {
    const { result } = await succeeds({
      ...ids,
      stateSessionId: null,
      snapshotId: null,
      instance: { sessionId: INSTANCE_SESSION_ID, configDir: undefined },
    });
    expect(result.sessionId).toBe(TRANSCRIPT_ID);
  });

  it("given_only_a_transcript_when_resolving_then_the_reader_gets_the_explicit_profile_dir_and_the_agent_cwd", async () => {
    const { h, result } = await succeeds({ stateSessionId: null, transcriptId: TRANSCRIPT_ID });

    expect(result.sessionId).toBe(TRANSCRIPT_ID);
    expect(h.pickTranscript).toHaveBeenCalledWith(PROFILE, CWD, expect.any(Set));
  });

  it("given_an_unset_profile_when_resolving_the_transcript_then_the_default_profile_dir_is_passed", async () => {
    const { h } = await succeeds({
      stateSessionId: null,
      transcriptId: TRANSCRIPT_ID,
      environment: { configDir: { kind: "unset" }, hasInstanceId: true },
    });

    expect(h.pickTranscript).toHaveBeenCalledWith(path.join(os.homedir(), ".claude"), CWD, expect.any(Set));
  });

  it("given_an_unreadable_profile_when_no_other_id_exists_then_the_transcript_reader_is_never_called", async () => {
    const { h, error } = await refused(
      { stateSessionId: null, transcriptId: TRANSCRIPT_ID, environment: { configDir: { kind: "unreadable" }, hasInstanceId: true } },
      "missing"
    );

    expect(error.missing).toEqual(["sessionId"]);
    expect(h.pickTranscript).not.toHaveBeenCalled();
    expect(h.noRelaunch()).toBe(true);
  });

  it.each(["short", "--evil-flag-xx", "has space in id"])("given_the_invalid_state_file_id_%s_when_resolving_then_it_is_ignored", async (badId) => {
    const { result } = await succeeds({ stateSessionId: badId, snapshotId: SNAPSHOT_ID });
    expect(result.sessionId).toBe(SNAPSHOT_ID);
  });
});

describe("restartClaudeSession: command sources and the exit hint", () => {
  const unparseableArgs = "/bin/bash /Users/example/bin/claude-me --model x stray-prompt-word";

  it("given_args_ps_cannot_be_parsed_when_the_launcher_matches_the_instance_then_the_instance_builder_is_used", async () => {
    const { h, result } = await succeeds({ paneJobArgs: unparseableArgs });

    expect(result.commandSource).toBe("instance");
    expect(h.envSets[0].value).toBe(`INSTANCE_BUILDER ${STATE_ID}`);
  });

  it("given_a_launcher_that_only_shares_a_prefix_with_the_instance_command_then_the_builder_is_not_used", async () => {
    const { h } = await refused({ paneJobArgs: unparseableArgs, instance: { command: "claude" } }, "missing");
    expect(h.noRelaunch()).toBe(true);
  });

  it("given_an_instance_profile_that_differs_from_the_running_one_then_the_builder_is_not_used", async () => {
    const { h } = await refused({ paneJobArgs: unparseableArgs, instance: { configDir: "/Users/example/.claude-in" } }, "missing");
    expect(h.noRelaunch()).toBe(true);
  });

  it("given_no_parseable_args_and_a_hint_with_a_command_when_the_profile_is_set_then_the_hint_command_is_used_with_the_profile_prefix", async () => {
    const { h, result } = await succeeds({
      paneJobArgs: unparseableArgs,
      instance: { command: "claude-in" },
      exitScreen: exitWithHint(`claude --resume ${HINT_ID}`),
      stateSessionId: null,
    });

    expect(result.commandSource).toBe("hint");
    expect(h.envSets[0].value).toContain("CLAUDE_CONFIG_DIR='/Users/example/.claude-me'");
    expect(h.envSets[0].value).toContain(`--resume '${HINT_ID}'`);
    expect(h.envSets[0].value).not.toContain("AI_MULTI_INSTANCE_ID");
  });

  it("given_a_hint_command_when_the_profile_is_unset_then_no_config_dir_is_prefixed", async () => {
    const { h } = await succeeds({
      paneJobArgs: unparseableArgs,
      instance: { command: "claude-in" },
      exitScreen: exitWithHint(`claude --resume ${HINT_ID}`),
      stateSessionId: null,
      environment: { configDir: { kind: "unset" }, hasInstanceId: false },
    });

    expect(h.envSets[0].value).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("given_an_unreadable_profile_when_only_a_hint_command_exists_then_it_is_refused_and_pane_stays_at_the_shell", async () => {
    const { h, error } = await refused(
      {
        paneJobArgs: unparseableArgs,
        instance: { command: "claude-in" },
        exitScreen: exitWithHint(`claude --resume ${HINT_ID}`),
        environment: { configDir: { kind: "unreadable" }, hasInstanceId: true },
      },
      "missing"
    );

    expect(error.missing).toContain("command");
    expect(h.noRelaunch()).toBe(true);
  });

  it("given_a_bare_claude_launcher_when_the_profile_is_unreadable_then_the_ps_command_is_refused_too", async () => {
    const { h, error } = await refused(
      { paneJobArgs: "claude --model x", instance: { command: "claude" }, environment: { configDir: { kind: "unreadable" }, hasInstanceId: true } },
      "missing"
    );

    expect(error.missing).toContain("command");
    expect(h.noRelaunch()).toBe(true);
  });

  it("given_a_ps_command_without_the_instance_id_in_the_environment_then_the_instance_id_is_not_added", async () => {
    const { h } = await succeeds({ environment: { configDir: { kind: "set", dir: PROFILE }, hasInstanceId: false } });

    expect(h.envSets[0].value).not.toContain("AI_MULTI_INSTANCE_ID");
  });

  it("given_a_replaced_resume_flag_in_the_original_command_then_only_the_new_id_is_in_the_relaunch", async () => {
    const { h } = await succeeds({ paneJobArgs: PS_ARGS.replace("--model", "--resume abcdef12-0000 --model") });

    expect(h.envSets[0].value).not.toContain("abcdef12-0000");
    expect(h.envSets[0].value.match(/--resume/g)).toHaveLength(1);
  });

  it("given_a_fresh_hint_and_only_a_weaker_id_when_exiting_then_the_hint_id_wins_and_both_are_reported", async () => {
    const { h, result } = await succeeds({
      stateSessionId: null,
      instance: { sessionId: INSTANCE_SESSION_ID },
      exitScreen: exitWithHint(`claude-me --resume ${HINT_ID}`),
    });

    expect(result.sessionId).toBe(HINT_ID);
    expect(result.replacedSessionId).toBe(INSTANCE_SESSION_ID);
    expect(h.envSets[0].value).toContain(`--resume '${HINT_ID}'`);
  });

  it("given_a_transcript_id_and_a_fresh_hint_when_exiting_then_the_hint_id_wins", async () => {
    const { result } = await succeeds({
      stateSessionId: null,
      transcriptId: TRANSCRIPT_ID,
      exitScreen: exitWithHint(`claude-me --resume ${HINT_ID}`),
    });

    expect(result.sessionId).toBe(HINT_ID);
    expect(result.replacedSessionId).toBe(TRANSCRIPT_ID);
  });

  it("given_a_state_file_id_and_a_different_hint_id_when_exiting_then_the_state_id_wins_and_the_hint_id_is_reported", async () => {
    const { h, result } = await succeeds({ exitScreen: exitWithHint(`claude-me --resume ${HINT_ID}`) });

    expect(result.sessionId).toBe(STATE_ID);
    expect(result.hintSessionId).toBe(HINT_ID);
    expect(h.envSets[0].value).toContain(`--resume '${STATE_ID}'`);
    expect(h.envSets[0].value).not.toContain(HINT_ID);
  });

  it("given_a_hint_that_was_already_on_screen_before_exit_when_exiting_then_it_is_stale_and_ignored", async () => {
    const scrollback = `❯ /exit\nResume this session with:\nclaude --resume ${OLD_HINT_ID}\n$ claude\n`;
    const preScreen = `${scrollback}${screen("default")}`;

    const { h, error } = await refused({ stateSessionId: null, preScreen, exitScreen: preScreen }, "missing");

    expect(error.missing).toEqual(["sessionId"]);
    expect(h.noRelaunch()).toBe(true);
  });

  it("given_no_command_and_no_id_when_exiting_then_nothing_is_relaunched_and_the_error_names_both", async () => {
    const { h, error } = await refused(
      { paneJobArgs: unparseableArgs, instance: { command: "claude-in" }, stateSessionId: null },
      "missing"
    );

    expect([...(error.missing ?? [])].sort()).toEqual(["command", "sessionId"]);
    expect(h.noRelaunch()).toBe(true);
    expect(h.events).not.toContain(`text:${LOADER_LINE}`);
    expect(error.message).toContain("launch command");
    expect(error.message).toContain("session id");
  });

  it("given_only_the_command_missing_then_the_message_names_the_command_and_not_the_id", async () => {
    const { error } = await refused({ paneJobArgs: unparseableArgs, instance: { command: "claude-in" } }, "missing");

    expect(error.message).toContain("launch command");
    expect(error.message).not.toContain("session id");
  });

  it("given_only_the_id_missing_then_the_message_names_the_id_and_not_the_command", async () => {
    const { error } = await refused({ stateSessionId: null }, "missing");

    expect(error.message).toContain("session id");
    expect(error.message).not.toContain("launch command");
  });
});

describe("restartClaudeSession: exit and relaunch verification", () => {
  it("given_claude_that_never_exits_when_restart_runs_then_it_times_out_after_20s_without_relaunching_and_names_the_exit_text", async () => {
    const { h, error } = await refused({ exitDelayMs: 60_000 }, "exit-timeout");

    expect(error.message).toMatch(/\/exit/);
    expect(h.noRelaunch()).toBe(true);
    expect(h.clock() - 1_000_000).toBeLessThan(30_000);
  });

  it("given_a_wrapper_that_lingers_in_the_foreground_when_claude_exits_then_no_loader_is_sent_and_a_timeout_is_reported", async () => {
    const { h } = await refused({ lingeringWrapper: true }, "exit-timeout");

    expect(h.noRelaunch()).toBe(true);
    expect(h.events).not.toContain(`text:${LOADER_LINE}`);
  });

  it("given_a_new_process_alive_after_four_seconds_when_verifying_then_success_is_reported", async () => {
    const { h, result } = await succeeds();

    expect(result.ok).toBe(true);
    expect(h.clock() - (h.relaunchAt() ?? 0)).toBeGreaterThanOrEqual(4000);
  });

  it("given_a_new_process_that_dies_within_three_seconds_when_verifying_then_it_is_an_error_not_a_success", async () => {
    const { error } = await refused({ dieAfterMs: 2000 }, "relaunch-failed");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("given_a_poll_that_times_out_after_the_relaunch_was_sent_then_the_error_carries_relaunch_sent_and_does_not_invite_a_blind_retry", async () => {
    const { error } = await refused({ startDelayMs: 90_000 }, "relaunch-timeout");

    expect(error.relaunchSent).toBe(true);
    expect(error.message).toMatch(/may be starting/i);
    expect(error.message).not.toMatch(/try again|please retry|retry now/i);
  });

  it("given_a_probe_that_is_unknown_while_the_session_is_absent_then_session_gone_is_reported", async () => {
    const { h } = await refused({ unknownProbeMs: 60_000, presence: "absent" }, "session-gone");
    expect(h.envSets).toHaveLength(1);
  });

  it("given_a_probe_that_is_unknown_while_the_session_is_present_then_it_keeps_polling_and_succeeds", async () => {
    const { result } = await succeeds({ unknownProbeMs: 2000, presence: "present" });
    expect(result.ok).toBe(true);
  });

  it("given_the_original_pane_id_changing_after_exit_then_session_gone_and_no_loader_is_sent", async () => {
    const { h } = await refused({ paneIdAfterExit: "%5" }, "session-gone");

    expect(h.noRelaunch()).toBe(true);
    expect(h.events).not.toContain(`text:${LOADER_LINE}`);
  });

  it("given_the_original_pane_id_changing_after_relaunch_then_a_surviving_split_never_looks_like_success", async () => {
    await refused({ paneIdAfterRelaunch: "%5" }, "session-gone");
  });

  it("given_versions_that_cannot_be_derived_when_restart_succeeds_then_they_are_null", async () => {
    const { result } = await succeeds({ deps: { readAgentArgs: async () => "claude --model x" } });

    expect(result.versionBefore).toBeNull();
    expect(result.versionAfter).toBeNull();
  });
});

describe("restartClaudeSession: auto mode after relaunch", () => {
  it("given_auto_before_when_the_new_session_starts_elsewhere_then_shift_tab_is_pressed_until_auto_shows", async () => {
    const { h, result } = await succeeds({ preMode: "auto", startMode: "default", btabSequence: ["accept-edits", "auto"] });

    expect(h.keys).toEqual(["BTab", "BTab"]);
    expect(result.autoMode).toBe("on");
  });

  it("given_auto_before_and_auto_already_showing_after_relaunch_then_no_key_is_pressed", async () => {
    const { h, result } = await succeeds({ preMode: "auto", startMode: "auto" });

    expect(h.keys).toEqual([]);
    expect(result.autoMode).toBe("on");
  });

  it("given_a_mode_other_than_auto_before_then_no_key_is_pressed_and_auto_is_not_applicable", async () => {
    const { h, result } = await succeeds({ preMode: "plan", startMode: "plan" });

    expect(h.keys).toEqual([]);
    expect(result.autoMode).toBe("not-applicable");
  });

  it("given_auto_never_appearing_then_it_stops_at_eight_presses_and_reports_unconfirmed_with_the_current_mode", async () => {
    const { h, result } = await succeeds({ preMode: "auto", startMode: "plan", btabSequence: ["accept-edits", "bypass"] });

    expect(h.keys).toHaveLength(8);
    expect(result.autoMode).toBe("unconfirmed");
    expect(result.currentMode).toBe("bypass");
  });

  it("given_a_cycle_without_auto_then_it_stops_when_the_starting_mode_returns_and_reports_unconfirmed", async () => {
    const { h, result } = await succeeds({ preMode: "auto", startMode: "default", btabSequence: ["accept-edits", "plan", "bypass", "default"] });

    expect(h.keys).toHaveLength(4);
    expect(result.autoMode).toBe("unconfirmed");
    expect(result.currentMode).toBe("default");
  });

  it("given_an_unknown_starting_mode_then_zero_presses_are_sent_and_auto_is_unconfirmed", async () => {
    const { h, result } = await succeeds({ preMode: "auto", startMode: "unknown" });

    expect(h.keys).toEqual([]);
    expect(result.autoMode).toBe("unconfirmed");
    expect(result.currentMode).toBe("unknown");
  });

  it("given_a_fault_while_restoring_auto_after_the_relaunch_then_the_restart_still_succeeds_as_unconfirmed", async () => {
    const { result } = await succeeds({
      preMode: "auto",
      startMode: "default",
      deps: {
        sendKey: async () => {
          throw new Error("tmux exploded with /secret/detail");
        },
      },
    });

    expect(result.autoMode).toBe("unconfirmed");
    expect(result.currentMode).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("given_a_failed_initial_pane_lookup_then_it_is_refused_as_session_gone", async () => {
    const { h } = await refused(
      {
        deps: {
          getOriginalPaneId: async () => {
            throw new Error("no such session");
          },
        },
      },
      "session-gone"
    );

    expect(h.nothingSent()).toBe(true);
  });

  it("given_two_presses_then_each_press_sits_in_its_own_short_lock_section_after_the_three_restart_sections", async () => {
    const { h } = await succeeds({ preMode: "auto", startMode: "default", btabSequence: ["accept-edits", "auto"] });

    const sections = lockSections(h.events);

    expect(sections).toHaveLength(5);
    for (const section of sections.slice(3)) {
      expect(section).toContain("key:BTab");
      expect(section).not.toContain("probe");
      expect(section.some((event) => event.startsWith("sleep:"))).toBe(false);
    }
  });
});

describe("restartClaudeSession: environment cleanup", () => {
  const failure = (): Error => new Error("send failed");

  it("given_set_environment_failing_then_the_variable_is_unset_best_effort", async () => {
    const { h } = await outcome({ failSetEnvironment: failure() });
    expect(h.unsets).toEqual(["AI_LAUNCH_COMMAND"]);
  });

  it("given_the_loader_text_send_failing_then_the_variable_is_unset", async () => {
    const { h, error } = await outcome({ failLoaderText: failure() });

    expect(error).not.toBeNull();
    expect(h.unsets).toEqual(["AI_LAUNCH_COMMAND"]);
  });

  it("given_the_loader_enter_failing_for_certain_then_the_variable_is_unset_and_the_error_says_the_line_remains_in_the_prompt", async () => {
    const { h, error } = await outcome({ failLoaderEnter: Object.assign(failure(), { killed: false }) });

    expect(h.unsets).toEqual(["AI_LAUNCH_COMMAND"]);
    expect(error?.message).toMatch(/prompt/i);
  });

  it("given_the_loader_enter_timing_out_then_the_variable_is_kept_because_the_loader_may_have_read_it", async () => {
    const { h } = await outcome({ failLoaderEnter: Object.assign(failure(), { killed: true }) });
    expect(h.unsets).toEqual([]);
  });

  it("given_a_clean_restart_then_nothing_is_unset", async () => {
    const { h } = await succeeds();
    expect(h.unsets).toEqual([]);
  });
});

describe("restartClaudeSession: the command never leaks", () => {
  function secretError(): Error {
    return Object.assign(new Error(`tmux send-keys ${FAKE_TOKEN} failed`), { stdout: `env ${FAKE_TOKEN}`, stderr: FAKE_TOKEN, cmd: [FAKE_TOKEN] });
  }

  function expectNoToken(h: Harness, result: RestartResult | null, error: Error | null): void {
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    if (error !== null) {
      expect(error.message).not.toContain(FAKE_TOKEN);
      expect(String(error)).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);
    }
    for (const line of h.logs) expect(line).not.toContain(FAKE_TOKEN);
    for (const text of h.texts) expect(text).not.toContain(FAKE_TOKEN);
  }

  it("given_a_secret_in_the_settings_when_restart_succeeds_then_no_result_log_or_typed_text_contains_it", async () => {
    const { h, result } = await succeeds();

    expectNoToken(h, result, null);
    expect(h.logs.every((line) => line.length < 200)).toBe(true);
  });

  it.each([
    ["set-environment", { failSetEnvironment: secretError() }],
    ["the loader text", { failLoaderText: secretError() }],
    ["the loader enter", { failLoaderEnter: secretError() }],
    ["the environment read", { deps: { readAgentEnvironment: async () => Promise.reject(secretError()) } }],
    ["the screen capture", { deps: { capturePane: async () => Promise.reject(secretError()) } }],
    ["the process probe", { deps: { probePane: async () => Promise.reject(secretError()) } }],
  ] as [string, World][])("given_a_tmux_or_ps_error_carrying_argv_from_%s_then_no_error_log_or_result_repeats_it", async (_name, world) => {
    const { h, result, error } = await outcome(world);

    expectNoToken(h, result, error);
  });
});

describe("handleRestartRequest and restartErrorStatus", () => {
  const instance = baseInstance();
  const okResult: RestartResult = { ok: true, sessionId: STATE_ID, versionBefore: null, versionAfter: null, autoMode: "not-applicable", commandSource: "process" };

  function handlerDeps(restart: (target: InstanceRecord) => Promise<RestartResult>, loadInstance: (id: string) => Promise<InstanceRecord | undefined> = async () => instance) {
    const logs: string[] = [];
    return { logs, deps: { loadInstance, restart, log: (line: string) => logs.push(line) } };
  }

  it("given_an_unknown_instance_then_404_and_restart_is_not_called", async () => {
    const restart = vi.fn(async () => okResult);
    const { deps } = handlerDeps(restart, async () => undefined);

    const response = await handleRestartRequest("missing", deps);

    expect(response.status).toBe(404);
    expect(restart).not.toHaveBeenCalled();
  });

  it("given_a_successful_restart_then_200_with_the_result_and_one_fixed_log_line", async () => {
    const { deps, logs } = handlerDeps(async () => okResult);

    const response = await handleRestartRequest("abc123", deps);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, sessionId: STATE_ID });
    expect(logs).toEqual(["restart abc123 ok"]);
  });

  it("given_a_restart_error_then_the_status_comes_from_the_mapper_and_the_body_carries_the_fixed_fields", async () => {
    const { deps, logs } = handlerDeps(async () => {
      throw new RestartError("missing", "Could not relaunch: no session id", { missing: ["sessionId"] });
    });

    const response = await handleRestartRequest("abc123", deps);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: "missing", missing: ["sessionId"], error: "Could not relaunch: no session id" });
    expect(logs).toEqual(["restart abc123 missing"]);
  });

  it("given_a_relaunch_timeout_then_the_body_carries_relaunch_sent", async () => {
    const { deps } = handlerDeps(async () => {
      throw new RestartError("relaunch-timeout", "The relaunch may be starting", { relaunchSent: true });
    });

    const response = await handleRestartRequest("abc123", deps);

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ relaunchSent: true });
  });

  it("given_an_unexpected_error_carrying_a_secret_then_500_with_fixed_text_and_the_message_is_never_logged", async () => {
    const { deps, logs } = handlerDeps(async () => {
      throw Object.assign(new Error(`boom ${FAKE_TOKEN}`), { stdout: FAKE_TOKEN });
    });

    const response = await handleRestartRequest("abc123", deps);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(FAKE_TOKEN);
    expect(logs).toEqual(["restart abc123 error"]);
  });

  it("given_a_second_concurrent_request_then_it_gets_409_and_the_first_stays_in_progress_until_it_finishes", async () => {
    let finishFirst: (result: RestartResult) => void = () => undefined;
    const restart = vi.fn(() => new Promise<RestartResult>((resolve) => (finishFirst = resolve)));
    const { deps } = handlerDeps(restart);

    const first = handleRestartRequest("abc123", deps);
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(isRestartInProgress(SESSION)).toBe(true);

    const second = await handleRestartRequest("abc123", deps);

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: "restart-in-progress" });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(isRestartInProgress(SESSION)).toBe(true);

    finishFirst(okResult);
    expect((await first).status).toBe(200);
    expect(isRestartInProgress(SESSION)).toBe(false);
  });

  it("given_a_restart_that_throws_then_the_in_progress_flag_is_cleared", async () => {
    const { deps } = handlerDeps(async () => {
      throw new Error("boom");
    });

    await handleRestartRequest("abc123", deps);

    expect(isRestartInProgress(SESSION)).toBe(false);
  });

  it("given_a_restart_error_then_the_in_progress_flag_is_cleared", async () => {
    const { deps } = handlerDeps(async () => {
      throw new RestartError("busy", "The session is busy");
    });

    await handleRestartRequest("abc123", deps);

    expect(isRestartInProgress(SESSION)).toBe(false);
  });

  it("given_the_handler_deps_then_it_needs_no_lock_and_cannot_deadlock_on_the_plain_session_key", async () => {
    // withSessionLock is not reentrant: if the handler took the plain key, the restart inside would hang.
    const { deps } = handlerDeps(() => withSessionLock(SESSION, async () => okResult));

    const response = await handleRestartRequest("abc123", deps);

    expect(response.status).toBe(200);
  });

  it.each([
    ["not-found", 404],
    ["busy", 409],
    ["input-not-empty", 409],
    ["client-active", 409],
    ["session-gone", 409],
    ["restart-in-progress", 409],
    ["shell-is-agent", 422],
    ["no-agent", 422],
    ["missing", 422],
    ["no-state", 422],
    ["exit-timeout", 502],
    ["relaunch-timeout", 502],
    ["relaunch-failed", 502],
  ] as [RestartErrorCode, number][])("maps the error code %s to status %i", (code, status) => {
    expect(restartErrorStatus(code)).toBe(status);
  });

  it("builds a RestartError that carries its code and extras", () => {
    const error = new RestartError("missing", "nothing to relaunch", { missing: ["command", "sessionId"], relaunchSent: false });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("missing");
    expect(error.missing).toEqual(["command", "sessionId"]);
    expect(error.relaunchSent).toBe(false);
  });
});
