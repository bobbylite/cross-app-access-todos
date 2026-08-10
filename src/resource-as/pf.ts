import { createHash } from "node:crypto";
import { type CryptoKey, createRemoteJWKSet, importJWK } from "jose";
import { config } from "../config.js";

/**
 * Everything this server needs to know about PingFederate: where its keys live, and
 * what issuer string to expect. Discovery runs once at boot so the JWKS URI isn't a
 * hand-copied environment variable that can drift from reality.
 */

export interface PfMetadata {
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string | null;
}

let metadata: PfMetadata | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function initPingFederate(): Promise<PfMetadata> {
  if (config.pf.jwksUri) {
    // Explicit override — skip discovery entirely.
    metadata = {
      issuer: config.pf.issuer,
      jwksUri: config.pf.jwksUri,
      tokenEndpoint: null,
    };
  } else {
    const response = await fetch(config.pf.discoveryUrl);
    if (!response.ok) {
      throw new Error(
        `PingFederate discovery failed: ${response.status} ${response.statusText} from ${config.pf.discoveryUrl}\n` +
          `Set PF_JWKS_URI to skip discovery, or check PF_ISSUER.`,
      );
    }
    const doc = (await response.json()) as Record<string, unknown>;

    const issuer = typeof doc.issuer === "string" ? doc.issuer : null;
    const jwksUri = typeof doc.jwks_uri === "string" ? doc.jwks_uri : null;
    if (!jwksUri) {
      throw new Error(
        `PingFederate discovery document at ${config.pf.discoveryUrl} has no jwks_uri`,
      );
    }

    // A mismatch here means PF_ISSUER is wrong, and every `iss` check would fail with
    // a much less obvious message later.
    if (issuer && issuer.replace(/\/$/, "") !== config.pf.issuer) {
      throw new Error(
        `PF_ISSUER is ${config.pf.issuer} but the discovery document says ${issuer}. ` +
          `The issuer must match exactly — fix PF_ISSUER.`,
      );
    }

    metadata = {
      issuer: config.pf.issuer,
      jwksUri,
      tokenEndpoint:
        typeof doc.token_endpoint === "string" ? doc.token_endpoint : null,
    };
  }

  // Caches keys and re-fetches automatically when an unknown `kid` shows up, so a key
  // rotation at PingFederate doesn't need a restart here.
  jwks = createRemoteJWKSet(new URL(metadata.jwksUri), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });

  return metadata;
}

export function pfMetadata(): PfMetadata {
  if (!metadata) throw new Error("initPingFederate() has not run yet");
  return metadata;
}

export function pfJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) throw new Error("initPingFederate() has not run yet");
  return jwks;
}

/**
 * Selecting PingFederate's signing key when the assertion has no `kid`.
 *
 * PingFederate does not put a `kid` on the ID-JAGs it issues — it uses `x5t`, the SHA-1
 * thumbprint of the signing certificate. Both are legal JOSE key hints, but only `kid` is
 * what an ordinary JWKS lookup keys on, so the usual path has nothing to resolve.
 *
 * `x5t` resolves it precisely: PingFederate publishes the same thumbprint on the JWKS
 * entry, so the header names exactly one certificate. Matching on it is a real lookup,
 * not a guess. Trying every published key remains as a last resort, which costs a few
 * milliseconds of local RSA work and admits nothing extra — a signature either verifies
 * under a key PingFederate publishes or it does not.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;

interface PfKey {
  key: CryptoKey;
  kid: string | null;
  /** SHA-1 certificate thumbprint, as published or derived from `x5c`. */
  x5t: string | null;
  /** SHA-256 certificate thumbprint. */
  x5tS256: string | null;
}

let cache: { keys: PfKey[]; fetchedAt: number } | null = null;

/** How the key that verified an assertion was found. Reported in the trace. */
export type KeyLookup = "kid" | "x5t" | "x5t#S256" | "exhaustive";

function thumbprint(x5c: unknown, algorithm: "sha1" | "sha256"): string | null {
  if (!Array.isArray(x5c) || typeof x5c[0] !== "string") return null;
  return createHash(algorithm)
    .update(Buffer.from(x5c[0], "base64"))
    .digest("base64url");
}

async function fetchKeys(forceRefresh: boolean): Promise<PfKey[]> {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && !forceRefresh) return cache!.keys;

  const jwksUri = pfMetadata().jwksUri;
  const startTime = Date.now();

  try {
    console.log(`[network] Fetching PingFederate JWKS from ${jwksUri}${forceRefresh ? " (forced refresh)" : ""}`);
    const response = await fetch(jwksUri);
    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const body = await response.text().catch(() => "(unable to read body)");
      throw new Error(
        `HTTP ${response.status} ${response.statusText} from ${jwksUri} (${elapsed}ms). Body: ${body.slice(0, 200)}`,
      );
    }

    const doc = (await response.json()) as { keys?: Record<string, unknown>[] };
    console.log(`[network] JWKS fetch succeeded in ${elapsed}ms, processing ${doc.keys?.length ?? 0} keys`);

    // Every RSA key, deliberately unfiltered by `alg` or `use`. Those are advisory
    // metadata, and filtering on them risks discarding the one key that would actually
    // have verified the assertion.
    const usable = (doc.keys ?? []).filter((k) => k.kty === "RSA");
    console.log(`[network] Found ${usable.length} RSA keys`);

    const keys: PfKey[] = [];
    for (const jwk of usable) {
      try {
        keys.push({
          key: (await importJWK(jwk, "RS256")) as CryptoKey,
          kid: typeof jwk.kid === "string" ? jwk.kid : null,
          // Derived from x5c when absent, so this works against a JWKS that publishes
          // the certificate chain but not the thumbprint.
          x5t:
            typeof jwk.x5t === "string" ? jwk.x5t : thumbprint(jwk.x5c, "sha1"),
          x5tS256:
            typeof jwk["x5t#S256"] === "string"
              ? (jwk["x5t#S256"] as string)
              : thumbprint(jwk.x5c, "sha256"),
        });
      } catch (err) {
        console.log(`[network] Skipped key ${typeof jwk.kid === "string" ? jwk.kid : "(no kid)"}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    cache = { keys, fetchedAt: Date.now() };
    console.log(`[network] Successfully cached ${keys.length} importable RSA keys`);
    return keys;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[network] Failed to fetch JWKS from ${jwksUri} after ${elapsed}ms: ${message}`);
    throw err;
  }
}

/**
 * The keys worth trying for this assertion, narrowed by whatever hint its header
 * carries. Returns how the narrowing happened so the trace can say which.
 */
export async function pfCandidateKeys(
  header: { kid?: unknown; x5t?: unknown; "x5t#S256"?: unknown },
  forceRefresh = false,
): Promise<{ keys: CryptoKey[]; how: KeyLookup; published: number }> {
  const published = await fetchKeys(forceRefresh);

  const sha256 = header["x5t#S256"];
  if (typeof sha256 === "string") {
    const matched = published.filter((k) => k.x5tS256 === sha256);
    if (matched.length > 0) {
      return {
        keys: matched.map((k) => k.key),
        how: "x5t#S256",
        published: published.length,
      };
    }
  }

  const sha1 = header.x5t;
  if (typeof sha1 === "string") {
    const matched = published.filter((k) => k.x5t === sha1);
    if (matched.length > 0) {
      return {
        keys: matched.map((k) => k.key),
        how: "x5t",
        published: published.length,
      };
    }
  }

  const kid = header.kid;
  if (typeof kid === "string") {
    const matched = published.filter((k) => k.kid === kid);
    if (matched.length > 0) {
      return {
        keys: matched.map((k) => k.key),
        how: "kid",
        published: published.length,
      };
    }
  }

  return {
    keys: published.map((k) => k.key),
    how: "exhaustive",
    published: published.length,
  };
}
