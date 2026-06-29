-- Blade Vale — Step 9: the server owns the WHOLE general world, not just five capitals.
-- The overworld streams in CHUNK-sized squares; each chunk's villages/towns/cities are a pure
-- function of (cx, cz, worldSeed) via the shared kernel (sim/world-sim.js). As a player navigates
-- the shared world, the server GENERATES, PERSISTS, and CONTESTS those settlements — so factions
-- fight over the frontier, not only the five capitals.
--
-- `holds` is the authoritative settlement table; its key is the SAME siteKey "cx,cz,idx" the
-- player-economy `holdings` table already uses, so ownership stays coherent between the two
-- (holds = the world's settlement; holdings = the player-economy satellite keyed by the same id).
-- `hold_regions` is a generated-chunk ledger: most chunks yield 0 settlements, so the ledger marks
-- a chunk "visited" cheaply and lets ensureRegion skip already-generated ground idempotently.

CREATE TABLE holds (
  id              INTEGER PRIMARY KEY,
  world_id        INTEGER NOT NULL REFERENCES worlds(id),
  cx              INTEGER NOT NULL,                 -- chunk coords
  cz              INTEGER NOT NULL,
  idx             INTEGER NOT NULL,                 -- 0..1 (rarely 2) within the chunk
  name            TEXT NOT NULL,                    -- display name (from the kernel)
  tier            TEXT NOT NULL DEFAULT 'village',  -- village | town | city
  x               REAL NOT NULL,                    -- map coords
  z               REAL NOT NULL,
  owner_name      TEXT NOT NULL,                    -- current political owner (nation | 'Free City' | petty realm | 'Your Banner')
  garrison        INTEGER NOT NULL DEFAULT 0,       -- defenders; an attacking host must outweigh this to flip it
  generated_tick  INTEGER NOT NULL DEFAULT 0,       -- sim_tick this hold was first generated
  UNIQUE (world_id, cx, cz, idx)
);
CREATE INDEX ix_holds_world ON holds(world_id);
CREATE INDEX ix_holds_world_pos ON holds(world_id, x, z);

CREATE TABLE hold_regions (
  world_id        INTEGER NOT NULL REFERENCES worlds(id),
  cx              INTEGER NOT NULL,
  cz              INTEGER NOT NULL,
  generated_tick  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, cx, cz)
);
