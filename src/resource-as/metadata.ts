import { config } from "../config.js";
import { JWT_BEARER_GRANT } from "./tokenEndpoint.js";

/**
 * RFC 8414 authorization server metadata.
 *
 * The `issuer` here is the exact string an ID-JAG must carry in `aud`. Publishing it
 * means the value PingFederate is configured with can be checked against the source of
 * truth instead of against someone's notes — which is the fastest way to settle the
 * trailing-slash argument.
 */
export function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: config.resourceAs.issuer,
    token_endpoint: `${config.resourceAs.issuer}/token`,
    jwks_uri: `${config.resourceAs.issuer}/jwks.json`,
    grant_types_supported: [JWT_BEARER_GRANT],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: config.allowedScopes,
    // No authorization endpoint: this server does one thing, and it isn't interactive.
    response_types_supported: [],
    resource_indicators_supported: true,
    authorization_details_types_supported: ["todos"],
  };
}

/**
 * RFC 9728 protected resource metadata for the MCP server, served from the MCP
 * listener. This is the document an MCP client fetches after a 401 to discover which
 * authorization server to go to — the seam a chatbot client attaches to later.
 */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: config.mcp.resource,
    authorization_servers: [config.resourceAs.issuer],
    scopes_supported: config.allowedScopes,
    bearer_methods_supported: ["header"],
    resource_documentation: `${config.resourceAs.issuer}/console`,
  };
}
