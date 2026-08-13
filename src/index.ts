// Must be first: OpenTelemetry patches http/express/fetch as they load, so anything
// imported above this line would be invisible to the trace. Both service modules also
// import this — importing it twice is a harmless no-op, Node caches the module.
import "./otel/bootstrap.js";

import { startResource } from "./services/resource.js";
import { startChat } from "./services/chat.js";

/**
 * The local, all-in-one fallback: everything in one process, exactly as this project
 * ran before the split into `resource`/`chat`/`agent` containers. Kept deliberately —
 * `npm run dev`/`npm run check` still boot this way, and it's the thing to reach for
 * if something breaks 20 minutes before a walkthrough and there's no time to debug a
 * multi-container setup. The containerized path is `src/services/resource.ts` and
 * `src/services/chat.ts` run as separate processes — see docker-compose.yml.
 */
async function main(): Promise<void> {
  await startResource();
  await startChat();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
