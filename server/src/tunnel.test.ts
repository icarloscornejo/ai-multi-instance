import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyPreflight, extractTunnelUrl } from "./tunnel";

// Shape of the real production build's index.html (web/dist/index.html, produced by
// updateTransaction.ts): a hashed script bundle, not the dev-only /src/main.tsx module path.
const APP_SHELL_BODY =
  '<html><head><title>AI Multi-Instance</title><link rel="icon" href="/ai-multi-instance.svg" />' +
  '<script type="module" crossorigin src="/assets/index-q-rZD3FO.js"></script></head>' +
  '<body><div id="root"></div></body></html>';

// A generic React/Vite app shell that happens to share the two markers this preflight used to
// rely on (`<div id="root">`, an `/assets/` path) but isn't THIS app - the exact case
// classifyPreflight exists to rule out (Caddy answering, but fronting some unrelated service).
const GENERIC_REACT_VITE_BODY =
  '<html><head><title>Some Other App</title>' +
  '<script type="module" crossorigin src="/assets/index-abc123.js"></script></head>' +
  '<body><div id="root"></div></body></html>';

// startTunnel() writes cloudflared's own stdout/stderr straight to data/cloudflared.log (see
// tunnel.ts's dataDirectory comment); stubbing fs here keeps the state-machine tests below from
// clobbering that real, user-facing log file on disk.
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
}));

// checkCaddyReachable() preflights over node:http before startTunnel ever spawns cloudflared;
// mocking it lets each test choose "Caddy is up and serving this app" without a real Caddy/Vite
// pair running, and without pulling checkCaddyReachable's internals into scope.
class FakeIncomingMessage extends EventEmitter {
  statusCode: number;
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
}

function mockHttpGetOk(): void {
  vi.doMock("node:http", () => ({
    default: {
      get: (
        _options: unknown,
        callback: (response: FakeIncomingMessage) => void
      ): { on: () => void } => {
        // Deferred to a microtask, like a real socket callback: checkCaddyReachable assigns
        // its connectTimer *after* this call returns, and clearTimeout(connectTimer) runs
        // inside the response callback, so firing synchronously here would read it before
        // that const is initialized.
        queueMicrotask(() => {
          const response = new FakeIncomingMessage(200);
          callback(response);
          queueMicrotask(() => {
            response.emit("data", Buffer.from(APP_SHELL_BODY));
            response.emit("end");
          });
        });
        return { on: (): void => undefined };
      },
    },
  }));
}

// A minimal stand-in for the ChildProcess spawn("cloudflared", [...]) returns: just enough of
// the EventEmitter surface (stdout/stderr 'data', process 'error'/'exit') that startTunnel's
// handlers attach without throwing, plus a spy-able kill().
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe("startTunnel state machine", () => {
  let fakeChild: FakeChildProcess;
  let spawnMock: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mockHttpGetOk();
    fakeChild = new FakeChildProcess();
    spawnMock = vi.fn(() => fakeChild);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock("node:http");
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
  });

  function emitUrl(url: string): void {
    fakeChild.stderr.emit("data", Buffer.from(`  |  ${url}  |\n`));
  }

  it("walks checking-caddy -> launching -> verifying -> running on a clean success", async () => {
    const { startTunnel, getTunnelStatus } = await import("./tunnel");
    fetchMock.mockResolvedValue(new Response(APP_SHELL_BODY, { status: 200 }));

    const startPromise = startTunnel();
    // Preflight (checkCaddyReachable) resolves on a microtask; let it settle before the spawn
    // happens, mirroring startTunnel's real await boundary.
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    expect(getTunnelStatus().phase).toBe("launching");

    emitUrl("https://random-words-here.trycloudflare.com");
    expect(getTunnelStatus().phase).toBe("verifying");
    expect(getTunnelStatus().url).toBe("https://random-words-here.trycloudflare.com");

    const result = await startPromise;
    expect(result.state).toBe("running");
    expect(result.phase).toBeNull();
    expect(result.error).toBeNull();
    expect(result.warning).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries verifyEdge exactly once (2 attempts total) on a transport error, then reports a warning instead of an error", async () => {
    const { startTunnel } = await import("./tunnel");
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const startPromise = startTunnel();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    emitUrl("https://random-words-here.trycloudflare.com");

    // Single backoff between the two attempts (EDGE_VERIFY_BACKOFFS_MS = [1_500]).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const result = await startPromise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.state).toBe("running");
    expect(result.phase).toBeNull();
    expect(result.error).toBeNull();
    expect(result.warning).not.toBeNull();
  });

  it("does not retry a bad-response outcome (real HTTP answer, just the wrong one)", async () => {
    const { startTunnel } = await import("./tunnel");
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));

    const startPromise = startTunnel();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    emitUrl("https://random-words-here.trycloudflare.com");

    const result = await startPromise;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("error");
    expect(result.phase).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.warning).toBeNull();
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it("clears phase and warning on stopTunnel", async () => {
    const { startTunnel, stopTunnel, getTunnelStatus } = await import("./tunnel");
    fetchMock.mockResolvedValue(new Response(APP_SHELL_BODY, { status: 200 }));

    const startPromise = startTunnel();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    emitUrl("https://random-words-here.trycloudflare.com");
    await startPromise;

    const stopped = stopTunnel();
    expect(stopped.state).toBe("stopped");
    expect(stopped.phase).toBeNull();
    expect(stopped.warning).toBeNull();
    expect(getTunnelStatus().url).toBeNull();
  });

  // D1: single-flight ownership via a generation counter, established before the first await
  // (the Caddy preflight) rather than after it - see attemptStart in tunnel.ts.
  describe("generation-owned single-flight and auto-restart (D1/D2)", () => {
    // spawnMock in the outer beforeEach always returns the SAME fakeChild; these tests need a
    // distinct child per spawn (to simulate the old one dying and a new one taking over), so
    // each test that needs it overrides the implementation to push onto this array instead.
    function trackSpawnedChildren(): FakeChildProcess[] {
      const children: FakeChildProcess[] = [];
      spawnMock.mockImplementation(() => {
        const newChild = new FakeChildProcess();
        children.push(newChild);
        return newChild;
      });
      return children;
    }

    function emitUrlOn(target: FakeChildProcess, url: string): void {
      target.stderr.emit("data", Buffer.from(`  |  ${url}  |\n`));
    }

    it("concurrent startTunnel() calls spawn only a single cloudflared child", async () => {
      const { startTunnel } = await import("./tunnel");
      fetchMock.mockImplementation(() => Promise.resolve(new Response(APP_SHELL_BODY, { status: 200 })));

      const [firstCall, secondCall, thirdCall] = [startTunnel(), startTunnel(), startTunnel()];
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      emitUrl("https://random-words-here.trycloudflare.com");

      const [first, second, third] = await Promise.all([firstCall, secondCall, thirdCall]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(first.state).toBe("running");
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    it("stopping during the Caddy preflight prevents cloudflared from ever being spawned", async () => {
      const { startTunnel, stopTunnel, getTunnelStatus } = await import("./tunnel");
      fetchMock.mockImplementation(() => Promise.resolve(new Response(APP_SHELL_BODY, { status: 200 })));

      const startPromise = startTunnel();
      // No await between startTunnel() and here: races stopTunnel against the preflight's
      // own queued microtasks (see mockHttpGetOk), exactly the "stop during preflight" case
      // the audit flagged as unguarded before generation checks existed.
      stopTunnel();
      await startPromise;

      expect(spawnMock).not.toHaveBeenCalled();
      expect(getTunnelStatus().state).toBe("stopped");
    });

    it("stopping during edge verification does not let the stale attempt resurrect a cleared status", async () => {
      const { startTunnel, stopTunnel, getTunnelStatus } = await import("./tunnel");
      let resolveFetch: ((value: Response) => void) | undefined;
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));

      const startPromise = startTunnel();
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      emitUrl("https://random-words-here.trycloudflare.com");
      await vi.waitFor(() => expect(getTunnelStatus().phase).toBe("verifying"));

      stopTunnel();
      resolveFetch?.(new Response(APP_SHELL_BODY, { status: 200 }));
      await startPromise;

      const status = getTunnelStatus();
      expect(status.state).toBe("stopped");
      expect(status.url).toBeNull();
    });

    it("restarts with backoff after an unexpected non-zero exit while the tunnel is still desired", async () => {
      const children = trackSpawnedChildren();
      const { startTunnel, getTunnelStatus } = await import("./tunnel");
      fetchMock.mockImplementation(() => Promise.resolve(new Response(APP_SHELL_BODY, { status: 200 })));

      const startPromise = startTunnel();
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      emitUrlOn(children[0], "https://first.trycloudflare.com");
      await startPromise;
      expect(getTunnelStatus().state).toBe("running");

      children[0].emit("exit", 1);
      expect(getTunnelStatus().state).toBe("stopped");
      // Not yet: the restart is scheduled behind the first backoff step, not immediate.
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      emitUrlOn(children[1], "https://second.trycloudflare.com");
      await vi.waitFor(() => expect(getTunnelStatus().state).toBe("running"));
      expect(getTunnelStatus().url).toBe("https://second.trycloudflare.com");
    });

    // D2's core requirement: restart is driven by desiredRunning, not by the exit code. Code
    // 0 only used to suppress the displayed error text - it must never also suppress recovery,
    // or cloudflared giving up cleanly would leave the tunnel dead forever despite the user
    // still wanting it running.
    it("also restarts after a clean exit code 0, not just a non-zero one", async () => {
      const children = trackSpawnedChildren();
      const { startTunnel, getTunnelStatus } = await import("./tunnel");
      fetchMock.mockImplementation(() => Promise.resolve(new Response(APP_SHELL_BODY, { status: 200 })));

      const startPromise = startTunnel();
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      emitUrlOn(children[0], "https://first.trycloudflare.com");
      await startPromise;

      children[0].emit("exit", 0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    });

    it("an explicit stopTunnel cancels a pending auto-restart", async () => {
      const children = trackSpawnedChildren();
      const { startTunnel, stopTunnel, getTunnelStatus } = await import("./tunnel");
      fetchMock.mockImplementation(() => Promise.resolve(new Response(APP_SHELL_BODY, { status: 200 })));

      const startPromise = startTunnel();
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      emitUrlOn(children[0], "https://first.trycloudflare.com");
      await startPromise;

      children[0].emit("exit", 1); // schedules a restart
      stopTunnel(); // must cancel it

      await vi.advanceTimersByTimeAsync(60_000); // exhaust every possible backoff step
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(getTunnelStatus().state).toBe("stopped");
    });

    it("calling startTunnel again during a pending restart backoff starts immediately instead of waiting", async () => {
      const children = trackSpawnedChildren();
      const { startTunnel, getTunnelStatus } = await import("./tunnel");
      fetchMock.mockImplementation(() => Promise.resolve(new Response(APP_SHELL_BODY, { status: 200 })));

      const firstStart = startTunnel();
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      emitUrlOn(children[0], "https://first.trycloudflare.com");
      await firstStart;

      children[0].emit("exit", 1); // schedules a restart ~1s out
      const secondStart = startTunnel(); // must not wait for the backoff
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      emitUrlOn(children[1], "https://second.trycloudflare.com");
      await secondStart;
      expect(getTunnelStatus().url).toBe("https://second.trycloudflare.com");
    });

    // The exact hazard finding 5 (round 2 of the audit) flagged: every child's exit handler
    // must verify it still belongs to the CURRENT generation before mutating shared status -
    // otherwise a slow-to-die superseded child can stomp a brand new, healthy tunnel back to
    // "stopped".
    it("a stale child's late exit, after a restart has already replaced it, does not overwrite the current status", async () => {
      const children = trackSpawnedChildren();
      const { startTunnel, getTunnelStatus } = await import("./tunnel");
      fetchMock.mockImplementation(() => Promise.resolve(new Response(APP_SHELL_BODY, { status: 200 })));

      const startPromise = startTunnel();
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      emitUrlOn(children[0], "https://first.trycloudflare.com");
      await startPromise;

      children[0].emit("exit", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      emitUrlOn(children[1], "https://second.trycloudflare.com");
      await vi.waitFor(() => expect(getTunnelStatus().state).toBe("running"));
      expect(getTunnelStatus().url).toBe("https://second.trycloudflare.com");

      // The OLD (already-superseded) child finally reports its own exit, late.
      children[0].emit("exit", 1);
      expect(getTunnelStatus().state).toBe("running");
      expect(getTunnelStatus().url).toBe("https://second.trycloudflare.com");
    });
  });
});

describe("extractTunnelUrl", () => {
  it("extracts the trycloudflare URL from a stderr chunk", () => {
    const chunk = "2026-07-21T12:00:00Z INF |  https://random-words-here.trycloudflare.com  | \n";
    expect(extractTunnelUrl(chunk)).toBe("https://random-words-here.trycloudflare.com");
  });

  it("returns null when no URL is present yet", () => {
    expect(extractTunnelUrl("2026-07-21T12:00:00Z INF Starting tunnel\n")).toBeNull();
  });

  it("ignores unrelated https URLs", () => {
    expect(extractTunnelUrl("Connecting to https://api.cloudflare.com/health\n")).toBeNull();
  });

  it("finds the URL across accumulated multi-line output", () => {
    const chunk =
      "line one\nline two\n" +
      "+--------------------------------------------------------------------------------------------+\n" +
      "|  https://another-example.trycloudflare.com                                                  |\n" +
      "+--------------------------------------------------------------------------------------------+\n";
    expect(extractTunnelUrl(chunk)).toBe("https://another-example.trycloudflare.com");
  });
});

describe("classifyPreflight", () => {
  it("classifies a 200 with the app-shell markers as ok", () => {
    expect(classifyPreflight(200, APP_SHELL_BODY)).toBe("ok");
  });

  it("classifies a 200 without the app-shell markers as wrong-origin", () => {
    expect(classifyPreflight(200, "<html><body>Hello from some other server</body></html>")).toBe("wrong-origin");
  });

  // The exact bug this preflight would have had with a generic marker like `<div id="root">` or
  // `/assets/`: those are common to any React/Vite build, so Caddy could be misconfigured to
  // front a completely different app and this would have falsely reported "ok".
  it("classifies a 200 from a DIFFERENT React/Vite app (same generic markers) as wrong-origin", () => {
    expect(classifyPreflight(200, GENERIC_REACT_VITE_BODY)).toBe("wrong-origin");
  });

  it("classifies a 404 as wrong-origin", () => {
    expect(classifyPreflight(404, "Not Found")).toBe("wrong-origin");
  });

  it("classifies a 502 as upstream-down", () => {
    expect(classifyPreflight(502, "")).toBe("upstream-down");
  });

  it("classifies a 503 as upstream-down", () => {
    expect(classifyPreflight(503, "")).toBe("upstream-down");
  });

  it("classifies a blocked/rejected response as wrong-origin", () => {
    expect(classifyPreflight(403, "Blocked request. This host is not allowed.")).toBe("wrong-origin");
  });
});
