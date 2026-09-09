/* Blade Vale — the shared TERRAIN kernel (UMD).
   ALL pure worldgen math lives here — noise fields, biomes, hex lattice, land seating,
   settlement probes/gates/streets, the road network builder, and the travel A* — so the
   browser (window.Terra) and the Node server (require('./terra')) generate byte-identical
   worlds from the same seed. Extracted verbatim from game.js (Phase 0 of the server-side
   worldgen migration): the client keeps thin same-name shims; the server becomes the
   authority that persists what this kernel computes.

   Rules of the house (same as world-sim.js): pure & deterministic. No DOM, no three.js,
   no Math.random, no Date. Everything seeded is derived from the instance tseed via
   WorldSim.mulberry32 / WorldSim.chunkHash. NEVER change any math here without bumping
   VERSION — persisted chunk payloads are stamped with it. */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./world-sim.js'));
  else root.Terra = factory(root.WorldSim);
})(typeof self !== 'undefined' ? self : this, function (WorldSim) {
  'use strict';

  var VERSION = 4;                       // bump on ANY math change (chunk payloads are stamped with it)
  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  var mulberry32 = WorldSim.mulberry32;
  var chunkHash = WorldSim.chunkHash;

  // ---------- Static constants (seed-independent, mirrored by game.js aliases) ----------
  var CHUNK = WorldSim.CHUNK;            // 60 — world units per chunk side
  var MAP_HALF = WorldSim.MAP_HALF;      // 90 — overworld half-size (drives tempAt latitude + nearestLand bound)
  var CITY_BLOCK = 11;                   // mirrors WorldSim CITY_BLOCK (not exported there)
  var SEA_LEVEL = 0.38;
  var TERR_SCALE = 1 / 42;
  var MAP_RELIEF = 17;                   // overworld vertical exaggeration — base lift for the rolling country
  // Mountain ranges: a slow "orogeny belt" field decides WHERE the crust is buckled into highlands;
  // a ridged spine field carves the actual peaks within those belts (see game.js history for tuning notes).
  var MOUNTAINS = {
    beltScale:  0.16,
    beltThresh: 0.48,
    beltWidth:  0.34,
    spineScale: 1.05,
    lift:       0.62,
  };
  // biome table — plain data; `water` marks the wet ones, colours are packed hex ints
  var B = {
    OCEAN:    { name: 'Ocean',     water: true, ground: 0x16415f },
    SHALLOW:  { name: 'Coast',     water: true, ground: 0x2b7aa6 },
    BEACH:    { name: 'Coast',     ground: 0xddd2a0, pad: 0xc8bd86, fog: 0xd6e6ea, sky: 0xe3eef2, tree: 0x7a9a55, treeChance: 0.02, rockChance: 0.06 },
    GRASS:    { name: 'Grassland', ground: 0x6f9e54, pad: 0x8a6a45, fog: 0x9fc6e8, sky: 0x9fc6e8, tree: 0x4f8a3f, treeChance: 0.10, rockChance: 0.04 },
    SAVANNA:  { name: 'Savanna',   ground: 0x9a9c58, pad: 0x9a8a4f, fog: 0xcfd2a0, sky: 0xdcdca8, tree: 0x8a9a4a, treeChance: 0.06, rockChance: 0.10, dry: true },
    FOREST:   { name: 'Forest',    ground: 0x3f6b34, pad: 0x5a6038, fog: 0x86a98e, sky: 0x93b89e, tree: 0x2f6a30, treeChance: 0.22, rockChance: 0.05 },
    TAIGA:    { name: 'Taiga',     ground: 0x47675a, pad: 0x4f5f50, fog: 0xacc2c2, sky: 0xbcd0cc, tree: 0x356a52, treeChance: 0.19, rockChance: 0.10 },
    DESERT:   { name: 'Desert',    ground: 0xc9a266, pad: 0xb8924f, fog: 0xe6d09c, sky: 0xeedaa6, tree: 0x9a8a4a, treeChance: 0.02, rockChance: 0.28, dry: true },
    TUNDRA:   { name: 'Tundra',    ground: 0xdde7f0, pad: 0xc6d2dc, fog: 0xcfe0ee, sky: 0xdcebf6, tree: 0x6f8a7a, treeChance: 0.07, rockChance: 0.14 },
    MOUNTAIN: { name: 'Mountains', ground: 0x8c8c86, pad: 0x77756f, fog: 0xc8ccd2, sky: 0xd2d6dc, tree: 0x5a6a55, treeChance: 0.05, rockChance: 0.34 },
  };
  // the five powers' themed compass bearings (radians; +z is the hot south) — mirrors game.js NATIONS
  var NATION_HOMES = [
    { name: 'Aurelia',  home: 2.62 },
    { name: 'Khorvane', home: 0.15 },
    { name: 'Sahir',    home: 1.57 },
    { name: 'Wendmark', home: 4.71 },
    { name: 'Maridor',  home: 3.67 },
  ];
  // continuous colour bands (the smooth cousin of the biome table — see groundColorRGB)
  var _BAND_T   = [0.10, 0.29, 0.48, 0.68, 0.88];
  var _BAND_DRY = [0xdde7f0, 0xdde7f0, 0x6f9e54, 0x9a9c58, 0xc9a266];
  var _BAND_WET = [0xdde7f0, 0x47675a, 0x3f6b34, 0x3f6b34, 0x9a9c58];

  // ---------- Hex lattice: the overworld is a honeycomb (pointy-top, odd-r offset) ----------
  var HEX_R = 2.4;
  var HEX_W = Math.sqrt(3) * HEX_R;
  var HEX_H = 1.5 * HEX_R;
  var HEX_FLOOR = -14;
  function hexKey(q, r) { return q + ',' + r; }
  function hexCenterX(q, r) { return (q + 0.5 * (r & 1)) * HEX_W; }
  function hexCenterZ(r) { return r * HEX_H; }
  function worldToHex(x, z) {
    var ar = z / HEX_H, best = [0, 0], bd = Infinity;
    for (var dr = -1; dr <= 1; dr++) {
      var r = Math.round(ar) + dr, off = 0.5 * (r & 1), q = Math.round(x / HEX_W - off);
      var dx = (q + off) * HEX_W - x, dz = r * HEX_H - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = [q, r]; }
    }
    return best;
  }
  function hexCellsInChunk(cx, cz) {
    var out = [];
    var rLo = Math.floor(cz * CHUNK / HEX_H) - 1, rHi = Math.ceil((cz + 1) * CHUNK / HEX_H) + 1;
    for (var r = rLo; r <= rHi; r++) {
      var zc = r * HEX_H; if (Math.floor(zc / CHUNK) !== cz) continue;
      var off = 0.5 * (r & 1);
      var qLo = Math.floor(cx * CHUNK / HEX_W - off) - 1, qHi = Math.ceil((cx + 1) * CHUNK / HEX_W - off) + 1;
      for (var q = qLo; q <= qHi; q++) {
        var xc = (q + off) * HEX_W; if (Math.floor(xc / CHUNK) !== cx) continue;
        out.push([q, r, xc, zc]);
      }
    }
    return out;
  }
  // the 13 TOP-vertex offsets of a hex prism, in the canonical mesh order the client's
  // _hexTemplate uses: centre (0), 6 corners (1..6, a = k·60°, [R·sin, R·cos]), 6 edge
  // midpoints (7..12). Server chunk payloads sample heights in EXACTLY this order per cell.
  var TOP_OFFSETS = (function () {
    var out = [[0, 0]], cor = [];
    for (var k = 0; k < 6; k++) { var a = k * Math.PI / 3; cor.push([HEX_R * Math.sin(a), HEX_R * Math.cos(a)]); }
    for (k = 0; k < 6; k++) out.push(cor[k]);
    for (k = 0; k < 6; k++) { var b2 = cor[(k + 1) % 6]; out.push([(cor[k][0] + b2[0]) / 2, (cor[k][1] + b2[1]) / 2]); }
    return out;
  })();

  // ---------- Static noise (seed passed explicitly — game.js aliases these directly) ----------
  function nHash(ix, iz, seed) { var h = Math.sin(ix * 127.1 + iz * 311.7 + seed * 53.7) * 43758.5453; return h - Math.floor(h); }
  function vnoise(x, z, seed) {
    var ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
    var ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    var a = nHash(ix, iz, seed), b = nHash(ix + 1, iz, seed), c = nHash(ix, iz + 1, seed), d = nHash(ix + 1, iz + 1, seed);
    return a * (1 - ux) * (1 - uz) + b * ux * (1 - uz) + c * (1 - ux) * uz + d * ux * uz;
  }
  function fbm(x, z, seed) {
    var v = 0, amp = 0.5, f = 1, norm = 0;
    for (var o = 0; o < 4; o++) { v += amp * vnoise(x * f, z * f, seed + o * 31); norm += amp; f *= 2; amp *= 0.5; }
    return v / norm;
  }
  function ridge(x, z, seed) {
    var v = 0, amp = 0.5, f = 1, norm = 0, prev = 1;
    for (var o = 0; o < 4; o++) {
      var n = vnoise(x * f, z * f, seed + o * 31);
      n = 1 - Math.abs(2 * n - 1); n *= n;
      v += amp * n * prev; prev = clamp(n * 1.4, 0, 1);
      norm += amp; f *= 2; amp *= 0.5;
    }
    return v / norm;
  }

  // ---------- Roads + movement constants ----------
  var ROAD = {
    v2: true,
    nodeChunkR: 10,       // gather hub/settlement nodes within ±this many chunks (window-stability radius)
    renderChunkR: 5,      // only route + draw edges with an endpoint/midpoint within ±this of the player
    kNearest: 3,
    trunkK: 2,
    hubDegCap: 4,
    segStep: 5,
    relaxPasses: 3,
    fall: 2.6,
  };
  var ROAD_TIER = {                                  // w = core roadbed width, world units (HEX is ~4.8u across)
    major:  { w: 2.6, col: 0x9a9ba0, str: 1.00 },    // a great road ~half a hex of packed core
    medium: { w: 1.7, col: 0x85868b, str: 0.82 },
    small:  { w: 1.05, col: 0x737470, str: 0.62 },   // lanes + interior streets: a cart's width, not a highway
    path:   { w: 0.55, col: 0x7a6a50, str: 0.40 },
  };
  var MOVE = {
    roadSpeed: 0.62,
    roughSlow: 0.60,
    roadGrade: 0.85,
    drainBase: 2.0,
    roughDrain: 3.6,
    roadRelief: 0.90,
    regen: 9,
    fatigueAt: 35,
    fatigueSlow: 0.45,
  };
  var TRAVEL_BASE_SPEED = 12.2;   // steady-state banner march on open flat ground, world-units/s

  // ---------- Settlement spec (radii/walls — the mesh-building knobs ride along, they're plain data) ----------
  var SCATTER_DENSITY = 0.28;   // multiplier on biome tree/rock chance — thins features so tiles read clean
  var SG_SPEC = {
    village: { castle: false, R: 10, houses: [13, 7],   castles: [0, 0],   wall: null,       centerClear: 0,    lbl: 3.8, top: 4.2,  gap: 2.0 },
    town:    { castle: true,  R: 21, houses: [50, 14],  castles: [1, 0.4], castleR: 6, bailey: [3, 3], wallH: 1.2, wall: 'palisade', centerClear: 0,    lbl: 5.4, top: 7.0,  gap: 2.0 },
    city:    { castle: true,  R: 48, houses: [330, 90], castles: [3, 0], castleR: 8, bailey: [4, 3], wallH: 1.8, wall: 'stone',    centerClear: 0.30, lbl: 10.5, top: 15.0, gap: 2.0 },
    capital: { castle: true,  R: 58, houses: [440, 100], castles: [3, 0], castleR: 9, bailey: [6, 4], wallH: 2.1, wall: 'stone',    centerClear: 0.32, bigKeep: true, lbl: 12.5, top: 18.0, gap: 2.1 },
  };

  // ---------- Static path helpers ----------
  function angD(a, b) { return Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI); }
  function thinPath(pts) {
    if (pts.length <= 2) return pts;
    var out = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
      var a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      var cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      if (Math.abs(cross) > 2.0 || Math.pow(b.x - a.x, 2) + Math.pow(b.z - a.z, 2) > 100) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  function smoothPath(pts) {
    if (pts.length <= 2) return pts;
    var out = [pts[0]];
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      if (i > 0) out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      if (i < pts.length - 2) out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  function _MinHeap() { this.a = []; }
  _MinHeap.prototype.push = function (n) { var a = this.a; a.push(n); var i = a.length - 1; while (i > 0) { var p = (i - 1) >> 1; if (_heapLt(a[i], a[p])) { var t = a[i]; a[i] = a[p]; a[p] = t; i = p; } else break; } };
  _MinHeap.prototype.pop = function () { var a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; var i = 0; for (;;) { var l = 2 * i + 1, rr = l + 1; var m = i; if (l < a.length && _heapLt(a[l], a[m])) m = l; if (rr < a.length && _heapLt(a[rr], a[m])) m = rr; if (m === i) break; var t = a[i]; a[i] = a[m]; a[m] = t; i = m; } } return top; };
  function _heapLt(x, y) { return x.f !== y.f ? x.f < y.f : x.g !== y.g ? x.g < y.g : x.q !== y.q ? x.q < y.q : x.r < y.r; }
  // axial coords over the same lattice — strides scale cleanly here (odd-r's half-row shift can't)
  function _axC(aq, ar) { return [(aq + ar / 2) * HEX_W, ar * HEX_H]; }
  function _worldToAxial(x, z) { var o = worldToHex(x, z); return [o[0] - ((o[1] - (o[1] & 1)) / 2), o[1]]; }
  var _AX_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

  // Gabriel test: trunk edge (a,b) survives iff no other hub sits inside the circle on diameter ab
  function gabrielEdge(a, b, hubs) {
    var mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5, rr = (Math.pow(a.x - b.x, 2) + Math.pow(a.z - b.z, 2)) * 0.25;
    for (var k = 0; k < hubs.length; k++) {
      var c = hubs[k]; if (c === a || c === b) continue;
      if (Math.pow(c.x - mx, 2) + Math.pow(c.z - mz, 2) < rr - 1e-6) return false;
    }
    return true;
  }
  // flatten routed edges into segments for T-junction searches
  function segIndex(edgeList) {
    var segs = [];
    for (var e = 0; e < edgeList.length; e++) {
      var pts = edgeList[e].pts; if (!pts) continue;
      for (var i = 0; i < pts.length - 1; i++) segs.push({ ax: pts[i].x, az: pts[i].z, bx: pts[i + 1].x, bz: pts[i + 1].z, key: edgeList[e].key + ':' + i });
    }
    return segs;
  }
  function nearestSegPoint(x, z, segs) {
    var best = null;
    for (var s = 0; s < segs.length; s++) {
      var sg = segs[s];
      var vx = sg.bx - sg.ax, vz = sg.bz - sg.az, L2 = vx * vx + vz * vz || 1;
      var u = ((x - sg.ax) * vx + (z - sg.az) * vz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
      var jx = sg.ax + vx * u, jz = sg.az + vz * u, d2 = Math.pow(x - jx, 2) + Math.pow(z - jz, 2);
      if (!best || d2 < best.d2) best = { x: jx, z: jz, d2: d2, key: sg.key };
    }
    return best;
  }
  // a gate's APRON: a point a few strides straight out from the doors
  function gateApron(g, tier) {
    if (!g || g.bearing == null) return null;
    var ap = tier === 'major' ? 7 : tier === 'medium' ? 5 : 3.2;
    return { x: g.x + Math.cos(g.bearing) * ap, z: g.z + Math.sin(g.bearing) * ap };
  }
  // the organic footprint outline — pure from {r: rng, T: probe}; wall & house-fill share it
  function sgFootprint(P) {
    var r = P.r, T = P.T;
    var K = 3 + (r() * 3 | 0), harm = [];
    for (var i = 0; i < K; i++) harm.push({ m: 2 + (r() * 4 | 0), ph: r() * TAU, amp: 0.10 + r() * 0.15 });
    var elongAng = (T.cls === 'RIDGE') ? T.spineAz
                 : (T.cls === 'HILLSIDE' || T.cls === 'COASTAL') ? T.downhill + Math.PI / 2
                 : r() * TAU;
    var elong = 0.12 + r() * 0.32;
    return function (a) {
      var v = 1; for (var h = 0; h < harm.length; h++) v += harm[h].amp * Math.cos(harm[h].m * a + harm[h].ph);
      v *= 1 + elong * Math.cos(2 * (a - elongAng));
      return clamp(v, 0.6, 1.4);
    };
  }
  function sgIsRidge(rim) {
    var n = rim.length, hi = 0; for (var k = 1; k < n; k++) if (rim[k].y > rim[hi].y) hi = k;
    var mean = 0; for (k = 0; k < n; k++) mean += rim[k].y; mean /= n;
    var hiY = rim[hi].y;
    var opp = rim[(hi + n / 2) % n].y, pa = rim[(hi + n / 4) % n].y, pb = rim[(hi + 3 * n / 4) % n].y;
    return opp > mean && Math.min(pa, pb) < mean - (hiY - mean) * 0.4;
  }
  function hexRGB(h, out) { out[0] = ((h >> 16) & 255) / 255; out[1] = ((h >> 8) & 255) / 255; out[2] = (h & 255) / 255; return out; }
  function lerp3(a, b, t) { a[0] += (b[0] - a[0]) * t; a[1] += (b[1] - a[1]) * t; a[2] += (b[2] - a[2]) * t; return a; }
  // ---------- field-value statics: classify/colour/height from (e,t,m) — payload-fed clients render
  // from stored field values, so none of these may touch (x,z) or a seed ----------
  function classifyBiome(e, t, m) {
    if (e < SEA_LEVEL) return e < SEA_LEVEL - 0.10 ? B.OCEAN : B.SHALLOW;
    if (e < SEA_LEVEL + 0.035) return B.BEACH;
    if (e > 0.80) return B.MOUNTAIN;
    if (t < 0.20) return B.TUNDRA;
    if (t < 0.38) return m > 0.45 ? B.TAIGA : B.TUNDRA;
    if (t < 0.58) return m > 0.45 ? B.FOREST : B.GRASS;
    if (t < 0.78) return m > 0.50 ? B.FOREST : B.SAVANNA;
    return m < 0.40 ? B.DESERT : B.SAVANNA;
  }
  function elevToY(e) {
    if (e < SEA_LEVEL) return -0.6 - (SEA_LEVEL - e) * 2.0;
    var land = (e - SEA_LEVEL) / (1 - SEA_LEVEL);
    var h = Math.pow(land, 1.35) * MAP_RELIEF;
    if (e > 0.68) h += (e - 0.68) * MAP_RELIEF * 2.6;
    return h;
  }
  var _gc1 = [0, 0, 0], _gc2 = [0, 0, 0], _gc3 = [0, 0, 0], _gcB = [0, 0, 0];
  function groundColorFromFields(e, t, m, out) {
    if (e < SEA_LEVEL) { hexRGB(0x123a5e, out); return lerp3(out, hexRGB(0x2f86b4, _gcB), clamp(e / SEA_LEVEL, 0, 1)); }
    var seg = 0; while (seg < _BAND_T.length - 2 && t > _BAND_T[seg + 1]) seg++;
    var f = clamp((t - _BAND_T[seg]) / (_BAND_T[seg + 1] - _BAND_T[seg]), 0, 1);
    var dry = lerp3(hexRGB(_BAND_DRY[seg], _gc1), hexRGB(_BAND_DRY[seg + 1], _gcB), f);
    var wet = lerp3(hexRGB(_BAND_WET[seg], _gc2), hexRGB(_BAND_WET[seg + 1], _gc3), f);
    var mw = clamp((m - 0.40) / 0.16, 0, 1);
    out[0] = dry[0]; out[1] = dry[1]; out[2] = dry[2];
    lerp3(out, wet, mw * mw * (3 - 2 * mw));
    var beach = clamp((e - SEA_LEVEL) / 0.05, 0, 1);
    if (beach < 1) lerp3(out, hexRGB(0xddd2a0, _gcB), (1 - beach) * 0.85);
    var rock = clamp((e - 0.66) / 0.12, 0, 1); if (rock > 0) lerp3(out, hexRGB(0x8c8c86, _gcB), rock * 0.7);
    var snow = clamp((e - 0.78) / 0.10, 0, 1); if (snow > 0) lerp3(out, hexRGB(0xeef3f7, _gcB), snow * 0.9);
    var k = clamp(0.80 + (e - SEA_LEVEL) * 0.4, 0.7, 1.0);
    out[0] *= k; out[1] *= k; out[2] *= k;
    return out;
  }

  // ============================================================================
  // Terra.make(tseed[, opts]) — a seed-bound worldgen instance. All memos are per-instance,
  // so "new region" is simply "new instance". Injectables:
  //   opts.capitalsProvider: () => [{x, z, name}]  — the live capital list (client: nations; server: DB rows)
  //   opts.roadFactorAt:     (x, z) => 0..1        — drawn-road benefit for travel costs (client: splat grid)
  //   T.heightFn:            (x, z) => y | null    — display-height override (client wires its mapElevY so
  //                                                  the ?edit sculpted-terrain hook rides through the probes)
  // ============================================================================
  function make(tseed, opts) {
    var seed = tseed >>> 0;
    opts = opts || {};
    var capitalsProvider = opts.capitalsProvider || function () { return []; };
    var roadFactorInj = opts.roadFactorAt || function () { return 0; };

    var T = {
      seed: seed,
      heightFn: null,
      get roadFactorAt() { return roadFactorInj; },
      set roadFactorAt(f) { roadFactorInj = f || function () { return 0; }; },
      get capitalsProvider() { return capitalsProvider; },
      set capitalsProvider(f) { capitalsProvider = f || function () { return []; }; },
    };

    // ---------- per-instance caches (region-scoped by construction) ----------
    var terraMemo = new Map();      // 2u-quantised routing roughness
    var seatMemo = new Map();       // city-block -> land-snapped seat
    var siteCache = new Map();      // "cx,cz" -> reseated settlementSites
    var routeCache = new Map();     // edgeKey|endpoints -> routed polyline
    var wallRingMemo = new Map();   // hold key -> wall ring (per network build)
    var routeAvoid = [];            // walled holds routes flow around (set by roadBuildNetwork)
    var avoidNodes = new Map();     // hold key -> node

    // ---------- fields ----------
    function elevationAt(x, z) {
      var base = fbm((x + 1000) * TERR_SCALE, (z - 1000) * TERR_SCALE, seed + 1);
      var cont = fbm((x - 4000) * TERR_SCALE * 0.20, (z + 4000) * TERR_SCALE * 0.20, seed + 5);
      var e = 0.30 + base * 0.55 + (cont - 0.55) * 0.80;
      var M = MOUNTAINS;
      var belt = fbm((x + 6000) * TERR_SCALE * M.beltScale, (z - 6000) * TERR_SCALE * M.beltScale, seed + 23);
      var inBelt = clamp((belt - M.beltThresh) / M.beltWidth, 0, 1);
      if (inBelt > 0 && e > SEA_LEVEL) {
        var spine = ridge((x - 1500) * TERR_SCALE * M.spineScale, (z + 1500) * TERR_SCALE * M.spineScale, seed + 29);
        e += inBelt * spine * M.lift * clamp((e - SEA_LEVEL) / 0.12, 0, 1);
      }
      return clamp(e, 0, 1);
    }
    function moistureAt(x, z) { return fbm((x - 2200) * TERR_SCALE * 1.15, (z + 1700) * TERR_SCALE * 1.15, seed + 19); }
    // Valleys: broad, slow-drifting patches (independent of biome) that read as clearings —
    // green valleys over wet ground, olive-treed yellow valleys over dry ground. Cuts through
    // forest too, so the same field that keeps grassland empty also glades a stand of firs.
    var VALLEY_SCALE = 0.6, VALLEY_THRESH = 0.60;
    var VALLEY_TREE_CHANCE = 0.0006, VALLEY_ROCK_MUL = 0.35;
    var OLIVE_TREE = 0x6f7a3a;
    function valleyAt(x, z) { return fbm((x + 3300) * TERR_SCALE * VALLEY_SCALE, (z - 3300) * TERR_SCALE * VALLEY_SCALE, seed + 53); }
    function tempAt(x, z) {
      var latBand = clamp((z + MAP_HALF) / (2 * MAP_HALF), 0, 1);
      var prov = fbm((x + 9000) * 0.0016, (z - 9000) * 0.0016, seed + 71);
      var frontier = clamp((Math.hypot(x, z) - MAP_HALF) / (MAP_HALF * 3), 0, 1);
      var lat = latBand * (1 - frontier) + prov * frontier;
      return clamp(lat * 0.95 + 0.03 + fbm(x * 0.025, z * 0.025, seed + 41) * 0.1 - elevationAt(x, z) * 0.18, 0, 1);
    }
    function isWater(x, z) { return elevationAt(x, z) < SEA_LEVEL; }
    function biomeAt(x, z) {
      var e = elevationAt(x, z);
      if (e < SEA_LEVEL || e < SEA_LEVEL + 0.035 || e > 0.80) return classifyBiome(e, 0, 0);
      return classifyBiome(e, tempAt(x, z), moistureAt(x, z));
    }
    // the height the probes/roads see: the client's mapElevY (editor hook) if wired, else analytic
    function heightAt(x, z) { return T.heightFn ? T.heightFn(x, z) : elevToY(elevationAt(x, z)); }

    // ---------- colour (plain [r,g,b] floats — the client wraps them back into THREE.Color) ----------
    function groundColorRGB(x, z, out) {
      var e = elevationAt(x, z);
      if (e < SEA_LEVEL) return groundColorFromFields(e, 0, 0, out);
      return groundColorFromFields(e, tempAt(x, z), moistureAt(x, z), out);
    }
    // realistic ground colour: blended biome + a position-deterministic weathering jitter
    function tileColorRGB(x, z, out) {
      groundColorRGB(x, z, out);
      var jit = 0.86 + vnoise(x * 0.23, z * 0.23, seed + 99) * 0.22 + vnoise(x * 0.6, z * 0.6, seed + 131) * 0.08;
      out[0] *= jit; out[1] *= jit; out[2] *= jit;
      return out;
    }

    // ---------- land seating ----------
    function nearestLand(x, z) {
      if (!isWater(x, z)) return [x, z];
      for (var r = 4; r < MAP_HALF * 2; r += 4) for (var a = 0; a < 12; a++) {
        var ax = x + Math.cos(a / 12 * Math.PI * 2) * r;
        var az = z + Math.sin(a / 12 * Math.PI * 2) * r;
        if (!isWater(ax, az)) return [ax, az];
      }
      return [x, z];
    }
    function landScore(x, z, footR) {
      if (isWater(x, z)) return -1;
      var s = 0, n = 0, rings = [footR * 0.45, footR * 0.72, footR];
      for (var k = 0; k < 16; k++) {
        var a = k / 16 * TAU, ca = Math.cos(a), sa = Math.sin(a);
        for (var ri = 0; ri < 3; ri++) { s += isWater(x + ca * rings[ri], z + sa * rings[ri]) ? 0 : 1; n++; }
      }
      return s / n;
    }
    function bestLandSpot(x0, z0, footR, searchR) {
      var bx = x0, bz = z0, bs = landScore(x0, z0, footR);
      var STEP = Math.max(6, footR * 0.34);
      for (var rad = STEP; rad <= searchR && bs < 0.97; rad += STEP) {
        for (var k = 0; k < 12; k++) {
          var a = k / 12 * TAU + rad * 0.5;
          var x = x0 + Math.cos(a) * rad, z = z0 + Math.sin(a) * rad, sc = landScore(x, z, footR);
          if (sc > bs) { bs = sc; bx = x; bz = z; }
        }
      }
      return bs >= 0 ? { x: bx, z: bz, score: bs } : null;
    }
    function citySeatScore(x, z, footR) {
      var land = landScore(x, z, footR);
      if (land < 0) return -1;
      var rough = 0;
      for (var k = 0; k < 8; k++) { var a = k / 8 * TAU, rr = fastRoughAt(x + Math.cos(a) * footR * 0.6, z + Math.sin(a) * footR * 0.6); rough += rr < 0 ? 1 : rr; }
      return land * (1 - (rough / 8) * 0.75);
    }
    function cityLandCenter(x0, z0, R) {
      var bx = x0, bz = z0, bs = citySeatScore(x0, z0, R);
      var STEP = Math.max(6, R * 0.34);
      for (var rad = STEP; rad <= R * 2.6 && bs < 0.95; rad += STEP)
        for (var k = 0; k < 12; k++) {
          var a = k / 12 * TAU + rad * 0.5;
          var x = x0 + Math.cos(a) * rad, z = z0 + Math.sin(a) * rad, sc = citySeatScore(x, z, R);
          if (sc > bs) { bs = sc; bx = x; bz = z; }
        }
      return bs >= 0.62 ? { x: bx, z: bz, score: bs } : null;
    }

    // ---------- capital seats: the five powers' positions are PURE terrain (client + server agree) ----------
    // Port of the client's placeCapitals position math: themed bearing + seeded wobble, ring
    // MAP_HALF*1.5, seated on solid land. Ownership/garrison state lives elsewhere (DB / client).
    function capitalSeats() {
      var out = [];
      var jitter = ((seed % 1000) / 1000 - 0.5) * 0.18;   // ±~5°
      // The five crowns ride a WIDE ring: the old MAP_HALF*1.5 (135u) packed 58u-wall capitals only
      // ~18u apart on the tight bearings, so their walls collapsed into each other. At MAP_HALF*2.4
      // (216u) the ring circumference finally has room for five capital footprints.
      var CAP_RING = MAP_HALF * 2.4;
      var i;
      for (i = 0; i < NATION_HOMES.length; i++) {
        var ang = NATION_HOMES[i].home + jitter, bx = Math.cos(ang) * CAP_RING, bz = Math.sin(ang) * CAP_RING;
        var spot = bestLandSpot(bx, bz, 36, 16);
        var p = spot ? [spot.x, spot.z] : nearestLand(bx, bz);
        out.push({ idx: i, name: NATION_HOMES[i].name, x: p[0], z: p[1] });
      }
      // Guarantee the crowns stay apart no matter what the coastline did to their seats: relax any
      // over-close pair apart along its axis (deterministic — pure geometry), then re-snap to land.
      var MIN_SEP = SG_SPEC.capital.R * 2 + 80;           // ≥ ~80u of open country between capital walls
      for (var pass = 0; pass < 8; pass++) {
        var moved = false;
        for (i = 0; i < out.length; i++) for (var j = i + 1; j < out.length; j++) {
          var A = out[i], Bc = out[j], dx = Bc.x - A.x, dz = Bc.z - A.z, d = Math.hypot(dx, dz) || 1e-3;
          if (d >= MIN_SEP) continue;
          var push = (MIN_SEP - d) / 2, ux = dx / d, uz = dz / d;
          A.x -= ux * push; A.z -= uz * push; Bc.x += ux * push; Bc.z += uz * push;
          moved = true;
        }
        if (!moved) break;
      }
      for (i = 0; i < out.length; i++) { var q = nearestLand(out[i].x, out[i].z); out[i].x = q[0]; out[i].z = q[1]; }
      return out;
    }

    // ---------- settlement reseating: kernel identity, land-decided positions ----------
    function blockCityRaw(bx, bz) {           // mirrors WorldSim.blockCity (block coords in)
      var r = mulberry32((Math.imul(bx | 0, 668265263) ^ Math.imul(bz | 0, 374761393) ^ Math.imul(seed >>> 0, 2654435761)) >>> 0);
      if (r() >= 0.5) return null;
      return { x: (bx + 0.5 + (r() - 0.5) * 0.3) * CITY_BLOCK * CHUNK, z: (bz + 0.5 + (r() - 0.5) * 0.3) * CITY_BLOCK * CHUNK };
    }
    function citySeat(bx, bz) {
      var k = bx + ',' + bz;
      var v = seatMemo.get(k);
      if (v === undefined) { var c = blockCityRaw(bx, bz); v = c ? cityLandCenter(c.x, c.z, SG_SPEC.city.R) : null; seatMemo.set(k, v); }
      return v;
    }
    // which way is the nearest highway? — a hold's MAIN GATE faces the road that serves it
    function roadwardBearing(x, z) {
      var BW = CITY_BLOCK * CHUNK, bx0 = Math.floor(x / BW), bz0 = Math.floor(z / BW);
      var seats = [];
      for (var bx = bx0 - 2; bx <= bx0 + 2; bx++) for (var bz = bz0 - 2; bz <= bz0 + 2; bz++) { var c = citySeat(bx, bz); if (c) seats.push(c); }
      var caps = capitalsProvider();
      for (var i = 0; i < caps.length; i++) { var n = caps[i]; if (Math.hypot(n.x - x, n.z - z) < BW * 2.5) seats.push({ x: n.x, z: n.z }); }
      if (seats.length < 2) return null;
      var best = null;
      for (i = 0; i < seats.length; i++) for (var j = i + 1; j < seats.length; j++) {
        var A = seats[i], Bb = seats[j];
        if (Math.hypot(A.x - x, A.z - z) < 8 || Math.hypot(Bb.x - x, Bb.z - z) < 8) continue;
        var mx = (A.x + Bb.x) / 2, mz = (A.z + Bb.z) / 2, rr = (Math.pow(A.x - Bb.x, 2) + Math.pow(A.z - Bb.z, 2)) / 4;
        var open = true;
        for (var q = 0; q < seats.length; q++) { var cc = seats[q]; if (cc === A || cc === Bb) continue; if (Math.pow(cc.x - mx, 2) + Math.pow(cc.z - mz, 2) < rr - 1e-6) { open = false; break; } }
        if (!open) continue;
        var vx = Bb.x - A.x, vz = Bb.z - A.z, L2 = vx * vx + vz * vz || 1;
        var u = ((x - A.x) * vx + (z - A.z) * vz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
        var px = A.x + vx * u, pz = A.z + vz * u, d2 = Math.pow(x - px, 2) + Math.pow(z - pz, 2);
        if (!best || d2 < best.d2) best = { px: px, pz: pz, d2: d2 };
      }
      if (!best || best.d2 > 90 * 90 || best.d2 < 4) return null;
      return Math.atan2(best.pz - z, best.px - x);
    }
    // pull a town/village onto the wayside of the arterial skeleton
    function snapToSkeleton(s) {
      var BW = CITY_BLOCK * CHUNK, bx0 = Math.floor(s.x / BW), bz0 = Math.floor(s.z / BW);
      var seats = [];
      for (var bx = bx0 - 2; bx <= bx0 + 2; bx++) for (var bz = bz0 - 2; bz <= bz0 + 2; bz++) { var c = citySeat(bx, bz); if (c) seats.push(c); }
      var caps = capitalsProvider();
      for (var i = 0; i < caps.length; i++) { var n = caps[i]; if (Math.hypot(n.x - s.x, n.z - s.z) < BW * 2.5) seats.push({ x: n.x, z: n.z }); }
      if (seats.length < 2) return;
      var best = null;
      for (i = 0; i < seats.length; i++) for (var j = i + 1; j < seats.length; j++) {
        var A = seats[i], Bb = seats[j];
        var mx = (A.x + Bb.x) / 2, mz = (A.z + Bb.z) / 2, rr = (Math.pow(A.x - Bb.x, 2) + Math.pow(A.z - Bb.z, 2)) / 4;
        var open = true;
        for (var q = 0; q < seats.length; q++) { var cc = seats[q]; if (cc === A || cc === Bb) continue; if (Math.pow(cc.x - mx, 2) + Math.pow(cc.z - mz, 2) < rr - 1e-6) { open = false; break; } }
        if (!open) continue;
        var vx = Bb.x - A.x, vz = Bb.z - A.z, L2 = vx * vx + vz * vz || 1, L = Math.sqrt(L2);
        var uMin = Math.min(0.45, 75 / L);
        var u = ((s.x - A.x) * vx + (s.z - A.z) * vz) / L2; u = u < uMin ? uMin : u > 1 - uMin ? 1 - uMin : u;
        var px = A.x + vx * u, pz = A.z + vz * u, d2 = Math.pow(s.x - px, 2) + Math.pow(s.z - pz, 2);
        if (!best || d2 < best.d2) best = { px: px, pz: pz, d2: d2, nx: -vz / L, nz: vx / L };
      }
      var cap = s.tier === 'town' ? 60 : 60;   // keep holds local to their chunk so the overlap scan can see every collision
      if (!best || best.d2 > cap * cap) return;
      var rng = mulberry32((chunkHash(s.cx, s.cz, seed) ^ Math.imul(s.idx + 11, 0x27d4eb2f)) >>> 0);
      if (s.tier === 'village') {
        if (isWater(best.px, best.pz)) return;
        s.x = best.px; s.z = best.pz;
        s.roadAx = Math.atan2(-best.nx, best.nz) + Math.PI / 2;
        return;
      }
      var off = 24 + rng() * 4, sgn = rng() < 0.5 ? -1 : 1;
      for (var sd = 0; sd < 2; sd++) {
        var side = sd === 0 ? sgn : -sgn;
        var tx = best.px + best.nx * off * side, tz = best.pz + best.nz * off * side;
        if (!isWater(tx, tz)) { s.x = tx; s.z = tz; return; }
      }
    }
    // reseat a chunk's raw kernel sites onto the land — cities to their block seat, holds onto the
    // road skeleton. No keep-out and, crucially, NO recursion into settlementSites, so the neighbour
    // scan below can call this freely to see what the next chunk over placed.
    var rawCache = new Map();               // "cx,cz" -> reseated (pre-cull) sites, reused by neighbour scans
    function reseatRaw(cx, cz) {
      var key = cx + ',' + cz, hit = rawCache.get(key);
      if (hit) return hit;
      var sites = WorldSim.settlementSites(cx, cz, seed);
      for (var i = sites.length - 1; i >= 0; i--) {
        var s = sites[i];
        if (s.tier === 'city') {
          var c = citySeat(Math.floor(s.x / (CITY_BLOCK * CHUNK)), Math.floor(s.z / (CITY_BLOCK * CHUNK)));
          if (c) { s.x = c.x; s.z = c.z; } else sites.splice(i, 1);
        } else snapToSkeleton(s);
      }
      if (rawCache.size > 40000) rawCache.clear();
      rawCache.set(key, sites);
      return sites;
    }
    function holdRank(t) { return t === 'capital' ? 4 : t === 'city' ? 3 : t === 'town' ? 2 : 1; }
    // a stable global tie-break so BOTH chunks in an overlapping cross-chunk pair drop the SAME hold
    function holdKey(s) { return (Math.imul(s.cx | 0, 73856093) ^ Math.imul(s.cz | 0, 19349663) ^ Math.imul((s.idx | 0) + 1, 83492791)) >>> 0; }
    // deterministic settlement sites within a chunk — kernel identity, land-decided positions.
    // A hold is dropped when its walls would touch a HIGHER-priority hold (bigger tier, or equal tier
    // with the smaller holdKey) in this chunk or any of the eight neighbours — so exactly one of every
    // overlapping pair survives and client + server agree on which.
    function settlementSites(cx, cz) {
      var sites = reseatRaw(cx, cz).slice();  // copy — we cull this list but must NOT mutate the raw cache
      var caps = capitalsProvider();
      var others = sites.slice();            // this chunk's holds, pre-cull, for same-chunk comparisons
      // scan ±SCAN chunks: a hold snaps at most ~88u onto the road skeleton, so a collision's home
      // chunk can be up to ~4 cells away — anything nearer than that must be visible from here.
      var SCAN = 4;
      for (var nx = cx - SCAN; nx <= cx + SCAN; nx++) for (var nz = cz - SCAN; nz <= cz + SCAN; nz++) {
        if (nx === cx && nz === cz) continue;
        var ns = reseatRaw(nx, nz);
        for (var q = 0; q < ns.length; q++) others.push(ns[q]);
      }
      var gap = 8;
      for (var i = sites.length - 1; i >= 0; i--) {
        var s = sites[i], myR = (SG_SPEC[s.tier] || SG_SPEC.village).R;
        if (s.tier === 'city') {
          // never seat a city on top of a capital — drop it if its walls would touch a crown's
          if (nearBigHold(s.x, s.z, SG_SPEC.city.R, caps, s)) { sites.splice(i, 1); continue; }
        } else if (nearBigHold(s.x, s.z, myR, caps, s)) { sites.splice(i, 1); continue; }
        // walled holds must not overlap each other; the lower-priority one yields
        if (s.tier === 'village') continue;   // villages have no wall — let them nestle close
        var myRank = holdRank(s.tier), myKey = holdKey(s), lose = false;
        for (var k = 0; k < others.length; k++) {
          var o = others[k];
          if (o === s || o.tier === 'village') continue;
          if (o.cx === s.cx && o.cz === s.cz && o.idx === s.idx) continue;
          var oRank = holdRank(o.tier);
          var better = oRank > myRank || (oRank === myRank && holdKey(o) < myKey);
          if (!better) continue;
          if (Math.hypot(o.x - s.x, o.z - s.z) < myR + (SG_SPEC[o.tier] || SG_SPEC.village).R + gap) { lose = true; break; }
        }
        if (lose) sites.splice(i, 1);
      }
      return sites;
    }
    // does a hold of radius myR at (x,z) overlap any nearby city seat or capital (walls touching)?
    function nearBigHold(x, z, myR, caps, self) {
      var BW = CITY_BLOCK * CHUNK, bx0 = Math.floor(x / BW), bz0 = Math.floor(z / BW), gap = 8;
      for (var bx = bx0 - 1; bx <= bx0 + 1; bx++) for (var bz = bz0 - 1; bz <= bz0 + 1; bz++) {
        var c = citySeat(bx, bz); if (!c) continue;
        if (self && Math.abs(c.x - x) < 1e-3 && Math.abs(c.z - z) < 1e-3) continue;   // that's me
        if (Math.hypot(c.x - x, c.z - z) < SG_SPEC.city.R + myR + gap) return true;
      }
      for (var k = 0; k < caps.length; k++) {
        var n = caps[k];
        if (Math.hypot(n.x - x, n.z - z) < SG_SPEC.capital.R + myR + gap) return true;
      }
      return false;
    }
    function roadSites(cx, cz) {
      var k = cx + ',' + cz, s = siteCache.get(k);
      if (!s) { s = settlementSites(cx, cz); siteCache.set(k, s); }
      return s;
    }

    // ---------- ruggedness + march speed ----------
    function landRoughAt(x, z) {
      var e = elevationAt(x, z);
      if (e < SEA_LEVEL) return 1;
      var hi = clamp((e - 0.50) / 0.34, 0, 1);
      var d = 3.2;
      var ex = elevationAt(x + d, z) - elevationAt(x - d, z);
      var ez = elevationAt(x, z + d) - elevationAt(x, z - d);
      var slope = clamp(Math.hypot(ex, ez) / (2 * d) * 70, 0, 1);
      var rough = Math.max(hi, slope * 0.92);
      var b = biomeAt(x, z);
      if (b === B.FOREST || b === B.TAIGA) rough = Math.max(rough, 0.22);
      return clamp(rough, 0, 1);
    }
    function fastRoughAt(x, z) {
      var k = Math.round(x * 0.5) * 131071 + Math.round(z * 0.5);
      var v = terraMemo.get(k);
      if (v === undefined) {
        var e = elevationAt(x, z);
        if (e < SEA_LEVEL) v = -1;
        else { var hi = (e - 0.50) / 0.34; v = hi < 0 ? 0 : hi > 1 ? 1 : hi; }
        if (terraMemo.size > 200000) terraMemo.clear();
        terraMemo.set(k, v);
      }
      return v;
    }
    // march-speed multiplier — stamina: pass the party's 0..100 to apply fatigue, null to skip
    function terrainSpeedMul(road, rough, stamina) {
      var effRough = rough * (1 - road * MOVE.roadGrade);
      var m = (1 + road * MOVE.roadSpeed) * (1 - effRough * MOVE.roughSlow);
      if (stamina != null) { var f = clamp(1 - stamina / MOVE.fatigueAt, 0, 1); m *= 1 - f * MOVE.fatigueSlow; }
      return clamp(m, 0.3, 1.8);
    }

    // ---------- the hex-lattice A* (deterministic; total-order heap tie-break) ----------
    function hexAStar(ax, az, bx, bz, cellCost, hFloor, maxExpand, stride) {
      var st = Math.max(1, stride | 0), step = HEX_W * st;
      var sA = _worldToAxial(ax, az);
      var sq = sA[0], sr = sA[1];
      var gA = _worldToAxial(bx, bz);
      var gq = sq + Math.round((gA[0] - sq) / st) * st, gr = sr + Math.round((gA[1] - sr) / st) * st;
      var gC = _axC(gq, gr), gx = gC[0], gzz = gC[1];
      var open = new _MinHeap(), best = new Map(), parents = new Map(), memo = new Map();
      var hK = function (q, r) { return q + ',' + r; };
      var cellC = function (q, r, x, z) { var k = hK(q, r); var c = memo.get(k); if (c === undefined) { c = cellCost(x, z); memo.set(k, c); } return c; };
      var sC = _axC(sq, sr);
      open.push({ q: sq, r: sr, g: 0, f: Math.hypot(gx - sC[0], gzz - sC[1]) * hFloor });
      best.set(hK(sq, sr), 0);
      var found = false, expanded = 0;
      while (open.a.length) {
        var cur = open.pop(), ck = hK(cur.q, cur.r);
        if (best.get(ck) < cur.g - 1e-9) continue;
        if (cur.q === gq && cur.r === gr) { found = true; break; }
        if (++expanded > maxExpand) break;
        for (var di = 0; di < _AX_DIRS.length; di++) {
          var d = _AX_DIRS[di];
          var nq = cur.q + d[0] * st, nr = cur.r + d[1] * st;
          var nC = _axC(nq, nr), nx = nC[0], nz = nC[1];
          var cc = cellC(nq, nr, nx, nz); if (!(cc < Infinity)) continue;
          var ng = cur.g + step * cc, nk = hK(nq, nr), ex = best.get(nk);
          if (ex !== undefined && ex <= ng + 1e-9) continue;
          best.set(nk, ng); parents.set(nk, ck);
          open.push({ q: nq, r: nr, g: ng, f: ng + Math.hypot(gx - nx, gzz - nz) * hFloor });
        }
      }
      if (!found) return null;
      var pts = [], k = hK(gq, gr);
      while (k !== undefined) { var ci = k.indexOf(','), q = +k.slice(0, ci), r = +k.slice(ci + 1); var w = _axC(q, r); pts.push({ x: w[0], z: w[1] }); k = parents.get(k); }
      pts.reverse();
      pts[0] = { x: ax, z: az }; pts[pts.length - 1] = { x: bx, z: bz };
      var out = smoothPath(thinPath(pts));
      for (var i = 1; i < out.length - 1; i++) if (fastRoughAt(out[i].x, out[i].z) < 0) {  // Chaikin cut a lake corner — probe ashore
        var px = out[i].x, pz = out[i].z, fixed = false;
        for (var rri = 0; rri < 2 && !fixed; rri++) {
          var rr = rri === 0 ? 3 : 6;
          for (var kk = 0; kk < 8; kk++) {
            var a = kk / 8 * TAU, nx2 = px + Math.cos(a) * rr, nz2 = pz + Math.sin(a) * rr;
            if (fastRoughAt(nx2, nz2) >= 0) { out[i] = { x: nx2, z: nz2 }; fixed = true; break; }
          }
        }
      }
      return out;
    }

    // ---------- travel costs + route planning ----------
    function roadBuildCost(x, z, avoid, rays) {
      var rough = fastRoughAt(x, z);
      if (rough < 0) return Infinity;
      var c = 1 + rough * rough * 7;
      for (var i = 0; i < avoid.length; i++) {
        var t = avoid[i], dx = x - t.x, dz = z - t.z;
        if (dx * dx + dz * dz < t.r2) {
          var inChannel = false;
          if (rays) for (var k = 0; k < rays.length && !inChannel; k++) {
            var ry = rays[k], px = x - ry.x, pz = z - ry.z;
            var u = px * ry.dx + pz * ry.dz;
            if (u > -3 && u < 36) { var ox = px - ry.dx * u, oz = pz - ry.dz * u; if (ox * ox + oz * oz < 4.5 * 4.5) inChannel = true; }
          }
          if (!inChannel) c += 60;
          break;
        }
      }
      return c;
    }
    function avoidNear(A, Bb) {
      var pad = 70;
      var x0 = Math.min(A.x, Bb.x) - pad, x1 = Math.max(A.x, Bb.x) + pad;
      var z0 = Math.min(A.z, Bb.z) - pad, z1 = Math.max(A.z, Bb.z) + pad;
      var out = [];
      for (var i = 0; i < routeAvoid.length; i++) {
        var t = routeAvoid[i];
        if (t.x >= x0 && t.x <= x1 && t.z >= z0 && t.z <= z1) out.push(t);
      }
      return out;
    }
    function travelCost(x, z, avoid) {
      var rough = fastRoughAt(x, z);
      if (rough < 0) return Infinity;
      var mul = terrainSpeedMul(roadFactorInj(x, z), rough, null);
      var av = avoid || routeAvoid;
      for (var i = 0; i < av.length; i++) {
        var t = av[i], dx = x - t.x, dz = z - t.z;
        if (dx * dx + dz * dz < t.r2) { mul *= 0.34; break; }
      }
      return 1 / (TRAVEL_BASE_SPEED * mul);
    }
    function travelPath(sx, sz, tx, tz, maxExpand) {
      var d0 = Math.hypot(tx - sx, tz - sz);
      var avoid = avoidNear({ x: sx, z: sz }, { x: tx, z: tz });
      var pts = hexAStar(sx, sz, tx, tz, function (x, z) { return travelCost(x, z, avoid); }, 1.3 / (TRAVEL_BASE_SPEED * 1.8), maxExpand || 16000, d0 > 140 ? 2 : 1);
      if (!pts) return null;
      var secs = 0, road = 0, total = 0;
      for (var i = 1; i < pts.length; i++) {
        var mx = (pts[i].x + pts[i - 1].x) / 2, mz = (pts[i].z + pts[i - 1].z) / 2;
        var d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        secs += d * travelCost(mx, mz); total += d;
        if (roadFactorInj(mx, mz) > 0.45) road += d;
      }
      return { pts: pts, seconds: secs, roadFrac: total ? road / total : 0 };
    }

    // ---------- settlement probes, gates, streets (the sg* family the walls + roads share) ----------
    function sgProbe(X, Z, spec) {
      var cache = new Map();
      var Y = function (x, z) { var k = (x * 4 | 0) + ',' + (z * 4 | 0); var v = cache.get(k); if (v === undefined) { v = heightAt(x, z); cache.set(k, v); } return v; };
      var refY = heightAt(X, Z), R = spec.R, e = HEX_R;
      var gx = 0.5 * (Y(X + e, Z) - Y(X - e, Z)) / (2 * e) + 0.5 * (Y(X + R, Z) - Y(X - R, Z)) / (2 * R);
      var gz = 0.5 * (Y(X, Z + e) - Y(X, Z - e)) / (2 * e) + 0.5 * (Y(X, Z + R) - Y(X, Z - R)) / (2 * R);
      var slope = Math.hypot(gx, gz), downhill = Math.atan2(gz, gx), uphill = downhill + Math.PI;
      var NS = 16, rim = [], minY = 1e9, maxY = -1e9, sum = 0, wet = 0, hiK = 0, hiY = -1e9;
      for (var k = 0; k < NS; k++) {
        var a = k / NS * TAU, rx = X + Math.cos(a) * R, rz = Z + Math.sin(a) * R, y = Y(rx, rz);
        rim.push({ a: a, y: y }); minY = Math.min(minY, y); maxY = Math.max(maxY, y); sum += y;
        if (y > hiY) { hiY = y; hiK = k; }
        if (isWater(rx, rz)) wet++;
      }
      var rimMean = sum / NS, relief = maxY - minY, prom = refY - rimMean, wetFrac = wet / NS;
      var cls;
      if (wetFrac > 0.12) cls = 'COASTAL';
      else if (prom > 1.5) cls = 'KNOLL';
      else if (prom < -1.0) cls = 'VALLEY';
      else if (slope < 0.14 && relief < 2.0) cls = 'PLAIN';
      else cls = (relief > 2.5 && sgIsRidge(rim)) ? 'RIDGE' : 'HILLSIDE';
      return { Y: Y, refY: refY, R: R, slope: slope, downhill: downhill, uphill: uphill, rim: rim, rimMean: rimMean, relief: relief, prom: prom, wetFrac: wetFrac, cls: cls, spineAz: rim[hiK].a };
    }
    // big-gate + postern BEARINGS for a walled hold — shared by the wall builder and the road engine
    function cityGateBearings(P, siteSeed, x, z) {
      var dryAt = function (b) { return x == null || (!isWater(x + Math.cos(b) * P.R * 0.9, z + Math.sin(b) * P.R * 0.9) && !isWater(x + Math.cos(b) * P.R * 1.4, z + Math.sin(b) * P.R * 1.4)); };
      var taken = [];
      var dry = function (b0) {
        for (var t = 0; t < 13; t++) {
          var b = b0 + (t % 2 ? -1 : 1) * Math.ceil(t / 2) * 0.42;
          if (dryAt(b) && taken.every(function (g) { return angD(b, g) > 0.5; })) { taken.push(b); return b; }
        }
        taken.push(b0); return b0;
      };
      var roadward = (x != null) ? roadwardBearing(x, z) : null;
      var base = roadward != null ? roadward : P.downhill;
      var big = [dry(base), dry(base + TAU / 3), dry(base - TAU / 3)];
      var rr = mulberry32((((siteSeed || 0) >>> 0) ^ 0x9A7E5) >>> 0), small = [];
      var n = 2 + (rr() * 2 | 0);
      for (var i = 0; i < n; i++) for (var t = 0; t < 10; t++) {
        var b = rr() * TAU;
        if (dryAt(b) && big.every(function (g) { return angD(b, g) > 0.55; }) && small.every(function (g) { return angD(b, g) > 0.6; })) { small.push(b); break; }
      }
      return { big: big, small: small };
    }
    // the two lesser keeps of a stone hold — pure from the site seed, clear of the gate bearings
    function cityFlankerCastles(P, siteSeed, spec, gateBearings) {
      if (!spec || spec.wall !== 'stone') return [];
      var rr = mulberry32((((siteSeed || 0) >>> 0) ^ 0xCA57E) >>> 0), out = [];
      var cR = (spec.castleR || spec.R * 0.42) * 0.68;
      var base = rr() * TAU;
      for (var t = 0; t < 8 && gateBearings.some(function (g) { return angD(base, g) < 0.5 || angD(base + Math.PI, g) < 0.5; }); t++) base = rr() * TAU;
      for (var i = 0; i < 2; i++) {
        var a = base + i * Math.PI + (rr() - 0.5) * 0.4, d = spec.R * (0.56 + rr() * 0.08);
        out.push({ cx: Math.cos(a) * d, cz: Math.sin(a) * d, cR: cR });
      }
      return out;
    }
    function settlementStreetPlan(x, z, tier, siteSeed) {
      var spec = SG_SPEC[tier]; if (!spec || !spec.wall) return [];
      var p = sgProbe(x, z, spec);
      var fp = sgFootprint({ r: mulberry32((siteSeed || 0) >>> 0), T: p });
      var margin = spec.wall === 'stone' ? 2.6 : 1.5;
      var Rfit = Math.max(spec.R * 0.5, spec.R + margin / 0.8);
      var R = spec.R, r0 = (spec.castleR || R * 0.42) + 2.2;
      var gbAll = cityGateBearings(p, siteSeed, x, z);
      var bearings = spec.wall === 'stone' ? gbAll.big : [gbAll.big[0]];
      var st = [];
      for (var bi = 0; bi < bearings.length; bi++) {
        var b = bearings[bi];
        st.push({ w: 2.0, art: true, pts: [
          { x: x + Math.cos(b) * r0, z: z + Math.sin(b) * r0 },
          { x: x + Math.cos(b) * Rfit * fp(b), z: z + Math.sin(b) * Rfit * fp(b) }] });
      }
      var plaza = { w: 1.5, art: false, pts: [] };
      for (var k = 0; k <= 12; k++) { var a = k / 12 * TAU; plaza.pts.push({ x: x + Math.cos(a) * r0, z: z + Math.sin(a) * r0 }); }
      st.push(plaza);
      if (spec.wall === 'stone') {
        var rr = mulberry32((((siteSeed || 0) >>> 0) ^ 0x57E37) >>> 0);
        var flank = cityFlankerCastles(p, siteSeed, spec, bearings);
        var blocked = function (px, pz) { return flank.some(function (c) { return Math.pow(px - (x + c.cx), 2) + Math.pow(pz - (z + c.cz), 2) < Math.pow(c.cR * 1.5 + 1.5, 2); }); };
        var bs = bearings.slice().sort(function (a1, b1) { return a1 - b1; });
        var fracs = [0.48, 0.76];
        for (var fi = 0; fi < fracs.length; fi++) {
          var frac = fracs[fi];
          for (var i = 0; i < bs.length; i++) {
            if (rr() < 0.3) continue;
            var a0 = bs[i], a1 = (i === bs.length - 1 ? bs[0] + TAU : bs[i + 1]);
            var steps = Math.max(3, Math.round((a1 - a0) / 0.38));
            var seg = null;
            for (k = 0; k <= steps; k++) {
              a = a0 + (a1 - a0) * k / steps;
              var px = x + Math.cos(a) * R * frac * fp(a), pz = z + Math.sin(a) * R * frac * fp(a);
              if (blocked(px, pz)) { if (seg && seg.pts.length >= 2) st.push(seg); seg = null; continue; }
              if (!seg) seg = { w: 1.1, art: false, pts: [] };
              seg.pts.push({ x: px, z: pz });
            }
            if (seg && seg.pts.length >= 2) st.push(seg);
          }
        }
      }
      return st;
    }
    function settlementGates(x, z, tier, siteSeed) {
      var spec = SG_SPEC[tier]; if (!spec || !spec.wall) return { big: [], small: [] };
      var p = sgProbe(x, z, spec);
      var fp = sgFootprint({ r: mulberry32((siteSeed || 0) >>> 0), T: p });
      var margin = spec.wall === 'stone' ? 2.6 : 1.5;
      var Rfit = Math.max(spec.R * 0.5, spec.R + margin / 0.8);
      var at = function (b) { var RA = Rfit * fp(b); return { x: x + Math.cos(b) * RA, z: z + Math.sin(b) * RA, bearing: b }; };
      var gb = cityGateBearings(p, siteSeed, x, z);
      if (spec.wall === 'stone') return { big: gb.big.map(at), small: gb.small.map(at) };
      return { big: [at(gb.big[0])], small: [] };
    }
    // the WALL RING as a plain point list — the exact polygon sgCityWall/sgPalisade seat their
    // bays on (probe + seeded footprint + kernel-pinned radius + wet-vertex pull-ashore). The
    // rung-0 hold icon traces THIS ring and the server persists it in the chunk payload, so the
    // overworld border IS the real wall, not a stand-in circle. Returns [[lx,lz],...] local
    // offsets from the seat (0.1u quantised, JSON-friendly), or null for unwalled tiers.
    function wallRingPts(x, z, tier, siteSeed) {
      var spec = SG_SPEC[tier]; if (!spec || !spec.wall) return null;
      var p = sgProbe(x, z, spec);
      var fp = sgFootprint({ r: mulberry32((siteSeed || 0) >>> 0), T: p });
      var margin = spec.wall === 'stone' ? 2.6 : 1.5;
      var Rfit = Math.max(spec.R * 0.5, spec.R + margin / 0.8);
      var N = Math.max(30, Math.round(Rfit * 1.4 * 1.3));
      var pts = [];
      for (var k = 0; k < N; k++) {
        var a = k / N * TAU, RA = Rfit * fp(a), R = RA;
        var lx = Math.cos(a) * R, lz = Math.sin(a) * R;
        while (isWater(x + lx, z + lz) && R > RA * 0.45) { R -= 1.2; lx = Math.cos(a) * R; lz = Math.sin(a) * R; }
        pts.push([Math.round(lx * 10) / 10, Math.round(lz * 10) / 10]);
      }
      return pts;
    }

    // ---------- per-chunk decoration: trees + rocks, deterministic from the chunk seed ----------
    // The PLACEMENT kernel behind the client's scatter meshes AND the server's persisted street
    // detail — both sides derive the identical list from (cx, cz, tseed). One roll per hex cell
    // (at most one feature, on its centre); water cells draw nothing. Roads are NOT considered
    // here: the roadbed-clearing filter is a render-time concern (the client knows its drawn
    // roads), so placement stays pure. Returns compact rows, JSON-friendly for chunk_detail:
    //   trees: [x, z, colorHex, sc, trunkH, rotY]      rocks: [x, z, r, e1, e2, e3, squash]
    function chunkScatter(cx, cz) {
      var rng = mulberry32((chunkHash(cx, cz, seed) ^ 0x5EED) >>> 0);
      var cells = hexCellsInChunk(cx, cz), picks = [], trees = [], rocks = [];
      for (var i = 0; i < cells.length; i++) {
        var jx = cells[i][2], jz = cells[i][3];
        if (isWater(jx, jz)) continue;                                  // no roll — matches the client stream
        var b = biomeAt(jx, jz), roll = rng();
        var tc, rc, treeCol;
        if (b !== B.MOUNTAIN && valleyAt(jx, jz) > VALLEY_THRESH) {     // an open valley cuts through, wet or dry
          tc = VALLEY_TREE_CHANCE; rc = b.rockChance * SCATTER_DENSITY * VALLEY_ROCK_MUL;
          treeCol = b.dry ? OLIVE_TREE : b.tree;
        } else {
          tc = b.treeChance * SCATTER_DENSITY; rc = b.rockChance * SCATTER_DENSITY; treeCol = b.tree;
        }
        if (roll < tc) picks.push([1, jx, jz, treeCol]);
        else if (roll < tc + rc) picks.push([0, jx, jz]);
      }
      for (i = 0; i < picks.length; i++) if (picks[i][0]) {             // trees first, then rocks — the client's draw order
        var sc = 0.8 + rng() * 0.7, th = (2 + rng()) * sc, rot = rng() * Math.PI;
        trees.push([picks[i][1], picks[i][2], picks[i][3], sc, th, rot]);
      }
      for (i = 0; i < picks.length; i++) if (!picks[i][0]) {
        var rr = 0.6 + rng() * 1.0, e1 = rng(), e2 = rng(), e3 = rng(), sq = 0.6 + rng() * 0.4;
        rocks.push([picks[i][1], picks[i][2], rr, e1, e2, e3, sq]);
      }
      return { trees: trees, rocks: rocks };
    }
    // Street-level groves: every map tree becomes a small stand of 3-5. The satellites are pure
    // from the chunk seed (salt 0x66E5) so the server persists exactly what the client grows.
    // Water rejection happens AFTER the draws — the stream stays stable near coastlines.
    function chunkGroves(cx, cz, base) {
      var sc0 = base || chunkScatter(cx, cz);
      var rng = mulberry32((chunkHash(cx, cz, seed) ^ 0x66E5) >>> 0);
      var out = [];
      for (var i = 0; i < sc0.trees.length; i++) {
        var t = sc0.trees[i], n = 2 + (rng() * 3 | 0);                  // 2-4 satellites → a 3-5 tree stand
        for (var k = 0; k < n; k++) {
          var ang = rng() * TAU, d = 2.2 + rng() * 3.6;
          var sc = t[3] * (0.7 + rng() * 0.55), rot = rng() * Math.PI, thM = 0.85 + rng() * 0.3;
          var x = t[0] + Math.cos(ang) * d, z = t[1] + Math.sin(ang) * d;
          if (isWater(x, z)) continue;
          out.push([x, z, t[2], sc, (t[4] / t[3]) * sc * thM, rot]);
        }
      }
      return out;
    }

    // ---------- the road network: nodes → hierarchy → routed polylines ----------
    function roadGatherNodes(pcx, pcz) {
      if (routeCache.size > 4000) routeCache.clear();     // region-scoped caches, bounded on a very long ride
      if (siteCache.size > 2000) siteCache.clear();
      var nodes = [];
      var caps = capitalsProvider();
      for (var i = 0; i < caps.length; i++) {
        var n = caps[i];
        if (isWater(n.x, n.z)) continue;
        var cseed = (Math.imul(Math.round(n.x) | 0, 73856093) ^ Math.imul(Math.round(n.z) | 0, 19349663) ^ (seed >>> 0)) >>> 0;
        nodes.push({ x: n.x, z: n.z, rank: 3, tier: 'capital', seed: cseed, key: 'cap:' + n.name });
      }
      var R = ROAD.nodeChunkR;
      for (var cx = pcx - R; cx <= pcx + R; cx++) for (var cz = pcz - R; cz <= pcz + R; cz++) {
        var sites = roadSites(cx, cz);
        for (var si = 0; si < sites.length; si++) {
          var s = sites[si];
          if (isWater(s.x, s.z)) continue;
          var rank = s.tier === 'city' ? 2 : s.tier === 'town' ? 1 : 0;
          var nseed = (chunkHash(s.cx, s.cz, seed) ^ (Math.imul(s.idx + 3, 0x9E3779B1) >>> 0)) >>> 0;
          nodes.push({ x: s.x, z: s.z, rank: rank, tier: s.tier, seed: nseed, site: s, key: WorldSim.siteKey(s) });
        }
      }
      return nodes;
    }
    function nodeGates(node) {
      if (!node._gates) node._gates = (node.tier && node.tier !== 'village') ? settlementGates(node.x, node.z, node.tier, node.seed) : { big: [], small: [] };
      return node._gates;
    }
    function pickGate(node, tx, tz, wantBig) {
      var g = nodeGates(node);
      var list = wantBig ? (g.big.length ? g.big : g.small) : (g.small.length ? g.small : g.big);
      if (!list.length) return null;
      var want = Math.atan2(tz - node.z, tx - node.x);
      var best = null, bsc = -Infinity;
      for (var i = 0; i < list.length; i++) { var gt = list[i]; var sc = Math.cos(gt.bearing - want) - (gt._claims || 0) * 0.35; if (sc > bsc) { bsc = sc; best = gt; } }
      best._claims = (best._claims || 0) + 1;
      return best;
    }
    function routeEdgeGates(e, big) {
      if (e.a.tier && e.a.tier !== 'village') e.aGate = pickGate(e.a, e.b.x, e.b.z, big);
      if (e.b.tier && e.b.tier !== 'village') e.bGate = pickGate(e.b, e.a.x, e.a.z, big);
    }
    function villageRoadAxis(st) {
      if (st.roadAx != null) return st.roadAx;
      var best = null, bd = Infinity, any = null, ad = Infinity;
      for (var cx = st.cx - 3; cx <= st.cx + 3; cx++) for (var cz = st.cz - 3; cz <= st.cz + 3; cz++) {
        var sites = roadSites(cx, cz);
        for (var i = 0; i < sites.length; i++) {
          var o = sites[i];
          if (o.cx === st.cx && o.cz === st.cz && o.idx === st.idx) continue;
          var d = Math.pow(o.x - st.x, 2) + Math.pow(o.z - st.z, 2);
          if (o.tier !== 'village' && d < bd) { bd = d; best = o; }
          if (d < ad) { ad = d; any = o; }
        }
      }
      var t = best || any;
      if (t) return Math.atan2(t.z - st.z, t.x - st.x);
      var rr = mulberry32((chunkHash(st.cx, st.cz, seed) ^ Math.imul(st.idx + 5, 0x85EBCA6B)) >>> 0);
      return rr() * TAU;
    }
    function chordHitsHold(A, Bb, skip) {
      for (var i = 0; i < routeAvoid.length; i++) {
        var t = routeAvoid[i];
        if (skip && skip.has(t.key)) continue;
        var vx = Bb.x - A.x, vz = Bb.z - A.z, L2 = vx * vx + vz * vz || 1;
        var u = ((t.x - A.x) * vx + (t.z - A.z) * vz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
        if (Math.pow(t.x - (A.x + vx * u), 2) + Math.pow(t.z - (A.z + vz * u), 2) < t.r2) return true;
      }
      return false;
    }
    function roadBuildNetwork(nodes) {
      var seen = new Set(), edges = [];
      var mk = function (a, b, tier) {
        if (a === b || a.key === b.key) return null;
        var lo = a.key <= b.key ? a : b, hi = a.key <= b.key ? b : a, ek = lo.key + '~' + hi.key;
        if (seen.has(ek)) return null; seen.add(ek);
        var e = { a: lo, b: hi, tier: tier, key: ek, aGate: null, bGate: null, pts: null };
        edges.push(e); return e;
      };
      avoidNodes = new Map(nodes.filter(function (n) { return n.tier && n.tier !== 'village'; }).map(function (n) { return [n.key, n]; }));
      wallRingMemo.clear();
      routeAvoid = nodes.filter(function (n) { return n.tier; })
        .map(function (n) {
          var R;
          if (n.tier === 'village') R = SG_SPEC.village.R + 2;
          else { var sp = SG_SPEC[n.tier], margin = sp.wall === 'stone' ? 2.6 : 1.5; R = (sp.R + margin / 0.8) * 1.4 + 2.5; }
          return { x: n.x, z: n.z, r2: R * R, key: n.key };
        });

      // ---- trunks: Gabriel over hubs, shortest-first under the degree cap, then a ≥3-roads floor per city ----
      var hubs = nodes.filter(function (n) { return n.rank >= 2; }), H = hubs.length, deg = new Array(H).fill(0);
      var cand = [];
      for (var i = 0; i < H; i++) for (var j = i + 1; j < H; j++) {
        var dx = hubs[i].x - hubs[j].x, dz = hubs[i].z - hubs[j].z;
        cand.push([dx * dx + dz * dz, i, j, gabrielEdge(hubs[i], hubs[j], hubs)]);
      }
      cand.sort(function (p, q) { return p[0] - q[0]; });
      var hubLink = function (i2, j2) { var e = mk(hubs[i2], hubs[j2], 'major'); if (e) { deg[i2]++; deg[j2]++; } };
      for (var c = 0; c < cand.length; c++) if (cand[c][3] && deg[cand[c][1]] < ROAD.hubDegCap && deg[cand[c][2]] < ROAD.hubDegCap) hubLink(cand[c][1], cand[c][2]);
      for (i = 0; i < H; i++) {
        var want = Math.min(3, H - 1);
        for (c = 0; c < cand.length; c++) { if (deg[i] >= want) break; if (cand[c][1] === i || cand[c][2] === i) hubLink(cand[c][1], cand[c][2]); }
      }
      var trunks = edges.slice();
      for (var e0 = 0; e0 < trunks.length; e0++) { routeEdgeGates(trunks[e0], true); trunks[e0].pts = roadRoute(trunks[e0]); }

      // ---- branches: towns fork off the artery (1.1× bias toward the trunk) or march to the nearest hub ----
      var trunkSegs = segIndex(trunks), branches = [];
      for (var t = 0; t < nodes.length; t++) {
        var tn = nodes[t];
        if (tn.rank !== 1) continue;
        var jn = nearestSegPoint(tn.x, tn.z, trunkSegs);
        var hub = null, hd = Infinity;
        for (var h = 0; h < hubs.length; h++) { var d = Math.pow(hubs[h].x - tn.x, 2) + Math.pow(hubs[h].z - tn.z, 2); if (d < hd) { hd = d; hub = hubs[h]; } }
        var e = null;
        if (jn && Math.sqrt(jn.d2) * 1.1 < Math.sqrt(hd)) e = mk(tn, { x: jn.x, z: jn.z, rank: -2, tier: null, key: 'jct:' + jn.key }, 'medium');
        else if (hub) e = mk(tn, hub, 'medium');
        if (e) { routeEdgeGates(e, false); e.pts = roadRoute(e); branches.push(e); }
      }

      // ---- lanes: villages hook onto the nearest roadside (T-junction) or the nearest settlement ----
      var roadSegs = segIndex(trunks.concat(branches)), lanes = [];
      for (var v = 0; v < nodes.length; v++) {
        var vn = nodes[v];
        if (vn.rank !== 0) continue;
        var jv = nearestSegPoint(vn.x, vn.z, roadSegs);
        if (jv && jv.d2 < 16) continue;
        var near = null, nd = Infinity;
        for (var o = 0; o < nodes.length; o++) { var on = nodes[o]; if (on === vn || on.rank < 0) continue; var d2 = Math.pow(on.x - vn.x, 2) + Math.pow(on.z - vn.z, 2); if (d2 < nd) { nd = d2; near = on; } }
        var ev = null;
        if (jv && jv.d2 * 1.15 < nd) ev = mk(vn, { x: jv.x, z: jv.z, rank: -2, tier: null, key: 'jct:' + jv.key }, 'small');
        else if (near) ev = mk(vn, near, 'small');
        if (ev) { routeEdgeGates(ev, false); lanes.push(ev); }
      }
      // through-villages get a MAIN STREET on their shared axis; lanes land on the street mouths
      var spurIntent = new Map();
      for (var a0 = 0; a0 < nodes.length; a0++) {
        var an = nodes[a0];
        if (an.rank > 1 || an.rank < 0) continue;
        var rng = mulberry32((Math.imul(Math.round(an.x) | 0, 374761393) ^ Math.imul(Math.round(an.z) | 0, 668265263) ^ (seed >>> 0)) >>> 0);
        if (rng() < 0.55) spurIntent.set(an.key, { ang: rng() * Math.PI * 2, len: 16 + rng() * 18 });
      }
      var vdeg = new Map();
      for (var ei = 0; ei < edges.length; ei++) { var ee = edges[ei]; var ends = [ee.a, ee.b]; for (var en = 0; en < 2; en++) if (ends[en].tier === 'village') vdeg.set(ends[en].key, (vdeg.get(ends[en].key) || 0) + 1); }
      var streets = new Map();
      for (v = 0; v < nodes.length; v++) {
        vn = nodes[v];
        if (vn.rank !== 0 || !vn.site) continue;
        var dcount = (vdeg.get(vn.key) || 0);
        if (dcount < 2 && !(dcount >= 1 && spurIntent.has(vn.key))) continue;
        var ax = villageRoadAxis(vn.site), L = SG_SPEC.village.R * 1.15;
        streets.set(vn.key, { cx: vn.x, cz: vn.z, x1: vn.x + Math.cos(ax) * L, z1: vn.z + Math.sin(ax) * L, x2: vn.x - Math.cos(ax) * L, z2: vn.z - Math.sin(ax) * L, m1: 0, m2: 0 });
      }
      var lanesCopy = lanes.concat();
      for (var li = 0; li < lanesCopy.length; li++) {
        var le = lanesCopy[li];
        var endsL = ['a', 'b'];
        for (var eL = 0; eL < 2; eL++) {
          var endKey = endsL[eL], nL = le[endKey];
          if (!nL.tier || nL.tier !== 'village') continue;
          var stv = streets.get(nL.key); if (!stv) continue;
          var oL = endKey === 'a' ? le.b : le.a;
          var d1 = Math.pow(oL.x - stv.x1, 2) + Math.pow(oL.z - stv.z1, 2), d2v = Math.pow(oL.x - stv.x2, 2) + Math.pow(oL.z - stv.z2, 2);
          if (d1 <= d2v) { le[endKey + 'Gate'] = { x: stv.x1, z: stv.z1, bearing: Math.atan2(stv.z1 - stv.cz, stv.x1 - stv.cx) }; stv.m1++; }
          else { le[endKey + 'Gate'] = { x: stv.x2, z: stv.z2, bearing: Math.atan2(stv.z2 - stv.cz, stv.x2 - stv.cx) }; stv.m2++; }
        }
      }
      // lanes route LAZILY at draw time — their endpoints are final here
      streets.forEach(function (stv, vk) {
        edges.push({
          a: { x: stv.x1, z: stv.z1, rank: -1, tier: null, key: vk + ':stA' },
          b: { x: stv.x2, z: stv.z2, rank: -1, tier: null, key: vk + ':stB' },
          tier: 'small', key: 'street:' + vk, aGate: null, bGate: null,
          pts: [{ x: stv.x1, z: stv.z1 }, { x: stv.cx, z: stv.cz }, { x: stv.x2, z: stv.z2 }],
        });
      });

      // ---- interior streets: every walled hold's arteries + plaza + veins become REAL roadbeds ----
      for (var ni = 0; ni < nodes.length; ni++) {
        var nn = nodes[ni];
        if (!nn.tier || nn.tier === 'village' || nn.rank < 1) continue;
        var plan = settlementStreetPlan(nn.x, nn.z, nn.tier, nn.seed);
        for (var pi = 0; pi < plan.length; pi++) {
          var stt = plan[pi], pp = stt.pts; if (pp.length < 2) continue;
          edges.push({
            a: { x: pp[0].x, z: pp[0].z, rank: -1, tier: null, key: nn.key + ':in' + pi + 'a' },
            b: { x: pp[pp.length - 1].x, z: pp[pp.length - 1].z, rank: -1, tier: null, key: nn.key + ':in' + pi + 'b' },
            tier: stt.art && nn.rank >= 2 ? 'medium' : 'small', key: 'city:' + nn.key + ':' + pi,
            aGate: null, bGate: null, pts: pp,
          });
        }
      }

      // ---- tiny foot-paths: short dead-end trails off villages/towns ----
      for (a0 = 0; a0 < nodes.length; a0++) {
        an = nodes[a0];
        if (an.rank > 1 || an.rank < 0) continue;
        var si = spurIntent.get(an.key); if (!si) continue;
        var stq = an.tier === 'village' ? streets.get(an.key) : null;
        var sx = an.x, sz = an.z, ang = si.ang;
        if (stq) {
          var quiet = stq.m1 <= stq.m2 ? { x: stq.x1, z: stq.z1 } : { x: stq.x2, z: stq.z2 };
          sx = quiet.x; sz = quiet.z;
          ang = Math.atan2(quiet.z - an.z, quiet.x - an.x) + (si.ang - Math.PI) * 0.12;
        }
        var ex = sx + Math.cos(ang) * si.len, ez = sz + Math.sin(ang) * si.len;
        if (isWater(ex, ez)) continue;
        if (chordHitsHold({ x: sx, z: sz }, { x: ex, z: ez }, new Set([an.key]))) continue;
        var start = stq ? { x: sx, z: sz, rank: -1, tier: null, key: an.key + ':stq' } : an;
        var end = { x: ex, z: ez, rank: -1, tier: null, key: 'spur:' + an.key };
        edges.push({ a: start, b: end, tier: 'path', key: an.key + '~' + end.key, aGate: null, bGate: null, pts: null });
      }
      return edges;
    }
    function roadSegCost(x, z, a, c, skip) {
      var rough = fastRoughAt(x, z);
      var cost = rough < 0 ? 43 : rough * 3.0;
      for (var i = 0; i < routeAvoid.length; i++) {
        var t = routeAvoid[i];
        if (skip && skip.has(t.key)) continue;
        var dx = x - t.x, dz = z - t.z;
        if (dx * dx + dz * dz < t.r2) { cost += 45; break; }
      }
      var mx = (a.x + c.x) * 0.5, mz = (a.z + c.z) * 0.5;
      cost += Math.hypot(x - mx, z - mz) * 0.05;
      return cost;
    }
    function roadRoute(edge) {
      var A = edge.aGate || edge.a, Bb = edge.bGate || edge.b;
      var ck = edge.key + '|' + Math.round(A.x * 2) + ',' + Math.round(A.z * 2) + '~' + Math.round(Bb.x * 2) + ',' + Math.round(Bb.z * 2);
      var cached = routeCache.get(ck); if (cached) return cached;
      var skip = new Set([edge.a.key, edge.b.key]);
      var apA = gateApron(A, edge.tier), apB = gateApron(Bb, edge.tier);
      var fFork = edge.tier === 'major' ? 3.6 : 2.6;
      var farA = apA ? { x: A.x + (apA.x - A.x) * fFork, z: A.z + (apA.z - A.z) * fFork } : null;
      var farB = apB ? { x: Bb.x + (apB.x - Bb.x) * fFork, z: Bb.z + (apB.z - Bb.z) * fFork } : null;
      var RA = farA || A, RB = farB || Bb;
      var rays = [];
      var gpts = [A, Bb];
      for (var gi = 0; gi < 2; gi++) { var g = gpts[gi]; if (g && g.bearing != null) rays.push({ x: g.x, z: g.z, dx: Math.cos(g.bearing), dz: Math.sin(g.bearing) }); }
      var pts = null;
      if (edge.tier === 'major' || edge.tier === 'medium' || (edge.tier === 'small' && chordHitsHold(RA, RB, skip))) {
        var avoid = avoidNear(RA, RB);
        var len = Math.hypot(RB.x - RA.x, RB.z - RA.z);
        if (len > 16) pts = hexAStar(RA.x, RA.z, RB.x, RB.z, function (x, z) { return roadBuildCost(x, z, avoid, rays); }, 1.7, Math.min(1900, 340 + len * 3), len > 380 ? 3 : len > 180 ? 2 : 1);
      }
      if (!pts && chordHitsHold(RA, RB, skip)) {
        var avoid2 = avoidNear(RA, RB);
        var len2 = Math.hypot(RB.x - RA.x, RB.z - RA.z);
        pts = hexAStar(RA.x, RA.z, RB.x, RB.z, function (x, z) { return roadBuildCost(x, z, avoid2, rays); }, 1.7, Math.min(6400, 1000 + len2 * 12), len2 > 220 ? 2 : 1);
      }
      if (!pts) pts = roadRouteRelax(RA, RB, null);
      if (apA) pts.unshift({ x: A.x, z: A.z }, { x: apA.x, z: apA.z });
      if (apB) pts.push({ x: apB.x, z: apB.z }, { x: Bb.x, z: Bb.z });
      for (var pass = 0; pass < 2; pass++) {
        if (apA) for (var k1 = 2; k1 <= 3; k1++) if (k1 < pts.length - 1) pts[k1] = { x: pts[k1 - 1].x * 0.25 + pts[k1].x * 0.5 + pts[k1 + 1].x * 0.25, z: pts[k1 - 1].z * 0.25 + pts[k1].z * 0.5 + pts[k1 + 1].z * 0.25 };
        if (apB) { var kks = [pts.length - 3, pts.length - 4]; for (var ki = 0; ki < 2; ki++) { var k2 = kks[ki]; if (k2 > 0 && k2 < pts.length - 1) pts[k2] = { x: pts[k2 - 1].x * 0.25 + pts[k2].x * 0.5 + pts[k2 + 1].x * 0.25, z: pts[k2 - 1].z * 0.25 + pts[k2].z * 0.5 + pts[k2 + 1].z * 0.25 }; } }
      }
      routeCache.set(ck, pts);
      return pts;
    }
    function roadRouteRelax(A, Bb, skip) {
      var ax = A.x, az = A.z, bx = Bb.x, bz = Bb.z;
      var dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      var n = Math.max(2, Math.round(len / ROAD.segStep));
      var ux = dx / len, uz = dz / len, perpx = -uz, perpz = ux;
      var rng = mulberry32((chunkHash(Math.round(ax), Math.round(az), seed) ^ Math.round(bx * 13 + bz * 7)) >>> 0);
      var amp = Math.min(len * 0.16, 20), ph1 = rng() * 6.283, ph2 = rng() * 6.283, f1 = 1 + rng() * 1.4, f2 = 2 + rng() * 2.2;
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var t = i / n, env = Math.sin(Math.PI * t);
        var off = env * amp * (0.6 * Math.sin(ph1 + f1 * Math.PI * t) + 0.4 * Math.sin(ph2 + f2 * Math.PI * t));
        pts.push({ x: ax + dx * t + perpx * off, z: az + dz * t + perpz * off });
      }
      for (var pass = 0; pass < ROAD.relaxPasses; pass++) {
        for (i = 1; i < n; i++) {
          var a = pts[i - 1], c = pts[i + 1], m = pts[i];
          var lx = -(c.z - a.z), lz = (c.x - a.x), ll = Math.hypot(lx, lz) || 1, nx = lx / ll, nz = lz / ll;
          var best = m, bc = roadSegCost(m.x, m.z, a, c, skip);
          var offsets = [-9, -6, -3, 3, 6, 9];
          for (var oi = 0; oi < offsets.length; oi++) {
            var o = offsets[oi];
            var cx = m.x + nx * o, cz = m.z + nz * o, cc = roadSegCost(cx, cz, a, c, skip);
            if (cc < bc) { bc = cc; best = { x: cx, z: cz }; }
          }
          pts[i] = best;
        }
      }
      return pts;
    }
    // THE WALL RULE, enforced at draw time: a road may cross a walled hold's ring ONLY at a gate
    function holdRing(key) {
      var v = wallRingMemo.get(key);
      if (v === undefined) {
        var h = avoidNodes.get(key);
        v = null;
        if (h && h.tier && h.tier !== 'village' && SG_SPEC[h.tier] && SG_SPEC[h.tier].wall) {
          var spec = SG_SPEC[h.tier], p = sgProbe(h.x, h.z, spec);
          var fp = sgFootprint({ r: mulberry32((h.seed || 0) >>> 0), T: p });
          var margin = spec.wall === 'stone' ? 2.6 : 1.5;
          var Rfit = Math.max(spec.R * 0.5, spec.R + margin / 0.8);
          var g = nodeGates(h);
          v = { x: h.x, z: h.z, Rfit: Rfit, fp: fp, gates: g.big.concat(g.small) };
        }
        wallRingMemo.set(key, v);
      }
      return v;
    }
    function edgeWallSafe(e, pts) {
      for (var ti = 0; ti < routeAvoid.length; ti++) {
        var t = routeAvoid[ti];
        var w = holdRing(t.key);
        if (!w) continue;
        if (Math.pow(pts[0].x - w.x, 2) + Math.pow(pts[0].z - w.z, 2) > t.r2 * 4 && Math.pow(pts[pts.length - 1].x - w.x, 2) + Math.pow(pts[pts.length - 1].z - w.z, 2) > t.r2 * 4) {
          var near = false;
          for (var i0 = 0; i0 < pts.length; i0 += 3) { var dx = pts[i0].x - w.x, dz = pts[i0].z - w.z; if (dx * dx + dz * dz < t.r2 * 1.3) { near = true; break; } }
          if (!near) continue;
        }
        for (var i = 1; i < pts.length; i++) {
          var p = pts[i], q = pts[i - 1];
          var dP = Math.hypot(p.x - w.x, p.z - w.z), dQ = Math.hypot(q.x - w.x, q.z - w.z);
          var aP = Math.atan2(p.z - w.z, p.x - w.x), wallR = w.Rfit * w.fp(aP);
          if ((dP - wallR) * (dQ - wallR) < 0 || Math.abs(dP - wallR) < 1.8) {
            var legal = false;
            for (var gi = 0; gi < w.gates.length; gi++) { var g = w.gates[gi]; if (Math.pow(g.x - p.x, 2) + Math.pow(g.z - p.z, 2) < 100) { legal = true; break; } }
            if (!legal) return false;
          }
        }
      }
      return true;
    }

    // ---------- assemble the instance ----------
    T.elevationAt = elevationAt;
    T.moistureAt = moistureAt;
    T.tempAt = tempAt;
    T.isWater = isWater;
    T.biomeAt = biomeAt;
    T.elevToY = elevToY;
    T.heightAt = heightAt;
    T.groundColorRGB = groundColorRGB;
    T.tileColorRGB = tileColorRGB;
    T.nearestLand = nearestLand;
    T.capitalSeats = capitalSeats;
    T.landScore = landScore;
    T.bestLandSpot = bestLandSpot;
    T.citySeatScore = citySeatScore;
    T.cityLandCenter = cityLandCenter;
    T.blockCityRaw = blockCityRaw;
    T.citySeat = citySeat;
    T.roadwardBearing = roadwardBearing;
    T.snapToSkeleton = snapToSkeleton;
    T.settlementSites = settlementSites;
    T.roadSites = roadSites;
    T.landRoughAt = landRoughAt;
    T.fastRoughAt = fastRoughAt;
    T.terrainSpeedMul = terrainSpeedMul;
    T.hexAStar = hexAStar;
    T.travelCost = travelCost;
    T.travelPath = travelPath;
    T.sgProbe = sgProbe;
    T.cityGateBearings = cityGateBearings;
    T.cityFlankerCastles = cityFlankerCastles;
    T.settlementStreetPlan = settlementStreetPlan;
    T.settlementGates = settlementGates;
    T.wallRingPts = wallRingPts;
    T.chunkScatter = chunkScatter;
    T.chunkGroves = chunkGroves;
    T.roadGatherNodes = roadGatherNodes;
    T.nodeGates = nodeGates;
    T.villageRoadAxis = villageRoadAxis;
    T.roadBuildNetwork = roadBuildNetwork;
    T.roadRoute = roadRoute;
    T.edgeWallSafe = edgeWallSafe;
    T.holdRing = holdRing;
    T.chordHitsHold = chordHitsHold;
    T.getRouteAvoid = function () { return routeAvoid; };
    return T;
  }

  // ---------- parity primitive: an FNV-1a fingerprint of the fields at 256 seeded points ----------
  // Client (BV.terraHash) and server (node -e) must agree exactly; it gates every migration phase.
  function hash(tseed) {
    var T = make(tseed);
    var r = mulberry32(((tseed >>> 0) ^ 0x7E55A) >>> 0);
    var h = 0x811c9dc5 | 0;
    function mix(v) {
      var q = Math.round(v * 1e6) | 0;
      for (var b = 0; b < 4; b++) { h = (h ^ ((q >>> (b * 8)) & 255)) | 0; h = Math.imul(h, 0x01000193); }
    }
    var c = [0, 0, 0];
    for (var i = 0; i < 256; i++) {
      var x = (r() - 0.5) * 4000, z = (r() - 0.5) * 4000;
      mix(T.elevationAt(x, z)); mix(T.tempAt(x, z)); mix(T.moistureAt(x, z));
      T.tileColorRGB(x, z, c); mix(c[0]); mix(c[1]); mix(c[2]);
      mix(T.landRoughAt(x, z));
    }
    return (h >>> 0).toString(16);
  }

  return {
    VERSION: VERSION,
    TAU: TAU, clamp: clamp,
    CHUNK: CHUNK, MAP_HALF: MAP_HALF, CITY_BLOCK: CITY_BLOCK,
    SEA_LEVEL: SEA_LEVEL, TERR_SCALE: TERR_SCALE, MAP_RELIEF: MAP_RELIEF, MOUNTAINS: MOUNTAINS,
    B: B,
    HEX_R: HEX_R, HEX_W: HEX_W, HEX_H: HEX_H, HEX_FLOOR: HEX_FLOOR,
    hexKey: hexKey, hexCenterX: hexCenterX, hexCenterZ: hexCenterZ, worldToHex: worldToHex, hexCellsInChunk: hexCellsInChunk,
    TOP_OFFSETS: TOP_OFFSETS,
    nHash: nHash, vnoise: vnoise, fbm: fbm, ridge: ridge,
    ROAD: ROAD, ROAD_TIER: ROAD_TIER, MOVE: MOVE, TRAVEL_BASE_SPEED: TRAVEL_BASE_SPEED,
    SG_SPEC: SG_SPEC, NATION_HOMES: NATION_HOMES, SCATTER_DENSITY: SCATTER_DENSITY,
    angD: angD, thinPath: thinPath, smoothPath: smoothPath,
    classifyBiome: classifyBiome, elevToY: elevToY, groundColorFromFields: groundColorFromFields,
    gabrielEdge: gabrielEdge, segIndex: segIndex, nearestSegPoint: nearestSegPoint, gateApron: gateApron,
    sgFootprint: sgFootprint, sgIsRidge: sgIsRidge,
    make: make, hash: hash,
  };
});
