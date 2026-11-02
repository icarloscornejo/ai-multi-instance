import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenRunOptions } from "./githubToken";
import { _resetGitlabTokenForTests, invalidateGitlabToken, resolveGitlabToken } from "./gitlabToken";

// Recognizable values that pass the shape check, deliberately not shaped like any real prefix.
const FAKE_TOKEN = "faketoken_for_tests_0123456789abcdef";
const OTHER_FAKE_TOKEN = "otherfaketoken_0123456789abcdefgh";
const THIRD_FAKE_TOKEN = "thirdfaketoken_0123456789abcdefgh";
const HOST = "gitlab.example.com";
const OTHER_HOST = "git.other.example.org";

type RunMock = ReturnType<typeof vi.fn<(file: string, args: string[], options: TokenRunOptions) => Promise<{ stdout: string }>>>;

let nowMs = 0;
let run: RunMock;

function enoent(): Error {
  return Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" });
}

function deps(env: NodeJS.ProcessEnv = {}) {
  return { env, run, now: () => nowMs };
}

function credentialOutput(password: string, host: string = HOST): string {
  return `protocol=https\nhost=${host}\nusername=someone\npassword=${password}\n`;
}

beforeEach(() => {
  nowMs = Date.parse("2026-11-02T12:00:00Z");
  _resetGitlabTokenForTests();
  run = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveGitlabToken order", () => {
  it("takes the variable configured for the host first and runs nothing", async () => {
    const result = await resolveGitlabToken(HOST, "CORP_GITLAB", { [HOST]: "CORP_GITLAB" }, deps({ CORP_GITLAB: FAKE_TOKEN, GITLAB_TOKEN: OTHER_FAKE_TOKEN, GITLAB_HOST: HOST }));

    expect(result).toEqual({ token: FAKE_TOKEN });
    expect(run).not.toHaveBeenCalled();
  });

  it("uses GITLAB_TOKEN only for the host named by GITLAB_HOST", async () => {
    const result = await resolveGitlabToken(HOST, undefined, {}, deps({ GITLAB_TOKEN: FAKE_TOKEN, GITLAB_HOST: HOST }));

    expect(result).toEqual({ token: FAKE_TOKEN });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["a url with a trailing slash", `https://${HOST}/`],
    ["a url without a slash", `https://${HOST}`],
    ["an upper case host", "GitLab.Example.COM"],
  ])("accepts GITLAB_HOST given as %s", async (_name, gitlabHost) => {
    const result = await resolveGitlabToken(HOST, undefined, {}, deps({ GITLAB_TOKEN: FAKE_TOKEN, GITLAB_HOST: gitlabHost }));

    expect(result).toEqual({ token: FAKE_TOKEN });
  });

  it.each([
    ["a port", `${HOST}:8443`],
    ["an http url", `http://${HOST}/`],
    ["a path", `https://${HOST}/sub`],
    ["two slashes", `https://${HOST}//`],
    ["userinfo", `user@${HOST}`],
    ["a different host", OTHER_HOST],
    ["nothing", ""],
  ])("ignores GITLAB_TOKEN when GITLAB_HOST has %s", async (_name, gitlabHost) => {
    run.mockRejectedValue(enoent());

    const result = await resolveGitlabToken(HOST, undefined, {}, deps({ GITLAB_TOKEN: FAKE_TOKEN, GITLAB_HOST: gitlabHost }));

    expect(result).toEqual({ reason: "no-token" });
  });

  it("never sends GITLAB_TOKEN to a host that is not GITLAB_HOST", async () => {
    run.mockRejectedValue(enoent());

    const result = await resolveGitlabToken(OTHER_HOST, undefined, {}, deps({ GITLAB_TOKEN: FAKE_TOKEN, GITLAB_HOST: HOST }));

    expect(result).toEqual({ reason: "no-token" });
  });

  it("does not hand GITLAB_TOKEN to a listed host whose own variable is unset", async () => {
    run.mockRejectedValue(enoent());

    const result = await resolveGitlabToken(
      OTHER_HOST,
      "OTHER_GL",
      { [OTHER_HOST]: "OTHER_GL", [HOST]: "CORP_GITLAB" },
      deps({ GITLAB_TOKEN: FAKE_TOKEN, GITLAB_HOST: HOST })
    );

    expect(result).toEqual({ reason: "no-token" });
  });

  it("lets the configured variable win over GITLAB_TOKEN for the same host", async () => {
    const result = await resolveGitlabToken(HOST, "CORP_GITLAB", { [HOST]: "CORP_GITLAB" }, deps({ CORP_GITLAB: OTHER_FAKE_TOKEN, GITLAB_TOKEN: FAKE_TOKEN, GITLAB_HOST: HOST }));

    expect(result).toEqual({ token: OTHER_FAKE_TOKEN });
  });

  it("ignores a variable name when the host is not a key of the configured map", async () => {
    run.mockRejectedValue(enoent());

    const result = await resolveGitlabToken(OTHER_HOST, "CORP_GITLAB", { [HOST]: "CORP_GITLAB" }, deps({ CORP_GITLAB: FAKE_TOKEN }));

    expect(result).toEqual({ reason: "no-token" });
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("ignores a configured name %s that resolves to a non-string without throwing", async (name) => {
    run.mockRejectedValue(enoent());

    const result = await resolveGitlabToken(HOST, name, { [HOST]: name }, deps({}));

    expect(result).toEqual({ reason: "no-token" });
  });

  it("ignores non-string environment values", async () => {
    run.mockRejectedValue(enoent());
    const env = { CORP_GITLAB: 12345, GITLAB_TOKEN: { toString: () => FAKE_TOKEN }, GITLAB_HOST: HOST } as unknown as NodeJS.ProcessEnv;

    const result = await resolveGitlabToken(HOST, "CORP_GITLAB", { [HOST]: "CORP_GITLAB" }, deps(env));

    expect(result).toEqual({ reason: "no-token" });
  });

  it("rejects a candidate that fails the shape check", async () => {
    run.mockRejectedValue(enoent());

    const result = await resolveGitlabToken(HOST, "CORP_GITLAB", { [HOST]: "CORP_GITLAB" }, deps({ CORP_GITLAB: "short token with spaces" }));

    expect(result).toEqual({ reason: "no-token" });
  });
});

describe("resolveGitlabToken glab and the credential helper", () => {
  it("asks glab for the config token of exactly that host", async () => {
    run.mockResolvedValueOnce({ stdout: `${FAKE_TOKEN}\n` });

    const result = await resolveGitlabToken(HOST, undefined, {}, deps({ PATH: "/usr/bin" }));

    expect(result).toEqual({ token: FAKE_TOKEN });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("glab", ["config", "get", "token", "--host", HOST], expect.anything());
  });

  it("treats empty or whitespace glab output as a miss and falls through to the credential helper", async () => {
    run.mockImplementation(async (file) => {
      if (file === "glab") return { stdout: "  \n" };
      return { stdout: credentialOutput(FAKE_TOKEN) };
    });

    const result = await resolveGitlabToken(HOST, undefined, {}, deps());

    expect(result).toEqual({ token: FAKE_TOKEN });
    expect(run.mock.calls.map((call) => call[0])).toEqual(["glab", "git"]);
  });

  it("falls through when glab is missing, exits non-zero or prints a malformed token", async () => {
    for (const glabBehavior of [
      () => Promise.reject(enoent()),
      () => Promise.reject(new Error("exit 1")),
      () => Promise.resolve({ stdout: "not a token!" }),
    ]) {
      _resetGitlabTokenForTests();
      run.mockReset();
      run.mockImplementation(async (file) => (file === "glab" ? glabBehavior() : { stdout: credentialOutput(FAKE_TOKEN) }));

      const result = await resolveGitlabToken(HOST, undefined, {}, deps());

      expect(result).toEqual({ token: FAKE_TOKEN });
    }
  });

  it("stops at glab when it answers and never runs the credential helper", async () => {
    run.mockResolvedValueOnce({ stdout: FAKE_TOKEN });

    await resolveGitlabToken(HOST, undefined, {}, deps());

    expect(run.mock.calls.map((call) => call[0])).toEqual(["glab"]);
  });

  it("fills credentials with the exact stdin for the host, outside any repository", async () => {
    run.mockImplementation(async (file) => {
      if (file === "glab") throw enoent();
      return { stdout: credentialOutput(FAKE_TOKEN) };
    });

    const result = await resolveGitlabToken(HOST, undefined, {}, deps({ PATH: "/usr/bin", HOME: "/home/someone" }));

    expect(result).toEqual({ token: FAKE_TOKEN });
    const gitCall = run.mock.calls.find((call) => call[0] === "git");
    expect(gitCall?.[1]).toEqual(["credential", "fill"]);
    expect(gitCall?.[2].input).toBe(`protocol=https\nhost=${HOST}\n\n`);
    expect(gitCall?.[2].cwd).toBe(os.tmpdir());
    expect(gitCall?.[2].env?.GCM_INTERACTIVE).toBe("never");
    expect(gitCall?.[2].timeoutMs).toBeGreaterThan(0);
  });

  it("takes only the password line of the credential output", async () => {
    run.mockImplementation(async (file) => {
      if (file === "glab") throw enoent();
      return { stdout: `username=${OTHER_FAKE_TOKEN}\npassword=${FAKE_TOKEN}\nextra=${THIRD_FAKE_TOKEN}\n` };
    });

    expect(await resolveGitlabToken(HOST, undefined, {}, deps())).toEqual({ token: FAKE_TOKEN });
  });

  it("gives no token when every source misses", async () => {
    run.mockRejectedValue(enoent());

    expect(await resolveGitlabToken(HOST, undefined, {}, deps())).toEqual({ reason: "no-token" });
  });

  it("gives child processes an allowlisted environment with no token variable", async () => {
    run.mockRejectedValue(enoent());
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      USER: "someone",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      GITLAB_TOKEN: FAKE_TOKEN,
      GITLAB_ACCESS_TOKEN: FAKE_TOKEN,
      GITLAB_URI: "https://evil.example",
      GITLAB_HOST: "other.example.org",
      GL_HOST: "evil.example",
      OAUTH_TOKEN: FAKE_TOKEN,
      CI_JOB_TOKEN: FAKE_TOKEN,
      GITHUB_TOKEN: FAKE_TOKEN,
      GH_TOKEN: FAKE_TOKEN,
      GH_ENTERPRISE_TOKEN: FAKE_TOKEN,
      DASHBOARD_PASSWORD: FAKE_TOKEN,
      SOME_SECRET: FAKE_TOKEN,
    };

    await resolveGitlabToken(HOST, undefined, {}, deps(env));

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of run.mock.calls) {
      const childEnv = call[2].env ?? {};
      const keys: string[] = Object.keys(childEnv);
      expect(keys.some((key) => /^(GITLAB_|GL_|GITHUB_|GH_|OAUTH_TOKEN|CI_JOB_TOKEN|DASHBOARD_)/.test(key))).toBe(false);
      expect(keys).not.toContain("SOME_SECRET");
      expect(Object.values(childEnv)).not.toContain(FAKE_TOKEN);
      expect(childEnv.PATH).toBe("/usr/bin");
      expect(childEnv.HOME).toBe("/home/someone");
    }
  });

  it("copes with a missing PATH or HOME in the injected environment", async () => {
    run.mockRejectedValue(enoent());

    await expect(resolveGitlabToken(HOST, undefined, {}, deps({}))).resolves.toEqual({ reason: "no-token" });
  });
});

describe("resolveGitlabToken validation", () => {
  it.each([
    "",
    "GitLab.example.com",
    "gitlab.example.com.",
    "gitlab.example.com:8443",
    "user@gitlab.example.com",
    "gitlab.example.com/x",
    "10.0.0.1",
    "localhost",
    "gitlab.exämple.com",
    "-x.example.com",
    "--hostname=evil",
    "a b.example.com",
    "gitlab.example.com\nhost=evil.com",
  ])("gives no token and runs nothing for the host %j", async (host) => {
    const result = await resolveGitlabToken(host, undefined, { [host]: "CORP_GITLAB" }, deps({ CORP_GITLAB: FAKE_TOKEN, GITLAB_TOKEN: FAKE_TOKEN, GITLAB_HOST: host }));

    expect(result).toEqual({ reason: "no-token" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["DASHBOARD_PASSWORD", "GITHUB_TOKEN", "GITHUB_PAT", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "bad name", "1ABC", "X=Y", ""])(
    "gives no token and runs nothing for the variable name %j",
    async (name) => {
      const env: NodeJS.ProcessEnv = { [name]: FAKE_TOKEN };

      const result = await resolveGitlabToken(HOST, name, { [HOST]: name }, deps(env));

      expect(result).toEqual({ reason: "no-token" });
      expect(run).not.toHaveBeenCalled();
    }
  );
});

describe("resolveGitlabToken caching", () => {
  it("caches a glab token per host for five minutes", async () => {
    run.mockResolvedValue({ stdout: FAKE_TOKEN });

    await resolveGitlabToken(HOST, undefined, {}, deps());
    nowMs += 4 * 60_000;
    const second = await resolveGitlabToken(HOST, undefined, {}, deps());

    expect(second).toEqual({ token: FAKE_TOKEN });
    expect(run).toHaveBeenCalledTimes(1);

    nowMs += 2 * 60_000;
    await resolveGitlabToken(HOST, undefined, {}, deps());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("caches a miss for only a minute", async () => {
    run.mockRejectedValue(enoent());

    await resolveGitlabToken(HOST, undefined, {}, deps());
    const callsAfterFirst: number = run.mock.calls.length;
    nowMs += 30_000;
    await resolveGitlabToken(HOST, undefined, {}, deps());
    expect(run.mock.calls.length).toBe(callsAfterFirst);

    nowMs += 31_000;
    await resolveGitlabToken(HOST, undefined, {}, deps());
    expect(run.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("keeps each host's token separate", async () => {
    run.mockImplementation(async (file, args) => {
      if (file === "glab" && args.includes(HOST)) return { stdout: FAKE_TOKEN };
      if (file === "glab" && args.includes(OTHER_HOST)) return { stdout: OTHER_FAKE_TOKEN };
      throw enoent();
    });

    expect(await resolveGitlabToken(HOST, undefined, {}, deps())).toEqual({ token: FAKE_TOKEN });
    expect(await resolveGitlabToken(OTHER_HOST, undefined, {}, deps())).toEqual({ token: OTHER_FAKE_TOKEN });
    expect(await resolveGitlabToken(HOST, undefined, {}, deps())).toEqual({ token: FAKE_TOKEN });
  });

  it("does not mix up gitlab.co with variable GITLAB_MX and gitlab.com with variable GITLAB_X", async () => {
    run.mockRejectedValue(enoent());
    const env: NodeJS.ProcessEnv = { GITLAB_MX: FAKE_TOKEN };

    expect(await resolveGitlabToken("gitlab.co", "GITLAB_MX", { "gitlab.co": "GITLAB_MX" }, deps(env))).toEqual({ token: FAKE_TOKEN });
    expect(await resolveGitlabToken("gitlab.com", "GITLAB_X", { "gitlab.com": "GITLAB_X" }, deps(env))).toEqual({ reason: "no-token" });
  });

  it("does not mix them up in the other order either", async () => {
    run.mockRejectedValue(enoent());
    const env: NodeJS.ProcessEnv = { GITLAB_X: FAKE_TOKEN };

    expect(await resolveGitlabToken("gitlab.com", "GITLAB_X", { "gitlab.com": "GITLAB_X" }, deps(env))).toEqual({ token: FAKE_TOKEN });
    expect(await resolveGitlabToken("gitlab.co", "GITLAB_MX", { "gitlab.co": "GITLAB_MX" }, deps(env))).toEqual({ reason: "no-token" });
  });

  it("blocks every source for a host after invalidation, for a minute", async () => {
    const env: NodeJS.ProcessEnv = { CORP_GITLAB: FAKE_TOKEN };
    run.mockResolvedValue({ stdout: OTHER_FAKE_TOKEN });
    const configured = { [HOST]: "CORP_GITLAB" };

    expect(await resolveGitlabToken(HOST, "CORP_GITLAB", configured, deps(env))).toEqual({ token: FAKE_TOKEN });
    invalidateGitlabToken(HOST);

    nowMs += 30_000;
    expect(await resolveGitlabToken(HOST, "CORP_GITLAB", configured, deps(env))).toEqual({ reason: "no-token" });
    expect(await resolveGitlabToken(HOST, undefined, {}, deps({ GITLAB_TOKEN: FAKE_TOKEN, GITLAB_HOST: HOST }))).toEqual({ reason: "no-token" });
    expect(run).not.toHaveBeenCalled();

    nowMs += 31_000;
    expect(await resolveGitlabToken(HOST, "CORP_GITLAB", configured, deps(env))).toEqual({ token: FAKE_TOKEN });
  });

  it("invalidates only the rejected host", async () => {
    const env: NodeJS.ProcessEnv = { A_GITLAB: FAKE_TOKEN, B_GITLAB: OTHER_FAKE_TOKEN };
    const configured = { [HOST]: "A_GITLAB", [OTHER_HOST]: "B_GITLAB" };

    invalidateGitlabToken(HOST);

    expect(await resolveGitlabToken(OTHER_HOST, "B_GITLAB", configured, deps(env))).toEqual({ token: OTHER_FAKE_TOKEN });
    expect(await resolveGitlabToken(HOST, "A_GITLAB", configured, deps(env))).toEqual({ reason: "no-token" });
  });

  it("does not resend a rejected credential helper secret on the next call", async () => {
    run.mockImplementation(async (file) => {
      if (file === "glab") throw enoent();
      return { stdout: credentialOutput(FAKE_TOKEN) };
    });
    await resolveGitlabToken(HOST, undefined, {}, deps());
    invalidateGitlabToken(HOST);
    run.mockClear();

    const result = await resolveGitlabToken(HOST, undefined, {}, deps());

    expect(result).toEqual({ reason: "no-token" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("resolveGitlabToken secrecy", () => {
  it("keeps the token out of the console even when a command fails with it in the message", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    run.mockRejectedValue(Object.assign(new Error(`failed with ${FAKE_TOKEN}`), { stderr: FAKE_TOKEN, stdout: FAKE_TOKEN }));

    const result = await resolveGitlabToken(HOST, undefined, {}, deps({ PATH: "/usr/bin" }));

    expect(result).toEqual({ reason: "no-token" });
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });
});
