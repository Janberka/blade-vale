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
// holds) and its routed road polylines (server/roads.js). Owners/garrisons are merged in LIVE at
// serve time; terrain + roads are static, generated once and persisted forever.
const zlib = require('zlib');
const { db } = require('./db');
const WorldSim = require('../sim/world-sim.js');
const Terra = require('../sim/terra.js');
const Roads = require('./roads.js');

const SHARED_WORLD_SEED = 0x51A3F00D;
const NATIONS = Terra.NATION_HOMES.map(n => n.name);
const PAYLOAD_V = 3;                 // payload SHAPE version (fields/encoding), separate from Terra.VERSION (math)
                                     // v2: holds carry their wall RING polygon (Terra.wallRingPts)
                                     // v3: roads[] carries the routed, culled, region-quantised road polylines

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

// current terrain pointer for a world: shared worlds are PINNED to SHARED_WORLD_SEED — the client
// derives its whole shared-world identity (terrain, capitals, station, home realm) from that one
// fixed seed, so the server must match it or the client rejects every chunk (tseed mismatch → blank
// terrain). Per-shared-world seeds can't ship until the client learns the seed from the server.
// Solo worlds follow the player's claimed universe (null until the client's first /chunks call claims one).
function sharedUseed(w) { return SHARED_WORLD_SEED; }
function tseedParams(worldId) {
  const w = db.prepare('SELECT kind, map_level, universe_seed FROM worlds WHERE id=?').get(worldId);
  if (!w) return null;
  if (w.kind === 'shared') { const us = sharedUseed(w); return { level: 0, useed: us, tseed: tseedOf(0, us) }; }
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
    const h = {
      idx: s.idx, tier: s.tier, x: s.x, z: s.z,
      name: WorldSim.settlementName(s, tseed),
      owner: WorldSim.settlementOwner(s, tseed, caps, ownerOf),
      garrison: WorldSim.settlementGarrison(s, tseed, level),
      roadAx: s.roadAx != null ? s.roadAx : null,
    };
    // the wall ring the client's icons trace — same site seed makeSettlement derives client-side
    const sseed = (WorldSim.chunkHash(cx, cz, tseed) ^ (Math.imul(s.idx + 3, 0x9E3779B1) >>> 0)) >>> 0;
    const ring = T.wallRingPts(s.x, s.z, s.tier, sseed);
    if (ring) h.ring = ring;
    holds.push(h);
  }
  return {
    v: PAYLOAD_V, kernel: Terra.VERSION, cx, cz, n: N,
    elev: elev.toString('base64'), temp: temp.toString('base64'), moist: moist.toString('base64'),
    rough: rough.toString('base64'),
    // roads: region-quantised, routed + water/wall-culled polylines from the shared kernel — the
    // client renders these (splat + rocks) instead of running the ~2.4s network build itself
    holds, roads: Roads.roadsForChunk(tseed, cx, cz),
  };
}

// ---------- ensure: load-or-generate one chunk (idempotent, one transaction per generation) ----------
function ensureChunk(worldId, level, useed, cx, cz) {
  const tseed = tseedOf(level, useed);
  const row = db.prepare('SELECT payload FROM chunks WHERE world_id=? AND tseed=? AND cx=? AND cz=?').get(worldId, tseed, cx, cz);
  if (row) {
    const cached = JSON.parse(zlib.gunzipSync(row.payload).toString('utf8'));
    if (cached.v === PAYLOAD_V && cached.kernel === Terra.VERSION) return cached;  // shape AND math current — serve as-is
    // stale shape (pre-ring v1) OR stale kernel math (e.g. capitals re-spaced): regenerate + REPLACE
    // below so a math bump makes a genuinely new world without a manual DB wipe (holds rows reseat)
  }
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
    db.prepare('INSERT OR REPLACE INTO chunks(world_id, tseed, cx, cz, version, payload, generated_tick) VALUES (?,?,?,?,?,?,?)')
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

// ---------- the DETAIL tier: street-level rows, generated once and saved (Google-Street rule) ----------
// The action rung's richer world: the base scatter rows + every map tree expanded into a 3-5 tree
// grove, all pure from (cx, cz, tseed) via the shared kernel — the client's local fallback is
// byte-identical, so these rows are the persisted canonical copy of the zoomed-in area.
const DETAIL_V = 1;                  // detail payload SHAPE version (fields/encoding)
function buildDetailPayload(T, cx, cz) {
  const base = T.chunkScatter(cx, cz);
  return { v: DETAIL_V, kernel: Terra.VERSION, cx, cz,
           trees: base.trees, rocks: base.rocks, groves: T.chunkGroves(cx, cz, base) };
}
function ensureDetail(worldId, level, useed, cx, cz) {
  const tseed = tseedOf(level, useed);
  const row = db.prepare('SELECT payload FROM chunk_detail WHERE world_id=? AND tseed=? AND cx=? AND cz=?').get(worldId, tseed, cx, cz);
  if (row) return JSON.parse(zlib.gunzipSync(row.payload).toString('utf8'));
  const T = terraFor(tseed);
  const tick = (db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(worldId) || { sim_tick: 0 }).sim_tick | 0;
  const payload = buildDetailPayload(T, cx, cz);
  db.prepare('INSERT OR IGNORE INTO chunk_detail(world_id, tseed, cx, cz, version, payload, generated_tick) VALUES (?,?,?,?,?,?,?)')
    .run(worldId, tseed, cx, cz, Terra.VERSION, zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')), tick);
  return payload;
}
function serveDetailBatch(worldId, level, useed, list) {
  const tseed = tseedOf(level, useed);
  const out = [];
  for (const key of list) {
    const m = /^(-?\d+):(-?\d+)$/.exec(key);
    if (!m) continue;
    out.push(ensureDetail(worldId, level, useed, +m[1], +m[2]));
  }
  return { tseed, kernel: Terra.VERSION, detailV: DETAIL_V, chunks: out };
}

// ---------- the TERRITORY field: the political heat-map, generated from LIVE ownership ----------
// Per chunk, per logical hex cell: the dominant faction + how decisively it holds the ground —
// resolved by the shared kernel (WorldSim.territoryCell) from the live tables (capitals, holds,
// marching warlords, present players). Rows persist in `territory`; src_hash fingerprints the
// sources in reach, so a conquest or an army marching through regenerates exactly the chunks it
// touches — real-time borders, stored truth, one weight table (WorldSim.TERRITORY) with the client.
const TERR_V = 1;                    // territory payload SHAPE version
function territorySources(worldId, tseed, T, x0, z0, x1, z1) {
  const K = WorldSim.TERRITORY, src = [];
  const own = nationOwnerMap(worldId);
  for (const c of T.capitalsProvider()) {
    if (c.x < x0 - K.CAP_R || c.x > x1 + K.CAP_R || c.z < z0 - K.CAP_R || c.z > z1 + K.CAP_R) continue;
    src.push({ x: c.x, z: c.z, f: own(c.name), W: K.CAP_W, R: K.CAP_R });
  }
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
// FNV-1a over the source tuples (positions 4u-quantised so slow drift doesn't thrash the store)
function terrHash(src) {
  let h = 0x811c9dc5 | 0;
  const mix = (v) => { v |= 0; for (let b = 0; b < 4; b++) { h = (h ^ ((v >>> (b * 8)) & 255)) | 0; h = Math.imul(h, 0x01000193); } };
  mix(TERR_V);
  for (const s of src) {
    mix(Math.round(s.x / 4)); mix(Math.round(s.z / 4)); mix((s.W * 100) | 0);
    const f = s.f || '';
    for (let i = 0; i < f.length; i++) mix(f.charCodeAt(i));
  }
  return (h >>> 0).toString(16) + ':' + src.length;
}
function buildTerritoryPayload(T, cx, cz, src) {
  const cells = Terra.hexCellsInChunk(cx, cz), N = cells.length;
  const o = Buffer.alloc(N), s = Buffer.alloc(N);        // per-cell: owner index+1 (0 = none), heat 0..255
  const names = [], nameIdx = new Map();
  for (let i = 0; i < N; i++) {
    const xc = cells[i][2], zc = cells[i][3];
    if (T.isWater(xc, zc)) continue;                     // open water flies no banner
    const c = WorldSim.territoryCell(xc, zc, src);
    if (!c.o) continue;
    let ix = nameIdx.get(c.o);
    if (ix === undefined) { ix = names.length; names.push(c.o); nameIdx.set(c.o, ix); }
    o[i] = ix + 1; s[i] = Math.round(c.s * 255);
  }
  return { v: TERR_V, cx, cz, f: names, o: o.toString('base64'), s: s.toString('base64') };
}
function serveTerritoryBatch(worldId, level, useed, list) {
  const tseed = tseedOf(level, useed);
  const T = terraFor(tseed);
  const now = Math.floor(Date.now() / 1000);
  const get = db.prepare('SELECT payload, src_hash FROM territory WHERE world_id=? AND tseed=? AND cx=? AND cz=?');
  const put = db.prepare('INSERT OR REPLACE INTO territory(world_id, tseed, cx, cz, version, src_hash, payload, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  const out = [];
  for (const key of list) {
    const m = /^(-?\d+):(-?\d+)$/.exec(key);
    if (!m) continue;
    const cx = +m[1], cz = +m[2];
    const x0 = cx * Terra.CHUNK, z0 = cz * Terra.CHUNK;
    const src = territorySources(worldId, tseed, T, x0, z0, x0 + Terra.CHUNK, z0 + Terra.CHUNK);
    const hash = terrHash(src);
    const row = get.get(worldId, tseed, cx, cz);
    if (row && row.src_hash === hash) { out.push(JSON.parse(zlib.gunzipSync(row.payload).toString('utf8'))); continue; }
    const payload = buildTerritoryPayload(T, cx, cz, src);
    put.run(worldId, tseed, cx, cz, TERR_V, hash, zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')), now);
    out.push(payload);
  }
  return { tseed, terrV: TERR_V, chunks: out };
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

module.exports = { tseedOf, tseedParams, terraFor, ensureChunk, ensureChunks, serveBatch, buildPayload, nationOwnerMap, SHARED_WORLD_SEED, PAYLOAD_V, ensureDetail, serveDetailBatch, buildDetailPayload, DETAIL_V, serveTerritoryBatch, TERR_V };
