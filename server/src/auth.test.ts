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

describe("login throttle", () => {
  it("locks after five failures inside the window and releases when they age out", async () => {
    const auth = await loadAuth();
    const start = 1_000_000;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      auth.recordFailedLogin(start);
    }
    expect(auth.isLoginLocked(start)).toBe(false);

    auth.recordFailedLogin(start);
    expect(auth.isLoginLocked(start)).toBe(true);
    expect(auth.isLoginLocked(start + 15 * 60 * 1000 - 1)).toBe(true);
    expect(auth.isLoginLocked(start + 15 * 60 * 1000)).toBe(false);
  });

  it("resetFailedLogins clears the counter", async () => {
    const auth = await loadAuth();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      auth.recordFailedLogin(1);
    }

    auth.resetFailedLogins();

    expect(auth.isLoginLocked(1)).toBe(false);
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
