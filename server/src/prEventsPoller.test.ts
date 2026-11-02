import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPrEventsForTests,
  deliverSweep,
  getPrEventsStatus,
  pollSweep,
  type PrEventsPollerDeps,
} from "./prEventsPoller";
import type { PrEvent } from "./prEvents";
import type { PaneAgent } from "./paneAgent";
import type { ReviewRequest } from "./reviewRequests";
import { withSessionLock } from "./sessionLock";
import type { DashboardState, InstanceRecord } from "./types";

// Obviously fake, but it passes the token shape check so the code under test accepts it.
const FAKE_TOKEN = "faketoken_for_tests_0123456789abcdef";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const HEAD = "1111111111111111111111111111111111111111";
const NEW_HEAD = "2222222222222222222222222222222222222222";
const FOUND: ReviewRequest = {
  state: "found",
  number: 7,
  kind: "github",
  url: "https://github.com/acme/widgets/pull/7",
  checkedAt: "2026-11-02T11:59:00.000Z",
  stale: false,
};

interface StoreEntry {
  prNumber: number;
  headSha: string | null;
  seen: string[];
  queue: PrEvent[];
}
interface StoreFile {
  version: 1;
  instances: Record<string, unknown>;
}

interface FakeApi {
  pull: Record<string, unknown>;
  checkRuns: unknown[];
  reviews: unknown[];
  reviewPages: unknown[][] | null;
  user: Record<string, unknown>;
  overrides: Record<string, () => Response>;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function checkRun(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: "build",
    status: "completed",
    conclusion: "failure",
    app: { slug: "github-actions" },
    output: { title: "SECRET OUTPUT", summary: "SECRET SUMMARY", text: "SECRET TEXT" },
    ...overrides,
  };
}

function review(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    state: "CHANGES_REQUESTED",
    body: "SECRET REVIEW BODY",
    user: { login: "alice", type: "User" },
    ...overrides,
  };
}

function prEvent(id: string, overrides: Partial<PrEvent> = {}): PrEvent {
  const runId: string = id.split(":")[1];
  return {
    id,
    kind: "ci",
    author: "github-actions",
    link: `https://github.com/acme/widgets/runs/${runId}`,
    label: "build: failure",
    sha: HEAD,
    ...overrides,
  };
}

function instance(id: string, overrides: Record<string, unknown> = {}): InstanceRecord {
  return {
    id,
    label: id,
    locationPath: "/work/repo",
    tmuxSession: `ccdash-${id}`,
    provider: "claude",
    command: "claude",
    model: null,
    effort: null,
    fontSize: 13,
    createdAt: "2026-01-01T00:00:00.000Z",
    prEvents: { enabled: true, paused: false },
    ...overrides,
  } as InstanceRecord;
}

function claudeAgent(paneJobPid: number): PaneAgent {
  return { kind: "agent", provider: "claude", paneJobPid, agentPid: paneJobPid + 1, startedAtMs: 0, resumeId: null };
}

function seededEntry(overrides: Partial<StoreEntry> = {}): StoreEntry {
  return { prNumber: 7, headSha: HEAD, seen: [], queue: [], ...overrides };
}

interface Harness {
  deps: PrEventsPollerDeps;
  api: FakeApi;
  instances: InstanceRecord[];
  clock: { now: number };
  store: { current: StoreFile };
  fetchCalls: { url: string; init: RequestInit }[];
  entry: (id: string) => StoreEntry;
  paste: ReturnType<typeof vi.fn>;
  reviewRequest: { current: ReviewRequest | null };
  onLock: { current: () => void };
}

function harness(options: { instances?: InstanceRecord[]; store?: Record<string, unknown>; overrides?: Partial<PrEventsPollerDeps> } = {}): Harness {
  const clock = { now: NOW };
  const instances: InstanceRecord[] = options.instances ?? [instance("aaa111")];
  const store = { current: { version: 1 as const, instances: options.store ?? {} } };
  const reviewRequest: { current: ReviewRequest | null } = { current: FOUND };
  const onLock = { current: (): void => undefined };
  const fetchCalls: { url: string; init: RequestInit }[] = [];
  const api: FakeApi = {
    pull: { state: "open", merged: false, head: { sha: HEAD } },
    checkRuns: [],
    reviews: [],
    reviewPages: null,
    user: { login: "token-owner", type: "User" },
    overrides: {},
  };

  const fetchGithub = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, init });
    const parsed = new URL(url);
    const override = api.overrides[parsed.pathname];
    if (override !== undefined) return override();
    if (parsed.pathname === "/user") return json(api.user);
    if (parsed.pathname === "/repos/acme/widgets/pulls/7") return json(api.pull);
    if (parsed.pathname.endsWith("/check-runs")) return json({ total_count: api.checkRuns.length, check_runs: api.checkRuns });
    if (parsed.pathname === "/repos/acme/widgets/pulls/7/reviews") {
      if (api.reviewPages === null) return json(api.reviews);
      const page: number = Number(parsed.searchParams.get("page") ?? "1");
      const headers: Record<string, string> =
        page < api.reviewPages.length
          ? { link: `<https://api.github.com/repos/acme/widgets/pulls/7/reviews?per_page=100&page=${page + 1}>; rel="next"` }
          : {};
      return json(api.reviewPages[page - 1] ?? [], { headers });
    }
    return json({ message: "Not Found" }, { status: 404 });
  });

  const paste = vi.fn(async (_session: string, _text: string) => ({ submitted: true }));

  const deps: PrEventsPollerDeps = {
    now: () => clock.now,
    loadState: async () =>
      ({ schemaVersion: 2, config: { locations: [], enabledProviders: ["claude"] }, instances: structuredClone(instances), sessionsByKey: {} }) as unknown as DashboardState,
    loadStore: async () => structuredClone(store.current),
    persist: async (file) => {
      store.current = structuredClone(file) as unknown as StoreFile;
    },
    resolveReviewRequest: async () => reviewRequest.current,
    fetchGithub,
    resolveToken: async () => ({ token: FAKE_TOKEN }),
    invalidateToken: vi.fn(),
    readAgentState: async () => ({ state: "idle", updatedAt: new Date(NOW - 3 * 3_600_000).toISOString(), paneJobPid: 4242 }),
    probePane: async () => claudeAgent(4242),
    clientActivity: async () => null,
    paste,
    withLock: async (session, run) => {
      onLock.current();
      return withSessionLock(session, run);
    },
    ...options.overrides,
  };

  return {
    deps,
    api,
    instances,
    clock,
    store,
    fetchCalls,
    paste,
    reviewRequest,
    onLock,
    entry: (id: string) => store.current.instances[id] as StoreEntry,
  };
}

beforeEach(() => {
  _resetPrEventsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pollSweep collecting", () => {
  it("queues a new failed check and a changes-requested review with only structured fields", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.checkRuns = [checkRun(501), checkRun(502, { conclusion: "success" })];
    h.api.reviews = [review(901), review(902, { state: "COMMENTED" })];

    await pollSweep(h.deps);

    const queue: PrEvent[] = h.entry("aaa111").queue;
    expect(queue.map((candidate) => candidate.id).sort()).toEqual(["ci:501", "review:901"]);
    for (const queued of queue) {
      expect(Object.keys(queued).sort()).toEqual(queued.kind === "ci" ? ["author", "id", "kind", "label", "link", "sha"] : ["author", "id", "kind", "label", "link"]);
    }
    const persisted: string = JSON.stringify(h.store.current);
    expect(persisted).not.toContain("SECRET");
    expect(persisted).not.toContain(FAKE_TOKEN);
  });

  it("does not queue the same event twice across sweeps", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);
    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toHaveLength(1);
  });

  it("does not queue an event again after it was delivered", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);
    await pollSweep(h.deps);

    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("reads reviews from the second page", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.reviewPages = [[review(901, { state: "COMMENTED" })], [review(902)]];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["review:902"]);
  });

  it("never follows a Link header to another host", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.overrides["/repos/acme/widgets/pulls/7/reviews"] = () =>
      json([review(901)], { headers: { link: '<https://evil.example/repos/acme/widgets/pulls/7/reviews?page=2>; rel="next"' } });

    await pollSweep(h.deps);

    expect(h.fetchCalls.every((call) => new URL(call.url).host === "api.github.com")).toBe(true);
    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["review:901"]);
  });

  it("reads at most five pages of a listing", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.reviewPages = Array.from({ length: 9 }, (_value, index) => [review(900 + index, { state: "COMMENTED" })]);

    await pollSweep(h.deps);

    const reviewCalls = h.fetchCalls.filter((call) => new URL(call.url).pathname.endsWith("/reviews"));
    expect(reviewCalls.length).toBeLessThanOrEqual(5);
  });

  it("sends the bearer token and never follows redirects", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });

    await pollSweep(h.deps);

    expect(h.fetchCalls.length).toBeGreaterThan(0);
    for (const call of h.fetchCalls) {
      const headers = new Headers(call.init.headers);
      expect(call.url.startsWith("https://api.github.com/")).toBe(true);
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("x-github-api-version")).toBeTruthy();
      expect(headers.get("user-agent")).toBeTruthy();
    }
  });
});

describe("pollSweep bots, own reviews and the user lookup", () => {
  it.each([
    ["Bot type", { login: "some-app", type: "Bot" }],
    ["[bot] suffix", { login: "dependabot[bot]", type: "User" }],
    ["configured bot list", { login: "renovate-helper", type: "User" }],
    ["token owner", { login: "token-owner", type: "User" }],
  ])("drops a review from the %s", async (_name, user) => {
    const h = harness({
      instances: [instance("aaa111", { prEvents: { enabled: true, paused: false, botLogins: ["renovate-helper"] } })],
      store: { aaa111: seededEntry() },
    });
    h.api.reviews = [review(901, { user })];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("holds reviews back when the user lookup fails but keeps delivering CI events", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.checkRuns = [checkRun(501)];
    h.api.reviews = [review(901)];
    h.api.overrides["/user"] = () => json({ message: "boom" }, { status: 500 });

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["ci:501"]);

    h.api.overrides = {};
    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id).sort()).toEqual(["ci:501", "review:901"]);
  });
});

describe("pollSweep seeding and the pull request lifecycle", () => {
  it("seeds what already exists on first enable without queueing it", async () => {
    const h = harness();
    h.api.checkRuns = [checkRun(501)];
    h.api.reviews = [review(901)];

    await pollSweep(h.deps);

    expect(h.entry("aaa111")).toMatchObject({ prNumber: 7, headSha: HEAD, queue: [] });
    expect(h.entry("aaa111").seen).toEqual(expect.arrayContaining(["ci:501", "review:901"]));
  });

  it("queues only what appears after the seed", async () => {
    const h = harness();
    h.api.checkRuns = [checkRun(501)];
    await pollSweep(h.deps);

    h.api.checkRuns = [checkRun(501), checkRun(502)];
    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["ci:502"]);
  });

  it("seeds again and drops the old events when the instance moves to another pull request", async () => {
    const h = harness({ store: { aaa111: seededEntry({ prNumber: 3, queue: [prEvent("ci:1")], seen: ["ci:1"] }) } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").prNumber).toBe(7);
    expect(h.entry("aaa111").queue).toEqual([]);
    expect(h.entry("aaa111").seen).toContain("ci:501");
  });

  it.each([
    ["an entry that is a string", "garbage"],
    ["a wrong prNumber type", { prNumber: "7", headSha: HEAD, seen: [], queue: [] }],
    ["a queue that is not an array", { prNumber: 7, headSha: HEAD, seen: [], queue: "nope" }],
    ["a missing seen list", { prNumber: 7, headSha: HEAD, queue: [] }],
  ])("seeds without queueing when the persisted entry is corrupt (%s)", async (_name, corrupt) => {
    const h = harness({ store: { aaa111: corrupt } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
    expect(h.entry("aaa111").seen).toContain("ci:501");
  });

  it("survives a store file that is not an object", async () => {
    const h = harness({ overrides: { loadStore: async () => "not a store" as never } });

    await expect(pollSweep(h.deps)).resolves.toBeUndefined();
  });

  it.each([
    ["an unknown answer", { state: "unknown" } as ReviewRequest],
    ["a stale none answer", { state: "none", checkedAt: "2026-11-02T11:00:00.000Z", stale: true } as ReviewRequest],
    ["a null answer", null],
  ])("keeps the previous state and does not seed again on %s", async (_name, answer) => {
    const queued: PrEvent[] = [prEvent("ci:1")];
    const h = harness({ store: { aaa111: seededEntry({ queue: queued, seen: ["ci:1"] }) } });
    h.reviewRequest.current = answer;
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);

    expect(h.entry("aaa111")).toEqual(seededEntry({ queue: queued, seen: ["ci:1"] }));
    expect(h.fetchCalls).toEqual([]);
  });

  it.each([
    ["closed", { state: "closed", merged: false }],
    ["merged", { state: "closed", merged: true }],
  ])("clears the queue and reads no checks or reviews once the pull request is %s", async (_name, pull) => {
    const h = harness({ store: { aaa111: seededEntry({ queue: [prEvent("ci:1")] }) } });
    h.api.pull = { ...pull, head: { sha: HEAD } };

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
    expect(getPrEventsStatus().aaa111).toEqual({ status: "no-pr", pending: 0 });
    const paths: string[] = h.fetchCalls.map((call) => new URL(call.url).pathname);
    expect(paths.some((path) => path.endsWith("/check-runs"))).toBe(false);
    expect(paths.some((path) => path.endsWith("/reviews"))).toBe(false);
  });

  it("drops queued check events from an older head sha and keeps reviews", async () => {
    const h = harness({
      store: {
        aaa111: seededEntry({
          headSha: HEAD,
          queue: [prEvent("ci:1", { sha: HEAD }), prEvent("review:2", { kind: "review", sha: undefined, link: "https://github.com/acme/widgets/pull/7#pullrequestreview-2" })],
        }),
      },
    });
    h.api.pull = { state: "open", merged: false, head: { sha: NEW_HEAD } };

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["review:2"]);
    expect(h.entry("aaa111").headSha).toBe(NEW_HEAD);
  });

  it("queues failing checks of the new head after a push", async () => {
    const h = harness({ store: { aaa111: seededEntry({ seen: ["ci:501"] }) } });
    h.api.pull = { state: "open", merged: false, head: { sha: NEW_HEAD } };
    h.api.checkRuns = [checkRun(777)];

    await pollSweep(h.deps);

    const [queued] = h.entry("aaa111").queue;
    expect(queued).toMatchObject({ id: "ci:777", sha: NEW_HEAD });
  });

  it("forgets seen ids only when they vanish from the listing", async () => {
    const h = harness({ store: { aaa111: seededEntry({ seen: ["ci:501", "ci:502", "review:901"] }) } });
    h.api.checkRuns = [checkRun(502)];
    h.api.reviews = [review(901)];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").seen.slice().sort()).toEqual(["ci:502", "review:901"]);
  });

  it("removes persisted entries of instances that no longer exist", async () => {
    const h = harness({ store: { aaa111: seededEntry(), gone999: seededEntry() } });

    await pollSweep(h.deps);

    expect(Object.keys(h.store.current.instances)).toEqual(["aaa111"]);
  });
});

describe("opt-in and pause", () => {
  it.each([
    ["not opted in", { prEvents: undefined }],
    ["explicitly disabled", { prEvents: { enabled: false, paused: false } }],
    ["paused", { prEvents: { enabled: true, paused: true } }],
  ])("polls and delivers nothing for an instance that is %s and keeps its queue", async (_name, overrides) => {
    const queued: PrEvent[] = [prEvent("ci:1")];
    const h = harness({ instances: [instance("aaa111", overrides)], store: { aaa111: seededEntry({ queue: queued }) } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    expect(h.fetchCalls).toEqual([]);
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.entry("aaa111").queue).toEqual(queued);
  });

  it("reports off and paused statuses, keeping the pending count of a paused instance", async () => {
    const h = harness({
      instances: [
        instance("aaa111", { prEvents: { enabled: false, paused: false } }),
        instance("bbb222", { prEvents: { enabled: true, paused: true } }),
      ],
      store: { bbb222: seededEntry({ queue: [prEvent("ci:1"), prEvent("ci:2")] }) },
    });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("off");
    expect(getPrEventsStatus().bbb222).toEqual({ status: "paused", pending: 2 });
  });

  it("does not touch shell-only instances", async () => {
    const h = harness({ instances: [instance("aaa111", { shellOnly: true })] });

    await pollSweep(h.deps);

    expect(h.fetchCalls).toEqual([]);
  });
});

describe("statuses", () => {
  it("reports ok with the pending count", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111).toEqual({ status: "ok", pending: 1 });
  });

  it("reports no-token and makes no request when no token can be found", async () => {
    const h = harness({ overrides: { resolveToken: async () => ({ reason: "no-token" }) } });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("no-token");
    expect(h.fetchCalls).toEqual([]);
  });

  it("reports no-pr when the branch has no pull request", async () => {
    const h = harness();
    h.reviewRequest.current = { state: "none", checkedAt: "2026-11-02T11:59:00.000Z", stale: false };

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("no-pr");
    expect(h.fetchCalls).toEqual([]);
  });

  it.each([
    ["a gitlab merge request", { ...FOUND, kind: "gitlab", url: "https://gitlab.example.com/acme/widgets/-/merge_requests/7" } as ReviewRequest],
    ["a GitHub Enterprise host", { ...FOUND, url: "https://github.example.com/acme/widgets/pull/7" } as ReviewRequest],
    ["a lookalike host", { ...FOUND, url: "https://github.com.evil.example/acme/widgets/pull/7" } as ReviewRequest],
    ["no url", { ...FOUND, url: null } as ReviewRequest],
  ])("reports unsupported and makes no request for %s", async (_name, answer) => {
    const h = harness();
    h.reviewRequest.current = answer;

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("unsupported");
    expect(h.fetchCalls).toEqual([]);
  });

  it("reports error when GitHub keeps failing, without throwing", async () => {
    const h = harness();
    h.api.overrides["/repos/acme/widgets/pulls/7"] = () => json({ message: "boom" }, { status: 500 });

    await expect(pollSweep(h.deps)).resolves.toBeUndefined();

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
  });

  it("only ever exposes status and pending", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);

    expect(Object.keys(getPrEventsStatus().aaa111).sort()).toEqual(["pending", "status"]);
  });
});

describe("GitHub client limits", () => {
  it("invalidates the token on a 401", async () => {
    const h = harness();
    h.api.overrides["/repos/acme/widgets/pulls/7"] = () => json({ message: "Bad credentials" }, { status: 401 });

    await pollSweep(h.deps);

    expect(h.deps.invalidateToken).toHaveBeenCalled();
    expect(getPrEventsStatus().aaa111?.status).toBe("error");
  });

  it.each([403, 429])("backs off after a %s with no rate limit left until the reset time", async (status) => {
    const h = harness();
    const resetEpochSeconds: number = NOW / 1000 + 600;
    h.api.overrides["/repos/acme/widgets/pulls/7"] = () =>
      json({ message: "rate limited" }, { status, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpochSeconds) } });
    await pollSweep(h.deps);

    const callsAfterLimit: number = h.fetchCalls.length;
    h.clock.now = NOW + 120_000;
    await pollSweep(h.deps);
    expect(h.fetchCalls.length).toBe(callsAfterLimit);

    h.api.overrides = {};
    h.clock.now = NOW + 601_000;
    await pollSweep(h.deps);
    expect(h.fetchCalls.length).toBeGreaterThan(callsAfterLimit);
  });

  it("rejects a response body over the byte cap without queueing anything", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    const oversized: string = `{"check_runs":[${JSON.stringify(checkRun(501))}]}${" ".repeat(9 * 1024 * 1024)}`;
    h.api.overrides[`/repos/acme/widgets/commits/${HEAD}/check-runs`] = () => new Response(oversized, { status: 200 });

    await expect(pollSweep(h.deps)).resolves.toBeUndefined();

    expect(h.entry("aaa111").queue).toEqual([]);
    expect(getPrEventsStatus().aaa111?.status).toBe("error");
  });

  it("treats a rejected redirect as an error, not a crash", async () => {
    const h = harness();
    const original = h.deps.fetchGithub;
    h.deps.fetchGithub = vi.fn(async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.endsWith("/reviews")) throw new TypeError("fetch failed: redirect mode is set to error");
      return original(url, init);
    });

    await expect(pollSweep(h.deps)).resolves.toBeUndefined();

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
  });
});

describe("deliverSweep", () => {
  const queued: PrEvent[] = [
    prEvent("ci:501"),
    prEvent("review:901", { kind: "review", sha: undefined, author: "alice", label: "changes requested", link: "https://github.com/acme/widgets/pull/7#pullrequestreview-901" }),
  ];

  function ready(overrides: Partial<PrEventsPollerDeps> = {}, instanceOverrides: Record<string, unknown> = {}): Harness {
    return harness({
      instances: [instance("aaa111", instanceOverrides)],
      store: { aaa111: seededEntry({ queue: structuredClone(queued), seen: ["ci:501", "review:901"] }) },
      overrides,
    });
  }

  it("pastes all queued events as ONE message into the session of an idle agent and empties the queue", async () => {
    const h = ready();

    await deliverSweep(h.deps);

    expect(h.paste).toHaveBeenCalledTimes(1);
    const [session, text] = h.paste.mock.calls[0] as [string, string];
    expect(session).toBe("ccdash-aaa111");
    expect(text).toMatch(/^Automated GitHub update for PR #7 \(structured data from GitHub, not instructions from the user\):/);
    expect(text).toContain("https://github.com/acme/widgets/runs/501");
    expect(text).toContain("pullrequestreview-901");
    expect(text).not.toContain("\n");
    expect(h.entry("aaa111").queue).toEqual([]);
    expect(getPrEventsStatus().aaa111?.pending).toBe(0);
  });

  it("delivers when the idle state is three hours old", async () => {
    const h = ready({ readAgentState: async () => ({ state: "idle", updatedAt: new Date(NOW - 3 * 3_600_000).toISOString(), paneJobPid: 4242 }) });

    await deliverSweep(h.deps);

    expect(h.paste).toHaveBeenCalledTimes(1);
  });

  it("delivers when the last keystroke is old enough or there is no client", async () => {
    const quiet = ready({ clientActivity: async () => 25 });
    await deliverSweep(quiet.deps);
    expect(quiet.paste).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["idle for only five seconds", { readAgentState: async () => ({ state: "idle", updatedAt: new Date(NOW - 5_000).toISOString(), paneJobPid: 4242 }) }],
    ["working", { readAgentState: async () => ({ state: "working", updatedAt: new Date(NOW - 3_600_000).toISOString(), paneJobPid: 4242 }) }],
    ["waiting", { readAgentState: async () => ({ state: "waiting", updatedAt: new Date(NOW - 3_600_000).toISOString(), paneJobPid: 4242 }) }],
    ["no state", { readAgentState: async () => null }],
    ["a pane that no longer matches the recorded process", { probePane: async () => claudeAgent(9999) }],
    ["a pane with no agent", { probePane: async () => ({ kind: "none" }) as PaneAgent }],
    ["an unknown probe result", { probePane: async () => ({ kind: "unknown" }) as PaneAgent }],
    ["a codex agent", { probePane: async () => ({ ...claudeAgent(4242), provider: "codex" }) as PaneAgent }],
    ["a recent client keystroke", { clientActivity: async () => 5 }],
  ] as [string, Partial<PrEventsPollerDeps>][])("types nothing and keeps the queue on %s", async (_name, overrides) => {
    const h = ready(overrides);

    await deliverSweep(h.deps);

    expect(h.paste).not.toHaveBeenCalled();
    expect(h.entry("aaa111").queue).toHaveLength(2);
  });

  it("types nothing into a shell-only instance", async () => {
    const h = ready({}, { shellOnly: true });

    await deliverSweep(h.deps);

    expect(h.paste).not.toHaveBeenCalled();
    expect(h.entry("aaa111").queue).toHaveLength(2);
  });

  it("types nothing into a codex instance", async () => {
    const h = ready({}, { provider: "codex" });

    await deliverSweep(h.deps);

    expect(h.paste).not.toHaveBeenCalled();
  });

  it.each([
    ["paused", (instances: InstanceRecord[]) => void (instances[0] = instance("aaa111", { prEvents: { enabled: true, paused: true } }))],
    ["disabled", (instances: InstanceRecord[]) => void (instances[0] = instance("aaa111", { prEvents: { enabled: false, paused: false } }))],
    ["removed", (instances: InstanceRecord[]) => void instances.splice(0, 1)],
  ])("rechecks inside the lock: an instance %s by then gets nothing and keeps its queue", async (_name, mutate) => {
    const h = ready();
    h.onLock.current = () => mutate(h.instances);

    await deliverSweep(h.deps);

    expect(h.paste).not.toHaveBeenCalled();
    expect(h.entry("aaa111").queue).toHaveLength(2);
  });

  it("pastes once when two ticks overlap", async () => {
    const h = ready();
    h.paste.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { submitted: true };
    });

    await Promise.all([deliverSweep(h.deps), deliverSweep(h.deps)]);

    expect(h.paste).toHaveBeenCalledTimes(1);
  });

  it("does not deliver again when the paste worked but Enter failed", async () => {
    const h = ready();
    h.paste.mockResolvedValue({ submitted: false });

    await deliverSweep(h.deps);
    await deliverSweep(h.deps);

    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("keeps the queue when the paste itself fails and tries again later", async () => {
    const h = ready();
    h.paste.mockRejectedValueOnce(new Error("tmux paste failed"));

    await expect(deliverSweep(h.deps)).resolves.toBeUndefined();
    expect(h.entry("aaa111").queue).toHaveLength(2);

    await deliverSweep(h.deps);
    expect(h.paste).toHaveBeenCalledTimes(2);
    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("does nothing when nothing is queued", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });

    await deliverSweep(h.deps);

    expect(h.paste).not.toHaveBeenCalled();
  });
});

describe("a tick never rejects", () => {
  const failing: [string, Partial<PrEventsPollerDeps>][] = [
    ["loadState", { loadState: async () => Promise.reject(new Error("boom")) }],
    ["loadStore", { loadStore: async () => Promise.reject(new Error("boom")) }],
    ["persist", { persist: async () => Promise.reject(new Error("boom")) }],
    ["resolveReviewRequest", { resolveReviewRequest: async () => Promise.reject(new Error("boom")) }],
    ["fetchGithub", { fetchGithub: async () => Promise.reject(new Error("boom")) }],
    ["resolveToken", { resolveToken: async () => Promise.reject(new Error("boom")) }],
    ["readAgentState", { readAgentState: async () => Promise.reject(new Error("boom")) }],
    ["probePane", { probePane: async () => Promise.reject(new Error("boom")) }],
    ["clientActivity", { clientActivity: async () => Promise.reject(new Error("boom")) }],
    ["paste", { paste: async () => Promise.reject(new Error("boom")) }],
    ["withLock", { withLock: async () => Promise.reject(new Error("boom")) }],
  ];

  it.each(failing)("when %s rejects", async (_name, overrides) => {
    const h = harness({
      store: { aaa111: seededEntry({ queue: [prEvent("ci:1")] }) },
      overrides,
    });
    h.api.checkRuns = [checkRun(501)];

    await expect(pollSweep(h.deps)).resolves.toBeUndefined();
    await expect(deliverSweep(h.deps)).resolves.toBeUndefined();
  });

  it("when GitHub answers with something that is not JSON", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.overrides["/repos/acme/widgets/pulls/7"] = () => new Response("<html>not json</html>", { status: 200 });

    await expect(pollSweep(h.deps)).resolves.toBeUndefined();
  });
});

describe("the token never leaks", () => {
  it("stays out of the console, the status and the persisted file even when everything fails with it in the message", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const leaky = Object.assign(new Error(`request failed with ${FAKE_TOKEN}`), { stderr: FAKE_TOKEN, stdout: FAKE_TOKEN });
    const h = harness({
      store: { aaa111: seededEntry({ queue: [prEvent("ci:1")] }) },
      overrides: {
        fetchGithub: async () => Promise.reject(leaky),
        paste: async () => Promise.reject(leaky),
        readAgentState: async () => Promise.reject(leaky),
      },
    });

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_TOKEN);
    }
    expect(JSON.stringify(getPrEventsStatus())).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(h.store.current)).not.toContain(FAKE_TOKEN);
  });

  it("stays out of the console and persisted file on a normal successful sweep", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_TOKEN);
    }
    expect(JSON.stringify(h.store.current)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(getPrEventsStatus())).not.toContain("http");
  });
});

// ---------------------------------------------------------------------------------------------
// GitLab merge requests on a self-hosted host. Everything below injects its own fetch, token
// resolver and clock: no network, no glab, no git.
// ---------------------------------------------------------------------------------------------

const GL_HOST = "gitlab.example.com";
const GL_PROJECT = "acme/team/widgets";
const GL_ENCODED_PROJECT = "acme%2Fteam%2Fwidgets";
const GL_API = `https://${GL_HOST}/api/v4/`;
const GL_MERGED_RESULTS_SHA = "3333333333333333333333333333333333333333";
const GL_FOUND = {
  ...FOUND,
  kind: "gitlab",
  url: `https://${GL_HOST}/${GL_PROJECT}/-/merge_requests/7`,
} as ReviewRequest;

interface GitlabApi {
  mr: Record<string, unknown>;
  jobs: unknown[];
  approvals: unknown[];
  user: Record<string, unknown>;
  overrides: Record<string, () => Response>;
}

function glJob(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: "rspec", status: "failed", allow_failure: false, trace: "SECRET LOG TEXT", user: { name: "SECRET JOB USER" }, ...overrides };
}

function glApproval(userId: number, username: string): Record<string, unknown> {
  return { user: { id: userId, username, name: "SECRET DISPLAY NAME" }, note: "SECRET APPROVAL NOTE" };
}

function glEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { prNumber: 7, headSha: HEAD, seen: [], queue: [], provider: "gitlab", host: GL_HOST, project: GL_PROJECT, ...overrides };
}

function glEvent(id: string, overrides: Partial<PrEvent> = {}): PrEvent {
  return {
    id,
    kind: "ci",
    author: "gitlab-ci",
    link: `https://${GL_HOST}/${GL_PROJECT}/-/jobs/${id.split(":")[1]}`,
    label: "rspec: failed",
    sha: HEAD,
    ...overrides,
  };
}

interface GitlabHarness extends Harness {
  gl: GitlabApi;
  resolveGitlab: ReturnType<typeof vi.fn>;
  invalidateGitlab: ReturnType<typeof vi.fn>;
  glUrls: () => string[];
}

function gitlabHarness(
  options: {
    instances?: InstanceRecord[];
    store?: Record<string, unknown>;
    overrides?: Partial<PrEventsPollerDeps>;
    review?: ReviewRequest;
    tokenEnv?: Record<string, string>;
  } = {}
): GitlabHarness {
  const instances: InstanceRecord[] = options.instances ?? [instance("aaa111")];
  const gl: GitlabApi = {
    mr: { iid: 7, state: "opened", sha: HEAD, head_pipeline: { id: 300, sha: HEAD } },
    jobs: [],
    approvals: [],
    user: { id: 99, username: "token-owner" },
    overrides: {},
  };
  const resolveGitlab = vi.fn(async (_host: string, _envName?: string, _configured?: Record<string, string>) => ({ token: FAKE_TOKEN }));
  const invalidateGitlab = vi.fn();
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchGitlab = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const pathname: string = parsed.pathname;
    const override = gl.overrides[pathname];
    if (override !== undefined) return override();
    if (pathname === "/api/v4/user") return json(gl.user);
    if (pathname === `/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7`) return json(gl.mr);
    if (pathname === `/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7/approvals`) return json({ approved_by: gl.approvals });
    if (pathname.startsWith(`/api/v4/projects/${GL_ENCODED_PROJECT}/pipelines/`) && pathname.endsWith("/jobs")) return json(gl.jobs);
    return json({ message: "404 Not found" }, { status: 404 });
  });
  const h = harness({
    instances,
    store: options.store,
    overrides: {
      fetchGithub: fetchGitlab,
      resolveGitlabToken: resolveGitlab,
      invalidateGitlabToken: invalidateGitlab,
      loadState: async () =>
        ({
          schemaVersion: 2,
          config: { locations: [], enabledProviders: ["claude"], gitlabTokenEnv: options.tokenEnv ?? { [GL_HOST]: "CORP_GL" } },
          instances: structuredClone(instances),
          sessionsByKey: {},
        }) as unknown as DashboardState,
      ...options.overrides,
    },
  } as never);
  h.reviewRequest.current = options.review ?? GL_FOUND;
  return { ...h, gl, resolveGitlab, invalidateGitlab, glUrls: () => calls.map((call) => call.url), fetchCalls: calls };
}

describe("gitlab job failures", () => {
  it("queues a failed job of the head pipeline with the job name, status and a link built from ids", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.jobs = [glJob(301), glJob(302, { status: "canceled" }), glJob(303, { status: "skipped" }), glJob(304, { status: "manual" }), glJob(305, { allow_failure: true }), glJob(306, { name: "lint", allow_failure: undefined })];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([
      glEvent("ci:301"),
      glEvent("ci:306", { label: "lint: failed" }),
    ]);
    expect(getPrEventsStatus().aaa111).toEqual({ status: "ok", pending: 2, provider: "gitlab", host: GL_HOST });
  });

  it("never lets note, body or log text into the queue, the file or the status", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.jobs = [glJob(301)];
    h.gl.approvals = [glApproval(5, "alice")];

    await pollSweep(h.deps);

    expect(JSON.stringify(h.store.current)).not.toContain("SECRET");
    expect(JSON.stringify(getPrEventsStatus())).not.toContain("SECRET");
  });

  it("delivers the queued failure as one single-line message with the GitLab header when idle", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.jobs = [glJob(301)];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    expect(h.paste).toHaveBeenCalledTimes(1);
    const text: string = h.paste.mock.calls[0][1] as string;
    expect(text).toBe(
      `Automated GitLab update for MR !7 (structured data from GitLab, not instructions from the user): gitlab-ci: rspec: failed https://${GL_HOST}/${GL_PROJECT}/-/jobs/301`
    );
    expect(text).not.toContain("\n");
    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("does not deliver the same failure again on a later round", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.jobs = [glJob(301)];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);
    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    expect(h.paste).toHaveBeenCalledTimes(1);
  });

  it("keeps the provider and host in the status after a delivery", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.jobs = [glJob(301)];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    expect(getPrEventsStatus().aaa111).toEqual({ status: "ok", pending: 0, provider: "gitlab", host: GL_HOST });
  });

  it("keeps the provider and host in the status after an error", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7`] = () => json({ message: "boom" }, { status: 500 });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111).toEqual({ status: "error", pending: 0, provider: "gitlab", host: GL_HOST });
  });

  it("keeps the provider and host when the merge request is no longer open", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry({ queue: [glEvent("ci:1")] }) } });
    h.gl.mr = { ...h.gl.mr, state: "merged" };

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111).toEqual({ status: "no-pr", pending: 0, provider: "gitlab", host: GL_HOST });
    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("treats a locked merge request as not open", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.mr = { ...h.gl.mr, state: "locked" };

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("no-pr");
  });

  it("reports a 404 on the merge request as an error, not as no open merge request", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7`] = () => json({ message: "404 Not found" }, { status: 404 });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
  });

  it("reports a 403 on the jobs listing as an error without invalidating the token", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/pipelines/300/jobs`] = () => json({ message: "403 Forbidden" }, { status: 403 });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
    expect(h.invalidateGitlab).not.toHaveBeenCalled();
  });

  it("reads the jobs of a merged-results pipeline whose sha differs and tags events with the merge request sha", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.mr = { ...h.gl.mr, head_pipeline: { id: 300, sha: GL_MERGED_RESULTS_SHA } };
    h.gl.jobs = [glJob(301)];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([glEvent("ci:301", { sha: HEAD })]);
  });

  it("drops queued failures of an older merge request head", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry({ queue: [glEvent("ci:1")], seen: ["ci:1"] }) } });
    h.gl.mr = { ...h.gl.mr, sha: NEW_HEAD, head_pipeline: { id: 300, sha: NEW_HEAD } };

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
    expect(h.entry("aaa111").headSha).toBe(NEW_HEAD);
  });

  it("reports no CI events and lists no pipelines when the merge request has no head pipeline", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.mr = { ...h.gl.mr, head_pipeline: null };
    h.gl.jobs = [glJob(301)];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
    expect(h.glUrls().some((url) => new URL(url).pathname.includes("/pipelines"))).toBe(false);
    expect(getPrEventsStatus().aaa111?.status).toBe("ok");
  });

  it.each([
    ["a string", "300"],
    ["a fraction", 1.5],
    ["zero", 0],
    ["a negative number", -4],
    ["a path-like string", "../../x"],
    ["an object", { id: 3 }],
  ])("reports an error and requests no jobs when head_pipeline.id is %s", async (_name, id) => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.mr = { ...h.gl.mr, head_pipeline: { id, sha: HEAD } };

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
    expect(h.glUrls().some((url) => new URL(url).pathname.endsWith("/jobs"))).toBe(false);
  });

  it("reports an error when the merge request sha is not 40 hex characters", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.mr = { ...h.gl.mr, sha: "not-a-sha" };

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
  });
});

describe("gitlab approvals", () => {
  it("queues an approval by someone else and delivers it with the merge request link", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.approvals = [glApproval(5, "alice")];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.paste.mock.calls[0][1]).toBe(
      `Automated GitLab update for MR !7 (structured data from GitLab, not instructions from the user): alice: approved https://${GL_HOST}/${GL_PROJECT}/-/merge_requests/7`
    );
  });

  it("ignores the token owner's own approval by user id", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.approvals = [glApproval(99, "renamed-since")];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("ignores configured bot logins", async () => {
    const h = gitlabHarness({
      instances: [instance("aaa111", { prEvents: { enabled: true, paused: false, botLogins: ["review-bot"] } })],
      store: { aaa111: glEntry() },
    });
    h.gl.approvals = [glApproval(6, "Review-Bot")];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("does not notify again about a standing approval or a re-approval by the same person", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.approvals = [glApproval(5, "alice")];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);
    await pollSweep(h.deps);
    await pollSweep(h.deps);

    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.entry("aaa111").queue).toEqual([]);
  });

  it("holds approvals when the user lookup fails but still queues CI failures", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.jobs = [glJob(301)];
    h.gl.approvals = [glApproval(5, "alice")];
    h.gl.overrides["/api/v4/user"] = () => json({ message: "boom" }, { status: 500 });

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["ci:301"]);
    expect(getPrEventsStatus().aaa111?.status).toBe("ok");

    h.gl.overrides = {};
    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id).sort()).toEqual(["ci:301", "review:5"]);
  });

  it.each([403, 404, 500])("holds approvals when the approvals endpoint answers %s but keeps CI going", async (status) => {
    const h = gitlabHarness({ store: { aaa111: glEntry({ seen: ["review:5"] }) } });
    h.gl.jobs = [glJob(301)];
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7/approvals`] = () => json({ message: "no" }, { status });

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["ci:301"]);
    expect(getPrEventsStatus().aaa111?.status).toBe("ok");
    expect(h.entry("aaa111").seen).toContain("review:5");

    h.gl.overrides = {};
    h.gl.approvals = [glApproval(5, "alice")];
    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["ci:301"]);
  });
});

describe("gitlab seeding", () => {
  it("seeds what already exists on first enable without queueing it", async () => {
    const h = gitlabHarness();
    h.gl.jobs = [glJob(301)];
    h.gl.approvals = [glApproval(5, "alice")];

    await pollSweep(h.deps);

    expect(h.entry("aaa111")).toMatchObject({ prNumber: 7, headSha: HEAD, queue: [] });
    expect(h.entry("aaa111").seen).toEqual(expect.arrayContaining(["ci:301", "review:5"]));
    expect(getPrEventsStatus().aaa111).toEqual({ status: "ok", pending: 0, provider: "gitlab", host: GL_HOST });
  });

  it("queues only what appears after the seed", async () => {
    const h = gitlabHarness();
    h.gl.jobs = [glJob(301)];
    await pollSweep(h.deps);

    h.gl.jobs = [glJob(301), glJob(302)];
    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["ci:302"]);
  });

  it("persists provider, host and project in the entry", async () => {
    const h = gitlabHarness();

    await pollSweep(h.deps);

    expect(h.entry("aaa111")).toMatchObject({ provider: "gitlab", host: GL_HOST, project: GL_PROJECT });
  });

  it("seeds again when the host or project changes with the same number", async () => {
    for (const stale of [{ host: "gitlab.other.example.org" }, { project: "acme/other" }, { provider: undefined, host: undefined, project: undefined }]) {
      _resetPrEventsForTests();
      const h = gitlabHarness({ store: { aaa111: glEntry({ queue: [glEvent("ci:1")], seen: ["ci:1"], ...stale }) } });
      h.gl.jobs = [glJob(301)];
      h.gl.approvals = [glApproval(5, "alice")];

      await pollSweep(h.deps);

      expect(h.entry("aaa111").queue).toEqual([]);
      expect(h.entry("aaa111").seen).toEqual(expect.arrayContaining(["ci:301", "review:5"]));
      expect(h.entry("aaa111")).toMatchObject({ provider: "gitlab", host: GL_HOST, project: GL_PROJECT });
    }
  });

  it("makes the round an error and records no seed when the approvals listing fails while seeding", async () => {
    const h = gitlabHarness();
    h.gl.jobs = [glJob(301)];
    h.gl.approvals = [glApproval(5, "alice")];
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7/approvals`] = () => json({ message: "boom" }, { status: 500 });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
    expect(h.store.current.instances.aaa111).toBeUndefined();

    h.gl.overrides = {};
    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
    expect(h.entry("aaa111").seen).toEqual(expect.arrayContaining(["ci:301", "review:5"]));
  });

  it("makes the round an error and records no seed when the user lookup fails while seeding", async () => {
    const h = gitlabHarness();
    h.gl.approvals = [glApproval(5, "alice")];
    h.gl.overrides["/api/v4/user"] = () => json({ message: "boom" }, { status: 500 });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
    expect(h.store.current.instances.aaa111).toBeUndefined();
  });

  it("forgets the baseline after the instance is switched off so enabling again seeds", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.instances[0] = instance("aaa111", { prEvents: { enabled: false, paused: false } });

    await pollSweep(h.deps);

    expect(h.store.current.instances.aaa111).toBeUndefined();
  });
});

describe("gitlab token and host handling", () => {
  it("asks the resolver for the host with the configured variable name and the configured map", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() }, tokenEnv: { [GL_HOST]: "CORP_GL", "git.other.example.org": "OTHER_GL" } });

    await pollSweep(h.deps);

    expect(h.resolveGitlab).toHaveBeenCalledWith(GL_HOST, "CORP_GL", { [GL_HOST]: "CORP_GL", "git.other.example.org": "OTHER_GL" });
  });

  it("asks the resolver without a name when the host is not configured", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() }, tokenEnv: {} });

    await pollSweep(h.deps);

    expect(h.resolveGitlab.mock.calls[0][0]).toBe(GL_HOST);
    expect(h.resolveGitlab.mock.calls[0][1]).toBeUndefined();
  });

  it("reports no-token and makes no request when the resolver finds nothing", async () => {
    const h = gitlabHarness({ overrides: { resolveGitlabToken: async () => ({ reason: "no-token" }) } as never });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111).toEqual({ status: "no-token", pending: 0, provider: "gitlab", host: GL_HOST });
    expect(h.glUrls()).toEqual([]);
  });

  it("reports unsupported and makes no request when the poller has no GitLab token resolver", async () => {
    const h = gitlabHarness({ overrides: { resolveGitlabToken: undefined, invalidateGitlabToken: undefined } as never });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("unsupported");
    expect(h.glUrls()).toEqual([]);
  });

  it("sends every request to https://<host>/api/v4/ with the bearer token, no redirects and a timeout", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.jobs = [glJob(301)];
    h.gl.approvals = [glApproval(5, "alice")];

    await pollSweep(h.deps);

    expect(h.glUrls().length).toBeGreaterThanOrEqual(4);
    for (const call of h.fetchCalls) {
      const parsed = new URL(call.url);
      const headers = new Headers(call.init.headers);
      expect(parsed.origin).toBe(`https://${GL_HOST}`);
      expect(parsed.pathname.startsWith("/api/v4/")).toBe(true);
      expect(parsed.username).toBe("");
      expect(call.url.startsWith(GL_API)).toBe(true);
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(headers.get("user-agent")).toBeTruthy();
    }
  });

  it("encodes the project path as one segment and requests failed jobs with an encoded scope", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });

    await pollSweep(h.deps);

    expect(h.glUrls()).toContain(`${GL_API}projects/${GL_ENCODED_PROJECT}/merge_requests/7`);
    expect(h.glUrls()).toContain(`${GL_API}projects/${GL_ENCODED_PROJECT}/pipelines/300/jobs?scope%5B%5D=failed&per_page=100`);
    expect(h.glUrls()).toContain(`${GL_API}projects/${GL_ENCODED_PROJECT}/merge_requests/7/approvals`);
    expect(h.glUrls()).toContain(`${GL_API}user`);
  });

  it("never follows pagination links, on any host", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    const next = { headers: { link: '<https://evil.example/api/v4/projects/x/jobs?page=2>; rel="next", <https://gitlab.example.com/api/v4/x?page=2>; rel="next"' } };
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/pipelines/300/jobs`] = () => json([glJob(301)], next);

    await pollSweep(h.deps);

    expect(h.glUrls().filter((url) => url.includes("page=2") || url.includes("evil.example"))).toEqual([]);
    expect(h.glUrls().filter((url) => url.includes("/jobs"))).toHaveLength(1);
    expect(h.entry("aaa111").queue.map((candidate) => candidate.id)).toEqual(["ci:301"]);
  });

  it("treats a rejected redirect as an error, not a crash", async () => {
    const h = gitlabHarness({
      store: { aaa111: glEntry() },
      overrides: { fetchGithub: async () => Promise.reject(new TypeError("fetch failed: redirect mode is set to error")) },
    });

    await expect(pollSweep(h.deps)).resolves.toBeUndefined();

    expect(getPrEventsStatus().aaa111?.status).toBe("error");
  });

  it.each([
    ["userinfo", "https://user@gitlab.example.com/acme/widgets/-/merge_requests/7"],
    ["two at signs", "https://a@b@gitlab.example.com/acme/widgets/-/merge_requests/7"],
    ["a backslash", "https://gitlab.example.com\\@evil.example/acme/widgets/-/merge_requests/7"],
    ["a port", "https://gitlab.example.com:8443/acme/widgets/-/merge_requests/7"],
    ["a trailing dot", "https://gitlab.example.com./acme/widgets/-/merge_requests/7"],
    ["an upper case host", "https://GitLab.example.com/acme/widgets/-/merge_requests/7"],
    ["an idn host", "https://gitlab.exämple.com/acme/widgets/-/merge_requests/7"],
    ["an ipv6 host", "https://[::1]/acme/widgets/-/merge_requests/7"],
    ["a dotted ipv4 host", "https://10.0.0.1/acme/widgets/-/merge_requests/7"],
    ["a query", "https://gitlab.example.com/acme/widgets/-/merge_requests/7?x=1"],
    ["a hash", "https://gitlab.example.com/acme/widgets/-/merge_requests/7#note_1"],
    ["a dot dot segment", "https://gitlab.example.com/acme/../-/merge_requests/7"],
    ["http", "http://gitlab.example.com/acme/widgets/-/merge_requests/7"],
    ["a different number", "https://gitlab.example.com/acme/widgets/-/merge_requests/8"],
  ])("rejects a review url with %s as unsupported without resolving a token or requesting anything", async (_name, url) => {
    const h = gitlabHarness({ review: { ...GL_FOUND, url } as ReviewRequest });

    await pollSweep(h.deps);

    expect(getPrEventsStatus().aaa111?.status).toBe("unsupported");
    expect(h.resolveGitlab).not.toHaveBeenCalled();
    expect(h.glUrls()).toEqual([]);
  });

  it("records the provider but no host for an unsupported host that fails validation", async () => {
    const h = gitlabHarness({ review: { ...GL_FOUND, url: "https://10.0.0.1/acme/widgets/-/merge_requests/7" } as ReviewRequest });

    await pollSweep(h.deps);

    const status = getPrEventsStatus().aaa111;
    expect(status?.status).toBe("unsupported");
    expect((status as Record<string, unknown>).provider).toBe("gitlab");
    expect((status as Record<string, unknown>).host).toBeUndefined();
  });

  it("invalidates only that host's token and the user cache on a 401, and reports an error", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7`] = () => json({ message: "401 Unauthorized" }, { status: 401 });

    await pollSweep(h.deps);

    expect(h.invalidateGitlab).toHaveBeenCalledTimes(1);
    expect(h.invalidateGitlab).toHaveBeenCalledWith(GL_HOST);
    expect(h.deps.invalidateToken).not.toHaveBeenCalled();
    expect(getPrEventsStatus().aaa111?.status).toBe("error");
  });

  it("keeps the fake token out of errors, console, status, the persisted file and request urls", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const leaky = Object.assign(new Error(`request failed with ${FAKE_TOKEN}`), { stderr: FAKE_TOKEN, stdout: FAKE_TOKEN });
    const h = gitlabHarness({
      store: { aaa111: glEntry({ queue: [glEvent("ci:1")] }) },
      overrides: { fetchGithub: async () => Promise.reject(leaky), paste: async () => Promise.reject(leaky) },
    });

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(getPrEventsStatus())).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(h.store.current)).not.toContain(FAKE_TOKEN);
  });

  it("keeps the fake token out of urls, status and the file on a successful round", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.jobs = [glJob(301)];
    h.gl.approvals = [glApproval(5, "alice")];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    expect(h.glUrls().join("\n")).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(getPrEventsStatus())).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(h.store.current)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(h.paste.mock.calls)).not.toContain(FAKE_TOKEN);
  });
});

describe("gitlab and github rate limits are independent", () => {
  function twoInstances(order: "gitlab-first" | "github-first") {
    const githubUrls: string[] = [];
    const githubOverride: { current: (() => Response) | null } = { current: null };
    const gitlabInstance = instance("aaa111");
    const githubInstance = instance("bbb222", { tmuxSession: "ccdash-bbb222" });
    const h = gitlabHarness({
      instances: order === "gitlab-first" ? [gitlabInstance, githubInstance] : [githubInstance, gitlabInstance],
      store: { aaa111: glEntry(), bbb222: seededEntry() },
    });
    h.deps.resolveReviewRequest = async (candidate) => (candidate.id === "aaa111" ? GL_FOUND : FOUND);
    const glFetch = h.deps.fetchGithub;
    h.deps.fetchGithub = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.host === "api.github.com") {
        githubUrls.push(url);
        const override = githubOverride.current;
        if (override !== null) return override();
        if (parsed.pathname === "/repos/acme/widgets/pulls/7") return json({ state: "open", head: { sha: HEAD } });
        if (parsed.pathname === "/user") return json({ login: "token-owner" });
        if (parsed.pathname.endsWith("/check-runs")) return json({ check_runs: [] });
        return json([]);
      }
      return glFetch(url, init);
    };
    return Object.assign(h, { githubUrls, githubOverride });
  }

  it("a GitLab 429 backs that host off without pausing GitHub", async () => {
    const h = twoInstances("gitlab-first");
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7`] = () => json({ message: "slow down" }, { status: 429 });

    await pollSweep(h.deps);

    expect(h.githubUrls.length).toBeGreaterThan(0);
    expect(getPrEventsStatus().bbb222?.status).toBe("ok");
  });

  it("a GitHub rate limit does not pause GitLab", async () => {
    const h = twoInstances("github-first");
    h.githubOverride.current = () => json({ message: "limited" }, { status: 429 });

    await pollSweep(h.deps);

    expect(h.glUrls().length).toBeGreaterThan(0);
    expect(getPrEventsStatus().aaa111?.status).toBe("ok");
  });

  it("checks the per-host backoff before resolving a token, so a limited host spawns nothing", async () => {
    const h = gitlabHarness({ store: { aaa111: glEntry() } });
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7`] = () => json({ message: "slow down" }, { status: 429 });
    await pollSweep(h.deps);
    const resolvesAfterLimit: number = h.resolveGitlab.mock.calls.length;
    const requestsAfterLimit: number = h.glUrls().length;

    h.clock.now = NOW + 20_000;
    await pollSweep(h.deps);

    expect(h.resolveGitlab.mock.calls.length).toBe(resolvesAfterLimit);
    expect(h.glUrls().length).toBe(requestsAfterLimit);

    h.gl.overrides = {};
    h.clock.now = NOW + 3_700_000;
    await pollSweep(h.deps);
    expect(h.glUrls().length).toBeGreaterThan(requestsAfterLimit);
  });

  it("honors Retry-After for the limited host only", async () => {
    const other = "git.other.example.org";
    const h = gitlabHarness({
      instances: [instance("aaa111"), instance("bbb222", { tmuxSession: "ccdash-bbb222" })],
      store: { aaa111: glEntry(), bbb222: glEntry({ host: other }) },
      tokenEnv: {},
    });
    h.deps.resolveReviewRequest = async (candidate) =>
      candidate.id === "aaa111" ? GL_FOUND : ({ ...GL_FOUND, url: `https://${other}/${GL_PROJECT}/-/merge_requests/7` } as ReviewRequest);
    h.gl.overrides[`/api/v4/projects/${GL_ENCODED_PROJECT}/merge_requests/7`] = () =>
      json({ message: "slow down" }, { status: 429, headers: { "retry-after": "300" } });

    await pollSweep(h.deps);

    const resolvedHosts: string[] = h.resolveGitlab.mock.calls.map((call) => call[0] as string);
    expect(resolvedHosts).toContain(other);
  });
});

describe("github entries stay unchanged by the GitLab support", () => {
  it("persists a GitHub entry without provider, host or project", async () => {
    const h = harness();
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);

    expect(Object.keys(h.entry("aaa111")).sort()).toEqual(["headSha", "prNumber", "queue", "seen"]);
  });

  it("keeps a GitHub entry's keys after a queueing round and a delivery", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);
    await deliverSweep(h.deps);

    expect(Object.keys(h.entry("aaa111")).sort()).toEqual(["headSha", "prNumber", "queue", "seen"]);
    expect(h.paste.mock.calls[0][1]).toMatch(/^Automated GitHub update for PR #7 \(structured data from GitHub, not instructions from the user\): /);
  });

  it("seeds again when a GitHub review meets an entry persisted for GitLab with the same number", async () => {
    const h = harness({ store: { aaa111: glEntry({ queue: [glEvent("ci:1")], seen: ["ci:1"] }) } });
    h.api.checkRuns = [checkRun(501)];

    await pollSweep(h.deps);

    expect(h.entry("aaa111").queue).toEqual([]);
    expect(h.entry("aaa111").seen).toContain("ci:501");
    expect(Object.keys(h.entry("aaa111")).sort()).toEqual(["headSha", "prNumber", "queue", "seen"]);
  });

  it("never shows provider or host in the status of a GitHub instance", async () => {
    const h = harness({ store: { aaa111: seededEntry() } });

    await pollSweep(h.deps);

    expect(Object.keys(getPrEventsStatus().aaa111).sort()).toEqual(["pending", "status"]);
  });
});
