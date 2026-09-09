-- Blade Vale — the living war: settlement patrols, conquest campaigns, and timed visible battles.
--
-- Patrols: every settlement fields a tier-scaled garrison ecology (a city keeps 2 large, 5 medium,
-- 10 small groups riding circuits around its walls). They are ordinary warlord rows — named
-- characters with careers — told apart by `role`, anchored by `home_*`.
--
-- Campaigns: rarely a great host calls the banners (same-realm hosts + patrols + allied realms),
-- musters, and marches to take an enemy settlement. The defender either rides to its relief or
-- leaves it to its fate. Both are first-class rows so the client can DRAW the whole arc.
--
-- Battles (sbattles): armies that meet no longer resolve instantly — they lock into a battle that
-- bleeds over ticks, so a player can watch it live (and walk up to see the lines fighting).

ALTER TABLE warlords ADD COLUMN role TEXT NOT NULL DEFAULT 'host';   -- host | patrol
ALTER TABLE warlords ADD COLUMN pclass TEXT;                          -- large | medium | small (patrols only)
ALTER TABLE warlords ADD COLUMN home_key TEXT;                        -- 'cx,cz,idx' | 'cap:idx' (patrols only)
ALTER TABLE warlords ADD COLUMN home_x REAL;
ALTER TABLE warlords ADD COLUMN home_z REAL;
CREATE INDEX ix_warlords_home ON warlords(world_id, home_key);

-- re-muster pacing: a hold that lost patrols raises replacements only so fast
ALTER TABLE holds ADD COLUMN last_muster_tick INTEGER NOT NULL DEFAULT 0;
ALTER TABLE capitals ADD COLUMN last_muster_tick INTEGER NOT NULL DEFAULT 0;

CREATE TABLE campaigns (
  id            INTEGER PRIMARY KEY,
  world_id      INTEGER NOT NULL REFERENCES worlds(id),
  faction       TEXT NOT NULL,
  leader_id     INTEGER NOT NULL,                 -- the warlord who called the banners
  target_kind   TEXT NOT NULL,                    -- hold | capital
  target_key    TEXT NOT NULL,                    -- 'cx,cz,idx' | 'cap:idx'
  target_name   TEXT NOT NULL,
  target_x      REAL NOT NULL,
  target_z      REAL NOT NULL,
  muster_x      REAL NOT NULL,
  muster_z      REAL NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'muster',   -- muster | march | siege | done
  members_json  TEXT NOT NULL DEFAULT '[]',       -- committed warlord ids (leader included)
  relief_json   TEXT NOT NULL DEFAULT '[]',       -- the defender's relief army ids
  defense       TEXT NOT NULL DEFAULT 'pending',  -- pending | relief | abandoned
  created_tick  INTEGER NOT NULL,
  stage_tick    INTEGER NOT NULL,                 -- tick of the last stage change (drives timeouts)
  done          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_campaigns_world ON campaigns(world_id, done);

CREATE TABLE sbattles (
  id            INTEGER PRIMARY KEY,
  world_id      INTEGER NOT NULL REFERENCES worlds(id),
  x             REAL NOT NULL,
  z             REAL NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'field',    -- field | siege
  big           INTEGER NOT NULL DEFAULT 0,       -- huge stakes -> the map draws a LARGE crossed-swords
  campaign_id   INTEGER,
  hold_key      TEXT,                             -- siege: the settlement at stake ('cx,cz,idx' | 'cap:idx')
  hold_name     TEXT,
  a_faction     TEXT NOT NULL,
  b_faction     TEXT NOT NULL,
  a_ids_json    TEXT NOT NULL DEFAULT '[]',       -- attacking warlord ids
  b_ids_json    TEXT NOT NULL DEFAULT '[]',       -- defending warlord ids
  b_garrison    INTEGER NOT NULL DEFAULT 0,       -- virtual walls-and-watchmen strength on side B (sieges)
  a_start       REAL NOT NULL,
  b_start       REAL NOT NULL,
  a_end         REAL NOT NULL,                    -- character-weighted outcome, fixed at creation
  b_end         REAL NOT NULL,
  a_str         REAL NOT NULL,                    -- live strengths, bled every tick (what the bar shows)
  b_str         REAL NOT NULL,
  a_wins        INTEGER NOT NULL,
  started_tick  INTEGER NOT NULL,
  ends_tick     INTEGER NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_sbattles_world ON sbattles(world_id, done);
