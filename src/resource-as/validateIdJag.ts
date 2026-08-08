import { compactVerify, decodeJwt, decodeProtectedHeader, errors } from "jose";
import { config } from "../config.js";
import type { Trace } from "../trace.js";
import { OAuthError } from "./errors.js";
import { type KeyLookup, pfCandidateKeys, pfJwks, pfMetadata } from "./pf.js";
import { claimJti } from "./replay.js";

/**
 * Steps 2 through 6b of the draft's §4.4.1 processing rules.
 *
 * These run as separate, individually narrated checks rather than as one library call,
 * because the point of this server is that each rule is visible. `jose` could validate
 * signature, audience, issuer and expiry in a single `jwtVerify`, but then there'd be
 * nothing to step through.
 */

/** The `typ` header that distinguishes an ID-JAG from any other JWT PF signs. */
const ID_JAG_TYP = "oauth-id-jag+jwt";

export interface IdJagClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  client_id: string;
  jti: string;
  exp: number;
  iat: number;
  nbf?: number;
  scope?: string;
  resource?: string;
  email?: string;
  authorization_details?: unknown;
  [key: string]: unknown;
}

export interface ValidatedIdJag {
  claims: IdJagClaims;
  header: Record<string, unknown>;
}

function audienceList(aud: string | string[]): string[] {
  return Array.isArray(aud) ? aud : [aud];
}

function requireString(
  claims: Record<string, unknown>,
  name: string,
  trace: Trace,
): string {
  const value = claims[name];
  if (typeof value !== "string" || value === "") {
    trace.fail(
      "claims present",
      `Required claim '${name}' is missing or not a string`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant(`ID-JAG is missing required claim '${name}'`);
  }
  return value;
}

function requireNumber(
  claims: Record<string, unknown>,
  name: string,
  trace: Trace,
): number {
  const value = claims[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    trace.fail(
      "claims present",
      `Required claim '${name}' is missing or not a number`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant(`ID-JAG is missing required claim '${name}'`);
  }
  return value;
}

/**
 * Reports what was actually presented, before anything is verified.
 *
 * Nothing here is trusted — it exists so that "this isn't an ID-JAG" is visible on the
 * console immediately, rather than being inferred from a signature error three steps
 * later. The overwhelmingly common mistake is redeeming the wrong token: an ID token, or
 * a plain access token from an exchange where PingFederate ignored
 * `requested_token_type`.
 */
function describePresented(assertion: string, trace: Trace): void {
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(assertion) as Record<string, unknown>;
  } catch {
    trace.info(
      "1c. presented token",
      "Not a well-formed compact JWS — check for a truncated or wrapped paste",
    );
    return;
  }

  const typ = typeof header.typ === "string" ? header.typ : "(absent)";
  const alg = typeof header.alg === "string" ? header.alg : "(absent)";
  // PingFederate identifies the key by certificate thumbprint rather than `kid`, so
  // report whichever hint is actually present.
  const hint =
    typeof header.kid === "string"
      ? `kid=${header.kid}`
      : typeof header["x5t#S256"] === "string"
        ? `x5t#S256=${String(header["x5t#S256"])}`
        : typeof header.x5t === "string"
          ? `x5t=${header.x5t}`
          : "no key hint";

  let shape = "";
  try {
    const claims = decodeJwt(assertion) as Record<string, unknown>;
    const audience = Array.isArray(claims.aud)
      ? claims.aud.join(",")
      : String(claims.aud ?? "(absent)");
    shape = `, iss=${String(claims.iss ?? "(absent)")}, aud=${audience}`;

    // Name the impostor rather than just rejecting it.
    if (typ !== ID_JAG_TYP) {
      const looksLikeIdToken =
        "nonce" in claims || "at_hash" in claims || "auth_time" in claims;
      const guess = looksLikeIdToken
        ? "looks like an OIDC ID token"
        : "client_id" in claims
          ? "looks like an ordinary access token"
          : "unrecognised";
      shape += ` — ${guess}, not an ID-JAG`;
    }
  } catch {
    shape = ", payload not decodable";
  }

  trace.info("1c. presented token", `typ=${typ}, alg=${alg}, ${hint}${shape}`);
}

/**
 * Verifies the assertion's signature against a key PingFederate publishes.
 *
 * A `kid` is the ordinary path and jose resolves it directly, re-fetching the JWKS by
 * itself when the key is unknown. PingFederate's ID-JAGs carry `x5t` instead, so the
 * fallback matches on the certificate thumbprint the JWKS publishes alongside each key —
 * still a lookup, not a guess. Only when the header carries no usable hint at all does
 * this try every published key in turn.
 *
 * Every path ends in the same place: the assertion must verify under a key that
 * PingFederate's JWKS actually advertises.
 */
async function verifySignature(
  assertion: string,
): Promise<{ verified: Awaited<ReturnType<typeof compactVerify>>; how: KeyLookup }> {
  const header = decodeProtectedHeader(assertion) as Record<string, unknown>;

  if (typeof header.kid === "string") {
    try {
      return {
        verified: await compactVerify(assertion, pfJwks(), {
          algorithms: ["RS256"],
        }),
        how: "kid",
      };
    } catch {
      // A `kid` the remote set can't resolve still deserves the thumbprint path below.
    }
  }

  const attempt = async (refresh: boolean) => {
    const { keys, how, published } = await pfCandidateKeys(header, refresh);
    if (published === 0) {
      throw new Error(
        `no usable RS256 keys published at ${pfMetadata().jwksUri}`,
      );
    }
    for (const key of keys) {
      try {
        return {
          verified: await compactVerify(assertion, key, {
            algorithms: ["RS256"],
          }),
          how,
        };
      } catch {
        // Wrong key of several — keep going.
      }
    }
    return null;
  };

  const found = await attempt(false);
  if (found) return found;

  // Nothing matched. Re-fetch once in case PingFederate rotated since we last looked,
  // then give up.
  const afterRefresh = await attempt(true);
  if (afterRefresh) return afterRefresh;

  const { published } = await pfCandidateKeys(header);
  throw new Error(
    `no key among the ${published} RSA key(s) published at ${pfMetadata().jwksUri} verifies this assertion`,
  );
}

export async function validateIdJag(
  assertion: string,
  authenticatedClientId: string,
  trace: Trace,
): Promise<ValidatedIdJag> {
  describePresented(assertion, trace);

  // ---- Step 2: signature against PingFederate's JWKS, and the issuer it claims -----
  //
  // `algorithms` is pinned to RS256 on purpose: without it, a JWT presenting `alg:
  // none` or a symmetric algorithm is a well-known way to get a forged token accepted.
  let payloadBytes: Uint8Array;
  let header: Record<string, unknown>;
  let lookup: KeyLookup;
  try {
    const { verified, how } = await verifySignature(assertion);
    payloadBytes = verified.payload;
    header = verified.protectedHeader as Record<string, unknown>;
    lookup = how;
  } catch (cause) {
    // Recover whichever key hint the header carries, even though the signature didn't
    // hold — it is what makes a rotation or publishing problem diagnosable.
    let presentedHint = "unknown";
    try {
      const failed = decodeProtectedHeader(assertion) as Record<string, unknown>;
      presentedHint =
        typeof failed.kid === "string"
          ? `kid=${failed.kid}`
          : typeof failed["x5t#S256"] === "string"
            ? `x5t#S256=${String(failed["x5t#S256"])}`
            : typeof failed.x5t === "string"
              ? `x5t=${failed.x5t}`
              : "no key hint";
    } catch {
      /* not even a well-formed JWT */
    }
    let reason = cause instanceof Error ? cause.message : String(cause);

    // Reaching here means the thumbprint path found nothing and every published key was
    // tried — a genuine signature failure, not the ambiguity jose would otherwise report.
    if (cause instanceof errors.JWKSMultipleMatchingKeys) {
      reason =
        `${pfMetadata().jwksUri} holds several candidate keys and the assertion carries ` +
        `no 'kid' or 'x5t' that matches any of them`;
    }

    trace.fail(
      "2. signature (PF JWKS)",
      `Signature did not verify against ${pfMetadata().jwksUri} (${presentedHint}): ${reason}`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant("ID-JAG signature verification failed");
  }

  let rawClaims: Record<string, unknown>;
  try {
    rawClaims = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<
      string,
      unknown
    >;
  } catch {
    trace.fail("2. signature (PF JWKS)", "Payload is not JSON", "invalid_grant");
    throw OAuthError.invalidGrant("ID-JAG payload is not valid JSON");
  }

  // Naming how the key was located matters on stage: "matched on x5t" is a lookup
  // against published metadata, where "tried every key" is a brute-force fallback.
  const foundBy =
    lookup === "exhaustive"
      ? "no usable key hint — tried every published key"
      : `key found by ${lookup}=${String(
          header[lookup === "kid" ? "kid" : lookup] ?? "?",
        )}`;

  trace.pass(
    "2. signature (PF JWKS)",
    `RS256 verified against ${pfMetadata().jwksUri} — ${foundBy}`,
  );

  const iss = requireString(rawClaims, "iss", trace);
  if (iss.replace(/\/$/, "") !== pfMetadata().issuer) {
    trace.fail(
      "2b. iss claim",
      `Expected '${pfMetadata().issuer}', assertion says '${iss}'`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant("ID-JAG was not issued by the expected IdP");
  }
  trace.pass("2b. iss claim", `Issued by ${iss}`);

  // ---- Step 3: typed JWT ----------------------------------------------------------
  //
  // PingFederate signs plenty of JWTs with this same key: ID tokens, access tokens,
  // logout tokens. `typ` is the only thing that says "this one is an ID-JAG, meant to
  // be redeemed at a token endpoint". Accepting an ID token here would be a serious
  // confusion bug, and RFC 8725 exists because that bug is common.
  const typ = typeof header.typ === "string" ? header.typ : null;
  if (typ !== ID_JAG_TYP) {
    trace.fail(
      "3. typ header",
      `Expected '${ID_JAG_TYP}', got '${typ ?? "(absent)"}'`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant(
      `Assertion is not an ID-JAG — typ must be '${ID_JAG_TYP}'`,
    );
  }
  trace.pass("3. typ header", `typ = ${typ}`);

  // ---- Step 4: audience -----------------------------------------------------------
  //
  // Exact string comparison against our own issuer identifier. This is the check that
  // stops an ID-JAG minted for a different SaaS vendor from being spent here.
  const audClaim = rawClaims.aud;
  if (typeof audClaim !== "string" && !Array.isArray(audClaim)) {
    trace.fail("4. aud claim", "Required claim 'aud' is missing", "invalid_grant");
    throw OAuthError.invalidGrant("ID-JAG is missing required claim 'aud'");
  }
  const audiences = audienceList(audClaim as string | string[]);
  if (!audiences.includes(config.resourceAs.issuer)) {
    trace.fail(
      "4. aud claim",
      `Expected '${config.resourceAs.issuer}', assertion says '${audiences.join(", ")}'`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant(
      "ID-JAG audience does not match this authorization server",
    );
  }
  trace.pass("4. aud claim", `aud = ${config.resourceAs.issuer}`);

  // ---- Step 5: client binding -----------------------------------------------------
  //
  // The assertion names the client it was issued for. If a different client
  // authenticated at this endpoint, someone is redeeming a credential that isn't
  // theirs — a captured ID-JAG replayed by another party looks exactly like this.
  const clientIdClaim = requireString(rawClaims, "client_id", trace);
  if (clientIdClaim !== authenticatedClientId) {
    trace.fail(
      "5. client_id binding",
      `Assertion was issued to '${clientIdClaim}' but '${authenticatedClientId}' authenticated`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant(
      "ID-JAG client_id does not match the authenticated client",
    );
  }
  trace.pass(
    "5. client_id binding",
    `client_id claim '${clientIdClaim}' matches the authenticated client`,
  );

  // ---- Step 6: freshness ----------------------------------------------------------
  const exp = requireNumber(rawClaims, "exp", trace);
  const iat = requireNumber(rawClaims, "iat", trace);
  const nbf = typeof rawClaims.nbf === "number" ? rawClaims.nbf : null;
  const now = Math.floor(Date.now() / 1000);
  const skew = config.resourceAs.clockSkewSeconds;

  if (exp <= now - skew) {
    trace.fail(
      "6. exp / nbf / iat",
      `Expired ${now - exp}s ago (exp=${exp}, now=${now})`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant("ID-JAG has expired");
  }
  if (nbf !== null && nbf > now + skew) {
    trace.fail(
      "6. exp / nbf / iat",
      `Not valid for another ${nbf - now}s (nbf=${nbf}, now=${now})`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant("ID-JAG is not yet valid");
  }
  if (iat > now + skew) {
    trace.fail(
      "6. exp / nbf / iat",
      `Issued ${iat - now}s in the future (iat=${iat}, now=${now}) — check clock sync`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant("ID-JAG was issued in the future");
  }
  trace.pass(
    "6. exp / nbf / iat",
    `Valid for another ${exp - now}s (lifetime ${exp - iat}s, skew allowance ${skew}s)`,
  );

  // ---- Step 6b: single use --------------------------------------------------------
  const jti = requireString(rawClaims, "jti", trace);
  if (!claimJti(jti, exp)) {
    trace.fail(
      "6b. jti replay",
      `jti '${jti}' has already been redeemed — refusing to issue a second token`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant("ID-JAG has already been redeemed");
  }
  trace.pass("6b. jti replay", `jti '${jti}' not seen before, now consumed`);

  const sub = requireString(rawClaims, "sub", trace);

  return {
    claims: {
      ...rawClaims,
      iss,
      sub,
      aud: audClaim as string | string[],
      client_id: clientIdClaim,
      jti,
      exp,
      iat,
    },
    header,
  };
}
