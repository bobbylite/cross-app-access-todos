---
name: run-locally
description: Start, stop, and debug the XAA demo's 3 components (resource, chat, agent) locally without Docker.
---

# Running the XAA demo locally

Three components, three ways to run them. Pick based on what the user is trying to do —
don't default to Docker for local iteration, it's slower to restart.

## Option A — one process, zero setup (`npm run dev`)

```bash
npm run dev
```

Runs `src/index.ts`, the kept-on-purpose all-in-one fallback. Binds resource
(8081/8082) + chat (8083) in one `tsx watch` process, reads the repo-root `.env`.
Reloads on save. This is the fastest path when the user just wants it running — no
Docker, no per-service ports to juggle.

The agent is separate either way:

```bash
cd xaaagent && agentcore dev --skip-deploy --logs
```

## Option B — VS Code, per-component debugging (`.vscode/launch.json`)

Three configs (Resource / Chat / Agent) plus an "Everything" compound that launches all
three together with one click and stops them together. Use this when the user wants
breakpoints, or wants to run components independently to prove the split actually works
(e.g. restarting Chat without touching Resource).

- Resource needs `NODE_OPTIONS=--experimental-sqlite --disable-warning=ExperimentalWarning`
  — already baked into its launch config.
- Resource/Chat read the repo-root `.env` (no `CONFIG_FILE` set) — same values as
  Option A.
- Agent runs `tsx --env-file-if-exists=../../agentcore/.env.local main.ts` from
  `xaaagent/app/todos_agent` — same env file as `agentcore dev`.

**Known pitfall:** Option A and Option B's Resource/Chat configs bind the *same ports*
(8081-8083) from the *same `.env`*. Running both at once fails with `EADDRINUSE`. Stop
one before starting the other.

## Option C — containers (`docker compose`)

```bash
docker compose --env-file deploy/.env up -d --build
```

`--env-file deploy/.env` is required on every compose command (up/down/logs/ps/restart) —
compose does not auto-load it. Reads from `deploy/config/{resource,chat,agent}.env`
(copy from the `.env.example` templates first if they don't exist yet), not the
repo-root `.env`. Use this when the user wants to test the actual deployable containers,
not just the code.

If Option A/B is already running on the standard ports, either stop it first, or use a
`docker-compose.override.yml` with `ports: !override [...]` (not `!reset` — that clears
the port list entirely instead of replacing it) to remap to alternate host ports for a
side-by-side test. Delete the override file after — it's not meant to be permanent.

## Sanity checks after starting anything

- Resource: `curl http://localhost:8081/jwks.json` should return a real JWKS.
- Chat: `curl http://localhost:8083/api/obo/recent` should return `{"entries":[...]}`,
  not `{"entries":[],"stale":true}` — `stale:true` means it couldn't reach Resource's
  `/api/audit` (wrong `AUDIT_URL`, or Resource isn't up).
