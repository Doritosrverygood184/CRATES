// src/lib/auth.js
// HMAC-SHA256 signed session tokens, stored in HttpOnly cookies.
//
// Player sessions and admin sessions are signed with different secrets
// (SESSION_SECRET vs ADMIN_SESSION_SECRET) and stored under different
// cookie names, so a leaked player cookie can never be replayed as an
// admin cookie or vice versa — they're not just different payloads, they
// don't even verify against the same key.
//
// Token shape: base64url(json payload) + "." + base64url(hmac signature)
// Payload always carries an `exp` (unix seconds) checked on every verify.

import { base64UrlEncode, base64UrlDecode, base64UrlDecodeToString, constantTimeEqual } from "./util.js";

export const PLAYER_COOKIE_NAME = "crate_session";
export const ADMIN_COOKIE_NAME = "crate_admin_session";

const PLAYER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours — shorter-lived, higher privilege

/** @param {string} secret @returns {Promise<CryptoKey>} */
async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Sign an arbitrary JSON-serializable payload into a session token.
 * @param {Record<string, unknown>} payload
 * @param {string} secret
 * @param {number} ttlSeconds
 */
async function signSession(payload, secret, ttlSeconds) {
  const fullPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncode(signature);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify and decode a session token. Returns null on any failure —
 * malformed token, bad signature, or expiry — never throws, since a
 * forged/corrupt cookie is an expected input, not an exceptional one.
 * @param {string | undefined | null} token
 * @param {string} secret
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function verifySession(token, secret) {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let expectedSig;
  try {
    const key = await importHmacKey(secret);
    expectedSig = base64UrlEncode(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64))
    );
  } catch {
    return null;
  }

  if (!constantTimeEqual(expectedSig, sigB64)) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

/** @param {{id: string, username: string}} user @param {string} secret */
export function createPlayerSession(user, secret) {
  return signSession({ sub: user.id, username: user.username }, secret, PLAYER_SESSION_TTL_SECONDS);
}

/** @param {string | undefined | null} token @param {string} secret */
export function verifyPlayerSession(token, secret) {
  return verifySession(token, secret);
}

/** @param {string} secret */
export function createAdminSession(secret) {
  return signSession({ role: "admin" }, secret, ADMIN_SESSION_TTL_SECONDS);
}

/** @param {string | undefined | null} token @param {string} secret */
export async function verifyAdminSession(token, secret) {
  const payload = await verifySession(token, secret);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

export { PLAYER_SESSION_TTL_SECONDS, ADMIN_SESSION_TTL_SECONDS };
