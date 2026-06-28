// Blade Vale — the destiny engine (server authority).
// Sibling of diplomacy.js: owns each character's fated arc + the world "age", driven each world tick
// by the shared, deterministic kernel in sim/world-sim.js (computeDestiny). CHRONICLE-ONLY — it records
// labels + prophecies in world_events, never modifies combat / marching / conquest / diplomacy. All
// writes run INSIDE the runTicks() transaction in tick.js (no new txns). It READS the macro state that
// diplomacy already persisted THIS tick (faction power/posture/alive, capital counts, war pairs) — so it
// must be called AFTER tickDiplomacy. No recompute of power here.
const { db } = require('./db');
const WS = require('../sim/world-sim.js');
const D = require('./diplomacy');

const DESTINY_EVERY = 3;   // destiny is a slow tide — run ~once a minute (every 3 ticks); also keeps catch-up cheap

function ev(worldId, tick, type, summary) {
  db.prepare('INSERT INTO world_events(world_id, tick, type, summary) VALUES (?,?,?,?)').run(worldId, tick, type, summary);
}
function worldSeed(worldId) { const w = db.prepare('SELECT seed FROM worlds WHERE id=?').get(worldId); return (w && w.seed) || 0; }
function parse(s) { try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; } }

// ----- seeding (idempotent) -----
function seedDestiny(worldId) {
  if (!db.prepare('SELECT count(*) n FROM world_destiny WHERE world_id=?').get(worldId).n)
    db.prepare('INSERT INTO world_destiny(world_id, age, prophecy, momentum, age_tick) VALUES (?,?,?,?,0)')
      .run(worldId, 'age_of_ambition', '', 0);
}

// ----- reads: every character in the world, normalized into the kernel's shape -----
function loadCharacters(worldId) {
  const out = [];
  for (const w of db.prepare("SELECT id, name, faction, renown, kills, battles_won, size, born_tick, personality_json, loyalty, destiny, fate FROM warlords WHERE world_id=? AND status='alive' ORDER BY id").all(worldId))
    out.push({ id: w.id, kind: 'warlord', name: w.name, faction: w.faction, renown: w.renown, kills: w.kills,
      battlesWon: w.battles_won, size: w.size, bornTick: w.born_tick, personality: parse(w.personality_json),
      loyalty: w.loyalty, destiny: w.destiny, fate: w.fate });
  for (const c of db.prepare("SELECT id, name, renown, kills, battles_won, personality_json, loyalty, destiny, fate FROM characters WHERE world_id=? AND status='alive' ORDER BY id").all(worldId))
    out.push({ id: c.id, kind: 'char', name: c.name, faction: D.PLAYER, renown: c.renown, kills: c.kills,
      battlesWon: c.battles_won, size: 0, bornTick: null, personality: parse(c.personality_json),
      loyalty: c.loyalty, destiny: c.destiny, fate: c.fate });
  return out;
}

// macro aggregates for the kernel — read what diplomacy persisted this tick (no recompute)
function aggregates(worldId, tick) {
  const powerOf = {}, postureOf = {}, aliveOf = {};
  let sum = 0, live = 0;
  for (const r of db.prepare('SELECT faction, power, posture, alive FROM faction_state WHERE world_id=?').all(worldId)) {
    powerOf[r.faction] = r.power || 0; postureOf[r.faction] = r.posture; aliveOf[r.faction] = r.alive !== 0;
    if (r.faction !== D.PLAYER && r.alive !== 0) { sum += r.power || 0; live++; }   // mean over the living NATIONS only
  }
  const capsOf = {}; let totalCaps = 0, topCaps = 0;
  for (const c of db.prepare('SELECT owner_name FROM capitals WHERE world_id=?').all(worldId)) { capsOf[c.owner_name] = (capsOf[c.owner_name] || 0) + 1; totalCaps++; }
  for (const f in capsOf) if (capsOf[f] > topCaps) topCaps = capsOf[f];
  const nationsAlive = db.prepare("SELECT count(*) n FROM faction_state WHERE world_id=? AND alive=1 AND faction!=?").get(worldId, D.PLAYER).n;
  const warPairs = db.prepare("SELECT count(*) n FROM faction_relations WHERE world_id=? AND stance IN ('war','hostile')").get(worldId).n;
  const wd = db.prepare('SELECT age FROM world_destiny WHERE world_id=?').get(worldId);
  return { tick, mean: live ? sum / live : 0, powerOf, postureOf, aliveOf, capsOf, totalCaps,
    strongestShareCaps: totalCaps ? topCaps / totalCaps : 0, nationsAlive, warPairs,
    prevAge: wd ? wd.age : 'age_of_ambition' };
}

// ----- the per-tick destiny step (called inside runTick's transaction, after diplomacy) -----
function tickDestiny(worldId, tick) {
  if (tick % DESTINY_EVERY !== 0) return;          // slow tide
  seedDestiny(worldId);
  const chars = loadCharacters(worldId);
  if (!chars.length) return;
  const world = aggregates(worldId, tick);
  const rnd = WS.mulberry32((worldSeed(worldId) ^ tick ^ 0xDE57) >>> 0);
  const out = WS.computeDestiny(chars, world, { tick }, rnd);

  const updW = db.prepare('UPDATE warlords SET destiny=?, fate=?, destiny_tick=? WHERE id=? AND world_id=?');
  const updC = db.prepare('UPDATE characters SET destiny=?, fate=?, destiny_tick=? WHERE id=? AND world_id=?');
  for (const u of out.charUpdates) (u.kind === 'char' ? updC : updW).run(u.destiny, u.fate, tick, u.id, worldId);

  const cur = db.prepare('SELECT age_tick FROM world_destiny WHERE world_id=?').get(worldId);
  const ageTick = out.world.changed ? tick : (cur ? cur.age_tick : tick);
  db.prepare('UPDATE world_destiny SET age=?, prophecy=?, momentum=?, age_tick=? WHERE world_id=?')
    .run(out.world.age, out.world.prophecy, out.world.momentum, ageTick, worldId);

  for (const e of out.events) ev(worldId, tick, e.type, e.summary);
}

// ----- API shape (the world's current destiny + its most-fated names) -----
function destinyForApi(worldId) {
  const wd = db.prepare('SELECT age, prophecy, momentum, age_tick FROM world_destiny WHERE world_id=?').get(worldId)
    || { age: 'age_of_ambition', prophecy: '', momentum: 0, age_tick: 0 };
  const fated = db.prepare("SELECT name, faction, destiny, fate FROM warlords WHERE world_id=? AND status='alive' AND destiny IS NOT NULL AND destiny!='wanderer' ORDER BY fate DESC, renown DESC LIMIT 6").all(worldId)
    .map(w => ({ name: w.name, faction: w.faction, destiny: w.destiny, destinyTitle: WS.destinyTitle(w.destiny), fate: w.fate }));
  return { age: wd.age, ageTitle: WS.ageTitle(wd.age), prophecy: wd.prophecy, momentum: wd.momentum, ageTick: wd.age_tick, fated };
}

module.exports = { DESTINY_EVERY, seedDestiny, tickDestiny, destinyForApi };
