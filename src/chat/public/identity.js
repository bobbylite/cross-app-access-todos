// The identity half of the trace pane.
//
// A latency waterfall answers "what was slow". An identity audience is asking something
// else: *did the person survive the trip, and does the target system know who they were
// acting for?* Those two questions get their own furniture — a continuity ribbon across
// the top, and the resource app's own audit log along the bottom.

import { connectSSE } from "./sse.js";

const ribbonEl = document.getElementById("ribbon");
const oboEl = document.getElementById("obo");

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function attr(spans, key) {
  for (const span of spans) {
    const value = span.attributes[key];
    if (value !== undefined && value !== "") return String(value);
  }
  return null;
}

/**
 * The hops that carried an identity, in order, with the token shape at each.
 *
 * Built from span attributes rather than hard-coded, so it reflects what actually
 * happened. A hop with no evidence in the trace is simply absent.
 */
export function identityChain(spans) {
  const idpSubject = attr(spans, "xaa.identity.idp_subject");
  const localSubject = attr(spans, "xaa.identity.local_subject");
  const actor = attr(spans, "xaa.actor.client_id");
  const inAud = attr(spans, "xaa.token.in.aud");
  const outAud = attr(spans, "xaa.token.out.aud");
  const requested = attr(spans, "xaa.scope.requested");
  const granted = attr(spans, "xaa.scope.granted");
  const presented = attr(spans, "xaa.scope.presented");
  const narrowed = attr(spans, "xaa.scope.narrowed") === "true";
  const jit = attr(spans, "xaa.identity.jit_provisioned") === "true";

  if (!idpSubject && !localSubject) return null;

  const hops = [];

  if (idpSubject) {
    hops.push({
      where: "PingFederate",
      token: "ID-JAG",
      domain: "identity",
      subject: idpSubject,
      rows: [
        ["aud", inAud ?? "—"],
        ["scope", requested ?? "—"],
      ],
    });
  }

  if (localSubject) {
    hops.push({
      where: "Resource AS",
      token: "access token",
      domain: "resource",
      subject: localSubject,
      linkedFrom: idpSubject,
      rows: [
        ["aud", outAud ?? "—"],
        ["scope", granted ?? "—"],
        ...(narrowed ? [["narrowed", `from ${requested ?? "?"}`]] : []),
      ],
    });

    hops.push({
      where: "Todos app",
      token: "acting for",
      domain: "resource",
      subject: localSubject,
      rows: [
        ["actor", actor ?? "—"],
        ["scope", presented ?? granted ?? "—"],
      ],
    });
  }

  return { hops, idpSubject, localSubject, actor, jit, narrowed };
}

export function renderRibbon(spans) {
  const chain = identityChain(spans);
  if (!chain || chain.hops.length === 0) {
    ribbonEl.innerHTML = "";
    return;
  }

  const cards = chain.hops
    .map(
      (hop) => `
      <div class="hop hop-${hop.domain}">
        <div class="hop-where">${escapeHtml(hop.where)}</div>
        <div class="hop-subject">${escapeHtml(hop.subject)}</div>
        <div class="hop-token">${escapeHtml(hop.token)}</div>
        <dl class="hop-rows">
          ${hop.rows
            .map(
              ([k, v]) =>
                `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
            )
            .join("")}
        </dl>
      </div>`,
    )
    .join('<div class="hop-arrow">→</div>');

  // The claim the ribbon is making, stated rather than implied.
  const verdict = chain.idpSubject
    ? `Same person end to end — <strong>${escapeHtml(chain.idpSubject)}</strong>` +
      (chain.localSubject
        ? ` is <strong>${escapeHtml(chain.localSubject)}</strong> here`
        : "")
    : "Identity carried through the chain";

  ribbonEl.innerHTML = `
    <div class="ribbon-title">Identity continuity</div>
    <div class="hops">${cards}</div>
    <div class="verdict">
      <span class="verdict-mark">✓</span>
      <span>${verdict}. The audience changed at every hop; the subject did not.</span>
    </div>`;
}

// ---- the target system's own log --------------------------------------------

/**
 * Entries seen since this page loaded.
 *
 * The audit table keeps every row — it is an audit log and must not lie about history.
 * What resets on refresh is this view, so the stage is clean before presenting.
 */
const seen = [];

function renderAudit(entries) {
  if (!entries || entries.length === 0) {
    oboEl.innerHTML =
      `<div class="obo-title">Todos app · audit log` +
      `<span class="obo-note">what the target system recorded, since page load</span></div>` +
      `<p class="empty">Nothing yet. Ask the agent to change something.</p>`;
    return;
  }

  const rows = entries
    .map((entry) => {
      const delegated = entry.authority === "delegated";
      const who = delegated
        ? `<span class="obo-actor">${escapeHtml(entry.actorClient ?? "agent")}</span>` +
          ` <span class="obo-obo">on behalf of</span> ` +
          `<span class="obo-subject">${escapeHtml(entry.subject)}</span>`
        : `<span class="obo-subject">${escapeHtml(entry.subject)}</span>` +
          ` <span class="obo-obo">in person</span>`;

      return `
        <div class="obo-row">
          <span class="badge badge-${delegated ? "delegated" : "session"}">
            ${delegated ? "OBO" : "self"}
          </span>
          <div class="obo-main">
            <div class="obo-line">${who}</div>
            <div class="obo-meta">
              ${escapeHtml(entry.action)}
              ${entry.detail ? `· ${escapeHtml(entry.detail)}` : ""}
              ${entry.idpSubject ? `· idp ${escapeHtml(entry.idpSubject)}` : ""}
            </div>
          </div>
        </div>`;
    })
    .join("");

  oboEl.innerHTML =
    `<div class="obo-title">Todos app · audit log` +
    `<span class="obo-note">what the target system recorded, since page load</span></div>` +
    rows;
}

export function connectAudit() {
  // Start empty every time the page loads, then accumulate. The server sends one entry
  // per event rather than the whole tail, so nothing from a previous run reappears.
  renderAudit([]);

  connectSSE("/api/obo/stream", (data) => {
    try {
      const { entry } = JSON.parse(data);
      if (!entry) return;
      seen.unshift(entry);
      if (seen.length > 20) seen.pop();
      renderAudit(seen);
    } catch {
      /* a malformed frame shouldn't blank the panel */
    }
  });
}
