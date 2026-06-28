-- Blade Vale — Destiny engine (Step 7). A fated arc per character + a world-level "age".
-- Chronicle-only: these columns are read by the destiny engine and the client view; nothing in
-- combat / marching / conquest / diplomacy reads them. Forward-only (applied by db.js migrate()).

ALTER TABLE warlords   ADD COLUMN destiny TEXT;
ALTER TABLE warlords   ADD COLUMN fate REAL DEFAULT 0;
ALTER TABLE warlords   ADD COLUMN destiny_tick INTEGER DEFAULT 0;

ALTER TABLE characters ADD COLUMN destiny TEXT;
ALTER TABLE characters ADD COLUMN fate REAL DEFAULT 0;
ALTER TABLE characters ADD COLUMN destiny_tick INTEGER DEFAULT 0;

-- the global world destiny: one row per world (the current "age" the whole population bends toward)
CREATE TABLE IF NOT EXISTS world_destiny (
  world_id INTEGER PRIMARY KEY,
  age      TEXT,
  prophecy TEXT,
  momentum REAL    DEFAULT 0,
  age_tick INTEGER DEFAULT 0
);
