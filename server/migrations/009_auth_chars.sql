-- Blade Vale — simple username/password auth + multiple player characters per account.
-- An account may field several characters ON THE SAME MAP; exactly one is active (being
-- played), the rest wait where they were left. Men can be moved between an account's own
-- characters (give) or split off under a brand-new character.

ALTER TABLE accounts ADD COLUMN pass_salt TEXT;
ALTER TABLE accounts ADD COLUMN pass_hash TEXT;

-- bearer sessions: the login endpoint mints a random token, every request presents it
-- via the existing X-Player-Token seam (legacy passwordless handles keep working as-is)
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX ix_sessions_acct ON sessions(account_id);

-- an account's characters in a given world (map). x/z = where the character stands
-- (live-updated by presence for the active one; frozen where they were left for idlers).
-- men = the warband riding under that character (hero not counted).
-- state_json = opaque client bundle (hero career + roster + composition) restored on switch.
CREATE TABLE player_chars (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  world_id INTEGER NOT NULL REFERENCES worlds(id),
  name TEXT NOT NULL,
  archetype TEXT NOT NULL DEFAULT 'sword',
  x REAL NOT NULL DEFAULT 0,
  z REAL NOT NULL DEFAULT 0,
  men INTEGER NOT NULL DEFAULT 0,
  renown REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'alive',    -- alive | gone
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX ix_pchars_world ON player_chars(world_id, account_id, status);
