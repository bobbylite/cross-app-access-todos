import { connectTraces } from "./trace.js";

// Chat client. Streams SSE from the local proxy, which forwards to the AgentCore
// runtime. Trace frames are drawn as the auth chain rather than printed as text.
//
// Sign-in is never asked for up front. The agent raises an auth-required trace the
// moment a turn needs the user's todos; this file turns that into a PingFederate login
// and then replays the turn that triggered it.

const threadEl = document.getElementById("thread");
const composerEl = document.getElementById("composer");
const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const whoEl = document.getElementById("who");

// Must match TRACE_PREFIX in the agent's main.ts — a NUL sentinel, written as an
// escape so it is visible in source rather than an invisible byte.
const TRACE_PREFIX = "\u0000TRACE";
const sessionId = `chat-${crypto.randomUUID().slice(0, 8)}`;

let signedIn = false;
let loginAvailable = false;

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function scrollDown() {
  threadEl.scrollTop = threadEl.scrollHeight;
}

function addMessage(role, text = "") {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  threadEl.appendChild(el);
  scrollDown();
  return el;
}

function addToolCall(name, args) {
  const el = document.createElement("div");
  el.className = "tool";
  const rendered = args && Object.keys(args).length > 0 ? JSON.stringify(args) : "{}";
  el.textContent = `→ ${name}(${rendered})`;
  threadEl.appendChild(el);
  scrollDown();
}

/** One box per turn, appended to as chain steps arrive. */
function chainBox() {
  let el = null;
  return (step) => {
    if (!el) {
      el = document.createElement("div");
      el.className = "chain";
      el.innerHTML = `<div class="chain-title">Getting access</div>`;
      threadEl.appendChild(el);
    }
    const row = document.createElement("div");
    row.className = `chain-step ${step.ok ? "" : "bad"}`;
    row.innerHTML =
      `<span class="mark">${step.ok ? "✓" : "✗"}</span>` +
      `<span class="what">${escapeHtml(step.step)}</span>` +
      `<span>${escapeHtml(step.detail)}</span>`;
    el.appendChild(row);
    scrollDown();
  };
}

// ---- session ----------------------------------------------------------------

async function refreshSession() {
  const info = await fetch("/api/session").then((r) => r.json());
  signedIn = Boolean(info.signedIn);
  loginAvailable = Boolean(info.loginAvailable);

  if (signedIn) {
    whoEl.innerHTML =
      `signed in as <strong>${escapeHtml(info.email ?? info.name)}</strong> ` +
      `<button id="signout" class="linkish">sign out</button>`;
    document.getElementById("signout").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      await refreshSession();
      addMessage("agent", "Signed out. I've lost access to your todos.");
    });
  } else {
    whoEl.textContent = loginAvailable ? "not signed in" : "OIDC not configured";
  }
  return info;
}

/**
 * Opens the PingFederate login in a popup and resolves once it reports back.
 *
 * A popup rather than a redirect so the conversation underneath survives — the whole
 * point is that signing in happens *during* a turn, not before one.
 */
function signIn() {
  return new Promise((resolve) => {
    const popup = window.open(
      "/auth/login",
      "pf-login",
      "width=520,height=680,menubar=no,toolbar=no",
    );
    if (!popup) {
      resolve({ ok: false, detail: "Your browser blocked the sign-in popup." });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
      resolve(result);
    };

    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.source !== "xaa-chat-auth") return;
      finish({ ok: Boolean(event.data.ok), detail: event.data.detail });
    };
    window.addEventListener("message", onMessage);

    // Covers the user closing the window without completing.
    const poll = setInterval(() => {
      if (popup.closed) finish({ ok: false, detail: "Sign-in window was closed." });
    }, 500);
  });
}

// ---- a turn -----------------------------------------------------------------

/** Returns "auth-required" when the agent asked for a login instead of answering. */
async function streamTurn(prompt, pushChainStep) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, sessionId }),
  });

  if (!response.ok || !response.body) {
    const { error } = await response.json().catch(() => ({}));
    addMessage("agent error", error ?? `Request failed (${response.status}).`);
    return "done";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = null;
  let outcome = "done";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;

      let chunk;
      try {
        chunk = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (typeof chunk !== "string") continue;

      if (chunk.startsWith(TRACE_PREFIX)) {
        let event;
        try {
          event = JSON.parse(chunk.slice(TRACE_PREFIX.length));
        } catch {
          continue;
        }
        if (event.type === "chain") {
          pushChainStep(event);
        } else if (event.type === "chain-failed") {
          pushChainStep({ step: "Chain failed", detail: event.detail, ok: false });
        } else if (event.type === "tool") {
          addToolCall(event.name, event.args);
        } else if (event.type === "auth-required") {
          outcome = "auth-required";
          addAuthPrompt(event.reason, event.scope);
        }
        continue;
      }

      if (!reply) reply = addMessage("agent");
      reply.textContent += chunk;
      scrollDown();
    }
  }

  if (reply && reply.textContent.length === 0) reply.remove();
  return outcome;
}

let pendingAuthCard = null;

function addAuthPrompt(reason, scope) {
  const el = document.createElement("div");
  el.className = "authcard";
  el.innerHTML =
    `<div class="authcard-title">Sign-in needed</div>` +
    `<p>The todos server refused with <strong>401</strong>` +
    (scope ? ` and asked for <code>${escapeHtml(scope)}</code>` : "") +
    `. Its metadata says access needs an ID-JAG, which needs your identity — ` +
    `for <strong>${escapeHtml(reason)}</strong>.</p>` +
    `<p class="authcard-note">You sign in to PingFederate once, not to the todos app.</p>`;

  const button = document.createElement("button");
  button.textContent = loginAvailable
    ? "Sign in with PingFederate"
    : "OIDC not configured";
  button.disabled = !loginAvailable;
  el.appendChild(button);

  if (!loginAvailable) {
    const note = document.createElement("p");
    note.className = "authcard-note";
    note.textContent =
      "Set OIDC_CLIENT_ID in .env (and OIDC_CLIENT_SECRET if the client is confidential), then restart.";
    el.appendChild(note);
  }

  threadEl.appendChild(el);
  scrollDown();
  pendingAuthCard = { el, button };
  return el;
}

async function send(prompt, { echo = true } = {}) {
  if (echo) addMessage("user", prompt);
  promptEl.value = "";
  sendEl.disabled = true;
  promptEl.disabled = true;

  try {
    const outcome = await streamTurn(prompt, chainBox());

    if (outcome === "auth-required" && pendingAuthCard) {
      const { el, button } = pendingAuthCard;
      pendingAuthCard = null;

      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Waiting for PingFederate…";

        const result = await signIn();
        if (!result.ok) {
          button.disabled = false;
          button.textContent = "Sign in with PingFederate";
          const err = document.createElement("p");
          err.className = "authcard-note bad";
          err.textContent = result.detail ?? "Sign-in didn't complete.";
          el.appendChild(err);
          return;
        }

        await refreshSession();
        el.classList.add("done");
        button.remove();
        const ok = document.createElement("p");
        ok.className = "authcard-note";
        ok.textContent = "Signed in. Picking up where we left off…";
        el.appendChild(ok);

        // Replay the turn that triggered the login — the user shouldn't have to retype.
        sendEl.disabled = true;
        promptEl.disabled = true;
        await send(prompt, { echo: false });
      });
    }
  } catch (error) {
    addMessage("agent error", `Could not reach the chat server. ${error}`);
  } finally {
    sendEl.disabled = false;
    promptEl.disabled = false;
    promptEl.focus();
  }
}

composerEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = promptEl.value.trim();
  if (prompt) void send(prompt);
});

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    if (!sendEl.disabled) void send(chip.dataset.q);
  });
}

await refreshSession();
connectTraces();
promptEl.focus();
