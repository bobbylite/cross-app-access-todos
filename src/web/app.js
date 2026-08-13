// Live console. Subscribes to the Resource AS trace stream and renders each validation
// step as it arrives, plus the decoded tokens for the most recent successful exchange.

import { initTheme } from "./theme.js";
initTheme();

const runsEl = document.getElementById("runs");
const tokensEl = document.getElementById("tokens");
const configEl = document.getElementById("config");
const dotEl = document.getElementById("dot");
const statusEl = document.getElementById("status-text");

/** traceId -> { el, stepsEl } */
const runs = new Map();

const MARK = { pass: "PASS", fail: "FAIL", info: "····" };

function setStatus(state, text) {
  dotEl.className = `dot ${state}`;
  statusEl.textContent = text;
}

async function loadConfig() {
  try {
    const res = await fetch("/config.json");
    if (!res.ok) return;
    const c = await res.json();
    const rows = [
      ["Resource AS", c.resourceAsIssuer],
      ["MCP resource", c.mcpResource],
      ["PingFederate", c.pfIssuer],
      ["Clients", c.registeredClients.join(", ")],
      ["Grantable", c.allowedScopes.join(" ")],
    ];
    configEl.innerHTML = rows
      .map(([k, v]) => `<span>${k} <b>${escapeHtml(v)}</b></span>`)
      .join("");
  } catch {
    /* the console still works without the header */
  }
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function ensureRun(event) {
  let run = runs.get(event.traceId);
  if (run) return run;

  const empty = runsEl.querySelector(".empty");
  if (empty) empty.remove();

  const el = document.createElement("article");
  el.className = "run";
  el.innerHTML = `
    <div class="run-head">
      <span class="badge ${event.source === "mcp" ? "mcp" : ""}">${
        event.source === "mcp" ? "MCP server" : "Resource AS"
      }</span>
      <span>trace ${escapeHtml(event.traceId)}</span>
      <span class="spacer"></span>
      <span>${new Date(event.at).toLocaleTimeString()}</span>
    </div>
    <div class="steps"></div>`;

  // Newest run on top — during a demo the interesting thing just happened.
  runsEl.prepend(el);
  run = { el, stepsEl: el.querySelector(".steps") };
  runs.set(event.traceId, run);

  // Keep the DOM from growing without bound over a long session.
  while (runsEl.children.length > 25) {
    const oldest = runsEl.lastElementChild;
    for (const [id, r] of runs) if (r.el === oldest) runs.delete(id);
    oldest.remove();
  }

  return run;
}

function renderStep(event) {
  const run = ensureRun(event);
  const row = document.createElement("div");
  row.className = `step ${event.status}`;
  row.innerHTML = `
    <span class="mark">${MARK[event.status] ?? "····"}</span>
    <span class="name">${escapeHtml(event.step)}</span>
    <span class="detail">${escapeHtml(event.detail)}${
      event.error ? ` <em>(${escapeHtml(event.error)})</em>` : ""
    }</span>`;
  run.stepsEl.append(row);
  if (event.status === "fail") run.el.classList.add("failed");
}

/**
 * Colours one line of JSON. Tokenising the raw text and escaping each piece as it's
 * emitted keeps this correct — escaping the whole string first would turn every quote
 * into `&quot;` and leave the string and key patterns with nothing to match.
 */
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

function highlightLine(line) {
  let out = "";
  let last = 0;
  let match;
  JSON_TOKEN.lastIndex = 0;
  while ((match = JSON_TOKEN.exec(line)) !== null) {
    out += escapeHtml(line.slice(last, match.index));
    const [, quoted, colon, number, literal] = match;
    if (quoted !== undefined) {
      // A quoted token followed by a colon is a key; otherwise it's a value.
      out += `<span class="${colon ? "k" : "s"}">${escapeHtml(quoted)}</span>`;
      if (colon) out += escapeHtml(colon);
    } else {
      out += `<span class="n">${number ?? literal}</span>`;
    }
    last = JSON_TOKEN.lastIndex;
  }
  return out + escapeHtml(line.slice(last));
}

/**
 * Pretty-prints a decoded token, calling out `aud` and `resource`. The audience change
 * between the ID-JAG and the access token is the single most important thing on this
 * screen: the first is addressed to the authorization server, the second to the MCP
 * server, and neither is any use anywhere else.
 */
function highlightJson(value) {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => {
      const rendered = highlightLine(line);
      return /^\s*"(?:aud|resource)"\s*:/.test(line)
        ? `<span class="hl">${rendered}</span>`
        : rendered;
    })
    .join("\n");
}

function renderTokens(event) {
  const entries = Object.entries(event.tokens);
  if (entries.length === 0) return;
  tokensEl.innerHTML = `
    <div class="token-pair">
      ${entries
        .map(
          ([label, body]) => `
        <div class="token">
          <h3>${escapeHtml(label)}</h3>
          <pre>${highlightJson(body)}</pre>
        </div>`,
        )
        .join("")}
    </div>`;
}

function connect() {
  const source = new EventSource("/events");

  source.onopen = () => setStatus("live", "live");

  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (event.kind === "tokens") renderTokens(event);
    else renderStep(event);
  };

  source.onerror = () => {
    setStatus("down", "reconnecting…");
    // EventSource reconnects on its own; nothing to do but say so.
  };
}

document.getElementById("clear").addEventListener("click", () => {
  runs.clear();
  runsEl.innerHTML =
    '<p class="empty">Cleared. Redeem an ID-JAG at <code>POST /token</code> to start again.</p>';
  tokensEl.innerHTML =
    '<p class="empty">The ID-JAG and the access token issued in exchange for it will appear here side by side.</p>';
});

loadConfig();
connect();
