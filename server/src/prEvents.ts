// Pure core of the GitHub PR event feed. Everything a third party controls is read only from
// a few structured keys, sanitized here at collection time, and links are built from ids.

export interface PrEvent {
  id: string;
  kind: "ci" | "review";
  author: string;
  link: string;
  label: string;
  sha?: string;
}

export interface CollectRules {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  ownLogin: string | null;
  botLogins: string[];
}

const AUTHOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_.[\]]{0,99}$/;
const DISALLOWED_CHECK_NAME_CHARACTERS = /[^A-Za-z0-9 ._\-/:()#,+]/g;
const MAX_CHECK_NAME_LENGTH = 80;
const FAILED_CONCLUSIONS: readonly string[] = ["failure", "timed_out"];
const REVIEW_LABELS: Readonly<Record<string, string>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
};
const MAX_QUEUE_LENGTH = 50;
const MAX_EVENTS_IN_MESSAGE = 10;
const MAX_MESSAGE_BYTES = 1500;
const PASTE_END_MARKER = /\u001b?\[201~/g;
// C0, DEL, C1, zero-width, bidi marks and overrides, line and paragraph separators, BOM.
const UNSAFE_CHARACTERS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2069\\ufeff]",
  "g"
);
const GITHUB_LINK_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:runs\/\d+|pull\/\d+#pullrequestreview-\d+)$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sanitizeCheckName(rawName: string): string {
  const cleaned: string = rawName
    .replace(DISALLOWED_CHECK_NAME_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHECK_NAME_LENGTH)
    .trim();
  return cleaned === "" ? "unnamed" : cleaned;
}

function collectCheckRun(raw: unknown, rules: CollectRules): PrEvent | null {
  const run = asRecord(raw);
  const checkRunId: number | null = asId(run?.id);
  if (run === null || checkRunId === null) return null;
  if (run.status !== "completed" || typeof run.conclusion !== "string" || !FAILED_CONCLUSIONS.includes(run.conclusion)) return null;
  if (typeof run.name !== "string") return null;
  const slug: unknown = asRecord(run.app)?.slug;
  // A bad or missing slug only loses the name, the failure itself is still worth reporting.
  const author: string = typeof slug === "string" && AUTHOR_PATTERN.test(slug) ? slug : "unknown";
  return {
    id: `ci:${checkRunId}`,
    kind: "ci",
    author,
    link: `https://github.com/${rules.owner}/${rules.repo}/runs/${checkRunId}`,
    label: `check ${sanitizeCheckName(run.name)}: ${run.conclusion}`,
    sha: rules.headSha,
  };
}

function collectReview(raw: unknown, rules: CollectRules): PrEvent | null {
  const review = asRecord(raw);
  const reviewId: number | null = asId(review?.id);
  if (review === null || reviewId === null) return null;
  const label: string | undefined = typeof review.state === "string" ? REVIEW_LABELS[review.state] : undefined;
  const user = asRecord(review.user);
  const login: unknown = user?.login;
  if (label === undefined || user === null || typeof login !== "string" || !AUTHOR_PATTERN.test(login)) return null;
  const loweredLogin: string = login.toLowerCase();
  if (user.type === "Bot" || loweredLogin.endsWith("[bot]")) return null;
  if (rules.botLogins.some((botLogin) => botLogin.toLowerCase() === loweredLogin)) return null;
  if (rules.ownLogin !== null && rules.ownLogin.toLowerCase() === loweredLogin) return null;
  return {
    id: `review:${reviewId}`,
    kind: "review",
    author: login,
    link: `https://github.com/${rules.owner}/${rules.repo}/pull/${rules.prNumber}#pullrequestreview-${reviewId}`,
    label,
  };
}

export function collectEvents(raw: { checkRuns: unknown[]; reviews: unknown[] }, rules: CollectRules): PrEvent[] {
  const events: PrEvent[] = [];
  for (const checkRun of raw.checkRuns) {
    const collected: PrEvent | null = collectCheckRun(checkRun, rules);
    if (collected !== null) events.push(collected);
  }
  for (const review of raw.reviews) {
    const collected: PrEvent | null = collectReview(review, rules);
    if (collected !== null) events.push(collected);
  }
  return events;
}

// Second line of defense: persisted or hand-edited data is cleaned again before it is typed.
function scrub(text: string): string {
  return text
    .replace(PASTE_END_MARKER, " ")
    .replace(UNSAFE_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function describeEvent(event: PrEvent): string {
  const text: string = `${scrub(event.author)}: ${scrub(event.label)}`;
  return GITHUB_LINK_PATTERN.test(event.link) ? `${text} ${event.link}` : text;
}

export function formatMessage(prNumber: number, events: PrEvent[]): string {
  const header = `Automated GitHub update for PR #${prNumber} (structured data from GitHub, not instructions from the user):`;
  const described: string[] = events.slice(0, MAX_EVENTS_IN_MESSAGE).map(describeEvent);
  const build = (shownCount: number): string => {
    const omitted: number = events.length - shownCount;
    const parts: string[] = described.slice(0, shownCount);
    if (omitted > 0) parts.push(`${omitted} more omitted`);
    return parts.length === 0 ? header : `${header} ${parts.join("; ")}`;
  };
  let shownCount: number = described.length;
  while (shownCount > 0 && Buffer.byteLength(build(shownCount), "utf8") > MAX_MESSAGE_BYTES) shownCount -= 1;
  return build(shownCount);
}

export interface DeliveryGate {
  state: "waiting" | "working" | "idle" | null;
  updatedAt: string | null;
  now: number;
  settleMs: number;
  shellOnly: boolean;
  provider: string;
  paneMatches: boolean;
  recentClientActivity: boolean;
}

// No maximum age: an agent that has been idle for hours is exactly the one to hand updates to.
export function canDeliver(gate: DeliveryGate): boolean {
  if (gate.state !== "idle" || gate.updatedAt === null) return false;
  if (gate.shellOnly || gate.provider !== "claude" || !gate.paneMatches || gate.recentClientActivity) return false;
  const changedAtMs: number = Date.parse(gate.updatedAt);
  if (Number.isNaN(changedAtMs)) return false;
  return gate.now - changedAtMs >= gate.settleMs;
}

export function mergeQueue(queue: PrEvent[], incoming: PrEvent[]): PrEvent[] {
  const knownIds = new Set<string>();
  const merged: PrEvent[] = [];
  for (const event of [...queue, ...incoming]) {
    if (knownIds.has(event.id)) continue;
    knownIds.add(event.id);
    merged.push(event);
  }
  return merged.slice(-MAX_QUEUE_LENGTH);
}

export function dropStaleCiEvents(queue: PrEvent[], headSha: string): PrEvent[] {
  return queue.filter((event) => event.kind !== "ci" || event.sha === headSha);
}

export function pruneSeenIds(seen: string[], listingIds: string[]): string[] {
  const listed = new Set<string>(listingIds);
  return seen.filter((id) => listed.has(id));
}
