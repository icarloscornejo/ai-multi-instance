import { describe, expect, it } from "vitest";
import { quoteForShell } from "./providers";
import {
  buildRestartCommand,
  currentMode,
  isAutoModeOn,
  isPromptEmpty,
  looksBusy,
  parseResumeHint,
  sanitizeError,
  stripResumeFlags,
  tokenizeCommandLine,
  versionFromPath,
  type ScreenMode,
} from "./restartCommand";

const SESSION_ID = "0198aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const FAKE_TOKEN: string = String("faketoken_for_tests_0123456789abcdef");
const SETTINGS = String.raw`{"statusLine":{"type":"command","command":"/Users/example/line.sh"},"hooks":{"Stop":[{"command":"say \"hi {there}\" now"}]}}`;

describe("tokenizeCommandLine", () => {
  it("keeps a --settings JSON with nested braces, spaces and escaped quotes as ONE token", () => {
    const flat = `/bin/bash /Users/example/bin/claude-me --model opusplan --effort medium --settings ${SETTINGS} -n Auto-MI`;

    expect(tokenizeCommandLine(flat)).toEqual([
      "/bin/bash",
      "/Users/example/bin/claude-me",
      "--model",
      "opusplan",
      "--effort",
      "medium",
      "--settings",
      SETTINGS,
      "-n",
      "Auto-MI",
    ]);
  });

  it("keeps a brace inside a JSON string from unbalancing the value", () => {
    const json = String.raw`{"a":"close } and \" quote","b":{"c":"x y"}}`;

    expect(tokenizeCommandLine(`claude --settings ${json} --model x`)).toEqual(["claude", "--settings", json, "--model", "x"]);
  });

  it("returns null for unbalanced JSON", () => {
    expect(tokenizeCommandLine(`claude --settings {"a":{"b":1} --model x`)).toBeNull();
  });

  it("accepts a multi-word name only when it equals the known label", () => {
    expect(tokenizeCommandLine("claude -n My Session --model x", "My Session")).toEqual(["claude", "-n", "My Session", "--model", "x"]);
    expect(tokenizeCommandLine("claude -n My Session --model x", "Other Label")).toBeNull();
    expect(tokenizeCommandLine("claude -n My Session --model x")).toBeNull();
  });

  it("accepts a single-word name with or without a label", () => {
    expect(tokenizeCommandLine("claude -n Auto-MI")).toEqual(["claude", "-n", "Auto-MI"]);
    expect(tokenizeCommandLine("claude --name Auto-MI", "Auto-MI")).toEqual(["claude", "--name", "Auto-MI"]);
  });

  it("accepts a label that contains a lone dash word", () => {
    expect(tokenizeCommandLine("claude -n Fix - login --model x", "Fix - login")).toEqual(["claude", "-n", "Fix - login", "--model", "x"]);
  });

  it.each(["claude-me", "claude-in", "claude-oto", "claude-tm"])("parses the launcher %s in bash, node and bare forms", (launcher) => {
    for (const prefix of ["/bin/bash /Users/example/bin/", "node /Users/example/bin/", "/Users/example/bin/", ""]) {
      const flat = `${prefix}${launcher} --model opusplan`;
      expect(tokenizeCommandLine(flat)).toEqual(flat.split(" "));
    }
  });

  it("parses plain claude in bare form", () => {
    expect(tokenizeCommandLine("claude --model opusplan --effort low")).toEqual(["claude", "--model", "opusplan", "--effort", "low"]);
  });

  it("accepts the other value-taking flags of the allow-list", () => {
    const flat = "claude --permission-mode plan --add-dir /Users/example/extra --mcp-config /Users/example/mcp.json";
    expect(tokenizeCommandLine(flat)).toEqual(flat.split(" "));
  });

  it.each([
    ["a stray positional word", "/bin/bash /Users/example/bin/claude-me stray"],
    ["an initial prompt after the launcher", "claude fix the failing test"],
    ["a word after a non-value flag", "claude --verbose hello"],
    ["a word after another non-value flag", "/bin/bash /Users/example/bin/claude-me --dangerously-skip-permissions continue"],
    ["a double space inside a value", `claude --settings {"a":"x  y"} --model x`],
  ])("returns null for %s", (_name, flat) => {
    expect(tokenizeCommandLine(flat)).toBeNull();
  });

  it("parses a command that already carries --resume, so the id can be replaced", () => {
    const flat = `/bin/bash /Users/example/bin/claude-me --resume abcdef12 --model x --settings ${SETTINGS} -n Label`;

    const tokens = tokenizeCommandLine(flat);

    expect(tokens).not.toBeNull();
    expect(stripResumeFlags(tokens as string[])).toEqual([
      "/bin/bash",
      "/Users/example/bin/claude-me",
      "--model",
      "x",
      "--settings",
      SETTINGS,
      "-n",
      "Label",
    ]);
  });

  it.each([
    ["--resume=abcdef12", ["claude", "--resume=abcdef12"]],
    ["-r abcdef12", ["claude", "-r", "abcdef12"]],
    ["--continue", ["claude", "--continue"]],
    ["-c", ["claude", "-c"]],
    ["--session-id abcdef12", ["claude", "--session-id", "abcdef12"]],
    ["--session-id=abcdef12", ["claude", "--session-id=abcdef12"]],
  ])("tokenizes the resume form %s", (flagText, expected) => {
    expect(tokenizeCommandLine(`claude ${flagText}`)).toEqual(expected);
  });

  it("never lets a bare resume flag swallow the next flag", () => {
    expect(tokenizeCommandLine("claude --resume --dangerously-skip-permissions")).toEqual(["claude", "--resume", "--dangerously-skip-permissions"]);
    expect(tokenizeCommandLine("claude -r --verbose")).toEqual(["claude", "-r", "--verbose"]);
    expect(tokenizeCommandLine(`claude --session-id --settings ${SETTINGS}`)).toEqual(["claude", "--session-id", "--settings", SETTINGS]);
  });

  it("returns null for a resume value that is too short to be an id", () => {
    expect(tokenizeCommandLine("claude --resume abc")).toBeNull();
  });
});

describe("stripResumeFlags", () => {
  it.each([
    ["--resume X", ["claude", "--resume", "abcdef12", "--model", "x"], ["claude", "--model", "x"]],
    ["--resume=X", ["claude", "--resume=abcdef12", "--model", "x"], ["claude", "--model", "x"]],
    ["-r X", ["claude", "-r", "abcdef12", "--model", "x"], ["claude", "--model", "x"]],
    ["--continue", ["claude", "--continue", "--model", "x"], ["claude", "--model", "x"]],
    ["-c", ["claude", "-c", "--model", "x"], ["claude", "--model", "x"]],
    ["--session-id X", ["claude", "--session-id", "abcdef12", "--model", "x"], ["claude", "--model", "x"]],
    ["--session-id=X", ["claude", "--session-id=abcdef12", "--model", "x"], ["claude", "--model", "x"]],
    ["bare --resume before a flag", ["claude", "--resume", "--verbose"], ["claude", "--verbose"]],
    ["bare -r before a flag", ["claude", "-r", "--verbose"], ["claude", "--verbose"]],
    ["bare --session-id before a flag", ["claude", "--session-id", "--verbose"], ["claude", "--verbose"]],
    ["bare --resume at the end", ["claude", "--model", "x", "--resume"], ["claude", "--model", "x"]],
  ])("removes %s", (_name, tokens, expected) => {
    expect(stripResumeFlags(tokens)).toEqual(expected);
  });

  it("leaves a command without resume flags untouched and does not mutate the input", () => {
    const tokens = ["claude", "--model", "x"];

    expect(stripResumeFlags(tokens)).toEqual(["claude", "--model", "x"]);
    expect(tokens).toEqual(["claude", "--model", "x"]);
  });
});

describe("buildRestartCommand", () => {
  const tokens = ["/bin/bash", "/Users/example/bin/claude-me", "--model", "opusplan", "--settings", SETTINGS, "-n", "Auto-MI"];

  it("appends --resume with the quoted id and quotes the settings JSON as one word", () => {
    const command = buildRestartCommand({ instanceId: "abc123", includeInstanceId: false, configDir: undefined, tokens, sessionId: SESSION_ID });

    expect(command.endsWith(` --resume '${SESSION_ID}'`)).toBe(true);
    expect(command).toContain(quoteForShell(SETTINGS));
  });

  it("adds AI_MULTI_INSTANCE_ID only when asked to", () => {
    const withId = buildRestartCommand({ instanceId: "abc123", includeInstanceId: true, configDir: undefined, tokens, sessionId: SESSION_ID });
    const withoutId = buildRestartCommand({ instanceId: "abc123", includeInstanceId: false, configDir: undefined, tokens, sessionId: SESSION_ID });

    expect(withId.startsWith("AI_MULTI_INSTANCE_ID='abc123' ")).toBe(true);
    expect(withoutId).not.toContain("AI_MULTI_INSTANCE_ID");
  });

  it("adds CLAUDE_CONFIG_DIR only when a profile is set", () => {
    const withProfile = buildRestartCommand({ instanceId: "abc123", includeInstanceId: false, configDir: "/Users/example/.claude-me", tokens, sessionId: SESSION_ID });
    const withoutProfile = buildRestartCommand({ instanceId: "abc123", includeInstanceId: false, configDir: undefined, tokens, sessionId: SESSION_ID });

    expect(withProfile.startsWith("CLAUDE_CONFIG_DIR='/Users/example/.claude-me' ")).toBe(true);
    expect(withoutProfile).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("puts the instance id before the config dir when both are present", () => {
    const command = buildRestartCommand({ instanceId: "abc123", includeInstanceId: true, configDir: "/Users/example/.claude-me", tokens, sessionId: SESSION_ID });

    expect(command.startsWith("AI_MULTI_INSTANCE_ID='abc123' CLAUDE_CONFIG_DIR='/Users/example/.claude-me' ")).toBe(true);
  });

  it("refuses an id that could carry shell syntax or a flag", () => {
    for (const sessionId of ["bad id; rm -rf x", "--help-flag-1", "short", "id'quote-12345"]) {
      expect(() => buildRestartCommand({ instanceId: "abc123", includeInstanceId: false, configDir: undefined, tokens, sessionId })).toThrow();
    }
  });

  it("is idempotent: flattening the output like ps does and re-parsing gives the same tokens", () => {
    const command = buildRestartCommand({ instanceId: "abc123", includeInstanceId: false, configDir: undefined, tokens, sessionId: SESSION_ID });
    // ps prints argv without any shell quoting.
    const flat = command.replace(/'\\''/g, "\u0000").replace(/'/g, "").replace(/\u0000/g, "'");

    const reparsed = tokenizeCommandLine(flat, "Auto-MI");

    expect(reparsed).toEqual([...tokens, "--resume", SESSION_ID]);
    expect(stripResumeFlags(reparsed as string[])).toEqual(tokens);
  });
});

describe("parseResumeHint", () => {
  it("reads the id and the launcher printed in front of --resume", () => {
    const text = `❯ /exit\n  ⎿  Bye!\n\nResume this session with:\nclaude --resume ${SESSION_ID}\n$ `;

    expect(parseResumeHint(text)).toEqual({ sessionId: SESSION_ID, command: "claude" });
  });

  it("reads a launcher other than claude and a long path in front of the flag", () => {
    const text = `❯ /exit\nResume this session with:\n/Users/example/projects/some/deep/folder/bin/claude-me --model opusplan --resume ${SESSION_ID}\n`;

    expect(parseResumeHint(text)).toEqual({
      sessionId: SESSION_ID,
      command: "/Users/example/projects/some/deep/folder/bin/claude-me --model opusplan",
    });
  });

  it("reports a null command when only the flag and id are printed", () => {
    expect(parseResumeHint(`❯ /exit\n--resume ${SESSION_ID}\n`)).toEqual({ sessionId: SESSION_ID, command: null });
  });

  it("ignores ANSI escape noise around the hint", () => {
    const text = `\u001b[2m❯ /exit\u001b[0m\n\u001b[2mResume this session with:\u001b[0m\n\u001b[1mclaude --resume ${SESSION_ID}\u001b[0m\n`;

    expect(parseResumeHint(text)).toEqual({ sessionId: SESSION_ID, command: "claude" });
  });

  it("returns null when there is no hint after the /exit marker", () => {
    expect(parseResumeHint("❯ /exit\n$ \n")).toBeNull();
  });

  it("ignores a hint that sits before the last /exit marker", () => {
    const text = `❯ /exit\nResume this session with:\nclaude --resume ${SESSION_ID}\n$ claude\n❯ /exit\n$ `;

    expect(parseResumeHint(text)).toBeNull();
  });

  it("uses the hint after the last marker when an older one exists too", () => {
    const newer = "0198aaaa-bbbb-4ccc-8ddd-eeeeffff0002";
    const text = `❯ /exit\nclaude --resume ${SESSION_ID}\n$ claude\n❯ /exit\nclaude --resume ${newer}\n`;

    expect(parseResumeHint(text)?.sessionId).toBe(newer);
  });

  it("returns null for a hint whose id is not a valid id", () => {
    expect(parseResumeHint("❯ /exit\nclaude --resume --verbose\n")).toBeNull();
    expect(parseResumeHint("❯ /exit\nclaude --resume abc\n")).toBeNull();
  });

  it("returns null when the text has no /exit marker at all", () => {
    expect(parseResumeHint(`claude --resume ${SESSION_ID}\n`)).toBeNull();
  });
});

// A Claude screen: conversation above, the input box between two rules, then the footer.
const RULE = "─".repeat(72);
const FOOTERS: Record<Exclude<ScreenMode, "unknown">, string> = {
  default: "  ? for shortcuts",
  "accept-edits": "  ⏵⏵ accept edits on (shift+tab to cycle)",
  plan: "  ⏸ plan mode on (shift+tab to cycle)",
  bypass: "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle)",
};

function screen(
  mode: ScreenMode,
  options: { above?: string[]; input?: string; extraFooter?: string[]; trailingBlankRows?: number } = {}
): string {
  const footer = mode === "unknown" ? "  something unrelated in the footer" : FOOTERS[mode];
  return [
    ...(options.above ?? ["● Done with the change."]),
    RULE,
    options.input ?? "❯ ",
    RULE,
    footer,
    ...(options.extraFooter ?? []),
    ...Array.from({ length: options.trailingBlankRows ?? 0 }, () => ""),
  ].join("\n");
}

const STATUSLINE = ["  statusline line one", "  statusline line two", "  statusline line three"];

describe("screen helpers", () => {
  it.each(["default", "accept-edits", "plan", "bypass", "auto"] as ScreenMode[])("currentMode reads %s from the footer", (mode) => {
    expect(currentMode(screen(mode))).toBe(mode);
  });

  it("returns unknown, never raw screen text, for an unrecognized footer", () => {
    expect(currentMode(screen("unknown"))).toBe("unknown");
    expect(["default", "accept-edits", "plan", "bypass", "auto", "unknown"]).toContain(currentMode("anything at all"));
  });

  it("finds auto mode under a 3-line statusline and under trailing blank rows", () => {
    expect(isAutoModeOn(screen("auto", { extraFooter: STATUSLINE }))).toBe(true);
    expect(isAutoModeOn(screen("auto", { trailingBlankRows: 6 }))).toBe(true);
    expect(isAutoModeOn(screen("auto", { extraFooter: STATUSLINE, trailingBlankRows: 4 }))).toBe(true);
  });

  it("does not treat 'auto mode on' in the conversation above the box as auto mode", () => {
    const text = screen("default", { above: ["● The footer reads auto mode on after you press shift+tab.", "", "● Anything else?"] });

    expect(isAutoModeOn(text)).toBe(false);
    expect(currentMode(text)).toBe("default");
  });

  it("is not auto when another mode is showing", () => {
    expect(isAutoModeOn(screen("accept-edits"))).toBe(false);
  });

  it("sees an empty prompt in both prompt styles, with a statusline and blank rows below", () => {
    expect(isPromptEmpty(screen("default"))).toBe(true);
    expect(isPromptEmpty(screen("default", { input: "> " }))).toBe(true);
    expect(isPromptEmpty(screen("default", { extraFooter: STATUSLINE, trailingBlankRows: 5 }))).toBe(true);
  });

  it("sees a draft in the prompt", () => {
    expect(isPromptEmpty(screen("default", { input: "❯ fix the failing test" }))).toBe(false);
    expect(isPromptEmpty(screen("default", { input: "> /exi" }))).toBe(false);
  });

  it("treats a screen without an input box as not empty, the safe side", () => {
    expect(isPromptEmpty("$ ls\nfile.txt\n$ ")).toBe(false);
  });

  it("reads the box that is last on the screen when older boxes are in the scrollback", () => {
    const older = screen("default", { input: "❯ old draft" });
    const text = `${older}\n● reply\n${screen("default")}`;

    expect(isPromptEmpty(text)).toBe(true);
  });

  it("looks busy when the spinner and interrupt hint sit right above the box", () => {
    expect(looksBusy(screen("default", { above: ["● Reading files", "✻ Pondering… (12s · esc to interrupt)"] }))).toBe(true);
  });

  it("does not look busy for an idle screen", () => {
    expect(looksBusy(screen("default"))).toBe(false);
  });

  it("does not look busy because of interrupt text far up in the conversation", () => {
    const farAbove = ["✻ Pondering… (3s · esc to interrupt)", ...Array.from({ length: 12 }, (_value, index) => `● line ${index}`)];

    expect(looksBusy(screen("default", { above: farAbove }))).toBe(false);
  });
});

describe("versionFromPath", () => {
  it("reads the version from a versions directory in the args", () => {
    expect(versionFromPath("/Users/example/.local/share/claude/versions/2.1.310 --resume abcdef12")).toBe("2.1.310");
  });

  it("returns null when no version can be derived", () => {
    expect(versionFromPath("claude --model x")).toBeNull();
    expect(versionFromPath("node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBeNull();
    expect(versionFromPath("")).toBeNull();
  });
});

describe("sanitizeError", () => {
  it("never forwards the message, the stdout or the stderr of the error", () => {
    const error = Object.assign(new Error(`tmux set-environment AI_LAUNCH_COMMAND ${FAKE_TOKEN} failed`), {
      stdout: `PATH=/bin ${FAKE_TOKEN}`,
      stderr: FAKE_TOKEN,
      cmd: FAKE_TOKEN,
    });

    const message = sanitizeError(error);

    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(FAKE_TOKEN);
  });

  it("gives the same fixed text for different errors and for non-errors", () => {
    expect(sanitizeError(new Error("one"))).toBe(sanitizeError(new Error("two")));
    expect(sanitizeError("a string")).toBe(sanitizeError(undefined));
  });
});
