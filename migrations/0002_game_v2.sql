-- 0002_game_v2.sql
-- Adds per-crate spin tracking (last rarity, open counts, hidden pity)
-- and a single global row that locks Legendary to one winner ever,
-- across both crates and all players.

ALTER TABLE users ADD COLUMN standard_opens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN rare_opens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN standard_last_rarity TEXT;
ALTER TABLE users ADD COLUMN rare_last_rarity TEXT;

-- Hidden pity: set once a user's first two Standard Crate spins are both
-- Common. Never exposed to the client -- routes/api.js reads it only to
-- feed lib/game.js#eligiblePool.
ALTER TABLE users ADD COLUMN pity_rare_active INTEGER NOT NULL DEFAULT 0;

-- JSON array of the first up-to-two Standard Crate rarities this user
-- has rolled, used only to decide whether to flip pity_rare_active.
ALTER TABLE users ADD COLUMN standard_first_two TEXT NOT NULL DEFAULT '[]';

-- Single-row table (id is CHECK'd to 1) tracking the one-ever Legendary
-- win, global across every player and both crate types.
CREATE TABLE IF NOT EXISTS game_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  legendary_won     INTEGER NOT NULL DEFAULT 0,
  legendary_won_by  TEXT,
  legendary_won_at  TEXT
);

INSERT OR IGNORE INTO game_state (id, legendary_won) VALUES (1, 0);
