import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { db } from "./db.js";

/**
 * The todos application's own audit log.
 *
 * This is the evidence that matters to an identity audience, and it lives in the target
 * system rather than in the agent's telemetry — the point being that the resource app
 * *itself* knows the difference between "the agent did this" and "the agent did this on
 * behalf of Ryland".
 *
 * Three parties are recorded on every write, and they are not interchangeable:
 *
 *   subject   — whose data this is, in the todos app's own namespace
 *   idp       — who the identity provider said that is, upstream
 *   actor     — which client was holding the token when it acted
 *
 * A service-account integration would record a single identity for every row and lose
 * the person entirely. That difference is the whole argument, so it is written down.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS audit (
    id            TEXT PRIMARY KEY,
    at            TEXT NOT NULL,
    action        TEXT NOT NULL,
    -- Whose data was touched, in our namespace.
    subject       TEXT NOT NULL,
    -- The IdP's identifier for the same person, carried through the whole chain.
    idp_subject   TEXT,
    -- The OAuth client that presented the token. Null when a human used the app UI.
    actor_client  TEXT,
    -- How the caller was authorised: 'delegated' (on behalf of) or 'session' (in person).
    authority     TEXT NOT NULL CHECK (authority IN ('delegated','session')),
    -- The scope that permitted it, and the token id that carried it.
    scope         TEXT,
    token_id      TEXT,
    detail        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at DESC);
`);

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  subject: string;
  idpSubject: string | null;
  actorClient: string | null;
  authority: "delegated" | "session";
  scope: string | null;
  tokenId: string | null;
  detail: string | null;
}

export const auditEvents = new EventEmitter();
auditEvents.setMaxListeners(50);

export interface RecordAuditInput {
  action: string;
  subject: string;
  idpSubject?: string | null;
  actorClient?: string | null;
  authority: "delegated" | "session";
  scope?: string | null;
  tokenId?: string | null;
  detail?: string | null;
}

export function recordAudit(input: RecordAuditInput): AuditEntry {
  const entry: AuditEntry = {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    action: input.action,
    subject: input.subject,
    idpSubject: input.idpSubject ?? null,
    actorClient: input.actorClient ?? null,
    authority: input.authority,
    scope: input.scope ?? null,
    tokenId: input.tokenId ?? null,
    detail: input.detail ?? null,
  };

  db.prepare(
    `INSERT INTO audit (id, at, action, subject, idp_subject, actor_client,
                        authority, scope, token_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.at,
    entry.action,
    entry.subject,
    entry.idpSubject,
    entry.actorClient,
    entry.authority,
    entry.scope,
    entry.tokenId,
    entry.detail,
  );

  auditEvents.emit("audit", entry);
  return entry;
}

type AuditRow = {
  id: string;
  at: string;
  action: string;
  subject: string;
  idp_subject: string | null;
  actor_client: string | null;
  authority: string;
  scope: string | null;
  token_id: string | null;
  detail: string | null;
};

export function recentAudit(limit = 12): AuditEntry[] {
  const rows = db
    .prepare("SELECT * FROM audit ORDER BY at DESC, rowid DESC LIMIT ?")
    .all(limit) as AuditRow[];

  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    action: row.action,
    subject: row.subject,
    idpSubject: row.idp_subject,
    actorClient: row.actor_client,
    authority: row.authority as "delegated" | "session",
    scope: row.scope,
    tokenId: row.token_id,
    detail: row.detail,
  }));
}
