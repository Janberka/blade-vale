-- Blade Vale — Step 4: the always-on macro world.
-- The server owns the strategic truth between sessions: who holds each capital and which
-- named warlords are rising or falling. It advances over real time (including while the
-- player is offline) and the client reflects it on login.

-- ALTER ... ADD COLUMN defaults must be constant, so last_tick_at is set in code, not unixepoch().
ALTER TABLE worlds ADD COLUMN sim_tick INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worlds ADD COLUMN last_tick_at INTEGER NOT NULL DEFAULT 0;  -- real-time anchor for catch-up
ALTER TABLE worlds ADD COLUMN active_until INTEGER NOT NULL DEFAULT 0;  -- a session is live until this ts; the tick skips active worlds

CREATE TABLE capitals (
  id INTEGER PRIMARY KEY,
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  idx INTEGER NOT NULL,                  -- 0..4, matches the client's pentagon vertices
  def_name TEXT NOT NULL,                -- founding nation (Valgard, Eorland, ...)
  owner_name TEXT NOT NULL,              -- current owner nation, or 'Your Banner'
  garrison INTEGER NOT NULL DEFAULT 20,
  UNIQUE (world_id, idx)
);

CREATE TABLE warlords (
  id INTEGER PRIMARY KEY,
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  name TEXT NOT NULL,
  faction TEXT NOT NULL,
  archetype TEXT NOT NULL DEFAULT 'longsword',
  skills_json TEXT NOT NULL DEFAULT '{}',
  renown REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 20,
  kills INTEGER NOT NULL DEFAULT 0,
  battles_won INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'alive',   -- alive | fallen
  born_tick INTEGER NOT NULL DEFAULT 0,
  died_tick INTEGER
);
CREATE INDEX ix_warlords_world ON warlords(world_id, status);

CREATE TABLE world_events (
  id INTEGER PRIMARY KEY,
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,                     -- clash | capital_taken | leader_fell | warlord_rose
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX ix_wevents_world ON world_events(world_id, id);
