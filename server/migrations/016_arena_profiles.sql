-- Blade Vale — PROFILES + THE LADDER: a record for every fighter, player or NPC, and the per-fight ledger
-- both draw on. Mirrors the worker/schema.sql block of the same name (the Node server is local dev only).

ALTER TABLE arena_careers ADD COLUMN renown INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_careers_renown ON arena_careers(renown DESC);
-- a first renown for the rows already there (skills left out — the next fight recomputes exactly)
UPDATE arena_careers SET renown = xp + 25 * wins + 5 * MAX(0, matches - wins) + 60 * stars + 3 * kills + 6 * trophies + damage / 100;
CREATE TABLE IF NOT EXISTS npc_careers (
  name TEXT PRIMARY KEY,
  arch TEXT NOT NULL DEFAULT 'swordsman',   -- the archetype he fought as last
  archs_json TEXT NOT NULL DEFAULT '{}',    -- {archetype: fights}
  skill INTEGER NOT NULL DEFAULT 50,        -- the lobby XP (0-100) he last fought at
  xp INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  damage INTEGER NOT NULL DEFAULT 0,
  stars INTEGER NOT NULL DEFAULT 0,
  renown INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS ix_npc_renown ON npc_careers(renown DESC);
CREATE TABLE IF NOT EXISTS arena_bouts (
  seed TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- 'player' | 'npc'
  fighter TEXT NOT NULL,                    -- the handle / the NPC's name
  team INTEGER NOT NULL DEFAULT 0,
  won INTEGER NOT NULL DEFAULT 0,
  draw INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  dmg INTEGER NOT NULL DEFAULT 0,
  alive INTEGER NOT NULL DEFAULT 1,
  star INTEGER NOT NULL DEFAULT 0,
  venue TEXT,
  size INTEGER NOT NULL DEFAULT 0,          -- fighters in the pit
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (seed, kind, fighter)
);
CREATE INDEX IF NOT EXISTS ix_bouts_fighter ON arena_bouts(kind, fighter, created_at DESC);
