// Blade Vale — the always-on world tick (positional).
// Warlords are moving ARMIES on the map: they march toward rivals and enemy capitals, clash
// when they meet, and take holds — all server-authoritative, using the shared character-weighted
// resolver (sim/world-sim.js). The client renders this state as a view (dead-reckoned between
// polls). Time-driven: each advance runs the real ticks elapsed since the last (clamped), so
// sleep / restart / a week away are one code path. Presence lets players share a world.
const { db } = require('./db');
const WorldSim = require('../sim/world-sim.js');
const D = require('./diplomacy');
const Destiny = require('./destiny');
const validate = require('./validate');

const TICK_SECONDS = 20;
const MAX_CATCHUP_TICKS = 300;
const ACTIVE_TTL = 90;
const PRESENCE_TTL = 30;        // a player's banner is "present" this many seconds after its last heartbeat
const MAP_HALF = 90;            // matches the client overworld half-size
const CAP_RADIUS = 48;          // capitals sit on a pentagon of this radius (same formula client-side)
const ARMY_SPEED = 6;           // map units per tick
const CLASH_RANGE = 9;
const CAP_RANGE = 8;

// ---------- Town economy (player holdings) ----------
// Per-tick = per TICK_SECONDS (20s). Tunable. The client mirrors COSTS + a few of these for its
// readout (kept in sync by hand — small surface). Production is applied every tick by tickHoldings,
// so offline catch-up (runTick x N in one transaction) accrues it correctly with no extra math.
const PLAYER = 'Your Banner';
const TOWN = {
  START_POP:    { village: 6, town: 12, city: 22, capital: 30 },
  START_FOOD: 20, START_WOOD: 20,
  POP_CAP_BASE: { village: 8, town: 16, city: 28, capital: 40 },
  HOUSES_POP_CAP: 6,            // +pop cap per houses level
  FARM_FOOD_PER_WORKER: 0.5,   // * farm level, per assigned worker, per tick
  LUMBER_WOOD_PER_WORKER: 0.4, // * lumber level
  FOOD_UPKEEP_PER_POP: 0.12,
  POP_GROWTH_RATE: 0.04,       // toward cap when food surplus
  POP_STARVE_RATE: 0.06,       // shrink when food deficit
  WORKERS_PER_LEVEL: 4,        // a building absorbs this many workers per level
  MAX_LEVEL: 3,
  // upgrade cost [wood, food] indexed by CURRENT level (0->1, 1->2, 2->3)
  COSTS: {
    farm:       [[15, 0], [40, 0], [90, 0]],
    lumber:     [[10, 0], [35, 0], [80, 0]],
    watchtower: [[30, 10], [70, 20], [140, 40]],
    houses:     [[20, 0], [50, 0], [110, 0]],
  },
  WATCHTOWER_GARRISON_PER_LVL: 8, // each tower level adds to a player hold's effective garrison
  LEVY_POP_THRESHOLD: 4,          // population above this is leviable into recruit XP
  LEVY_XP_PER_POP: 1.0,
};
function emptyBuildings() { return { farm: 0, lumber: 0, watchtower: 0, houses: 0 }; }
function popCapOf(tier, b) { return (TOWN.POP_CAP_BASE[tier] || TOWN.POP_CAP_BASE.village) + (b.houses || 0) * TOWN.HOUSES_POP_CAP; }
function watchtowerBonus(b) { return (b.watchtower || 0) * TOWN.WATCHTOWER_GARRISON_PER_LVL; }
// the shape the client consumes (panel + projection). Production rates are per-tick.
function holdView(h) {
  const b = JSON.parse(h.buildings_json || '{}'), j = JSON.parse(h.jobs_json || '{}');
  const farmW = Math.min(j.farm | 0, (b.farm | 0) * TOWN.WORKERS_PER_LEVEL);
  const lumberW = Math.min(j.lumber | 0, (b.lumber | 0) * TOWN.WORKERS_PER_LEVEL);
  const foodRate = farmW * TOWN.FARM_FOOD_PER_WORKER * (b.farm || 0) - h.population * TOWN.FOOD_UPKEEP_PER_POP;
  const woodRate = lumberW * TOWN.LUMBER_WOOD_PER_WORKER * (b.lumber || 0);
  return {
    holdKey: h.hold_key, ownerName: h.owner_name, defName: h.def_name, tier: h.tier, x: h.x, z: h.z,
    food: h.food, wood: h.wood, population: h.population, popCap: popCapOf(h.tier, b),
    buildings: b, jobs: j, production: { food: +foodRate.toFixed(3), wood: +woodRate.toFixed(3) },
    watchtowerBonus: watchtowerBonus(b), foundedTick: h.founded_tick, lastEconTick: h.last_econ_tick
  };
}
// trim {farm, lumber} so farm+lumber <= cap, keeping idle = the remainder (lumber yields first)
function fitJobs(farm, lumber, cap) {
  farm = Math.max(0, Math.min(farm | 0, cap));
  lumber = Math.max(0, Math.min(lumber | 0, cap - farm));
  return { farm, lumber, idle: Math.max(0, cap - farm - lumber) };
}

const NATIONS = ['Aurelia', 'Khorvane', 'Sahir', 'Wendmark', 'Maridor'];
// each power's heartland bearing (radians), matching the client's NATIONS[].home: the rising
// power in the hot south, the war-tribes in the cold north, the empire and its rival east/west
const CAP_ANGLE = [2.62, 0.15, 1.57, 4.71, 3.67];
const GNAMES = ['Aldric','Bram','Cedwyn','Doran','Eadric','Falk','Garrec','Hale','Ivo','Joren','Kell','Lorne','Maddoc','Nael','Osric','Perrin','Roderic','Sefton','Tomas','Ulf','Varin','Wend','Yorin','Edra','Freya','Gerda','Halla','Ingrid','Kara','Linnet','Mira','Nessa','Orla','Petra','Romilda','Sigrun','Thora'];
const BYN = ['the Bold','the Grim','Ironhand','Oakheart','the Swift','Stonefist','Redmane','Hawkeye','the Tall','Wolfsbane','the Sly','Brightblade','Frostbeard','Stormcrow','the Fierce','the Quiet','Greycloak'];
function pick(a) { return a[(Math.random() * a.length) | 0]; }
function genName() { return pick(GNAMES) + (Math.random() < 0.6 ? ' ' + pick(BYN) : ''); }
function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function capPos(idx) { const a = CAP_ANGLE[idx] != null ? CAP_ANGLE[idx] : idx / NATIONS.length * Math.PI * 2; return { x: Math.cos(a) * CAP_RADIUS, z: Math.sin(a) * CAP_RADIUS }; }
function factionCapPos(f) { const i = NATIONS.indexOf(f); return capPos(i < 0 ? 0 : i); }

function ev(worldId, tick, type, summary) { db.prepare('INSERT INTO world_events(world_id, tick, type, summary) VALUES (?,?,?,?)').run(worldId, tick, type, summary); }

function spawnWarlord(worldId, faction, tick) {
  const p = factionCapPos(faction);
  // a temperament at birth — ambition/caution/loyalty/vengeance ∈ [0,1] (the Phase-B field, now populated).
  // The destiny engine reads this to diverge fates; nothing in combat/diplomacy reads it (chronicle-only).
  const pers = { ambition: +rand(0, 1).toFixed(2), caution: +rand(0, 1).toFixed(2), loyalty: +rand(0.3, 1).toFixed(2), vengeance: +rand(0, 1).toFixed(2) };
  db.prepare('INSERT INTO warlords(world_id, name, faction, archetype, skills_json, renown, size, x, z, born_tick, personality_json, loyalty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(worldId, genName(), faction, 'longsword', JSON.stringify({ strike: Math.random() * 14, lead: Math.random() * 6 }),
      Math.random() * 12, 12 + ((Math.random() * 20) | 0), clamp(p.x + rand(-12, 12), -MAP_HALF, MAP_HALF), clamp(p.z + rand(-12, 12), -MAP_HALF, MAP_HALF), tick || 0,
      JSON.stringify(pers), Math.round(pers.loyalty * 100));
}
function seedWorld(worldId) {
  if (!db.prepare('SELECT count(*) n FROM capitals WHERE world_id=?').get(worldId).n) {
    const ins = db.prepare('INSERT INTO capitals(world_id, idx, def_name, owner_name, garrison) VALUES (?,?,?,?,?)');
    for (let i = 0; i < NATIONS.length; i++) ins.run(worldId, i, NATIONS[i], NATIONS[i], 20 + ((Math.random() * 12) | 0));
  }
  let have = db.prepare("SELECT count(*) n FROM warlords WHERE world_id=? AND status='alive'").get(worldId).n;
  for (; have < NATIONS.length * 2; have++) spawnWarlord(worldId, pick(NATIONS), 0);
  D.seedDiplomacy(worldId);   // relation matrix + faction posture (idempotent)
  Destiny.seedDestiny(worldId); // world destiny / "age" row (idempotent)
  db.prepare('UPDATE worlds SET last_tick_at=? WHERE id=? AND last_tick_at=0').run(Math.floor(Date.now() / 1000), worldId);
}

// A fallen banner can RISE AGAIN. If too few powers remain (a floor), or now and then just because
// the world turns, a long-dormant nation foments a homeland rebellion: it reclaims its ancestral
// capital (never one the human player holds) and musters a fresh host — so the vale cycles through
// rise and fall instead of grinding down to a lone victor. (The "successor states" piece the
// diplomacy module earmarked.)
const REBIRTH_FLOOR = 3;     // never let the count of living nations fall below this
const REBIRTH_DELAY = 12;    // a nation must lie fallen this many ticks before it can return
const REBIRTH_CHANCE = 0.05; // per-tick chance a dormant banner returns even when the world is healthy
function maybeRebirth(worldId, tick) {
  const living = db.prepare("SELECT count(*) n FROM faction_state WHERE world_id=? AND alive=1 AND faction!=?").get(worldId, D.PLAYER).n;
  const fallen = db.prepare("SELECT faction, collapsed_tick FROM faction_state WHERE world_id=? AND alive=0 AND collapsed_tick IS NOT NULL ORDER BY collapsed_tick ASC").all(worldId)
    .filter(r => NATIONS.indexOf(r.faction) >= 0 && (tick - r.collapsed_tick) >= REBIRTH_DELAY);
  if (!fallen.length) return;
  if (living >= REBIRTH_FLOOR && Math.random() >= REBIRTH_CHANCE) return; // healthy world: only the rare return
  const F = fallen[0].faction, idx = NATIONS.indexOf(F);                  // the longest-dormant banner rises first
  const cap = db.prepare('SELECT id, def_name, owner_name, garrison FROM capitals WHERE world_id=? AND idx=?').get(worldId, idx);
  const seize = cap && cap.owner_name !== D.PLAYER;                       // never wrest a hold from the human player
  const lostFrom = seize ? cap.owner_name : null;
  if (seize) db.prepare('UPDATE capitals SET owner_name=?, garrison=? WHERE id=?').run(F, Math.max(8, Math.round(cap.garrison * 0.6)), cap.id);
  spawnWarlord(worldId, F, tick);   // a reborn host musters in the homeland (spawnWarlord seats it near capPos(idx))
  db.prepare('UPDATE faction_state SET alive=1, collapsed_tick=NULL WHERE world_id=? AND faction=?').run(worldId, F);
  ev(worldId, tick, 'nation_rose', F + ' rises again — a rebellion ' +
    (seize ? 'restores its banner at ' + cap.def_name + (lostFrom && lostFrom !== F ? ', wrested from ' + lostFrom : '')
           : 'rallies a host in the homeland'));
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
// player towns produce food/wood + grow population, every owned hold, every tick. Inside the
// runTicks transaction, so the away-gap catch-up accrues production with no special-casing.
function tickHoldings(worldId, tick) {
  const holds = db.prepare('SELECT * FROM holdings WHERE world_id=? AND owner_name=?').all(worldId, PLAYER);
  if (!holds.length) return;
  const upd = db.prepare('UPDATE holdings SET food=?, wood=?, population=?, last_econ_tick=?, updated_at=unixepoch() WHERE id=?');
  for (const h of holds) {
    const b = JSON.parse(h.buildings_json || '{}'), j = JSON.parse(h.jobs_json || '{}');
    const farmW = Math.min(j.farm | 0, (b.farm | 0) * TOWN.WORKERS_PER_LEVEL);
    const lumberW = Math.min(j.lumber | 0, (b.lumber | 0) * TOWN.WORKERS_PER_LEVEL);
    let food = h.food + farmW * TOWN.FARM_FOOD_PER_WORKER * (b.farm || 0);
    let wood = h.wood + lumberW * TOWN.LUMBER_WOOD_PER_WORKER * (b.lumber || 0);
    food -= h.population * TOWN.FOOD_UPKEEP_PER_POP;
    let pop = h.population;
    const cap = popCapOf(h.tier, b);
    if (food >= 0 && pop < cap) pop += (cap - pop) * TOWN.POP_GROWTH_RATE;   // surplus -> growth toward cap
    else if (food < 0) { pop = Math.max(1, pop - pop * TOWN.POP_STARVE_RATE); food = 0; } // deficit -> shrink, floor at 0
    upd.run(Math.max(0, food), Math.max(0, wood), pop, tick, h.id);
  }
}
// ----- holdings: claim / build / assign / levy (server-authoritative; called by index.js endpoints) -----
function getHoldings(worldId) {
  return db.prepare('SELECT * FROM holdings WHERE world_id=? AND owner_name=? ORDER BY id').all(worldId, PLAYER).map(holdView);
}
function holdRow(worldId, holdKey) { return db.prepare('SELECT * FROM holdings WHERE world_id=? AND hold_key=?').get(worldId, holdKey); }
// the player took (or re-entered) a hold — create its economy row, or flip it back to the player if
// an NPC had retaken it (buildings/stock survive the interregnum, so the investment isn't lost).
function claimHolding(worldId, tick, body) {
  const v = validate.clampHold(body);
  if (!v.ok) return v;
  const existing = holdRow(worldId, v.holdKey);
  if (existing) {
    if (existing.owner_name !== PLAYER) db.prepare('UPDATE holdings SET owner_name=?, last_econ_tick=?, updated_at=unixepoch() WHERE id=?').run(PLAYER, tick, existing.id);
    return { ok: true, holding: holdView(holdRow(worldId, v.holdKey)) };
  }
  const pop = TOWN.START_POP[v.tier] || TOWN.START_POP.village;
  db.prepare(`INSERT INTO holdings(world_id, hold_key, owner_name, def_name, tier, x, z, food, wood, population, buildings_json, jobs_json, founded_tick, last_econ_tick)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    worldId, v.holdKey, PLAYER, v.defName, v.tier, v.x, v.z, TOWN.START_FOOD, TOWN.START_WOOD, pop,
    JSON.stringify(emptyBuildings()), JSON.stringify({ farm: 0, lumber: 0, idle: Math.round(pop) }), tick, tick);
  return { ok: true, holding: holdView(holdRow(worldId, v.holdKey)) };
}
function buildHolding(worldId, body) {
  if (!validate.holdKeyOk(body && body.holdKey)) return { ok: false, reason: 'bad hold key' };
  const building = String((body && body.building) || '');
  if (!TOWN.COSTS[building]) return { ok: false, reason: 'unknown building' };
  const row = holdRow(worldId, body.holdKey);
  if (!row || row.owner_name !== PLAYER) return { ok: false, reason: 'not your holding' };
  const b = Object.assign(emptyBuildings(), JSON.parse(row.buildings_json || '{}'));
  const lvl = b[building] | 0;
  if (lvl >= TOWN.MAX_LEVEL) return { ok: false, reason: 'at max level' };
  const cost = TOWN.COSTS[building][lvl];            // server recomputes — never trusts the client
  if (row.wood < cost[0]) return { ok: false, reason: 'need wood' };
  if (row.food < cost[1]) return { ok: false, reason: 'need food' };
  b[building] = lvl + 1;
  db.prepare('UPDATE holdings SET wood=?, food=?, buildings_json=?, updated_at=unixepoch() WHERE id=?')
    .run(row.wood - cost[0], row.food - cost[1], JSON.stringify(b), row.id);
  return { ok: true, holding: holdView(holdRow(worldId, body.holdKey)) };
}
function assignJobs(worldId, body) {
  if (!validate.holdKeyOk(body && body.holdKey)) return { ok: false, reason: 'bad hold key' };
  const row = holdRow(worldId, body.holdKey);
  if (!row || row.owner_name !== PLAYER) return { ok: false, reason: 'not your holding' };
  const b = Object.assign(emptyBuildings(), JSON.parse(row.buildings_json || '{}'));
  const inJobs = (body && body.jobs) || {};
  let farm = Math.min(inJobs.farm | 0, (b.farm | 0) * TOWN.WORKERS_PER_LEVEL);   // can't work a building past its level
  let lumber = Math.min(inJobs.lumber | 0, (b.lumber | 0) * TOWN.WORKERS_PER_LEVEL);
  const jobs = fitJobs(farm, lumber, Math.floor(row.population));
  db.prepare('UPDATE holdings SET jobs_json=?, updated_at=unixepoch() WHERE id=?').run(JSON.stringify(jobs), row.id);
  return { ok: true, holding: holdView(holdRow(worldId, body.holdKey)) };
}
// muster a levy: surplus population (above a threshold) becomes recruit XP, and is removed from the
// town. Server-authoritative so it can't be farmed — regrowth rate-limits how often it pays out.
function levyHolding(worldId, body) {
  if (!validate.holdKeyOk(body && body.holdKey)) return { ok: false, reason: 'bad hold key' };
  const row = holdRow(worldId, body.holdKey);
  if (!row || row.owner_name !== PLAYER) return { ok: false, reason: 'not your holding' };
  const leviable = Math.floor(row.population - TOWN.LEVY_POP_THRESHOLD);
  if (leviable <= 0) return { ok: false, reason: 'no surplus to levy' };
  const xp = Math.round(leviable * TOWN.LEVY_XP_PER_POP);
  const newPop = row.population - leviable;
  const b = Object.assign(emptyBuildings(), JSON.parse(row.buildings_json || '{}'));
  const j = JSON.parse(row.jobs_json || '{}');
  const jobs = fitJobs(Math.min(j.farm | 0, (b.farm | 0) * TOWN.WORKERS_PER_LEVEL), Math.min(j.lumber | 0, (b.lumber | 0) * TOWN.WORKERS_PER_LEVEL), Math.floor(newPop));
  db.prepare('UPDATE holdings SET population=?, jobs_json=?, updated_at=unixepoch() WHERE id=?').run(newPop, JSON.stringify(jobs), row.id);
  return { ok: true, xp, holding: holdView(holdRow(worldId, body.holdKey)) };
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
  // 3. conquests: an army on an enemy hold, strong enough, takes it. A player hold's watchtowers
  //    stiffen its effective garrison, so a developed capital genuinely resists offline reconquest.
  for (const a of db.prepare("SELECT * FROM warlords WHERE world_id=? AND status='alive'").all(worldId)) {
    if (clashed.has(a.id)) continue;
    const cap = nearestEnemyCap(worldId, a.faction, a.x, a.z, relMap);
    if (!cap || cap.d2 > CAP_RANGE * CAP_RANGE) continue;
    const loser = cap.row.owner_name;
    let effGarr = cap.row.garrison, hold = null;
    if (loser === PLAYER) { hold = holdRow(worldId, 'cap:' + cap.row.idx); if (hold) effGarr += watchtowerBonus(JSON.parse(hold.buildings_json || '{}')); }
    if (a.size < effGarr * 0.5) continue;
    db.prepare('UPDATE capitals SET owner_name=? WHERE id=?').run(a.faction, cap.row.id);
    db.prepare('UPDATE warlords SET renown=renown+10, size=? WHERE id=?').run(Math.max(2, a.size - Math.round(effGarr * 0.4)), a.id);
    ev(worldId, tick, 'capital_taken', a.faction + ' seized ' + cap.row.def_name + ' under ' + a.name);
    D.bumpRelation(worldId, loser, a.faction, -D.CONQUEST_SHOCK, tick); // the wronged nation seethes (may tip into war)
    if (hold) { // the player just lost a developed hold: stop crediting it, but freeze its buildings/stock for retaking
      db.prepare('UPDATE holdings SET owner_name=?, updated_at=unixepoch() WHERE id=?').run(a.faction, hold.id);
      ev(worldId, tick, 'hold_lost', a.faction + ' wrested ' + cap.row.def_name + ' from your banner');
    }
  }
  // 3c. player towns produce + grow (offline catch-up safe — see tickHoldings)
  tickHoldings(worldId, tick);
  // 4. diplomacy: drift relations + posture, then record any nation that has fallen
  D.tickDiplomacy(worldId, tick);
  D.handleCollapse(worldId, tick);
  // 4a. successor states: a fallen banner can rise again so the world never grinds to a lone power
  maybeRebirth(worldId, tick);
  // 4b. destiny: read the whole population + the macro state diplomacy just refreshed, and advance
  // each character's fated arc + the world "age" (chronicle-only; self-gated to a slow cadence)
  Destiny.tickDestiny(worldId, tick);
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
  return db.prepare("SELECT id, name, faction, archetype, x, z, size, renown, kills, battles_won, intent, intent_target_kind, intent_target_id, loyalty, personality_json, grudge_faction, destiny, fate FROM warlords WHERE world_id=? AND status='alive' ORDER BY id").all(worldId);
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
  advanceWorld, seedWorld, runTicks, markActive, isActive, tickInactiveWorlds, forceTicks,
  getArmies, getCapitals, defeatArmy, updatePresence, getPresence, capPos,
  getHoldings, claimHolding, buildHolding, assignJobs, levyHolding, TOWN,
  TICK_SECONDS, MAX_CATCHUP_TICKS, ACTIVE_TTL, MAP_HALF
};

if (require.main === module) {
  const i = process.argv.indexOf('--advance');
  if (i >= 0) { const n = parseInt(process.argv[i + 1] || '50', 10); const wid = parseInt(process.argv[i + 2] || '1', 10); console.log('forced', forceTicks(wid, n), 'ticks on world', wid); }
}
