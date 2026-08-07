/**
 * Answers one question: is this assertion signed by ANY key the IdP publishes?
 *
 * Step 2 already tries every RSA key in the JWKS. When it still fails, the useful thing
 * to know is whether the key is simply absent from that endpoint — which happens when an
 * IdP signs different token types with different keys and only publishes some of them.
 *
 *   npx tsx scripts/probe-jwks.ts <assertion> [jwks-url]
 *   npx tsx scripts/probe-jwks.ts <assertion> --cert <path-to.pem>
 *
 * The JWKS URL defaults to PF_JWKS_URI, or PingFederate's discovery document.
 *
 * `--cert` tests one exported certificate directly, which settles the question the
 * PingFederate admin console raises but cannot answer: is *this* the certificate that
 * signed the assertion? Export it from Security → Certificate & Key Management, or from
 * the Manage Certificates button on the connection's Credentials screen.
 */

import { readFile } from "node:fs/promises";
import { config as loadDotenv } from "dotenv";
import {
  compactVerify,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  importSPKI,
  importX509,
} from "jose";
import type { CryptoKey } from "jose";

loadDotenv();

const assertion = process.argv[2];
if (!assertion) {
  console.error(
    "usage: npx tsx scripts/probe-jwks.ts <assertion> [jwks-url]\n",
  );
  process.exit(2);
}

async function resolveJwksUri(): Promise<string> {
  const fromArg = process.argv[3];
  if (fromArg) return fromArg;

  const fromEnv = process.env.PF_JWKS_URI?.trim();
  if (fromEnv) return fromEnv;

  const issuer = process.env.PF_ISSUER?.trim().replace(/\/$/, "");
  if (!issuer) {
    throw new Error("Pass a JWKS URL, or set PF_JWKS_URI / PF_ISSUER in .env");
  }
  const discoveryUrl =
    process.env.PF_DISCOVERY_URL?.trim() ??
    `${issuer}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(`Discovery failed: ${response.status} at ${discoveryUrl}`);
  }
  const doc = (await response.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`No jwks_uri at ${discoveryUrl}`);
  return doc.jwks_uri;
}

function short(value: unknown, length = 28): string {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

async function main(): Promise<void> {
  console.log("\n── The assertion ───────────────────────────────────────────");
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(assertion!) as Record<string, unknown>;
  } catch {
    console.error("  Not a well-formed compact JWS. Check for a truncated paste.");
    process.exit(1);
  }
  console.log(`  header    ${JSON.stringify(header)}`);

  try {
    const claims = decodeJwt(assertion!) as Record<string, unknown>;
    console.log(`  iss       ${String(claims.iss)}`);
    console.log(`  aud       ${JSON.stringify(claims.aud)}`);
    console.log(`  client_id ${String(claims.client_id ?? "(absent)")}`);
    const exp = typeof claims.exp === "number" ? claims.exp : 0;
    const remaining = exp - Math.floor(Date.now() / 1000);
    console.log(
      `  exp       ${exp} (${remaining > 0 ? `${remaining}s left` : `expired ${-remaining}s ago`})`,
    );
  } catch {
    console.log("  payload   not decodable");
  }

  const segments = assertion!.split(".");
  console.log(
    `  segments  header ${segments[0]?.length}c · payload ${segments[1]?.length}c · signature ${segments[2]?.length}c`,
  );
  if ((segments[2]?.length ?? 0) < 300) {
    console.log(
      "  ⚠ an RS256 signature over a 2048-bit key is ~342 chars — this looks truncated",
    );
  }

  // ---- Single-certificate mode ---------------------------------------------------
  const certFlag = process.argv.indexOf("--cert");
  if (certFlag !== -1) {
    const certPath = process.argv[certFlag + 1];
    if (!certPath) {
      console.error("\n  --cert needs a path to a PEM file\n");
      process.exit(2);
    }

    // PingFederate hands out PEM or DER depending on version and export path. Accept
    // either rather than making anyone reach for openssl mid-debug.
    const raw = await readFile(certPath);
    const asText = raw.toString("utf8");
    const pem = asText.includes("-----BEGIN")
      ? asText
      : `-----BEGIN CERTIFICATE-----\n${raw
          .toString("base64")
          .replace(/(.{64})/g, "$1\n")
          .trimEnd()}\n-----END CERTIFICATE-----\n`;

    if (!asText.includes("-----BEGIN")) {
      console.log("\n  (read as DER, converted to PEM)");
    }

    const alg = typeof header.alg === "string" ? header.alg : "RS256";

    let key: CryptoKey;
    try {
      key = (pem.includes("BEGIN CERTIFICATE")
        ? await importX509(pem, alg)
        : await importSPKI(pem, alg)) as CryptoKey;
    } catch (error) {
      console.error(
        `\n  Could not read ${certPath} as a certificate or public key: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }

    console.log(`\n── ${certPath} ──`);
    try {
      await compactVerify(assertion!, key);
      console.log("  ✓ THIS CERTIFICATE SIGNED THE ASSERTION\n");
      console.log(
        "── Verdict ─────────────────────────────────────────────────\n" +
          "  Confirmed signer. If it is absent from the JWKS, that is the gap:\n" +
          "  publish it, or point PF_JWKS_URI at an endpoint that carries it.\n",
      );
    } catch {
      console.log("  ✗ this certificate did not sign the assertion\n");
      console.log(
        "── Verdict ─────────────────────────────────────────────────\n" +
          "  Not the signer. Whatever this certificate is configured for, it is not\n" +
          "  what minted this token — keep looking at the other token generators.\n",
      );
    }
    return;
  }

  const jwksUri = await resolveJwksUri();
  console.log(`\n── ${jwksUri} ──`);

  const response = await fetch(jwksUri);
  if (!response.ok) {
    console.error(`  Fetch failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const doc = (await response.json()) as { keys?: Record<string, unknown>[] };
  const keys = doc.keys ?? [];
  console.log(`  ${keys.length} key(s) published\n`);

  let matched = false;

  for (const [index, jwk] of keys.entries()) {
    const label =
      `  [${index}] kty=${String(jwk.kty)} alg=${String(jwk.alg ?? "-")} ` +
      `use=${String(jwk.use ?? "-")} kid=${short(jwk.kid)}`;

    let key: CryptoKey;
    try {
      // Import under the assertion's own alg so EC and RSA keys both get a fair try.
      const alg = typeof header.alg === "string" ? header.alg : "RS256";
      key = (await importJWK(jwk, alg)) as CryptoKey;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`${label}\n        skipped — cannot import: ${reason}`);
      continue;
    }

    try {
      await compactVerify(assertion!, key);
      console.log(`${label}\n        ✓ THIS KEY VERIFIES THE ASSERTION`);
      matched = true;
    } catch {
      console.log(`${label}\n        ✗ does not verify`);
    }
  }

  console.log("\n── Verdict ─────────────────────────────────────────────────");
  if (matched) {
    console.log(
      "  Signed by a key this endpoint publishes. If step 2 still fails, the\n" +
        "  Resource AS is reading a different JWKS — check PF_JWKS_URI.\n",
    );
  } else {
    console.log(
      "  No key at this endpoint verifies the assertion.\n\n" +
        "  The signing key is not published here. In PingFederate, the key used to\n" +
        "  sign an issued token is chosen by the token generator or access token\n" +
        "  manager handling that exchange, and it is not necessarily the OIDC\n" +
        "  provider key served at /pf/JWKS.\n\n" +
        "  Worth checking:\n" +
        "    · which signing certificate the ID-JAG token generator is configured with\n" +
        "    · whether that certificate is published on any JWKS endpoint\n" +
        "    · whether the assertion survived the trip intact (see segment sizes above)\n",
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
