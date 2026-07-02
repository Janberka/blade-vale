-- Blade Vale — server-authoritative world generation, Phase 1: the chunk store.
-- The server now GENERATES AND PERSISTS terrain chunks (via the shared kernel sim/terra.js) and
-- serves them to clients; a chunk is generated at most once and lives forever. Terrain is keyed by
-- tseed = ((map_level*1000+7) ^ (universe_seed*2654435761))>>>0 — the client's exact worldSeed()
-- formula — NOT by world row, so one world row (careers/economy) spans every universe the player
-- rerolls and every region they conquer into.

-- worlds carry the player's CURRENT universe pointer (the background tick contests THAT terrain)
ALTER TABLE worlds ADD COLUMN universe_seed INTEGER;
UPDATE worlds SET universe_seed = 1369698317 WHERE kind = 'shared';   -- 0x51A3F00D, fixed for all

-- the chunk store: payload = gzip(JSON) of per-vertex terrain fields + settlement identity.
-- version = Terra.VERSION at generation time (payloads are never silently regenerated).
CREATE TABLE chunks (
  world_id        INTEGER NOT NULL REFERENCES worlds(id),
  tseed           INTEGER NOT NULL,
  cx              INTEGER NOT NULL,
  cz              INTEGER NOT NULL,
  version         INTEGER NOT NULL,
  payload         BLOB NOT NULL,
  generated_tick  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, tseed, cx, cz)
);

-- holds gain the tseed dimension. Shared-world rows keep their ownership history under the shared
-- terrain seed (2275024391 = the client's worldSeed at mapLevel 0). Solo rows are DROPPED: they
-- were generated with a seed formula (^0x9E3779B9) that never matched any client's terrain, so
-- they point at settlements no player ever saw. (Their positions also predate land-reseating —
-- surviving shared rows get their x,z corrected on first chunk generation, siteKey unchanged.)
CREATE TABLE holds_new (
  id              INTEGER PRIMARY KEY,
  world_id        INTEGER NOT NULL REFERENCES worlds(id),
  tseed           INTEGER NOT NULL,
  cx              INTEGER NOT NULL,
  cz              INTEGER NOT NULL,
  idx             INTEGER NOT NULL,
  name            TEXT NOT NULL,
  tier            TEXT NOT NULL DEFAULT 'village',
  x               REAL NOT NULL,
  z               REAL NOT NULL,
  owner_name      TEXT NOT NULL,
  garrison        INTEGER NOT NULL DEFAULT 0,
  generated_tick  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (world_id, tseed, cx, cz, idx)
);
INSERT INTO holds_new (world_id, tseed, cx, cz, idx, name, tier, x, z, owner_name, garrison, generated_tick)
  SELECT h.world_id, 2275024391, h.cx, h.cz, h.idx, h.name, h.tier, h.x, h.z, h.owner_name, h.garrison, h.generated_tick
  FROM holds h JOIN worlds w ON w.id = h.world_id
  WHERE w.kind = 'shared';
DROP TABLE holds;
ALTER TABLE holds_new RENAME TO holds;
CREATE INDEX ix_holds_world ON holds(world_id, tseed);
CREATE INDEX ix_holds_world_pos ON holds(world_id, tseed, x, z);

-- the chunks table IS the generated-ground ledger now; the old per-chunk ledger goes away
DROP TABLE hold_regions;
