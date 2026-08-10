import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "../config.js";
import { auditEvents } from "../todos/audit.js";
import { ingest, subscribe } from "./collector.js";
import { beginLogin, completeLogin, oidcConfigured } from "./oidc.js";
import { clearSession, createSession, publicView, readSession } from "./session.js";

/**
 * The chat client.
 *
 * Two jobs. It signs the user in against PingFederate, and it forwards their turns to
 * the AgentCore runtime with the resulting token attached — the same `Authorization`
 * header the runtime's request-header allowlist will supply once deployed, so the agent
 * cannot tell local from deployed.
 *
 * Sign-in is deliberately *not* required to start talking. The agent answers ordinary
 * questions unauthenticated and asks for a login only when a turn actually needs the
 * user's todos. That ordering is the demonstration: authorization arrives when it is
 * needed, for the thing that needs it.
 */

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");

export function createChatApp(agentUrl: string): express.Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // ---- OTLP receiver ------------------------------------------------------------
  //
  // Every process in the demo exports here. Spans arrive in batches, so a trace is
  // assembled over several of these before it is complete.

  app.post(
    "/v1/traces",
    express.json({ limit: "8mb", type: () => true }),
    (req, res) => {
      try {
        ingest(req.body as Parameters<typeof ingest>[0]);
      } catch {
        // A malformed export must never take the chat down mid-demo.
      }
      res.status(200).json({ partialSuccess: {} });
    },
  );

  /** Live traces, pushed as they are assembled. */
  app.get("/api/traces/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    // Deliberately no replay of stored traces. A refresh is how you clear the stage
    // before presenting, so the pane shows only what happens from now on.
    const unsubscribe = subscribe((trace) => {
      res.write(`data: ${JSON.stringify(trace)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---- who am I ---------------------------------------------------------------

  app.get("/api/session", (req, res) => {
    res.json({
      ...publicView(readSession(req)),
      loginAvailable: oidcConfigured(),
    });
  });

  app.post("/api/logout", (req, res) => {
    clearSession(req, res);
    res.json({ signedIn: false });
  });

  // ---- sign in ----------------------------------------------------------------

  app.get("/auth/login", async (_req, res) => {
    if (!oidcConfigured()) {
      res
        .status(503)
        .send(
          "OIDC isn't configured. Set OIDC_CLIENT_ID (and OIDC_CLIENT_SECRET for a " +
            "confidential client) in .env, then restart.",
        );
      return;
    }
    try {
      const { authorizeUrl } = await beginLogin();
      res.redirect(authorizeUrl);
    } catch (error) {
      res.status(500).send(String(error instanceof Error ? error.message : error));
    }
  });

  /**
   * Where PingFederate sends the browser back.
   *
   * This runs in a popup, so it renders a tiny page that tells the opener what happened
   * and closes itself — the conversation underneath never navigates away.
   */
  app.get("/auth/callback", async (req, res) => {
    const send = (ok: boolean, detail: string) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="font:15px system-ui;padding:2rem;color:#16191d">
<p>${ok ? "Signed in. You can close this window." : detail}</p>
<script>
  window.opener?.postMessage(
    { source: "xaa-chat-auth", ok: ${ok}, detail: ${JSON.stringify(detail)} },
    window.location.origin,
  );
  if (${ok}) setTimeout(() => window.close(), 400);
</script>
</body>`);
    };

    const error = typeof req.query.error === "string" ? req.query.error : null;
    if (error) {
      const description =
        typeof req.query.error_description === "string"
          ? req.query.error_description
          : "";
      send(false, `PingFederate returned "${error}". ${description}`);
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) {
      send(false, "The callback arrived without a code and state.");
      return;
    }

    try {
      const { idToken, claims } = await completeLogin(code, state);
      createSession(res, idToken, claims);
      send(true, "ok");
    } catch (err) {
      send(false, err instanceof Error ? err.message : String(err));
    }
  });

  // ---- the conversation --------------------------------------------------------

  app.post("/api/chat", async (req, res) => {
    const body = req.body as { prompt?: unknown; sessionId?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId
        ? body.sessionId
        : "chat-session";

    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    const session = readSession(req);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
      };
      // Attached only when there is one. Its absence is what makes the agent ask.
      if (session) headers.Authorization = `Bearer ${session.idToken}`;

      console.log(`[chat] Forwarding to agent: POST ${agentUrl} (sessionId: ${sessionId}, auth: ${session ? "attached" : "none"})`);
      const startTime = Date.now();
      const upstream = await fetch(agentUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt }),
      });

      const elapsed = Date.now() - startTime;
      console.log(`[chat] Agent response: ${upstream.status} ${upstream.statusText} (${elapsed}ms)`);

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => "");
        console.error(`[chat] Agent error: ${upstream.status} - ${detail.slice(0, 300)}`);
        res.write(
          `data: ${JSON.stringify(
            `The agent returned ${upstream.status}. ${detail.slice(0, 300)}`,
          )}\n\n`,
        );
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[chat] Failed to reach agent at ${agentUrl}: ${message}`);
      if (error instanceof Error) {
        console.error(`[chat] Error: ${error.constructor.name} - ${error.stack}`);
      }
      res.write(
        `data: ${JSON.stringify(
          `Could not reach the agent at ${agentUrl}. Is 'agentcore dev' running? (${message})`,
        )}\n\n`,
      );
      res.end();
    }
  });

  /**
   * The target system's own log, streamed to the pane.
   *
   * Read straight from the todos app's audit table rather than over HTTP — all three
   * listeners share a process. What matters is that this is the *resource app's*
   * record, not the agent's telemetry: the distinction between "the agent did this"
   * and "the agent did this for Ryland" is one the target system has to be able to
   * make on its own.
   */
  app.get("/api/obo/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const onAudit = (entry: unknown) => {
      res.write(`data: ${JSON.stringify({ entry })}\n\n`);
    };
    auditEvents.on("audit", onAudit);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      auditEvents.off("audit", onAudit);
    });
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      agentUrl,
      issuer: config.pf.issuer,
      loginAvailable: oidcConfigured(),
    });
  });

  app.use("/", express.static(publicDir));
  return app;
}
