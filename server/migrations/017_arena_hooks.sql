-- Blade Vale — THE HOOKS (2026-09-14): personal bests, the rival, loot pity and the hook counters in one JSON blob on
-- the career; the champion's belt; the bout of the day's board. Mirrors worker/schema.sql (the Node server is local dev only).
ALTER TABLE arena_careers ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS arena_belt (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  renown INTEGER NOT NULL DEFAULT 0,
  since INTEGER NOT NULL DEFAULT (unixepoch()),
  defenses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS arena_daily (
  day TEXT NOT NULL,
  fighter TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  dmg INTEGER NOT NULL DEFAULT 0,
  alive INTEGER NOT NULL DEFAULT 0,
  won INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (day, fighter)
);
CREATE INDEX IF NOT EXISTS ix_daily_board ON arena_daily(day, score DESC);
