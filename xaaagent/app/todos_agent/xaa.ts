import { discoverAccessRequirements, type Discovery } from './discover.js';

/**
 * Cross App Access, from the agent's side.
 *
 * The agent never holds a credential for the todos app. What it holds is the caller's
 * own token — the one AgentCore already validated on the way in — and it trades that,
 * twice, for something the todos MCP server will accept:
 *
 *   caller's token  ──exchange at PingFederate──▶  ID-JAG   (aud: the Resource AS)
 *   ID-JAG          ──redeem at the Resource AS──▶  access token (aud: the MCP server)
 *
 * Nobody is asked to log in a second time, and the token that comes out works at exactly
 * one place.
 */

export interface XaaConfig {
  pfTokenEndpoint: string;
  resourceAsIssuer: string;
  resourceAsTokenEndpoint: string;
  mcpResource: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

export function loadXaaConfig(): XaaConfig {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new Error(
        `${name} is not set. The agent needs it to complete the token chain — ` +
          `see xaaagent/.env.local`,
      );
    }
    return value;
  };

  const resourceAsIssuer = required('RESOURCE_AS_ISSUER').replace(/\/$/, '');

  return {
    pfTokenEndpoint: required('PF_TOKEN_ENDPOINT'),
    resourceAsIssuer,
    resourceAsTokenEndpoint: `${resourceAsIssuer}/token`,
    mcpResource: required('MCP_RESOURCE'),
    clientId: required('CLIENT_ID'),
    clientSecret: required('CLIENT_SECRET'),
    scope: process.env.XAA_SCOPE?.trim() || 'todos.read todos.write',
  };
}

/** One narratable step of the chain, surfaced to the chat UI as it happens. */
export interface ChainStep {
  step: string;
  detail: string;
  ok: boolean;
}

export interface GrantedAccess {
  accessToken: string;
  scope: string;
  expiresAt: number;
  steps: ChainStep[];
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

/** Claims read without verification, for narration only — never for a decision. */
function peek(jwt: string): Record<string, unknown> {
  try {
    const segment = jwt.split('.')[1];
    if (!segment) return {};
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

/**
 * Step 1 — RFC 8693 token exchange at PingFederate.
 *
 * The response returns the ID-JAG in `access_token`, which surprises people; the field
 * that actually tells you what you got is `issued_token_type`, so it is checked rather
 * than assumed.
 */
async function exchangeForIdJag(
  config: XaaConfig,
  discovery: Discovery,
  subjectToken: string,
  steps: ChainStep[],
): Promise<string> {
  // Audience and resource come from what discovery found, not from configuration. That
  // is the difference between a client that was told where to go and one that worked
  // it out — and it is why pointing this agent at a different MCP server would just
  // work.
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    subject_token: subjectToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    audience: discovery.authorizationServer.issuer,
    resource: discovery.resource.resource,
    scope: discovery.challenge.scope ?? config.scope,
  });

  const response = await fetch(config.pfTokenEndpoint, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(config.clientId, config.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    steps.push({
      step: 'Token exchange at PingFederate',
      detail: `${response.status} — ${text.slice(0, 300)}`,
      ok: false,
    });
    throw new Error(`PingFederate token exchange failed: ${response.status} ${text}`);
  }

  const payload = JSON.parse(text) as {
    access_token?: string;
    issued_token_type?: string;
  };

  if (payload.issued_token_type !== 'urn:ietf:params:oauth:token-type:id-jag') {
    steps.push({
      step: 'Token exchange at PingFederate',
      detail:
        `issued_token_type is '${payload.issued_token_type}', not an ID-JAG. ` +
        `The client is probably not enabled for the ID-JAG grant.`,
      ok: false,
    });
    throw new Error(`Expected an ID-JAG, got issued_token_type=${payload.issued_token_type}`);
  }

  const idJag = payload.access_token;
  if (!idJag) throw new Error('PingFederate returned no access_token');

  const claims = peek(idJag);
  steps.push({
    step: 'Token exchange at PingFederate',
    detail: `ID-JAG issued for sub=${String(claims.sub)}, aud=${String(claims.aud)}`,
    ok: true,
  });
  return idJag;
}

/** Step 2 — redeem the assertion at the Resource AS, which runs its own ten checks. */
async function redeemIdJag(
  config: XaaConfig,
  discovery: Discovery,
  idJag: string,
  steps: ChainStep[],
): Promise<{ accessToken: string; scope: string; expiresIn: number }> {
  const response = await fetch(discovery.authorizationServer.tokenEndpoint, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(config.clientId, config.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: idJag,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    steps.push({
      step: 'Redeem at the Resource AS',
      detail: `${response.status} — ${text.slice(0, 300)}`,
      ok: false,
    });
    throw new Error(`Resource AS rejected the ID-JAG: ${response.status} ${text}`);
  }

  const payload = JSON.parse(text) as {
    access_token: string;
    scope?: string;
    expires_in?: number;
  };

  const claims = peek(payload.access_token);
  steps.push({
    step: 'Redeem at the Resource AS',
    detail:
      `Access token issued for ${String(claims.sub)}, aud=${String(claims.aud)}, ` +
      `scope=[${payload.scope ?? ''}]`,
    ok: true,
  });

  return {
    accessToken: payload.access_token,
    scope: payload.scope ?? '',
    expiresIn: payload.expires_in ?? 900,
  };
}

/**
 * Runs the chain once and caches the result per session.
 *
 * The ID-JAG is single-use by design, so the cache is not an optimisation — redeeming
 * the same assertion twice is refused at step 6b. Re-entering the chain means a fresh
 * exchange at PingFederate, which is exactly what happens when the access token expires.
 */
const cache = new Map<string, GrantedAccess>();
const EXPIRY_SKEW_MS = 30_000;

export async function accessForSession(
  config: XaaConfig,
  sessionId: string,
  callerToken: string,
): Promise<GrantedAccess> {
  const cached = cache.get(sessionId);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return { ...cached, steps: [] };
  }

  const steps: ChainStep[] = [];
  const callerClaims = peek(callerToken);
  steps.push({
    step: 'Caller identity',
    detail: `AgentCore validated a token for sub=${String(callerClaims.sub)}`,
    ok: true,
  });

  // Ask the resource what it wants before assuming anything.
  const discovery = await discoverAccessRequirements(
    config.mcpResource,
    (step, detail, ok) => steps.push({ step, detail, ok }),
  );

  const idJag = await exchangeForIdJag(config, discovery, callerToken, steps);
  const granted = await redeemIdJag(config, discovery, idJag, steps);

  const result: GrantedAccess = {
    accessToken: granted.accessToken,
    scope: granted.scope,
    expiresAt: Date.now() + granted.expiresIn * 1000,
    steps,
  };
  cache.set(sessionId, result);
  return result;
}
