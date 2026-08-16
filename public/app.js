// public/app.js
// Player-facing UI. Talks only to /api/me, /api/spin, /api/redeem.
//
// The server resolves an entire "Spin Again" chain in one /api/spin call
// and returns it as an ordered list. This file's only job is to play
// that list back, one reel-spin at a time — it never decides an outcome,
// predicts one, or re-orders the chain it's given.

const RARITY_LABEL = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
const RARITY_ICON = { common: "⬜", uncommon: "🔁", rare: "🗝️", epic: "🐾", legendary: "💳" };
const CRATE_LABEL = { standard: "Standard Crate", rare: "Rare Crate" };

const CARD_WIDTH = 110; // px, matches .reel-card flex-basis (100) + margins (5+5)
const REEL_LENGTH = 44;
const LAND_INDEX = REEL_LENGTH - 6;

let state = null; // last /api/me payload
let spinning = { standard: false, rare: false };

const app = document.getElementById("app");
const userSlot = document.getElementById("userSlot");

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
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
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function refreshMe() {
  try { state = await api("/api/me"); } catch { state = null; }
  render();
}

function render() {
  if (!state) {
    userSlot.innerHTML = `<a class="btn btn-primary" href="/auth/discord/login">Log in with Discord</a>`;
    app.innerHTML = `
      <div class="login-hero">
        <h1 class="display">Open crates. Win real prizes.</h1>
        <p>Log in with Discord for keys, spin the reels, and redeem Epic and
           Legendary wins. Every roll is decided server-side — the reel just
           shows you what already happened.</p>
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
      ${crateCardHtml("standard")}
      ${crateCardHtml("rare")}
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

  seedReel("standard");
  seedReel("rare");
  renderOdds("standard");
  renderOdds("rare");
  renderRedemptions();
  renderHistory();
}

function crateCardHtml(crateType) {
  const label = CRATE_LABEL[crateType];
  const keyCount = crateType === "standard" ? state.keys : state.rareKeys;
  const desc = crateType === "standard"
    ? "Nothing, a free respin, a Rare Crate Key, a PetMart item, or the $10 Visa card."
    : "Same prize ladder, better odds on the big ones — unlocked by winning a Rare Crate Key.";
  return `
    <div class="crate-card ${crateType}">
      <h3>${label}</h3>
      <p>${desc}</p>

      <div class="reel-viewport" id="viewport-${crateType}">
        <div class="reel-pointer"></div>
        <div class="reel-strip" id="reel-${crateType}"></div>
      </div>
      <div id="chainBanner-${crateType}"></div>

      <div class="key-count"><strong>${keyCount}</strong> key${keyCount === 1 ? "" : "s"} available</div>
      <button class="btn btn-primary" data-spin-crate="${crateType}" ${keyCount > 0 && !spinning[crateType] ? "" : "disabled"}>
        ${keyCount > 0 ? "Spin" : "No keys"}
      </button>
      <div id="resultBox-${crateType}"></div>

      <p class="section-title" style="margin-top:16px">Odds</p>
      <table class="odds-table"><tbody id="oddsBody-${crateType}"></tbody></table>
    </div>
  `;
}

// --- Reel rendering ---------------------------------------------------

function cardHtml(rarity, name) {
  return `<div class="reel-card">
    <div>${RARITY_ICON[rarity]}</div>
    <div class="reel-card-name rarity-${rarity}">${escapeHtml(name)}</div>
  </div>`;
}

// Cosmetic filler only — drawn locally for the idle/scrolling look.
// Never used to determine an outcome; the server already decided that
// before this file sees the response.
function randomFillerRarity() {
  const rarities = ["common", "uncommon", "rare", "epic", "legendary"];
  return rarities[Math.floor(Math.random() * rarities.length)];
}

function seedReel(crateType) {
  const reel = document.getElementById(`reel-${crateType}`);
  if (!reel) return;
  let html = "";
  for (let i = 0; i < 10; i++) {
    const r = randomFillerRarity();
    html += cardHtml(r, RARITY_LABEL[r]);
  }
  reel.style.transition = "none";
  reel.style.transform = "translateX(-50%)";
  reel.innerHTML = html;
}

/**
 * Animate one reel landing on `rarity`/`prizeName`. Builds a strip with
 * random filler and the real result placed at LAND_INDEX, then slides
 * the strip so that card stops under the pointer.
 */
async function playReelSpin(crateType, rarity, prizeName) {
  const reel = document.getElementById(`reel-${crateType}`);
  let html = "";
  for (let i = 0; i < REEL_LENGTH; i++) {
    if (i === LAND_INDEX) {
      html += cardHtml(rarity, prizeName);
    } else {
      const r = randomFillerRarity();
      html += cardHtml(r, RARITY_LABEL[r]);
    }
  }
  reel.innerHTML = html;
  reel.style.transition = "none";
  reel.style.transform = "translateX(0px)";
  void reel.offsetWidth; // force reflow before animating

  const targetOffset = -(LAND_INDEX * CARD_WIDTH) - CARD_WIDTH / 2;
  const jitter = Math.random() * 24 - 12;
  reel.style.transition = "transform 1.9s cubic-bezier(0.12, 0.85, 0.1, 1)";
  reel.style.transform = `translateX(${targetOffset + jitter}px)`;

  await wait(2000);
}

// --- Odds / history / redemptions -------------------------------------

function renderOdds(crateType) {
  const body = document.getElementById(`oddsBody-${crateType}`);
  const rows = (state.odds?.[crateType] || [])
    .map(
      (o) => `
      <tr>
        <td><span class="odds-pip rarity-${o.rarity}" style="background:currentColor"></span><span class="rarity-${o.rarity}">${RARITY_LABEL[o.rarity]}</span></td>
        <td>${o.percent}%</td>
        <td>${escapeHtml(o.prizeName)}</td>
      </tr>`
    )
    .join("");
  body.innerHTML = rows || `<tr><td colspan="3" class="empty-state">No data yet.</td></tr>`;
}

function renderRedemptions() {
  const list = document.getElementById("redemptionsList");
  const unredeemed = state.redemptions.filter((r) => !r.redeemed_at);
  if (unredeemed.length === 0) {
    list.innerHTML = `<div class="empty-state">No unredeemed prizes yet — Epic and Legendary wins show up here.</div>`;
    return;
  }
  list.innerHTML = unredeemed
    .map(
      (r) => `
    <div class="redemption-row">
      <span>${escapeHtml(r.prize_name)}</span>
      <span class="prize-code">${escapeHtml(r.code)}</span>
    </div>`
    )
    .join("");
}

function renderHistory() {
  const list = document.getElementById("historyList");
  if (state.history.length === 0) {
    list.innerHTML = `<div class="empty-state">No spins yet — open a crate to get started.</div>`;
    return;
  }
  list.innerHTML = state.history
    .map(
      (h) => `
    <div class="history-row">
      <span>
        <span class="rarity-badge rarity-${h.rarity}">${RARITY_LABEL[h.rarity]}</span>
        &nbsp; ${escapeHtml(h.prize_name)}
      </span>
      <span class="history-meta">${escapeHtml(CRATE_LABEL[h.crate_type])} · ${formatTime(h.created_at)}</span>
    </div>`
    )
    .join("");
}

function formatTime(sqliteUtc) {
  const d = new Date(`${sqliteUtc.replace(" ", "T")}Z`);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// --- Spin flow ----------------------------------------------------------

async function spin(crateType) {
  if (spinning[crateType]) return;
  spinning[crateType] = true;
  render();

  const resultBox = document.getElementById(`resultBox-${crateType}`);
  const chainBanner = document.getElementById(`chainBanner-${crateType}`);
  resultBox.innerHTML = "";
  chainBanner.innerHTML = "";

  try {
    const response = await api("/api/spin", { method: "POST", body: JSON.stringify({ crateType }) });
    const chain = response.chain;

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i];
      if (i > 0) {
        chainBanner.innerHTML = `<div class="chain-banner">🔁 Spin Again — free respin ${i + 1}</div>`;
        await wait(500);
      }
      await playReelSpin(crateType, step.rarity, step.prizeName);
    }
    chainBanner.innerHTML = "";

    const final = chain[chain.length - 1];
    resultBox.innerHTML = renderResultBox(final);

    if (final.legendaryClaimed) {
      showToast("🎉 Legendary claimed — you got the $10 Visa Gift Card!", "ok");
    } else if (final.rareKeyGranted) {
      showToast("Rare Crate Key earned!", "ok");
    }

    await refreshMeSilently();
  } catch (err) {
    showToast(err.message, "err");
  } finally {
    spinning[crateType] = false;
    await refreshMe();
  }
}

function renderResultBox(step) {
  return `
    <div class="prize-reveal">
      <span class="rarity-badge rarity-${step.rarity}">${RARITY_LABEL[step.rarity]}</span>
      <span class="prize-name">${escapeHtml(step.prizeName)}</span>
      ${step.redemptionCode ? `<span class="prize-code">Redeem with: ${escapeHtml(step.redemptionCode)}</span>` : ""}
    </div>
  `;
}

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

refreshMe();
