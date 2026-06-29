-- Blade Vale — Step 8: player town management (server-backed living economy).
-- One row per player-owned hold: a streamed settlement keyed by the client's siteKey
-- ("cx,cz,idx"), or one of the five capitals via the synthetic key "cap:<idx>". The server
-- advances production + population growth on the world tick (offline catch-up included), and
-- the client opens a management overlay at any owned hold to build farms / lumber camps /
-- watchtowers / houses and assign people to jobs.
--
-- The authoritative owner-of-record stays in `capitals` (and the client's heldOwners map);
-- holdings.owner_name only MIRRORS it so the tick knows whether to keep crediting the player.
-- A fresh CREATE TABLE (no ALTER), so unixepoch() defaults are fine here.

CREATE TABLE holdings (
  id             INTEGER PRIMARY KEY,
  world_id       INTEGER NOT NULL REFERENCES worlds(id),
  hold_key       TEXT NOT NULL,                    -- "cx,cz,idx" (settlement siteKey) | "cap:<idx>" (capital)
  owner_name     TEXT NOT NULL,                    -- 'Your Banner' while held by the player; NPC faction after loss
  def_name       TEXT NOT NULL,                    -- display name
  tier           TEXT NOT NULL DEFAULT 'village',  -- village | town | city | capital
  x              REAL NOT NULL DEFAULT 0,          -- map coords (context / Phase 2 walkable town)
  z              REAL NOT NULL DEFAULT 0,
  food           REAL NOT NULL DEFAULT 0,          -- accumulated food stock
  wood           REAL NOT NULL DEFAULT 0,          -- accumulated wood stock
  population     REAL NOT NULL DEFAULT 0,          -- current population (grows on food surplus, shrinks on deficit)
  buildings_json TEXT NOT NULL DEFAULT '{}',       -- { farm, lumber, watchtower, houses } -> level (0 = unbuilt)
  jobs_json      TEXT NOT NULL DEFAULT '{}',       -- { farm, lumber, idle } -> population assigned (sum <= population)
  founded_tick   INTEGER NOT NULL DEFAULT 0,       -- sim_tick the player claimed it (economy start)
  last_econ_tick INTEGER NOT NULL DEFAULT 0,       -- last tick production was applied (catch-up anchor)
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (world_id, hold_key)
);
CREATE INDEX ix_holdings_world ON holdings(world_id, owner_name);
