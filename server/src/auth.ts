import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";

// Data directory mirrors store.ts's; kept separate to avoid coupling the auth
// secret's lifecycle to the instance registry file.
const dataDirectory: string = path.resolve(import.meta.dirname, "../../data");
const secretFilePath: string = path.join(dataDirectory, "auth-secret.txt");

export const AUTH_COOKIE_NAME = "ccdash_auth";
const TOKEN_TTL_MS: number = 180 * 24 * 60 * 60 * 1000; // ~180 days

let cachedSecret: Buffer | null = null;

// The password gate is opt-in: with no DASHBOARD_PASSWORD set, every check below
// is skipped and the dashboard behaves exactly as it did before auth existed.
export function isAuthEnabled(): boolean {
  return typeof process.env.DASHBOARD_PASSWORD === "string" && process.env.DASHBOARD_PASSWORD.length > 0;
}

async function getOrCreateSecret(): Promise<Buffer> {
  if (cachedSecret !== null) {
    return cachedSecret;
  }
  try {
    const existing: string = await fs.readFile(secretFilePath, "utf8");
    cachedSecret = Buffer.from(existing.trim(), "hex");
    return cachedSecret;
  } catch {
    const generated: Buffer = randomBytes(32);
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(secretFilePath, generated.toString("hex"), "utf8");
    cachedSecret = generated;
    return cachedSecret;
  }
}

function sign(secret: Buffer, expiresAt: number): string {
  return createHmac("sha256", secret).update(String(expiresAt)).digest("hex");
}

export function checkPassword(candidate: string): boolean {
  const expected: string = process.env.DASHBOARD_PASSWORD ?? "";
  const candidateBuffer: Buffer = Buffer.from(candidate);
  const expectedBuffer: Buffer = Buffer.from(expected);
  // Lengths must match before timingSafeEqual, but that comparison itself is not
  // timing-safe: it is cheap and reveals only length, not content.
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
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
