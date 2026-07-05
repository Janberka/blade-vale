// Blade Vale — the living war around every settlement (patrols, campaigns, visible battles).
//
// Three layers, all server-authoritative and offline-catch-up safe (every function is per-tick
// and runs inside runTicks' transaction):
//
//   PATROLS    every settlement musters a tier-scaled garrison ecology (a city keeps 2 large,
//              5 medium, 10 small groups riding circuits around its walls). Ordinary warlord
//              rows — named characters with careers — with role='patrol' and a home leash.
//   CAMPAIGNS  rarely, a great host CALLS THE BANNERS: same-realm hosts + nearby patrols +
//              allied realms converge on a muster point, then march as one stack to take an
//              enemy settlement. The defender weighs the balance of power and either rides to
//              the relief or leaves the hold to its fate.
//   SBATTLES   armies that meet lock into a TIMED battle that bleeds over ticks instead of
//              resolving instantly — the map shows the bar move; walking up shows the lines.
//
// The client is a pure view of these rows (/world ships them); nothing here reads client state.
const { db } = require('./db');
const WorldSim = require('../sim/world-sim.js');
const D = require('./diplomacy');
const Chunks = require('./chunks');

const NATIONS = ['Aurelia', 'Khorvane', 'Sahir', 'Wendmark', 'Maridor']; // keep in sync with tick.js
const PLAYER = 'Your Banner';
const FREE = WorldSim.FREE_NAME;   // 'Free City' — the only masterless owner; every other non-player owner is a realm
// NOT the old ±90 arena bound: the explored world streams far past it (holds exist at |x| > 140),
// and clamping to the old edge stranded their patrols mid-map. This is a sanity backstop only —
// every real destination (home, muster, target, foe) is an actual settlement or army position.
const MAP_HALF = 640;
const CAP_RADIUS = 48;
const CAP_ANGLE = [2.62, 0.15, 1.57, 4.71, 3.67];                        // keep in sync with tick.js

// ---- patrol ecology ----
// the user-facing promise: around each CITY you see at least 2 large, 5 medium, 10 small groups.
const QUOTA = {
  capital: { large: 2, medium: 5, small: 10 },
  city:    { large: 2, medium: 5, small: 10 },
  town:    { large: 0, medium: 1, small: 3 },
  village: { large: 0, medium: 0, small: 0 },   // villages shelter under their town's patrols
};
const MILITIA_QUOTA = { city: { large: 0, medium: 2, small: 4 }, town: { large: 0, medium: 1, small: 2 }, village: { large: 0, medium: 0, small: 0 } };
const PATROL_SIZE  = { large: [24, 40], medium: [10, 18], small: [3, 8] };
// each class rides a wider ring: the big companies range out to the borders of their ground, the
// small watches stay tight to the walls. This is now an OUTWARD OFFSET added to the settlement's
// footprint — the watch orbits OUTSIDE the ramparts, not inside them (a city wall is ~44u across, far
// wider than the old flat 8–22 ring, which left the guard circling the market square).
const PATROL_LEASH = { large: 22, medium: 14, small: 8 };  // ring offset BEYOND the walls
// settlement footprint radius (SG_SPEC.R + wall margin) the ring wraps: village 7 / town 15 / city 38 /
// capital 46, bumped so the circuit clears the stone walls. Keep in sync with sim/terra.js SG_SPEC.
const FOOT_R = { village: 9, town: 20, city: 46, capital: 54 };
function ringR(tier, pclass) { return (FOOT_R[tier] != null ? FOOT_R[tier] : FOOT_R.village) + (PATROL_LEASH[pclass] || 8); }
const PATROL_SPEED = 5;      // map units per tick — MIDDLE speed (packs wander at nothing, hosts march at 6)
const MUSTER_CD = 4;         // ticks between replacement patrols at one settlement
const DEFEND_R = 13;         // an enemy this close to home pulls every patrol onto it

// ---- roaming focus: patrols walk the whole realm they hold, not one fixed ring ----
const PATROL_VISIT_CHANCE = 0.18;                          // odds a re-pick rides a company out (LOW: the bulk of a garrison keeps to its own walls)
const PATROL_VISIT_R = { large: 70, medium: 40, small: 0 }; // how far each class ranges to visit (small watches stay home)
const VISIT_DWELL = [5, 11];                               // ticks a visit lasts — short sorties, so companies don't pile up out at one hold
const HOME_DWELL  = [6, 14];                               // ticks a home spell lasts (kept short so they keep circulating)
// how many VISITORS (home roster excluded) a hold will draw, by tier — a village/town must never
// look better-guarded than the city that garrisons it, so small holds cap hard; big holds don't need one.
const VISIT_CAP = { capital: 99, city: 99, town: 2, village: 1 };
// a faction's "lands": within this of one of its settlements (bigger holds project further, echoing the
// territory overlay). Drives who a patrol FIGHTS (enemy on our soil) vs merely TURNS BACK (neutral column).
const LANDS_R = { capital: 60, city: 36, town: 26, village: 18 };
const LEAVE_CD = 8;                                        // ticks before we re-announce turning one column back
const NUDGE = 3;                                           // units a shadowed neutral column is shoved toward the border

// ---- campaigns ----
const CAMP = {
  MAX_ACTIVE: 2,             // world-wide cap on simultaneous campaigns
  CHANCE: 0.012,             // per-tick chance the rolled faction launches one (rare by design)
  MIN_LEAD: 16,              // a host must be at least this strong to call the banners
  TARGET_R: 75,              // how far a leader looks for a settlement worth taking
  CALL_PATROL_R: 45,         // patrols within this of the muster point answer the call
  ALLY_HOST_R: 65,           // allied-realm hosts within this of the muster answer
  MAX_MEMBERS: 8,
  MUSTER_R: 9,               // gathered when every banner is inside this
  MUSTER_TIMEOUT: 18,        // ticks before the stack marches with whoever came
  ARRIVE_R: 8,               // the stack is "at the walls" inside this
  MARCH_SPEED: 5,
  RELIEF_R: 55,              // defenders this close to the hold can ride to its relief
  RELIEF_THRESH: 0.6,        // defend if defense >= this fraction of the attacker's strength
};

// ---- battles ----
const CLASH_RANGE = 9;       // matches tick.js — armies this close can lock swords
const ENGAGE_CHANCE = 0.55;  // meeting rivals sometimes glare and pass
const BIG_BATTLE = 60;       // combined strength that earns the LARGE crossed-swords marker

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function pick(a) { return a[(Math.random() * a.length) | 0]; }
const GNAMES = ['Aldric','Bram','Cedwyn','Doran','Eadric','Falk','Garrec','Hale','Ivo','Joren','Kell','Lorne','Maddoc','Nael','Osric','Perrin','Roderic','Sefton','Tomas','Ulf','Varin','Wend','Yorin','Edra','Freya','Gerda','Halla','Ingrid','Kara','Linnet','Mira','Nessa','Orla','Petra','Romilda','Sigrun','Thora'];
const BYN = ['the Bold','the Grim','Ironhand','Oakheart','the Swift','Stonefist','Redmane','Hawkeye','the Tall','Wolfsbane','the Sly','Brightblade','Frostbeard','Stormcrow','the Fierce','the Quiet','Greycloak'];
function genName() { return pick(GNAMES) + (Math.random() < 0.6 ? ' ' + pick(BYN) : ''); }
function capPos(idx) { const a = CAP_ANGLE[idx] != null ? CAP_ANGLE[idx] : idx / NATIONS.length * Math.PI * 2; return { x: Math.cos(a) * CAP_RADIUS, z: Math.sin(a) * CAP_RADIUS }; }
function ev(worldId, tick, type, summary) { db.prepare('INSERT INTO world_events(world_id, tick, type, summary) VALUES (?,?,?,?)').run(worldId, tick, type, summary); }
function isNation(name) { return NATIONS.indexOf(name) >= 0; }
// ambient rivalry (mirrors the client's areAmbientRivals): anyone not bound by pact is a fair
// TARGET — this drives campaign target choice, so wars can reignite out of a drifted peace.
function rivalable(relMap, a, b) {
  if (a === b || a === PLAYER || b === PLAYER) return false;
  if (!isNation(a) || !isNation(b)) return true;
  const st = D.stanceBetween(relMap, a, b);
  return st !== 'alliance' && st !== 'nonaggression';
}
// but swords only come OUT for a declared enemy — otherwise neutral patrol circuits overlap in a
// tense peace instead of grinding every border village into a permanent battle. (Conquest shocks
// from campaigns tip stances into war, and then these same patrols fight for real.)
function combatEnemies(relMap, a, b) {
  if (a === b || a === PLAYER || b === PLAYER) return false;
  if (!isNation(a) || !isNation(b)) return false;         // militia is defensive-only (see defendersProvoked)
  return WorldSim.areEnemies(D.stanceBetween(relMap, a, b));
}
const HOME_SANCTUM = 8;   // a non-pact intruder this close to the walls provokes the watch, war or no war
function defendingHome(relMap, p, o) {
  return p.home_x != null && rivalable(relMap, p.faction, o.faction) &&
    Math.hypot(o.x - p.home_x, o.z - p.home_z) < HOME_SANCTUM;
}
function tseedOf(worldId) { const tp = Chunks.tseedParams(worldId); return tp ? tp.tseed : null; }

// every settlement the war can touch: generated holds (current terrain) + the five capitals
function settlements(worldId) {
  const out = [];
  const ts = tseedOf(worldId);
  if (ts != null) for (const h of db.prepare('SELECT * FROM holds WHERE world_id=? AND tseed=?').all(worldId, ts))
    out.push({ src: 'hold', id: h.id, key: h.cx + ',' + h.cz + ',' + h.idx, name: h.name, tier: h.tier, x: h.x, z: h.z, owner: h.owner_name, garrison: h.garrison, lastMuster: h.last_muster_tick });
  for (const c of db.prepare('SELECT * FROM capitals WHERE world_id=?').all(worldId)) {
    const p = capPos(c.idx);
    out.push({ src: 'cap', id: c.id, key: 'cap:' + c.idx, name: c.def_name, tier: 'capital', x: p.x, z: p.z, owner: c.owner_name, garrison: c.garrison, lastMuster: c.last_muster_tick });
  }
  return out;
}

// ---------- PATROLS ----------
function quotaFor(s) {
  if (s.owner === PLAYER) return null;                        // the player raises their own armies
  if (s.owner === FREE) return MILITIA_QUOTA[s.tier] || MILITIA_QUOTA.village;  // masterless — a town watch only
  return QUOTA[s.tier] || QUOTA.village;                      // the five nations AND emergent frontier realms keep a full garrison
}
function spawnPatrol(worldId, tick, s, pclass) {
  const sz = PATROL_SIZE[pclass], R = ringR(s.tier, pclass);
  const a = rand(0, Math.PI * 2), r = rand(R * 0.82, R);   // stand up ON the circuit, outside the walls
  const pers = { ambition: +rand(0, 0.5).toFixed(2), caution: +rand(0.3, 1).toFixed(2), loyalty: +rand(0.5, 1).toFixed(2), vengeance: +rand(0, 1).toFixed(2) };
  db.prepare(`INSERT INTO warlords(world_id, name, faction, archetype, skills_json, renown, size, x, z, born_tick,
      personality_json, loyalty, role, pclass, home_key, home_x, home_z)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(worldId, genName(), s.owner, 'longsword', JSON.stringify({ strike: Math.random() * 10, lead: Math.random() * 4 }),
      Math.random() * 6, Math.round(rand(sz[0], sz[1])),
      clamp(s.x + Math.cos(a) * r, -MAP_HALF, MAP_HALF), clamp(s.z + Math.sin(a) * r, -MAP_HALF, MAP_HALF), tick,
      JSON.stringify(pers), Math.round(pers.loyalty * 100), 'patrol', pclass, s.key, s.x, s.z);
}
// keep every settlement's roster at quota: a bare settlement musters its FULL complement at once
// (first deploy / freshly explored ground), an attrited one raises a replacement every MUSTER_CD.
function ensurePatrols(worldId, tick) {
  const byHome = new Map(); // 'key|faction|pclass' -> n — only the CURRENT owner's patrols count toward quota
  const rows = db.prepare(`SELECT home_key, faction, pclass, count(*) n FROM warlords
    WHERE world_id=? AND status='alive' AND role='patrol' GROUP BY home_key, faction, pclass`).all(worldId);
  for (const r of rows) byHome.set(r.home_key + '|' + r.faction + '|' + r.pclass, r.n);
  const bumpHold = db.prepare('UPDATE holds SET last_muster_tick=? WHERE id=?');
  const bumpCap = db.prepare('UPDATE capitals SET last_muster_tick=? WHERE id=?');
  for (const s of settlements(worldId)) {
    const q = quotaFor(s);
    if (!q) continue;
    const have = (c) => byHome.get(s.key + '|' + s.owner + '|' + c) || 0;
    const total = have('large') + have('medium') + have('small');
    const wantTotal = q.large + q.medium + q.small;
    if (!wantTotal || total >= wantTotal) continue;
    const missing = [];
    for (const c of ['large', 'medium', 'small']) for (let i = have(c); i < q[c]; i++) missing.push(c);
    const burst = total === 0;                          // virgin ground: the full complement stands up at once
    if (!burst && tick - s.lastMuster < MUSTER_CD) continue;
    const n = burst ? missing.length : 1;
    for (let i = 0; i < n; i++) spawnPatrol(worldId, tick, s, missing[i]);
    (s.src === 'cap' ? bumpCap : bumpHold).run(tick, s.id);
  }
}

// spatial grid over the armies for cheap neighborhood queries (rebuilt each tick)
const CELL = 12;
function buildGrid(armies) {
  const g = new Map();
  for (const a of armies) {
    const k = ((a.x / CELL) | 0) + ':' + ((a.z / CELL) | 0);
    let arr = g.get(k); if (!arr) g.set(k, arr = []);
    arr.push(a);
  }
  return g;
}
function nearGrid(grid, x, z, r, fn) {
  const c0x = ((x - r) / CELL) | 0, c1x = ((x + r) / CELL) | 0, c0z = ((z - r) / CELL) | 0, c1z = ((z + r) / CELL) | 0;
  for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
    const arr = grid.get(cx + ':' + cz);
    if (arr) for (const o of arr) fn(o);
  }
}

// ---- territory + roam helpers ----
// settlements grouped by owning faction — a realm's holdings drive both roam targets and "in our lands"
function byOwner(setts) {
  const m = new Map();
  for (const s of setts) { let a = m.get(s.owner); if (!a) m.set(s.owner, a = []); a.push(s); }
  return m;
}
function inLands(ownByFaction, faction, x, z) {
  const list = ownByFaction.get(faction); if (!list) return false;
  for (const s of list) { const r = LANDS_R[s.tier] || 24; if ((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) <= r * r) return true; }
  return false;
}
function nearestOwned(ownByFaction, faction, x, z) {
  const list = ownByFaction.get(faction); if (!list) return null;
  let best = null, bd = Infinity;
  for (const s of list) { const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z); if (d < bd) { bd = d; best = s; } }
  return best;
}
// a column riding our ground that is NOT a declared enemy: same realm + pact-bound neighbours are waved
// through (friends), everyone else is a neutral to be turned back. (enemies are the combatEnemies path.)
function neutralIntruder(relMap, p, o) {
  if (o.faction === p.faction || o.faction === PLAYER) return false;      // kin, and the player (client hails them)
  if (combatEnemies(relMap, p.faction, o.faction)) return false;          // enemy -> attacked, not asked to leave
  if (isNation(p.faction) && isNation(o.faction)) {
    const st = D.stanceBetween(relMap, p.faction, o.faction);
    if (st === 'alliance' || st === 'nonaggression') return false;        // friend -> let pass
  }
  return true;
}
// re-pick a patrol's circuit centre: usually its home city's own borders, sometimes a ride out to a
// nearby OWNED village/castle/town it also guards. Small watches never leave the walls. A per-hold
// visitor cap (VISIT_CAP) keeps rovers from piling onto one small hold and out-garrisoning its city.
function repickFocus(tick, p, ownList, visitorCount) {
  const range = PATROL_VISIT_R[p.pclass] || 0;
  let target = null;
  if (range > 0 && ownList && ownList.length && Math.random() < PATROL_VISIT_CHANCE) {
    const cand = [];
    for (const s of ownList) {
      if (s.key === p.home_key) continue;                                 // "visit" means somewhere other than home
      const d = Math.hypot(s.x - p.home_x, s.z - p.home_z);
      if (d <= 0 || d > range) continue;
      const cap = VISIT_CAP[s.tier] != null ? VISIT_CAP[s.tier] : 2;
      if ((visitorCount.get(s.key) || 0) >= cap) continue;                // this hold already has its fill of guests
      cand.push(s);
    }
    if (cand.length) target = pick(cand);
  }
  const old = p.focus_key;
  if (target) { p.focus_key = target.key; p.focus_x = target.x; p.focus_z = target.z; p.focus_until = tick + Math.round(rand(VISIT_DWELL[0], VISIT_DWELL[1])); }
  else { p.focus_key = p.home_key; p.focus_x = p.home_x; p.focus_z = p.home_z; p.focus_until = tick + Math.round(rand(HOME_DWELL[0], HOME_DWELL[1])); }
  // keep the live visitor tally in step so companies re-picking on the SAME tick spread out instead of clumping
  if (old && old !== p.home_key) visitorCount.set(old, Math.max(0, (visitorCount.get(old) || 0) - 1));
  if (p.focus_key !== p.home_key) visitorCount.set(p.focus_key, (visitorCount.get(p.focus_key) || 0) + 1);
}
const _leaveCd = new Map(); // 'worldId:hostId' -> tick until which we won't re-announce a turn-back
// a neutral column on our soil is shadowed by the watch and shoved back toward the border — no blood.
function askToLeave(worldId, tick, patrol, host, ownByFaction, nudged, upd) {
  patrol.tx = host.x; patrol.tz = host.z;                                 // the watch rides over to see them off
  if (nudged.has(host.id)) return;                                        // one shove per tick, however many watches spot them
  nudged.add(host.id);
  const near = nearestOwned(ownByFaction, patrol.faction, host.x, host.z);
  if (!near) return;
  let ox = host.x - near.x, oz = host.z - near.z; const on = Math.hypot(ox, oz) || 1;
  host.x = clamp(host.x + ox / on * NUDGE, -MAP_HALF, MAP_HALF);
  host.z = clamp(host.z + oz / on * NUDGE, -MAP_HALF, MAP_HALF);
  host.tx = clamp(host.x + ox / on * 20, -MAP_HALF, MAP_HALF);            // and their march is turned back outward
  host.tz = clamp(host.z + oz / on * 20, -MAP_HALF, MAP_HALF);
  upd.run(host.x, host.z, host.tx, host.tz, host.focus_x, host.focus_z, host.focus_key, host.focus_until, host.id);
  const key = worldId + ':' + host.id;
  if ((_leaveCd.get(key) || 0) <= tick && Math.random() < 0.25) {
    _leaveCd.set(key, tick + LEAVE_CD);
    ev(worldId, tick, 'turned_back', 'The watch of ' + near.name + ' turns a ' + host.faction + ' column back from ' + patrol.faction + ' lands');
  }
}

// patrols ride circuits around a ROAMING FOCUS (home most of the time, a nearby owned hold sometimes);
// an enemy on our soil is chased down, a neutral column is turned back, a friend is let pass.
function tickPatrols(worldId, tick, armies, relMap, busy, steered, grid, ownByFaction, nudged, visitorCount, settTier) {
  const upd = db.prepare('UPDATE warlords SET x=?, z=?, tx=?, tz=?, focus_x=?, focus_z=?, focus_key=?, focus_until=? WHERE id=?');
  for (const p of armies) {
    if (p.role !== 'patrol' || busy.has(p.id) || steered.has(p.id)) continue;
    if (p.home_x == null) continue;
    // every once in a while the server re-picks where this company patrols (see repickFocus)
    if (p.focus_x == null || p.focus_until <= tick) repickFocus(tick, p, ownByFaction.get(p.faction), visitorCount);
    // the circuit wraps the walls of whatever settlement the company is posted to (home or a visit)
    const focusTier = (settTier && (settTier.get(p.focus_key) || settTier.get(p.home_key))) || 'town';
    const fx = p.focus_x, fz = p.focus_z, leash = ringR(focusTier, p.pclass);
    const scanR = DEFEND_R + leash;
    // scan the ground the company actually holds (around its post) for intruders
    let threat = null, td = scanR * scanR;
    nearGrid(grid, p.x, p.z, scanR, (o) => {
      if (o.id === p.id) return;
      if (combatEnemies(relMap, p.faction, o.faction)) {
        // an ENEMY army (patrol OR host) on our soil, or bearing on either home — run it down; the
        // fight itself locks in meetClashes once they close to sword-range
        if (inLands(ownByFaction, p.faction, o.x, o.z) || defendingHome(relMap, p, o) || defendingHome(relMap, o, p)) {
          const d = (o.x - p.x) * (o.x - p.x) + (o.z - p.z) * (o.z - p.z);
          if (d < td) { td = d; threat = o; }
        }
        return;
      }
      // a non-enemy raider/free company actually AT our walls still forms up the watch (militia defence)
      if (defendingHome(relMap, p, o) && !(isNation(p.faction) && isNation(o.faction))) {
        const d = (o.x - p.x) * (o.x - p.x) + (o.z - p.z) * (o.z - p.z);
        if (d < td) { td = d; threat = o; }
        return;
      }
      // a NEUTRAL peer column wandering our lands — shadow it and turn it back (no blood)
      if (o.role === 'host' && !busy.has(o.id) && !steered.has(o.id) &&
          neutralIntruder(relMap, p, o) && inLands(ownByFaction, p.faction, o.x, o.z)) {
        askToLeave(worldId, tick, p, o, ownByFaction, nudged, upd);
      }
    });
    if (threat) { p.tx = threat.x; p.tz = threat.z; }
    else if (Math.hypot(p.x - fx, p.z - fz) > leash + 3) {
      p.tx = fx; p.tz = fz;                                               // riding out to a new post (a village/castle visit)
    } else {
      // ride the PERIMETER of the focus: a step further around the ring in the fixed circling sense, so
      // the watch visibly orbits its walls/borders instead of pin-balling in and out.
      const bearing = Math.atan2(p.z - fz, p.x - fx);
      const dir = (p.id % 2) ? 1 : -1;                                    // half circle each way (stable per warlord)
      const a = bearing + dir * 0.9;                                      // ~50° of arc per waypoint
      p.tx = clamp(fx + Math.cos(a) * leash, -MAP_HALF, MAP_HALF);
      p.tz = clamp(fz + Math.sin(a) * leash, -MAP_HALF, MAP_HALF);
    }
    const dx = p.tx - p.x, dz = p.tz - p.z, d = Math.hypot(dx, dz) || 1, step = Math.min(PATROL_SPEED, d);
    p.x = clamp(p.x + dx / d * step + rand(-0.4, 0.4), -MAP_HALF, MAP_HALF);
    p.z = clamp(p.z + dz / d * step + rand(-0.4, 0.4), -MAP_HALF, MAP_HALF);
    upd.run(p.x, p.z, p.tx, p.tz, p.focus_x, p.focus_z, p.focus_key, p.focus_until, p.id);
  }
}

// ---------- TIMED BATTLES ----------
function rowsByIds(worldId, ids) {
  if (!ids.length) return [];
  const get = db.prepare("SELECT * FROM warlords WHERE world_id=? AND id=? AND status='alive'");
  const out = [];
  for (const id of ids) { const r = get.get(worldId, id); if (r) out.push(r); }
  return out;
}
function aggBand(rows, extra) {
  let size = extra || 0, best = null;
  for (const r of rows) { size += r.size; if (!best || r.renown > best.renown) best = r; }
  return { size, quality: 1.05, leader: { skills: best ? JSON.parse(best.skills_json || '{}') : { strike: 4, lead: 1 }, renown: best ? best.renown : 0 } };
}
function pinTo(worldId, rows, x, z) {
  const upd = db.prepare('UPDATE warlords SET x=?, z=?, tx=?, tz=? WHERE id=?');
  for (const r of rows) upd.run(x + rand(-1.5, 1.5), z + rand(-1.5, 1.5), x, z, r.id);
}
function startBattle(worldId, tick, o) {
  const aRows = rowsByIds(worldId, o.aIds), bRows = rowsByIds(worldId, o.bIds);
  const A = aggBand(aRows, 0), B = aggBand(bRows, o.bGarrison || 0);
  if (A.size <= 0 || B.size <= 0) return null;
  const r = WorldSim.resolveClash(A, B, Math.random);
  const aEnd = Math.max(0, A.size - (r.aWins ? r.winnerLoss : r.loserLoss));
  const bEnd = Math.max(0, B.size - (r.aWins ? r.loserLoss : r.winnerLoss));
  const total = A.size + B.size;
  const dur = clamp(2 + Math.round(0.55 * Math.sqrt(total)), 2, 24);
  const big = total >= BIG_BATTLE ? 1 : 0;
  const info = db.prepare(`INSERT INTO sbattles(world_id, x, z, kind, big, campaign_id, hold_key, hold_name,
      a_faction, b_faction, a_ids_json, b_ids_json, b_garrison,
      a_start, b_start, a_end, b_end, a_str, b_str, a_wins, started_tick, ends_tick)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(worldId, o.x, o.z, o.kind || 'field', big, o.campaignId || null, o.holdKey || null, o.holdName || null,
      A.size ? (aRows[0] ? aRows[0].faction : 'Unknown') : 'Unknown', bRows[0] ? bRows[0].faction : (o.bFaction || 'Garrison'),
      JSON.stringify(aRows.map(x => x.id)), JSON.stringify(bRows.map(x => x.id)), o.bGarrison || 0,
      A.size, B.size, aEnd, bEnd, A.size, B.size, r.aWins ? 1 : 0, tick, tick + dur);
  pinTo(worldId, aRows.concat(bRows), o.x, o.z);
  if (big) ev(worldId, tick, 'battle_joined', (aRows[0] ? aRows[0].faction : '?') + ' and ' + (bRows[0] ? bRows[0].faction : (o.bFaction || 'the garrison')) +
    ' meet in a great battle' + (o.holdName ? ' before the walls of ' + o.holdName : '') + ' — ' + Math.round(total) + ' souls in the field');
  return info.lastInsertRowid;
}
// meeting rivals lock into a visible battle instead of resolving instantly.
// A short post-battle cooldown (in-memory; a restart just forgets it, harmless) stops the winner
// chain-fighting through a settlement's whole patrol roster tick after tick.
const _clashCd = new Map(); // 'worldId:armyId' -> tick this army may fight again
const CLASH_COOLDOWN = 3;
function cdKey(worldId, id) { return worldId + ':' + id; }
function onCooldown(worldId, tick, id) { return (_clashCd.get(cdKey(worldId, id)) || 0) > tick; }
function setCooldown(worldId, tick, ids) { for (const id of ids) _clashCd.set(cdKey(worldId, id), tick + CLASH_COOLDOWN); }
function meetClashes(worldId, tick, armies, relMap, busy, grid, ownByFaction) {
  const used = new Set();
  for (const a of armies) {
    if (busy.has(a.id) || used.has(a.id) || onCooldown(worldId, tick, a.id)) continue;
    let foe = null, fd = CLASH_RANGE * CLASH_RANGE;
    nearGrid(grid, a.x, a.z, CLASH_RANGE, (o) => {
      if (o.id === a.id || busy.has(o.id) || used.has(o.id) || onCooldown(worldId, tick, o.id)) return;
      if (combatEnemies(relMap, a.faction, o.faction)) {
        // enemies draw swords when one stands on OWNED SOIL (either realm's lands) or has breached a
        // wall — a patrol fights any enemy, patrol OR host, that rides into its country. Only two
        // enemies meeting in true no-man's-land pass, unless a roaming HOST is hunting the war there.
        const onSoil = inLands(ownByFaction, a.faction, o.x, o.z) || inLands(ownByFaction, o.faction, a.x, a.z)
          || defendingHome(relMap, a, o) || defendingHome(relMap, o, a);
        if (!onSoil) {
          if (a.role === 'patrol' && o.role === 'patrol') return;          // two patrols pass in the open
          const patrol = a.role === 'patrol' ? a : (o.role === 'patrol' ? o : null);
          if (patrol) return;                                              // a patrol won't chase a host off its lands
        }
      } else {
        // not declared enemies: neutrals are TURNED BACK (tickPatrols), never fought. Only a non-nation
        // raider actually breaching a wall still provokes the old defensive militia watch.
        const breach = defendingHome(relMap, a, o) || defendingHome(relMap, o, a);
        if (!breach) return;
        if (isNation(a.faction) && isNation(o.faction)) return;            // two nations at peace: escorted off, not fought
      }
      const d = (o.x - a.x) * (o.x - a.x) + (o.z - a.z) * (o.z - a.z);
      if (d < fd) { fd = d; foe = o; }
    });
    if (!foe || Math.random() > ENGAGE_CHANCE) continue;
    used.add(a.id); used.add(foe.id);
    const id = startBattle(worldId, tick, { x: (a.x + foe.x) / 2, z: (a.z + foe.z) / 2, kind: 'field', aIds: [a.id], bIds: [foe.id] });
    if (id != null) { busy.add(a.id); busy.add(foe.id); }
  }
}
function activeBattles(worldId) { return db.prepare('SELECT * FROM sbattles WHERE world_id=? AND done=0').all(worldId); }
function busySet(worldId) {
  const s = new Set();
  for (const b of activeBattles(worldId)) {
    for (const id of JSON.parse(b.a_ids_json)) s.add(id);
    for (const id of JSON.parse(b.b_ids_json)) s.add(id);
  }
  return s;
}
function creditWinners(worldId, tick, rows, end, loserStart, loserLoss) {
  if (!rows.length) return;
  let total = 0; for (const r of rows) total += r.size;
  let best = rows[0]; for (const r of rows) if (r.renown > best.renown) best = r;
  const upd = db.prepare('UPDATE warlords SET size=?, renown=?, battles_won=battles_won+?, kills=kills+? WHERE id=?');
  for (const r of rows) {
    const share = total > 0 ? r.size / total : 1 / rows.length;
    const lead = r.id === best.id;
    upd.run(Math.max(1, Math.round(end * share)), r.renown + (lead ? 3 + 0.12 * loserStart : 1), lead ? 1 : 0, Math.round(loserLoss * share), r.id);
  }
}
function breakLosers(worldId, tick, rows, winnerName) {
  const fall = db.prepare("UPDATE warlords SET status='fallen', died_tick=?, size=? WHERE id=?");
  for (const r of rows) {
    fall.run(tick, 0, r.id);
    if (r.role === 'host' && r.renown >= 40) ev(worldId, tick, 'leader_fell', r.name + ' of ' + r.faction + ' fell to ' + winnerName);
  }
}
// a hold changed hands (siege OR the ordinary contest path in tick.js): the old owner's patrols
// won't serve the conqueror. A LARGE company has the weight to turn free host and take to the
// field; the small and middling watches melt away (else every flip mints feral armies and the
// world snowballs into a meat grinder — measured: 25 flips bred 100+ wandering hosts).
function orphanPatrols(worldId, key, newFaction) {
  db.prepare("UPDATE warlords SET role='host', home_key=NULL, home_x=NULL, home_z=NULL WHERE world_id=? AND status='alive' AND role='patrol' AND pclass='large' AND home_key=? AND faction!=?")
    .run(worldId, key, newFaction);
  db.prepare("UPDATE warlords SET status='fallen', size=0 WHERE world_id=? AND status='alive' AND role='patrol' AND home_key=? AND faction!=?")
    .run(worldId, key, newFaction);
}
function flipHold(worldId, tick, key, name, newFaction, newGarrison) {
  const m = /^(-?\d+),(-?\d+),(\d+)$/.exec(key);
  let oldOwner = null;
  if (m) {
    const ts = tseedOf(worldId);
    if (ts == null) return;
    const row = db.prepare('SELECT * FROM holds WHERE world_id=? AND tseed=? AND cx=? AND cz=? AND idx=?').get(worldId, ts, +m[1], +m[2], +m[3]);
    if (!row) return;
    oldOwner = row.owner_name;
    db.prepare('UPDATE holds SET owner_name=?, garrison=? WHERE id=?').run(newFaction, newGarrison, row.id);
    db.prepare('UPDATE holdings SET owner_name=?, updated_at=unixepoch() WHERE world_id=? AND hold_key=?').run(newFaction, worldId, key);
  } else {
    const idx = +(key.split(':')[1] || -1);
    const cap = db.prepare('SELECT * FROM capitals WHERE world_id=? AND idx=?').get(worldId, idx);
    if (!cap) return;
    oldOwner = cap.owner_name;
    db.prepare('UPDATE capitals SET owner_name=?, garrison=? WHERE id=?').run(newFaction, newGarrison, cap.id);
  }
  // the fallen lord's household troops won't serve the conqueror — they take to the field
  orphanPatrols(worldId, key, newFaction);
  ev(worldId, tick, m ? 'hold_taken' : 'capital_taken', newFaction + ' storms ' + name + (oldOwner && oldOwner !== newFaction ? ', wrested from ' + oldOwner : ''));
  if (oldOwner && isNation(oldOwner) && isNation(newFaction) && oldOwner !== newFaction)
    D.bumpRelation(worldId, oldOwner, newFaction, -(m ? Math.round(D.CONQUEST_SHOCK * 0.4) : D.CONQUEST_SHOCK), tick);
}
function tickBattles(worldId, tick) {
  const updStr = db.prepare('UPDATE sbattles SET a_str=?, b_str=?, a_ids_json=?, b_ids_json=? WHERE id=?');
  const finish = db.prepare('UPDATE sbattles SET done=1, a_str=?, b_str=? WHERE id=?');
  for (const b of activeBattles(worldId)) {
    let aRows = rowsByIds(worldId, JSON.parse(b.a_ids_json));
    let bRows = rowsByIds(worldId, JSON.parse(b.b_ids_json));
    const bStrength = bRows.length + (b.b_garrison > 0 ? 1 : 0);
    // a side emptied out from outside (the player broke it in person) — the field is forfeit
    let frac = clamp((tick - b.started_tick) / Math.max(1, b.ends_tick - b.started_tick), 0, 1);
    let aWins = !!b.a_wins;
    if (!aRows.length) { frac = 1; aWins = false; }
    else if (!bStrength) { frac = 1; aWins = true; }
    if (frac < 1) {
      const aStr = lerp(b.a_start, b.a_end, frac), bStr = lerp(b.b_start, b.b_end, frac);
      updStr.run(aStr, bStr, JSON.stringify(aRows.map(x => x.id)), JSON.stringify(bRows.map(x => x.id)), b.id);
      pinTo(worldId, aRows.concat(bRows), b.x, b.z);
      continue;
    }
    // ---- resolve ----
    const winRows = aWins ? aRows : bRows, losRows = aWins ? bRows : aRows;
    const winEnd = Math.max(1, aWins ? b.a_end : b.b_end);
    const losStart = aWins ? b.b_start : b.a_start;
    const losLoss = losStart - (aWins ? b.b_end : b.a_end);
    const winnerName = winRows.length ? winRows[0].name : (aWins ? b.a_faction : b.b_faction);
    creditWinners(worldId, tick, winRows, winEnd, losStart, Math.max(0, losLoss));
    breakLosers(worldId, tick, losRows, winnerName);
    setCooldown(worldId, tick, winRows.map(r => r.id)); // the bloodied victors regroup before the next fight
    if (b.kind === 'siege' && b.hold_key) {
      if (aWins) flipHold(worldId, tick, b.hold_key, b.hold_name || 'the hold', b.a_faction, Math.max(2, Math.round(winEnd * 0.4)));
      else ev(worldId, tick, 'siege_broken', 'The siege of ' + (b.hold_name || 'the hold') + ' is broken — ' + b.b_faction + ' holds the walls');
    } else if (b.big) {
      ev(worldId, tick, 'battle_won', (aWins ? b.a_faction : b.b_faction) + ' carries the field against ' + (aWins ? b.b_faction : b.a_faction));
    }
    if (b.campaign_id) db.prepare("UPDATE campaigns SET stage='done', done=1 WHERE id=?").run(b.campaign_id);
    finish.run(aWins ? winEnd : 0, aWins ? 0 : winEnd, b.id);
  }
}

// ---------- CAMPAIGNS ----------
function activeCampaigns(worldId) { return db.prepare('SELECT * FROM campaigns WHERE world_id=? AND done=0').all(worldId); }
function campaignSteered(worldId) {
  const s = new Set();
  for (const c of activeCampaigns(worldId)) {
    for (const id of JSON.parse(c.members_json)) s.add(id);
    for (const id of JSON.parse(c.relief_json)) s.add(id);
  }
  return s;
}
function stepToward(upd, r, tx, tz, speed) {
  const dx = tx - r.x, dz = tz - r.z, d = Math.hypot(dx, dz) || 1, step = Math.min(speed, d);
  r.x = clamp(r.x + dx / d * step + rand(-0.5, 0.5), -MAP_HALF, MAP_HALF);
  r.z = clamp(r.z + dz / d * step + rand(-0.5, 0.5), -MAP_HALF, MAP_HALF);
  upd.run(r.x, r.z, tx, tz, r.id);
}
function targetOwner(worldId, c) {
  const m = /^(-?\d+),(-?\d+),(\d+)$/.exec(c.target_key);
  if (m) {
    const ts = tseedOf(worldId);
    const row = ts == null ? null : db.prepare('SELECT owner_name, garrison FROM holds WHERE world_id=? AND tseed=? AND cx=? AND cz=? AND idx=?').get(worldId, ts, +m[1], +m[2], +m[3]);
    return row ? { owner: row.owner_name, garrison: row.garrison } : null;
  }
  const cap = db.prepare('SELECT owner_name, garrison FROM capitals WHERE world_id=? AND idx=?').get(worldId, +(c.target_key.split(':')[1] || -1));
  return cap ? { owner: cap.owner_name, garrison: cap.garrison } : null;
}
// the defender weighs the balance of power: ride to the relief, or leave the hold to its fate
function decideDefense(worldId, tick, c, armies, busy) {
  const t = targetOwner(worldId, c);
  if (!t) return { defense: 'abandoned', relief: [] };
  const members = new Set(JSON.parse(c.members_json));
  let atk = 0;
  for (const a of armies) if (members.has(a.id)) atk += a.size;
  const relief = [];
  let def = t.garrison;
  if (isNation(t.owner)) {
    for (const a of armies) {
      if (a.faction !== t.owner || busy.has(a.id) || members.has(a.id)) continue;
      const d = Math.hypot(a.x - c.target_x, a.z - c.target_z);
      if (d <= CAMP.RELIEF_R) { def += a.size; relief.push(a.id); }
      if (relief.length >= CAMP.MAX_MEMBERS) break;
    }
  }
  if (def >= atk * CAMP.RELIEF_THRESH && relief.length) {
    ev(worldId, tick, 'relief_march', t.owner + ' rides to the relief of ' + c.target_name + ' — ' + relief.length + ' banners answer');
    return { defense: 'relief', relief };
  }
  if (isNation(t.owner)) ev(worldId, tick, 'hold_abandoned', t.owner + ' weighs the odds and leaves ' + c.target_name + ' to its fate');
  return { defense: 'abandoned', relief: [] };
}
function tickCampaigns(worldId, tick, armies, relMap, busy) {
  const byId = new Map(armies.map(a => [a.id, a]));
  const upd = db.prepare('UPDATE warlords SET x=?, z=?, tx=?, tz=? WHERE id=?');
  const save = db.prepare('UPDATE campaigns SET stage=?, members_json=?, relief_json=?, defense=?, stage_tick=?, done=? WHERE id=?');
  for (const c of activeCampaigns(worldId)) {
    let members = JSON.parse(c.members_json).filter(id => byId.has(id));
    let relief = JSON.parse(c.relief_json).filter(id => byId.has(id));
    let { stage, defense } = c, done = 0, stageTick = c.stage_tick;
    const leader = byId.get(c.leader_id);
    if (!leader || !members.length) {                       // the head is cut off — the war party scatters
      ev(worldId, tick, 'campaign_broken', 'The banners called against ' + c.target_name + ' scatter, leaderless');
      save.run('done', JSON.stringify(members), JSON.stringify(relief), defense, tick, 1, c.id);
      continue;
    }
    if (stage === 'muster') {
      let gathered = true;
      for (const id of members) {
        const r = byId.get(id);
        if (busy.has(id)) continue;
        const d = Math.hypot(r.x - c.muster_x, r.z - c.muster_z);
        if (d > CAMP.MUSTER_R) { gathered = false; stepToward(upd, r, c.muster_x, c.muster_z, CAMP.MARCH_SPEED); }
      }
      if (gathered || tick - stageTick > CAMP.MUSTER_TIMEOUT) {
        stage = 'march'; stageTick = tick;
        let strength = 0; for (const id of members) strength += byId.get(id).size;
        ev(worldId, tick, 'campaign_march', 'The host of ' + c.faction + ' marches on ' + c.target_name + ' under ' + leader.name + ' — ' + Math.round(strength) + ' spears');
        if (defense === 'pending') {
          const d = decideDefense(worldId, tick, c, armies, busy);
          defense = d.defense; relief = d.relief;
        }
      }
    } else if (stage === 'march') {
      for (const id of members) {
        const r = byId.get(id);
        if (busy.has(id)) continue;
        stepToward(upd, r, id === leader.id ? c.target_x : leader.x, id === leader.id ? c.target_z : leader.z, CAMP.MARCH_SPEED);
      }
      for (const id of relief) { const r = byId.get(id); if (!busy.has(id)) stepToward(upd, r, c.target_x, c.target_z, CAMP.MARCH_SPEED); }
      if (Math.hypot(leader.x - c.target_x, leader.z - c.target_z) <= CAMP.ARRIVE_R) {
        stage = 'siege'; stageTick = tick;
        const t = targetOwner(worldId, c) || { owner: 'Garrison', garrison: 4 };
        const defendersUp = relief.filter(id => { const r = byId.get(id); return r && Math.hypot(r.x - c.target_x, r.z - c.target_z) <= 20; });
        const bid = startBattle(worldId, tick, {
          x: c.target_x, z: c.target_z, kind: 'siege', campaignId: c.id,
          holdKey: c.target_key, holdName: c.target_name,
          aIds: members, bIds: defendersUp, bGarrison: t.garrison, bFaction: t.owner,
        });
        if (bid == null) { done = 1; stage = 'done'; }      // nothing left to fight — fizzle
        else ev(worldId, tick, 'siege_laid', c.faction + ' lays siege to ' + c.target_name +
          (defense === 'relief' ? ' — the defenders stand before the walls' : defense === 'abandoned' && isNation(t.owner) ? ' — abandoned to its garrison' : ''));
      }
    } // 'siege' resolves through its battle (tickBattles marks the campaign done)
    save.run(stage, JSON.stringify(members), JSON.stringify(relief), defense, stageTick, done, c.id);
  }
}
// rarely, a great host calls the banners: pick a leader, a target, a muster point, and the allies
function maybeStartCampaign(worldId, tick, armies, relMap, busy) {
  if (activeCampaigns(worldId).length >= CAMP.MAX_ACTIVE) return;
  if (Math.random() >= CAMP.CHANCE) return;
  const nations = D.aliveNations(worldId).slice();
  if (!nations.length) return;
  const steered = campaignSteered(worldId);
  // in a hot war most hosts are engaged — walk the realms from a random start and take the first
  // with a great host free to lead, so the rare event isn't starved by one busy nation's dice
  let leader = null, F = null;
  const start = (Math.random() * nations.length) | 0;
  for (let i = 0; i < nations.length && !leader; i++) {
    F = nations[(start + i) % nations.length];
    for (const a of armies) {
      if (a.faction !== F || a.role !== 'host' || busy.has(a.id) || steered.has(a.id)) continue;
      if (a.size >= CAMP.MIN_LEAD && (!leader || a.size > leader.size)) leader = a;
    }
  }
  if (!leader) return;
  // a settlement worth taking: enemy- or free-held, the bigger the better, the closer the better
  const TIER_W = { capital: 5, city: 4, town: 2, village: 1 };
  let target = null, best = -1;
  for (const s of settlements(worldId)) {
    if (s.owner === F || s.owner === PLAYER) continue;
    if (isNation(s.owner) && !rivalable(relMap, F, s.owner)) continue;
    const d = Math.hypot(s.x - leader.x, s.z - leader.z);
    if (d > CAMP.TARGET_R) continue;
    const score = (TIER_W[s.tier] || 1) * (1.2 - d / CAMP.TARGET_R) * rand(0.7, 1.3);
    if (score > best) { best = score; target = s; }
  }
  if (!target) return;
  const mx = clamp(leader.x * 0.55 + target.x * 0.45, -MAP_HALF, MAP_HALF);
  const mz = clamp(leader.z * 0.55 + target.z * 0.45, -MAP_HALF, MAP_HALF);
  const members = [leader.id];
  const allied = [];
  for (const a of armies) {
    if (members.length >= CAMP.MAX_MEMBERS) break;
    if (a.id === leader.id || busy.has(a.id) || steered.has(a.id)) continue;
    if (a.faction === F && a.role === 'host') { if (Math.random() < 0.75) members.push(a.id); continue; }
    const dm = Math.hypot(a.x - mx, a.z - mz);
    if (a.faction === F && a.role === 'patrol' && (a.pclass === 'large' || a.pclass === 'medium') && dm <= CAMP.CALL_PATROL_R) {
      if (Math.random() < 0.7) members.push(a.id);
      continue;
    }
    if (isNation(a.faction) && a.faction !== F && a.role === 'host' && dm <= CAMP.ALLY_HOST_R &&
        D.stanceBetween(relMap, F, a.faction) === 'alliance' && Math.random() < 0.5) {
      members.push(a.id); if (allied.indexOf(a.faction) < 0) allied.push(a.faction);
    }
  }
  db.prepare(`INSERT INTO campaigns(world_id, faction, leader_id, target_kind, target_key, target_name, target_x, target_z,
      muster_x, muster_z, stage, members_json, defense, created_tick, stage_tick)
    VALUES (?,?,?,?,?,?,?,?,?,?,'muster',?,'pending',?,?)`)
    .run(worldId, F, leader.id, target.src === 'cap' ? 'capital' : 'hold', target.key, target.name, target.x, target.z,
      mx, mz, JSON.stringify(members), tick, tick);
  ev(worldId, tick, 'campaign_called', leader.name + ' of ' + F + ' calls the banners against ' + target.name +
    ' — ' + members.length + ' hosts answer' + (allied.length ? ' (with ' + allied.join(' and ') + ' beside them)' : ''));
}

// ---------- the per-tick entry point (called from tick.js inside the runTicks transaction) ----------
function tickWarfare(worldId, tick, armies, relMap) {
  const busy = busySet(worldId);
  const steered = campaignSteered(worldId);
  const setts = settlements(worldId);
  const ownByFaction = byOwner(setts);                     // who holds what — roam targets + "in our lands" tests
  const settTier = new Map(setts.map(s => [s.key, s.tier])); // key -> tier, so a patrol's ring wraps its walls
  const grid = buildGrid(armies);
  const nudged = new Set();                                // neutral columns shoved back this tick (dedupe)
  // how many guests each hold currently hosts (home roster excluded) — caps rovers per hold so a small
  // village never out-garrisons its city; kept live across the loop as companies re-pick.
  const visitorCount = new Map();
  for (const a of armies) if (a.role === 'patrol' && a.focus_key && a.focus_key !== a.home_key)
    visitorCount.set(a.focus_key, (visitorCount.get(a.focus_key) || 0) + 1);
  tickPatrols(worldId, tick, armies, relMap, busy, steered, grid, ownByFaction, nudged, visitorCount, settTier);
  tickCampaigns(worldId, tick, armies, relMap, busy);
  maybeStartCampaign(worldId, tick, armies, relMap, busy);
  meetClashes(worldId, tick, armies, relMap, busy, buildGrid(armies), ownByFaction); // fresh grid: everyone has moved
  tickBattles(worldId, tick);
  if (tick % 3 === 0) ensurePatrols(worldId, tick);
  return busy;
}

// ---------- API shapes ----------
function getBattles(worldId) {
  return activeBattles(worldId).map(b => ({
    id: b.id, x: b.x, z: b.z, kind: b.kind, big: !!b.big, holdName: b.hold_name || null, holdKey: b.hold_key || null,
    aFaction: b.a_faction, bFaction: b.b_faction, aIds: JSON.parse(b.a_ids_json), bIds: JSON.parse(b.b_ids_json),
    aStart: b.a_start, bStart: b.b_start, aStr: b.a_str, bStr: b.b_str, garrison: b.b_garrison,
    startedTick: b.started_tick, endsTick: b.ends_tick, campaignId: b.campaign_id || null,
  }));
}
function getCampaigns(worldId) {
  const name = db.prepare('SELECT name FROM warlords WHERE id=?');
  return activeCampaigns(worldId).map(c => {
    const n = name.get(c.leader_id);
    return {
      id: c.id, faction: c.faction, leaderName: n ? n.name : '?', stage: c.stage, defense: c.defense,
      musterX: c.muster_x, musterZ: c.muster_z, targetX: c.target_x, targetZ: c.target_z,
      targetName: c.target_name, targetKey: c.target_key, members: JSON.parse(c.members_json), relief: JSON.parse(c.relief_json),
    };
  });
}
// Build a per-army INTENT lookup from the live campaigns + battles + patrol homes, so the client can
// show "what is this party doing" and colour it. Returns id -> { intent, intentKind }.
function buildIntentIndex(worldId) {
  const idx = new Map();
  const homeName = new Map();      // home_key -> settlement display name (for "Guarding <name>")
  for (const s of settlements(worldId)) if (!homeName.has(s.key)) homeName.set(s.key, s.name);
  // battles: siege besiegers/defenders + open-field fighters
  for (const b of activeBattles(worldId)) {
    const siege = b.kind === 'siege';
    for (const id of JSON.parse(b.a_ids_json)) idx.set(id, siege
      ? { intent: 'Storming ' + (b.hold_name || 'the walls'), intentKind: 'siege' }
      : { intent: 'In battle', intentKind: 'battle' });
    for (const id of JSON.parse(b.b_ids_json)) idx.set(id, siege
      ? { intent: 'Holding ' + (b.hold_name || 'the walls'), intentKind: 'siege' }
      : { intent: 'In battle', intentKind: 'battle' });
  }
  // campaigns override the generic battle text with the richer war-party story
  for (const c of activeCampaigns(worldId)) {
    const stageText = c.stage === 'muster' ? 'Mustering to march on ' + c.target_name
      : c.stage === 'siege' ? 'Besieging ' + c.target_name
      : 'Marching on ' + c.target_name;
    for (const id of JSON.parse(c.members_json)) idx.set(id, { intent: stageText, intentKind: c.stage === 'muster' ? 'muster' : c.stage === 'siege' ? 'siege' : 'march' });
    for (const id of JSON.parse(c.relief_json)) idx.set(id, { intent: 'Riding to relieve ' + c.target_name, intentKind: 'relief' });
  }
  return { idx, homeName };
}
function intentForRow(a, ctx) {
  const hit = ctx.idx.get(a.id);
  if (hit) return hit;
  if (a.role === 'patrol') {
    // riding OUT to another owned hold (focus != home, still far) reads as travel so the client
    // dead-reckons the column between settlements instead of orbiting; otherwise it circles its post
    if (a.focus_key && a.focus_key !== a.home_key && a.focus_x != null) {
      const leash = PATROL_LEASH[a.pclass] || 9;
      const fnm = ctx.homeName.get(a.focus_key);
      if (Math.hypot(a.x - a.focus_x, a.z - a.focus_z) > leash + 3)
        return { intent: fnm ? 'Riding to ' + fnm : 'Riding out', intentKind: 'travel' };
      return { intent: fnm ? 'Patrolling ' + fnm : 'On patrol', intentKind: 'patrol' };
    }
    const nm = a.home_key ? ctx.homeName.get(a.home_key) : null;
    return { intent: nm ? 'Patrolling ' + nm : 'On patrol', intentKind: 'patrol' };
  }
  // a free host with no campaign/battle: it's hunting the war (target set by tick.js toward a rival/cap)
  return { intent: 'Marching to war', intentKind: 'roam' };
}
// armies the CLIENT should draw: every host, patrols near the viewer, and anyone in a battle or
// campaign (those must render wherever they are — the ⚔ markers and muster beacons point at them).
function getArmiesNear(worldId, x, z, r) {
  const cols = `id, name, faction, archetype, x, z, tx, tz, size, renown, kills, battles_won, intent,
    intent_target_kind, intent_target_id, loyalty, personality_json, grudge_faction, destiny, fate, role, pclass,
    home_key, home_x, home_z, focus_key, focus_x, focus_z`;
  const ctx = buildIntentIndex(worldId);
  const tag = (rows) => { for (const a of rows) { const i = intentForRow(a, ctx); a.intent = i.intent; a.intentKind = i.intentKind; } return rows; };
  if (x == null || z == null) return tag(db.prepare(`SELECT ${cols} FROM warlords WHERE world_id=? AND status='alive' AND role='host' ORDER BY id`).all(worldId));
  const R = r == null ? 60 : Math.min(200, Math.max(10, +r || 60));
  const rows = db.prepare(`SELECT ${cols} FROM warlords WHERE world_id=? AND status='alive'
      AND (role='host' OR (x BETWEEN ? AND ? AND z BETWEEN ? AND ?)) ORDER BY id`)
    .all(worldId, x - R, x + R, z - R, z + R);
  const have = new Set(rows.map(a => a.id));
  const need = new Set();
  for (const b of activeBattles(worldId)) { for (const id of JSON.parse(b.a_ids_json)) need.add(id); for (const id of JSON.parse(b.b_ids_json)) need.add(id); }
  for (const c of activeCampaigns(worldId)) { for (const id of JSON.parse(c.members_json)) need.add(id); for (const id of JSON.parse(c.relief_json)) need.add(id); }
  const get = db.prepare(`SELECT ${cols} FROM warlords WHERE world_id=? AND id=? AND status='alive'`);
  for (const id of need) if (!have.has(id)) { const a = get.get(worldId, id); if (a) { rows.push(a); have.add(id); } }
  return tag(rows);
}

module.exports = {
  tickWarfare, ensurePatrols, busySet, campaignSteered, orphanPatrols,
  getBattles, getCampaigns, getArmiesNear,
  startBattle, maybeStartCampaign, activeCampaigns, activeBattles, settlements,
  QUOTA, CAMP, BIG_BATTLE, PATROL_SPEED,
};
