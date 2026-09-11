-- Blade Vale — the ARENA CAREER: one row per account. XP ranks you and unlocks the marketplace, gold buys
-- from it, trophies and stats are the permanent record; items/equipped are the loadout you ride in with.
-- arena_results makes a match's payout idempotent (the host reports once; a re-send is ignored).

CREATE TABLE IF NOT EXISTS arena_careers (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  xp INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  trophies INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  damage INTEGER NOT NULL DEFAULT 0,
  stars INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '["wood_sword"]',
  equipped_json TEXT NOT NULL DEFAULT '{"sword":"wood_sword"}',
  skills_json TEXT NOT NULL DEFAULT '{}',
  achievements_json TEXT NOT NULL DEFAULT '[]',
  last_seed TEXT,
  last_reward_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS arena_results (
  seed TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (seed, account_id)
);
