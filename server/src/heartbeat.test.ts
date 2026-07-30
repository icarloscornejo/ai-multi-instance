import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
});
