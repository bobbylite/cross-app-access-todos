import { assertConfigValid, loadConfig } from "./load.js";

/**
 * The chat service's own config singleton — validated against only the "chat" profile's
 * required fields, not the full combined set the legacy `src/config.ts` shim still
 * enforces (which resource-as/mcp files continue to import unchanged, since chat
 * currently has no uniquely-required field that resource doesn't already require too —
 * see `src/config/schema.ts`). `chat/server.ts` and `chat/oidc.ts` import from here
 * instead of the shim specifically so the chat container can boot without `CLIENT_SECRET`,
 * which it never uses.
 */
assertConfigValid("chat");
export const config = loadConfig("chat");
