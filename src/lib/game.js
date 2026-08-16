// src/lib/game.js
// Single source of truth for crate odds and prize pools. This file is the
// entire "rules of the game" — routes/api.js calls rollPrize() and trusts
// it completely; nothing outside this module decides an outcome.
//
// Rarity is rolled with crypto.getRandomValues via a rejection-sampled
// uniform draw (see randomUint32 below), not Math.random — Math.random is
// not cryptographically secure and must never appear anywhere server-side
// in this codebase.

/** @typedef {'common'|'uncommon'|'rare'|'epic'|'legendary'} Rarity */
/** @typedef {'standard'|'rare'} CrateType */

/** Weights don't need to sum to any particular total — they're normalized at roll time. */
export const CRATE_WEIGHTS = /** @type {const} */ ({
  standard: { common: 600, uncommon: 250, rare: 100, epic: 40, legendary: 10 },
  rare: { common: 300, uncommon: 300, rare: 250, epic: 120, legendary: 30 },
});

/**
 * Prize pools per crate type per rarity. Common/Uncommon/Rare are cosmetic
 * (no fulfillment needed beyond the win record). Epic/Legendary are real,
 * redeemable prizes — every Epic/Legendary win mints a one-time code
 * (see lib/db.js#recordSpin).
 * @type {Record<CrateType, Record<Rarity, {id: string, name: string}[]>>}
 */
export const PRIZE_POOLS = {
  standard: {
    common: [
      { id: "std-wooden-charm", name: "Wooden Charm" },
      { id: "std-rusty-coin", name: "Rusty Coin" },
      { id: "std-chipped-marble", name: "Chipped Marble" },
    ],
    uncommon: [
      { id: "std-silver-ring", name: "Silver Ring" },
      { id: "std-polished-stone", name: "Polished Stone" },
      { id: "std-copper-amulet", name: "Copper Amulet" },
    ],
    rare: [
      { id: "std-golden-feather", name: "Golden Feather" },
      { id: "std-sapphire-shard", name: "Sapphire Shard" },
    ],
    epic: [{ id: "std-petmart-15", name: "PetMart $15 Gift Card" }],
    legendary: [{ id: "std-visa-10", name: "$10 Visa Gift Card" }],
  },
  rare: {
    common: [
      { id: "rare-iron-charm", name: "Iron Charm" },
      { id: "rare-brass-coin", name: "Brass Coin" },
      { id: "rare-smooth-marble", name: "Smooth Marble" },
    ],
    uncommon: [
      { id: "rare-gold-ring", name: "Gold Ring" },
      { id: "rare-jade-stone", name: "Jade Stone" },
      { id: "rare-bronze-amulet", name: "Bronze Amulet" },
    ],
    rare: [
      { id: "rare-phoenix-feather", name: "Phoenix Feather" },
      { id: "rare-ruby-shard", name: "Ruby Shard" },
      { id: "rare-emerald-shard", name: "Emerald Shard" },
    ],
    epic: [{ id: "rare-petmart-25", name: "PetMart $25 Gift Card" }],
    legendary: [{ id: "rare-visa-10", name: "$10 Visa Gift Card" }],
  },
};

export const REDEEMABLE_RARITIES = new Set(["epic", "legendary"]);

/**
 * Draw a uniform random integer in [0, exclusiveMax) using rejection
 * sampling over crypto.getRandomValues, avoiding modulo bias.
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
 * Roll a rarity for the given crate type using its weight table.
 * @param {CrateType} crateType
 * @returns {Rarity}
 */
export function rollRarity(crateType) {
  const weights = CRATE_WEIGHTS[crateType];
  if (!weights) throw new RangeError(`unknown crate type: ${crateType}`);
  /** @type {[Rarity, number][]} */
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = randomUint32Below(total);
  for (const [rarity, weight] of entries) {
    if (roll < weight) return rarity;
    roll -= weight;
  }
  // Unreachable if weights are well-formed positive integers.
  return entries[entries.length - 1][0];
}

/**
 * Roll a full prize (rarity + specific item) for a crate type.
 * @param {CrateType} crateType
 * @returns {{rarity: Rarity, prizeId: string, prizeName: string}}
 */
export function rollPrize(crateType) {
  const rarity = rollRarity(crateType);
  const pool = PRIZE_POOLS[crateType][rarity];
  const prize = pool[randomUint32Below(pool.length)];
  return { rarity, prizeId: prize.id, prizeName: prize.name };
}

/** @param {string} value @returns {value is CrateType} */
export function isValidCrateType(value) {
  return value === "standard" || value === "rare";
}
