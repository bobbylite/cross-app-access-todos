import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { config } from "../config.js";
import { OAuthError } from "./errors.js";

/**
 * Step 1 of the pipeline: which downstream OAuth clients are allowed to redeem an
 * ID-JAG here at all. In a real deployment this is a client registration database; for
 * the demo it's whatever CLIENT_ID/CLIENT_SECRET are in .env.
 *
 * This registry matters more than it looks. The `client_id` claim inside the ID-JAG is
 * checked against whichever client authenticated here (step 5) — that binding is what
 * stops a stolen assertion from being redeemed by a different client.
 */

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
}

const registry = new Map<string, RegisteredClient>(
  config.clients.map((c) => [c.clientId, c]),
);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

interface PresentedCredentials {
  clientId: string;
  clientSecret: string;
  /** How the credentials arrived — worth naming out loud during the walkthrough. */
  via: "client_secret_basic" | "client_secret_post";
}

function presentedCredentials(req: Request): PresentedCredentials | null {
  const header = req.get("authorization");

  if (header?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString(
      "utf8",
    );
    const separator = decoded.indexOf(":");
    if (separator === -1) return null;
    return {
      // RFC 6749 §2.3.1 form-encodes both halves before base64.
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      via: "client_secret_basic",
    };
  }

  const body = req.body as Record<string, unknown> | undefined;
  const clientId = typeof body?.client_id === "string" ? body.client_id : null;
  const clientSecret =
    typeof body?.client_secret === "string" ? body.client_secret : null;
  if (clientId && clientSecret) {
    return { clientId, clientSecret, via: "client_secret_post" };
  }

  return null;
}

export interface AuthenticatedClient {
  clientId: string;
  via: PresentedCredentials["via"];
}

export function authenticateClient(req: Request): AuthenticatedClient {
  const presented = presentedCredentials(req);
  if (!presented) {
    throw OAuthError.invalidClient(
      "No client credentials — send HTTP Basic or client_id/client_secret in the body",
    );
  }

  const registered = registry.get(presented.clientId);
  if (!registered || !safeEqual(registered.clientSecret, presented.clientSecret)) {
    // Same message for unknown client and bad secret, so the endpoint isn't a
    // client_id oracle.
    throw OAuthError.invalidClient("Client authentication failed");
  }

  return { clientId: registered.clientId, via: presented.via };
}

export function registeredClientIds(): string[] {
  return [...registry.keys()];
}
