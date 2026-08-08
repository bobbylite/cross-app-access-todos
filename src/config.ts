import { config as loadDotenv } from "dotenv";

loadDotenv();

/**
 * Every value the demo needs, validated at boot so a misconfiguration surfaces as a
 * named variable rather than as a confusing `invalid_grant` twenty minutes into a
 * live walkthrough.
 */

const missing: string[] = [];

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    missing.push(`${name} — ${hint}`);
    return "";
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    missing.push(`${name} — must be a number, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return parsed;
}

/**
 * `aud` comparison in the ID-JAG is an exact string match, so a stray trailing slash
 * between PingFederate's registered audience and ours is a real failure. We strip it
 * on our side and say so, rather than silently accepting both forms later.
 */
function canonical(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

const pfIssuer = canonical(
  required("PF_ISSUER", "PingFederate issuer URL, e.g. https://pf.example.com"),
);

const resourceAsIssuer = canonical(
  required(
    "RESOURCE_AS_ISSUER",
    "this server's issuer identifier — must match the `audience` registered in PingFederate exactly",
  ),
);

const mcpResource = canonical(
  required(
    "MCP_RESOURCE",
    "canonical URI of the MCP server, e.g. http://localhost:8082/mcp",
  ),
);

const clientId = required(
  "CLIENT_ID",
  "client_id allowed to redeem ID-JAGs here — the same client_id PingFederate puts in the assertion",
);

const clientSecret = required(
  "CLIENT_SECRET",
  "secret for CLIENT_ID, used for client authentication at POST /token",
);

export const config = {
  pf: {
    issuer: pfIssuer,
    discoveryUrl: optional(
      "PF_DISCOVERY_URL",
      `${pfIssuer}/.well-known/openid-configuration`,
    ),
    /** Skips discovery when set. Otherwise read from the discovery document at boot. */
    jwksUri: process.env.PF_JWKS_URI?.trim() || null,

  },

  resourceAs: {
    issuer: resourceAsIssuer,
    port: optionalNumber("AS_PORT", 8081),
    accessTokenTtlSeconds: optionalNumber("ACCESS_TOKEN_TTL_SECONDS", 900),
    clockSkewSeconds: optionalNumber("CLOCK_SKEW_SECONDS", 60),
  },

  mcp: {
    resource: mcpResource,
    port: optionalNumber("MCP_PORT", 8082),
  },

  /**
   * The chat client, and where it forwards to.
   *
   * `agentUrl` points at the AgentCore runtime — `agentcore dev` locally, or the
   * deployed `/invocations` endpoint later. Only this value changes between the two.
   */
  chat: {
    port: optionalNumber("CHAT_PORT", 8083),
    agentUrl: optional("AGENT_URL", "http://localhost:8080/invocations"),
  },

  /**
   * The chat client's own OIDC registration at PingFederate.
   *
   * This is a *separate* client from the one that redeems ID-JAGs. This one signs a
   * human in; that one acts on their behalf afterwards. Keeping them apart is the point
   * — the agent is a different party from the app the user logged into.
   *
   * PKCE is always used. A `clientSecret` is optional: set it for a confidential
   * client, leave it empty for a public client (PingFederate advertises `none` as a
   * token endpoint auth method, so both work).
   */
  oidc: {
    clientId: optional("OIDC_CLIENT_ID", ""),
    clientSecret: optional("OIDC_CLIENT_SECRET", ""),
    redirectUri: optional(
      "OIDC_REDIRECT_URI",
      `http://localhost:${optionalNumber("CHAT_PORT", 8083)}/auth/callback`,
    ),
    // PingFederate's discovery document advertises only `openid` and `profile`;
    // asking for `email` on top of those is rejected as an unknown scope.
    scopes: optional("OIDC_SCOPES", "openid profile"),
  },

  clients: [{ clientId, clientSecret }],

  /**
   * The scopes local policy is willing to grant. The granted set is the intersection
   * of this and what the ID-JAG asked for — see resource-as/policy.ts.
   */
  allowedScopes: optional("ALLOWED_SCOPES", "todos.read todos.write")
    .split(/\s+/)
    .filter(Boolean),
} as const;

export function assertConfigValid(): void {
  if (missing.length === 0) return;
  const lines = missing.map((m) => `  - ${m}`).join("\n");
  throw new Error(
    `Missing or invalid environment configuration:\n${lines}\n\nCopy .env.example to .env and fill these in.`,
  );
}
