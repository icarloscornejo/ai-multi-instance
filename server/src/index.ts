
import http from "node:http";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { AUTH_COOKIE_NAME, isAuthEnabled, readCookie, verifyToken } from "./auth";
import { apiRouter } from "./routes";
import { loadState } from "./store";
import { bridgeTerminal } from "./terminal";
import type { DashboardState } from "./types";

const serverPort: number = Number(process.env.PORT ?? 3001);
const serverHost: string = process.env.HOST ?? "127.0.0.1";

const app = express();
app.use(express.json());
app.use("/api", apiRouter);

// In production mode (npm start) the server serves the pre-built frontend
const webDistPath: string = path.resolve(import.meta.dirname, "../../web/dist");
app.use(express.static(webDistPath));

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  console.error("[server] unhandled error:", error.message);
  response.status(500).json({ error: error.message });
});

const httpServer = http.createServer(app);
const webSocketServer = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const pathMatch = requestUrl.pathname.match(/^\/ws\/terminal\/([\w-]+)$/);
  if (pathMatch === null) {
    socket.destroy();
    return;
  }
  const instanceId: string = pathMatch[1];
  const requestedCols: number = Number(requestUrl.searchParams.get("cols"));
  const requestedRows: number = Number(requestUrl.searchParams.get("rows"));
  const initialSize =
    Number.isInteger(requestedCols) && Number.isInteger(requestedRows) && requestedCols > 0 && requestedRows > 0
      ? { cols: requestedCols, rows: requestedRows }
      : null;

  void (async () => {
    // The WS upgrade is the real attack surface (it reads/writes the terminal
    // directly), so it needs the same cookie check as the REST API even though
    // the static HTML/assets stay open.
    if (isAuthEnabled()) {
      const token: string | undefined = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
      const isValid: boolean = await verifyToken(token);
      if (!isValid) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    completeUpgrade();
  })().catch((error: Error) => {
    console.error("[server] failed to authorize websocket upgrade:", error.message);
    socket.destroy();
  });

  function completeUpgrade(): void {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket: WebSocket) => {
      // bridgeTerminal performs several awaits (loadState here, and hasSession/createSession
      // inside) before it can hook into live messages; the client may send its initial
      // "resize" (and even type) throughout that window. "ws" does not buffer messages
      // for an EventEmitter with no listener: without this synchronous buffer (which stays
      // active until bridgeTerminal installs its own handler), that first resize is lost
      // forever and the pty keeps the fallback size (see terminal.ts) until the client
      // triggers the next real resize.
      const pendingMessages: RawData[] = [];
      const bufferMessage = (rawMessage: RawData): void => {
        pendingMessages.push(rawMessage);
      };
      webSocket.on("message", bufferMessage);

      void (async () => {
        const state: DashboardState = await loadState();
        const instance = state.instances.find((candidate) => candidate.id === instanceId);
        if (instance === undefined) {
          webSocket.removeListener("message", bufferMessage);
          webSocket.close(4004, "Unknown instance");
          return;
        }
        await bridgeTerminal(webSocket, instance, initialSize, pendingMessages, () =>
          webSocket.removeListener("message", bufferMessage)
        );
      })().catch((error: Error) => {
        console.error(`[server] failed to attach instance ${instanceId}:`, error.message);
        webSocket.close(4000, error.message.slice(0, 120));
      });
    });
  }
});

httpServer.listen(serverPort, serverHost, () => {
  console.log(`[server] listening on http://${serverHost}:${serverPort}`);
});
