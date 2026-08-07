/**
 * Offline verification. Boots both listeners on throwaway ports with throwaway config
 * and exercises everything that doesn't require PingFederate:
 *
 *   - the three discovery documents, and whether they agree with each other
 *   - the rejection paths at POST /token that need no valid assertion
 *   - the entire MCP half, using an access token this Resource AS mints directly
 *
 * That last part is not a simulation of the ID-JAG exchange — it deliberately skips it.
 * The point is to prove the resource-server half works before you go anywhere near PF,
 * so a failure during the live flow can only be in the PF leg.
 *
 *   npm run check
 */

// Set before importing anything that reads config. dotenv does not override values
// already present in process.env, so a real .env can't interfere with the check.
const AS_PORT = 18081;
const MCP_PORT = 18082;
const AS_ISSUER = `http://localhost:${AS_PORT}`;
const MCP_RESOURCE = `http://localhost:${MCP_PORT}/mcp`;

Object.assign(process.env, {
  PF_ISSUER: "https://pf.check.invalid",
  // Set so boot skips discovery — nothing in this script verifies a PF signature.
  PF_JWKS_URI: "https://pf.check.invalid/pf/JWKS",
  RESOURCE_AS_ISSUER: AS_ISSUER,
  AS_PORT: String(AS_PORT),
  MCP_RESOURCE,
  MCP_PORT: String(MCP_PORT),
  CLIENT_ID: "check-client",
  CLIENT_SECRET: "check-secret",
  ALLOWED_SCOPES: "todos.read todos.write",
  // Never touch the real todos database — this run writes and deletes rows.
  TODOS_DB_PATH: ":memory:",
});

const { assertConfigValid, config } = await import("../src/config.js");
const { loadSigningKeys } = await import("../src/keys.js");
const { createResourceAsApp } = await import("../src/resource-as/server.js");
const { createMcpApp } = await import("../src/mcp/server.js");
const { initPingFederate } = await import("../src/resource-as/pf.js");
const { issueAccessToken } = await import("../src/resource-as/issueToken.js");
const { resolveSubject } = await import("../src/resource-as/subjects.js");

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the raw text for the failure message */
  }
  return { res, body: body as Record<string, unknown> };
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

function rpc(token: string | null, method: string, params?: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The streamable HTTP transport requires both media types here.
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
}

/** The transport may answer as JSON or as a one-shot SSE frame. Accept both. */
function rpcResult(body: unknown): Record<string, unknown> | null {
  if (typeof body === "object" && body !== null) {
    return (body as Record<string, unknown>).result as Record<string, unknown>;
  }
  if (typeof body === "string") {
    const line = body.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return null;
    try {
      return (JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
        .result as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  assertConfigValid();
  const keys = await loadSigningKeys();
  await initPingFederate();

  const asServer = createResourceAsApp(keys).listen(AS_PORT);
  const mcpServer = createMcpApp(keys).listen(MCP_PORT);
  await new Promise((r) => setTimeout(r, 150));

  console.log(`\nChecking ${AS_ISSUER} and ${MCP_RESOURCE}`);

  // ---- Discovery ----------------------------------------------------------------
  section("Discovery documents");

  const asMeta = await json(
    `${AS_ISSUER}/.well-known/oauth-authorization-server`,
  );
  ok("authorization server metadata is served", asMeta.res.status === 200);
  ok(
    "its `issuer` equals RESOURCE_AS_ISSUER",
    asMeta.body.issuer === AS_ISSUER,
    `got ${JSON.stringify(asMeta.body.issuer)}, expected ${AS_ISSUER}`,
  );
  ok(
    "it advertises the jwt-bearer grant",
    Array.isArray(asMeta.body.grant_types_supported) &&
      (asMeta.body.grant_types_supported as string[]).includes(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ),
  );

  const jwks = await json(`${AS_ISSUER}/jwks.json`);
  const jwksKeys = (jwks.body.keys ?? []) as Record<string, unknown>[];
  ok("JWKS is served with exactly one key", jwksKeys.length === 1);
  ok(
    "the key is an RS256 signing key with a kid",
    jwksKeys[0]?.kty === "RSA" &&
      jwksKeys[0]?.alg === "RS256" &&
      typeof jwksKeys[0]?.kid === "string",
  );
  ok(
    "the published kid matches the signing key",
    jwksKeys[0]?.kid === keys.kid,
  );

  const prm = await json(
    `http://localhost:${MCP_PORT}/.well-known/oauth-protected-resource`,
  );
  ok("protected resource metadata is served", prm.res.status === 200);
  ok(
    "its `resource` equals MCP_RESOURCE",
    prm.body.resource === MCP_RESOURCE,
    `got ${JSON.stringify(prm.body.resource)}`,
  );
  ok(
    "it points back at this authorization server",
    Array.isArray(prm.body.authorization_servers) &&
      (prm.body.authorization_servers as string[])[0] === asMeta.body.issuer,
    "the AS a client would be sent to must be the AS that issues our tokens",
  );

  // ---- Token endpoint rejections --------------------------------------------------
  section("POST /token rejections (no PingFederate needed)");

  const noAuth = await json(
    `${AS_ISSUER}/token`,
    form({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "x.y.z",
    }),
  );
  ok(
    "unauthenticated → 401 invalid_client",
    noAuth.res.status === 401 && noAuth.body.error === "invalid_client",
    `got ${noAuth.res.status} ${JSON.stringify(noAuth.body)}`,
  );

  const badSecret = await json(
    `${AS_ISSUER}/token`,
    form({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "x.y.z",
      client_id: "check-client",
      client_secret: "wrong",
    }),
  );
  ok(
    "wrong secret → 401 invalid_client",
    badSecret.res.status === 401 && badSecret.body.error === "invalid_client",
  );

  const creds = Buffer.from("check-client:check-secret").toString("base64");
  const authed = (fields: Record<string, string>): RequestInit => {
    const init = form(fields);
    (init.headers as Record<string, string>).Authorization = `Basic ${creds}`;
    return init;
  };

  const wrongGrant = await json(
    `${AS_ISSUER}/token`,
    authed({ grant_type: "authorization_code", code: "nope" }),
  );
  ok(
    "wrong grant_type → 400 unsupported_grant_type",
    wrongGrant.res.status === 400 &&
      wrongGrant.body.error === "unsupported_grant_type",
  );

  const garbage = await json(
    `${AS_ISSUER}/token`,
    authed({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "not-a-jwt",
    }),
  );
  ok(
    "unverifiable assertion → 400 invalid_grant",
    garbage.res.status === 400 && garbage.body.error === "invalid_grant",
    `got ${garbage.res.status} ${JSON.stringify(garbage.body)}`,
  );

  // ---- MCP server -----------------------------------------------------------------
  section("MCP server");

  const anonymous = await fetch(`${MCP_RESOURCE}`, rpc(null, "tools/list"));
  const challenge = anonymous.headers.get("www-authenticate") ?? "";
  ok("no bearer token → 401", anonymous.status === 401);
  ok(
    "the 401 carries a Bearer challenge with resource_metadata",
    challenge.startsWith("Bearer ") && challenge.includes("resource_metadata="),
    `got: ${challenge || "(no header)"}`,
  );
  const advertised = challenge.match(/resource_metadata="([^"]+)"/)?.[1] ?? "";
  ok(
    "the advertised metadata URL uses the RFC 9728 layout",
    advertised ===
      `http://localhost:${MCP_PORT}/.well-known/oauth-protected-resource/mcp`,
    `got ${advertised} — the well-known segment goes between host and path`,
  );
  ok(
    "the advertised metadata URL is fetchable",
    await fetch(advertised || "http://invalid")
      .then((r) => r.ok)
      .catch(() => false),
    "a client that follows the challenge must land on a real document",
  );

  const bogus = await fetch(`${MCP_RESOURCE}`, rpc("not.a.token", "tools/list"));
  ok("a malformed bearer token → 401", bogus.status === 401);

  // Provisioned through the real path, so the user is an actual row in the todos
  // database rather than a literal the foreign keys would reject.
  const { user, created } = resolveSubject(
    "pf-subject-check",
    "check@example.com",
  );
  ok(
    "an unseen subject is JIT-provisioned into the todos database",
    created && user.localId.startsWith("user_"),
    `created=${created}, localId=${user.localId}`,
  );

  const full = await issueAccessToken(
    keys,
    user,
    {
      resource: MCP_RESOURCE,
      grantedScope: ["todos.read", "todos.write"],
      requestedScope: ["todos.read", "todos.write"],
      narrowed: false,
      authorizationDetails: null,
    },
    config.clients[0]!.clientId,
  );

  const list = await json(
    `${MCP_RESOURCE}`,
    rpc(full.accessToken, "tools/list"),
  );
  const listResult = rpcResult(list.body);
  const toolNames = ((listResult?.tools ?? []) as { name: string }[]).map(
    (t) => t.name,
  );
  ok(
    "tools/list works as a single POST, with no initialize handshake",
    list.res.status === 200 && toolNames.length > 0,
    `status ${list.res.status}, tools: ${JSON.stringify(toolNames)}`,
  );
  ok(
    "every todo tool is exposed",
    [
      "list_todos",
      "get_todo_summary",
      "create_todo",
      "complete_todo",
      "update_todo",
    ].every((n) => toolNames.includes(n)),
    `got ${JSON.stringify(toolNames)}`,
  );

  /** Runs a tool and returns the parsed JSON payload the tool produced. */
  async function callTool(
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    const response = await json(
      `${MCP_RESOURCE}`,
      rpc(token, "tools/call", { name, arguments: args }),
    );
    const result = rpcResult(response.body);
    const content = (result?.content ?? []) as { text?: string }[];
    const first = content[0]?.text;
    if (!first) return null;
    try {
      return JSON.parse(first) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const seeded = await callTool(full.accessToken, "list_todos");
  const seededTodos = (seeded?.todos ?? []) as Record<string, unknown>[];
  ok(
    "a freshly provisioned user starts with real seeded work",
    seededTodos.length >= 5,
    `got ${seededTodos.length} row(s)`,
  );
  ok(
    "seeded rows carry real fields, not just a title",
    seededTodos.some(
      (t) => typeof t.priority === "string" && typeof t.createdAt === "string",
    ),
    `first row: ${JSON.stringify(seededTodos[0] ?? null).slice(0, 160)}`,
  );

  // ---- persistence and attribution ------------------------------------------------
  section("Todos data");

  const written = await callTool(full.accessToken, "create_todo", {
    title: "Written by the offline check",
    priority: "high",
    due_date: "2030-01-01",
  });
  const writtenTodo = (written?.todo ?? {}) as Record<string, unknown>;
  ok(
    "create_todo persists a row with the fields it was given",
    writtenTodo.title === "Written by the offline check" &&
      writtenTodo.priority === "high" &&
      writtenTodo.dueDate === "2030-01-01",
    JSON.stringify(writtenTodo).slice(0, 200),
  );
  ok(
    "rows written through MCP are attributed to the agent",
    writtenTodo.createdBy === "agent",
    `createdBy=${String(writtenTodo.createdBy)} — the app view badges these`,
  );

  const readBack = await callTool(full.accessToken, "list_todos");
  const readBackTodos = (readBack?.todos ?? []) as Record<string, unknown>[];
  ok(
    "a separate call reads the write back out of the database",
    readBackTodos.some((t) => t.id === writtenTodo.id),
    "the tool result is not just an echo of the request",
  );

  const completed = await callTool(full.accessToken, "complete_todo", {
    id: String(writtenTodo.id),
  });
  ok(
    "complete_todo moves the row to done",
    ((completed?.todo ?? {}) as Record<string, unknown>).status === "done",
  );

  const summary = await callTool(full.accessToken, "get_todo_summary");
  ok(
    "get_todo_summary counts the agent's contribution",
    typeof summary?.open === "number" && (summary.byAgent as number) >= 1,
    JSON.stringify(summary),
  );

  // The isolation that matters: a second identity must not see the first one's work.
  const other = resolveSubject("pf-subject-other", "other@example.com");
  const otherToken = await issueAccessToken(
    keys,
    other.user,
    {
      resource: MCP_RESOURCE,
      grantedScope: ["todos.read", "todos.write"],
      requestedScope: ["todos.read", "todos.write"],
      narrowed: false,
      authorizationDetails: null,
    },
    config.clients[0]!.clientId,
  );
  const otherList = await callTool(otherToken.accessToken, "list_todos");
  const otherTodos = (otherList?.todos ?? []) as Record<string, unknown>[];
  ok(
    "a different subject gets a different set of records",
    otherTodos.length > 0 &&
      !otherTodos.some((t) => t.id === writtenTodo.id),
    "todos are scoped by the token's subject, in the SQL",
  );

  // Ownership is enforced in the query, so naming another user's row changes nothing.
  const stolen = await json(
    `${MCP_RESOURCE}`,
    rpc(otherToken.accessToken, "tools/call", {
      name: "complete_todo",
      arguments: { id: String(writtenTodo.id) },
    }),
  );
  const stolenResult = rpcResult(stolen.body);
  ok(
    "naming another user's todo id fails rather than reaching it",
    stolenResult?.isError === true,
    `got ${JSON.stringify(stolenResult).slice(0, 160)}`,
  );

  // ---- the app's own write path ---------------------------------------------------
  section("Todos app UI");

  const appOrigin = MCP_RESOURCE.replace(/\/mcp$/, "");
  const jsonPost = (body: unknown, cookie?: string) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

  const unauth = await fetch(
    `${appOrigin}/api/todos`,
    jsonPost({ title: "written with no session" }),
  );
  ok(
    "the app's write endpoint rejects an unauthenticated POST",
    unauth.status === 401,
    `got ${unauth.status} — reads are open, writes are not`,
  );

  const forged = await fetch(
    `${appOrigin}/api/todos`,
    jsonPost({ title: "forged" }, `todos_session=${user.localId}.99999999999999.deadbeef`),
  );
  ok(
    "a cookie with a bad signature is not a session",
    forged.status === 401,
    `got ${forged.status}`,
  );

  const signIn = await fetch(
    `${appOrigin}/api/session`,
    jsonPost({ userId: user.localId }),
  );
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  ok(
    "signing in issues an HttpOnly session cookie",
    signIn.status === 200 &&
      cookie.startsWith("todos_session=") &&
      (signIn.headers.get("set-cookie") ?? "").includes("HttpOnly"),
    `got ${signIn.status}, ${signIn.headers.get("set-cookie")}`,
  );

  const humanWrite = await fetch(
    `${appOrigin}/api/todos`,
    jsonPost({ title: "Written by a person in the app", priority: "low" }, cookie),
  );
  const humanTodo = ((await humanWrite.json()) as { todo?: Record<string, unknown> })
    .todo;
  ok(
    "a session write succeeds and is attributed to the person, not the agent",
    humanWrite.status === 201 && humanTodo?.createdBy === "user",
    `status ${humanWrite.status}, createdBy=${String(humanTodo?.createdBy)}`,
  );

  // The rule that matters: ownership comes from the session, never from the payload.
  const spoofed = await fetch(
    `${appOrigin}/api/todos`,
    jsonPost(
      { title: "for somebody else", userId: other.user.localId },
      cookie,
    ),
  );
  const spoofedTodo = ((await spoofed.json()) as { todo?: Record<string, unknown> })
    .todo;
  ok(
    "a userId in the request body cannot redirect the write",
    spoofedTodo?.userId === user.localId,
    `landed on ${String(spoofedTodo?.userId)}, session belongs to ${user.localId}`,
  );

  const crossComplete = await fetch(
    `${appOrigin}/api/todos/${String(writtenTodo.id)}/complete`,
    { method: "POST", headers: { Cookie: cookie } },
  );
  ok(
    "the session can only complete its own user's rows",
    crossComplete.status === 200,
    "this row does belong to the signed-in user, so it should succeed",
  );

  const otherRow = await callTool(otherToken.accessToken, "create_todo", {
    title: "belongs to the other user",
  });
  const otherRowId = String(
    ((otherRow?.todo ?? {}) as Record<string, unknown>).id,
  );
  const reachAcross = await fetch(
    `${appOrigin}/api/todos/${otherRowId}/complete`,
    { method: "POST", headers: { Cookie: cookie } },
  );
  ok(
    "the session cannot complete another user's row",
    reachAcross.status === 404,
    `got ${reachAcross.status} for a row owned by ${other.user.localId}`,
  );

  const bothOrigins = await callTool(full.accessToken, "get_todo_summary");
  ok(
    "the same list holds work from both doors, counted separately",
    (bothOrigins?.byAgent as number) >= 1 && (bothOrigins?.byUser as number) >= 1,
    JSON.stringify(bothOrigins),
  );

  section("MCP server, continued");

  // Same user, read-only token: the write tool must be refused at the HTTP layer.
  const readOnly = await issueAccessToken(
    keys,
    user,
    {
      resource: MCP_RESOURCE,
      grantedScope: ["todos.read"],
      requestedScope: ["todos.read"],
      narrowed: false,
      authorizationDetails: null,
    },
    config.clients[0]!.clientId,
  );
  const refused = await fetch(
    `${MCP_RESOURCE}`,
    rpc(readOnly.accessToken, "tools/call", {
      name: "create_todo",
      arguments: { title: "should not happen" },
    }),
  );
  const refusedChallenge = refused.headers.get("www-authenticate") ?? "";
  ok(
    "a read-only token calling create_todo → 403 insufficient_scope",
    refused.status === 403 && refusedChallenge.includes("insufficient_scope"),
    `status ${refused.status}, challenge: ${refusedChallenge || "(none)"}`,
  );
  ok(
    "the 403 names the scope the client is missing",
    refusedChallenge.includes('scope="todos.write"'),
    `challenge: ${refusedChallenge}`,
  );

  // A token we signed ourselves, with a valid signature and an unexpired lifetime, but
  // addressed to a different resource. It must still be refused — that audience check
  // is the whole reason a captured token is useless anywhere but its intended target.
  const { SignJWT } = await import("jose");
  const foreign = await new SignJWT({
    iss: AS_ISSUER,
    sub: user.localId,
    aud: "http://localhost:9999/someone-elses-mcp",
    scope: "todos.read todos.write",
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
  })
    .setProtectedHeader({ alg: "RS256", kid: keys.kid, typ: "at+jwt" })
    .sign(keys.privateKey);

  const foreignRes = await fetch(`${MCP_RESOURCE}`, rpc(foreign, "tools/list"));
  ok(
    "a validly-signed token for a different resource → 401",
    foreignRes.status === 401,
    `status ${foreignRes.status} — audience binding is what makes a stolen token useless elsewhere`,
  );

  asServer.close();
  mcpServer.close();

  console.log(
    `\n${failures === 0 ? "All" : `${checks - failures}/${checks}`} checks passed${
      failures === 0 ? ` (${checks})` : `, ${failures} failed`
    }\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
