import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/**
 * The chat client's browser session.
 *
 * It holds the `id_token` PingFederate issued, server-side, keyed by an opaque cookie.
 * The token never reaches the browser — the page knows only that it is signed in and
 * who as. That keeps the credential out of anything an injected script could read, and
 * it means the proxy can attach it to agent calls without the client being involved.
 *
 * In memory on purpose: sessions are per-run, and losing them on restart costs one
 * sign-in. Nothing here is a system of record.
 */

const COOKIE = "chat_session";
const SECRET = randomBytes(32);

export interface ChatSession {
  id: string;
  idToken: string;
  claims: Record<string, unknown>;
  expiresAt: number;
}

const sessions = new Map<string, ChatSession>();

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Expiry follows the token's own `exp` — a dead token is a dead session. */
function tokenExpiry(claims: Record<string, unknown>): number {
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  return exp > 0 ? exp * 1000 : Date.now() + 15 * 60 * 1000;
}

export function createSession(
  res: Response,
  idToken: string,
  claims: Record<string, unknown>,
): ChatSession {
  const id = randomBytes(24).toString("base64url");
  const session: ChatSession = {
    id,
    idToken,
    claims,
    expiresAt: tokenExpiry(claims),
  };
  sessions.set(id, session);

  const value = `${id}.${sign(id)}`;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return session;
}

export function readSession(req: Request): ChatSession | null {
  const header = req.headers.cookie;
  if (!header) return null;

  const raw = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;

  const [id, signature] = decodeURIComponent(raw).split(".");
  if (!id || !signature || !safeEquals(sign(id), signature)) return null;

  const session = sessions.get(id);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function clearSession(req: Request, res: Response): void {
  const existing = readSession(req);
  if (existing) sessions.delete(existing.id);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
}

/** What the page is allowed to know about who it is. Never the token. */
export function publicView(session: ChatSession | null) {
  if (!session) return { signedIn: false as const };
  const { claims } = session;
  return {
    signedIn: true as const,
    subject: String(claims.sub ?? "unknown"),
    name: String(claims.name ?? claims.preferred_username ?? claims.sub ?? "unknown"),
    email: typeof claims.email === "string" ? claims.email : null,
    expiresAt: session.expiresAt,
  };
}
