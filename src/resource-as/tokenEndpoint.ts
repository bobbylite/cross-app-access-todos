import type { Request, Response } from "express";
import { config } from "../config.js";
import type { SigningKeys } from "../keys.js";
import { Trace } from "../trace.js";
import { authenticateClient } from "./clients.js";
import { OAuthError } from "./errors.js";
import { annotate } from "../otel/spans.js";
import { issueAccessToken } from "./issueToken.js";
import { applyPolicy } from "./policy.js";
import { resolveSubject } from "./subjects.js";
import { validateIdJag } from "./validateIdJag.js";

/**
 * POST /token — the one endpoint that matters.
 *
 * Redeems an ID-JAG for an access token good at our MCP server, following the
 * processing rules in §4.4.1 of the Identity Assertion JWT Authorization Grant draft.
 * Steps run in the order they're numbered, and each one narrates itself to the trace.
 */

export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

function formValue(req: Request, name: string): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  return typeof value === "string" && value !== "" ? value : null;
}

export function tokenEndpoint(keys: SigningKeys) {
  return async (req: Request, res: Response): Promise<void> => {
    const trace = new Trace("resource-as");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Trace-Id", trace.traceId);

    try {
      const grantType = formValue(req, "grant_type");
      trace.info(
        "0. request",
        `POST /token grant_type=${grantType ?? "(absent)"}`,
      );

      if (grantType !== JWT_BEARER_GRANT) {
        trace.fail(
          "0. request",
          `Expected grant_type '${JWT_BEARER_GRANT}', got '${grantType ?? "(absent)"}'`,
          "unsupported_grant_type",
        );
        throw OAuthError.unsupportedGrantType(
          `This endpoint only supports ${JWT_BEARER_GRANT}`,
        );
      }

      // ---- Step 1: is the caller a client we've registered? ----------------------
      const client = authenticateClient(req);
      trace.pass(
        "1. client authentication",
        `'${client.clientId}' authenticated via ${client.via}`,
      );

      const assertion = formValue(req, "assertion");
      if (!assertion) {
        trace.fail("1b. assertion present", "No 'assertion' parameter", "invalid_request");
        throw OAuthError.invalidRequest("Missing 'assertion' parameter");
      }

      // ---- Steps 2-6b: is this ID-JAG one we should honour? ----------------------
      const { claims, header } = await validateIdJag(
        assertion,
        client.clientId,
        trace,
      );

      // ---- Step 7: who is this, locally? -----------------------------------------
      const email = typeof claims.email === "string" ? claims.email : null;
      const { user, created } = resolveSubject(claims.sub, email);
      trace.pass(
        "7. subject resolution",
        created
          ? `JIT-provisioned '${user.localId}' for IdP sub '${claims.sub}'${email ? ` (${email})` : ""}`
          : `Matched existing '${user.localId}' for IdP sub '${claims.sub}'`,
      );

      // ---- Step 8: our decision, not PingFederate's ------------------------------
      const decision = applyPolicy(claims, user, trace);
      trace.pass(
        "8. local policy",
        decision.narrowed
          ? `Requested [${decision.requestedScope.join(" ")}] → granted [${decision.grantedScope.join(" ")}] (narrowed by policy)`
          : `Granted [${decision.grantedScope.join(" ")}] for ${decision.resource}`,
      );

      // ---- Step 9: mint ----------------------------------------------------------
      // The identity facts, on the span that represents this redemption. An identity
      // audience cares about exactly these: the person stayed the same across the
      // boundary, the audience changed, and the scope may have narrowed.
      annotate({
        "xaa.identity.idp_subject": claims.sub,
        "xaa.identity.local_subject": user.localId,
        "xaa.identity.jit_provisioned": created,
        "xaa.token.in.typ": "oauth-id-jag+jwt",
        "xaa.token.in.aud": String(claims.aud ?? ""),
        "xaa.token.in.iss": String(claims.iss ?? ""),
        "xaa.token.out.aud": decision.resource,
        "xaa.scope.requested": decision.requestedScope.join(" "),
        "xaa.scope.granted": decision.grantedScope.join(" "),
        "xaa.scope.narrowed": decision.narrowed,
        "xaa.actor.client_id": String(claims.client_id ?? ""),
      });

      const issued = await issueAccessToken(
        keys,
        user,
        decision,
        client.clientId,
      );
      trace.pass(
        "9. issue access token",
        `RS256, aud=${config.mcp.resource}, expires in ${issued.expiresIn}s`,
      );

      trace.tokens({
        "ID-JAG (from PingFederate)": { header, payload: claims },
        "Access token (issued here)": {
          header: { alg: "RS256", kid: keys.kid, typ: "at+jwt" },
          payload: issued.claims,
        },
      });

      // ---- Step 10: respond per §4.4.2 -------------------------------------------
      res.status(200).json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: issued.expiresIn,
        scope: decision.grantedScope.join(" "),
        resource: decision.resource,
        ...(decision.authorizationDetails?.length
          ? { authorization_details: decision.authorizationDetails }
          : {}),
      });
      trace.pass("10. response", "200 with token_type=Bearer");
    } catch (error) {
      // Every step narrates its own rejection before throwing, with one exception:
      // client authentication throws from clients.ts, which has no trace handle.
      if (error instanceof OAuthError) {
        if (error.code === "invalid_client") {
          trace.fail("1. client authentication", error.description, error.code);
          res.setHeader("WWW-Authenticate", 'Basic realm="resource-as"');
        }
        res.status(error.status).json(error.toJSON());
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : "";
      console.error(`[error] Unexpected error in token exchange (trace ${trace.traceId}): ${message}`);
      if (stack) console.error(`[error] Stack: ${stack}`);

      trace.fail("!! unexpected", message, "server_error");
      res.status(500).json({
        error: "server_error",
        error_description: "Unexpected error while processing the grant",
      });
    }
  };
}
