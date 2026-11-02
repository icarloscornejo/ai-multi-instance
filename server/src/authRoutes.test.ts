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
// When true, reading the signing secret fails with a permission error (not ENOENT), the way a
// broken data/ directory would.
const secretRead = vi.hoisted(() => ({ shouldFailWithPermissionError: false }));

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
        if (secretRead.shouldFailWithPermissionError && filePath.endsWith("auth-secret.txt")) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
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
// Keeps the real type allowlist but never writes an image into the real data/ directory
vi.mock("./pastedImages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pastedImages")>()),
  savePastedImage: vi.fn(async () => "/fake/pasted-images/saved.png"),
}));

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
  options: {
    host?: string;
    cloudflare?: boolean;
    // Value of cf-connecting-ip when cloudflare is true
    clientIp?: string;
    cookie?: string;
    body?: unknown;
    // Sent as-is with its own content type, for the routes that take binary bodies
    rawBody?: Buffer;
    contentType?: string;
  } = {}
): Promise<AppResponse> {
  const headers: Record<string, string> = {
    host: options.host ?? LOCAL_HOST,
    "content-type": options.contentType ?? "application/json",
  };
  if (options.cloudflare === true) {
    headers["cf-connecting-ip"] = options.clientIp ?? "203.0.113.7";
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
    clientRequest.end(options.rawBody ?? JSON.stringify(options.body ?? {}));
  });
}

function login(
  password: string,
  options: { host?: string; cloudflare?: boolean; clientIp?: string } = {}
): Promise<AppResponse> {
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
  secretRead.shouldFailWithPermissionError = false;
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

describe("per-client login throttle", () => {
  const clientA = { cloudflare: true, clientIp: "203.0.113.1" };
  const clientB = { cloudflare: true, clientIp: "203.0.113.2" };

  it("locks one client without blocking another", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login("wrong-password", clientA)).status).toBe(401);
    }

    expect((await login(CORRECT_PASSWORD, clientA)).status).toBe(429);
    expect((await login(CORRECT_PASSWORD, clientB)).status).toBe(200);
  });

  it("keeps the socket-address bucket apart from Cloudflare clients", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login("wrong-password", { host: PUBLIC_HOST })).status).toBe(401);
    }

    expect((await login(CORRECT_PASSWORD, { host: PUBLIC_HOST })).status).toBe(429);
    expect((await login(CORRECT_PASSWORD, { cloudflare: true, clientIp: "203.0.113.50" })).status).toBe(200);
  });

  it("resets only the client that logged in successfully", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login("wrong-password", clientA);
      await login("wrong-password", clientB);
    }

    expect((await login(CORRECT_PASSWORD, clientA)).status).toBe(200);

    expect((await login("wrong-password", clientB)).status).toBe(401);
    expect((await login("wrong-password", clientB)).status).toBe(429);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await login("wrong-password", clientA)).status).toBe(401);
    }
  });

  it("clears every public lockout when a local login succeeds", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login("wrong-password", clientA)).status).toBe(401);
    }
    expect((await login(CORRECT_PASSWORD, clientA)).status).toBe(429);

    expect((await login(CORRECT_PASSWORD)).status).toBe(200);

    expect((await login(CORRECT_PASSWORD, clientA)).status).toBe(200);
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

describe("session cookie flags", () => {
  const SECURE_ATTRIBUTE: RegExp = /;\s*Secure(;|$)/;

  it("marks the cookie Secure, HttpOnly and SameSite for a Quick Tunnel visitor (Host rewritten to ai.local)", async () => {
    const response: AppResponse = await login(CORRECT_PASSWORD, { cloudflare: true });

    expect(response.status).toBe(200);
    expect(response.setCookie[0]).toMatch(SECURE_ATTRIBUTE);
    expect(response.setCookie[0]).toContain("HttpOnly");
    expect(response.setCookie[0]).toContain("SameSite=Lax");
  });

  it("marks the cookie Secure for the public hostname", async () => {
    const response: AppResponse = await login(CORRECT_PASSWORD, { host: PUBLIC_HOST });

    expect(response.setCookie[0]).toMatch(SECURE_ATTRIBUTE);
  });

  it("keeps the cookie non-Secure on ai.local and on a LAN address, which are plain HTTP", async () => {
    const viaAiLocal: AppResponse = await login(CORRECT_PASSWORD);
    const viaLanAddress: AppResponse = await login(CORRECT_PASSWORD, { host: "192.168.1.42" });

    expect(viaAiLocal.setCookie[0]).not.toMatch(SECURE_ATTRIBUTE);
    expect(viaLanAddress.setCookie[0]).not.toMatch(SECURE_ATTRIBUTE);
  });

  it("marks the cookie from the first-password bootstrap Secure when it arrives through the Quick Tunnel", async () => {
    server.close();
    await startApp({ withPassword: false });

    const response: AppResponse = await send("/auth/set-password", {
      cloudflare: true,
      body: { password: "first-password" },
    });

    expect(response.status).toBe(200);
    expect(response.setCookie[0]).toMatch(SECURE_ATTRIBUTE);
  });
});

describe("update routes", () => {
  let applyUpdate: ReturnType<typeof vi.fn>;
  let resetToRemote: ReturnType<typeof vi.fn>;
  let sessionCookie: string;

  beforeEach(async () => {
    const updater = await import("./updater");
    applyUpdate = vi.mocked(updater.applyUpdate);
    resetToRemote = vi.mocked(updater.resetToRemote);
    applyUpdate.mockClear().mockResolvedValue({});
    resetToRemote.mockClear().mockResolvedValue({});
    sessionCookie = cookieFor((await auth.issueToken()).value);
  });

  it.each(["/update/apply", "/update/reset"])("%s is refused with 403 for a signed-in public visitor", async (route) => {
    const viaHost: AppResponse = await send(route, { host: PUBLIC_HOST, cookie: sessionCookie });
    const viaQuickTunnel: AppResponse = await send(route, { cloudflare: true, cookie: sessionCookie });

    expect(viaHost.status).toBe(403);
    expect(viaQuickTunnel.status).toBe(403);
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(resetToRemote).not.toHaveBeenCalled();
  });

  it("still runs both from the LAN", async () => {
    expect((await send("/update/apply", { cookie: sessionCookie })).status).toBe(200);
    expect((await send("/update/reset", { cookie: sessionCookie })).status).toBe(200);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(resetToRemote).toHaveBeenCalledTimes(1);
  });
});

describe("requireAuth when the signing secret cannot be read", () => {
  it("answers 500 with a generic body, logs the cause and keeps serving", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Well formed and unexpired but never issued here, so verifyToken has to load the secret
      const unissuedToken = `${Date.now() + 60_000}.x`;
      secretRead.shouldFailWithPermissionError = true;

      const failed: AppResponse = await send("/update/check", { cookie: cookieFor(unissuedToken) });

      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain("EACCES");
      expect(consoleError).toHaveBeenCalled();

      secretRead.shouldFailWithPermissionError = false;
      const { value: token } = await auth.issueToken();
      expect((await send("/update/check", { cookie: cookieFor(token) })).status).toBe(200);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("password normalization", () => {
  it("lets a password set with surrounding spaces log in with or without them", async () => {
    const { value: token } = await auth.issueToken();

    const setResponse: AppResponse = await send("/auth/set-password", {
      cookie: cookieFor(token),
      body: { password: "  spaced-pass-1  " },
    });

    expect(setResponse.status).toBe(200);
    expect((await login("spaced-pass-1")).status).toBe(200);
    expect((await login("  spaced-pass-1  ")).status).toBe(200);
  });

  it("never lets an empty login match a whitespace-only DASHBOARD_PASSWORD", async () => {
    vi.stubEnv("DASHBOARD_PASSWORD", "   ");

    expect((await login("")).status).toBe(401);
  });
});

describe("POST /pasted-images", () => {
  const PNG_BYTES: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  async function uploadAsSignedIn(contentType: string, rawBody: Buffer): Promise<AppResponse> {
    const { value: token } = await auth.issueToken();
    return send("/pasted-images", { cookie: cookieFor(token), contentType, rawBody });
  }

  it("rejects a request without a session", async () => {
    const response: AppResponse = await send("/pasted-images", { contentType: "image/png", rawBody: PNG_BYTES });

    expect(response.status).toBe(401);
  });

  it("saves a PNG and answers with its path", async () => {
    const response: AppResponse = await uploadAsSignedIn("image/png", PNG_BYTES);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ path: "/fake/pasted-images/saved.png" });
  });

  it("answers 415 for types that are not images the agent accepts", async () => {
    expect((await uploadAsSignedIn("text/plain", Buffer.from("hola"))).status).toBe(415);
    expect((await uploadAsSignedIn("application/json", Buffer.from("{}"))).status).toBe(415);
    expect((await uploadAsSignedIn("image/tiff", PNG_BYTES)).status).toBe(415);
  });

  it("answers 400 for an empty image", async () => {
    expect((await uploadAsSignedIn("image/png", Buffer.alloc(0))).status).toBe(400);
  });

  it("answers 413, not 500, for a body over the limit", async () => {
    const response: AppResponse = await uploadAsSignedIn("image/png", Buffer.alloc(21 * 1024 * 1024));

    expect(response.status).toBe(413);
  });
});
