// src/lib/db.js
// All D1 access lives here. Nothing in routes/ touches env.DB directly —
// that keeps the anti-cheat-critical queries (spendKey, recordSpin) in one
// auditable place.

import { generateRedemptionCode } from "./util.js";
import { REDEEMABLE_RARITIES } from "./game.js";

/**
 * Fetch a user by Discord id, or null if they've never logged in before.
 * @param {D1Database} db @param {string} discordId
 */
export async function getUserById(db, discordId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(discordId).first();
}

/**
 * Idempotent upsert on every login: creates the user on first login,
 * refreshes username/avatar on every subsequent one (Discord profiles
 * change), never touches key balances.
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
 * The anti-cheat core: atomically spend one key of the given crate type.
 * `UPDATE ... WHERE keys > 0` means the row only updates if a key was
 * actually available — D1/SQLite serializes writes per-row, so two
 * concurrent spins from the same user can't both succeed against a
 * balance of 1. Returns true iff a key was spent.
 * @param {D1Database} db @param {string} userId @param {'standard'|'rare'} crateType
 * @returns {Promise<boolean>}
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
  // D1's run() reports affected row count on meta.changes.
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Record a spin outcome. If the rarity is redeemable (epic/legendary),
 * also mints a one-time redemption code in the same call. Both inserts
 * happen after spendKey has already committed the key decrement, so a
 * failure here never lets a player re-attempt the same spin for free —
 * worst case is a spin with no history row, which is safe by construction
 * (no prize was ever shown to the client without this having succeeded,
 * since the route awaits this before responding).
 * @param {D1Database} db
 * @param {{userId: string, crateType: 'standard'|'rare', rarity: string, prizeId: string, prizeName: string}} spin
 * @returns {Promise<{spinId: number, redemptionCode: string | null}>}
 */
export async function recordSpin(db, spin) {
  const { userId, crateType, rarity, prizeId, prizeName } = spin;
  const insertResult = await db
    .prepare(
      `INSERT INTO spins (user_id, crate_type, rarity, prize_id, prize_name)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(userId, crateType, rarity, prizeId, prizeName)
    .run();

  const spinId = insertResult.meta?.last_row_id;
  if (typeof spinId !== "number") {
    throw new Error("failed to obtain spin id after insert");
  }

  if (!REDEEMABLE_RARITIES.has(rarity)) {
    return { spinId, redemptionCode: null };
  }

  // Retry on the extremely unlikely event of a code collision (unique
  // constraint on redemptions.code).
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
      return { spinId, redemptionCode: code };
    } catch (err) {
      if (attempt === 4) throw err;
      // UNIQUE constraint failed — loop and try a fresh code.
    }
  }
  throw new Error("unreachable");
}

/**
 * Recent spin history for a player, most recent first.
 * @param {D1Database} db @param {string} userId @param {number} limit
 */
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

/**
 * Unredeemed and redeemed prize codes for a player, most recent first.
 * @param {D1Database} db @param {string} userId
 */
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
 * Redeem a code for a user. Fails closed: wrong user, unknown code, or
 * already-redeemed code all return { ok: false } rather than throwing, so
 * the route can respond with a clean 4xx.
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

  if ((result.meta?.changes ?? 0) === 0) {
    // Lost a race against a concurrent redeem of the same code.
    return { ok: false, reason: "already_redeemed" };
  }
  return { ok: true, prizeName: row.prize_name, prizeId: row.prize_id };
}

/**
 * Search players by username substring, for the admin panel. Capped at 20
 * results — this is a lookup tool, not a full listing endpoint.
 * @param {D1Database} db @param {string} query
 */
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
 * Grant keys to a player and log the grant in one logical operation.
 * Grants are additive (never overwrite a balance), which is the safer
 * default for an admin tool used by a human under time pressure.
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

/**
 * Read-only audit log for the admin panel, most recent first.
 * @param {D1Database} db @param {number} limit
 */
export async function getAdminGrantLog(db, limit = 100) {
  const { results } = await db
    .prepare(`SELECT * FROM admin_grants ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all();
  return results ?? [];
}
