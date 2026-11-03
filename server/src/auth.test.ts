import { createHmac } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The secret and password files live under the real data/ directory, which tests must never
// touch. Reads of those two paths are served from an in-memory map (everything else falls
// through to the real fs) and writes go through the mocked store, so a test can also make a
// write fail on demand.
const secretFilePath: string = path.resolve(import.meta.dirname, "../../data/auth-secret.txt");
const passwordFilePath: string = path.resolve(import.meta.dirname, "../../data/auth-password.json");

const fakeFiles = vi.hoisted(() => new Map<string, string>());
const writeFailures = vi.hoisted(() => ({ remaining: 0 }));

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
  writeStateFileAtomic: vi.fn(async (filePath: string, content: string): Promise<void> => {
    if (writeFailures.remaining > 0) {
      writeFailures.remaining -= 1;
      throw new Error("ENOSPC: no space left on device");
    }
    fakeFiles.set(filePath, content);
  }),
}));

// auth.ts keeps its secret, password and throttle state at module level, so every test loads a
// fresh copy.
async function loadAuth(): Promise<typeof import("./auth")> {
  vi.resetModules();
  return import("./auth");
}

beforeEach(() => {
  fakeFiles.clear();
  writeFailures.remaining = 0;
  vi.stubEnv("DASHBOARD_PASSWORD", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rotateSecret", () => {
  it("invalidates tokens issued before the rotation", async () => {
    const auth = await loadAuth();
    const { value: oldToken } = await auth.issueToken();
    expect(await auth.verifyToken(oldToken)).toBe(true);

    await auth.rotateSecret();

    expect(await auth.verifyToken(oldToken)).toBe(false);
    const { value: newToken } = await auth.issueToken();
    expect(await auth.verifyToken(newToken)).toBe(true);
  });

  it("keeps the old key and the old file when the write fails", async () => {
    const auth = await loadAuth();
    const { value: token } = await auth.issueToken();
    const fileBefore: string | undefined = fakeFiles.get(secretFilePath);

    writeFailures.remaining = 1;
    await expect(auth.rotateSecret()).rejects.toThrow("ENOSPC");

    expect(await auth.verifyToken(token)).toBe(true);
    expect(fakeFiles.get(secretFilePath)).toBe(fileBefore);
  });

  it("leaves the file matching the in-memory key after concurrent rotations", async () => {
    const auth = await loadAuth();

    await Promise.all([auth.rotateSecret(), auth.rotateSecret()]);

    const { value: token } = await auth.issueToken();
    const [expiresAt, signature] = token.split(".");
    const keyFromDisk: Buffer = Buffer.from(fakeFiles.get(secretFilePath) ?? "", "hex");
    expect(signature).toBe(createHmac("sha256", keyFromDisk).update(expiresAt).digest("hex"));
  });

  it("calls the listener after a rotation but not after a failed one", async () => {
    const auth = await loadAuth();
    const listener = vi.fn();
    auth.setSecretRotatedListener(listener);

    await auth.rotateSecret();
    expect(listener).toHaveBeenCalledTimes(1);

    writeFailures.remaining = 1;
    await expect(auth.rotateSecret()).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("getOrCreateSecret", () => {
  it.each([["empty", ""], ["short", "abcd"]])("replaces a %s stored secret with a full-length one", async (_name, stored) => {
    fakeFiles.set(secretFilePath, stored);
    const auth = await loadAuth();

    await auth.issueToken();

    expect(Buffer.from(fakeFiles.get(secretFilePath) ?? "", "hex")).toHaveLength(32);
  });
});

describe("revokeLiveSockets", () => {
  it("terminates every client", () => {
    return loadAuth().then((auth) => {
      const clients = [{ terminate: vi.fn() }, { terminate: vi.fn() }];

      auth.revokeLiveSockets(new Set(clients));

      for (const client of clients) {
        expect(client.terminate).toHaveBeenCalledTimes(1);
      }
    });
  });
});

describe("trusted device token", () => {
  it("verifies, and fails when tampered, expired, or swapped with a session token", async () => {
    const auth = await loadAuth();
    const trusted = await auth.issueTrustedDeviceToken();
    const session = await auth.issueToken();
    const [expiresAt, signature] = trusted.value.split(".");

    expect(await auth.verifyTrustedDeviceToken(trusted.value)).toBe(true);
    expect(await auth.verifyTrustedDeviceToken(`${Number(expiresAt) + 1}.${signature}`)).toBe(false);
    expect(await auth.verifyTrustedDeviceToken(`${expiresAt}.${"0".repeat(64)}`)).toBe(false);
    expect(await auth.verifyTrustedDeviceToken(`${Date.now() - 1000}.${signature}`)).toBe(false);
    expect(await auth.verifyTrustedDeviceToken(undefined)).toBe(false);
    expect(await auth.verifyTrustedDeviceToken(session.value)).toBe(false);
    expect(await auth.verifyToken(trusted.value)).toBe(false);
  });

  it("lasts longer than a session and stops verifying after the secret rotates", async () => {
    const auth = await loadAuth();
    const trusted = await auth.issueTrustedDeviceToken();
    const session = await auth.issueToken();

    expect(trusted.maxAgeMs).toBeGreaterThan(session.maxAgeMs);
    await auth.rotateSecret();
    expect(await auth.verifyTrustedDeviceToken(trusted.value)).toBe(false);
  });
});

describe("login throttle", () => {
  const windowMs: number = 15 * 60 * 1000;

  function failTimes(auth: Awaited<ReturnType<typeof loadAuth>>, clientKey: string, count: number, now: number): void {
    for (let attempt = 0; attempt < count; attempt += 1) {
      auth.recordFailedLogin(clientKey, now);
    }
  }

  it("locks after five failures inside the window and releases when they age out", async () => {
    const auth = await loadAuth();
    const start = 1_000_000;

    failTimes(auth, "client-a", 4, start);
    expect(auth.isLoginLocked("client-a", start)).toBe(false);

    auth.recordFailedLogin("client-a", start);
    expect(auth.isLoginLocked("client-a", start)).toBe(true);
    expect(auth.isLoginLocked("client-a", start + windowMs - 1)).toBe(true);
    expect(auth.isLoginLocked("client-a", start + windowMs)).toBe(false);
  });

  it("resetFailedLogins clears the counter of that client", async () => {
    const auth = await loadAuth();
    failTimes(auth, "client-a", 5, 1);

    auth.resetFailedLogins("client-a");

    expect(auth.isLoginLocked("client-a", 1)).toBe(false);
  });

  it("keeps clients isolated: one at five failures does not lock another", async () => {
    const auth = await loadAuth();
    failTimes(auth, "client-a", 5, 1_000);

    expect(auth.isLoginLocked("client-a", 1_000)).toBe(true);
    expect(auth.isLoginLocked("client-b", 1_000)).toBe(false);
  });

  it("locks every client once the global ceiling of 100 failures is reached", async () => {
    const auth = await loadAuth();
    const start = 5_000_000;

    for (let keyIndex = 0; keyIndex < 24; keyIndex += 1) {
      failTimes(auth, `client-${keyIndex}`, 4, start);
    }
    failTimes(auth, "client-24", 3, start);
    expect(auth.isLoginLocked("fresh-client", start)).toBe(false);

    auth.recordFailedLogin("client-24", start);
    expect(auth.isLoginLocked("fresh-client", start)).toBe(true);
    expect(auth.isLoginLocked("fresh-client", start + windowMs)).toBe(false);
    expect(auth.isLoginLocked("client-0", start + windowMs)).toBe(false);
  });

  it("a trusted device is exempt from the global ceiling only, never from its own five failures", async () => {
    const auth = await loadAuth();
    const start = 5_000_000;
    for (let keyIndex = 0; keyIndex < 25; keyIndex += 1) {
      failTimes(auth, `client-${keyIndex}`, 4, start);
    }

    expect(auth.isLoginLocked("fresh-client", start)).toBe(true);
    expect(auth.isLoginLocked("fresh-client", start, true)).toBe(false);
    expect(auth.isLoginLocked("client-0", start, true)).toBe(false);

    auth.recordFailedLogin("client-0", start);
    expect(auth.isLoginLocked("client-0", start, true)).toBe(true);
  });

  it("scoped reset leaves other clients counted and keeps the reset client in the global total", async () => {
    const auth = await loadAuth();
    const start = 9_000_000;
    failTimes(auth, "client-a", 4, start);
    failTimes(auth, "client-b", 4, start);

    auth.resetFailedLogins("client-a");

    auth.recordFailedLogin("client-b", start);
    expect(auth.isLoginLocked("client-b", start)).toBe(true);
    expect(auth.isLoginLocked("client-a", start)).toBe(false);

    // 4 (a, reset) + 5 (b) = 9 so far; 22 clients x 4 + 2 = 90 more make 99, one short of the ceiling.
    for (let keyIndex = 0; keyIndex < 22; keyIndex += 1) {
      failTimes(auth, `other-${keyIndex}`, 4, start);
    }
    failTimes(auth, "other-22", 2, start);
    expect(auth.isLoginLocked("fresh-client", start)).toBe(false);
    auth.recordFailedLogin("other-22", start);
    expect(auth.isLoginLocked("fresh-client", start)).toBe(true);
  });

  it("clearAllFailedLogins unlocks every client and the global ceiling", async () => {
    const auth = await loadAuth();
    const start = 2_000_000;
    for (let keyIndex = 0; keyIndex < 25; keyIndex += 1) {
      failTimes(auth, `client-${keyIndex}`, 4, start);
    }
    failTimes(auth, "client-a", 5, start);
    expect(auth.isLoginLocked("fresh-client", start)).toBe(true);
    expect(auth.isLoginLocked("client-a", start)).toBe(true);

    auth.clearAllFailedLogins();

    expect(auth.isLoginLocked("fresh-client", start)).toBe(false);
    expect(auth.isLoginLocked("client-a", start)).toBe(false);
    expect(auth.isLoginLocked("client-0", start)).toBe(false);
  });

  it("does not let a long-expired client distort the counting of others", async () => {
    const auth = await loadAuth();
    const start = 3_000_000;
    failTimes(auth, "stale-client", 5, start);

    const later = start + windowMs + 1_000;
    failTimes(auth, "client-b", 4, later);

    expect(auth.isLoginLocked("stale-client", later)).toBe(false);
    expect(auth.isLoginLocked("client-b", later)).toBe(false);
    auth.recordFailedLogin("client-b", later);
    expect(auth.isLoginLocked("client-b", later)).toBe(true);
    expect(auth.isLoginLocked("fresh-client", later)).toBe(false);
  });
});

describe("stored password", () => {
  it("keeps auth off when the very first write fails", async () => {
    const auth = await loadAuth();

    writeFailures.remaining = 1;
    await expect(auth.setStoredPassword("first-password")).rejects.toThrow("ENOSPC");

    expect(auth.isAuthEnabled()).toBe(false);
    expect(fakeFiles.has(passwordFilePath)).toBe(false);
  });

  it("keeps the old password when a later write fails", async () => {
    const auth = await loadAuth();
    await auth.setStoredPassword("old-password-1");

    writeFailures.remaining = 1;
    await expect(auth.setStoredPassword("new-password-2")).rejects.toThrow("ENOSPC");

    expect(auth.checkPassword("old-password-1")).toBe(true);
    expect(auth.checkPassword("new-password-2")).toBe(false);
  });

  it("reports whether DASHBOARD_PASSWORD overrides the stored one", async () => {
    const auth = await loadAuth();
    expect(auth.isPasswordFromEnv()).toBe(false);

    vi.stubEnv("DASHBOARD_PASSWORD", "from-the-env");

    expect(auth.isPasswordFromEnv()).toBe(true);
    expect(auth.isAuthEnabled()).toBe(true);
  });
});
