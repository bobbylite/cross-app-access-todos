// The trace pane: turns collected OTLP spans into a waterfall that reads as a story.
//
// The organising idea is trust domain, not service. An audience does not care that
// `todos-platform` emitted a span — they care that the request left the caller's domain
// and was let into the resource's. So colour encodes domain, and the crossings are
// called out explicitly beneath the chart.

import { connectAudit, renderRibbon } from "./identity.js";

const waterfallEl = document.getElementById("waterfall");
const traceSubEl = document.getElementById("trace-sub");
const traceTotalEl = document.getElementById("trace-total");
const highlightsEl = document.getElementById("highlights");

/** Spans that add depth without adding meaning for an audience. */
const NOISE = [/^GET \/api\//, /^GET \/$/, /^middleware/, /^request handler/];

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function ms(value) {
  if (value >= 100) return `${Math.round(value)}ms`;
  if (value >= 10) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(2)}ms`;
}

/**
 * A readable label.
 *
 * Raw span names are HTTP verbs and paths; what the room needs is the participant and
 * the act — "PingFederate · token exchange", not "POST /as/token.oauth2".
 */
function label(span) {
  const url = String(span.attributes["url.full"] ?? "");
  const step = span.attributes["xaa.step"];
  if (typeof step === "string") return step;

  if (url.includes("/as/token.oauth2")) return "PingFederate · token exchange";
  if (url.includes("/pf/JWKS")) return "PingFederate · fetch signing keys";
  if (url.includes("/as/authorization")) return "PingFederate · sign in";
  if (url.match(/:8081\/token/)) return "Resource AS · redeem ID-JAG";
  if (url.match(/:8082\/mcp/)) return "Todos MCP · tool call";
  if (url.includes("/invocations")) return "Agent · turn";
  if (url.includes("bedrock")) return "Bedrock · Claude Opus 5";

  // HTTP server spans are often named by method alone; the route is an attribute.
  const route = String(
    span.attributes["http.route"] ?? span.attributes["url.path"] ?? "",
  );
  if (route.startsWith("/token")) return "Resource AS · redeem ID-JAG";
  if (route.startsWith("/mcp")) return "Todos MCP · tool call";
  if (route.startsWith("/invocations")) return "Agent · turn";
  if (route.startsWith("/api/chat")) return "Chat · turn";
  if (route.startsWith("/auth/callback")) return "Chat · sign-in callback";
  return route ? `${span.name} ${route}` : span.name;
}

function isNoise(span) {
  return NOISE.some((pattern) => pattern.test(span.name));
}

/** Builds the parent/child tree, re-rooting orphans so nothing is silently dropped. */
function buildTree(spans) {
  const byId = new Map(spans.map((s) => [s.spanId, { ...s, children: [] }]));
  const roots = [];

  for (const node of byId.values()) {
    const parent = node.parentSpanId ? byId.get(node.parentSpanId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRec = (nodes) => {
    nodes.sort((a, b) => a.startMs - b.startMs);
    for (const node of nodes) sortRec(node.children);
  };
  sortRec(roots);
  return roots;
}

function renderRow(node, depth, traceStart, traceSpan) {
  const offset = ((node.startMs - traceStart) / traceSpan) * 100;
  const width = Math.max((node.durationMs / traceSpan) * 100, 0.6);
  const isStep = typeof node.attributes["xaa.step"] === "string";
  const failed =
    node.status === "error" || node.attributes["xaa.status"] === "fail";

  const detail = node.attributes["xaa.detail"];
  const title = [
    label(node),
    detail ? `\n${detail}` : "",
    `\n${ms(node.durationMs)} · ${node.service}`,
  ].join("");

  return `
    <div class="row ${isStep ? "row-step" : ""} ${failed ? "row-fail" : ""}"
         style="--depth:${depth}" title="${escapeHtml(title)}">
      <div class="row-label">
        <span class="dot dot-${node.domain}"></span>
        <span class="row-name">${escapeHtml(label(node))}</span>
      </div>
      <div class="row-track">
        <div class="bar bar-${node.domain} ${failed ? "bar-fail" : ""}"
             style="left:${offset}%;width:${width}%"></div>
      </div>
      <div class="row-ms">${node.durationMs >= 0.5 ? ms(node.durationMs) : ""}</div>
    </div>`;
}

function flatten(nodes, depth, out) {
  for (const node of nodes) {
    if (!isNoise(node)) {
      out.push({ node, depth });
      flatten(node.children, depth + 1, out);
    } else {
      // Keep the children, drop the uninteresting frame around them.
      flatten(node.children, depth, out);
    }
  }
  return out;
}

/**
 * The two or three sentences the trace is actually making.
 *
 * Pulled from span attributes rather than hard-coded, so if the policy changes the
 * narration changes with it.
 */
function highlights(spans) {
  const notes = [];

  const policy = spans.find((s) => String(s.attributes["xaa.step"] ?? "").startsWith("8."));
  if (policy) {
    const detail = String(policy.attributes["xaa.detail"] ?? "");
    notes.push({
      kind: "decision",
      title: "The resource domain decided for itself",
      body: detail || "Local policy applied to the requested scope.",
    });
  }

  const jwks = spans.find((s) => String(s.attributes["url.full"] ?? "").includes("/pf/JWKS"));
  if (jwks) {
    notes.push({
      kind: "timing",
      title: `Key discovery cost ${ms(jwks.durationMs)}`,
      body:
        "The signature check fetched PingFederate's published keys. Cached after this, " +
        "which is why the next turn is faster.",
    });
  }

  const failed = spans.find(
    (s) => s.attributes["xaa.status"] === "fail" || s.status === "error",
  );
  if (failed) {
    notes.unshift({
      kind: "fail",
      title: `Rejected at ${String(failed.attributes["xaa.step"] ?? failed.name)}`,
      body: String(
        failed.attributes["xaa.detail"] ??
          "The resource domain refused the request.",
      ),
    });
  }

  const crossings = spans.filter(
    (s) => s.domain === "resource" && String(s.name).startsWith("POST /token"),
  );
  if (crossings.length > 0) {
    notes.push({
      kind: "boundary",
      title: "One boundary crossing, one grant",
      body:
        "The caller presented an assertion; the resource domain issued its own token. " +
        "Nobody shared a password, and nobody logged in twice.",
    });
  }

  return notes;
}

/**
 * How much a trace is worth showing.
 *
 * Traces arrive continuously and the pane holds one, so a stray single-span request
 * must not displace the chain someone is mid-sentence about. Weight favours the
 * authorization steps and the number of domains involved — which is exactly what makes
 * a trace worth looking at here.
 */
function weight(spans) {
  const steps = spans.filter((s) => s.attributes["xaa.step"]).length;
  const domains = new Set(spans.map((s) => s.domain)).size;
  return spans.length + steps * 3 + domains * 5;
}

let shownWeight = 0;
let shownTraceId = null;

export function renderTrace(trace) {
  const spans = trace.spans.filter((s) => !isNoise(s));
  if (spans.length < 2) return;

  // Updates to the trace already on screen always render; a different trace has to
  // earn the space.
  const w = weight(spans);
  if (trace.traceId !== shownTraceId && w <= shownWeight) return;
  shownTraceId = trace.traceId;
  shownWeight = w;

  const roots = buildTree(trace.spans);
  const rows = flatten(roots, 0, []);
  if (rows.length === 0) return;

  const traceStart = Math.min(...spans.map((s) => s.startMs));
  const traceEnd = Math.max(...spans.map((s) => s.startMs + s.durationMs));
  const traceSpan = Math.max(traceEnd - traceStart, 1);

  renderRibbon(spans);

  waterfallEl.innerHTML = rows
    .map(({ node, depth }) => renderRow(node, depth, traceStart, traceSpan))
    .join("");

  const serviceCount = new Set(spans.map((s) => s.service)).size;
  traceSubEl.textContent =
    `${spans.length} span${spans.length === 1 ? "" : "s"} across ` +
    `${serviceCount} service${serviceCount === 1 ? "" : "s"} · ` +
    `trace ${trace.traceId.slice(0, 12)}`;
  traceTotalEl.textContent = ms(traceSpan);

  highlightsEl.innerHTML = highlights(spans)
    .map(
      (note) => `
      <div class="note note-${note.kind}">
        <div class="note-title">${escapeHtml(note.title)}</div>
        <div class="note-body">${escapeHtml(note.body)}</div>
      </div>`,
    )
    .join("");
}

/** Subscribes to the collector's live stream. */
export function connectTraces() {
  connectAudit();
  const source = new EventSource("/api/traces/stream");
  source.onmessage = (event) => {
    try {
      renderTrace(JSON.parse(event.data));
    } catch {
      /* a malformed frame is not worth breaking the pane over */
    }
  };
}
