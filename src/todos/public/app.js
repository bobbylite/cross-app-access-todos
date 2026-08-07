// The todos app view. Polls nothing — it re-reads only when the store says something
// changed, so an agent's tool call shows up here the instant it commits.

const peopleEl = document.getElementById("people");
const boardEl = document.getElementById("board");
const footerEl = document.getElementById("footer");
const dotEl = document.getElementById("dot");
const liveEl = document.getElementById("live");
const sessionEl = document.getElementById("session");
const composeEl = document.getElementById("compose");
const hintEl = document.getElementById("compose-hint");
const titleEl = document.getElementById("title");
const priorityEl = document.getElementById("priority");
const dueEl = document.getElementById("due");

let selectedUserId = null;
let signedInUserId = null;
/** Todo ids seen on the previous render, so new arrivals can be highlighted. */
let previouslySeen = new Set();
let firstRender = true;

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function relativeDue(dueDate) {
  if (!dueDate) return null;
  const days = Math.round(
    (new Date(`${dueDate}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 86400000,
  );
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days < 0) return `${-days}d overdue`;
  return `due in ${days}d`;
}

// ---- session --------------------------------------------------------------------

async function loadSession() {
  const { user } = await fetch("/api/session").then((r) => r.json());
  signedInUserId = user?.id ?? null;
  renderSession(user);
}

function renderSession(user) {
  if (user) {
    sessionEl.innerHTML = `
      <span class="who-in">signed in as <strong>${escapeHtml(
        user.displayName || user.email || user.id,
      )}</strong></span>
      <button id="signout" class="linkish">sign out</button>`;
    document.getElementById("signout").addEventListener("click", async () => {
      await fetch("/api/session", { method: "DELETE" });
      await loadSession();
      updateCompose();
      // The board renders its complete buttons based on the session, so it has to be
      // redrawn too — otherwise controls linger that the server would only reject.
      await refresh();
    });
  } else {
    sessionEl.innerHTML = `<button id="signin" class="linkish">sign in</button>`;
    document.getElementById("signin").addEventListener("click", async () => {
      if (!selectedUserId) return;
      await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedUserId }),
      });
      await loadSession();
      updateCompose();
      await refresh();
    });
  }
}

/**
 * The form only appears when the session's user is the person being viewed. Writing
 * into someone else's list isn't a thing the app offers — same rule the tools follow.
 */
function updateCompose() {
  const canWrite = signedInUserId && signedInUserId === selectedUserId;
  composeEl.hidden = !canWrite;

  if (canWrite) {
    hintEl.textContent =
      "Writes from here are recorded as 'in app' — a person over a session. The agent's arrive as 'via agent'.";
  } else if (signedInUserId) {
    hintEl.textContent =
      "You're signed in as someone else. Select your own list to add items.";
  } else {
    hintEl.textContent =
      "Demo sign-in — pick a person and sign in to add items. Not a credential check; the real version is OIDC against the same IdP that issues the ID-JAGs.";
  }
}

// ---- people ---------------------------------------------------------------------

async function loadPeople() {
  const res = await fetch("/api/users");
  const { users, database } = await res.json();

  footerEl.textContent = database ? `sqlite · ${database}` : "";

  if (users.length === 0) {
    peopleEl.innerHTML = "";
    boardEl.innerHTML = `<p class="empty">No users yet. Redeem an ID-JAG and the
      todos app will provision one just in time.</p>`;
    composeEl.hidden = true;
    return;
  }

  if (!selectedUserId || !users.some((u) => u.id === selectedUserId)) {
    selectedUserId = users[0].id;
  }

  peopleEl.innerHTML = users
    .map(
      (u) => `
      <button class="person" data-id="${escapeHtml(u.id)}"
              aria-pressed="${u.id === selectedUserId}">
        ${escapeHtml(u.displayName || u.email || u.idpSubject)}
        <span class="count">${u.counts.open} open</span>
      </button>`,
    )
    .join("");

  for (const button of peopleEl.querySelectorAll(".person")) {
    button.addEventListener("click", () => {
      if (button.dataset.id === selectedUserId) return;
      selectedUserId = button.dataset.id;
      previouslySeen = new Set();
      firstRender = true;
      updateCompose();
      void refresh();
    });
  }
}

// ---- board ----------------------------------------------------------------------

const ORIGIN_BADGE = {
  agent: { label: "via agent", className: "by-agent" },
  user: { label: "in app", className: "by-user" },
};

function renderTodo(todo, isNew, canComplete) {
  const due = relativeDue(todo.dueDate);
  const meta = [
    `<span class="id">${escapeHtml(todo.id)}</span>`,
    `<span class="pri pri-${escapeHtml(todo.priority)}">${escapeHtml(todo.priority)}</span>`,
    due ? `<span>${escapeHtml(due)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  const badge = ORIGIN_BADGE[todo.createdBy];
  const check =
    canComplete && todo.status === "open"
      ? `<button class="check" data-complete="${escapeHtml(todo.id)}"
                 aria-label="Complete ${escapeHtml(todo.title)}"></button>`
      : `<span class="check" aria-hidden="true"></span>`;

  return `
    <article class="todo ${todo.status === "done" ? "done" : ""} ${isNew ? "just-changed" : ""}">
      ${check}
      <div class="title">${escapeHtml(todo.title)}</div>
      ${badge ? `<span class="${badge.className}">${badge.label}</span>` : "<span></span>"}
      ${todo.notes ? `<div class="notes">${escapeHtml(todo.notes)}</div>` : ""}
      <div class="meta">${meta}</div>
    </article>`;
}

async function refresh() {
  if (!selectedUserId) return;

  const res = await fetch(`/api/users/${encodeURIComponent(selectedUserId)}/todos`);
  if (!res.ok) return;
  const { user, todos, counts } = await res.json();

  const canWrite = signedInUserId === user.id;
  const open = todos.filter((t) => t.status === "open");
  const done = todos.filter((t) => t.status === "done");

  const section = (label, items) =>
    items.length === 0
      ? ""
      : `<div class="group-label">${label} · ${items.length}</div>` +
        items
          .map((t) =>
            renderTodo(t, !firstRender && !previouslySeen.has(t.id), canWrite),
          )
          .join("");

  const tally = [
    counts.byAgent ? `${counts.byAgent} via agent` : "",
    counts.byUser ? `${counts.byUser} in app` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  boardEl.innerHTML = `
    <div class="who">
      <h2>${escapeHtml(user.displayName || user.email || user.id)}</h2>
      <span class="idp">${escapeHtml(user.idpSubject)}</span>
      ${user.jitProvisioned ? '<span class="tag-jit">JIT provisioned</span>' : ""}
      ${tally ? `<span class="tally">${escapeHtml(tally)}</span>` : ""}
    </div>
    ${section("Open", open)}
    ${section("Done", done)}
    ${todos.length === 0 ? '<p class="empty">Nothing here yet.</p>' : ""}`;

  for (const button of boardEl.querySelectorAll("[data-complete]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      await fetch(`/api/todos/${encodeURIComponent(button.dataset.complete)}/complete`, {
        method: "POST",
      });
      await refresh();
    });
  }

  const chip = peopleEl.querySelector(`.person[data-id="${CSS.escape(user.id)}"] .count`);
  if (chip) chip.textContent = `${counts.open} open`;

  previouslySeen = new Set(todos.map((t) => t.id));
  firstRender = false;
}

// ---- compose --------------------------------------------------------------------

composeEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = titleEl.value.trim();
  if (!title) return;

  const button = composeEl.querySelector("button");
  button.disabled = true;
  try {
    const res = await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        priority: priorityEl.value,
        due_date: dueEl.value || undefined,
      }),
    });
    if (res.ok) {
      titleEl.value = "";
      dueEl.value = "";
      priorityEl.value = "normal";
    } else {
      const { error } = await res.json().catch(() => ({}));
      hintEl.textContent = error ?? "That write was rejected.";
    }
  } finally {
    button.disabled = false;
    titleEl.focus();
  }
  await refresh();
});

// ---- live ------------------------------------------------------------------------

function connect() {
  const source = new EventSource("/api/events");
  source.onopen = () => {
    dotEl.className = "dot on";
    liveEl.textContent = "live";
  };
  source.onmessage = () => {
    // A write landed somewhere. Reload the roster too, since it may be a brand-new
    // user arriving through just-in-time provisioning.
    void loadPeople().then(refresh);
  };
  source.onerror = () => {
    dotEl.className = "dot off";
    liveEl.textContent = "reconnecting…";
  };
}

await loadSession();
await loadPeople();
updateCompose();
await refresh();
connect();
