// public/app.js
// Player-facing UI. Talks only to /api/me, /api/spin, /api/redeem.
//
// Important: this file NEVER decides a prize. rollLocalOutcome() does not
// exist here on purpose — every crate opening is a POST /api/spin, and the
// animation below just plays back whatever the server already committed
// to. If you're reading this because you're tempted to "predict" the
// result client-side for a snappier animation, don't: that reopens the
// exact hole the server-authoritative design closes.

const RARITY_LABEL = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

const CRATE_LABEL = { standard: "Standard Crate", rare: "Rare Crate" };

let state = null; // last /api/me payload
let spinning = false;

const app = document.getElementById("app");
const userSlot = document.getElementById("userSlot");

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

async function refreshMe() {
  try {
    state = await api("/api/me");
  } catch {
    state = null;
  }
  render();
}

function render() {
  if (!state) {
    userSlot.innerHTML = `<a class="btn btn-primary" href="/auth/discord/login">Log in with Discord</a>`;
    app.innerHTML = `
      <div class="login-hero">
        <h1 class="display">Open crates. Win real prizes.</h1>
        <p>Log in with Discord to get your keys, spin the reels, and redeem
           Epic and Legendary wins for real rewards. Every outcome is
           decided server-side — the animation just shows you what already happened.</p>
        <a class="btn btn-primary" href="/auth/discord/login">Log in with Discord</a>
      </div>`;
    return;
  }

  userSlot.innerHTML = `
    <span class="user-chip">
      ${state.avatarUrl ? `<img src="${escapeHtml(state.avatarUrl)}" alt="" />` : ""}
      ${escapeHtml(state.username)}
    </span>
    <button class="btn" id="logoutBtn" style="margin-left:10px">Log out</button>
  `;
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetch("/auth/discord/logout", { method: "POST" });
    location.reload();
  });

  app.innerHTML = `
    <div class="crate-grid">
      ${crateCardHtml("standard", state.keys)}
      ${crateCardHtml("rare", state.rareKeys)}
    </div>

    <div class="crate-stage" id="stage">
      <div class="crate-box" id="crateBox">🎁</div>
      <div class="text-dim" id="stageHint" style="color:var(--text-dim);font-size:0.85rem">
        Pick a crate above to spin.
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <p class="section-title">Unredeemed prizes</p>
        <div id="redemptionsList"></div>
        <form class="redeem-form" id="redeemForm">
          <input type="text" id="redeemInput" placeholder="CRATE-XXXX-XXXX-XXXX" autocomplete="off" />
          <button class="btn btn-primary" type="submit">Redeem</button>
        </form>
      </div>

      <div class="card">
        <p class="section-title">Recent spins</p>
        <div id="historyList"></div>
      </div>
    </div>
  `;

  document.querySelectorAll("[data-spin-crate]").forEach((btn) => {
    btn.addEventListener("click", () => spin(btn.getAttribute("data-spin-crate")));
  });

  document.getElementById("redeemForm").addEventListener("submit", onRedeemSubmit);

  renderRedemptions();
  renderHistory();
}

function crateCardHtml(crateType, keyCount) {
  const label = CRATE_LABEL[crateType];
  const desc = crateType === "standard"
    ? "Common trinkets up to a $10 Visa gift card."
    : "Better odds across the board — up to a $10 Visa gift card and a bigger PetMart prize.";
  return `
    <div class="crate-card ${crateType}">
      <h3>${label}</h3>
      <p>${desc}</p>
      <div class="key-count"><strong>${keyCount}</strong> key${keyCount === 1 ? "" : "s"} available</div>
      <button class="btn btn-primary" data-spin-crate="${crateType}" ${keyCount > 0 && !spinning ? "" : "disabled"}>
        ${keyCount > 0 ? "Open crate" : "No keys"}
      </button>
    </div>
  `;
}

function renderRedemptions() {
  const list = document.getElementById("redemptionsList");
  const unredeemed = state.redemptions.filter((r) => !r.redeemed_at);
  if (unredeemed.length === 0) {
    list.innerHTML = `<div class="empty-state">No unredeemed prizes yet — Epic and Legendary wins show up here.</div>`;
    return;
  }
  list.innerHTML = unredeemed.map((r) => `
    <div class="redemption-row">
      <span>${escapeHtml(r.prize_name)}</span>
      <span class="prize-code">${escapeHtml(r.code)}</span>
    </div>
  `).join("");
}

function renderHistory() {
  const list = document.getElementById("historyList");
  if (state.history.length === 0) {
    list.innerHTML = `<div class="empty-state">No spins yet — open a crate to get started.</div>`;
    return;
  }
  list.innerHTML = state.history.map((h) => `
    <div class="history-row">
      <span>
        <span class="rarity-badge rarity-${h.rarity}">${RARITY_LABEL[h.rarity]}</span>
        &nbsp; ${escapeHtml(h.prize_name)}
      </span>
      <span class="history-meta">${escapeHtml(CRATE_LABEL[h.crate_type])} · ${formatTime(h.created_at)}</span>
    </div>
  `).join("");
}

function formatTime(sqliteUtc) {
  // D1's datetime('now') is UTC without a 'Z' suffix — append it so
  // Date parses it as UTC instead of assuming local time.
  const d = new Date(`${sqliteUtc.replace(" ", "T")}Z`);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function spin(crateType) {
  if (spinning) return;
  spinning = true;
  render();

  const crateBox = document.getElementById("crateBox");
  const stageHint = document.getElementById("stageHint");
  crateBox.className = "crate-box shaking";
  crateBox.textContent = "🎁";
  stageHint.textContent = `Opening ${CRATE_LABEL[crateType]}…`;

  try {
    // Let the shake animation play for a beat before the request lands —
    // purely cosmetic pacing, the outcome is already fixed server-side
    // the instant this fetch resolves.
    const [result] = await Promise.all([
      api("/api/spin", { method: "POST", body: JSON.stringify({ crateType }) }),
      wait(700),
    ]);

    crateBox.className = "crate-box bursting";
    await wait(400);

    document.getElementById("stage").innerHTML = `
      <div class="prize-reveal">
        <span class="rarity-badge rarity-${result.rarity}">${RARITY_LABEL[result.rarity]}</span>
        <span class="prize-name">${escapeHtml(result.prizeName)}</span>
        ${result.redemptionCode
          ? `<span class="prize-code">Redeem with: ${escapeHtml(result.redemptionCode)}</span>`
          : ""}
      </div>
    `;

    await refreshMeSilently();
  } catch (err) {
    showToast(err.message, "err");
  } finally {
    spinning = false;
    await refreshMe();
  }
}

// Refresh balances/history without a full re-render, so the just-revealed
// prize card stays on screen instead of being wiped by render().
async function refreshMeSilently() {
  try { state = await api("/api/me"); } catch { /* keep stale state */ }
}

async function onRedeemSubmit(e) {
  e.preventDefault();
  const input = document.getElementById("redeemInput");
  const code = input.value.trim();
  if (!code) return;
  try {
    const result = await api("/api/redeem", { method: "POST", body: JSON.stringify({ code }) });
    showToast(`Redeemed: ${result.prizeName}`, "ok");
    input.value = "";
    await refreshMe();
  } catch (err) {
    showToast(err.message, "err");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

refreshMe();
