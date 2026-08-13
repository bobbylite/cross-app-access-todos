// Must be first: OpenTelemetry patches http/express/fetch as they load, so anything
// imported above this line would be invisible to the trace.
import "../otel/bootstrap.js";

import { createChatApp } from "../chat/server.js";
import { config } from "../config/for-chat.js";
import { listen } from "./listen.js";

/**
 * The `chat` service — human-facing UI, OIDC login, agent proxy, and OTLP collector.
 * Deliberately boots against only the "chat" config profile (`../config/for-chat.js`),
 * not the legacy shim — it needs none of the Resource AS's secrets to run.
 */
export async function startChat(): Promise<void> {
  const chat = createChatApp(config.chat.agentUrl);
  await listen(chat, config.chat.port, "Chat client");

  console.log(
    [
      "",
      `  Chat client          http://localhost:${config.chat.port}`,
      `    forwards to        ${config.chat.agentUrl}`,
      `    audit source       ${config.chat.auditUrl}`,
      "",
    ].join("\n"),
  );
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startChat().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
