---
name: aws-deploy
description: Deploy the XAA demo's components to AWS — resource/chat to ECS Fargate + EFS, agent to Bedrock AgentCore Runtime — and how to develop against a SaaS-hosted MCP server that needs inbound reachability.
---

# Deploying to AWS

This is a plan, not yet built infrastructure — treat it as the starting design, confirm
before provisioning anything real (cost, account access, and blast radius all apply).

## The agent does not go through this path

`xaaagent/app/todos_agent/` deploys via **Bedrock AgentCore Runtime**, a managed
serverless product built for agents specifically:

```bash
cd xaaagent && agentcore deploy
```

It does not use `deploy/agent.Dockerfile` or ECS. Don't containerize the agent for AWS
unless the user explicitly wants it off AgentCore Runtime for some reason — that would
be a deliberate deviation from the tool that already fits.

**Config changes to a deployed agent require a redeploy, not a live edit** — AgentCore
Runtime takes its config at `agentcore deploy` time, there's no mounted file it re-reads.
This is standard for managed/serverless runtimes (same as Lambda) — not a gap to work
around, just the model. Don't propose live-editing a deployed agent's env; propose a
fast redeploy loop instead if the user needs to iterate against it.

## `resource`, `chat` → ECS Fargate

| local (docker-compose) | AWS |
|---|---|
| `resource`/`chat` services | ECS Fargate services, one per component |
| images from `deploy/node.Dockerfile` | ECR — `docker build && docker push`, ECS pulls from there |
| `xaa` network + aliases `resource-as`/`todos-mcp` | ECS Service Connect (internal DNS, direct analog) |
| named volumes `resource-keys`/`todos-data` | EFS access points mounted into the Fargate task |
| `deploy/config` bind mount (`:ro`) | same model, on an EFS access point instead of local disk — no code change needed, it's still just files |
| `chat`'s public port | ALB in front of `chat` and `resource` (agent/browser both need to reach Resource's `/token`, `/console`, `/.well-known/...`) |

**Move secrets to Secrets Manager.** `CLIENT_SECRET`, `OIDC_CLIENT_SECRET` currently
live in plaintext env files — fine for local/single-operator use, not once this is real
shared infrastructure. Reference them from the ECS task definition's `secrets:` field
instead of baking them into the EFS-mounted env files. For config edits at deployed-time,
modify the EFS files directly and restart the affected service ("force new deployment").

## Developing against a SaaS-hosted MCP server (e.g. ServiceNow)

This is a different problem from "deploying our own containers" — it's about a
*third-party* platform needing to reach *your* machine, not the other way around. MCP
clients (the agent) normally just dial *out* to the MCP server, which works fine from a
laptop with no special setup. The exception is when the SaaS side needs to call
something of yours inbound — a JWKS endpoint for client-assertion verification, an OAuth
redirect/callback URI, or a webhook subscription target.

**Fix: tunnel the specific local endpoint out** (Cloudflare Tunnel —
`cloudflared tunnel --url http://localhost:PORT` — already used earlier in this project
for the chat UI) and register the tunnel's public HTTPS URL with the SaaS platform
instead of `localhost`. Nothing about your local code changes; only the URL handed to
the third party does. This is unrelated to whether your own agent is running locally or
deployed to AgentCore Runtime — it's purely about what the SaaS platform itself needs to
reach.

Ask which specific thing the SaaS side needs to reach before proposing a fix — a JWKS
endpoint, a redirect URI, and a webhook target are different pieces of the app and the
tunnel target differs accordingly.
