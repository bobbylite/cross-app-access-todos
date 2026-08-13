---
name: telemetry-check
description: Verify OpenTelemetry tracing still works end-to-end after touching resource, chat, or agent code — the waterfall, identity ribbon, and audit pane, with no orphan spans at rest.
---

# Telemetry regression check

Telemetry in this project has broken silently multiple times — once over a Cloudflare
Tunnel, once when the audit log was decoupled from an in-process EventEmitter to an HTTP
poll. It fails **quietly**: the rest of the app keeps working, the trace pane just goes
blank or stale. Run this after any change touching `src/otel/`, `src/chat/server.ts`,
`src/resource-as/`, `src/mcp/`, `src/services/`, or the agent's `otel.ts`/`xaa.ts`.

## The check

1. Start the stack (see the `run-locally` skill) and open the chat UI.
2. Sign in, ask "What's on my list?" — a real turn that exercises the full chain.
3. Confirm the **waterfall** shows the complete PF → Resource AS → MCP chain, not a
   partial trace.
4. Confirm the **identity ribbon** populates with the token subject/scope, not blank.
5. Confirm the **audit pane** gains a new row for the turn just run.
6. Sit idle for 60 seconds with nothing happening in the UI. Confirm **no new spans
   appear** in that window. New spans at rest is the signature of a polling loop that's
   supposed to be excluded from tracing but isn't (see the `ignoreOutgoingRequestHook`/
   `ignoreIncomingRequestHook` in `src/otel/bootstrap.ts` — any new polled endpoint added
   to chat or the config editor needs to be added there too, in the same change).

## Specific regression signatures to know

- **Chat needing `--experimental-sqlite`** — it shouldn't. If it suddenly does, some
  change reintroduced a transitive import of `src/todos/db.ts` into the chat path,
  undoing the audit-coupling cut. Grep chat's import graph for `todos/`.
- **`/api/obo/recent` returning `{"entries":[],"stale":true}`** — chat couldn't reach
  Resource's `/api/audit` over HTTP. Usually a wrong `AUDIT_URL` (check it resolves to
  wherever Resource actually is — `localhost` outside Docker, the `todos-mcp` network
  alias inside it) or Resource simply isn't up.
- **A dead OTLP exporter target fails silently** — nothing crashes, spans just never
  arrive. Check each process's own boot log for its `[otel] exporting spans to ...` line
  first; a wrong URL there (e.g. still pointing at a Cloudflare Tunnel hostname that
  rotated, or a Docker-only alias used outside Docker) is the most common cause and
  won't produce any error on its own.
- **A new poll loop without an ignore-hook entry** — causes exactly the "new spans at
  rest" symptom in step 6. Fix in `src/otel/bootstrap.ts`, not by suppressing the
  symptom elsewhere.
