# Cross App Access demo — architecture notes for Claude Code

A real (not simulated) implementation of Cross App Access / ID-JAG against a live
PingFederate tenant. Full narrative in [README.md](README.md); this file is the
fast-orientation version for a coding session.

## The 3 components

| component | what it is | code | how it deploys |
|---|---|---|---|
| `resource` | Resource AS + MCP server + Todos app, bundled | `src/resource-as/`, `src/mcp/`, `src/todos/` | container (ECS Fargate target) |
| `chat` | UI, OIDC login, agent proxy, OTLP collector | `src/chat/` | container (ECS Fargate / App Runner target) |
| `agent` | LLM agent, XAA token chain, MCP client | `xaaagent/app/todos_agent/` | **AWS Bedrock AgentCore Runtime**, via `agentcore deploy` — not a generic container |

**Why `resource` is one bundle, not three:** Resource AS and MCP share one in-process
RS256 signing key (`src/keys.ts`), and Resource AS JIT-provisions users directly into the
same SQLite DB Todos/MCP reads (`src/resource-as/subjects.ts` → `todos/store.js`).
Splitting them further means building a real JWKS-fetch protocol and an HTTP
provisioning API — not done, and not needed unless asked for.

**Why `agent` is different from the other three:** it's not a plain container — it runs
on Bedrock AgentCore Runtime, a managed serverless product built specifically for agents.
`agentcore dev --skip-deploy --logs` (from `xaaagent/`) is the *local* dev mode; it runs
as an ordinary local process with zero cloud involvement. `agentcore deploy` is the
separate, later step for a stable, always-on instance. **Don't cycle through deploy while
iterating** — that's what local dev mode is for.

## Running it

- **`npm run dev`** — the original one-process fallback (`src/index.ts`, still
  maintained). Binds resource + chat together, reads the repo-root `.env`. Always works,
  zero Docker.
- **`.vscode/launch.json`** — one debug config per component (Resource / Chat / Agent)
  plus an "Everything" compound that launches all three with one click. Resource/Chat read
  the root `.env` by default (no `CONFIG_FILE` set); Agent reads
  `xaaagent/agentcore/.env.local` via VS Code's `envFile`.
- **`docker compose --env-file deploy/.env up -d --build`** — all three as real
  containers. `--env-file deploy/.env` is required on every compose invocation
  (build/up/down/logs/ps/restart) — compose doesn't auto-load it, since the repo root
  already has its own separate `.env` for the `npm run dev` path.

## Config model

Two separate, deliberately non-overlapping config sources — don't conflate them:

- **Repo-root `.env`** — used only by `npm run dev` / `src/index.ts` and by the VS Code
  launch configs for Resource/Chat. Gitignored.
- **`deploy/config/{resource,chat,agent}.env`** — used only by the Docker containers
  (`CONFIG_FILE` env var per service). Also gitignored; only the `.env.example` templates
  are committed.

The containers read `deploy/config/` as a read-only bind mount. Editing a file manually
requires restarting the target service (via `docker compose restart` or "force new deployment"
in AWS) — env vars are read once at boot (`src/config/load.ts`).

`RESOURCE_AS_ISSUER`/`MCP_RESOURCE` must match **byte-for-byte** whatever PingFederate is
registered to mint into the ID-JAG audience. The `deploy/config/*.env.example` defaults
use Docker network aliases (`http://resource-as:8081`, `http://todos-mcp:8082/mcp`); the
repo-root `.env` uses `http://localhost:8081` etc. Whichever you use, PF's registration
has to agree with it — this is the one config value that reaches outside the repo.

## Known PingFederate gotchas

- **Live tenant only — no mock IdP, ever.** Declined explicitly; the demo's whole value
  is that nothing is simulated. Don't propose an offline/mock fallback even as
  networking insurance. `npm run check` is the sanctioned offline path (verifies the
  resource-server half only, deliberately skips the PF leg).
- **PF signs ID-JAGs with a cert not published at `/pf/JWKS`** (CN=oauth, assertions
  carry `x5t` not `kid`). Worked around today via `PF_SIGNING_CERTS` pointing at the
  exported cert — a demo unblock, not the intended long-term story. Before a real
  customer-facing run, either publish that cert or repoint PF's ID-JAG generator at a
  published key.
- **Attribute-mapping `${username}` failures** ("No value found for required
  attribute/claim 'sub'", client sees `invalid_grant`/"No attributes found in the
  context of this grant") come from PF admin console contract-fulfillment config, not
  this code — use `${persistentgrant.USER_NAME}`/`USER_KEY` instead of `${username}`.

## AWS deployment plan (discussed, not yet built)

- `resource`, `chat` → **ECS Fargate**. ECS Service Connect replaces Docker network
  aliases for service-to-service DNS. EFS access points replace the `resource-keys`/
  `todos-data` named volumes and the `deploy/config` bind mount (read-only for both
  services). Secrets (`CLIENT_SECRET`, `OIDC_CLIENT_SECRET`) should move to AWS Secrets
  Manager rather than staying in plaintext env files once this is real infrastructure.
- `agent` → **Bedrock AgentCore Runtime** via `agentcore deploy` (see above) — not ECS.
- **Developing against a SaaS-hosted MCP server that needs to reach your machine**
  (e.g. ServiceNow's MCP tools needing a JWKS endpoint, redirect URI, or webhook target
  it can call into): tunnel the specific local endpoint out (Cloudflare Tunnel —
  already used earlier for the chat UI) and register the tunnel's public URL with the
  SaaS platform instead of `localhost`. This is unrelated to whether *your* agent is
  locally run or AgentCore-deployed; it's about whatever the third-party platform needs
  to call inbound.
