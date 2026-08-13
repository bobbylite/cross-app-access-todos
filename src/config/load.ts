import { config as loadDotenv } from "dotenv";
import { FIELDS, type Profile } from "./schema.js";
import { assertProfileValid, validateProfile } from "./validate.js";

/**
 * Loads env vars for one service's profile from `process.env.CONFIG_FILE` (falling
 * back to `.env` in the working directory, same as the original single-file setup),
 * validates only the fields that profile actually needs, and returns the same shaped
 * config object every part of this codebase already imports.
 *
 * Kept deliberately separate from `process.env` access at import time (unlike the
 * original `config.ts`) so `validateProfile`/`validateConsistency` in `validate.ts`
 * can be exercised against arbitrary key/value maps — e.g. from the config editor's
 * in-browser form — without needing a real process environment.
 */

let loaded = false;

function readEnv(): Record<string, string> {
  if (!loaded) {
    loadDotenv({ path: process.env.CONFIG_FILE });
    loaded = true;
  }
  const out: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = process.env[field.name];
    if (value !== undefined) out[field.name] = value;
  }
  return out;
}

function get(values: Record<string, string>, name: string, fallback = ""): string {
  const raw = values[name]?.trim();
  return raw ? raw : fallback;
}

function getNumber(values: Record<string, string>, name: string, fallback: number): number {
  const raw = values[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function canonical(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export interface XaaConfig {
  pf: { issuer: string; discoveryUrl: string; jwksUri: string | null };
  resourceAs: {
    issuer: string;
    port: number;
    accessTokenTtlSeconds: number;
    clockSkewSeconds: number;
  };
  mcp: { resource: string; port: number };
  chat: { port: number; agentUrl: string; auditUrl: string };
  oidc: { clientId: string; clientSecret: string; redirectUri: string; scopes: string };
  clients: { clientId: string; clientSecret: string }[];
  allowedScopes: string[];
}

function buildConfig(values: Record<string, string>): XaaConfig {
  const pfIssuer = canonical(get(values, "PF_ISSUER"));
  const resourceAsIssuer = canonical(get(values, "RESOURCE_AS_ISSUER"));
  const mcpResource = canonical(get(values, "MCP_RESOURCE"));
  const chatPort = getNumber(values, "CHAT_PORT", 8083);

  return {
    pf: {
      issuer: pfIssuer,
      discoveryUrl: get(values, "PF_DISCOVERY_URL", `${pfIssuer}/.well-known/openid-configuration`),
      jwksUri: get(values, "PF_JWKS_URI") || null,
    },
    resourceAs: {
      issuer: resourceAsIssuer,
      port: getNumber(values, "AS_PORT", 8081),
      accessTokenTtlSeconds: getNumber(values, "ACCESS_TOKEN_TTL_SECONDS", 900),
      clockSkewSeconds: getNumber(values, "CLOCK_SKEW_SECONDS", 60),
    },
    mcp: {
      resource: mcpResource,
      port: getNumber(values, "MCP_PORT", 8082),
    },
    chat: {
      port: chatPort,
      agentUrl: get(values, "AGENT_URL", "http://localhost:8080/invocations"),
      auditUrl: get(values, "AUDIT_URL", `http://localhost:${getNumber(values, "MCP_PORT", 8082)}/api/audit`),
    },
    oidc: {
      clientId: get(values, "OIDC_CLIENT_ID"),
      clientSecret: get(values, "OIDC_CLIENT_SECRET"),
      redirectUri: get(values, "OIDC_REDIRECT_URI", `http://localhost:${chatPort}/auth/callback`),
      scopes: get(values, "OIDC_SCOPES", "openid profile"),
    },
    clients: [{ clientId: get(values, "CLIENT_ID"), clientSecret: get(values, "CLIENT_SECRET") }],
    allowedScopes: get(values, "ALLOWED_SCOPES", "todos.read todos.write")
      .split(/\s+/)
      .filter(Boolean),
  };
}

/** Loads config for one service profile. Does not validate — call assertConfigValid() separately. */
export function loadConfig(_profile: Profile): XaaConfig {
  return buildConfig(readEnv());
}

/** Validates one profile's required fields, throwing a combined error if any are missing/invalid. */
export function assertConfigValid(profile: Profile): void {
  assertProfileValid(profile, readEnv());
}

/**
 * For src/index.ts, the local all-in-one fallback: one config object, but validated
 * against *both* resource's and chat's required fields at once (a combined error
 * naming everything missing, not just whichever profile happened to be checked first).
 */
export function loadAllProfiles(): { config: XaaConfig; assertAll: () => void } {
  const values = readEnv();
  return {
    config: buildConfig(values),
    assertAll: () => {
      const errors = [
        ...validateProfile("resource", values),
        ...validateProfile("chat", values),
      ].filter((f) => f.level === "error");
      if (errors.length === 0) return;
      const seen = new Set<string>();
      const lines = errors
        .filter((f) => (seen.has(f.field) ? false : (seen.add(f.field), true)))
        .map((f) => `  - ${f.field} — ${f.message}`)
        .join("\n");
      throw new Error(
        `Missing or invalid environment configuration:\n${lines}\n\n` +
          `Copy .env.example to .env and fill these in.`,
      );
    },
  };
}
