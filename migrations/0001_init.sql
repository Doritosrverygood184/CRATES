-- 0001_init.sql
-- Initial schema for the crate system.
-- Applied via `wrangler d1 migrations apply DB --local|--remote`.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,        -- Discord snowflake user id
  username      TEXT NOT NULL,           -- Discord username (global_name || username)
  avatar_url    TEXT,                    -- resolved CDN avatar URL, nullable
  keys          INTEGER NOT NULL DEFAULT 0,      -- Standard crate keys
  rare_keys     INTEGER NOT NULL DEFAULT 0,      -- Rare crate keys
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- Every spin, win or lose, is recorded here. This is the audit trail the
-- anti-cheat model depends on: the row is written by the server in the
-- same request that decided the outcome, so client and server can never
-- disagree about what happened.
CREATE TABLE IF NOT EXISTS spins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  crate_type    TEXT NOT NULL CHECK (crate_type IN ('standard', 'rare')),
  rarity        TEXT NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  prize_id      TEXT NOT NULL,           -- key into the static prize catalog in lib/game.js
  prize_name    TEXT NOT NULL,           -- denormalized for cheap history reads / redemption UI
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spins_user ON spins (user_id, created_at DESC);

-- One-time redemption codes for Epic/Legendary prizes. A spin that lands
-- Epic or Legendary gets a row here at spin time (unredeemed); redeeming
-- just flips redeemed_at, it never mints a new code.
CREATE TABLE IF NOT EXISTS redemptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  spin_id       INTEGER NOT NULL UNIQUE REFERENCES spins(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  code          TEXT NOT NULL UNIQUE,    -- e.g. CRATE-XXXX-XXXX-XXXX
  prize_id      TEXT NOT NULL,
  prize_name    TEXT NOT NULL,
  redeemed_at   TEXT                     -- NULL until claimed
);

CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions (user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_code ON redemptions (code);

-- Every admin grant is logged: who granted, to whom, how many keys of
-- each type, and when. Surfaced read-only in the admin panel.
CREATE TABLE IF NOT EXISTS admin_grants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  target_user_id    TEXT NOT NULL REFERENCES users(id),
  target_username   TEXT NOT NULL,
  keys_granted      INTEGER NOT NULL DEFAULT 0,
  rare_keys_granted INTEGER NOT NULL DEFAULT 0,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_grants_target ON admin_grants (target_user_id);
