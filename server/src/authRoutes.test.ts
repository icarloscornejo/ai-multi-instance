import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real routes.ts and auth.ts, with everything around them stubbed the way instancesRoute.test.ts
// does. The secret and password files are served from memory (see auth.test.ts) so nothing here
// can touch the real data/ directory.
const secretFilePath: string = path.resolve(import.meta.dirname, "../../data/auth-secret.txt");

const fakeFiles = vi.hoisted(() => new Map<string, string>());
// failOnWriteNumber is 1-based and counts store writes since the last reset, so a test can let
// the password write succeed and fail the secret rotation that follows it.
const writeFailures = vi.hoisted(() => ({ writeCount: 0, failOnWriteNumber: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isFakePath = (filePath: unknown): filePath is string =>
    typeof filePath === "string" && /auth-(secret\.txt|password\.json)$/.test(filePath);
  const missingFileError = (): Error => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const readFile = actual.promises.readFile as (...args: unknown[]) => Promise<unknown>;
  const readFileSync = actual.readFileSync as (...args: unknown[]) => unknown;
  const patched = {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: async (filePath: unknown, ...rest: unknown[]) => {
        if (!isFakePath(filePath)) {
          return readFile(filePath, ...rest);
        }
        const content: string | undefined = fakeFiles.get(filePath);
        if (content === undefined) {
          throw missingFileError();
        }
        return content;
      },
    },
    readFileSync: (filePath: unknown, ...rest: unknown[]) => {
      if (!isFakePath(filePath)) {
        return readFileSync(filePath, ...rest);
      }
      const content: string | undefined = fakeFiles.get(filePath);
      if (content === undefined) {
        throw missingFileError();
      }
      return content;
    },
  };
  return { ...patched, default: patched };
});

vi.mock("./store", () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
  updateState: vi.fn(),
  writeStateFileAtomic: vi.fn(async (filePath: string, content: string): Promise<void> => {
    writeFailures.writeCount += 1;
    if (writeFailures.writeCount === writeFailures.failOnWriteNumber) {
      throw new Error("ENOSPC: no space left on device");
    }
    fakeFiles.set(filePath, content);
  }),
}));
vi.mock("./paths", () => ({ pathExists: vi.fn() }));
vi.mock("./terminal", () => ({ initializeInstanceSession: vi.fn() }));
vi.mock("./tmux", () => ({
  getOriginalPanePid: vi.fn(),
  getPaneCurrentPath: vi.fn(),
  getSessionPresence: vi.fn(),
  killSession: vi.fn(),
}));
vi.mock("./tunnel", () => ({
  getTunnelStatus: vi.fn(),
  readTunnelLog: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
}));
// The real getTunnelMode() reads data/named-tunnel/tunnel.json, which exists on the dev machine.
vi.mock("./namedTunnel", () => ({
  getTunnelMode: () => "quick",
  getNamedTunnelStatus: vi.fn(),
  startNamedTunnel: vi.fn(),
  stopNamedTunnel: vi.fn(),
}));
vi.mock("./updater", () => ({
  applyUpdate: vi.fn(),
  checkForUpdate: vi.fn(),
  getUpdateStatus: vi.fn(),
  resetToRemote: vi.fn(),
}));
vi.mock("./reviewRequests", () => ({ reviewRequestFor: vi.fn() }));

const PUBLIC_HOST = "protom4-mi.example.com";
const LOCAL_HOST = "ai.local";
const CORRECT_PASSWORD = "correct-password";

interface AppResponse {
  status: number;
  setCookie: string[];
  body: Record<string, unknown>;
}

type AuthModule = typeof import("./auth");

let server: http.Server;
let port: number;
let auth: AuthModule;

// node:http instead of fetch: undici refuses to let a caller choose the Host header, and the
// Host header is exactly what these tests are about.
function send(
  requestPath: string,
  options: { host?: string; cloudflare?: boolean; cookie?: string; body?: unknown } = {}
): Promise<AppResponse> {
  const headers: Record<string, string> = {
    host: options.host ?? LOCAL_HOST,
    "content-type": "application/json",
  };
  if (options.cloudflare === true) {
    headers["cf-connecting-ip"] = "203.0.113.7";
  }
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  return new Promise((resolve, reject) => {
    const clientRequest = http.request({ port, path: requestPath, method: "POST", headers }, (response) => {
      let raw = "";
      response.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      response.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // Express's default error page for an unhandled rejection is HTML; the status is what matters.
        }
        resolve({ status: response.statusCode ?? 0, setCookie: response.headers["set-cookie"] ?? [], body });
      });
    });
    clientRequest.on("error", reject);
    clientRequest.end(JSON.stringify(options.body ?? {}));
  });
}

function login(password: string, options: { host?: string; cloudflare?: boolean } = {}): Promise<AppResponse> {
  return send("/auth/login", { ...options, body: { password } });
}

function cookieFor(token: string): string {
  return `${auth.AUTH_COOKIE_NAME}=${token}`;
}

function tokenFromSetCookie(setCookie: string[]): string {
  const match: RegExpMatchArray | null = (setCookie[0] ?? "").match(/^ccdash_auth=([^;]+)/);
  return decodeURIComponent(match?.[1] ?? "");
}

async function startApp(options: { withPassword: boolean }): Promise<void> {
  fakeFiles.clear();
  vi.stubEnv("DASHBOARD_PASSWORD", "");
  // Fresh module state per start: the throttle counter, the cached secret and the listener.
  vi.resetModules();
  auth = await import("./auth");
  const { apiRouter } = await import("./routes");
  if (options.withPassword) {
    await auth.setStoredPassword(CORRECT_PASSWORD);
  }
  writeFailures.writeCount = 0;
  writeFailures.failOnWriteNumber = 0;
  const app = express();
  app.use(express.json());
  app.use("/", apiRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  await startApp({ withPassword: true });
});

afterEach(() => {
  server.close();
  vi.unstubAllEnvs();
});

describe("login throttle", () => {
  it("answers 429 on the sixth public attempt even with the correct password", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login("wrong-password", { host: PUBLIC_HOST })).status).toBe(401);
    }

    expect((await login(CORRECT_PASSWORD, { host: PUBLIC_HOST })).status).toBe(429);
  });

  it("never throttles ai.local without the Cloudflare header", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login("wrong-password")).status).toBe(401);
    }

    expect((await login(CORRECT_PASSWORD)).status).toBe(200);
  });

  it("counts ai.local with a Cloudflare header as public (Quick Tunnel rewrites Host)", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login("wrong-password", { cloudflare: true });
    }

    expect((await login(CORRECT_PASSWORD, { cloudflare: true })).status).toBe(429);
  });

  it("resets the counter after a successful login", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login("wrong-password", { host: PUBLIC_HOST });
    }
    expect((await login(CORRECT_PASSWORD, { host: PUBLIC_HOST })).status).toBe(200);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await login("wrong-password", { host: PUBLIC_HOST })).status).toBe(401);
    }
  });
});

describe("POST /auth/revoke-all", () => {
  it("rejects a request without a session", async () => {
    expect((await send("/auth/revoke-all")).status).toBe(401);
  });

  it("is refused off the local network and leaves sessions alone", async () => {
    const { value: token } = await auth.issueToken();

    const viaHost: AppResponse = await send("/auth/revoke-all", { host: PUBLIC_HOST, cookie: cookieFor(token) });
    const viaQuickTunnel: AppResponse = await send("/auth/revoke-all", { cloudflare: true, cookie: cookieFor(token) });

    expect(viaHost.status).toBe(403);
    expect(viaQuickTunnel.status).toBe(403);
    expect(await auth.verifyToken(token)).toBe(true);
  });

  it("on the LAN kills old cookies, cuts live sockets and hands the caller a fresh cookie", async () => {
    const { value: token } = await auth.issueToken();
    const listener = vi.fn();
    auth.setSecretRotatedListener(listener);

    const response: AppResponse = await send("/auth/revoke-all", { cookie: cookieFor(token) });

    expect(response.status).toBe(200);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await auth.verifyToken(token)).toBe(false);
    expect(await auth.verifyToken(tokenFromSetCookie(response.setCookie))).toBe(true);
  });
});

describe("POST /auth/set-password", () => {
  it("is refused off the local network: password, sessions and sockets stay as they were", async () => {
    const { value: token } = await auth.issueToken();
    const listener = vi.fn();
    auth.setSecretRotatedListener(listener);

    const viaHost: AppResponse = await send("/auth/set-password", {
      host: PUBLIC_HOST,
      cookie: cookieFor(token),
      body: { password: "attacker-password" },
    });
    const viaQuickTunnel: AppResponse = await send("/auth/set-password", {
      cloudflare: true,
      cookie: cookieFor(token),
      body: { password: "attacker-password" },
    });

    expect(viaHost.status).toBe(403);
    expect(viaQuickTunnel.status).toBe(403);
    expect(auth.checkPassword(CORRECT_PASSWORD)).toBe(true);
    expect(auth.checkPassword("attacker-password")).toBe(false);
    expect(await auth.verifyToken(token)).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("answers 409 while DASHBOARD_PASSWORD overrides the stored password", async () => {
    const { value: token } = await auth.issueToken();
    vi.stubEnv("DASHBOARD_PASSWORD", "from-the-env");

    const response: AppResponse = await send("/auth/set-password", {
      cookie: cookieFor(token),
      body: { password: "new-password-1" },
    });

    expect(response.status).toBe(409);
  });

  it("on the LAN changes the password and signs every other session out", async () => {
    const { value: token } = await auth.issueToken();
    const listener = vi.fn();
    auth.setSecretRotatedListener(listener);

    const response: AppResponse = await send("/auth/set-password", {
      cookie: cookieFor(token),
      body: { password: "new-password-1" },
    });

    expect(response.status).toBe(200);
    expect(auth.checkPassword("new-password-1")).toBe(true);
    expect(auth.checkPassword(CORRECT_PASSWORD)).toBe(false);
    expect(await auth.verifyToken(token)).toBe(false);
    expect(await auth.verifyToken(tokenFromSetCookie(response.setCookie))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("says sessions were NOT signed out when the rotation fails after the password was written", async () => {
    const { value: token } = await auth.issueToken();
    writeFailures.writeCount = 0;
    writeFailures.failOnWriteNumber = 2;

    const response: AppResponse = await send("/auth/set-password", {
      cookie: cookieFor(token),
      body: { password: "new-password-1" },
    });

    expect(response.status).toBe(500);
    expect(String(response.body.error)).toContain("NOT signed out");
    expect(auth.checkPassword("new-password-1")).toBe(true);
    expect(await auth.verifyToken(token)).toBe(true);
  });

  it("keeps auth on with the old password when the password write itself fails", async () => {
    const { value: token } = await auth.issueToken();
    writeFailures.writeCount = 0;
    writeFailures.failOnWriteNumber = 1;

    const response: AppResponse = await send("/auth/set-password", {
      cookie: cookieFor(token),
      body: { password: "new-password-1" },
    });

    expect(response.status).toBe(500);
    expect(auth.isAuthEnabled()).toBe(true);
    expect(auth.checkPassword(CORRECT_PASSWORD)).toBe(true);
    expect(await auth.verifyToken(token)).toBe(true);
  });

  it("bootstraps the first password without rotating anything", async () => {
    server.close();
    await startApp({ withPassword: false });
    const listener = vi.fn();
    auth.setSecretRotatedListener(listener);

    const response: AppResponse = await send("/auth/set-password", { body: { password: "first-password" } });

    expect(response.status).toBe(200);
    expect(auth.checkPassword("first-password")).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(await auth.verifyToken(tokenFromSetCookie(response.setCookie))).toBe(true);
    expect(fakeFiles.has(secretFilePath)).toBe(true);
  });
});
