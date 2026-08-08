# Cross App Access — a real Resource AS and MCP server

A working implementation of the receiving half of
[Cross App Access](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant):
a **Resource Authorization Server** that accepts an Identity Assertion JWT Authorization
Grant (ID-JAG) from PingFederate and exchanges it for its own access token, a **todos MCP
server** that only accepts the tokens that Resource AS issues, and the **todos application
itself** — a real database with a UI, so the agent's writes land somewhere you can see.

Nothing here is simulated. Signatures are verified against PingFederate's live JWKS, the
tokens are real RS256 JWTs, the records are real rows, and every rejection is a real
rejection.

> Two sibling repos tell this story as an animation —
> `cross-app-access-tour` and `identity-chaining-demo` both generate inert JWTs in the
> browser and make no network calls. This one is the implementation.

## Why build the Resource AS rather than point at a product

Because you can step through it. Every rule in §4.4.1 of the draft is a separate,
individually logged check, in spec order, in one file you can put on a screen — "here's
where we check `typ`", "here's where we bind `client_id` to stop a replay", "here's the
authorization decision we make independently of whatever PingFederate granted".

## Quick start

Requires **Node 22.5+**. The todos database uses the built-in `node:sqlite`, which is
still behind `--experimental-sqlite` on Node 22 — the npm scripts pass that flag for you,
so there is no native module to compile and nothing to install for it.

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env` (see [Configuration](#configuration)), then:

```bash
npm run dev
```

That starts two listeners in one process:

| | |
| --- | --- |
| Resource AS | `http://localhost:8081` — `POST /token`, metadata, JWKS |
| Live console | `http://localhost:8081/console` — the validation trace |
| Todos MCP server | `http://localhost:8082/mcp` |
| Todos app | `http://localhost:8082/app` — the records themselves |

Then import both files in `postman/` and run the folders top to bottom.

For a walkthrough, put the console and the todos app side by side: the left shows the ten
checks passing, the right shows the row appearing.

## The flow

```
Postman ──1── PingFederate            get an ID token
        ──2── PingFederate            token exchange → ID-JAG   (aud: the Resource AS)
        ──3── Resource AS  /token     ID-JAG → access token     (aud: the MCP server)
        ──4── MCP server   /mcp       tools/call with the access token
```

Steps 3 and 4 are what this repo implements.

## What `POST /token` actually does

`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<the ID-JAG>`, plus
client authentication. Each step logs one line to stdout and to the console.

| # | Check | Where |
| --- | --- | --- |
| 1 | Client authentication against the registry | [clients.ts](src/resource-as/clients.ts) |
| 2 | RS256 signature against PingFederate's JWKS, and the `iss` it claims | [validateIdJag.ts](src/resource-as/validateIdJag.ts) |
| 3 | `typ` header is exactly `oauth-id-jag+jwt` | [validateIdJag.ts](src/resource-as/validateIdJag.ts) |
| 4 | `aud` matches our issuer identifier, exact string | [validateIdJag.ts](src/resource-as/validateIdJag.ts) |
| 5 | `client_id` claim matches the authenticated client | [validateIdJag.ts](src/resource-as/validateIdJag.ts) |
| 6 | `exp` / `nbf` / `iat` freshness | [validateIdJag.ts](src/resource-as/validateIdJag.ts) |
| 6b | `jti` has not been redeemed before | [replay.ts](src/resource-as/replay.ts) |
| 7 | Resolve `sub` to a local user, JIT-provisioning if new | [subjects.ts](src/resource-as/subjects.ts) |
| 8 | Local policy on `resource` / `scope` / `authorization_details` | [policy.ts](src/resource-as/policy.ts) |
| 9 | Mint our own access token | [issueToken.ts](src/resource-as/issueToken.ts) |
| 10 | Respond per §4.4.2 | [tokenEndpoint.ts](src/resource-as/tokenEndpoint.ts) |

Three of these are worth pausing on during a walkthrough.

**Step 3** is the one people skip. PingFederate signs ID tokens, access tokens and logout
tokens with the same key. `typ` is the only thing that says *this* JWT is meant to be
redeemed at a token endpoint. Accepting an ID token here would be a serious confusion
bug, and RFC 8725 exists because that bug is common.

**Step 6b** is an addition to the draft's explicit list, not a departure from it — `jti`
is a required claim, and remembering it until `exp` makes redemption single-use. Capture
an ID-JAG in flight and it is worth nothing once the legitimate client has spent it.

**Step 8** is the point of the whole exercise. PingFederate said who the user is and
which client is asking. It did not decide what this server hands out. Granted scope is
the *intersection* of what was requested and what policy allows — ask for `todos.admin`
and it simply doesn't come back, and the `scope` in the response visibly differs from the
`scope` in the assertion.

## The two audiences

The single most likely source of a confusing failure. These are different values:

| Value | Set by | Lands in |
| --- | --- | --- |
| `RESOURCE_AS_ISSUER`, e.g. `http://localhost:8081` | PingFederate's `audience` on the token exchange | `aud` of the **ID-JAG** |
| `MCP_RESOURCE`, e.g. `http://localhost:8082/mcp` | this server's policy | `aud` of the **access token** |

Step 4 compares `aud` as an exact string. A trailing slash, or `http` where PingFederate
has `https`, fails there — and the failure looks like a signature problem if you aren't
watching the console. The authoritative value is served at
`http://localhost:8081/.well-known/oauth-authorization-server`; compare it against
PingFederate's registered audience character for character.

The audience changing between the two tokens is what makes "this token works nowhere
else" demonstrable rather than merely asserted. The MCP server rejects any token whose
`aud` isn't itself, even one this Resource AS signed.

## PingFederate prerequisites

PingFederate 13.1+ supports `requested_token_type=urn:ietf:params:oauth:token-type:id-jag`.

- A client permitted to use token exchange with that requested token type.
- Its `audience` for this exchange registered as **exactly** `RESOURCE_AS_ISSUER`.
- The same `client_id` registered here as `CLIENT_ID`, with a secret — otherwise step 5
  rejects the redemption by design.

**PingFederate does not put a `kid` on the ID-JAGs it issues** — it identifies the key
with `x5t`, the SHA-1 thumbprint of the signing certificate. Both are legal JOSE key
hints, but only `kid` is what an ordinary JWKS lookup keys on, so the usual path has
nothing to resolve.

Step 2 handles this by matching `x5t` against the thumbprint PingFederate publishes on
each JWKS entry. That's a real lookup against published metadata, not a guess, and the
console says which hint resolved the key. `x5t#S256` is matched the same way, and both are
derived from `x5c` when a JWKS publishes the certificate but not the thumbprint. Only when
a header carries no usable hint at all does it fall back to trying every published key.

**Make sure the ID-JAG signing certificate is published in the JWKS.** In PingFederate the
key that signs an issued token is chosen by the token generator handling the exchange, and
it is not automatically the OIDC provider key at `/pf/JWKS`. If it isn't published, step 2
cannot verify anything and no amount of configuration here will help — see
[When step 2 fails](#when-step-2-fails).

**One thing that surprises people:** RFC 8693 returns the ID-JAG in the `access_token`
field of the token-exchange response, not in a field named after its type. Check
`issued_token_type` to confirm you actually got an ID-JAG. The Postman collection asserts
this for you.

## Configuration

Everything lives in `.env`; see [.env.example](.env.example) for the annotated list.
`config.ts` validates at boot and names anything missing rather than failing later.

| Variable | Notes |
| --- | --- |
| `PF_ISSUER` | PingFederate issuer, no trailing slash |
| `PF_JWKS_URI` | Optional — otherwise read from PF's discovery document at boot |
| `RESOURCE_AS_ISSUER` | Our issuer identifier. **This is the `aud` PingFederate must use.** |
| `MCP_RESOURCE` | Canonical URI of the MCP server, including the `/mcp` path |
| `CLIENT_ID` / `CLIENT_SECRET` | The client allowed to redeem ID-JAGs here |
| `ALLOWED_SCOPES` | What policy is willing to grant |
| `TODOS_DB_PATH` | Optional — defaults to `./data/todos.db`; `:memory:` for a throwaway |

The RS256 key pair for our own access tokens is generated on first run into `keys/`
(gitignored) and reused after that, so a restart mid-walkthrough doesn't invalidate a
token already sitting in a Postman environment.

## The MCP server

Standard OAuth 2.1 resource server behaviour, per the
[MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization):

- Token validation is **local** — same key, no network call to the authorization server.
- Signature, `iss`, `aud`, and `exp` are all checked; `aud` must be this server.
- No token → `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
- Missing scope → `403 insufficient_scope`, naming the scope, at the HTTP layer rather
  than as a tool result that happens to say no.
- `/.well-known/oauth-protected-resource/mcp` (RFC 9728) advertises this Resource AS.
  Note the shape: the well-known segment goes *between* host and path.

Five tools — `list_todos`, `get_todo_summary`, `create_todo`, `complete_todo`,
`update_todo` — each gated on scope and scoped to the caller's subject. The user is not a
parameter on any of them; it comes from the token and is applied in the SQL, so a caller
cannot reach someone else's records even by guessing an id.

### It runs stateless, on purpose

`sessionIdGenerator: undefined` means no `initialize` handshake and no `Mcp-Session-Id`
to echo back, so every call is one self-contained POST with a bearer token. That is what
makes the flow drivable from Postman. Requests need
`Accept: application/json, text/event-stream` — the transport requires both media types.

## Postman

`postman/cross-app-access.postman_collection.json` and the matching environment.

Folders 1–3 are the happy path and run top to bottom in one click; each request captures
what the next one needs. Folder 4 is the rejections, and each one stops the pipeline at a
different step:

| Request | Stops at | Because |
| --- | --- | --- |
| 4a tampered payload | step 2 | the signature no longer covers the payload |
| 4b wrong client | step 1 | that client isn't registered here |
| 4c replay | step 6b | the `jti` was already spent |
| 4d/4e wrong audience | step 4, or at PF | the assertion was addressed elsewhere |
| 4f under-scoped token | MCP, 403 | `todos.write` was never granted |
| 4g no token | MCP, 401 | and the 401 says where to get one |

Run them with the console open — the failing step is the one in red.

## Verification

```bash
npm run check
```

Typechecks, then boots both listeners on throwaway ports against an in-memory database and
runs 41 assertions with no network access and no PingFederate:

- the three discovery documents, and whether they agree with each other
- every `POST /token` rejection that doesn't need a valid assertion
- the MCP half, using a token the Resource AS mints directly
- persistence, verified by reading a write back out rather than trusting the echo
- both write paths, and that each is attributed to the right one
- the isolation that matters — a second subject sees different records, naming another
  user's id returns not-found, an unauthenticated or forged-cookie write is refused, and
  a `userId` in a request body cannot redirect where a write lands

It deliberately skips the ID-JAG exchange. The point is to prove everything downstream
works before you go near PingFederate, so anything that fails during the live flow can
only be in the PF leg.

### When step 2 fails

```bash
npx tsx scripts/probe-jwks.ts "<the assertion>"
```

Fetches the JWKS and tries the assertion against **every** key it publishes, one at a
time, printing which ones were tried and whether any verified. It also reports the
segment sizes, since a truncated paste looks identical to a bad signature.

The answer it gives you is which of two problems you have: the signing key is published
and something else is wrong, or the key simply isn't at that endpoint. In PingFederate
the key that signs an issued token is chosen by the token generator handling the
exchange, and that isn't necessarily the OIDC provider key served at `/pf/JWKS`.

If the signer isn't published, that is the fix — publish it. There is deliberately no
option here to trust a certificate out of band: it would mean the demo says "we fetch the
IdP's keys" while quietly reading a file, and it wouldn't survive a key rotation.

To test one exported certificate instead of a whole JWKS:

```bash
npx tsx scripts/probe-jwks.ts "<the assertion>" --cert ./oauth-cert.pem
```

That settles the question the PingFederate console raises but can't answer — whether the
certificate a connection is configured with is the one that actually signed the token.

## The chatbot

The agent lives in `xaaagent/` — a **Bedrock AgentCore** runtime, TypeScript, Claude Opus
5 via Bedrock. It holds no credential for the todos app. On each turn it takes the
caller's own token and runs the chain itself:

```
caller's id_token ──exchange at PingFederate──▶ ID-JAG ──redeem here──▶ access token
                                                                            │
                                          MCP tools, scoped to one user ────┘
```

Two processes:

```bash
npm run dev
```

```bash
cd xaaagent && /opt/homebrew/bin/agentcore dev --skip-deploy --logs
```

Then open **http://localhost:8083** and just start talking — there is no sign-in screen.

**Authorization arrives when it's needed, not before.** Ask *"how does access work?"* and
it answers, unauthenticated, with no tools. Ask *"what's on my list?"* and the agent calls
its one anonymous tool, `request_sign_in`, which raises a sign-in card naming what it
needs access **for**. You sign in to PingFederate once, in a popup, and the turn that
triggered it replays automatically — you never retype it, and you are never asked to log
in to the todos app at all.

After that the chain is drawn in the transcript as it happens, and each tool call appears
as its own line, so *"what's on my list?"* shows the exchange, the redemption, and
`list_todos` before the answer arrives.

### The trace pane

The right half of the chat screen is a live OpenTelemetry waterfall. Real SDKs, real W3C
context propagation, real OTLP over HTTP — the only unusual part is where the spans go.

**The chat app is its own collector.** Every process exports to `POST /v1/traces` on port
8083, which assembles traces and streams them to the browser. That's deliberate: the
argument being made is that the trace *is* the explanation, and sending an audience to a
second tool loses the moment. Repointing `OTEL_EXPORTER_OTLP_ENDPOINT` at Jaeger or
CloudWatch is a one-variable change and nothing else moves.

**Colour encodes trust domain, not service** — caller, identity provider, resource. That's
the only thing on screen using those three hues, because the boundary crossing is the
whole point. The JWKS fetch shows as *identity* orange even though the Resource AS made
the call, which is the correct reading: that request left the resource domain.

The pane is built for an identity audience, so it answers identity questions first:

**Identity continuity ribbon** (top). The same person across every hop, with the token
shape at each — PingFederate's subject, the Resource AS's local subject, and who the
todos app thinks it is acting for. The audience changes at every hop; the subject does
not, and the ribbon says so explicitly rather than leaving it to be inferred.

**The target system's audit log** (bottom). Not the agent's telemetry — the todos app's
own record, written by [audit.ts](src/todos/audit.ts) on every tool call:

```
OBO  postman-oidc on behalf of user_84cab92a
     create_todo · created "Publish the ID-JAG signing cert" · idp pf-ryland
```

Three parties, deliberately not interchangeable: the **actor** that held the token, the
**subject** whose data it is, and the **idp** identifier linking that person upstream. A
service-account integration records one identity for every row and loses the person
entirely — that difference is the argument, so the target system writes it down. Writes
made by a human in the app UI are recorded as `self` authority alongside, which is what
makes the `OBO` badge legible.

Three more things the pane gives you that prose can't:

- **The ten checks are spans**, nested under `POST /token`, each with `xaa.step`,
  `xaa.status` and `xaa.detail` attributes. One line in [trace.ts](src/trace.ts) does
  this — the console and the trace are two consumers of one narration.
- **Key discovery has a number.** The first JWKS fetch costs ~90ms and the second ~26ms.
  You can point at that instead of describing it.
- **Failures name themselves.** A rejected step turns red and is restated underneath with
  the values that were compared.

There is no OTel semantic convention for authorization decisions, so `xaa.*` is ours.
That's a feature: *"show me every redemption where granted scope was narrower than
requested"* becomes a query rather than a story.

### Configuring sign-in

The chat client needs **its own** PingFederate OAuth client — separate from the one that
redeems ID-JAGs. That one acts on the user's behalf; this one signs the human in, and
keeping them apart is exactly the point being made.

In PingFederate, create an OAuth client with:

| | |
| --- | --- |
| Grant type | Authorization Code |
| Redirect URI | `http://localhost:8083/auth/callback` — must match exactly |
| PKCE | required, `S256` |
| Scopes | `openid`, `profile` |
| OIDC policy | attached, or no `id_token` is issued |

Then fill in `OIDC_CLIENT_ID` in `.env`. Leave `OIDC_CLIENT_SECRET` empty for a public
client — PKCE alone is enough, and PingFederate advertises `none` as a token endpoint auth
method. Until it's set, the chat still runs and the agent still asks; the sign-in button
just says so and tells you which variable is missing.

The `id_token` lives in a server-side session keyed by an `HttpOnly` cookie. The browser
never holds it — it knows only that it is signed in and as whom.

**Four things that bite:**

- **`--skip-deploy` is not optional.** Without it, `agentcore dev` provisions AWS
  resources before starting.
- **Use the full path to `agentcore`** if the deprecated starter toolkit is still
  installed — a bare `agentcore` resolves to it and won't understand the project.
  `pip uninstall bedrock-agentcore-starter-toolkit` fixes it permanently.
- **The agent picks a free port.** It wants 8080; if something already holds it, it
  quietly takes 8084 and the chat client — pointed at `AGENT_URL`, default 8080 — talks
  to the wrong thing. Check the `Server:` line it prints.
- **The token must be fresh.** PingFederate ID tokens expire in minutes; the chat client
  checks `exp` before it lets you start and tells you to re-run `1a`.

The agent reads the caller's token from `context.headers` — the runtime filters incoming
headers down to `Authorization` and `Custom-*`. Locally the chat client's proxy sets that
header; deployed, the runtime's request-header allowlist does. The agent code cannot tell
the two apart, which is what makes local iteration worth anything.

## The todos application

The MCP server isn't the application — it's one door into it. Behind both doors is a
SQLite database (`data/todos.db`, created on first run) with real users and real records:
titles, notes, priority, due dates, status, and who created each row.

Open **http://localhost:8082/app** to use it. Pick a person, sign in, and you can add and
complete items yourself. It updates live over SSE — so during a walkthrough you can call
`create_todo` from Postman and have it appear on screen mid-sentence.

**Every row records which door it came through**, and the UI badges them: `in app` for a
human writing over a session, `via agent` for a write that arrived through MCP carrying an
access token the Resource AS minted from an ID-JAG. Same person, same list, two paths —
which is the entire argument, visible in one screen.

Reads are open; **writes require a session**. There's no unauthenticated write endpoint
sitting next to the one the whole demo secures. Ownership comes from the session cookie,
never from the request body — the same rule the MCP tools follow with the token's subject.

The sign-in itself is a picker, not a credential check, and the UI says so. The real
version is an OIDC authorization-code flow against the same PingFederate that issues the
ID-JAGs; at that point the demo lands completely, because the human signs in once and the
agent never signs in at all.

Users arrive by just-in-time provisioning: a `sub` the app has never seen becomes a real
row at step 7, with a starting backlog so the first `list_todos` returns something
readable. `npm run db:reset` clears everything.

Ownership is enforced in the SQL, not in the tool handlers — no tool takes a user
parameter, and naming another person's todo id returns not-found rather than their data.

## Layout

```
src/
  config.ts              env loading, validated at boot
  trace.ts               the narration bus — stdout and SSE
  keys.ts                RS256 key pair for our access tokens
  resource-as/           the authorization server — the ten checks
  mcp/                   the resource server — bearer auth and the tools
  todos/                 the application — schema, store, session, its own UI
  web/                   the live console
postman/                 collection + environment
scripts/
  check.ts               offline verification
  probe-jwks.ts          which key signed this assertion, if any
data/                    the todos database (gitignored, created on first run)
keys/                    our signing key pair (gitignored, created on first run)
```

## Out of scope

No chatbot client, no AgentCore wiring, no refresh tokens, no DPoP.

The app's sign-in is a picker rather than a credential check — enough to give the UI a
real session boundary, not enough to call it authentication. Replacing it with an OIDC
authorization-code flow against the same PingFederate is the obvious next step, and the
one that would complete the argument: the human signs in once, and the agent never signs
in at all.

The RFC 9728 metadata is the seam a chatbot client attaches to later.
