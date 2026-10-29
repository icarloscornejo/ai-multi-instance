import { randomBytes, timingSafeEqual, createHmac, scryptSync } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { writeStateFileAtomic } from "./store";

// Data directory mirrors store.ts's; kept separate to avoid coupling the auth
// secret's lifecycle to the instance registry file.
const dataDirectory: string = path.resolve(import.meta.dirname, "../../data");
const secretFilePath: string = path.join(dataDirectory, "auth-secret.txt");
const passwordFilePath: string = path.join(dataDirectory, "auth-password.json");

export const AUTH_COOKIE_NAME = "ccdash_auth";
const TOKEN_TTL_MS: number = 180 * 24 * 60 * 60 * 1000; // ~180 days
const SCRYPT_KEY_LENGTH = 64;
const SECRET_BYTE_LENGTH = 32;

// ponytail: one global counter because there is a single user; if this ever serves several
// people, key it per cf-connecting-ip so one attacker cannot lock everyone out.
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS: number = 15 * 60 * 1000;
let failedLoginTimestamps: number[] = [];

let cachedSecret: Buffer | null = null;
// Serializes every secret write (first creation and rotations): two overlapping writers could
// otherwise leave the in-memory key different from the one on disk.
let secretWriteQueueTail: Promise<unknown> = Promise.resolve();
let secretRotatedListener: (() => void) | null = null;

interface StoredPassword {
  salt: string;
  hash: string;
}

// undefined = not loaded from disk yet; null = loaded, nothing stored
let cachedStoredPassword: StoredPassword | null | undefined = undefined;

// A sync read, cached after the first call: isAuthEnabled/checkPassword are called from
// synchronous middleware (requireAuth), so this avoids threading async through the whole chain.
function loadStoredPassword(): StoredPassword | null {
  if (cachedStoredPassword !== undefined) {
    return cachedStoredPassword;
  }
  try {
    cachedStoredPassword = JSON.parse(readFileSync(passwordFilePath, "utf8")) as StoredPassword;
  } catch {
    cachedStoredPassword = null;
  }
  return cachedStoredPassword;
}

// Persists a password set from the UI (e.g. the "Start tunnel" flow), hashed with a random
// salt via scrypt so the plaintext password never sits on disk. DASHBOARD_PASSWORD, if set,
// still takes priority in checkPassword below; this is only consulted when that env var is absent.
// Written atomically (tmp + rename) and cached only afterwards: a torn password file parses as
// "no password" in loadStoredPassword, which would silently turn the gate off on the LAN.
export async function setStoredPassword(password: string): Promise<void> {
  const salt: Buffer = randomBytes(16);
  const hash: Buffer = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const stored: StoredPassword = { salt: salt.toString("hex"), hash: hash.toString("hex") };
  await writeStateFileAtomic(passwordFilePath, JSON.stringify(stored));
  cachedStoredPassword = stored;
}

// DASHBOARD_PASSWORD wins over the stored hash (see checkPassword), so while it is set a
// password saved from the UI has no effect.
export function isPasswordFromEnv(): boolean {
  return typeof process.env.DASHBOARD_PASSWORD === "string" && process.env.DASHBOARD_PASSWORD.length > 0;
}

// The password gate is opt-in: with neither DASHBOARD_PASSWORD nor a stored password set,
// every check below is skipped and the dashboard behaves exactly as it did before auth existed.
export function isAuthEnabled(): boolean {
  return isPasswordFromEnv() || loadStoredPassword() !== null;
}

// Generates a fresh secret, persists it atomically and only then swaps the cached key, so a
// failed write leaves both the old file and the old key in place. With onlyIfMissing, a caller
// that lost the race to another creator reuses its secret instead of replacing it.
function writeNewSecret(onlyIfMissing: boolean): Promise<Buffer> {
  const write: Promise<Buffer> = secretWriteQueueTail.then(async () => {
    if (onlyIfMissing && cachedSecret !== null) {
      return cachedSecret;
    }
    const generated: Buffer = randomBytes(SECRET_BYTE_LENGTH);
    await writeStateFileAtomic(secretFilePath, generated.toString("hex"));
    cachedSecret = generated;
    return generated;
  });
  secretWriteQueueTail = write.catch(() => undefined);
  return write;
}

async function getOrCreateSecret(): Promise<Buffer> {
  if (cachedSecret !== null) {
    return cachedSecret;
  }
  try {
    const existing: Buffer = Buffer.from((await fs.readFile(secretFilePath, "utf8")).trim(), "hex");
    // A short key (an empty file left by a torn write) is still accepted by createHmac, and
    // anyone could then forge cookies with it, so anything under the full length is discarded.
    if (existing.length >= SECRET_BYTE_LENGTH) {
      cachedSecret = existing;
      return cachedSecret;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return writeNewSecret(true);
}

// Invalidates every cookie issued so far (they are HMACs of the old secret), then lets the
// registered listener cut the sockets that were already authenticated at upgrade time.
export async function rotateSecret(): Promise<void> {
  await writeNewSecret(false);
  secretRotatedListener?.();
}

export function setSecretRotatedListener(listener: (() => void) | null): void {
  secretRotatedListener = listener;
}

// terminate(), not close(): ws keeps delivering messages from a client that ignores the close
// frame until its 30s close timer fires, and terminal.ts writes them straight into the pty.
export function revokeLiveSockets(clients: Iterable<{ terminate(): void }>): void {
  for (const client of clients) {
    client.terminate();
  }
}

export function isLoginLocked(now: number = Date.now()): boolean {
  failedLoginTimestamps = failedLoginTimestamps.filter((failedAt: number) => now - failedAt < LOGIN_FAILURE_WINDOW_MS);
  return failedLoginTimestamps.length >= LOGIN_FAILURE_LIMIT;
}

export function recordFailedLogin(now: number = Date.now()): void {
  failedLoginTimestamps.push(now);
}

export function resetFailedLogins(): void {
  failedLoginTimestamps = [];
}

function sign(secret: Buffer, expiresAt: number): string {
  return createHmac("sha256", secret).update(String(expiresAt)).digest("hex");
}

export function checkPassword(candidate: string): boolean {
  if (isPasswordFromEnv()) {
    const expectedBuffer: Buffer = Buffer.from(process.env.DASHBOARD_PASSWORD ?? "");
    const candidateBuffer: Buffer = Buffer.from(candidate);
    // Lengths must match before timingSafeEqual, but that comparison itself is not
    // timing-safe: it is cheap and reveals only length, not content.
    return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
  }
  const stored: StoredPassword | null = loadStoredPassword();
  if (stored === null) {
    return false;
  }
  const candidateHash: Buffer = scryptSync(candidate, Buffer.from(stored.salt, "hex"), SCRYPT_KEY_LENGTH);
  const storedHashBuffer: Buffer = Buffer.from(stored.hash, "hex");
  return candidateHash.length === storedHashBuffer.length && timingSafeEqual(candidateHash, storedHashBuffer);
}

export async function issueToken(): Promise<{ value: string; maxAgeMs: number }> {
  const secret: Buffer = await getOrCreateSecret();
  const expiresAt: number = Date.now() + TOKEN_TTL_MS;
  return { value: `${expiresAt}.${sign(secret, expiresAt)}`, maxAgeMs: TOKEN_TTL_MS };
}

export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (typeof token !== "string") {
    return false;
  }
  const separatorIndex: number = token.indexOf(".");
  if (separatorIndex === -1) {
    return false;
  }
  const expiresAtRaw: string = token.slice(0, separatorIndex);
  const signature: string = token.slice(separatorIndex + 1);
  const expiresAt: number = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || expiresAt < Date.now()) {
    return false;
  }
  const secret: Buffer = await getOrCreateSecret();
  const expectedSignature: string = sign(secret, expiresAt);
  const signatureBuffer: Buffer = Buffer.from(signature);
  const expectedBuffer: Buffer = Buffer.from(expectedSignature);
  return signatureBuffer.length === expectedBuffer.length && timingSafeEqual(signatureBuffer, expectedBuffer);
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const separatorIndex: number = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    if (part.slice(0, separatorIndex).trim() === name) {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    }
  }
  return undefined;
}

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    next();
    return;
  }
  const token: string | undefined = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
  void verifyToken(token).then((isValid) => {
    if (isValid) {
      next();
      return;
    }
    response.status(401).json({ error: "Unauthorized" });
  });
}
