import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "../config.js";
import type { SigningKeys } from "../keys.js";
import { recentEvents, subscribe } from "../trace.js";
import { authorizationServerMetadata } from "./metadata.js";
import { pfMetadata } from "./pf.js";
import { registeredClientIds } from "./clients.js";
import { knownUsers } from "./subjects.js";
import { replayCacheSize } from "./replay.js";
import { tokenEndpoint } from "./tokenEndpoint.js";

const webDir = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "src",
  "web",
);

export function createResourceAsApp(keys: SigningKeys): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // ---- Discovery -----------------------------------------------------------------
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authorizationServerMetadata());
  });

  app.get("/jwks.json", (_req, res) => {
    res.json({ keys: [keys.publicJwk] });
  });

  // ---- The endpoint --------------------------------------------------------------
  app.post("/token", tokenEndpoint(keys));

  // ---- Live console --------------------------------------------------------------
  app.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    // Replay what already happened, so opening the console mid-demo isn't a blank page.
    for (const event of recentEvents()) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Proxies and browsers drop an idle event stream; a comment every 20s prevents it.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/config.json", (_req, res) => {
    res.json({
      resourceAsIssuer: config.resourceAs.issuer,
      mcpResource: config.mcp.resource,
      pfIssuer: pfMetadata().issuer,
      pfJwksUri: pfMetadata().jwksUri,
      registeredClients: registeredClientIds(),
      allowedScopes: config.allowedScopes,
      accessTokenTtlSeconds: config.resourceAs.accessTokenTtlSeconds,
    });
  });

  app.get("/state.json", (_req, res) => {
    res.json({ users: knownUsers(), redeemedJtis: replayCacheSize() });
  });

  app.use("/console", express.static(webDir));
  app.get("/", (_req, res) => res.redirect("/console"));

  return app;
}
