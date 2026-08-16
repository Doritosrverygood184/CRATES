// src/routes/api.js
// Player-facing API. The entire anti-cheat contract lives in handleSpin's
// ordering: spend key -> read roll context -> roll -> record -> respond.
// "Spin Again" (Uncommon) chains are resolved in a loop right here on the
// server; the client receives the full ordered list of outcomes and just
// plays them back one reel-spin at a time. It never rolls anything itself.

import { verifyPlayerSession, PLAYER_COOKIE_NAME } from "../lib/auth.js";
import { parseCookies, json, jsonError } from "../lib/util.js";
import {
  spendKey,
  recordSpin,
  getRecentSpins,
  getRedemptionsForUser,
  redeemCode,
  getUserById,
  getRollContext,
  getGameState,
} from "../lib/db.js";
import { eligiblePool, rollFromPool, isValidCrateType, RARITY_PRIZE, displayOdds } from "../lib/game.js";

const MAX_CHAIN_LENGTH = 25; // safety cap on consecutive free "Spin Again" respins

/**
 * @param {Request} request @param {Env} env
 * @returns {Promise<{id: string, username: string} | null>}
 */
async function getSessionUser(request, env) {
  const cookies = parseCookies(request);
  const payload = await verifyPlayerSession(cookies[PLAYER_COOKIE_NAME], env.SESSION_SECRET);
  if (!payload) return null;
  return { id: /** @type {string} */ (payload.sub), username: /** @type {string} */ (payload.username) };
}

/**
 * GET /api/me — profile, balances, history, redemptions, and the
 * current (display-only) odds table for both crates.
 * @param {Request} request @param {Env} env
 */
export async function handleMe(request, env) {
  const session = await getSessionUser(request, env);
  if (!session) return jsonError("not authenticated", 401);

  const user = await getUserById(env.DB, session.id);
  if (!user) return jsonError("account not found", 404);

  const [history, redemptions, gameState] = await Promise.all([
    getRecentSpins(env.DB, session.id, 25),
    getRedemptionsForUser(env.DB, session.id),
    getGameState(env.DB),
  ]);

  const legendaryWon = !!gameState?.legendary_won;
  const odds = {
    standard: displayOdds("standard", { lastRarity: user.standard_last_rarity, legendaryWon }),
    rare: displayOdds("rare", { lastRarity: user.rare_last_rarity, legendaryWon }),
  };

  return json({
    id: user.id,
    username: user.username,
    avatarUrl: user.avatar_url,
    keys: user.keys,
    rareKeys: user.rare_keys,
    standardOpens: user.standard_opens,
    rareOpens: user.rare_opens,
    legendaryWon,
    history,
    redemptions,
    odds,
  });
}

/**
 * POST /api/spin { crateType: 'standard' | 'rare' }
 *
 * Spends exactly one key for the initial spin. If that spin (or any
 * chained free respin after it) lands Uncommon, the server immediately
 * rolls the next spin on the same crate at no cost and appends it to the
 * chain, repeating until a non-Uncommon result or MAX_CHAIN_LENGTH.
 * @param {Request} request @param {Env} env
 */
export async function handleSpin(request, env) {
  const session = await getSessionUser(request, env);
  if (!session) return jsonError("not authenticated", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const crateType = body?.crateType;
  if (!isValidCrateType(crateType)) {
    return jsonError("crateType must be 'standard' or 'rare'", 400);
  }

  const spent = await spendKey(env.DB, session.id, crateType);
  if (!spent) {
    return jsonError(`no ${crateType} keys available`, 409);
  }

  const chain = [];
  for (let i = 0; i < MAX_CHAIN_LENGTH; i++) {
    const ctx = await getRollContext(env.DB, session.id, crateType);
    const pool = eligiblePool(crateType, ctx);
    const rarity = rollFromPool(pool);
    const prize = RARITY_PRIZE[rarity];

    const outcome = await recordSpin(env.DB, {
      userId: session.id,
      crateType,
      rarity,
      prizeId: prize.id,
      prizeName: prize.name,
    });

    chain.push({
      rarity,
      prizeId: prize.id,
      prizeName: prize.name,
      redemptionCode: outcome.redemptionCode,
      rareKeyGranted: outcome.rareKeyGranted,
      legendaryClaimed: outcome.legendaryClaimed,
    });

    if (rarity !== "uncommon") break; // only Uncommon chains a free respin
  }

  const user = await getUserById(env.DB, session.id);
  return json({
    crateType,
    chain,
    keys: user.keys,
    rareKeys: user.rare_keys,
  });
}

/**
 * POST /api/redeem { code: string }
 * @param {Request} request @param {Env} env
 */
export async function handleRedeem(request, env) {
  const session = await getSessionUser(request, env);
  if (!session) return jsonError("not authenticated", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return jsonError("code is required", 400);

  const result = await redeemCode(env.DB, session.id, code);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return jsonError(result.reason, status);
  }

  return json({ ok: true, prizeId: result.prizeId, prizeName: result.prizeName });
}
