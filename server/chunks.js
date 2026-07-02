// Blade Vale — the server-side chunk store (Phase 1 of server-authoritative worldgen).
// The server GENERATES terrain chunks with the shared kernel (sim/terra.js), PERSISTS them in
// SQLite forever, and SERVES them to clients — the client renders payloads instead of generating.
// Everything is keyed by tseed = the client's exact worldSeed() formula, so one world row spans
// every rerolled universe and every conquered region.
//
// A chunk payload carries, per hex cell (in Terra.hexCellsInChunk order):
//   elev/temp/moist — Uint16, sampled at the 13 top-vertex positions (Terra.TOP_OFFSETS order:
//                     centre, 6 corners, 6 edge midpoints) — exactly the mesh's vertex lattice
//   rough           — Uint8 at the cell centre (the march-speed model's landRoughAt)
// plus the chunk's settlement identities (reseated positions — the fix for the old raw-position
// holds) and, from Phase 3, its road polylines. Owners/garrisons are merged in LIVE at serve time.
const zlib = require('zlib');
const { db } = require('./db');
const WorldSim = require('../sim/world-sim.js');
const Terra = require('../sim/terra.js');

const SHARED_WORLD_SEED = 0x51A3F00D;
const NATIONS = Terra.NATION_HOMES.map(n => n.name);
const PAYLOAD_V = 1;                 // payload SHAPE version (fields/encoding), separate from Terra.VERSION (math)

// the client's exact seed mix — worldSeed() in game.js (plain multiply then ToInt32 via ^, not imul)
function tseedOf(mapLevel, universeSeed) { return (((mapLevel | 0) * 1000 + 7) ^ (universeSeed * 2654435761)) >>> 0; }

// a handful of live kernel instances (their memos make repeat generation cheap within a universe)
const _instances = new Map();
function terraFor(tseed) {
  let T = _instances.get(tseed);
  if (!T) {
    if (_instances.size > 8) _instances.clear();
    T = Terra.make(tseed);
    T.capitalsProvider = () => T._capSeats || (T._capSeats = T.capitalSeats());
    _instances.set(tseed, T);
  }
  return T;
}

// current terrain pointer for a world: shared worlds are pinned; solo worlds follow the player's
// claimed universe (null until the client's first /chunks call claims one)
function tseedParams(worldId) {
  const w = db.prepare('SELECT kind, map_level, universe_seed FROM worlds WHERE id=?').get(worldId);
  if (!w) return null;
  if (w.kind === 'shared') return { level: 0, useed: SHARED_WORLD_SEED, tseed: tseedOf(0, SHARED_WORLD_SEED) };
  if (w.universe_seed == null) return null;
  const lv = w.map_level | 0;
  return { level: lv, useed: w.universe_seed >>> 0, tseed: tseedOf(lv, w.universe_seed >>> 0) };
}

// map a founding nation's name → its CURRENT owner (a conquered capital pulls its hinterland)
function nationOwnerMap(worldId) {
  const m = {};
  for (const c of db.prepare('SELECT idx, owner_name FROM capitals WHERE world_id=?').all(worldId)) m[NATIONS[c.idx]] = c.owner_name;
  return n => m[n] || n;
}

function nearCapital(seats, x, z, d) {
  for (const c of seats) if (Math.hypot(c.x - x, c.z - z) < d) return true;
  return false;
}

// ---------- generation: fields + settlement identity for one chunk ----------
function buildPayload(T, tseed, level, cx, cz, ownerOf) {
  const cells = Terra.hexCellsInChunk(cx, cz);
  const OFF = Terra.TOP_OFFSETS, V = OFF.length, N = cells.length;
  const elev = Buffer.alloc(N * V * 2);                       // heights need 16-bit (mesh slopes band at 8)
  const temp = Buffer.alloc(N * V), moist = Buffer.alloc(N * V); // colour bands are happy with 8-bit
  const rough = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    const xc = cells[i][2], zc = cells[i][3];
    for (let v = 0; v < V; v++) {
      const px = xc + OFF[v][0], pz = zc + OFF[v][1], o = i * V + v;
      elev.writeUInt16LE(Math.round(T.elevationAt(px, pz) * 65535), o * 2);
      temp[o] = Math.round(T.tempAt(px, pz) * 255);
      moist[o] = Math.round(T.moistureAt(px, pz) * 255);
    }
    rough[i] = Math.round(T.landRoughAt(xc, zc) * 255);
  }
  // settlement identity: reseated positions, with the SAME crowding filter the client applied
  // (isWater / too close to a capital) so payload holds are exactly what the client used to draw
  const seats = T.capitalsProvider();
  const caps = seats.map(c => ({ name: c.name, x: c.x, z: c.z }));
  const holds = [];
  for (const s of T.settlementSites(cx, cz)) {
    if (T.isWater(s.x, s.z) || nearCapital(seats, s.x, s.z, s.tier === 'city' ? 100 : 58)) continue;
    holds.push({
      idx: s.idx, tier: s.tier, x: s.x, z: s.z,
      name: WorldSim.settlementName(s, tseed),
      owner: WorldSim.settlementOwner(s, tseed, caps, ownerOf),
      garrison: WorldSim.settlementGarrison(s, tseed, level),
      roadAx: s.roadAx != null ? s.roadAx : null,
    });
  }
  return {
    v: PAYLOAD_V, kernel: Terra.VERSION, cx, cz, n: N,
    elev: elev.toString('base64'), temp: temp.toString('base64'), moist: moist.toString('base64'),
    rough: rough.toString('base64'),
    holds, roads: [],                                  // roads arrive in Phase 3
  };
}

// ---------- ensure: load-or-generate one chunk (idempotent, one transaction per generation) ----------
function ensureChunk(worldId, level, useed, cx, cz) {
  const tseed = tseedOf(level, useed);
  const row = db.prepare('SELECT payload FROM chunks WHERE world_id=? AND tseed=? AND cx=? AND cz=?').get(worldId, tseed, cx, cz);
  if (row) return JSON.parse(zlib.gunzipSync(row.payload).toString('utf8'));
  const T = terraFor(tseed);
  const ownerOf = nationOwnerMap(worldId);
  const tick = (db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(worldId) || { sim_tick: 0 }).sim_tick | 0;
  const payload = buildPayload(T, tseed, level, cx, cz, ownerOf);
  db.transaction(() => {
    const insHold = db.prepare(`INSERT OR IGNORE INTO holds(world_id, tseed, cx, cz, idx, name, tier, x, z, owner_name, garrison, generated_tick)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const fixPos = db.prepare('UPDATE holds SET x=?, z=? WHERE world_id=? AND tseed=? AND cx=? AND cz=? AND idx=?');
    for (const h of payload.holds) {
      insHold.run(worldId, tseed, cx, cz, h.idx, h.name, h.tier, h.x, h.z, h.owner, h.garrison, tick);
      fixPos.run(h.x, h.z, worldId, tseed, cx, cz, h.idx);   // legacy raw-position rows get reseated (siteKey unchanged)
    }
    db.prepare('INSERT OR IGNORE INTO chunks(world_id, tseed, cx, cz, version, payload, generated_tick) VALUES (?,?,?,?,?,?,?)')
      .run(worldId, tseed, cx, cz, Terra.VERSION, zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')), tick);
  })();
  return payload;
}

// pre-warm the ground around a navigating player (the presence-heartbeat hook; keeps contestHolds
// fed with holds even for clients that never fetch chunks, e.g. the terminal bot)
function ensureChunks(worldId, level, useed, x, z, radiusChunks, maxNew) {
  const R = radiusChunks == null ? 4 : radiusChunks | 0;
  const budget = maxNew == null ? Infinity : maxNew | 0;
  const tseed = tseedOf(level, useed);
  const has = db.prepare('SELECT 1 FROM chunks WHERE world_id=? AND tseed=? AND cx=? AND cz=?');
  const pcx = Math.floor(x / Terra.CHUNK), pcz = Math.floor(z / Terra.CHUNK);
  const ring = [];
  for (let cx = pcx - R; cx <= pcx + R; cx++) for (let cz = pcz - R; cz <= pcz + R; cz++)
    ring.push([Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)), cx, cz]);
  ring.sort((a, b) => a[0] - b[0]);                          // nearest-first: the ground underfoot wins
  let fresh = 0, have = 0;
  for (const [, cx, cz] of ring) {
    if (has.get(worldId, tseed, cx, cz)) { have++; continue; }
    if (fresh >= budget) continue;
    ensureChunk(worldId, level, useed, cx, cz); fresh++;
  }
  return { chunksEnsured: have + fresh, chunksGenerated: fresh };
}

// ---------- serve: a batch of chunks with LIVE hold ownership merged in ----------
function serveBatch(worldId, level, useed, list) {
  const tseed = tseedOf(level, useed);
  const liveHolds = db.prepare('SELECT cx, cz, idx, owner_name, garrison FROM holds WHERE world_id=? AND tseed=? AND cx=? AND cz=?');
  const out = [];
  for (const key of list) {
    const m = /^(-?\d+):(-?\d+)$/.exec(key);
    if (!m) continue;
    const cx = +m[1], cz = +m[2];
    const payload = ensureChunk(worldId, level, useed, cx, cz);
    const live = new Map(liveHolds.all(worldId, tseed, cx, cz).map(h => [h.idx, h]));
    for (const h of payload.holds) {
      const lv = live.get(h.idx);
      if (lv) { h.owner = lv.owner_name; h.garrison = lv.garrison; }
    }
    out.push(payload);
  }
  return { tseed, kernel: Terra.VERSION, payloadV: PAYLOAD_V, chunks: out };
}

module.exports = { tseedOf, tseedParams, terraFor, ensureChunk, ensureChunks, serveBatch, buildPayload, nationOwnerMap, SHARED_WORLD_SEED, PAYLOAD_V };
