/**
 * Step 6b: single-use enforcement on `jti`.
 *
 * `jti` is a required claim in the ID-JAG draft, and an assertion is a bearer
 * credential — anyone who captures one can present it until it expires. Remembering
 * each `jti` until its own `exp` passes makes redemption single-use, which shrinks the
 * replay window from "the whole assertion lifetime" to "nothing".
 *
 * In-memory is correct for a single-process demo. A clustered Resource AS needs shared
 * storage here, which is worth mentioning when someone asks how this scales.
 */

const seen = new Map<string, number>();

/** Drops entries whose assertions have expired anyway. */
function prune(now: number): void {
  for (const [jti, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(jti);
  }
}

/**
 * Records `jti` as redeemed. Returns false if it had already been redeemed.
 * `expSeconds` is the assertion's own `exp` — after that it fails the freshness check
 * regardless, so there's no reason to remember it any longer.
 */
export function claimJti(jti: string, expSeconds: number): boolean {
  const now = Date.now();
  prune(now);
  if (seen.has(jti)) return false;
  seen.set(jti, expSeconds * 1000);
  return true;
}

export function replayCacheSize(): number {
  prune(Date.now());
  return seen.size;
}
