// public/admin.js
// Admin panel. Auth here is the shared ADMIN_PASSWORD, entirely separate
// from player Discord auth — this page never reads or sets the player
// session cookie.

const app = document.getElementById("app");
const userSlot = document.getElementById("userSlot");

let authenticated = false;
let lastSearchResults = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const message = (data && data.error) || `request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

function showToast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderLogin() {
  userSlot.textContent = "";
  app.innerHTML = `
    <div class="login-hero" style="padding-top:60px">
      <h1 class="display" style="font-size:1.6rem">Admin sign-in</h1>
      <p>Enter the shared admin password to search players and grant keys.</p>
      <form class="admin-form" id="loginForm">
        <input type="password" id="passwordInput" placeholder="Admin password" autocomplete="current-password" required />
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
    </div>
  `;
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("passwordInput").value;
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
      authenticated = true;
      renderDashboard();
    } catch (err) {
      showToast(err.message, "err");
    }
  });
}

function renderDashboard() {
  userSlot.innerHTML = `<button class="btn" id="logoutBtn">Log out</button>`;
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST" });
    authenticated = false;
    renderLogin();
  });

  app.innerHTML = `
    <div class="stack">
      <div class="card">
        <p class="section-title">Find a player</p>
        <form class="admin-form" id="searchForm" style="max-width:none;flex-direction:row">
          <input type="text" id="searchInput" placeholder="Discord username" style="flex:1" />
          <button class="btn btn-primary" type="submit">Search</button>
        </form>
        <div id="searchResults" style="margin-top:16px"></div>
      </div>

      <div class="card">
        <p class="section-title">Recent grants</p>
        <div id="grantLog"></div>
      </div>
    </div>
  `;

  document.getElementById("searchForm").addEventListener("submit", onSearchSubmit);
  loadGrantLog();
}

async function onSearchSubmit(e) {
  e.preventDefault();
  const query = document.getElementById("searchInput").value.trim();
  if (query.length < 2) {
    showToast("type at least 2 characters", "err");
    return;
  }
  try {
    const { users } = await api(`/api/admin/search?username=${encodeURIComponent(query)}`);
    lastSearchResults = users;
    renderSearchResults(users);
  } catch (err) {
    showToast(err.message, "err");
  }
}

function renderSearchResults(users) {
  const container = document.getElementById("searchResults");
  if (users.length === 0) {
    container.innerHTML = `<div class="empty-state">No players matched.</div>`;
    return;
  }
  container.innerHTML = users.map((u) => `
    <div class="result-row" data-user-id="${escapeHtml(u.id)}">
      <div>
        <div class="who">${escapeHtml(u.username)}</div>
        <div class="balances">${u.keys} standard · ${u.rare_keys} rare</div>
      </div>
      <div class="grant-inline">
        <input type="number" min="0" placeholder="std" class="grant-std" title="Standard keys to grant" />
        <input type="number" min="0" placeholder="rare" class="grant-rare" title="Rare keys to grant" />
        <button class="btn btn-primary grant-btn" type="button">Grant</button>
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".grant-btn").forEach((btn) => {
    btn.addEventListener("click", () => onGrantClick(btn));
  });
}

async function onGrantClick(btn) {
  const row = btn.closest(".result-row");
  const userId = row.getAttribute("data-user-id");
  const keys = parseInt(row.querySelector(".grant-std").value, 10) || 0;
  const rareKeys = parseInt(row.querySelector(".grant-rare").value, 10) || 0;

  if (keys === 0 && rareKeys === 0) {
    showToast("enter at least one key to grant", "err");
    return;
  }

  btn.disabled = true;
  try {
    await api("/api/admin/grant", { method: "POST", body: JSON.stringify({ userId, keys, rareKeys }) });
    showToast("keys granted", "ok");
    row.querySelector(".grant-std").value = "";
    row.querySelector(".grant-rare").value = "";
    await loadGrantLog();
    // Re-run the search so the visible balance reflects the grant.
    const query = document.getElementById("searchInput").value.trim();
    if (query.length >= 2) {
      const { users } = await api(`/api/admin/search?username=${encodeURIComponent(query)}`);
      renderSearchResults(users);
    }
  } catch (err) {
    showToast(err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function loadGrantLog() {
  const container = document.getElementById("grantLog");
  try {
    const { grants } = await api("/api/admin/log");
    if (grants.length === 0) {
      container.innerHTML = `<div class="empty-state">No grants yet.</div>`;
      return;
    }
    container.innerHTML = grants.map((g) => `
      <div class="history-row">
        <span>${escapeHtml(g.target_username)} — +${g.keys_granted} std, +${g.rare_keys_granted} rare</span>
        <span class="history-meta">${formatTime(g.created_at)}</span>
      </div>
    `).join("");
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Couldn't load the grant log.</div>`;
  }
}

function formatTime(sqliteUtc) {
  const d = new Date(`${sqliteUtc.replace(" ", "T")}Z`);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// There's no "am I logged in" endpoint, so probe with a cheap authed call
// and fall back to the login screen on 401.
(async function init() {
  try {
    await api("/api/admin/log");
    authenticated = true;
    renderDashboard();
  } catch {
    renderLogin();
  }
})();
