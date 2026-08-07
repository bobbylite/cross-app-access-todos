import { readFile } from "node:fs/promises";
import {
  type CryptoKey,
  createRemoteJWKSet,
  importJWK,
  importSPKI,
  importX509,
} from "jose";
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

  await loadStaticSigningCerts();

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
 * Every RS256 signing key in PingFederate's JWKS, for assertions that arrive without a
 * `kid` header.
 *
 * PingFederate does not put a `kid` on the ID-JAGs it issues. That is permitted — `kid`
 * is a hint, not a requirement — but it means a JWKS holding more than one RS256 key is
 * ambiguous, and the usual "look the key up by kid" path has nothing to look up. The
 * remaining correct behaviour is to try each candidate and accept the assertion if any
 * one of them verifies it.
 *
 * This is not a weakening of the check. A signature either verifies under a key
 * PingFederate publishes or it does not; trying several costs a few milliseconds of
 * local RSA work and admits nothing extra.
 */
const CANDIDATE_TTL_MS = 10 * 60 * 1000;
let candidates: { keys: CryptoKey[]; fetchedAt: number } | null = null;

/** Certificates trusted out of band, loaded once at boot. */
let staticKeys: { key: CryptoKey; source: string }[] = [];

export async function loadStaticSigningCerts(): Promise<
  { key: CryptoKey; source: string }[]
> {
  staticKeys = [];
  for (const path of config.pf.signingCertPaths) {
    const raw = await readFile(path);
    const asText = raw.toString("utf8");
    // PingFederate exports PEM or DER depending on version; accept either.
    const pem = asText.includes("-----BEGIN")
      ? asText
      : `-----BEGIN CERTIFICATE-----\n${raw
          .toString("base64")
          .replace(/(.{64})/g, "$1\n")
          .trimEnd()}\n-----END CERTIFICATE-----\n`;
    const key = (pem.includes("BEGIN CERTIFICATE")
      ? await importX509(pem, "RS256")
      : await importSPKI(pem, "RS256")) as CryptoKey;
    staticKeys.push({ key, source: path });
  }
  return staticKeys;
}

export function staticSigningKeys(): CryptoKey[] {
  return staticKeys.map((s) => s.key);
}

export async function pfCandidateKeys(
  forceRefresh = false,
): Promise<CryptoKey[]> {
  const fresh =
    candidates && Date.now() - candidates.fetchedAt < CANDIDATE_TTL_MS;
  if (fresh && !forceRefresh) {
    return [...candidates!.keys, ...staticSigningKeys()];
  }

  const response = await fetch(pfMetadata().jwksUri);
  if (!response.ok) {
    throw new Error(
      `Could not fetch ${pfMetadata().jwksUri}: ${response.status} ${response.statusText}`,
    );
  }
  const doc = (await response.json()) as { keys?: Record<string, unknown>[] };

  // Every RSA key, deliberately unfiltered by `alg` or `use`. Those are advisory
  // metadata, and filtering on them risks discarding the one key that would actually
  // have verified the assertion. The signature check is the real gate.
  const usable = (doc.keys ?? []).filter((k) => k.kty === "RSA");

  const keys: CryptoKey[] = [];
  for (const jwk of usable) {
    try {
      keys.push((await importJWK(jwk, "RS256")) as CryptoKey);
    } catch {
      // A key we can't import is one we could never have verified against.
    }
  }

  candidates = { keys, fetchedAt: Date.now() };
  // Out-of-band certificates are appended, never substituted — the JWKS stays the
  // primary source and keeps working the moment PingFederate publishes the right key.
  return [...keys, ...staticSigningKeys()];
}
