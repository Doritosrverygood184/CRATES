# Crate System

A crate-opening game with two crate types (Standard / Rare), Discord login,
server-authoritative spins (the client never rolls its own outcome — it
only animates whatever `/api/spin` already decided), redeemable Epic/
Legendary prizes with one-time codes, and a password-protected admin panel
for granting keys to specific players.

**Stack:** Cloudflare Workers (backend + static hosting) + D1 (SQLite)
+ Discord OAuth. Source lives on GitHub; a GitHub Actions workflow deploys
to Cloudflare on every push to `main`.

> GitHub Pages can only serve static files — it can't run the anti-cheat
> logic or touch a database. That's why the actual app runs on Cloudflare
> Workers; GitHub is your source control + CI/CD trigger, not the host.

## How the anti-cheat works

The reel animation is 100% cosmetic. Every spin is a `POST /api/spin`
request; the server:
1. Atomically decrements the player's key count in D1 with
   `UPDATE users SET keys = keys - 1 WHERE id = ? AND keys > 0` — this
   either succeeds (a real key was spent) or fails outright, with no
   window for a double-spend even under concurrent requests.
2. Rolls the outcome itself using `crypto.getRandomValues` (not
   `Math.random`, which is not used anywhere server-side).
3. Writes the result to D1 and returns it to the client.

The client then just plays the reel animation and lands it on whatever
rarity the server already committed to. There's no client-side code path
that can produce a win the server didn't decide.

## One-time setup

### 1. Create a Discord Application

1. Go to https://discord.com/developers/applications → **New Application**.
2. Under **OAuth2 → General**, note the **Client ID** and **Client Secret**.
3. Under **OAuth2 → Redirects**, add:
   `https://<your-worker-subdomain>.workers.dev/auth/discord/callback`
   (you'll get the exact subdomain after your first deploy — come back
   and add this once you have it, or set up a custom domain first).

### 2. Create the Cloudflare resources

```bash
npm install
npx wrangler login

# Create the D1 database
npx wrangler d1 create crate-system-db
```

Copy the `database_id` from the output into `wrangler.toml`
(`REPLACE_WITH_YOUR_D1_DATABASE_ID`).

```bash
# Apply the schema locally (for `wrangler dev`) and remotely (production)
npm run db:migrate:local
npm run db:migrate:remote
```

### 3. Set secrets

Never commit these — they're pushed straight to Cloudflare:

```bash
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET        # any long random string
npx wrangler secret put ADMIN_SESSION_SECRET  # a DIFFERENT long random string
npx wrangler secret put ADMIN_PASSWORD        # the password for /admin.html
```

Generate random strings with e.g. `openssl rand -hex 32`.

Also set `PUBLIC_BASE_URL` in `wrangler.toml` under `[vars]` (or as a
secret) once you know your deployed URL, e.g.:

```toml
[vars]
PUBLIC_BASE_URL = "https://crate-system.<your-subdomain>.workers.dev"
```

This must exactly match the redirect URI you registered with Discord in
step 1.

### 4. First manual deploy (to get your URL)

```bash
npx wrangler deploy
```

Take the resulting `*.workers.dev` URL, update `PUBLIC_BASE_URL` in
`wrangler.toml` and the Discord redirect URI to match, then redeploy:

```bash
npx wrangler deploy
```

### 5. Push to GitHub

```bash
git init
git add .
git commit -m "Initial crate system"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

### 6. Enable auto-deploy via GitHub Actions

In your GitHub repo → **Settings → Secrets and variables → Actions**,
add:

- `CLOUDFLARE_API_TOKEN` — create at
  https://dash.cloudflare.com/profile/api-tokens with the **Edit Cloudflare
  Workers** template (needs Workers Scripts + D1 edit permissions).
- `CLOUDFLARE_ACCOUNT_ID` — found on the right sidebar of your Cloudflare
  dashboard.

From then on, every push to `main` runs migrations and redeploys
automatically via `.github/workflows/deploy.yml`.

## Local development

```bash
npm run dev
```

`wrangler dev` runs the Worker + D1 locally. Discord OAuth needs a public
HTTPS callback URL, so for local testing either use a tunnel (e.g.
`cloudflared tunnel`) and a second Discord redirect URI pointed at it, or
just test the OAuth flow against your deployed environment.

## Admin panel

Visit `/admin.html` on your deployed site, enter the `ADMIN_PASSWORD` you
set above, search for a player by their Discord username, and grant Keys
or Rare Crate Keys. Every grant is logged (visible in the same panel) with
who was granted what and when.

Admin auth is completely separate from player Discord auth — it's a
single shared password, not tied to any Discord account.

## Project layout

```
src/
  worker.js          Entry point — routes /auth, /api/admin, /api, else static
  lib/
    game.js           Canonical rarity weights, pools, secure RNG — the rules
    db.js             D1 queries, including the atomic key-decrement anti-cheat
    auth.js           HMAC-signed session cookies (player + admin, separate)
    util.js           Cookies, base64url, JSON responses, constant-time compare
  routes/
    auth.js           Discord OAuth login/callback/logout
    api.js            /api/me, /api/spin, /api/redeem
    admin.js          /api/admin/* (password login, grants, audit log)
public/
  index.html, app.js  Player-facing crate UI
  admin.html, admin.js Admin panel UI
migrations/
  0001_init.sql       D1 schema
.github/workflows/
  deploy.yml          CI/CD: migrate + deploy on push to main
```

## Notes / things to consider before going live

- **Real-money prizes**: this system awards a real $10 Visa gift card and
  PetMart items. Depending on your jurisdiction, a randomized reward system
  tied to real prizes may fall under sweepstakes/prize-draw regulations —
  worth checking before opening it up publicly.
- **Rate limiting**: there's no per-user request throttling beyond the
  atomic key check. A player can't spin without a key, but nothing stops
  rapid-fire requests once they have several. Consider Cloudflare's
  built-in rate limiting rules if abuse becomes a concern.
- **Redemption fulfillment**: redeeming currently just generates and
  displays a code — it doesn't actually email/DM it or trigger fulfillment.
  You'll want to add that (e.g. log codes somewhere you monitor, or notify
  yourself via a webhook) before relying on it for real prizes.
