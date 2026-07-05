-- Blade Vale — patrols that walk their realm's borders.
--
-- A patrol no longer orbits the one point it spawned from. It carries a FOCUS — the settlement it is
-- currently circuiting — which the server re-picks every once in a while (focus_until). Most of the
-- time the focus is the patrol's home city and it rides that city's own borders; sometimes a roving
-- company rides out to a nearby OWNED village/castle/town, patrols it for a spell, then returns. So a
-- city's watch fans out across the whole realm it holds instead of grinding one ring at the walls.
-- home_* stays the leash anchor for defence; focus_* is the roaming circuit centre.

ALTER TABLE warlords ADD COLUMN focus_x REAL;       -- current guarded point (settlement being circuited)
ALTER TABLE warlords ADD COLUMN focus_z REAL;
ALTER TABLE warlords ADD COLUMN focus_key TEXT;     -- settlement key the focus sits on (home or a visited hold)
ALTER TABLE warlords ADD COLUMN focus_until INTEGER NOT NULL DEFAULT 0;  -- tick to re-pick a focus
