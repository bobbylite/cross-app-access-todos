import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { config } from "../config.js";
import type { SigningKeys } from "../keys.js";
import type { PolicyDecision } from "./policy.js";
import type { LocalUser } from "./subjects.js";

/**
 * Step 9: mint our own access token.
 *
 * Note what changes between the ID-JAG and this token. `iss` becomes us, not
 * PingFederate. `sub` becomes our local user id, not the IdP's. And `aud` becomes the
 * MCP server, not this authorization server — so this token is useless at the endpoint
 * that issued it, and useless at anyone else's MCP server too.
 */

export interface IssuedToken {
  accessToken: string;
  expiresIn: number;
  claims: Record<string, unknown>;
}

export async function issueAccessToken(
  keys: SigningKeys,
  user: LocalUser,
  decision: PolicyDecision,
  clientId: string,
): Promise<IssuedToken> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresIn = config.resourceAs.accessTokenTtlSeconds;

  const claims: Record<string, unknown> = {
    iss: config.resourceAs.issuer,
    sub: user.localId,
    aud: config.mcp.resource,
    client_id: clientId,
    scope: decision.grantedScope.join(" "),
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + expiresIn,
    // Carried through so the todos API can show who the user is without a second
    // lookup, and so the IdP subject stays traceable end to end.
    idp_sub: user.idpSubject,
    ...(user.email ? { email: user.email } : {}),
    ...(decision.authorizationDetails?.length
      ? { authorization_details: decision.authorizationDetails }
      : {}),
  };

  const accessToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keys.kid, typ: "at+jwt" })
    .sign(keys.privateKey);

  return { accessToken, expiresIn, claims };
}
