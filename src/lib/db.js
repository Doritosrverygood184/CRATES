// src/lib/db.js
// All D1 access lives here. routes/api.js never touches env.DB directly.

import { generateRedemptionCode } from "./util.js";
import { REDEEMABLE_RARITIES } from "./game.js";

/** @param {D1Database} db @param {string} discordId */
export async function getUserById(db, discordId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(discordId).first();
}

/**
 * @param {D1Database} db
 * @param {{id: string, username: string, avatarUrl: string | null}} profile
 */
export async function upsertUserFromDiscord(db, profile) {
  await db
    .prepare(
      `INSERT INTO users (id, username, avatar_url, keys, rare_keys, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         avatar_url = excluded.avatar_url,
         updated_at = datetime('now')`
    )
    .bind(profile.id, profile.username, profile.avatarUrl)
    .run();
  return getUserById(db, profile.id);
}

/**
 * Atomic key spend — the anti-cheat core. `WHERE <col> > 0` means the
 * row only updates if a key was actually available, so two concurrent
 * spins against a balance of 1 can't both succeed.
 * @param {D1Database} db @param {string} userId @param {'standard'|'rare'} crateType
 */
export async function spendKey(db, userId, crateType) {
  const column = crateType === "rare" ? "rare_keys" : "keys";
  const result = await db
    .prepare(
      `UPDATE users SET ${column} = ${column} - 1, updated_at = datetime('now')
       WHERE id = ? AND ${column} > 0`
    )
    .bind(userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Read the whole roll context lib/game.js#eligiblePool needs for one
 * spin, in a single read: last rarity, open count, pity flag, and
 * whether Legendary has already been claimed by anyone.
 * @param {D1Database} db @param {string} userId @param {'standard'|'rare'} crateType
 */
export async function getRollContext(db, userId, crateType) {
  const user = await getUserById(db, userId);
  const gameState = await db.prepare("SELECT * FROM game_state WHERE id = 1").first();
  const lastRarityCol = crateType === "standard" ? "standard_last_rarity" : "rare_last_rarity";
  const opensCol = crateType === "standard" ? "standard_opens" : "rare_opens";
  return {
    lastRarity: user?.[lastRarityCol] ?? null,
    isFirstSpin: (user?.[opensCol] ?? 0) === 0,
    legendaryWon: !!gameState?.legendary_won,
    pityRareActive: !!user?.pity_rare_active,
  };
}

/**
 * Apply the after-effects of one resolved spin: increment open count,
 * store last rarity, grant a Rare Crate Key on "rare", update the
 * hidden pity tracker, claim the global Legendary lock if this is the
 * winning spin, and insert the spin history row (+ redemption code for
 * Epic/Legendary). Does NOT spend a key — chained "Spin Again" respins
 * call this without a prior spendKey.
 * @param {D1Database} db
 * @param {{userId: string, crateType: 'standard'|'rare', rarity: string, prizeId: string, prizeName: string}} spin
 * @returns {Promise<{spinId: number, redemptionCode: string | null, rareKeyGranted: boolean, legendaryClaimed: boolean}>}
 */
export async function recordSpin(db, spin) {
  const { userId, crateType, rarity, prizeId, prizeName } = spin;
  const lastRarityCol = crateType === "standard" ? "standard_last_rarity" : "rare_last_rarity";
  const opensCol = crateType === "standard" ? "standard_opens" : "rare_opens";

  const user = await getUserById(db, userId);
  const rareKeyGranted = rarity === "rare";

  const updates = [`${opensCol} = ${opensCol} + 1`, `${lastRarityCol} = ?`, `updated_at = datetime('now')`];
  const binds = [rarity];
  if (rareKeyGranted) updates.push("rare_keys = rare_keys + 1");

  // Hidden pity: only tracked for the user's first two Standard Crate
  // spins ever. Once both are Common, flip pity_rare_active permanently.
  if (crateType === "standard" && (user?.standard_opens ?? 0) < 2) {
    let firstTwo = [];
    try {
      firstTwo = JSON.parse(user?.standard_first_two ?? "[]");
    } catch {
      firstTwo = [];
    }
    firstTwo.push(rarity);
    updates.push("standard_first_two = ?");
    binds.push(JSON.stringify(firstTwo));
    if (firstTwo.length === 2 && firstTwo[0] === "common" && firstTwo[1] === "common") {
      updates.push("pity_rare_active = 1");
    }
  }

  binds.push(userId);
  await db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();

  let legendaryClaimed = false;
  if (rarity === "legendary") {
    const result = await db
      .prepare(
        `UPDATE game_state SET legendary_won = 1, legendary_won_by = ?, legendary_won_at = datetime('now')
         WHERE id = 1 AND legendary_won = 0`
      )
      .bind(userId)
      .run();
    legendaryClaimed = (result.meta?.changes ?? 0) > 0;
  }

  const insertResult = await db
    .prepare(
      `INSERT INTO spins (user_id, crate_type, rarity, prize_id, prize_name)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(userId, crateType, rarity, prizeId, prizeName)
    .run();

  const spinId = insertResult.meta?.last_row_id;
  if (typeof spinId !== "number") throw new Error("failed to obtain spin id after insert");

  if (!REDEEMABLE_RARITIES.has(rarity)) {
    return { spinId, redemptionCode: null, rareKeyGranted, legendaryClaimed };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRedemptionCode();
    try {
      await db
        .prepare(
          `INSERT INTO redemptions (spin_id, user_id, code, prize_id, prize_name, redeemed_at)
           VALUES (?, ?, ?, ?, ?, NULL)`
        )
        .bind(spinId, userId, code, prizeId, prizeName)
        .run();
      return { spinId, redemptionCode: code, rareKeyGranted, legendaryClaimed };
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  throw new Error("unreachable");
}

/** @param {D1Database} db @param {string} userId @param {number} limit */
export async function getRecentSpins(db, userId, limit = 25) {
  const { results } = await db
    .prepare(
      `SELECT id, crate_type, rarity, prize_id, prize_name, created_at
       FROM spins WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(userId, limit)
    .all();
  return results ?? [];
}

/** @param {D1Database} db @param {string} userId */
export async function getRedemptionsForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT id, code, prize_id, prize_name, redeemed_at
       FROM redemptions WHERE user_id = ? ORDER BY id DESC`
    )
    .bind(userId)
    .all();
  return results ?? [];
}

/**
 * @param {D1Database} db @param {string} userId @param {string} code
 */
export async function redeemCode(db, userId, code) {
  const row = await db
    .prepare("SELECT * FROM redemptions WHERE code = ? AND user_id = ?")
    .bind(code, userId)
    .first();
  if (!row) return { ok: false, reason: "not_found" };
  if (row.redeemed_at) return { ok: false, reason: "already_redeemed" };

  const result = await db
    .prepare("UPDATE redemptions SET redeemed_at = datetime('now') WHERE id = ? AND redeemed_at IS NULL")
    .bind(row.id)
    .run();

  if ((result.meta?.changes ?? 0) === 0) return { ok: false, reason: "already_redeemed" };
  return { ok: true, prizeName: row.prize_name, prizeId: row.prize_id };
}

/** @param {D1Database} db @param {string} query */
export async function searchUsersByUsername(db, query) {
  const { results } = await db
    .prepare(
      `SELECT id, username, avatar_url, keys, rare_keys
       FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20`
    )
    .bind(`%${query.replace(/[%_\\]/g, (c) => "\\" + c)}%`)
    .all();
  return results ?? [];
}

/**
 * @param {D1Database} db
 * @param {{targetUserId: string, keys: number, rareKeys: number, note?: string}} grant
 */
export async function grantKeys(db, grant) {
  const { targetUserId, keys, rareKeys, note } = grant;
  const user = await getUserById(db, targetUserId);
  if (!user) return { ok: false, reason: "user_not_found" };

  await db.batch([
    db
      .prepare(
        `UPDATE users SET keys = keys + ?, rare_keys = rare_keys + ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(keys, rareKeys, targetUserId),
    db
      .prepare(
        `INSERT INTO admin_grants (target_user_id, target_username, keys_granted, rare_keys_granted, note)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(targetUserId, user.username, keys, rareKeys, note ?? null),
  ]);
  return { ok: true };
}

/** @param {D1Database} db @param {number} limit */
export async function getAdminGrantLog(db, limit = 100) {
  const { results } = await db
    .prepare(`SELECT * FROM admin_grants ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all();
  return results ?? [];
}

/** Global game state — whether Legendary has been claimed, by whom. @param {D1Database} db */
export async function getGameState(db) {
  return db.prepare("SELECT * FROM game_state WHERE id = 1").first();
}
