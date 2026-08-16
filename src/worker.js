// src/worker.js
// Entry point. Routes /auth/* and /api/* to their handlers; everything
// else falls through to the static files in ./public via env.ASSETS.
//
// Env bindings (see wrangler.toml + README "Set secrets"):
//   DB                    D1Database  — [[d1_databases]] binding
//   ASSETS                Fetcher     — [assets] binding, serves ./public
//   DISCORD_CLIENT_ID     string      — secret
//   DISCORD_CLIENT_SECRET string      — secret
//   SESSION_SECRET        string      — secret, signs player session cookies
//   ADMIN_SESSION_SECRET  string      — secret, signs admin session cookies
//   ADMIN_PASSWORD        string      — secret, /admin.html password
//   PUBLIC_BASE_URL       string      — var, e.g. https://crate-system.<sub>.workers.dev

import { handleDiscordLogin, handleDiscordCallback, handleLogout } from "./routes/auth.js";
import { handleMe, handleSpin, handleRedeem } from "./routes/api.js";
import {
  handleAdminLogin,
  handleAdminLogout,
  handleAdminSearch,
  handleAdminGrant,
  handleAdminLog,
} from "./routes/admin.js";
import { jsonError } from "./lib/util.js";

/**
 * @typedef {Object} Env
 * @property {D1Database} DB
 * @property {Fetcher} ASSETS
 * @property {string} DISCORD_CLIENT_ID
 * @property {string} DISCORD_CLIENT_SECRET
 * @property {string} SESSION_SECRET
 * @property {string} ADMIN_SESSION_SECRET
 * @property {string} ADMIN_PASSWORD
 * @property {string} PUBLIC_BASE_URL
 */

/** Route table: [method, path, handler]. Path matches exactly (no wildcards needed at this scale). */
const ROUTES = [
  ["GET", "/auth/discord/login", handleDiscordLogin],
  ["GET", "/auth/discord/callback", handleDiscordCallback],
  ["POST", "/auth/discord/logout", handleLogout],

  ["GET", "/api/me", handleMe],
  ["POST", "/api/spin", handleSpin],
  ["POST", "/api/redeem", handleRedeem],

  ["POST", "/api/admin/login", handleAdminLogin],
  ["POST", "/api/admin/logout", handleAdminLogout],
  ["GET", "/api/admin/search", handleAdminSearch],
  ["POST", "/api/admin/grant", handleAdminGrant],
  ["GET", "/api/admin/log", handleAdminLog],
];

export default {
  /**
   * @param {Request} request @param {Env} env @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    for (const [method, path, handler] of ROUTES) {
      if (request.method === method && url.pathname === path) {
        try {
          return await handler(request, env, ctx);
        } catch (err) {
          console.error(`unhandled error in ${method} ${path}`, err);
          return jsonError("internal server error", 500);
        }
      }
    }

    // /api/* and /auth/* with no matching route -> 404 JSON, not the SPA.
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return jsonError("not found", 404);
    }

    // Everything else: static assets (index.html, app.js, admin.html, ...).
    return env.ASSETS.fetch(request);
  },
};
