import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { recentAudit, recordAudit } from "./audit.js";
import { databasePath } from "./db.js";
import { clearSession, issueSession, sessionUser } from "./session.js";
import {
  completeTodo,
  countTodos,
  createTodo,
  getUser,
  listTodos,
  listUsers,
  storeEvents,
} from "./store.js";

/**
 * The todos application's own UI — mounted on the MCP origin because it is the same
 * application, just a different door.
 *
 * Reads are open (it is a localhost demo and the room needs to see the data). Writes
 * require a session, so there is no unauthenticated path sitting next to the one the
 * whole walkthrough secures. Every write records which door it came through, and the UI
 * badges them differently: a human over an app session, or an agent over an access token
 * the Resource AS minted from an ID-JAG.
 */

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");

/** Rejects the request and returns null unless a session is present. */
function requireSession(req: express.Request, res: express.Response) {
  const user = sessionUser(req);
  if (!user) {
    res
      .status(401)
      .json({ error: "sign in to the todos app before writing" });
    return null;
  }
  return user;
}

export function mountTodosApp(app: express.Express): void {
  app.use("/api", express.json({ limit: "32kb" }));

  // ---- session --------------------------------------------------------------------

  app.get("/api/session", (req, res) => {
    res.json({ user: sessionUser(req) });
  });

  app.post("/api/session", (req, res) => {
    const userId = String(
      (req.body as { userId?: unknown } | undefined)?.userId ?? "",
    );
    const user = getUser(userId);
    if (!user) {
      res.status(404).json({ error: "no such user" });
      return;
    }
    issueSession(res, user.id);
    res.json({ user });
  });

  app.delete("/api/session", (_req, res) => {
    clearSession(res);
    res.json({ user: null });
  });

  // ---- reads ----------------------------------------------------------------------

  app.get("/api/users", (_req, res) => {
    res.json({
      users: listUsers().map((user) => ({
        ...user,
        counts: countTodos(user.id),
      })),
      database: databasePath(),
    });
  });

  app.get("/api/users/:userId/todos", (req, res) => {
    const userId = req.params.userId;
    const user = getUser(userId);
    if (!user) {
      res.status(404).json({ error: "no such user" });
      return;
    }
    res.json({ user, todos: listTodos(userId), counts: countTodos(userId) });
  });

  // ---- writes, session only -------------------------------------------------------

  app.post("/api/todos", (req, res) => {
    const user = requireSession(req, res);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    const priority =
      body.priority === "low" || body.priority === "high" ? body.priority : "normal";
    const dueDate =
      typeof body.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.due_date)
        ? body.due_date
        : null;

    // The owner is the session's user, never a value from the request body — the same
    // rule the MCP tools follow with the token's subject.
    const todo = createTodo(
      user.id,
      {
        title,
        notes: typeof body.notes === "string" && body.notes ? body.notes : null,
        priority,
        dueDate,
      },
      "user",
    );
    recordAudit({
      action: "create_todo",
      subject: user.id,
      idpSubject: user.idpSubject,
      actorClient: null,
      authority: "session",
      detail: `created "${todo.title}"`,
    });
    res.status(201).json({ todo });
  });

  app.post("/api/todos/:id/complete", (req, res) => {
    const user = requireSession(req, res);
    if (!user) return;

    const todo = completeTodo(user.id, req.params.id);
    if (!todo) {
      res.status(404).json({ error: "no such todo" });
      return;
    }
    recordAudit({
      action: "complete_todo",
      subject: user.id,
      idpSubject: user.idpSubject,
      actorClient: null,
      authority: "session",
      detail: `completed "${todo.title}"`,
    });
    res.json({ todo });
  });

  /** The target system's own record of who did what, for whom, under what authority. */
  app.get("/api/audit", (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, requested)) : 15;
    res.json({ entries: recentAudit(limit) });
  });

  // ---- live updates ---------------------------------------------------------------

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const onChange = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    storeEvents.on("change", onChange);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      storeEvents.off("change", onChange);
    });
  });

  app.use("/app", express.static(publicDir));
}
