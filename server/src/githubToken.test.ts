import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGithubTokenForTests, invalidateToken, resolveGithubToken, type TokenRunOptions } from "./githubToken";

// A recognizable value that passes the shape check, so any leak is greppable.
// Deliberately not shaped like a real GitHub prefix so secret scanners never flag the fixtures.
const FAKE_TOKEN = "faketoken_for_tests_0123456789abcdef";
const OTHER_FAKE_TOKEN = "otherfaketoken_0123456789abcdefgh";
const CREDENTIAL_STDIN = "protocol=https\nhost=github.com\n\n";

type RunMock = ReturnType<typeof vi.fn<(file: string, args: string[], options: TokenRunOptions) => Promise<{ stdout: string }>>>;

let nowMs = 0;
let run: RunMock;

function enoent(): Error {
  return Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
}

function deps(env: NodeJS.ProcessEnv = {}) {
  return { env, run, now: () => nowMs };
}

function credentialOutput(password: string): string {
  return `protocol=https\nhost=github.com\nusername=someone\npassword=${password}\n`;
}

beforeEach(() => {
  nowMs = Date.parse("2026-11-02T12:00:00Z");
  _resetGithubTokenForTests();
  run = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveGithubToken order", () => {
  it("takes GITHUB_TOKEN from the injected environment first and runs nothing", async () => {
    const result = await resolveGithubToken(deps({ GITHUB_TOKEN: FAKE_TOKEN }));

    expect(result).toEqual({ token: FAKE_TOKEN });
    expect(run).not.toHaveBeenCalled();
  });

  it("asks gh for the github.com host when the environment has no token", async () => {
    run.mockResolvedValueOnce({ stdout: `${FAKE_TOKEN}\n` });

    const result = await resolveGithubToken(deps());

    expect(result).toEqual({ token: FAKE_TOKEN });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("gh", ["auth", "token", "--hostname", "github.com"], expect.anything());
  });

  it("falls through to git credential fill when gh is missing", async () => {
    run.mockRejectedValueOnce(enoent());
    run.mockResolvedValueOnce({ stdout: credentialOutput(FAKE_TOKEN) });

    const result = await resolveGithubToken(deps());

    expect(result).toEqual({ token: FAKE_TOKEN });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("falls through to git credential fill when gh exits non-zero", async () => {
    run.mockRejectedValueOnce(Object.assign(new Error("not logged in"), { code: 1 }));
    run.mockResolvedValueOnce({ stdout: credentialOutput(FAKE_TOKEN) });

    expect(await resolveGithubToken(deps())).toEqual({ token: FAKE_TOKEN });
  });

  it("feeds git credential fill the exact stdin bytes with a non-interactive hardened env", async () => {
    run.mockRejectedValueOnce(enoent());
    run.mockResolvedValueOnce({ stdout: credentialOutput(FAKE_TOKEN) });

    await resolveGithubToken(deps());

    const [file, args, options] = run.mock.calls[1];
    expect(file).toBe("git");
    expect(args).toEqual(["credential", "fill"]);
    expect(options.input).toBe(CREDENTIAL_STDIN);
    expect(options.env?.GCM_INTERACTIVE).toBe("never");
    expect(options.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(options.timeoutMs).toBe(5000);
  });

  it("uses only the password= line of the credential output", async () => {
    run.mockRejectedValueOnce(enoent());
    run.mockResolvedValueOnce({
      stdout: `protocol=https\nhost=github.com\nusername=${OTHER_FAKE_TOKEN}\nextra=password=${OTHER_FAKE_TOKEN}\npassword=${FAKE_TOKEN}\n`,
    });

    expect(await resolveGithubToken(deps())).toEqual({ token: FAKE_TOKEN });
  });

  it("reports no-token when nothing yields one", async () => {
    run.mockRejectedValueOnce(enoent());
    run.mockResolvedValueOnce({ stdout: "" });

    expect(await resolveGithubToken(deps())).toEqual({ reason: "no-token" });
  });

  it("reports no-token for an ssh-only setup where the helper has no password", async () => {
    run.mockRejectedValueOnce(Object.assign(new Error("none"), { code: 1 }));
    run.mockResolvedValueOnce({ stdout: "protocol=https\nhost=github.com\nusername=someone\n" });

    expect(await resolveGithubToken(deps())).toEqual({ reason: "no-token" });
  });

  it("reports no-token when git credential fill itself fails", async () => {
    run.mockRejectedValue(enoent());

    expect(await resolveGithubToken(deps())).toEqual({ reason: "no-token" });
  });
});

describe("resolveGithubToken shape validation", () => {
  it.each([
    ["a newline inside the value", `${FAKE_TOKEN}\n${OTHER_FAKE_TOKEN}`],
    ["a space", "ghp_has a space in it 0123456789"],
    ["too short", "ghp_short"],
    ["a quote", `${FAKE_TOKEN}"`],
    ["an escape character", `${FAKE_TOKEN}\u001b[201~`],
    ["more than 255 characters", "a".repeat(256)],
  ])("treats an environment token with %s as no token", async (_name, value) => {
    run.mockRejectedValue(enoent());

    expect(await resolveGithubToken(deps({ GITHUB_TOKEN: value }))).toEqual({ reason: "no-token" });
  });

  it("treats a gh answer of the wrong shape as no token", async () => {
    run.mockResolvedValueOnce({ stdout: "error: you are not logged in to any hosts\n" });
    run.mockRejectedValueOnce(enoent());

    expect(await resolveGithubToken(deps())).toEqual({ reason: "no-token" });
  });

  it("treats a credential password of the wrong shape as no token", async () => {
    run.mockRejectedValueOnce(enoent());
    run.mockResolvedValueOnce({ stdout: credentialOutput("pass word!") });

    expect(await resolveGithubToken(deps())).toEqual({ reason: "no-token" });
  });
});

describe("resolveGithubToken secrecy", () => {
  it("never lets the token leak through a failing run, the console or the result", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
    ];
    const leakyError = Object.assign(new Error(`failed with ${FAKE_TOKEN}`), {
      stdout: FAKE_TOKEN,
      stderr: `fatal: ${FAKE_TOKEN}`,
      code: 1,
    });
    run.mockRejectedValue(leakyError);

    let outcome: unknown;
    let thrown: unknown = null;
    try {
      outcome = await resolveGithubToken(deps());
    } catch (error) {
      thrown = error;
    }

    expect(outcome).toEqual({ reason: "no-token" });
    expect(JSON.stringify(thrown)).not.toContain(FAKE_TOKEN);
    expect(String((thrown as Error | null)?.message ?? "")).not.toContain(FAKE_TOKEN);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_TOKEN);
    }
  });

  it("does not log the token when it resolves successfully", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    run.mockResolvedValueOnce({ stdout: FAKE_TOKEN });

    await resolveGithubToken(deps());

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_TOKEN);
    }
  });
});

describe("resolveGithubToken caching", () => {
  it("serves a found token from the cache for five minutes", async () => {
    run.mockResolvedValue({ stdout: FAKE_TOKEN });

    await resolveGithubToken(deps());
    nowMs += 4 * 60_000 + 59_000;
    await resolveGithubToken(deps());
    expect(run).toHaveBeenCalledTimes(1);

    nowMs += 2_000;
    await resolveGithubToken(deps());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("remembers a miss for sixty seconds only", async () => {
    run.mockRejectedValue(enoent());

    await resolveGithubToken(deps());
    const callsAfterFirstMiss: number = run.mock.calls.length;
    nowMs += 59_000;
    await resolveGithubToken(deps());
    expect(run.mock.calls.length).toBe(callsAfterFirstMiss);

    nowMs += 2_000;
    await resolveGithubToken(deps());
    expect(run.mock.calls.length).toBeGreaterThan(callsAfterFirstMiss);
  });

  it("invalidateToken drops the cached token so the next call resolves again", async () => {
    run.mockResolvedValueOnce({ stdout: FAKE_TOKEN });
    run.mockResolvedValueOnce({ stdout: OTHER_FAKE_TOKEN });

    expect(await resolveGithubToken(deps())).toEqual({ token: FAKE_TOKEN });
    invalidateToken();

    expect(await resolveGithubToken(deps())).toEqual({ token: OTHER_FAKE_TOKEN });
  });
});
