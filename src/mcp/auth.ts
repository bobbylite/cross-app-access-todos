import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";
import { config } from "../config.js";
import type { SigningKeys } from "../keys.js";
import { Trace } from "../trace.js";

/**
 * Bearer token validation for the MCP server, acting as an OAuth 2.1 resource server.
 *
 * This check is entirely local — same process, same key, no network call to the
 * authorization server. That's worth saying out loud during a walkthrough, because the
 * usual objection to token-based access is "so now every API call needs a round trip to
 * the IdP", and it doesn't.
 */

export interface AuthContext {
  /** The Resource AS's local user id. */
  subject: string;
  /** The original IdP subject, carried through for traceability. */
  idpSubject: string | null;
  email: string | null;
  scopes: string[];
  clientId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      auth?: AuthContext;
      trace?: Trace;
    }
  }
}

/**
 * RFC 9728 §3.1: the well-known segment goes between the host and the resource's path,
 * so `http://host:8082/mcp` advertises
 * `http://host:8082/.well-known/oauth-protected-resource/mcp` — not the path-appended
 * form, which is the easy mistake and leaves conformant clients fetching a 404.
 */
function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

const metadataUrl = protectedResourceMetadataUrl(config.mcp.resource);

function challenge(params: Record<string, string>): string {
  const parts = Object.entries(params).map(([k, v]) => `${k}="${v}"`);
  return `Bearer ${parts.join(", ")}`;
}

/**
 * 401 with a pointer to the protected resource metadata. This is the entire discovery
 * bootstrap: a client that has never seen this server learns where to get a token from
 * the failure response.
 */
export function unauthorized(
  res: Response,
  description: string,
  scope?: string,
): void {
  res.setHeader(
    "WWW-Authenticate",
    challenge({
      resource_metadata: metadataUrl,
      ...(scope ? { scope } : { scope: config.allowedScopes.join(" ") }),
      error: "invalid_token",
      error_description: description,
    }),
  );
  res.status(401).json({
    error: "invalid_token",
    error_description: description,
  });
}

export function insufficientScope(
  res: Response,
  required: string,
  description: string,
): void {
  res.setHeader(
    "WWW-Authenticate",
    challenge({
      error: "insufficient_scope",
      scope: required,
      resource_metadata: metadataUrl,
      error_description: description,
    }),
  );
  res.status(403).json({
    error: "insufficient_scope",
    error_description: description,
  });
}

export function bearerAuth(keys: SigningKeys) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const trace = new Trace("mcp");
    res.locals.trace = trace;
    res.setHeader("X-Trace-Id", trace.traceId);

    const header = req.get("authorization");
    if (!header?.toLowerCase().startsWith("bearer ")) {
      trace.fail(
        "A. bearer token present",
        "No Authorization: Bearer header — replying 401 with resource_metadata",
        "invalid_token",
      );
      unauthorized(res, "An access token is required");
      return;
    }

    const token = header.slice(7).trim();

    try {
      // `audience` is the load-bearing option. A token minted for someone else's MCP
      // server verifies against a different key anyway, but a token minted by *us* for
      // a different resource would pass signature checks — and must still be rejected.
      const { payload } = await jwtVerify(token, keys.publicKey, {
        algorithms: ["RS256"],
        issuer: config.resourceAs.issuer,
        audience: config.mcp.resource,
        clockTolerance: config.resourceAs.clockSkewSeconds,
      });

      const scopes =
        typeof payload.scope === "string"
          ? payload.scope.split(/\s+/).filter(Boolean)
          : [];

      res.locals.auth = {
        subject: String(payload.sub ?? ""),
        idpSubject:
          typeof payload.idp_sub === "string" ? payload.idp_sub : null,
        email: typeof payload.email === "string" ? payload.email : null,
        scopes,
        clientId:
          typeof payload.client_id === "string" ? payload.client_id : null,
      };

      trace.pass(
        "A. access token",
        `Verified locally — iss=${config.resourceAs.issuer}, aud=${config.mcp.resource}, sub=${String(payload.sub)}, scope=[${scopes.join(" ")}]`,
      );
      next();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      trace.fail("A. access token", `Rejected: ${reason}`, "invalid_token");
      unauthorized(res, `Access token rejected: ${reason}`);
    }
  };
}
