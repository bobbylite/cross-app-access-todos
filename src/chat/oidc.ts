import { createHash, randomBytes } from "node:crypto";
import { config } from "../config/for-chat.js";

/**
 * OIDC authorization code flow against PingFederate, for the chat client.
 *
 * The user signs in here exactly once. Everything downstream — the ID-JAG, the access
 * token, the tool calls — is derived from the token this produces, without ever asking
 * them again. That is the whole argument the demo is making, so it matters that this is
 * a real login and not a paste box.
 *
 * PKCE is unconditional. A confidential client additionally authenticates with its
 * secret; a public client relies on PKCE alone, which PingFederate supports.
 */

export interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

let endpoints: OidcEndpoints | null = null;

export async function discoverOidc(): Promise<OidcEndpoints> {
  if (endpoints) return endpoints;

  const url = config.pf.discoveryUrl;
  console.log(`[oidc] Discovering endpoints from ${url}`);
  const startTime = Date.now();

  try {
    const response = await fetch(url);
    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`OIDC discovery failed: ${response.status} from ${url} (${elapsed}ms)`);
    }

    const doc = (await response.json()) as Record<string, string>;
    console.log(`[oidc] Discovery succeeded in ${elapsed}ms`);

    if (!doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error(`${url} is missing authorization_endpoint or token_endpoint`);
    }

    endpoints = {
      issuer: doc.issuer ?? config.pf.issuer,
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
    };
    console.log(`[oidc] Using auth endpoint: ${endpoints.authorizationEndpoint}`);
    return endpoints;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[oidc] Discovery failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/** True when enough is configured for a login to be attempted at all. */
export function oidcConfigured(): boolean {
  return config.oidc.clientId.trim().length > 0;
}

export interface PendingLogin {
  state: string;
  codeVerifier: string;
  createdAt: number;
}

/**
 * In-flight logins, keyed by `state`.
 *
 * Short-lived and in memory: a login that hasn't come back within a few minutes is
 * abandoned, and losing them on restart just means signing in again.
 */
const pending = new Map<string, PendingLogin>();
const LOGIN_TTL_MS = 10 * 60 * 1000;

function sweep(): void {
  const cutoff = Date.now() - LOGIN_TTL_MS;
  for (const [state, login] of pending) {
    if (login.createdAt < cutoff) pending.delete(state);
  }
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

export async function beginLogin(): Promise<{ authorizeUrl: string; state: string }> {
  sweep();
  const { authorizationEndpoint } = await discoverOidc();

  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );

  pending.set(state, { state, codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    scope: config.oidc.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    authorizeUrl: `${authorizationEndpoint}?${params.toString()}`,
    state,
  };
}

export interface LoginResult {
  idToken: string;
  claims: Record<string, unknown>;
}

/** Claims read without verification — display only. PingFederate verifies at exchange. */
function peek(jwt: string): Record<string, unknown> {
  try {
    const segment = jwt.split(".")[1];
    if (!segment) return {};
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export async function completeLogin(
  code: string,
  state: string,
): Promise<LoginResult> {
  sweep();
  const login = pending.get(state);
  if (!login) {
    // Either forged, replayed, or simply stale. All three deserve the same answer.
    throw new Error(
      "That sign-in didn't match a request we started. Try signing in again.",
    );
  }
  pending.delete(state);

  console.log(`[oidc] Exchanging authorization code for ID token`);
  const { tokenEndpoint } = await discoverOidc();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.oidc.redirectUri,
    client_id: config.oidc.clientId,
    code_verifier: login.codeVerifier,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (config.oidc.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(
      `${config.oidc.clientId}:${config.oidc.clientSecret}`,
    ).toString("base64")}`;
  }

  const startTime = Date.now();
  try {
    console.log(`[oidc] POST ${tokenEndpoint} (with ${config.oidc.clientSecret ? "client secret" : "PKCE only"})`);
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers,
      body,
    });

    const elapsed = Date.now() - startTime;
    const text = await response.text();
    console.log(`[oidc] Token endpoint response: ${response.status} (${elapsed}ms, ${text.length} bytes)`);

    if (!response.ok) {
      throw new Error(`PingFederate rejected the code: ${response.status} ${text}`);
    }

    const payload = JSON.parse(text) as { id_token?: string };
    if (!payload.id_token) {
      throw new Error(
        "PingFederate returned no id_token. Is `openid` in OIDC_SCOPES, and does the " +
          "client have the OIDC policy attached?",
      );
    }

    console.log(`[oidc] ✓ Got ID token, claims: ${JSON.stringify(peek(payload.id_token))}`);
    return { idToken: payload.id_token, claims: peek(payload.id_token) };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[oidc] Token exchange failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
