import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CryptoKey,
  type JWK,
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
} from "jose";

/**
 * The Resource AS signs its own access tokens with this key. Self-signed is fine for a
 * demo, but the pair is persisted to disk so a server restart mid-walkthrough doesn't
 * invalidate an access token that's already sitting in a Postman environment.
 */

const keyDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "keys");
const privatePath = join(keyDir, "resource-as.private.pem");
const publicPath = join(keyDir, "resource-as.public.pem");

export interface SigningKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Published at /jwks.json and set as the `kid` header on issued access tokens. */
  kid: string;
  publicJwk: JWK;
}

async function readPair(): Promise<{ pkcs8: string; spki: string } | null> {
  try {
    const [pkcs8, spki] = await Promise.all([
      readFile(privatePath, "utf8"),
      readFile(publicPath, "utf8"),
    ]);
    return { pkcs8, spki };
  } catch {
    return null;
  }
}

export async function loadSigningKeys(): Promise<SigningKeys> {
  const existing = await readPair();

  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  if (existing) {
    privateKey = await importPKCS8(existing.pkcs8, "RS256", {
      extractable: true,
    });
    publicKey = await importSPKI(existing.spki, "RS256", { extractable: true });
  } else {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    await mkdir(keyDir, { recursive: true });
    await Promise.all([
      writeFile(privatePath, await exportPKCS8(privateKey), { mode: 0o600 }),
      writeFile(publicPath, await exportSPKI(publicKey)),
    ]);
    console.log(`Generated a new RS256 signing key pair in ${keyDir}`);
  }

  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);

  return {
    privateKey,
    publicKey,
    kid,
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
  };
}
