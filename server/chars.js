// Blade Vale — multiple characters per account, on the same map.
// Exactly one character per (account, world) is ACTIVE — the one being played; the rest
// wait on the map where they were left. The client owns the rich warband state (named
// soldiers, composition) and parks it in state_json; the server owns the numbers that
// other players see and that transfers arithmetic runs on: x/z, men, renown.
const { db } = require('./db');

const GIVE_RANGE = 30;   // two of your characters must be this close (map units) to trade men
const MAX_CHARS = 8;     // per account per world — plenty for now

function charView(r, withState) {
  const v = {
    charId: r.id, name: r.name, archetype: r.archetype, x: r.x, z: r.z,
    men: r.men, renown: r.renown, active: !!r.is_active
  };
  if (withState) v.state = JSON.parse(r.state_json || '{}');
  return v;
}
function listChars(worldId, accountId) {
  return db.prepare("SELECT * FROM player_chars WHERE world_id=? AND account_id=? AND status='alive' ORDER BY id").all(worldId, accountId);
}
function roster(worldId, accountId) { return listChars(worldId, accountId).map(r => charView(r)); }
function myChar(worldId, accountId, charId) {
  return db.prepare("SELECT * FROM player_chars WHERE id=? AND world_id=? AND account_id=? AND status='alive'").get(charId | 0, worldId, accountId);
}
function activeChar(worldId, accountId) {
  return db.prepare("SELECT * FROM player_chars WHERE world_id=? AND account_id=? AND is_active=1 AND status='alive'").get(worldId, accountId);
}
function clampName(n) { return String(n || 'A Wanderer').slice(0, 48); }
function num(v, d) { const x = +v; return Number.isFinite(x) ? x : (d || 0); }

// first contact from a logged-in client: return the roster, creating the first character
// from the client's current hero if the account has none in this world yet.
function adopt(worldId, accountId, body) {
  const have = listChars(worldId, accountId);
  const created = !have.length;
  if (created) {
    db.prepare(`INSERT INTO player_chars(account_id, world_id, name, archetype, x, z, men, renown, is_active, state_json)
      VALUES (?,?,?,?,?,?,?,?,1,?)`)
      .run(accountId, worldId, clampName(body.name), String(body.archetype || 'sword'),
        num(body.x), num(body.z), Math.max(0, body.men | 0), num(body.renown), JSON.stringify(body.state || {}));
  }
  const act = activeChar(worldId, accountId);
  return { ok: true, created, chars: roster(worldId, accountId), active: act ? charView(act, true) : null };
}

// switch play to another character. The outgoing one keeps waiting at the spot the client
// reports (its live position), with its final warband snapshot parked in state_json.
function switchChar(worldId, accountId, body) {
  const to = myChar(worldId, accountId, body.toId);
  if (!to) return { ok: false, error: 'no such character' };
  if (to.is_active) return { ok: false, error: 'already playing that character' };
  const from = activeChar(worldId, accountId);
  db.transaction(() => {
    if (from) {
      const f = body.from || {};
      db.prepare(`UPDATE player_chars SET x=?, z=?, men=?, renown=?, state_json=?, is_active=0, updated_at=unixepoch() WHERE id=?`)
        .run(num(f.x, from.x), num(f.z, from.z), Math.max(0, f.men != null ? f.men | 0 : from.men),
          num(f.renown, from.renown), JSON.stringify(f.state || JSON.parse(from.state_json || '{}')), from.id);
    }
    db.prepare('UPDATE player_chars SET is_active=1, updated_at=unixepoch() WHERE id=?').run(to.id);
  })();
  return { ok: true, active: charView(myChar(worldId, accountId, to.id), true), chars: roster(worldId, accountId) };
}

// split men off the ACTIVE character under a brand-new character, who starts waiting
// right beside it. The client removes the same men from its live warband.
function splitChar(worldId, accountId, body) {
  const from = activeChar(worldId, accountId);
  if (!from) return { ok: false, error: 'no active character' };
  if (listChars(worldId, accountId).length >= MAX_CHARS) return { ok: false, error: 'too many characters (max ' + MAX_CHARS + ')' };
  const men = body.men | 0;
  if (men < 1) return { ok: false, error: 'send at least 1 man' };
  if (men > from.men) return { ok: false, error: 'you only have ' + from.men + ' men' };
  const name = clampName(body.name);
  let created;
  db.transaction(() => {
    db.prepare('UPDATE player_chars SET men=men-?, updated_at=unixepoch() WHERE id=?').run(men, from.id);
    const r = db.prepare(`INSERT INTO player_chars(account_id, world_id, name, archetype, x, z, men, renown, is_active, state_json)
      VALUES (?,?,?,?,?,?,?,?,0,?)`)
      .run(accountId, worldId, name, String(body.archetype || 'sword'),
        num(body.x, from.x + 3), num(body.z, from.z + 3), men, 0, JSON.stringify(body.state || {}));
    created = r.lastInsertRowid;
  })();
  return { ok: true, charId: created, chars: roster(worldId, accountId) };
}

// stand up a brand-new INDEPENDENT character — a random player with their own random band
// in a random place. Unlike split, it draws nothing from the active character; the client
// rolls the name/men/position/warband and the server just records it (waiting, not active).
function createChar(worldId, accountId, body) {
  if (listChars(worldId, accountId).length >= MAX_CHARS) return { ok: false, error: 'too many characters (max ' + MAX_CHARS + ')' };
  const men = Math.max(0, Math.min(500, body.men | 0));
  let created;
  db.prepare(`INSERT INTO player_chars(account_id, world_id, name, archetype, x, z, men, renown, is_active, state_json)
    VALUES (?,?,?,?,?,?,?,?,0,?)`)
    .run(accountId, worldId, clampName(body.name), String(body.archetype || 'sword'),
      num(body.x), num(body.z), men, num(body.renown), JSON.stringify(body.state || {}));
  created = db.prepare('SELECT last_insert_rowid() id').get().id;
  return { ok: true, charId: created, chars: roster(worldId, accountId) };
}

// move men between two of your characters (either direction). They must have met on the
// map: within GIVE_RANGE of each other (the active one's position is live via presence).
function giveMen(worldId, accountId, body) {
  const from = myChar(worldId, accountId, body.fromId);
  const to = myChar(worldId, accountId, body.toId);
  if (!from || !to) return { ok: false, error: 'no such character' };
  if (from.id === to.id) return { ok: false, error: 'that is the same character' };
  const men = body.men | 0;
  if (men < 1) return { ok: false, error: 'send at least 1 man' };
  if (men > from.men) return { ok: false, error: from.name + ' only has ' + from.men + ' men' };
  const d = Math.hypot(from.x - to.x, from.z - to.z);
  if (d > GIVE_RANGE) return { ok: false, error: 'too far apart (' + Math.round(d) + ' > ' + GIVE_RANGE + ') — march them together first' };
  db.transaction(() => {
    db.prepare('UPDATE player_chars SET men=men-?, updated_at=unixepoch() WHERE id=?').run(men, from.id);
    db.prepare('UPDATE player_chars SET men=men+?, updated_at=unixepoch() WHERE id=?').run(men, to.id);
  })();
  return { ok: true, chars: roster(worldId, accountId) };
}

// presence heartbeat: keep the active character's live numbers current
function trackActive(worldId, accountId, info) {
  const act = activeChar(worldId, accountId);
  if (!act) return;
  db.prepare('UPDATE player_chars SET x=?, z=?, men=?, renown=?, name=?, updated_at=unixepoch() WHERE id=?')
    .run(num(info.x, act.x), num(info.z, act.z), info.size != null ? Math.max(0, info.size | 0) : act.men,
      num(info.renown, act.renown), clampName(info.name || act.name), act.id);
}

// other accounts' WAITING characters in this world — everyone can see them camped on the map.
// (Their active characters show through live presence instead, so no double banner.)
function idleCharsOf(worldId, exceptAccount) {
  return db.prepare(`SELECT p.*, a.handle FROM player_chars p JOIN accounts a ON a.id=p.account_id
    WHERE p.world_id=? AND p.account_id!=? AND p.is_active=0 AND p.status='alive'`)
    .all(worldId, exceptAccount == null ? -1 : exceptAccount)
    .map(r => ({ name: r.name, faction: 'Banner of ' + r.handle, x: r.x, z: r.z, size: r.men, renown: r.renown, idle: true }));
}

module.exports = { adopt, switchChar, splitChar, createChar, giveMen, trackActive, roster, idleCharsOf, GIVE_RANGE, MAX_CHARS };
