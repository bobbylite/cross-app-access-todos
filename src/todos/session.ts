import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { db } from "./db.js";
import { getUser, type TodoUser } from "./store.js";

/**
 * The todos application's own sign-in, for humans using its UI.
 *
 * This is emphatically **not** the secured path the demo is about. It is the ordinary
 * app session a SaaS product would have, and it exists so the UI has a real
 * authorization boundary instead of an open write endpoint — every write names a user,
 * and that user comes from a signed cookie rather than from the request body.
 *
 * In this build the sign-in itself is a picker: choose a provisioned person, no
 * credential. That is honest for a localhost demo and the UI says so plainly. The real
 * version is an OIDC authorization-code flow against the same PingFederate that issues
 * the ID-JAGs — at which point the demo's point lands completely: one identity, two
 * front doors, no second login.
 */

const COOKIE = "todos_session";
const MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * Kept in the database so sessions survive the restarts `tsx watch` causes constantly
 * while anyone is editing. Generated once, never shipped.
 */
function sessionSecret(): string {
  const existing = db
    .prepare("SELECT value FROM meta WHERE key = 'session_secret'")
    .get() as { value: string } | undefined;
  if (existing) return existing.value;

  const secret = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO meta (key, value) VALUES ('session_secret', ?)").run(
    secret,
  );
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function issueSession(res: Response, userId: string): void {
  const expiresAt = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${userId}.${expiresAt}`;
  const value = `${payload}.${sign(payload)}`;

  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`,
  );
}

export function clearSession(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
}

/** The signed-in user, or null. Tampering with the cookie yields null, not a user. */
export function sessionUser(req: Request): TodoUser | null {
  const header = req.headers.cookie;
  if (!header) return null;

  const raw = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;

  const parts = decodeURIComponent(raw).split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAt, signature] = parts as [string, string, string];

  if (!safeEquals(sign(`${userId}.${expiresAt}`), signature)) return null;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) {
    return null;
  }

  return getUser(userId);
}
