// Blade Vale — the always-on world tick.
// Advances the macro world (warlord clashes, capital conquests) over REAL time, including
// while the player is offline. Uses the SHARED resolver (sim/world-sim.js) so off-map wars
// resolve by the same character-weighted math the client uses. Time-driven: each advance
// runs however many ticks of real time have elapsed since the last one (clamped), so a
// laptop sleep, a server restart, and a week-long absence are all the same code path.
const { db } = require('./db');
const WorldSim = require('../sim/world-sim.js');

const TICK_SECONDS = 20;        // one world tick per 20 real seconds (3 ticks/min)
const MAX_CATCHUP_TICKS = 300;  // a long absence catches up at most this many ticks — bounded work
const ACTIVE_TTL = 90;          // a session keeps its world "active" (tick-skipped) for this long after the last poll

const NATIONS = ['Valgard', 'Eorland', 'Sunmarch', 'Mournhold', 'Frostmere'];

const GNAMES = ['Aldric','Bram','Cedwyn','Doran','Eadric','Falk','Garrec','Hale','Ivo','Joren','Kell','Lorne','Maddoc','Nael','Osric','Perrin','Roderic','Sefton','Tomas','Ulf','Varin','Wend','Yorin','Edra','Freya','Gerda','Halla','Ingrid','Kara','Linnet','Mira','Nessa','Orla','Petra','Romilda','Sigrun','Thora'];
const BYN = ['the Bold','the Grim','Ironhand','Oakheart','the Swift','Stonefist','Redmane','Hawkeye','the Tall','Wolfsbane','the Sly','Brightblade','Frostbeard','Stormcrow','the Fierce','the Quiet','Greycloak'];
function pick(a) { return a[(Math.random() * a.length) | 0]; }
function genName() { return pick(GNAMES) + (Math.random() < 0.6 ? ' ' + pick(BYN) : ''); }

// prepared lazily (better-sqlite3 caches by SQL) so requiring this module before migrate() is safe
function ev(worldId, tick, type, summary) { db.prepare('INSERT INTO world_events(world_id, tick, type, summary) VALUES (?,?,?,?)').run(worldId, tick, type, summary); }

function seedWorld(worldId) {
  if (!db.prepare('SELECT count(*) n FROM capitals WHERE world_id=?').get(worldId).n) {
    const ins = db.prepare('INSERT INTO capitals(world_id, idx, def_name, owner_name, garrison) VALUES (?,?,?,?,?)');
    for (let i = 0; i < NATIONS.length; i++) ins.run(worldId, i, NATIONS[i], NATIONS[i], 20 + ((Math.random() * 12) | 0));
  }
  const have = db.prepare("SELECT count(*) n FROM warlords WHERE world_id=? AND status='alive'").get(worldId).n;
  if (have < NATIONS.length * 2) {
    const ins = db.prepare('INSERT INTO warlords(world_id, name, faction, archetype, skills_json, renown, size) VALUES (?,?,?,?,?,?,?)');
    for (let i = have; i < NATIONS.length * 2; i++) {
      ins.run(worldId, genName(), pick(NATIONS), 'longsword',
        JSON.stringify({ strike: Math.random() * 20, lead: Math.random() * 8 }), Math.random() * 30, 12 + ((Math.random() * 24) | 0));
    }
  }
  db.prepare('UPDATE worlds SET last_tick_at=? WHERE id=? AND last_tick_at=0').run(Math.floor(Date.now() / 1000), worldId);
}

function band(w) { return { size: w.size, quality: 1.05, leader: { skills: JSON.parse(w.skills_json || '{}'), renown: w.renown } }; }

// one tick: a rival pair of warlords clash; the victor's name grows, the broken may fall;
// the strong sometimes seize a rival capital; the dead are replaced by fresh hopefuls.
function runTick(worldId, tick) {
  const alive = db.prepare("SELECT * FROM warlords WHERE world_id=? AND status='alive'").all(worldId);
  if (alive.length < 2) { seedWorld(worldId); return; }
  const a = alive[(Math.random() * alive.length) | 0];
  let b = a; for (let t = 0; (b === a || b.faction === a.faction) && t < 10; t++) b = alive[(Math.random() * alive.length) | 0];
  if (b === a || b.faction === a.faction) return;

  const r = WorldSim.resolveClash(band(a), band(b), Math.random);
  const win = r.aWins ? a : b, los = r.aWins ? b : a;
  const winSize = Math.max(1, win.size - r.winnerLoss);
  const losSize = Math.max(0, los.size - r.loserLoss);
  const winRenown = win.renown + 3 + 0.12 * los.size;

  db.prepare('UPDATE warlords SET size=?, renown=?, battles_won=battles_won+1, kills=kills+? WHERE id=?')
    .run(winSize, winRenown, r.loserLoss, win.id);
  if (win.renown < 100 && winRenown >= 100) ev(worldId, tick, 'warlord_rose', win.name + ' of ' + win.faction + ' is now a name spoken across the vale');

  if (r.leaderFell || losSize <= 0) {
    db.prepare("UPDATE warlords SET status='fallen', died_tick=?, size=? WHERE id=?").run(tick, losSize, los.id);
    ev(worldId, tick, 'leader_fell', los.name + ' of ' + los.faction + ' fell to ' + win.name);
    if (Math.random() < 0.7) db.prepare('INSERT INTO warlords(world_id, name, faction, archetype, skills_json, renown, size, born_tick) VALUES (?,?,?,?,?,?,?,?)')
      .run(worldId, genName(), los.faction, 'longsword', JSON.stringify({ strike: Math.random() * 12 }), Math.random() * 8, 10 + ((Math.random() * 18) | 0), tick);
  } else {
    db.prepare('UPDATE warlords SET size=? WHERE id=?').run(losSize, los.id);
  }

  if (Math.random() < 0.22) {
    const cap = db.prepare("SELECT * FROM capitals WHERE world_id=? AND owner_name!=? ORDER BY RANDOM() LIMIT 1").get(worldId, win.faction);
    if (cap) {
      db.prepare('UPDATE capitals SET owner_name=? WHERE id=?').run(win.faction, cap.id);
      db.prepare('UPDATE warlords SET renown=renown+10 WHERE id=?').run(win.id);
      ev(worldId, tick, 'capital_taken', win.faction + ' seized ' + cap.def_name + ' under ' + win.name);
    }
  }
}

function pruneWorld(worldId) {
  db.prepare('DELETE FROM world_events WHERE world_id=? AND id NOT IN (SELECT id FROM world_events WHERE world_id=? ORDER BY id DESC LIMIT 250)').run(worldId, worldId);
  // bounded growth: forget the unremarkable fallen — keep the living, plus the 60 most
  // renowned dead as the world's legends. (The player's OWN characters live in `characters`,
  // untouched by this.)
  db.prepare("DELETE FROM warlords WHERE world_id=? AND status='fallen' AND id NOT IN (SELECT id FROM warlords WHERE world_id=? AND status='fallen' ORDER BY renown DESC LIMIT 60)").run(worldId, worldId);
}
function runTicks(worldId, n) {
  if (n <= 0) return 0;
  let tick = db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(worldId).sim_tick;
  db.transaction(() => {
    for (let i = 0; i < n; i++) { tick++; runTick(worldId, tick); }
    db.prepare('UPDATE worlds SET sim_tick=? WHERE id=?').run(tick, worldId);
  })();
  pruneWorld(worldId);
  return n;
}

// advance by the real time elapsed since the last advance (clamped) — the catch-up path
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
// reset the away-clock and keep the world tick-frozen while a session is live (no double-sim)
function markActive(worldId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE worlds SET active_until=?, last_tick_at=? WHERE id=?').run(now + ACTIVE_TTL, now, worldId);
}
function isActive(worldId) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare('SELECT active_until FROM worlds WHERE id=?').get(worldId).active_until > now;
}
// the always-on heartbeat: advance every world that has no live session
function tickInactiveWorlds() {
  const now = Math.floor(Date.now() / 1000);
  for (const w of db.prepare('SELECT id FROM worlds WHERE active_until < ?').all(now)) advanceWorld(w.id);
}
// deterministic immediate advance for tests (ignores real time)
function forceTicks(worldId, n) { seedWorld(worldId); return runTicks(worldId, n); }

module.exports = { advanceWorld, seedWorld, markActive, isActive, tickInactiveWorlds, forceTicks, TICK_SECONDS, MAX_CATCHUP_TICKS, ACTIVE_TTL };

if (require.main === module) {
  const i = process.argv.indexOf('--advance');
  if (i >= 0) { const n = parseInt(process.argv[i + 1] || '50', 10); const wid = parseInt(process.argv[i + 2] || '1', 10); console.log('forced', forceTicks(wid, n), 'ticks on world', wid); }
}
