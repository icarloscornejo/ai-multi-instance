// Pure helpers for the GitLab host to token-variable-NAME rows in the setup screen.
// Only variable names ever pass through here, never token values.

export interface GitlabTokenEnvRow {
  host: string;
  envName: string;
}

export const MAX_GITLAB_TOKEN_ENV_ROWS = 20;

// Same rules as the server validators, so a row that passes here is not refused on save.
const HOST_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const GITLAB_NAMED_PATTERN = /^[A-Z0-9_]*GITLAB[A-Z0-9_]*$/;

function normalizedHost(rawHost: string): string | null {
  const host: string = rawHost.trim().toLowerCase();
  const labels: string[] = host.split(".");
  const isValid: boolean =
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => label.length <= 63 && HOST_LABEL_PATTERN.test(label)) &&
    /[a-z]/.test(labels[labels.length - 1]);
  return isValid ? host : null;
}

function isBlank(row: GitlabTokenEnvRow): boolean {
  return row.host.trim() === "" && row.envName.trim() === "";
}

export function gitlabTokenEnvRowsFromMap(map: Record<string, string> | undefined): GitlabTokenEnvRow[] {
  return Object.entries(map ?? {})
    .map(([host, envName]) => ({ host, envName }))
    .sort((left, right) => left.host.localeCompare(right.host));
}

export function gitlabTokenEnvFromRows(rows: GitlabTokenEnvRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((row) => !isBlank(row)).map((row) => [row.host.trim().toLowerCase(), row.envName.trim()]));
}

export function validateGitlabTokenEnvRows(rows: GitlabTokenEnvRow[]): { valid: boolean; errors: Array<string | null> } {
  const seenHosts = new Set<string>();
  const errors: Array<string | null> = rows.map((row, index) => {
    if (isBlank(row)) return null;
    if (index >= MAX_GITLAB_TOKEN_ENV_ROWS) return `At most ${MAX_GITLAB_TOKEN_ENV_ROWS} hosts.`;
    const host: string | null = normalizedHost(row.host);
    if (host === null) return "Use a plain host name such as gitlab.example.com.";
    const envName: string = row.envName.trim();
    if (
      !ENV_NAME_PATTERN.test(envName) ||
      !GITLAB_NAMED_PATTERN.test(envName) ||
      envName === "DASHBOARD_PASSWORD" ||
      /^(GITHUB_|GH_)/.test(envName)
    ) {
      return "Use an upper-case variable name that contains GITLAB, such as CORP_GITLAB_TOKEN.";
    }
    if (seenHosts.has(host)) return "This host is already listed.";
    seenHosts.add(host);
    return null;
  });
  return { valid: errors.every((error) => error === null), errors };
}
