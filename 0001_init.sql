-- Users are identified by their Discord user id. All game state lives
-- server-side; the client never holds anything authoritative.
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,       -- Discord user id
  username              TEXT NOT NULL,
  avatar                TEXT,
  keys                  INTEGER NOT NULL DEFAULT 3,
  rare_keys             INTEGER NOT NULL DEFAULT 0,
  standard_opens        INTEGER NOT NULL DEFAULT 0,
  rare_opens            INTEGER NOT NULL DEFAULT 0,
  standard_last_rarity  TEXT,
  rare_last_rarity      TEXT,
  first_two_ids         TEXT NOT NULL DEFAULT '[]',  -- hidden pity tracking, Standard Crate only
  pity_rare_active      INTEGER NOT NULL DEFAULT 0,  -- hidden — never exposed to the client
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Legendary is a single once-ever prize shared across both crates and all
-- players, so it lives in a single-row global table rather than per-user.
CREATE TABLE IF NOT EXISTS global_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  legendary_won    INTEGER NOT NULL DEFAULT 0,
  legendary_won_by TEXT,
  legendary_won_at TEXT
);
INSERT OR IGNORE INTO global_state (id, legendary_won) VALUES (1, 0);

-- Epic/Legendary wins are individually redeemable units (one code each).
CREATE TABLE IF NOT EXISTS inventory_entries (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  prize_name   TEXT NOT NULL,
  rarity       TEXT NOT NULL,
  redeemed     INTEGER NOT NULL DEFAULT 0,
  code         TEXT,
  redeemed_at  TEXT,
  won_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_entries_user ON inventory_entries(user_id);

-- Everything else (Nothing / Spin Again / Rare Crate Key) is just a running
-- counter per user — nothing to redeem there.
CREATE TABLE IF NOT EXISTS inventory_counts (
  user_id     TEXT NOT NULL REFERENCES users(id),
  prize_name  TEXT NOT NULL,
  rarity      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, prize_name)
);

-- Audit log of every admin key grant.
CREATE TABLE IF NOT EXISTS admin_grants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  keys_granted   INTEGER NOT NULL DEFAULT 0,
  rare_keys_granted INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  granted_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
