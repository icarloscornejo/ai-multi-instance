import type { WebSocket, WebSocketServer } from "ws";

// Detects a WS killed at the OS/network layer (mobile backgrounding, a Cloudflare tunnel edge
// dropping state, a NAT timing out) without either side ever seeing a "close" event: readyState
// stays OPEN and no error fires. Pinging every connection and terminating whichever one didn't
// pong since the last tick surfaces a real "close" event to the client promptly instead of
// relying on a TCP timeout that can take minutes (or never happen) over a mobile network. It
// also stops the tmux attach process in terminal.ts from leaking behind a dead client, since
// that process is only killed by the socket's own "close" handler.
//
// registerHeartbeat MUST be called from the upgrade site (see index.ts's completeUpgrade),
// not from a webSocketServer.on("connection", ...) handler: this server is always constructed
// with { noServer: true } (the upgrade is completed by hand against the Vite dev server's
// path), and ws only emits "connection" when it owns the underlying http.Server itself (see
// addListeners in ws's websocket-server.js). Under noServer, that event never fires, so a
// socket ends up tracked in wss.clients (clientTracking defaults to true, independent of
// "connection") but never seeded into socketIsAlive here and never wired to "pong" - every
// socket then reads as "didn't answer" on the very first sweep and gets terminated, regardless
// of whether it's actually alive. That silent mismatch is exactly the bug this file exists to
// make impossible: registerHeartbeat is called once, synchronously, at the one place a socket
// is guaranteed to exist and be about to join wss.clients.
const socketIsAlive = new WeakMap<WebSocket, boolean>();

export function registerHeartbeat(webSocket: WebSocket): void {
  socketIsAlive.set(webSocket, true);
  webSocket.on("pong", () => {
    socketIsAlive.set(webSocket, true);
  });
}

// Returns a stop function so callers (and tests) can tear the interval down deterministically
// instead of leaking it. intervalMs is a parameter (not a module-level constant) so the test
// can run this on a short tick without waiting out the real 15s in CI.
export function startHeartbeat(server: WebSocketServer, intervalMs: number): () => void {
  const interval = setInterval(() => {
    for (const webSocket of server.clients) {
      // Only terminate a socket this loop itself marked "didn't answer" last tick; a socket
      // with no entry yet (mid-upgrade, not registered) is left alone rather than read as dead.
      if (socketIsAlive.get(webSocket) === false) {
        webSocket.terminate();
        continue;
      }
      socketIsAlive.set(webSocket, false);
      webSocket.ping();
    }
  }, intervalMs);

  return () => clearInterval(interval);
}
