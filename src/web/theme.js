// Auto / Light / Dark — no separate "Ping" variant. Both light and dark are Ping
// Identity's palette (see styles.css); this only decides which one is active.

const STORAGE_KEY = "console-theme-preference";

export function initTheme() {
  const switcher = document.getElementById("theme-switcher");
  const saved = localStorage.getItem(STORAGE_KEY) || "auto";

  applyTheme(saved);

  if (switcher) {
    switcher.querySelectorAll(".theme-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.theme === saved);
      btn.addEventListener("click", () => setTheme(btn.dataset.theme));
    });
  }
}

function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === "auto") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", theme);
  }
  updateSwitcherState(theme);
}

function setTheme(theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

function updateSwitcherState(theme) {
  const switcher = document.getElementById("theme-switcher");
  if (!switcher) return;
  switcher.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
}