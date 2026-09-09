// Blade Vale — the admin god's-eye overview.
//
// The admin map (admin.html) is a top-down overwatch of the WHOLE shared world. The live entity
// layer (players + every army, incl. settlement patrols) already comes from /api/v1/world. This
// module serves the STANDING world beneath them — the layers the strategic map draws but the admin
// page never had: terrain, roads, and the political border field.
//
// Everything is sampled with the shared kernel (sim/terra.js) — the same math the client renders —
// so the admin view matches the game. Terrain + roads are static per universe (tseed) and cached
// forever; the territory field is rebuilt live (ownership moves as capitals fall and hosts march).
const { db } = require('./db');
const Terra = require('../sim/terra.js');
const WorldSim = require('../sim/world-sim.js');
const Roads = require('./roads.js');
const chunks = require('./chunks.js');
const tick = require('./tick.js');

const CHUNK = Terra.CHUNK;
const MAP_HALF = WorldSim.MAP_HALF;                 // 90 — the named-powers core half-size

// static-per-universe caches (bounded; a reseed/new world just evicts)
const _terrCache = new Map();                       // "tseed:extent:res" -> { res, rgb(base64) }
const _roadCache = new Map();                       // "tseed:extent"      -> [{tier, pts:[[x,z]]}]

// ---------- terrain raster: the ground colour the game paints, sampled on a regular grid ----------
// Row-major, res×res, top row = z:-extent, left col = x:-extent. Packed RGB (3 bytes/px), base64.
// groundColorRGB already renders open water blue, so the sea comes for free — no separate mask.
function terrainRaster(T, tseed, extent, res) {
  const key = tseed + ':' + extent + ':' + res;
  const hit = _terrCache.get(key);
  if (hit) return hit;
  const buf = Buffer.alloc(res * res * 3), out = [0, 0, 0], span = extent * 2;
  for (let iy = 0; iy < res; iy++) {
    const z = -extent + (iy + 0.5) / res * span;
    for (let ix = 0; ix < res; ix++) {
      const x = -extent + (ix + 0.5) / res * span;
      T.groundColorRGB(x, z, out);
      const o = (iy * res + ix) * 3;
      buf[o]     = Math.max(0, Math.min(255, Math.round(out[0] * 255)));
      buf[o + 1] = Math.max(0, Math.min(255, Math.round(out[1] * 255)));
      buf[o + 2] = Math.max(0, Math.min(255, Math.round(out[2] * 255)));
    }
  }
  const rec = { res, rgb: buf.toString('base64') };
  if (_terrCache.size > 8) _terrCache.clear();
  _terrCache.set(key, rec);
  return rec;
}

// ---------- roads: the routed network across the whole view, as world-space polylines ----------
// Built region-by-region on the shared kernel (server/roads.js) exactly as the chunk store does, so
// the strokes are byte-identical to what a player sees. Overlapping regions re-derive the same
// trunk (shared capital seats) — we key on tier + rounded endpoints so a trunk is emitted once.
function roadsFor(tseed, extent) {
  const key = tseed + ':' + extent;
  const hit = _roadCache.get(key);
  if (hit) return hit;
  const cLo = Math.floor(-extent / CHUNK), cHi = Math.floor(extent / CHUNK);
  const rLo = Roads.regionIndex(cLo), rHi = Roads.regionIndex(cHi);
  const seen = new Set(), out = [];
  for (let rix = rLo; rix <= rHi; rix++) for (let riz = rLo; riz <= rHi; riz++) {
    const reg = Roads.ensureRegion(tseed, rix, riz);
    for (const e of reg.edges) {
      if (!e.pts || e.pts.length < 2) continue;
      const a = e.pts[0], b = e.pts[e.pts.length - 1];
      const k = e.tier + ':' + Math.round(a.x) + ',' + Math.round(a.z) + '>' + Math.round(b.x) + ',' + Math.round(b.z);
      if (seen.has(k)) continue;
      seen.add(k);
      let touches = false;
      for (const p of e.pts) { if (p.x >= -extent && p.x <= extent && p.z >= -extent && p.z <= extent) { touches = true; break; } }
      if (!touches) continue;
      out.push({ tier: e.tier, pts: e.pts.map(p => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]) });
    }
  }
  if (_roadCache.size > 8) _roadCache.clear();
  _roadCache.set(key, out);
  return out;
}

// ---------- territory field: dominant faction + heat per grid cell, from LIVE ownership ----------
// Same source model + weight table as the per-chunk /territory service (chunks.js), gathered once
// for the whole box: capitals, owned holds, marching hosts, recent player banners.
function territorySources(worldId, tseed, T, x0, z0, x1, z1) {
  const K = WorldSim.TERRITORY, own = chunks.nationOwnerMap(worldId), src = [];
  for (const c of T.capitalsProvider())
    src.push({ x: c.x, z: c.z, f: own(c.name), W: K.CAP_W, R: K.CAP_R });
  for (const h of db.prepare('SELECT x, z, owner_name FROM holds WHERE world_id=? AND tseed=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?')
    .all(worldId, tseed, x0 - K.SET_R, x1 + K.SET_R, z0 - K.SET_R, z1 + K.SET_R))
    src.push({ x: h.x, z: h.z, f: h.owner_name, W: K.SET_W, R: K.SET_R });
  for (const a of db.prepare("SELECT x, z, faction FROM warlords WHERE world_id=? AND status='alive' AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?")
    .all(worldId, x0 - K.BAND_R, x1 + K.BAND_R, z0 - K.BAND_R, z1 + K.BAND_R))
    src.push({ x: a.x, z: a.z, f: own(a.faction), W: K.BAND_W, R: K.BAND_R });
  const cutoff = Math.floor(Date.now() / 1000) - 60;
  for (const p of db.prepare('SELECT x, z, faction FROM presence WHERE world_id=? AND updated_at>=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?')
    .all(worldId, cutoff, x0 - K.PLR_R, x1 + K.PLR_R, z0 - K.PLR_R, z1 + K.PLR_R))
    src.push({ x: p.x, z: p.z, f: p.faction, W: K.PLR_W, R: K.PLR_R });
  return src;
}
function territoryGrid(worldId, tseed, T, extent, res) {
  const src = territorySources(worldId, tseed, T, -extent, -extent, extent, extent);
  const owner = Buffer.alloc(res * res), heat = Buffer.alloc(res * res);   // owner index+1 (0=none), heat 0..255
  const names = [], nameIdx = new Map(), span = extent * 2;
  for (let iy = 0; iy < res; iy++) {
    const z = -extent + (iy + 0.5) / res * span;
    for (let ix = 0; ix < res; ix++) {
      const x = -extent + (ix + 0.5) / res * span;
      if (T.isWater(x, z)) continue;                                        // open water flies no banner
      const cell = WorldSim.territoryCell(x, z, src);
      if (!cell.o) continue;
      let k = nameIdx.get(cell.o);
      if (k === undefined) { k = names.length; names.push(cell.o); nameIdx.set(cell.o, k); }
      const o = iy * res + ix;
      owner[o] = k + 1;
      heat[o] = Math.round(cell.s * 255);
    }
  }
  return { res, names, owner: owner.toString('base64'), heat: heat.toString('base64') };
}

// ---------- the public call: one god's-eye snapshot of the standing world ----------
function overview(worldId, opts) {
  const tp = chunks.tseedParams(worldId);
  if (!tp) return { error: 'world has no claimed universe yet' };
  const T = chunks.terraFor(tp.tseed);
  opts = opts || {};
  const extent  = Math.max(40, Math.min(300, (opts.extent | 0) || Math.round(MAP_HALF * 1.35)));
  const terrRes = Math.max(64, Math.min(384, (opts.res | 0) || 256));
  const terrGrid = Math.max(48, Math.min(200, Math.round(terrRes * 0.55)));    // borders can be coarser than terrain
  const own = chunks.nationOwnerMap(worldId);
  const terrain = terrainRaster(T, tp.tseed, extent, terrRes);
  const roads = roadsFor(tp.tseed, extent);
  const territory = territoryGrid(worldId, tp.tseed, T, extent, terrGrid);
  const holds = db.prepare('SELECT name, tier, x, z, owner_name FROM holds WHERE world_id=? AND tseed=?')
    .all(worldId, tp.tseed).map(h => ({ name: h.name, tier: h.tier, x: h.x, z: h.z, owner: h.owner_name }));
  const capitals = T.capitalsProvider().map(c => ({ name: c.name, x: c.x, z: c.z, owner: own(c.name) }));
  return { extent, core: MAP_HALF, terrain, territory, roads, holds, capitals };
}

// ---------- reset: move everyone to a fresh shared world and delete the current one ----------
// A hard reset: the old shared world and ALL its data are deleted (fresh start — player characters
// go with it), and a brand-new shared world is created with its OWN terrain seed (a different-looking
// map) and freshly seeded (capitals/nations, warlord hosts, diplomacy, destiny). Because the shared
// world is resolved as "the single row where kind='shared'", once the swap commits every client that
// sends `X-World: shared` lands in the new world automatically — that IS the "move all users".

// every table that scopes rows to a world — discovered from the live schema so it can never drift out
// of date as migrations add tables (hold_regions, future tables, etc. are covered automatically).
function worldScopedTables() {
  const out = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    if (name === 'worlds') continue;
    if (db.prepare('PRAGMA table_info(' + name + ')').all().some(c => c.name === 'world_id')) out.push(name);
  }
  return out;
}
// a non-zero 32-bit terrain seed for the new world, distinct from the one we're leaving
function freshSeed(avoid) {
  let s = 0;
  while (!s || s === (avoid >>> 0)) s = (Math.floor(Math.random() * 0xffffffff) ^ (Date.now() & 0xffff)) >>> 0;
  return s;
}

function resetWorld() {
  let sys = db.prepare("SELECT id FROM accounts WHERE handle='system'").get();
  if (!sys) sys = { id: db.prepare("INSERT INTO accounts(handle) VALUES ('system')").run().lastInsertRowid };
  const old = db.prepare("SELECT id, universe_seed FROM worlds WHERE kind='shared'").get();
  const newSeed = freshSeed(old ? (old.universe_seed || 0) : 0);
  const tables = worldScopedTables();

  // FKs reference worlds(id) with no ON DELETE CASCADE, and some world tables cross-reference each
  // other (e.g. campaign/battle members) — so wipe with foreign_keys OFF (toggled outside the txn,
  // as SQLite ignores the pragma mid-transaction), then restore it. Single-process server: safe.
  db.pragma('foreign_keys = OFF');
  let result;
  try {
    result = db.transaction(() => {
      if (old) {
        for (const t of tables) db.prepare('DELETE FROM ' + t + ' WHERE world_id=?').run(old.id);
        db.prepare('DELETE FROM worlds WHERE id=?').run(old.id);
      }
      const now = Math.floor(Date.now() / 1000);
      const r = db.prepare("INSERT INTO worlds(account_id, seed, kind, universe_seed, last_tick_at) VALUES (?,?,'shared',?,?)")
        .run(sys.id, newSeed & 0x7fffffff, newSeed, now);
      const newId = r.lastInsertRowid;
      tick.seedWorld(newId);                 // capitals, warlord hosts, diplomacy, destiny — a playable world
      return { ok: true, oldWorldId: old ? old.id : null, newWorldId: newId, terrainSeed: newSeed };
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  // the static terrain/road caches are keyed by tseed, so the new world just misses them; clear the
  // old entries so a fresh map doesn't keep stale megabytes around.
  _terrCache.clear();
  _roadCache.clear();
  return result;
}

module.exports = { overview, resetWorld };
