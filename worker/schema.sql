-- Blade Vale on Cloudflare — the D1 schema for Arena Fights.
-- Accounts, bearer sessions, the arena career and the idempotent payout ledger, plus a blob for the
-- open-world roster the client still POSTs. The world simulation tables of server/migrations are NOT
-- here: the living world is parked (see VISION.md) and does not run on Workers.
-- Applied by hand (wrangler d1 execute / the dashboard) — the Worker never migrates at request time.

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  pass_salt TEXT,
  pass_hash TEXT,                       -- PBKDF2-SHA256 (WebCrypto; scrypt is not available on Workers)
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS ix_sessions_acct ON sessions(account_id);
CREATE TABLE IF NOT EXISTS worlds (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id),
  seed INTEGER NOT NULL,
  map_level INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- the open-world roster (hero + warband) the client saves; kept as the JSON it sent
CREATE TABLE IF NOT EXISTS careers (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
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
  renown INTEGER NOT NULL DEFAULT 0,     -- renownOf(career): the ladder key (added 2026-09-13; on an older DB: ALTER TABLE arena_careers ADD COLUMN renown INTEGER NOT NULL DEFAULT 0)
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS ix_careers_renown ON arena_careers(renown DESC);
CREATE TABLE IF NOT EXISTS arena_results (
  seed TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (seed, account_id)
);

-- PROFILES + THE LADDER (2026-09-13). Every fighter in a pit has a record: players in arena_careers, the vale's
-- own men in npc_careers (an NPC's identity is his name — the lobby draws from a fixed pool, so "Bram" is the same
-- Bram fight after fight). arena_bouts is the per-fight ledger for both: a profile's recent fights, the
-- "your network" ladder (everyone who shared a pit with you), and the idempotency key for NPC payouts.
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
