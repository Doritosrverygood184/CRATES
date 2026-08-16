// src/lib/game.js
// Canonical game rules. Every roll happens here, server-side, using
// crypto.getRandomValues — never Math.random. routes/api.js trusts this
// module completely and never re-derives an outcome.

/** @typedef {'common'|'uncommon'|'rare'|'epic'|'legendary'} Rarity */
/** @typedef {'standard'|'rare'} CrateType */

// Weights are the design's percentages *10 to stay integer (rare crate's
// 1.2% becomes 12). Only Common/Rare differ between crate types; the
// rest are shared by design.
export const CRATE_WEIGHTS = /** @type {const} */ ({
  standard: { common: 550, uncommon: 270, rare: 120, epic: 50, legendary: 10 },
  rare: { common: 275, uncommon: 270, rare: 12, epic: 50, legendary: 10 },
});

// Fixed prize per rarity — same name regardless of which crate it came
// from, matching the original design (no per-crate item pools).
export const RARITY_PRIZE = {
  common: { id: "nothing", name: "Nothing" },
  uncommon: { id: "spin-again", name: "Spin Again" },
  rare: { id: "rare-crate-key", name: "Rare Crate Key" },
  epic: { id: "petmart-item", name: "PetMart Item (under $5)" },
  legendary: { id: "visa-10", name: "$10 Visa Gift Card" },
};

export const REDEEMABLE_RARITIES = new Set(["epic", "legendary"]);

// A crate that locks Epic/Legendary out of its very first-ever spin.
// Standard does this by design (the "close first win" near-miss bait
// only makes sense if the real prize genuinely can't land there); Rare
// has no such lock.
const FIRST_SPIN_LOCKED_CRATES = new Set(["standard"]);

/**
 * Rejection-sampled uniform draw over crypto.getRandomValues — avoids
 * modulo bias, never uses Math.random.
 * @param {number} exclusiveMax
 */
function randomUint32Below(exclusiveMax) {
  if (exclusiveMax <= 0) throw new RangeError("exclusiveMax must be positive");
  const range = Math.floor(0xffffffff / exclusiveMax) * exclusiveMax;
  const buf = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= range);
  return value % exclusiveMax;
}

/**
 * Build the eligible rarity pool + weights for this spin, given the
 * user's live state. This is the single source of truth for "what can
 * this spin possibly land on" — routes/api.js never filters separately.
 * @param {CrateType} crateType
 * @param {{lastRarity: string|null, isFirstSpin: boolean, legendaryWon: boolean, pityRareActive: boolean}} ctx
 * @returns {{rarity: Rarity, weight: number}[]}
 */
export function eligiblePool(crateType, ctx) {
  const base = CRATE_WEIGHTS[crateType];
  if (!base) throw new RangeError(`unknown crate type: ${crateType}`);
  const firstSpinLocked = FIRST_SPIN_LOCKED_CRATES.has(crateType) && ctx.isFirstSpin;

  /** @type {Rarity[]} */
  const rarities = ["common", "uncommon", "rare", "epic", "legendary"];
  return rarities
    .filter((r) => {
      if (r === "uncommon" && ctx.lastRarity === "uncommon") return false; // no back-to-back Uncommon
      if (r === "epic" && firstSpinLocked) return false;
      if (r === "legendary" && (ctx.legendaryWon || firstSpinLocked)) return false;
      return true;
    })
    .map((r) => {
      let weight = base[r];
      // Hidden pity: Standard Crate only, never surfaced to the client —
      // boosts Rare's weight 50% once triggered. Intentionally not part
      // of any odds display; routes/api.js just uses the final number.
      if (crateType === "standard" && r === "rare" && ctx.pityRareActive) {
        weight = Math.round(weight * 1.5);
      }
      return { rarity: r, weight };
    });
}

/**
 * Roll one rarity from a precomputed eligible pool.
 * @param {{rarity: Rarity, weight: number}[]} pool
 * @returns {Rarity}
 */
export function rollFromPool(pool) {
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  let roll = randomUint32Below(total);
  for (const p of pool) {
    if (roll < p.weight) return p.rarity;
    roll -= p.weight;
  }
  return pool[pool.length - 1].rarity;
}

/** @param {string} value @returns {value is CrateType} */
export function isValidCrateType(value) {
  return value === "standard" || value === "rare";
}

/**
 * Odds table for display purposes only (never used to roll). Excludes
 * whatever the crate's permanent rules exclude (Legendary-already-won,
 * Uncommon-can't-repeat) but deliberately does NOT reflect the
 * first-spin lock or the hidden pity boost — the UI never tips off
 * either of those, matching the original design's "close first win".
 * @param {CrateType} crateType
 * @param {{lastRarity: string|null, legendaryWon: boolean}} ctx
 */
export function displayOdds(crateType, ctx) {
  const base = CRATE_WEIGHTS[crateType];
  /** @type {Rarity[]} */
  const rarities = ["common", "uncommon", "rare", "epic", "legendary"];
  const active = rarities.filter((r) => {
    if (r === "uncommon" && ctx.lastRarity === "uncommon") return false;
    if (r === "legendary" && ctx.legendaryWon) return false;
    return true;
  });
  const total = active.reduce((sum, r) => sum + base[r], 0);
  return active.map((r) => ({
    rarity: r,
    prizeName: RARITY_PRIZE[r].name,
    percent: Math.round((base[r] / total) * 1000) / 10,
  }));
}
