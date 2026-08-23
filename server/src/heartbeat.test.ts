import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { registerHeartbeat, startHeartbeat } from "./heartbeat";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// index.ts always constructs its WebSocketServer with { noServer: true } and completes the
// upgrade by hand (see the Caddyfile/Vite path this app runs behind). Mirrors that exactly:
// under noServer, ws never emits "connection" (see addListeners in ws's websocket-server.js,
// only wired when the server owns an http.Server directly), which is the whole reason
// registerHeartbeat has to be called from the upgrade callback rather than a "connection"
// listener. A test that instead used { server: httpServer } would let "connection" fire and
// pass even with the old, broken wiring - this setup is what makes it a real regression test.
function startTestServer(): { httpServer: http.Server; wss: WebSocketServer; stopHeartbeat: () => void } {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const stopHeartbeat = startHeartbeat(wss, 20);

  httpServer.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      registerHeartbeat(webSocket);
    });
  });

  return { httpServer, wss, stopHeartbeat };
}

describe("heartbeat", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("keeps a real, responsive client alive across many ticks", async () => {
    const { httpServer, wss, stopHeartbeat } = startTestServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanup = () => {
      stopHeartbeat();
      client.close();
      wss.close();
      httpServer.close();
    };

    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });

    // 20ms interval: 150ms covers 7+ heartbeat sweeps. Before the fix (heartbeat wired to a
    // "connection" listener that never fires under noServer), the socket read as "didn't
    // answer" on the very first sweep and was terminated well within this window.
    await sleep(150);

    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  // Regression test for the crash the audit found: heartbeat used to call ping()/terminate()
  // for every client inside a single try-less loop body, so one bad socket throwing (a race
  // with its own close, an already-destroyed connection) escaped the setInterval callback
  // uncaught - which doesn't just crash the process, it does so via the SAME callback that
  // would otherwise have pinged every other connected terminal on this sweep too.
  it("contains one client's failing ping()/terminate() without aborting the sweep for the others", async () => {
    const badSocket = {
      ping: vi.fn(() => {
        throw new Error("EPIPE");
      }),
      terminate: vi.fn(() => {
        throw new Error("terminate also failed");
      }),
    };
    const goodSocket = { ping: vi.fn(), terminate: vi.fn() };
    // startHeartbeat only touches `.clients` (a Set) and each member's ping()/terminate(), so
    // a minimal fake server object exercises the real containment logic without opening any
    // actual sockets.
    const fakeServer = { clients: new Set([badSocket, goodSocket]) };
    const stopHeartbeat = startHeartbeat(fakeServer as unknown as WebSocketServer, 10);
    cleanup = stopHeartbeat;

    await sleep(30); // several sweeps at a 10ms interval

    expect(badSocket.ping).toHaveBeenCalled();
    // The proof the sweep survived the bad socket's throw and kept going: the good socket
    // still got pinged on the same and/or later sweeps, not just before the bad one ever ran.
    expect(goodSocket.ping).toHaveBeenCalled();
  });
});
