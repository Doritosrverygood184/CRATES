// src/lib/util.js
// Runtime: Cloudflare Workers (V8 isolate, Web Crypto / Web Streams only —
// no Node builtins). Shared helpers with no dependencies on other lib files.

/**
 * Encode a Uint8Array/ArrayBuffer/string as unpadded base64url.
 * @param {Uint8Array | ArrayBuffer | string} input
 * @returns {string}
 */
export function base64UrlEncode(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode unpadded base64url back to a Uint8Array.
 * @param {string} input
 * @returns {Uint8Array}
 */
export function base64UrlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    "="
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode a base64url payload segment as a UTF-8 string.
 * @param {string} input
 * @returns {string}
 */
export function base64UrlDecodeToString(input) {
  return new TextDecoder().decode(base64UrlDecode(input));
}

/** JSON response helper. @param {unknown} data @param {number} status @param {HeadersInit} [headers] */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** @param {string} message @param {number} status */
export function jsonError(message, status = 400) {
  return json({ error: message }, status);
}

/**
 * Constant-time string comparison, byte length first (leaks length only —
 * acceptable here since code/password length isn't the secret).
 * @param {string} a @param {string} b
 */
export function constantTimeEqual(a, b) {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

/**
 * Parse a Cookie request header into a name -> value map.
 * @param {Request} request
 * @returns {Record<string,string>}
 */
export function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  /** @type {Record<string,string>} */
  const out = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    out[name] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Build a Set-Cookie header value.
 * @param {string} name @param {string} value
 * @param {{maxAgeSeconds?: number, path?: string, httpOnly?: boolean, secure?: boolean, sameSite?: 'Lax'|'Strict'|'None'}} [opts]
 */
export function serializeCookie(name, value, opts = {}) {
  const {
    maxAgeSeconds,
    path = "/",
    httpOnly = true,
    secure = true,
    sameSite = "Lax",
  } = opts;
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) cookie += "; HttpOnly";
  if (secure) cookie += "; Secure";
  if (typeof maxAgeSeconds === "number") cookie += `; Max-Age=${maxAgeSeconds}`;
  return cookie;
}

/** Cookie header that immediately expires a cookie. @param {string} name @param {string} [path] */
export function expireCookie(name, path = "/") {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Generate a cryptographically random one-time redemption code, formatted
 * for humans to read back over chat/email: CRATE-XXXX-XXXX-XXXX.
 * Uses crypto.getRandomValues — the same RNG the game rolls with — never
 * Math.random.
 */
export function generateRedemptionCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  const groups = [];
  for (let g = 0; g < 3; g++) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    let group = "";
    for (let i = 0; i < 4; i++) group += alphabet[bytes[i] % alphabet.length];
    groups.push(group);
  }
  return `CRATE-${groups.join("-")}`;
}

/**
 * Generate a random hex string using crypto.getRandomValues, for OAuth
 * `state` and similar CSRF-protection tokens.
 * @param {number} byteLength
 */
export function randomHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
