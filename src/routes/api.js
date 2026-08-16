// src/routes/api.js
// Player-facing API. Every handler here starts by resolving the session —
// there is no route in this file a logged-out request can do anything
// with beyond getting a 401.

import { verifyPlayerSession, PLAYER_COOKIE_NAME } from "../lib/auth.js";
import { parseCookies, json, jsonError } from "../lib/util.js";
import { spendKey, recordSpin, getRecentSpins, getRedemptionsForUser, redeemCode, getUserById } from "../lib/db.js";
import { rollPrize, isValidCrateType } from "../lib/game.js";

/**
 * Resolve the authenticated player from the request's session cookie.
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
 * GET /api/me — current player profile, key balances, recent history and
 * outstanding redemption codes. The dashboard's single data source.
 * @param {Request} request @param {Env} env
 */
export async function handleMe(request, env) {
  const session = await getSessionUser(request, env);
  if (!session) return jsonError("not authenticated", 401);

  const user = await getUserById(env.DB, session.id);
  if (!user) return jsonError("account not found", 404);

  const [history, redemptions] = await Promise.all([
    getRecentSpins(env.DB, session.id, 25),
    getRedemptionsForUser(env.DB, session.id),
  ]);

  return json({
    id: user.id,
    username: user.username,
    avatarUrl: user.avatar_url,
    keys: user.keys,
    rareKeys: user.rare_keys,
    history,
    redemptions,
  });
}

/**
 * POST /api/spin { crateType: 'standard' | 'rare' }
 *
 * The entire anti-cheat contract lives in this handler's ordering:
 *   1. spend the key atomically (fails closed if none available)
 *   2. only then roll the outcome server-side
 *   3. only then persist + respond
 * The client receives a prize it had zero part in generating; the reel
 * animation it plays afterward is cosmetic playback of this response.
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

  const { rarity, prizeId, prizeName } = rollPrize(crateType);
  const { redemptionCode } = await recordSpin(env.DB, {
    userId: session.id,
    crateType,
    rarity,
    prizeId,
    prizeName,
  });

  return json({ crateType, rarity, prizeId, prizeName, redemptionCode });
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
