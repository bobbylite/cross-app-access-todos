import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/**
 * The todos application's own database.
 *
 * This is the point of the whole exercise being believable: the agent isn't reaching
 * into an array the MCP server made up, it's reaching into the application's real
 * records — the same rows the app's own UI renders. SQLite because it is a real
 * database with real constraints and real persistence, and it ships inside Node.
 */

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dbPath =
  process.env.TODOS_DB_PATH?.trim() || join(projectRoot, "data", "todos.db");

if (dbPath !== ":memory:") {
  mkdirSync(dirname(dbPath), { recursive: true });
}

export const db = new DatabaseSync(dbPath);

// Foreign keys are off by default in SQLite. A todo belonging to a user who doesn't
// exist is exactly the kind of thing a demo should be unable to produce.
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    idp_subject     TEXT NOT NULL UNIQUE,
    email           TEXT,
    display_name    TEXT,
    created_at      TEXT NOT NULL,
    jit_provisioned INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS todos (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    notes      TEXT,
    status     TEXT NOT NULL DEFAULT 'open'    CHECK (status IN ('open','done')),
    priority   TEXT NOT NULL DEFAULT 'normal'  CHECK (priority IN ('low','normal','high')),
    due_date   TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- How the row got here: 'seed' for the starting backlog, 'agent' for a write that
    -- arrived through MCP with an ID-JAG-derived token, 'user' for one a human made in
    -- the app's own UI. The whole demo is the difference between the last two.
    created_by TEXT NOT NULL DEFAULT 'seed'   CHECK (created_by IN ('seed','agent','user'))
  );

  CREATE INDEX IF NOT EXISTS idx_todos_user_status ON todos (user_id, status);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/**
 * Widen `created_by` on databases created before humans could write.
 *
 * SQLite can't alter a CHECK constraint in place, so the table is rebuilt. Cheap at demo
 * scale, and it beats telling anyone to delete their data to pick up a schema change.
 */
const SCHEMA_VERSION = 2;
const currentVersion = (
  db.prepare("PRAGMA user_version").get() as { user_version: number }
).user_version;

if (currentVersion < SCHEMA_VERSION) {
  const constraint = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='todos'")
      .get() as { sql: string } | undefined
  )?.sql;

  if (constraint && !constraint.includes("'user'")) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      BEGIN;
      CREATE TABLE todos_migrated (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        notes      TEXT,
        status     TEXT NOT NULL DEFAULT 'open'    CHECK (status IN ('open','done')),
        priority   TEXT NOT NULL DEFAULT 'normal'  CHECK (priority IN ('low','normal','high')),
        due_date   TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'seed'   CHECK (created_by IN ('seed','agent','user'))
      );
      INSERT INTO todos_migrated SELECT * FROM todos;
      DROP TABLE todos;
      ALTER TABLE todos_migrated RENAME TO todos;
      CREATE INDEX IF NOT EXISTS idx_todos_user_status ON todos (user_id, status);
      COMMIT;
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function databasePath(): string {
  return dbPath;
}
