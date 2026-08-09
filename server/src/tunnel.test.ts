import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyPreflight, extractTunnelUrl } from "./tunnel";

const APP_SHELL_BODY = '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';

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

  it("classifies a 404 as wrong-origin", () => {
    expect(classifyPreflight(404, "Not Found")).toBe("wrong-origin");
  });

  it("classifies a 502 as upstream-down", () => {
    expect(classifyPreflight(502, "")).toBe("upstream-down");
  });

  it("classifies a 503 as upstream-down", () => {
    expect(classifyPreflight(503, "")).toBe("upstream-down");
  });

  it("classifies Vite's host-check rejection as wrong-origin", () => {
    expect(classifyPreflight(403, "Blocked request. This host is not allowed.")).toBe("wrong-origin");
  });
});
