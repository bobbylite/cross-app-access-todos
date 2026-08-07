import { findOrCreateUser, listUsers, type TodoUser } from "../todos/store.js";

/**
 * Step 7: subject resolution.
 *
 * The ID-JAG carries the IdP's identifier for the user (`sub`), which means nothing to
 * the todos app on its own. This is where it becomes a real row in that application's
 * user table — just-in-time provisioning, the pattern the draft recommends.
 *
 * Worth saying out loud on stage: the todos app had never heard of this person before
 * the assertion arrived. It didn't need to. PingFederate already vouched for them, so
 * the app only needs a stable key to hang their work off.
 */

/** The Resource AS's view of a provisioned user. Backed by the app's own database. */
export interface LocalUser {
  /** The todos app's identifier, distinct from the IdP's `sub`. */
  localId: string;
  /** The IdP's subject identifier — the join key. */
  idpSubject: string;
  email: string | null;
  createdAt: string;
  jitProvisioned: boolean;
}

function toLocalUser(user: TodoUser): LocalUser {
  return {
    localId: user.id,
    idpSubject: user.idpSubject,
    email: user.email,
    createdAt: user.createdAt,
    jitProvisioned: user.jitProvisioned,
  };
}

export interface ResolveResult {
  user: LocalUser;
  /** True when this call created the record — the live-demo moment. */
  created: boolean;
}

export function resolveSubject(
  idpSubject: string,
  email: string | null,
): ResolveResult {
  const { user, created } = findOrCreateUser(idpSubject, email);
  return { user: toLocalUser(user), created };
}

export function knownUsers(): LocalUser[] {
  return listUsers().map(toLocalUser);
}
