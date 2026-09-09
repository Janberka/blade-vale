-- Blade Vale — server-authoritative world generation, the DETAIL tier ("street level").
-- The action zoom rung renders a richer version of the same ground: expanded tree stands (every
-- map tree becomes a 3-5 tree grove) plus the base scatter rows. The server generates that detail
-- with the shared kernel (Terra.chunkScatter / Terra.chunkGroves), persists it here on first
-- visit — Google-Street-style: rows exist only where someone has actually walked — and serves it
-- at GET /api/v1/chunks/detail. The client's local kernel produces byte-identical rows, so this
-- table is the SAVED canonical copy, not a correctness dependency.
CREATE TABLE chunk_detail (
  world_id        INTEGER NOT NULL REFERENCES worlds(id),
  tseed           INTEGER NOT NULL,
  cx              INTEGER NOT NULL,
  cz              INTEGER NOT NULL,
  version         INTEGER NOT NULL,           -- Terra.VERSION at generation (never silently regenerated)
  payload         BLOB NOT NULL,              -- gzip(JSON { v, kernel, cx, cz, trees, rocks, groves })
  generated_tick  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, tseed, cx, cz)
);
