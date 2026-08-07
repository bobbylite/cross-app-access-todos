import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config.js";
import type { SigningKeys } from "../keys.js";
import { Trace } from "../trace.js";
import { protectedResourceMetadata } from "../resource-as/metadata.js";
import { mountTodosApp } from "../todos/app.js";
import { type AuthContext, bearerAuth, insufficientScope } from "./auth.js";
import { TOOL_SCOPES, registerTodoTools } from "./tools.js";

/**
 * The todos MCP server, protected by the access tokens our Resource AS issues.
 *
 * Runs stateless: `sessionIdGenerator: undefined` means no `initialize` handshake and
 * no `Mcp-Session-Id` to echo, so every call is one self-contained POST with a bearer
 * token. That's what makes the flow drivable from Postman, and it costs nothing here
 * because the todos store lives outside the transport anyway.
 */

function requiredScopeFor(body: unknown): { tool: string; scope: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const message = body as { method?: unknown; params?: unknown };
  if (message.method !== "tools/call") return null;
  const params = message.params as { name?: unknown } | undefined;
  const tool = typeof params?.name === "string" ? params.name : null;
  if (!tool) return null;
  const scope = TOOL_SCOPES[tool];
  return scope ? { tool, scope } : null;
}

export function createMcpApp(keys: SigningKeys): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // ---- RFC 9728: how a client finds the authorization server ----------------------
  // Served unauthenticated, by design — it's the answer to a 401.
  const metadataHandler = (
    _req: express.Request,
    res: express.Response,
  ): void => {
    res.json(protectedResourceMetadata());
  };
  app.get("/.well-known/oauth-protected-resource", metadataHandler);
  // Also served under the resource path, for clients that append the well-known
  // segment to the full canonical URI.
  app.get("/mcp/.well-known/oauth-protected-resource", metadataHandler);
  app.get("/.well-known/oauth-protected-resource/mcp", metadataHandler);

  // ---- Everything below needs a valid access token --------------------------------
  app.post("/mcp", bearerAuth(keys), async (req, res) => {
    const auth = res.locals.auth as AuthContext;
    const trace = (res.locals.trace as Trace) ?? new Trace("mcp");

    // Scope enforcement happens here rather than inside the tool, so the failure is a
    // real OAuth 403 with a challenge naming the scope the client is missing.
    const needed = requiredScopeFor(req.body);
    if (needed && !auth.scopes.includes(needed.scope)) {
      trace.fail(
        "B. scope check",
        `'${needed.tool}' needs '${needed.scope}', token carries [${auth.scopes.join(" ")}]`,
        "insufficient_scope",
      );
      insufficientScope(
        res,
        needed.scope,
        `Calling '${needed.tool}' requires the '${needed.scope}' scope`,
      );
      return;
    }
    if (needed) {
      trace.pass(
        "B. scope check",
        `'${needed.tool}' needs '${needed.scope}' — present in the token`,
      );
    }

    // A fresh server and transport per request: the stateless pattern, and it lets the
    // tools close over this caller's identity rather than looking it up.
    const server = new McpServer({
      name: "todos-mcp",
      version: "1.0.0",
    });
    registerTodoTools(server, auth, trace);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      trace.fail("B. mcp transport", reason, "server_error");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET /mcp is the server-initiated SSE stream, which a stateless server has no use
  // for. Say so explicitly rather than 404ing.
  app.get("/mcp", bearerAuth(keys), (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "This server is stateless; use POST /mcp",
      },
      id: null,
    });
  });

  // The application's own read-only view of the same records the tools operate on.
  mountTodosApp(app);

  app.get("/", (_req, res) => res.redirect("/app"));

  app.get("/whoami", (_req, res) => {
    res.json({
      resource: config.mcp.resource,
      authorization_servers: [config.resourceAs.issuer],
      hint: "POST /mcp with an Authorization: Bearer header",
    });
  });

  return app;
}
