-- Blade Vale — Step 5b (refinements): positional armies + multiplayer presence + shared worlds.
-- Warlords become moving ARMIES with map positions, so the client strategic map can be a true
-- view of authoritative server state (not its own independent sim). Presence lets multiple
-- players share one world and see each other's banners.

ALTER TABLE worlds ADD COLUMN kind TEXT NOT NULL DEFAULT 'solo';   -- solo | shared

ALTER TABLE warlords ADD COLUMN x REAL NOT NULL DEFAULT 0;
ALTER TABLE warlords ADD COLUMN z REAL NOT NULL DEFAULT 0;
ALTER TABLE warlords ADD COLUMN tx REAL;   -- current march target x
ALTER TABLE warlords ADD COLUMN tz REAL;   -- current march target z

CREATE TABLE presence (
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  faction TEXT NOT NULL DEFAULT 'Your Banner',
  x REAL NOT NULL DEFAULT 0,
  z REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 1,
  renown REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, account_id)
);
CREATE INDEX ix_presence_world ON presence(world_id, updated_at);
