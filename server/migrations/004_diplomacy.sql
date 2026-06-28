-- Blade Vale — Step 6: the diplomacy + intent engine.
-- Factions hold an evolving relationship (opinion → stance), leaders carry a personality and a
-- loyalty to the flag they serve, and a group's intent is derived from its leader. The math lives
-- in sim/world-sim.js (shared, deterministic); this schema is the persisted STATE the server owns.
--
-- Relations are SYMMETRIC and stored canonically (faction_a < faction_b, string compare) so there
-- is exactly one row per unordered pair — no A→B / B→A divergence. 6 factions (5 nations + the
-- player's 'Your Banner') ⇒ C(6,2) = 15 relation rows, 6 faction_state rows.
--
-- ALTER ... ADD COLUMN defaults must be CONSTANT (SQLite); the non-constant seeds (per-warlord
-- personality, per-pair opening opinions) are written in code by seedDiplomacy().

CREATE TABLE faction_relations (
  id INTEGER PRIMARY KEY,
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  faction_a TEXT NOT NULL,                  -- canonical: faction_a < faction_b
  faction_b TEXT NOT NULL,
  opinion REAL NOT NULL DEFAULT 0,          -- -100..100
  stance TEXT NOT NULL DEFAULT 'neutral',   -- war | hostile | neutral | nonaggression | alliance
  truce_until INTEGER NOT NULL DEFAULT 0,   -- sim_tick a forced truce holds until (0 = none)
  last_change_tick INTEGER NOT NULL DEFAULT 0,
  UNIQUE (world_id, faction_a, faction_b)
);
CREATE INDEX ix_frel_world ON faction_relations(world_id);

CREATE TABLE faction_state (
  id INTEGER PRIMARY KEY,
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  faction TEXT NOT NULL,
  posture TEXT NOT NULL DEFAULT 'consolidate',  -- expand | consolidate | defend | desperate
  war_weariness REAL NOT NULL DEFAULT 0,        -- 0..100, climbs at war, decays in peace
  power REAL NOT NULL DEFAULT 0,                 -- cached strength (capitals + army power)
  alive INTEGER NOT NULL DEFAULT 1,             -- 0 once collapsed (no capitals, no warlords)
  collapsed_tick INTEGER,
  UNIQUE (world_id, faction)
);
CREATE INDEX ix_fstate_world ON faction_state(world_id);

-- per-warlord personality + dynamic loyalty / intent / grudge (constant defaults; seeded in code)
ALTER TABLE warlords ADD COLUMN personality_json TEXT NOT NULL DEFAULT '{}';  -- {ambition,caution,loyalty,vengeance} 0..1
ALTER TABLE warlords ADD COLUMN loyalty REAL NOT NULL DEFAULT 70;             -- 0..100 toward current `faction`
ALTER TABLE warlords ADD COLUMN intent TEXT NOT NULL DEFAULT 'muster';        -- conquer|raid|hunt|defend|muster|defect|escort
ALTER TABLE warlords ADD COLUMN intent_target_kind TEXT;                      -- 'army'|'capital'|'point'|null
ALTER TABLE warlords ADD COLUMN intent_target_id INTEGER;                     -- warlord.id or capitals.idx, by kind
ALTER TABLE warlords ADD COLUMN grudge_faction TEXT;                          -- nation this warlord hates (or null)
ALTER TABLE warlords ADD COLUMN grudge_leader INTEGER;                        -- specific warlord.id (or null)

-- mirror personality/loyalty onto the player-facing character rows so a recruited defector keeps
-- identity through the careers save/load path; the existing cosmetic `trait` stays.
ALTER TABLE characters ADD COLUMN personality_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE characters ADD COLUMN loyalty REAL NOT NULL DEFAULT 80;
ALTER TABLE characters ADD COLUMN home_faction TEXT;   -- nation of origin, for defection lore
