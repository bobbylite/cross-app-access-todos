import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "../config.js";
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

      const upstream = await fetch(agentUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt }),
      });

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => "");
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
      res.write(
        `data: ${JSON.stringify(
          `Could not reach the agent at ${agentUrl}. Is 'agentcore dev' running? (${message})`,
        )}\n\n`,
      );
      res.end();
    }
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
