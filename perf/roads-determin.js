// Road determinism guard (Phase 0). Pure Node — no browser, no DB. Proves the invariant the
// server road store depends on: a chunk's roads are a deterministic function of (tseed, cx, cz),
// independent of request order or cache warmth. If this goes red, the per-chunk road persistence in
// server/chunks.js is no longer safe (revisiting a region could render different roads than stored).
//
//   node perf/roads-determin.js
const SHARED = 0x51A3F00D;
const tseedOf = (mapLevel, useed) => (((mapLevel | 0) * 1000 + 7) ^ (useed * 2654435761)) >>> 0;
const TSEED = tseedOf(0, SHARED);

// a cold Roads module (own kernel + region caches empty) — for cross-run reproducibility checks
function coldRoads() { delete require.cache[require.resolve('../server/roads.js')]; return require('../server/roads.js'); }

// fingerprint a chunk's road output so order-independent equality is a single integer compare
function fp(roads) {
  let h = 0x811c9dc5 | 0;
  const mix = (v) => { v |= 0; h = Math.imul(h ^ (v & 255), 0x01000193); h = Math.imul(h ^ ((v >>> 8) & 255), 0x01000193); };
  const sorted = roads.slice().sort((a, b) => a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : a.pts.length - b.pts.length || a.pts[0][0] - b.pts[0][0] || a.pts[0][1] - b.pts[0][1]);
  for (const s of sorted) { for (let i = 0; i < s.tier.length; i++) mix(s.tier.charCodeAt(i)); mix(s.pts.length); for (const p of s.pts) { mix(Math.round(p[0] * 10)); mix(Math.round(p[1] * 10)); } }
  return (h >>> 0);
}

let fail = 0;
const assert = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fail++; };

const Roads = require('../server/roads.js');
const RR = Roads.REGION_R;
// a spread of chunks: dense-road centre, region-interior, and both sides of a region seam
const CHUNKS = [[0, 0], [1, 0], [0, 1], [3, -2], [-4, 2], [RR - 1, 0], [RR, 0], [RR, RR], [-RR, -1]];

// 1) request-order + cache-warmth independence: forward pass on a warm module vs reversed pass on a
//    cold module must agree chunk-for-chunk
console.log('\n[1] a chunk hashes the same regardless of request order or cache warmth');
const base = new Map();
for (const [cx, cz] of CHUNKS) base.set(cx + ',' + cz, fp(Roads.roadsForChunk(TSEED, cx, cz)));
{
  const R2 = coldRoads();
  for (const [cx, cz] of CHUNKS.slice().reverse()) {
    const k = cx + ',' + cz, got = fp(R2.roadsForChunk(TSEED, cx, cz));
    assert(got === base.get(k), `chunk ${k} stable (0x${base.get(k).toString(16)})`);
  }
}

// 2) interleaving a whole neighbourhood must not perturb any single chunk (memo isolation)
console.log('\n[2] fetching a 3×3 neighbourhood first does not change a chunk');
{
  const R3 = coldRoads();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) R3.roadsForChunk(TSEED, dx, dz);
  assert(fp(R3.roadsForChunk(TSEED, 0, 0)) === base.get('0,0'), 'chunk 0,0 unchanged after neighbourhood warm-up');
}

// 3) coverage + cross-seam continuity (informational)
console.log('\n[3] coverage + seam continuity (informational)');
{
  const R4 = coldRoads();
  let total = 0, withRoads = 0;
  for (let cx = -RR; cx <= RR; cx++) for (let cz = -RR; cz <= RR; cz++) { const r = R4.roadsForChunk(TSEED, cx, cz); total++; if (r.length) withRoads++; }
  console.log(`  ${withRoads}/${total} chunks carry road segments across a ${(2 * RR + 1)}² grid`);
  console.log(`  region-seam chunks: (${RR - 1},0)=${R4.roadsForChunk(TSEED, RR - 1, 0).length} segs  (${RR},0)=${R4.roadsForChunk(TSEED, RR, 0).length} segs`);
}

console.log('\n' + (fail ? `ROADS DETERMINISM: ${fail} FAILURE(S)` : 'ROADS DETERMINISM: all green'));
process.exit(fail ? 1 : 0);
