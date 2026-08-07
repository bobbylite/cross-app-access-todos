import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Trace } from "../trace.js";
import type { AuthContext } from "./auth.js";
import {
  completeTodo,
  countTodos,
  createTodo,
  listTodos,
  updateTodo,
} from "../todos/store.js";

/**
 * The scope each tool needs. Enforced at the HTTP layer before the JSON-RPC body ever
 * reaches the MCP server (see mcp/server.ts), so an under-scoped call gets a proper
 * 403 `insufficient_scope` with a `WWW-Authenticate` challenge rather than a tool
 * result that happens to say no.
 */
export const TOOL_SCOPES: Record<string, string> = {
  list_todos: "todos.read",
  get_todo_summary: "todos.read",
  create_todo: "todos.write",
  complete_todo: "todos.write",
  update_todo: "todos.write",
};

function text(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function failure(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

const priority = z.enum(["low", "normal", "high"]);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export function registerTodoTools(
  server: McpServer,
  auth: AuthContext,
  trace: Trace,
): void {
  // Note what isn't a parameter on any of these: the user. The subject comes from the
  // verified access token and is applied in the SQL, so a caller cannot reach another
  // person's records even by guessing an id.
  const owner = auth.subject;

  server.registerTool(
    "list_todos",
    {
      title: "List todos",
      description:
        "List the signed-in user's todo items, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["open", "done"])
          .optional()
          .describe("Only return items with this status"),
      },
    },
    async ({ status }) => {
      const todos = listTodos(owner, status ? { status } : undefined);
      trace.pass(
        "B. tools/call list_todos",
        `Returned ${todos.length} row(s)${status ? ` with status=${status}` : ""} for ${owner}`,
      );
      return text({ todos });
    },
  );

  server.registerTool(
    "get_todo_summary",
    {
      title: "Summarise todos",
      description:
        "Counts of the signed-in user's open and completed items, and how many the agent created.",
      inputSchema: {},
    },
    async () => {
      const counts = countTodos(owner);
      trace.pass(
        "B. tools/call get_todo_summary",
        `${counts.open} open, ${counts.done} done, ${counts.byAgent} agent-created`,
      );
      return text(counts);
    },
  );

  server.registerTool(
    "create_todo",
    {
      title: "Create todo",
      description: "Add a new todo item for the signed-in user.",
      inputSchema: {
        title: z.string().min(1).describe("What needs doing"),
        notes: z.string().optional().describe("Any extra detail"),
        priority: priority.optional().describe("Defaults to normal"),
        due_date: isoDate.optional().describe("Due date, YYYY-MM-DD"),
      },
    },
    async ({ title, notes, priority: p, due_date }) => {
      const todo = createTodo(
        owner,
        {
          title,
          notes: notes ?? null,
          priority: p,
          dueDate: due_date ?? null,
        },
        "agent",
      );
      trace.pass(
        "B. tools/call create_todo",
        `Wrote '${todo.id}' (${todo.priority}) for ${owner}`,
      );
      return text({ todo });
    },
  );

  server.registerTool(
    "complete_todo",
    {
      title: "Complete todo",
      description: "Mark one of the signed-in user's todo items as done.",
      inputSchema: {
        id: z.string().min(1).describe("Id of the todo to complete"),
      },
    },
    async ({ id }) => {
      const todo = completeTodo(owner, id);
      if (!todo) {
        trace.fail(
          "B. tools/call complete_todo",
          `No todo '${id}' belonging to ${owner}`,
          "not_found",
        );
        return failure(`No todo with id '${id}'`);
      }
      trace.pass("B. tools/call complete_todo", `Closed '${todo.id}' for ${owner}`);
      return text({ todo });
    },
  );

  server.registerTool(
    "update_todo",
    {
      title: "Update todo",
      description:
        "Change the title, notes, priority, due date or status of an existing item.",
      inputSchema: {
        id: z.string().min(1).describe("Id of the todo to change"),
        title: z.string().min(1).optional(),
        notes: z.string().optional(),
        priority: priority.optional(),
        due_date: isoDate.optional(),
        status: z.enum(["open", "done"]).optional(),
      },
    },
    async ({ id, title, notes, priority: p, due_date, status }) => {
      const todo = updateTodo(owner, id, {
        ...(title !== undefined ? { title } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(p !== undefined ? { priority: p } : {}),
        ...(due_date !== undefined ? { dueDate: due_date } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      if (!todo) {
        trace.fail(
          "B. tools/call update_todo",
          `No todo '${id}' belonging to ${owner}`,
          "not_found",
        );
        return failure(`No todo with id '${id}'`);
      }
      trace.pass("B. tools/call update_todo", `Updated '${todo.id}' for ${owner}`);
      return text({ todo });
    },
  );
}
