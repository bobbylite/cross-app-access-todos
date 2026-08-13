// Must be first: OpenTelemetry patches http/express/fetch as they load, so anything
// imported above this line would be invisible to the trace.
import "../otel/bootstrap.js";

import { assertConfigValid as assertProfileValid } from "../config/load.js";
import { config } from "../config.js";
import { loadSigningKeys } from "../keys.js";
import { createMcpApp } from "../mcp/server.js";
import { createResourceAsApp } from "../resource-as/server.js";
import { initPingFederate } from "../resource-as/pf.js";
import { databasePath } from "../todos/db.js";
import { listen } from "./listen.js";

/**
 * The `resource` service — Resource AS + MCP + Todos, one process, one container.
 *
 * These three share an in-memory RS256 signing key (Resource AS signs, MCP verifies
 * locally, no network hop) and a SQLite handle (the Resource AS JIT-provisions users
 * straight into the Todos database during token exchange) — both couplings that would
 * need a real protocol to split further, so they stay together on purpose. See the
 * plan file for the full reasoning.
 */
export async function startResource(): Promise<void> {
  // Validated against only this profile's required fields — CLIENT_SECRET,
  // RESOURCE_AS_ISSUER, MCP_RESOURCE etc. — not chat's (which has none of its own
  // anyway; see src/config/schema.ts).
  assertProfileValid("resource");

  const keys = await loadSigningKeys();
  const pf = await initPingFederate();

  const resourceAs = createResourceAsApp(keys);
  const mcp = createMcpApp(keys);

  await listen(resourceAs, config.resourceAs.port, "Resource AS");
  await listen(mcp, config.mcp.port, "MCP server");

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
    `    todos app          ${config.mcp.resource.replace(/\/mcp$/, "")}/app`,
    `    database           ${databasePath()}`,
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

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startResource().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
