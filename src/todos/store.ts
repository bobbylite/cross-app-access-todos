import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";

/**
 * Every read and write the todos application performs. The MCP server is one caller of
 * this module; the app's own view is another. Neither owns the data.
 *
 * Note that every function taking a user takes it as the first argument and scopes its
 * SQL by it. There is no "list all todos" the tools could accidentally reach — ownership
 * is enforced in the query, not in the caller.
 */

export type TodoStatus = "open" | "done";
export type TodoPriority = "low" | "normal" | "high";
/**
 * How a row came to exist. `agent` means it arrived through MCP carrying an access token
 * the Resource AS minted from an ID-JAG; `user` means a human wrote it in the app's own
 * UI over a session. Recorded per row so the UI can show, live, which door each write
 * came through.
 */
export type TodoOrigin = "seed" | "agent" | "user";

export interface TodoUser {
  id: string;
  idpSubject: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  jitProvisioned: boolean;
}

export interface Todo {
  id: string;
  userId: string;
  title: string;
  notes: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: TodoOrigin;
}

/** Emits `change` whenever anything is written, so the app view can update live. */
export const storeEvents = new EventEmitter();
storeEvents.setMaxListeners(50);

function announce(userId: string): void {
  storeEvents.emit("change", { userId, at: new Date().toISOString() });
}

// ---- row mapping ------------------------------------------------------------------

type UserRow = {
  id: string;
  idp_subject: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  jit_provisioned: number;
};

type TodoRow = {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
};

function toUser(row: UserRow): TodoUser {
  return {
    id: row.id,
    idpSubject: row.idp_subject,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    jitProvisioned: row.jit_provisioned === 1,
  };
}

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    notes: row.notes,
    status: row.status as TodoStatus,
    priority: row.priority as TodoPriority,
    dueDate: row.due_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by as TodoOrigin,
  };
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function now(): string {
  return new Date().toISOString();
}

function isoDaysFromNow(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

// ---- users ------------------------------------------------------------------------

/**
 * Just-in-time provisioning. A `sub` the app has never seen becomes a real row in the
 * users table, with a starting set of work so the first `list_todos` returns something
 * a room can read.
 */
export function findOrCreateUser(
  idpSubject: string,
  email: string | null,
): { user: TodoUser; created: boolean } {
  const existing = db
    .prepare("SELECT * FROM users WHERE idp_subject = ?")
    .get(idpSubject) as UserRow | undefined;

  if (existing) {
    // An email that only shows up on a later assertion still gets attached.
    if (!existing.email && email) {
      db.prepare("UPDATE users SET email = ? WHERE id = ?").run(
        email,
        existing.id,
      );
      existing.email = email;
    }
    return { user: toUser(existing), created: false };
  }

  const id = `user_${shortId()}`;
  const displayName = email ? (email.split("@")[0] ?? null) : null;
  db.prepare(
    `INSERT INTO users (id, idp_subject, email, display_name, created_at, jit_provisioned)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(id, idpSubject, email, displayName, now());

  seedTodosFor(id);
  announce(id);

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  return { user: toUser(row), created: true };
}

export function listUsers(): TodoUser[] {
  const rows = db
    .prepare("SELECT * FROM users ORDER BY created_at ASC")
    .all() as UserRow[];
  return rows.map(toUser);
}

export function getUser(userId: string): TodoUser | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
    | UserRow
    | undefined;
  return row ? toUser(row) : null;
}

// ---- todos ------------------------------------------------------------------------

export function listTodos(
  userId: string,
  filter?: { status?: TodoStatus },
): Todo[] {
  const rows = filter?.status
    ? (db
        .prepare(
          `SELECT * FROM todos WHERE user_id = ? AND status = ?
           ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                    COALESCE(due_date, '9999-12-31'), created_at`,
        )
        .all(userId, filter.status) as TodoRow[])
    : (db
        .prepare(
          `SELECT * FROM todos WHERE user_id = ?
           ORDER BY status, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                    COALESCE(due_date, '9999-12-31'), created_at`,
        )
        .all(userId) as TodoRow[]);
  return rows.map(toTodo);
}

export function getTodo(userId: string, id: string): Todo | null {
  const row = db
    .prepare("SELECT * FROM todos WHERE user_id = ? AND id = ?")
    .get(userId, id) as TodoRow | undefined;
  return row ? toTodo(row) : null;
}

export interface NewTodo {
  title: string;
  notes?: string | null;
  priority?: TodoPriority;
  dueDate?: string | null;
}

export function createTodo(
  userId: string,
  input: NewTodo,
  origin: TodoOrigin = "agent",
): Todo {
  const id = shortId();
  const timestamp = now();
  db.prepare(
    `INSERT INTO todos (id, user_id, title, notes, status, priority, due_date,
                        created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.title,
    input.notes ?? null,
    input.priority ?? "normal",
    input.dueDate ?? null,
    timestamp,
    timestamp,
    origin,
  );
  announce(userId);
  return getTodo(userId, id)!;
}

export function completeTodo(userId: string, id: string): Todo | null {
  const result = db
    .prepare(
      "UPDATE todos SET status = 'done', updated_at = ? WHERE user_id = ? AND id = ?",
    )
    .run(now(), userId, id);
  if (result.changes === 0) return null;
  announce(userId);
  return getTodo(userId, id);
}

export interface TodoPatch {
  title?: string;
  notes?: string | null;
  priority?: TodoPriority;
  dueDate?: string | null;
  status?: TodoStatus;
}

export function updateTodo(
  userId: string,
  id: string,
  patch: TodoPatch,
): Todo | null {
  const current = getTodo(userId, id);
  if (!current) return null;

  db.prepare(
    `UPDATE todos SET title = ?, notes = ?, priority = ?, due_date = ?, status = ?,
                      updated_at = ?
     WHERE user_id = ? AND id = ?`,
  ).run(
    patch.title ?? current.title,
    patch.notes === undefined ? current.notes : patch.notes,
    patch.priority ?? current.priority,
    patch.dueDate === undefined ? current.dueDate : patch.dueDate,
    patch.status ?? current.status,
    now(),
    userId,
    id,
  );
  announce(userId);
  return getTodo(userId, id);
}

export function countTodos(userId: string): {
  open: number;
  done: number;
  byAgent: number;
  byUser: number;
} {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END)      AS open,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)      AS done,
         SUM(CASE WHEN created_by = 'agent' THEN 1 ELSE 0 END) AS byAgent,
         SUM(CASE WHEN created_by = 'user'  THEN 1 ELSE 0 END) AS byUser
       FROM todos WHERE user_id = ?`,
    )
    .get(userId) as {
    open: number | null;
    done: number | null;
    byAgent: number | null;
    byUser: number | null;
  };
  return {
    open: row.open ?? 0,
    done: row.done ?? 0,
    byAgent: row.byAgent ?? 0,
    byUser: row.byUser ?? 0,
  };
}

// ---- seed -------------------------------------------------------------------------

/**
 * Plausible work for a newly provisioned user. Deliberately the kind of items an
 * identity team would actually have open, so a live `list_todos` reads as a real
 * backlog rather than "test 1, test 2".
 */
function seedTodosFor(userId: string): void {
  const seeds: (NewTodo & { status?: TodoStatus })[] = [
    {
      title: "Review Q3 access certification",
      notes: "Sign-off due to Compliance before the quarter closes.",
      priority: "high",
      dueDate: isoDaysFromNow(3),
    },
    {
      title: "Rotate the service account credentials for billing-sync",
      notes: "Coordinate with Platform so the nightly job doesn't fail.",
      priority: "high",
      dueDate: isoDaysFromNow(7),
    },
    {
      title: "Draft the SSO migration plan for the field org",
      priority: "normal",
      dueDate: isoDaysFromNow(14),
    },
    {
      title: "Follow up on the stuck renewal in the EMEA pipeline",
      notes: "Blocked on a contract redline.",
      priority: "normal",
    },
    {
      title: "Archive the deprecated SAML connection",
      priority: "low",
    },
    {
      title: "Update the on-call runbook",
      priority: "low",
      status: "done",
    },
  ];

  const timestamp = now();
  const insert = db.prepare(
    `INSERT INTO todos (id, user_id, title, notes, status, priority, due_date,
                        created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed')`,
  );
  for (const seed of seeds) {
    insert.run(
      shortId(),
      userId,
      seed.title,
      seed.notes ?? null,
      seed.status ?? "open",
      seed.priority ?? "normal",
      seed.dueDate ?? null,
      timestamp,
      timestamp,
    );
  }
}
