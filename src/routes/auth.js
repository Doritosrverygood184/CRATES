// src/routes/auth.js
// Discord OAuth2 (authorization code flow) for player login.
//
// Flow:
//   GET /auth/discord/login    -> redirect to Discord, state stored in a
//                                 short-lived cookie for CSRF protection
//   GET /auth/discord/callback -> exchange code, fetch profile, upsert
//                                 user, set signed session cookie
//   POST /auth/discord/logout  -> clear session cookie

import { upsertUserFromDiscord } from "../lib/db.js";
import { createPlayerSession, PLAYER_COOKIE_NAME } from "../lib/auth.js";
import { parseCookies, serializeCookie, expireCookie, randomHex, jsonError } from "../lib/util.js";

const OAUTH_STATE_COOKIE = "crate_oauth_state";
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/v10/oauth2/token";
const DISCORD_USER_URL = "https://discord.com/api/v10/users/@me";

/** @param {Env} env */
function redirectUri(env) {
  return `${env.PUBLIC_BASE_URL}/auth/discord/callback`;
}

/**
 * @param {Request} request @param {Env} env
 */
export async function handleDiscordLogin(request, env) {
  const state = randomHex(16);
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: "identify",
    state,
    prompt: "none",
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: `${DISCORD_AUTHORIZE_URL}?${params.toString()}`,
      // 10 minutes is plenty for a user to complete the Discord consent screen.
      "set-cookie": serializeCookie(OAUTH_STATE_COOKIE, state, { maxAgeSeconds: 600 }),
    },
  });
}

/**
 * @param {Request} request @param {Env} env
 */
export async function handleDiscordCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`Discord sign-in was cancelled or denied (${error}).`, { status: 400 });
  }

  const cookies = parseCookies(request);
  const expectedState = cookies[OAUTH_STATE_COOKIE];

  if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
    return jsonError("invalid or missing OAuth state — please try logging in again", 400);
  }

  // Exchange the authorization code for an access token.
  const tokenResponse = await fetch(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(env),
    }),
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text().catch(() => "");
    console.error("discord token exchange failed", tokenResponse.status, detail);
    return jsonError("failed to complete Discord sign-in", 502);
  }

  const tokenData = /** @type {{access_token: string, token_type: string}} */ (await tokenResponse.json());

  // Fetch the Discord profile with the fresh access token.
  const userResponse = await fetch(DISCORD_USER_URL, {
    headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
  });

  if (!userResponse.ok) {
    console.error("discord profile fetch failed", userResponse.status);
    return jsonError("failed to fetch Discord profile", 502);
  }

  const discordUser = /** @type {{id: string, username: string, global_name: string | null, avatar: string | null}} */ (
    await userResponse.json()
  );

  const avatarUrl = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`
    : null;

  const user = await upsertUserFromDiscord(env.DB, {
    id: discordUser.id,
    username: discordUser.global_name || discordUser.username,
    avatarUrl,
  });

  const sessionToken = await createPlayerSession({ id: user.id, username: user.username }, env.SESSION_SECRET);

  return new Response(null, {
    status: 302,
    headers: [
      ["location", "/"],
      ["set-cookie", serializeCookie(PLAYER_COOKIE_NAME, sessionToken, { maxAgeSeconds: 60 * 60 * 24 * 30 })],
      ["set-cookie", expireCookie(OAUTH_STATE_COOKIE)],
    ],
  });
}

/** @param {Request} request */
export async function handleLogout(request) {
  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "set-cookie": expireCookie(PLAYER_COOKIE_NAME),
    },
  });
}
