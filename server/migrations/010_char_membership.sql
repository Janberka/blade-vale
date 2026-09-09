-- Blade Vale — a character may RIDE INSIDE another of your parties instead of leading its own
-- banner. member_of = the leader character's id it has folded into (NULL = independent leader).
-- A member keeps its full career (name, renown, state_json) but contributes its men to the
-- leader's headcount and shows no banner of its own — until you re-split it back out with some men.
ALTER TABLE player_chars ADD COLUMN member_of INTEGER REFERENCES player_chars(id);
CREATE INDEX ix_pchars_member ON player_chars(member_of);
