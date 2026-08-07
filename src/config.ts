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

    /**
     * Comma-separated paths to IdP signing certificates trusted out of band, tried in
     * addition to whatever the JWKS publishes.
     *
     * This exists because PingFederate can sign an ID-JAG with a certificate it does
     * not publish at /pf/JWKS — the token generator picks its own key. Distributing a
     * signing certificate out of band is a long-standing, legitimate pattern (it is how
     * SAML federations have always worked), but JWKS is better: it survives key
     * rotation without anyone copying a file. Prefer fixing the PingFederate side.
     */
    signingCertPaths: (process.env.PF_SIGNING_CERTS?.trim() || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
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
