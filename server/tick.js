// Blade Vale — the always-on world tick (positional).
// Warlords are moving ARMIES on the map: they march toward rivals and enemy capitals, clash
// when they meet, and take holds — all server-authoritative, using the shared character-weighted
// resolver (sim/world-sim.js). The client renders this state as a view (dead-reckoned between
// polls). Time-driven: each advance runs the real ticks elapsed since the last (clamped), so
// sleep / restart / a week away are one code path. Presence lets players share a world.
const { db } = require('./db');
const WorldSim = require('../sim/world-sim.js');
const D = require('./diplomacy');

const TICK_SECONDS = 20;
const MAX_CATCHUP_TICKS = 300;
const ACTIVE_TTL = 90;
const PRESENCE_TTL = 30;        // a player's banner is "present" this many seconds after its last heartbeat
const MAP_HALF = 90;            // matches the client overworld half-size
const CAP_RADIUS = 48;          // capitals sit on a pentagon of this radius (same formula client-side)
const ARMY_SPEED = 6;           // map units per tick
const CLASH_RANGE = 9;
const CAP_RANGE = 8;

const NATIONS = ['Valgard', 'Eorland', 'Sunmarch', 'Mournhold', 'Frostmere'];
const GNAMES = ['Aldric','Bram','Cedwyn','Doran','Eadric','Falk','Garrec','Hale','Ivo','Joren','Kell','Lorne','Maddoc','Nael','Osric','Perrin','Roderic','Sefton','Tomas','Ulf','Varin','Wend','Yorin','Edra','Freya','Gerda','Halla','Ingrid','Kara','Linnet','Mira','Nessa','Orla','Petra','Romilda','Sigrun','Thora'];
const BYN = ['the Bold','the Grim','Ironhand','Oakheart','the Swift','Stonefist','Redmane','Hawkeye','the Tall','Wolfsbane','the Sly','Brightblade','Frostbeard','Stormcrow','the Fierce','the Quiet','Greycloak'];
function pick(a) { return a[(Math.random() * a.length) | 0]; }
function genName() { return pick(GNAMES) + (Math.random() < 0.6 ? ' ' + pick(BYN) : ''); }
function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function capPos(idx) { const a = idx / NATIONS.length * Math.PI * 2; return { x: Math.cos(a) * CAP_RADIUS, z: Math.sin(a) * CAP_RADIUS }; }
function factionCapPos(f) { const i = NATIONS.indexOf(f); return capPos(i < 0 ? 0 : i); }

function ev(worldId, tick, type, summary) { db.prepare('INSERT INTO world_events(world_id, tick, type, summary) VALUES (?,?,?,?)').run(worldId, tick, type, summary); }

function spawnWarlord(worldId, faction, tick) {
  const p = factionCapPos(faction);
  db.prepare('INSERT INTO warlords(world_id, name, faction, archetype, skills_json, renown, size, x, z, born_tick) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(worldId, genName(), faction, 'longsword', JSON.stringify({ strike: Math.random() * 14, lead: Math.random() * 6 }),
      Math.random() * 12, 12 + ((Math.random() * 20) | 0), clamp(p.x + rand(-12, 12), -MAP_HALF, MAP_HALF), clamp(p.z + rand(-12, 12), -MAP_HALF, MAP_HALF), tick || 0);
}
function seedWorld(worldId) {
  if (!db.prepare('SELECT count(*) n FROM capitals WHERE world_id=?').get(worldId).n) {
    const ins = db.prepare('INSERT INTO capitals(world_id, idx, def_name, owner_name, garrison) VALUES (?,?,?,?,?)');
    for (let i = 0; i < NATIONS.length; i++) ins.run(worldId, i, NATIONS[i], NATIONS[i], 20 + ((Math.random() * 12) | 0));
  }
  let have = db.prepare("SELECT count(*) n FROM warlords WHERE world_id=? AND status='alive'").get(worldId).n;
  for (; have < NATIONS.length * 2; have++) spawnWarlord(worldId, pick(NATIONS), 0);
  D.seedDiplomacy(worldId);   // relation matrix + faction posture (idempotent)
  db.prepare('UPDATE worlds SET last_tick_at=? WHERE id=? AND last_tick_at=0').run(Math.floor(Date.now() / 1000), worldId);
}

function band(w) { return { size: w.size, quality: 1.05, leader: { skills: JSON.parse(w.skills_json || '{}'), renown: w.renown } }; }
function doClash(worldId, tick, a, b) {
  const r = WorldSim.resolveClash(band(a), band(b), Math.random);
  const win = r.aWins ? a : b, los = r.aWins ? b : a;
  const winSize = Math.max(1, win.size - r.winnerLoss), losSize = Math.max(0, los.size - r.loserLoss);
  const winRenown = win.renown + 3 + 0.12 * los.size;
  db.prepare('UPDATE warlords SET size=?, renown=?, battles_won=battles_won+1, kills=kills+? WHERE id=?').run(winSize, winRenown, r.loserLoss, win.id);
  if (win.renown < 100 && winRenown >= 100) ev(worldId, tick, 'warlord_rose', win.name + ' of ' + win.faction + ' is now a name spoken across the vale');
  if (r.leaderFell || losSize <= 0) {
    db.prepare("UPDATE warlords SET status='fallen', died_tick=?, size=? WHERE id=?").run(tick, losSize, los.id);
    ev(worldId, tick, 'leader_fell', los.name + ' of ' + los.faction + ' fell to ' + win.name);
    if (Math.random() < 0.7) spawnWarlord(worldId, los.faction, tick);
  } else {
    db.prepare('UPDATE warlords SET size=? WHERE id=?').run(losSize, los.id);
  }
}
function nearestEnemyCap(worldId, faction, x, z, relMap) {
  const caps = db.prepare('SELECT * FROM capitals WHERE world_id=? AND owner_name!=?').all(worldId, faction);
  let best = null, bd = 1e18;
  for (const c of caps) {
    if (relMap && !WorldSim.areEnemies(D.stanceBetween(relMap, faction, c.owner_name))) continue; // only storm a hold you're at war/hostile with
    const p = capPos(c.idx); const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z); if (d < bd) { bd = d; best = { row: c, x: p.x, z: p.z, d2: d }; }
  }
  return best;
}
function nearestRival(armies, a, relMap) {
  let best = null, bd = 1e18;
  for (const o of armies) {
    if (o.id === a.id || o.faction === a.faction) continue;
    if (relMap && !WorldSim.areEnemies(D.stanceBetween(relMap, a.faction, o.faction))) continue; // allies/non-aggression are not rivals
    const d = (o.x - a.x) * (o.x - a.x) + (o.z - a.z) * (o.z - a.z); if (d < bd) { bd = d; best = o; }
  }
  return best ? { o: best, d2: bd } : null;
}
function runTick(worldId, tick) {
  const armies = db.prepare("SELECT * FROM warlords WHERE world_id=? AND status='alive'").all(worldId);
  if (armies.length < 2) { seedWorld(worldId); return; }
  const relMap = D.relationsFor(worldId);   // who is at war with whom this tick (drives every target choice)
  const upd = db.prepare('UPDATE warlords SET x=?, z=?, tx=?, tz=? WHERE id=?');
  // 1. march toward a rival, else an enemy hold, else wander
  for (const a of armies) {
    const rv = nearestRival(armies, a, relMap);
    const cap = nearestEnemyCap(worldId, a.faction, a.x, a.z, relMap);
    let tx, tz;
    if (rv && rv.d2 < 70 * 70) { tx = rv.o.x; tz = rv.o.z; }
    else if (cap) { tx = cap.x; tz = cap.z; }
    else { tx = a.x + rand(-20, 20); tz = a.z + rand(-20, 20); }
    const dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz) || 1, step = Math.min(ARMY_SPEED, d);
    a.x = clamp(a.x + dx / d * step + rand(-1, 1), -MAP_HALF, MAP_HALF);
    a.z = clamp(a.z + dz / d * step + rand(-1, 1), -MAP_HALF, MAP_HALF);
    upd.run(a.x, a.z, tx, tz, a.id);
  }
  // 2. positional clashes between rival armies that have met
  const clashed = new Set();
  for (let i = 0; i < armies.length; i++) for (let j = i + 1; j < armies.length; j++) {
    const a = armies[i], b = armies[j];
    if (!WorldSim.areEnemies(D.stanceBetween(relMap, a.faction, b.faction)) || clashed.has(a.id) || clashed.has(b.id)) continue; // allies & truces don't fight
    if ((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z) <= CLASH_RANGE * CLASH_RANGE) { clashed.add(a.id); clashed.add(b.id); doClash(worldId, tick, a, b); }
  }
  // 3. conquests: an army on an enemy hold, strong enough, takes it
  for (const a of db.prepare("SELECT * FROM warlords WHERE world_id=? AND status='alive'").all(worldId)) {
    if (clashed.has(a.id)) continue;
    const cap = nearestEnemyCap(worldId, a.faction, a.x, a.z, relMap);
    if (cap && cap.d2 <= CAP_RANGE * CAP_RANGE && a.size >= cap.row.garrison * 0.5) {
      const loser = cap.row.owner_name;
      db.prepare('UPDATE capitals SET owner_name=? WHERE id=?').run(a.faction, cap.row.id);
      db.prepare('UPDATE warlords SET renown=renown+10, size=? WHERE id=?').run(Math.max(2, a.size - Math.round(cap.row.garrison * 0.4)), a.id);
      ev(worldId, tick, 'capital_taken', a.faction + ' seized ' + cap.row.def_name + ' under ' + a.name);
      D.bumpRelation(worldId, loser, a.faction, -D.CONQUEST_SHOCK, tick); // the wronged nation seethes (may tip into war)
    }
  }
  // 4. diplomacy: drift relations + posture, then record any nation that has fallen
  D.tickDiplomacy(worldId, tick);
  D.handleCollapse(worldId, tick);
  // 5. keep the war populated — only LIVING nations march in (a fallen banner stays fallen)
  const alive = db.prepare("SELECT count(*) n FROM warlords WHERE world_id=? AND status='alive'").get(worldId).n;
  if (alive < NATIONS.length * 2 && Math.random() < 0.5) { const nat = D.aliveNations(worldId); if (nat.length) spawnWarlord(worldId, pick(nat), tick); }
}

function pruneWorld(worldId) {
  db.prepare('DELETE FROM world_events WHERE world_id=? AND id NOT IN (SELECT id FROM world_events WHERE world_id=? ORDER BY id DESC LIMIT 250)').run(worldId, worldId);
  db.prepare("DELETE FROM warlords WHERE world_id=? AND status='fallen' AND id NOT IN (SELECT id FROM warlords WHERE world_id=? AND status='fallen' ORDER BY renown DESC LIMIT 60)").run(worldId, worldId);
}
function runTicks(worldId, n) {
  if (n <= 0) return 0;
  let tick = db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(worldId).sim_tick;
  db.transaction(() => { for (let i = 0; i < n; i++) { tick++; runTick(worldId, tick); } db.prepare('UPDATE worlds SET sim_tick=? WHERE id=?').run(tick, worldId); })();
  pruneWorld(worldId);
  return n;
}
function advanceWorld(worldId) {
  seedWorld(worldId);
  const now = Math.floor(Date.now() / 1000);
  const last = db.prepare('SELECT last_tick_at FROM worlds WHERE id=?').get(worldId).last_tick_at || now;
  let ticks = Math.floor((now - last) / TICK_SECONDS);
  if (ticks <= 0) return 0;
  if (ticks > MAX_CATCHUP_TICKS) ticks = MAX_CATCHUP_TICKS;
  runTicks(worldId, ticks);
  db.prepare('UPDATE worlds SET last_tick_at=? WHERE id=?').run(last + ticks * TICK_SECONDS, worldId);
  return ticks;
}
function markActive(worldId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE worlds SET active_until=?, last_tick_at=? WHERE id=?').run(now + ACTIVE_TTL, now, worldId);
}
function isActive(worldId) { return db.prepare('SELECT active_until FROM worlds WHERE id=?').get(worldId).active_until > Math.floor(Date.now() / 1000); }
function tickInactiveWorlds() {
  const now = Math.floor(Date.now() / 1000);
  for (const w of db.prepare('SELECT id FROM worlds WHERE active_until < ?').all(now)) advanceWorld(w.id);
}
function forceTicks(worldId, n) { seedWorld(worldId); return runTicks(worldId, n); }

// ----- positional reads + multiplayer presence -----
function getArmies(worldId) {
  return db.prepare("SELECT id, name, faction, archetype, x, z, size, renown, kills, battles_won, intent, intent_target_kind, intent_target_id, loyalty, personality_json, grudge_faction FROM warlords WHERE world_id=? AND status='alive' ORDER BY id").all(worldId);
}
function getCapitals(worldId) {
  return db.prepare('SELECT idx, def_name, owner_name, garrison FROM capitals WHERE world_id=? ORDER BY idx').all(worldId)
    .map(c => Object.assign(c, capPos(c.idx)));
}
function defeatArmy(worldId, armyId, tick) {
  const a = db.prepare('SELECT * FROM warlords WHERE id=? AND world_id=?').get(armyId, worldId);
  if (!a || a.status !== 'alive') return false;
  db.prepare("UPDATE warlords SET status='fallen', died_tick=?, size=0 WHERE id=?").run(tick || 0, armyId);
  ev(worldId, tick || 0, 'leader_fell', a.name + ' of ' + a.faction + ' was cut down by your hand');
  return true;
}
// prepared lazily (better-sqlite3 caches by SQL) so requiring this module before migrate() is safe
function updatePresence(worldId, accountId, info) {
  db.prepare(`INSERT INTO presence(world_id, account_id, name, faction, x, z, size, renown, updated_at)
    VALUES (@w,@a,@name,@faction,@x,@z,@size,@renown,@now)
    ON CONFLICT(world_id, account_id) DO UPDATE SET name=excluded.name, faction=excluded.faction, x=excluded.x, z=excluded.z, size=excluded.size, renown=excluded.renown, updated_at=excluded.updated_at`)
    .run({ w: worldId, a: accountId, name: String(info.name || 'A Wanderer').slice(0, 48), faction: String(info.faction || 'Your Banner').slice(0, 32), x: +info.x || 0, z: +info.z || 0, size: info.size | 0, renown: +info.renown || 0, now: Math.floor(Date.now() / 1000) });
}
function getPresence(worldId, exceptAccount) {
  const cutoff = Math.floor(Date.now() / 1000) - PRESENCE_TTL;
  return db.prepare('SELECT account_id, name, faction, x, z, size, renown FROM presence WHERE world_id=? AND account_id!=? AND updated_at>=?').all(worldId, exceptAccount == null ? -1 : exceptAccount, cutoff);
}

module.exports = {
  advanceWorld, seedWorld, markActive, isActive, tickInactiveWorlds, forceTicks,
  getArmies, getCapitals, defeatArmy, updatePresence, getPresence, capPos,
  TICK_SECONDS, MAX_CATCHUP_TICKS, ACTIVE_TTL, MAP_HALF
};

if (require.main === module) {
  const i = process.argv.indexOf('--advance');
  if (i >= 0) { const n = parseInt(process.argv[i + 1] || '50', 10); const wid = parseInt(process.argv[i + 2] || '1', 10); console.log('forced', forceTicks(wid, n), 'ticks on world', wid); }
}
