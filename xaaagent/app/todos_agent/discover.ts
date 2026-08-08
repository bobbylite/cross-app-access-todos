/**
 * Working out how to get in, rather than being told.
 *
 * The agent knows one thing at the start: the URL of an MCP server. Everything else —
 * which authorization server guards it, what kind of grant that server wants, where to
 * send it — is discovered by asking, in the order the specs lay out:
 *
 *   1. Call the resource with no token.                       → 401 + WWW-Authenticate
 *   2. Follow `resource_metadata` from the challenge.         → RFC 9728
 *   3. Read the authorization server it names.                → RFC 8414
 *   4. Notice it advertises the ID-JAG grant profile.         → the decision point
 *   5. Only now go to the IdP for an assertion of that kind.
 *
 * Step 4 is the one worth watching. Nothing in this file hard-codes "do a token
 * exchange" — the resource server's own metadata says an ID-JAG is what it takes, and
 * the agent reacts. Point it at a different MCP server advertising ordinary
 * authorization-code and this same code would reach a different conclusion.
 */

export interface Challenge {
  resourceMetadataUrl: string | null;
  scope: string | null;
  raw: string;
}

/** Parses a `WWW-Authenticate: Bearer ...` header into the bits that matter. */
export function parseChallenge(header: string): Challenge {
  const read = (key: string): string | null => {
    const match = header.match(new RegExp(`${key}="([^"]+)"`));
    return match?.[1] ?? null;
  };
  return {
    resourceMetadataUrl: read("resource_metadata"),
    scope: read("scope"),
    raw: header,
  };
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  tokenEndpoint: string;
  grantTypesSupported: string[];
  grantProfilesSupported: string[];
  scopesSupported: string[];
}

export interface Discovery {
  challenge: Challenge;
  resource: ProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  /** True when the AS says an ID-JAG is the assertion it expects. */
  wantsIdJag: boolean;
}

const ID_JAG_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/**
 * RFC 8414 3.1 well-known construction.
 *
 * The segment goes *between* host and path, so an issuer of `https://host/tenant1`
 * resolves to `https://host/.well-known/oauth-authorization-server/tenant1` — not
 * `.../tenant1/.well-known/...`. Only matters for multi-tenant issuers, which is
 * exactly where getting it wrong is hardest to debug.
 */
export function wellKnownUrl(issuer: string, suffix: string): string {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/${suffix}${path}`;
}

async function getJson(url: string, what: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${what} at ${url} returned ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Probes the resource unauthenticated and follows the trail its 401 leaves.
 *
 * `onStep` is called as each fact is learned, so the UI can show discovery happening
 * rather than presenting a finished conclusion.
 */
export async function discoverAccessRequirements(
  resourceUrl: string,
  onStep: (step: string, detail: string, ok: boolean) => void,
): Promise<Discovery> {
  // ---- 1. Ask without a token, on purpose ----------------------------------------
  const probe = await fetch(resourceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  if (probe.status !== 401) {
    throw new Error(
      `Expected a 401 challenge from ${resourceUrl}, got ${probe.status}. ` +
        `A protected MCP server should refuse an unauthenticated call.`,
    );
  }

  const header = probe.headers.get("www-authenticate") ?? "";
  const challenge = parseChallenge(header);
  onStep(
    "Called the MCP server with no token",
    `401 — the server replied with a Bearer challenge${
      challenge.scope ? `, scope="${challenge.scope}"` : ""
    }`,
    true,
  );

  if (!challenge.resourceMetadataUrl) {
    throw new Error(
      "The 401 carried no resource_metadata, so there is nothing to follow (RFC 9728).",
    );
  }

  // ---- 2. Follow the pointer the challenge left -----------------------------------
  const prmDoc = await getJson(
    challenge.resourceMetadataUrl,
    "Protected resource metadata",
  );
  const resource: ProtectedResourceMetadata = {
    resource: String(prmDoc.resource ?? resourceUrl),
    authorizationServers: strings(prmDoc.authorization_servers),
    scopesSupported: strings(prmDoc.scopes_supported),
  };
  if (resource.resource.replace(/\/$/, "") !== resourceUrl.replace(/\/$/, "")) {
    throw new Error(
      `The metadata at ${challenge.resourceMetadataUrl} describes ` +
        `${resource.resource}, not ${resourceUrl}. Refusing to follow it — an ` +
        `unvalidated pointer is how a hostile 401 sends a client to an authorization ` +
        `server the attacker controls.`,
    );
  }

  onStep(
    "Read the resource's metadata",
    `It is guarded by ${resource.authorizationServers[0] ?? "(none named)"}`,
    resource.authorizationServers.length > 0,
  );

  const asIssuer = resource.authorizationServers[0];
  if (!asIssuer) {
    throw new Error("The resource names no authorization server.");
  }

  // ---- 3. Ask that authorization server what it accepts ---------------------------
  const asDoc = await getJson(
    wellKnownUrl(asIssuer, "oauth-authorization-server"),
    "Authorization server metadata",
  );
  const authorizationServer: AuthorizationServerMetadata = {
    issuer: String(asDoc.issuer ?? asIssuer),
    tokenEndpoint: String(asDoc.token_endpoint ?? `${asIssuer}/token`),
    grantTypesSupported: strings(asDoc.grant_types_supported),
    grantProfilesSupported: strings(asDoc.authorization_grant_profiles_supported),
    scopesSupported: strings(asDoc.scopes_supported),
  };

  // ---- 4. The decision, taken from what it said -----------------------------------
  const wantsIdJag =
    authorizationServer.grantProfilesSupported.includes(ID_JAG_PROFILE) &&
    authorizationServer.grantTypesSupported.includes(JWT_BEARER);

  onStep(
    "Read what that server accepts",
    wantsIdJag
      ? `It advertises the ID-JAG grant profile — so an assertion from my IdP is what it wants`
      : `It advertises [${authorizationServer.grantTypesSupported.join(", ")}] — no ID-JAG profile`,
    wantsIdJag,
  );

  if (!wantsIdJag) {
    throw new Error(
      `${authorizationServer.issuer} does not advertise ` +
        `${ID_JAG_PROFILE}, so a Cross App Access exchange is not what it expects. ` +
        `An ordinary authorization-code flow would be the path here.`,
    );
  }

  return { challenge, resource, authorizationServer, wantsIdJag };
}
