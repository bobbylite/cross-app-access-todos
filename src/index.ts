// Must be first: OpenTelemetry patches http/express/fetch as they load, so anything
// imported above this line would be invisible to the trace.
import "./otel/bootstrap.js";

import type express from "express";
import { createChatApp } from "./chat/server.js";
import { assertConfigValid, config } from "./config.js";
import { loadSigningKeys } from "./keys.js";
import { createMcpApp } from "./mcp/server.js";
import { createResourceAsApp } from "./resource-as/server.js";
import { initPingFederate } from "./resource-as/pf.js";
import { databasePath } from "./todos/db.js";

/**
 * One process, two listeners: the Resource AS (plus the live console) and the todos MCP
 * server. They're separate ports because they're separate roles — an authorization
 * server and a resource server — and the demo is clearer when the boundary is visible
 * in the URLs.
 */
/** Resolves once bound, and rejects with something readable if the port is taken. */
function listen(app: express.Express, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve());
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} (${label}) is already in use`)
          : error,
      );
    });
  });
}

async function main(): Promise<void> {
  assertConfigValid();

  const keys = await loadSigningKeys();
  const pf = await initPingFederate();

  const resourceAs = createResourceAsApp(keys);
  const mcp = createMcpApp(keys);

  await listen(resourceAs, config.resourceAs.port, "Resource AS");
  await listen(mcp, config.mcp.port, "MCP server");

  // The chat client. Served here rather than from the agent, because an AgentCore
  // runtime's contract is one /invocations endpoint, not a website.
  const chat = createChatApp(config.chat.agentUrl);
  await listen(chat, config.chat.port, "Chat client");

  const lines = [
    "",
    "  Cross App Access demo — Resource AS + todos MCP server",
    "",
    `  Resource AS issuer   ${config.resourceAs.issuer}`,
    `    token endpoint     POST ${config.resourceAs.issuer}/token`,
    `    metadata           ${config.resourceAs.issuer}/.well-known/oauth-authorization-server`,
    `    our JWKS           ${config.resourceAs.issuer}/jwks.json  (kid ${keys.kid})`,
    `    live console       ${config.resourceAs.issuer}/console`,
    "",
    `  MCP resource         ${config.mcp.resource}`,
    `    metadata           ${config.mcp.resource.replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource/mcp`,
    `    todos app           ${config.mcp.resource.replace(/\/mcp$/, "")}/app`,
    `    database           ${databasePath()}`,
    `  Chat client          http://localhost:${config.chat.port}`,
    `    forwards to        ${config.chat.agentUrl}`,
    "",
    `  PingFederate         ${pf.issuer}`,
    `    JWKS               ${pf.jwksUri}`,
    pf.tokenEndpoint ? `    token endpoint     ${pf.tokenEndpoint}` : "",
    "",
    `  Registered clients   ${config.clients.map((c) => c.clientId).join(", ")}`,
    `  Grantable scopes     ${config.allowedScopes.join(" ")}`,
    "",
    `  PingFederate must be configured to issue ID-JAGs with aud exactly:`,
    `    ${config.resourceAs.issuer}`,
    "",
  ].filter((line) => line !== "");

  console.log(lines.join("\n"));
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
