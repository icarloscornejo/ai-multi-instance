import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fs is fully stubbed: the stateful tests below write/remove the `enabled` sentinel, and we
// never want that touching the real data/named-tunnel/ directory.
const fsState: { sentinel: boolean } = { sentinel: false };
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  existsSync: vi.fn(() => true),
  promises: {
    access: vi.fn(async () => {
      if (!fsState.sentinel) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => {
      fsState.sentinel = true;
    }),
    rm: vi.fn(async () => {
      fsState.sentinel = false;
    }),
  },
}));

// launchctl: each spawn returns a fake child we can drive. `nextExitCode` controls what the
// next spawned process exits with.
const spawnCalls: string[][] = [];
let nextExitCode = 0;
vi.mock("node:child_process", () => ({
  spawn: vi.fn((_command: string, args: string[]) => {
    spawnCalls.push(args);
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("exit", nextExitCode));
    return child;
  }),
}));

// verifyEdge is exercised by its own tests in tunnel.test.ts; here we just need it to not make
// real network calls when computeStatus() runs.
vi.mock("./tunnel", () => ({
  verifyEdge: vi.fn(async () => ({ outcome: "ok" })),
}));

import {
  buildKickstartArgs,
  buildKillArgs,
  classifyReady,
  getNamedTunnelStatus,
  startNamedTunnel,
  stopNamedTunnel,
  validateNamedTunnelConfig,
} from "./namedTunnel";
import { readFileSync } from "node:fs";

const VALID_CONFIG = JSON.stringify({
  hostname: "protom4-mi.example.com",
  tunnelName: "protom4-dashboard",
  tunnelId: "0348d31e-9dce-485b-84f3-842a2ef6578e",
  credentialsFile: "/Users/x/.cloudflared/0348d31e.json",
  metricsPort: 20241,
  protocol: "auto",
});

describe("validateNamedTunnelConfig", () => {
  it("accepts a well-formed config", () => {
    const result = validateNamedTunnelConfig(VALID_CONFIG);
    expect(result.kind).toBe("ok");
  });

  it("rejects malformed JSON as invalid, never as absent", () => {
    expect(validateNamedTunnelConfig("{not json").kind).toBe("invalid");
  });

  it("rejects a missing or empty required field", () => {
    expect(validateNamedTunnelConfig(JSON.stringify({ ...JSON.parse(VALID_CONFIG), hostname: "" })).kind).toBe("invalid");
    const withoutId: Record<string, unknown> = JSON.parse(VALID_CONFIG);
    delete withoutId.tunnelId;
    expect(validateNamedTunnelConfig(JSON.stringify(withoutId)).kind).toBe("invalid");
  });

  it("rejects a bad metrics port", () => {
    expect(validateNamedTunnelConfig(JSON.stringify({ ...JSON.parse(VALID_CONFIG), metricsPort: 0 })).kind).toBe("invalid");
    expect(validateNamedTunnelConfig(JSON.stringify({ ...JSON.parse(VALID_CONFIG), metricsPort: "20241" })).kind).toBe(
      "invalid"
    );
  });

  it("rejects an unsupported protocol", () => {
    expect(validateNamedTunnelConfig(JSON.stringify({ ...JSON.parse(VALID_CONFIG), protocol: "h3" })).kind).toBe("invalid");
  });
});

describe("classifyReady", () => {
  it("is not ok for a non-200 response", () => {
    expect(classifyReady(503, "")).toEqual({ ok: false, readyConnections: 0 });
    expect(classifyReady(undefined, "")).toEqual({ ok: false, readyConnections: 0 });
  });

  it("is not ok when there are zero ready connections", () => {
    expect(classifyReady(200, JSON.stringify({ readyConnections: 0 }))).toEqual({ ok: false, readyConnections: 0 });
  });

  it("is ok with at least one ready connection and reports the count", () => {
    expect(classifyReady(200, JSON.stringify({ readyConnections: 4 }))).toEqual({ ok: true, readyConnections: 4 });
  });

  it("is not ok for a malformed body", () => {
    expect(classifyReady(200, "not json")).toEqual({ ok: false, readyConnections: 0 });
  });
});

describe("launchctl argument construction", () => {
  it("targets the tunnel LaunchAgent in the caller's gui domain", () => {
    expect(buildKickstartArgs(501)).toEqual(["kickstart", "gui/501/com.ai-multi-instance.tunnel"]);
    expect(buildKillArgs(501)).toEqual(["kill", "SIGTERM", "gui/501/com.ai-multi-instance.tunnel"]);
  });
});

describe("start / stop transitions", () => {
  beforeEach(() => {
    fsState.sentinel = false;
    spawnCalls.length = 0;
    nextExitCode = 0;
    vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);
    // /ready: default to "up with 4 connections" so start resolves quickly.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ readyConnections: 4 }) }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("start writes the sentinel and kickstarts the service", async () => {
    const status = await startNamedTunnel();
    expect(fsState.sentinel).toBe(true);
    expect(spawnCalls).toContainEqual(["kickstart", "gui/" + (process.getuid?.() ?? 0) + "/com.ai-multi-instance.tunnel"]);
    expect(status.state).toBe("running");
    expect(status.mode).toBe("named");
  });

  it("a failed kickstart rolls the sentinel back and reports an error", async () => {
    nextExitCode = 1;
    const status = await startNamedTunnel();
    expect(fsState.sentinel).toBe(false);
    expect(status.state).toBe("error");
  });

  it("concurrent start calls share one in-flight run", async () => {
    const [a, b] = await Promise.all([startNamedTunnel(), startNamedTunnel()]);
    expect(a).toEqual(b);
    const kickstarts = spawnCalls.filter((args) => args[0] === "kickstart");
    expect(kickstarts).toHaveLength(1);
  });

  it("stop removes the sentinel and sends SIGTERM", async () => {
    fsState.sentinel = true;
    // /ready reports down so the drain loop exits immediately.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 503, text: async () => "" }))
    );
    const status = await stopNamedTunnel();
    expect(fsState.sentinel).toBe(false);
    expect(spawnCalls).toContainEqual(["kill", "SIGTERM", "gui/" + (process.getuid?.() ?? 0) + "/com.ai-multi-instance.tunnel"]);
    expect(status.state).toBe("stopped");
  });

  it("status is 'stopped' when the sentinel is absent", async () => {
    fsState.sentinel = false;
    const status = await getNamedTunnelStatus();
    expect(status.state).toBe("stopped");
  });

  it("status is 'error' when the config is invalid", async () => {
    vi.mocked(readFileSync).mockReturnValue("{ broken");
    const status = await getNamedTunnelStatus();
    expect(status.state).toBe("error");
  });
});
