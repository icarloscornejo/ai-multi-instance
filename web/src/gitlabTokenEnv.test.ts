import { describe, expect, it } from "vitest";
import { gitlabTokenEnvFromRows, gitlabTokenEnvRowsFromMap, validateGitlabTokenEnvRows } from "./gitlabTokenEnv";

describe("gitlabTokenEnvRowsFromMap", () => {
  it("hydrates one row per host sorted by host", () => {
    expect(gitlabTokenEnvRowsFromMap({ "z.example.com": "Z_VAR", "a.example.com": "A_VAR" })).toEqual([
      { host: "a.example.com", envName: "A_VAR" },
      { host: "z.example.com", envName: "Z_VAR" },
    ]);
  });

  it("gives no rows for an absent or empty map", () => {
    expect(gitlabTokenEnvRowsFromMap(undefined)).toEqual([]);
    expect(gitlabTokenEnvRowsFromMap({})).toEqual([]);
  });
});

describe("gitlabTokenEnvFromRows", () => {
  it("serializes rows to a map of lower-cased trimmed hosts to variable names", () => {
    expect(
      gitlabTokenEnvFromRows([
        { host: "  GitLab.Example.com ", envName: " CORP_GITLAB " },
        { host: "git.other.example.org", envName: "OTHER_GITLAB" },
      ])
    ).toEqual({ "gitlab.example.com": "CORP_GITLAB", "git.other.example.org": "OTHER_GITLAB" });
  });

  it("skips rows that are completely blank", () => {
    expect(gitlabTokenEnvFromRows([{ host: "", envName: "" }, { host: " ", envName: " " }])).toEqual({});
  });

  it("round trips a map", () => {
    const map = { "gitlab.example.com": "CORP_GITLAB" };

    expect(gitlabTokenEnvFromRows(gitlabTokenEnvRowsFromMap(map))).toEqual(map);
  });

  it("carries names only", () => {
    const serialized: string = JSON.stringify(gitlabTokenEnvFromRows([{ host: "gitlab.example.com", envName: "CORP_GITLAB" }]));

    expect(serialized).toBe('{"gitlab.example.com":"CORP_GITLAB"}');
  });
});

describe("validateGitlabTokenEnvRows", () => {
  it("accepts valid rows and blank rows", () => {
    const result = validateGitlabTokenEnvRows([
      { host: "gitlab.example.com", envName: "CORP_GITLAB" },
      { host: "", envName: "" },
      { host: "git.other.example.org", envName: "CORP_GITLAB_TOKEN" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([null, null, null]);
  });

  it.each([
    ["a host with userinfo", { host: "user@evil.example.com", envName: "CORP_GITLAB" }],
    ["a host with a port", { host: "gitlab.example.com:8443", envName: "CORP_GITLAB" }],
    ["a host with a path", { host: "gitlab.example.com/x", envName: "CORP_GITLAB" }],
    ["a url", { host: "https://gitlab.example.com", envName: "CORP_GITLAB" }],
    ["a single label host", { host: "localhost", envName: "CORP_GITLAB" }],
    ["an ip host", { host: "10.0.0.1", envName: "CORP_GITLAB" }],
    ["a missing host", { host: "", envName: "CORP_GITLAB" }],
    ["a missing variable name", { host: "gitlab.example.com", envName: "" }],
    ["a name with spaces", { host: "gitlab.example.com", envName: "bad name" }],
    ["a name starting with a digit", { host: "gitlab.example.com", envName: "1GL" }],
    ["the dashboard password variable", { host: "gitlab.example.com", envName: "DASHBOARD_PASSWORD" }],
    ["a GITHUB_ variable", { host: "gitlab.example.com", envName: "GITHUB_TOKEN" }],
    ["a GH_ variable", { host: "gitlab.example.com", envName: "GH_TOKEN" }],
    ["a variable without GITLAB", { host: "gitlab.example.com", envName: "ANTHROPIC_API_KEY" }],
    ["an unrelated service variable", { host: "gitlab.example.com", envName: "CORP_FIGMA_TOKEN" }],
  ])("flags a row with %s", (_name, row) => {
    const result = validateGitlabTokenEnvRows([row]);

    expect(result.valid).toBe(false);
    expect(typeof result.errors[0]).toBe("string");
    expect(result.errors[0]).not.toBe("");
  });

  it("flags a duplicate host regardless of case on the later row", () => {
    const result = validateGitlabTokenEnvRows([
      { host: "gitlab.example.com", envName: "A_GITLAB" },
      { host: "GITLAB.example.com", envName: "B_GITLAB" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toBeNull();
    expect(typeof result.errors[1]).toBe("string");
  });

  it("flags more than twenty rows", () => {
    const rows = Array.from({ length: 21 }, (_value, index) => ({ host: `gl${index}.example.com`, envName: `GITLAB_VAR_${index}` }));

    expect(validateGitlabTokenEnvRows(rows.slice(0, 20)).valid).toBe(true);
    expect(validateGitlabTokenEnvRows(rows).valid).toBe(false);
  });
});
