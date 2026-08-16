// src/routes/admin.js
// Admin panel API. Auth here is deliberately separate from player auth:
// a single shared password (ADMIN_PASSWORD) checked in constant time,
// producing a session signed with ADMIN_SESSION_SECRET and stored under
// a different cookie name. Nothing here trusts a Discord login — an admin
// and a player session are unrelated credentials even for the same human.

import { createAdminSession, verifyAdminSession, ADMIN_COOKIE_NAME } from "../lib/auth.js";
import { parseCookies, serializeCookie, expireCookie, json, jsonError, constantTimeEqual } from "../lib/util.js";
import { searchUsersByUsername, grantKeys, getAdminGrantLog } from "../lib/db.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../lib/auth.js";

/**
 * @param {Request} request @param {Env} env
 * @returns {Promise<boolean>}
 */
async function isAdminAuthenticated(request, env) {
  const cookies = parseCookies(request);
  const payload = await verifyAdminSession(cookies[ADMIN_COOKIE_NAME], env.ADMIN_SESSION_SECRET);
  return payload !== null;
}

/**
 * POST /api/admin/login { password: string }
 * @param {Request} request @param {Env} env
 */
export async function handleAdminLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const password = typeof body?.password === "string" ? body.password : "";
  if (!password || !constantTimeEqual(password, env.ADMIN_PASSWORD)) {
    // Deliberately generic message and no distinction between "wrong
    // password" and "malformed request" — don't help an attacker probe.
    return jsonError("invalid password", 401);
  }

  const token = await createAdminSession(env.ADMIN_SESSION_SECRET);
  return json(
    { ok: true },
    200,
    { "set-cookie": serializeCookie(ADMIN_COOKIE_NAME, token, { maxAgeSeconds: ADMIN_SESSION_TTL_SECONDS }) }
  );
}

/** POST /api/admin/logout */
export async function handleAdminLogout() {
  return json({ ok: true }, 200, { "set-cookie": expireCookie(ADMIN_COOKIE_NAME) });
}

/**
 * GET /api/admin/search?username=<query>
 * @param {Request} request @param {Env} env
 */
export async function handleAdminSearch(request, env) {
  if (!(await isAdminAuthenticated(request, env))) return jsonError("not authenticated", 401);

  const url = new URL(request.url);
  const query = (url.searchParams.get("username") || "").trim();
  if (query.length < 2) {
    return jsonError("username query must be at least 2 characters", 400);
  }

  const users = await searchUsersByUsername(env.DB, query);
  return json({ users });
}

/**
 * POST /api/admin/grant { userId: string, keys?: number, rareKeys?: number, note?: string }
 * @param {Request} request @param {Env} env
 */
export async function handleAdminGrant(request, env) {
  if (!(await isAdminAuthenticated(request, env))) return jsonError("not authenticated", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const userId = typeof body?.userId === "string" ? body.userId : "";
  const keys = Number.isInteger(body?.keys) ? body.keys : 0;
  const rareKeys = Number.isInteger(body?.rareKeys) ? body.rareKeys : 0;
  const note = typeof body?.note === "string" ? body.note.slice(0, 280) : undefined;

  if (!userId) return jsonError("userId is required", 400);
  if (keys === 0 && rareKeys === 0) return jsonError("must grant at least one key", 400);
  if (keys < 0 || rareKeys < 0) return jsonError("grant amounts must be non-negative", 400);
  if (keys > 1000 || rareKeys > 1000) return jsonError("grant amount too large — check the number", 400);

  const result = await grantKeys(env.DB, { targetUserId: userId, keys, rareKeys, note });
  if (!result.ok) return jsonError(result.reason, 404);

  return json({ ok: true });
}

/**
 * GET /api/admin/log
 * @param {Request} request @param {Env} env
 */
export async function handleAdminLog(request, env) {
  if (!(await isAdminAuthenticated(request, env))) return jsonError("not authenticated", 401);
  const grants = await getAdminGrantLog(env.DB, 100);
  return json({ grants });
}
