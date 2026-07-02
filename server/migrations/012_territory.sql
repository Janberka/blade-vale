-- Blade Vale — the political TERRITORY field (the map's border heat-map layer).
-- Per chunk, per logical hex cell: which faction's influence dominates and how decisively —
-- computed by the shared kernel (WorldSim.territoryCell) from LIVE ownership (capitals + holds
-- + marching warlords + present players), persisted here, and served at GET /api/v1/territory.
-- src_hash fingerprints the sources that fed a row; when ownership shifts or an army marches
-- through, the hash misses and the row is regenerated — real-time borders, stored truth.
CREATE TABLE territory (
  world_id        INTEGER NOT NULL REFERENCES worlds(id),
  tseed           INTEGER NOT NULL,
  cx              INTEGER NOT NULL,
  cz              INTEGER NOT NULL,
  version         INTEGER NOT NULL,           -- TERR_V payload shape at generation
  src_hash        TEXT NOT NULL,              -- fingerprint of the sources in reach of this chunk
  payload         BLOB NOT NULL,              -- gzip(JSON { v, cx, cz, f:[names], o:b64, s:b64 })
  updated_at      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, tseed, cx, cz)
);
