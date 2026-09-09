-- Blade Vale — initial schema (Step 3): persist named-character careers.
-- MP-forward shape: every row is scoped by world_id + owner_account, and `controller`
-- separates the player's hero from AI-run soldiers, so the single-player build extends
-- to a shared world without query changes. The always-on world tables (armies, capitals,
-- battles) arrive in a later migration.

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE worlds (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  seed INTEGER NOT NULL,
  map_level INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- one row per character: the player's hero (is_player=1) + every warband soldier.
CREATE TABLE characters (
  id INTEGER PRIMARY KEY,
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  owner_account INTEGER REFERENCES accounts(id),
  client_id INTEGER,                 -- the in-game char id, for client reconciliation
  name TEXT NOT NULL,
  archetype TEXT NOT NULL DEFAULT 'sword',
  is_player INTEGER NOT NULL DEFAULT 0,
  controller TEXT NOT NULL DEFAULT 'ai',   -- player | ai
  trait TEXT,
  skills_json TEXT NOT NULL DEFAULT '{}',  -- {strike,guard,lead,aim} raw accumulators
  xp INTEGER NOT NULL DEFAULT 0,
  renown REAL NOT NULL DEFAULT 0,
  popularity REAL NOT NULL DEFAULT 0,
  rank TEXT NOT NULL DEFAULT 'Recruit',
  kills INTEGER NOT NULL DEFAULT 0,
  battles INTEGER NOT NULL DEFAULT 0,
  battles_led INTEGER NOT NULL DEFAULT 0,
  battles_won INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  notability INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'alive',     -- alive | gone (fallen/disbanded)
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (world_id, client_id)
);
CREATE INDEX ix_char_world ON characters(world_id, status);

-- append-only chronicle of notable deeds — the durable "it should be recorded" log
CREATE TABLE deeds (
  id INTEGER PRIMARY KEY,
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  tick INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,                -- kill | battle_won | leader_fell | promotion
  actor TEXT,
  target TEXT,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX ix_deeds_world ON deeds(world_id, id);
