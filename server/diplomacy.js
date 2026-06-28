// Blade Vale — the diplomacy engine (server authority).
// Owns the persisted relationship STATE between factions and drives it each world tick using the
// shared, deterministic kernel in sim/world-sim.js (so the client can replay the same math). The
// faction layer lives here; per-leader personality/intent (Phase B) and defection/collapse (Phase C)
// extend this module. All writes run INSIDE the runTicks() transaction in tick.js — no new txns.
const { db } = require('./db');
const WS = require('../sim/world-sim.js');

const NATIONS = ['Aurelia', 'Khorvane', 'Sahir', 'Wendmark', 'Maridor'];
const PLAYER = 'Your Banner';
const ALL_FACTIONS = NATIONS.concat([PLAYER]);
const CAP_POWER = 25;          // a held capital is worth this much strategic weight
const CONQUEST_SHOCK = 28;     // opinion a faction loses toward whoever seizes its hold

// ----- seeding -----
function seedDiplomacy(worldId) {
  // relations: one row per unordered pair, opening opinion from the themed matrix in the kernel
  // (a fading empire, its eastern rival, a rising southern power, northern tribes, a sea-league)
  if (!db.prepare('SELECT count(*) n FROM faction_relations WHERE world_id=?').get(worldId).n) {
    const ins = db.prepare('INSERT INTO faction_relations(world_id, faction_a, faction_b, opinion, stance) VALUES (?,?,?,?,?)');
    for (let i = 0; i < ALL_FACTIONS.length; i++) for (let j = i + 1; j < ALL_FACTIONS.length; j++) {
      const a = ALL_FACTIONS[i], b = ALL_FACTIONS[j];
      const ni = NATIONS.indexOf(a), nj = NATIONS.indexOf(b);
      // nation↔nation opening standing is themed; the player opens neutral with everyone
      const opinion = (ni >= 0 && nj >= 0) ? WS.initialOpinion(a, b) : 0;
      const c = WS.canonPair(a, b);
      ins.run(worldId, c.a, c.b, opinion, WS.stanceFromOpinion(opinion, null));
    }
  }
  if (!db.prepare('SELECT count(*) n FROM faction_state WHERE world_id=?').get(worldId).n) {
    const ins = db.prepare('INSERT INTO faction_state(world_id, faction, posture) VALUES (?,?,?)');
    for (const f of ALL_FACTIONS) ins.run(worldId, f, 'consolidate');
  }
}

// ----- reads -----
function relationsFor(worldId) {
  const m = new Map();
  for (const r of db.prepare('SELECT faction_a, faction_b, opinion, stance, truce_until FROM faction_relations WHERE world_id=?').all(worldId))
    m.set(WS.pairKey(r.faction_a, r.faction_b), { a: r.faction_a, b: r.faction_b, opinion: r.opinion, stance: r.stance, truceUntil: r.truce_until });
  return m;
}
function factionStateFor(worldId) {
  const m = new Map();
  for (const r of db.prepare('SELECT faction, posture, war_weariness, power, alive FROM faction_state WHERE world_id=?').all(worldId))
    m.set(r.faction, { faction: r.faction, posture: r.posture, warWeariness: r.war_weariness, power: r.power, alive: r.alive });
  return m;
}
// stance between two factions given a relations Map; same faction is never an enemy, unknown pairs are neutral
function stanceBetween(relMap, a, b) {
  if (a === b) return 'alliance';
  const r = relMap.get(WS.pairKey(a, b));
  return r ? r.stance : 'neutral';
}

// ----- power balance -----
function band(w) { return { size: w.size, quality: 1.05, leader: { skills: JSON.parse(w.skills_json || '{}'), renown: w.renown } }; }
function recomputePower(worldId) {
  const power = {}; for (const f of ALL_FACTIONS) power[f] = 0;
  for (const c of db.prepare('SELECT owner_name FROM capitals WHERE world_id=?').all(worldId))
    if (power[c.owner_name] != null) power[c.owner_name] += CAP_POWER;
  for (const w of db.prepare("SELECT faction, size, skills_json, renown FROM warlords WHERE world_id=? AND status='alive'").all(worldId))
    if (power[w.faction] != null) power[w.faction] += WS.bandPower(band(w));
  const upd = db.prepare('UPDATE faction_state SET power=? WHERE world_id=? AND faction=?');
  for (const f of ALL_FACTIONS) upd.run(power[f], worldId, f);
  return power;
}

// a discrete opinion shock to a pair (a conquest, a betrayal); clamps + recomputes stance, persists.
function bumpRelation(worldId, a, b, delta, tick) {
  if (a === b) return;
  const c = WS.canonPair(a, b);
  const row = db.prepare('SELECT opinion, stance, truce_until FROM faction_relations WHERE world_id=? AND faction_a=? AND faction_b=?').get(worldId, c.a, c.b);
  if (!row) return;
  const opinion = Math.max(-100, Math.min(100, row.opinion + delta));
  const truced = (row.truce_until || 0) > tick;
  const stance = truced && WS.areEnemies(WS.rawStance(opinion)) ? 'neutral' : WS.stanceFromOpinion(opinion, row.stance);
  db.prepare('UPDATE faction_relations SET opinion=?, stance=?, last_change_tick=? WHERE world_id=? AND faction_a=? AND faction_b=?')
    .run(opinion, stance, tick, worldId, c.a, c.b);
}

// ----- the per-tick diplomacy step (called inside runTick's transaction) -----
function ev(worldId, tick, type, summary) {
  db.prepare('INSERT INTO world_events(world_id, tick, type, summary) VALUES (?,?,?,?)').run(worldId, tick, type, summary);
}
function tickDiplomacy(worldId, tick) {
  const power = recomputePower(worldId);
  const stateMap = factionStateFor(worldId);
  const factions = ALL_FACTIONS.map(f => {
    const s = stateMap.get(f) || {};
    return { name: f, power: power[f] || 0, alive: s.alive === 0 ? 0 : 1, warWeariness: s.warWeariness || 0, posture: s.posture || 'consolidate' };
  });
  const relations = [];
  for (const r of db.prepare('SELECT faction_a, faction_b, opinion, stance, truce_until FROM faction_relations WHERE world_id=?').all(worldId))
    relations.push({ a: r.faction_a, b: r.faction_b, opinion: r.opinion, stance: r.stance, truceUntil: r.truce_until });

  const rnd = WS.mulberry32((worldSeed(worldId) ^ tick ^ 0x5151) >>> 0);
  const out = WS.updateDiplomacy(factions, relations, { tick: tick }, rnd);

  const updRel = db.prepare('UPDATE faction_relations SET opinion=?, stance=?, last_change_tick=? WHERE world_id=? AND faction_a=? AND faction_b=?');
  for (const u of out.relationUpdates) {
    if (u.changed) updRel.run(u.opinion, u.stance, tick, worldId, u.a, u.b);
    else db.prepare('UPDATE faction_relations SET opinion=? WHERE world_id=? AND faction_a=? AND faction_b=?').run(u.opinion, worldId, u.a, u.b);
  }
  const updState = db.prepare('UPDATE faction_state SET posture=?, war_weariness=? WHERE world_id=? AND faction=?');
  for (const ps of out.postureUpdates) updState.run(ps.posture, ps.warWeariness, worldId, ps.faction);
  for (const e of out.events) ev(worldId, tick, 'diplomacy', e.summary);
}

// a nation with no capitals AND no living warlords has fallen. (Phase C scatters survivors into free
// companies; Phase A simply records the collapse and keeps the repopulator from reviving it.)
function handleCollapse(worldId, tick) {
  for (const f of NATIONS) {
    const st = db.prepare('SELECT alive FROM faction_state WHERE world_id=? AND faction=?').get(worldId, f);
    if (!st || st.alive === 0) continue;
    const caps = db.prepare('SELECT count(*) n FROM capitals WHERE world_id=? AND owner_name=?').get(worldId, f).n;
    const hosts = db.prepare("SELECT count(*) n FROM warlords WHERE world_id=? AND faction=? AND status='alive'").get(worldId, f).n;
    if (caps === 0 && hosts === 0) {
      db.prepare('UPDATE faction_state SET alive=0, collapsed_tick=? WHERE world_id=? AND faction=?').run(tick, worldId, f);
      ev(worldId, tick, 'nation_fell', f + ' is no more — its banner falls from the vale');
    }
  }
}
function aliveNations(worldId) {
  return db.prepare("SELECT faction FROM faction_state WHERE world_id=? AND alive=1 AND faction!=?").all(worldId, PLAYER)
    .map(r => r.faction).filter(f => NATIONS.indexOf(f) >= 0);
}

function worldSeed(worldId) { const w = db.prepare('SELECT seed FROM worlds WHERE id=?').get(worldId); return (w && w.seed) || 0; }

// ----- API shapes (plain arrays for JSON) -----
function relationsForApi(worldId) {
  return db.prepare('SELECT faction_a AS a, faction_b AS b, opinion, stance, truce_until AS truceUntil FROM faction_relations WHERE world_id=?').all(worldId);
}
function factionStateForApi(worldId) {
  return db.prepare('SELECT faction, posture, war_weariness AS warWeariness, power, alive FROM faction_state WHERE world_id=?').all(worldId);
}

module.exports = {
  NATIONS, PLAYER, ALL_FACTIONS, CONQUEST_SHOCK,
  seedDiplomacy, relationsFor, factionStateFor, stanceBetween, recomputePower, bumpRelation,
  tickDiplomacy, handleCollapse, aliveNations, relationsForApi, factionStateForApi
};
