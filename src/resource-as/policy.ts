import { config } from "../config.js";
import type { Trace } from "../trace.js";
import { OAuthError } from "./errors.js";
import type { IdJagClaims } from "./validateIdJag.js";
import type { LocalUser } from "./subjects.js";

/**
 * Step 8: the local authorization decision.
 *
 * This is the point of the whole exercise. PingFederate said who the user is and which
 * client is asking; it did not decide what this Resource AS hands out. That decision
 * happens here, and it can grant *less* than the assertion requested.
 *
 * The rule is deliberately trivial so it can be read aloud: the target resource must be
 * our MCP server, and the granted scope is the intersection of what was asked for and
 * what policy allows. Ask for `todos.admin` and it silently doesn't come back — the
 * `scope` in the response visibly differs from the `scope` in the ID-JAG.
 */

export interface AuthorizationDetail {
  type: string;
  locations?: string[];
  actions?: string[];
  [key: string]: unknown;
}

export interface PolicyDecision {
  resource: string;
  grantedScope: string[];
  requestedScope: string[];
  /** True when policy handed back less than was asked for. */
  narrowed: boolean;
  authorizationDetails: AuthorizationDetail[] | null;
}

function parseAuthorizationDetails(
  claims: IdJagClaims,
): AuthorizationDetail[] | null {
  const raw = claims.authorization_details;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (entry): entry is AuthorizationDetail =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as AuthorizationDetail).type === "string",
  );
}

export function applyPolicy(
  claims: IdJagClaims,
  _user: LocalUser,
  trace: Trace,
): PolicyDecision {
  // `resource` is optional in the draft. Absent, we assume the only resource we guard.
  const requestedResource = claims.resource ?? config.mcp.resource;
  if (requestedResource !== config.mcp.resource) {
    trace.fail(
      "8. local policy",
      `Requested resource '${requestedResource}' is not guarded by this server (expected '${config.mcp.resource}')`,
      "invalid_grant",
    );
    throw OAuthError.invalidGrant(
      `This authorization server only issues tokens for ${config.mcp.resource}`,
    );
  }

  // Absent `scope` means "whatever you'd normally give me", not "everything you have" —
  // but for a single-resource demo those coincide.
  const requestedScope = claims.scope
    ? claims.scope.split(/\s+/).filter(Boolean)
    : [...config.allowedScopes];

  const grantedScope = requestedScope.filter((s) =>
    config.allowedScopes.includes(s),
  );

  if (grantedScope.length === 0) {
    trace.fail(
      "8. local policy",
      `Requested [${requestedScope.join(" ")}], none of which policy allows [${config.allowedScopes.join(" ")}]`,
      "invalid_scope",
    );
    throw OAuthError.invalidScope(
      `None of the requested scopes are grantable here. Allowed: ${config.allowedScopes.join(" ")}`,
    );
  }

  // RAR objects get the same treatment: keep only what targets this resource, and
  // drop actions that don't map onto a granted scope.
  const requestedDetails = parseAuthorizationDetails(claims);
  const authorizationDetails =
    requestedDetails === null
      ? null
      : requestedDetails
          .filter(
            (d) =>
              !d.locations || d.locations.includes(config.mcp.resource),
          )
          .map((d) => ({
            ...d,
            locations: [config.mcp.resource],
            ...(d.actions
              ? {
                  actions: d.actions.filter((a) =>
                    grantedScope.some((s) => s.endsWith(`.${a}`) || s === a),
                  ),
                }
              : {}),
          }));

  return {
    resource: config.mcp.resource,
    grantedScope,
    requestedScope,
    narrowed: grantedScope.length !== requestedScope.length,
    authorizationDetails,
  };
}
