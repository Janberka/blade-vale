// Blade Vale — server-side road generation (Phase 1 of the region service).
//
// The road engine lives in the shared kernel (sim/terra.js): roadGatherNodes → roadBuildNetwork →
// roadRoute. On the client that build is a ~2.4s hitch every time the player rides into fresh ground.
// Here the server runs it ONCE per region, applies the same water/wall culls the client's roadRebuild
// applies, and hands back routed polylines clipped to a chunk — the client keeps only the cheap
// presentation (per-joint width/tone splat, roadside rocks).
//
// DETERMINISM (guarded by perf/roads-determin.js): a road network is byte-reproducible for a FIXED
// gather window, but two overlapping windows disagree on ~1.5% of shared edges (routing context —
// routeAvoid, gate claims — is window-dependent). So a chunk's roads MUST be built from a fixed,
// position-independent window: we quantise the gather centre to a REGION grid. Every chunk belongs to
// exactly one region, so its roads are the same whoever asks and whenever — safe to persist.
//
// Each region is built on its OWN isolated kernel: the kernel's routeCache is keyed by edge but a
// routed polyline depends on the window's routeAvoid, so sharing one kernel across regions lets
// whichever region routes a shared trunk first contaminate the others (order-dependent output).
// Road geometry does not depend on live ownership (nodes key on the deterministic capital seats), so
// a fresh analytic kernel per region is both correct and cheap next to the routing cost.
//
// This module is DB-free (Terra only) so the determinism harness can import it without a database.
const Terra = require('../sim/terra.js');

const CHUNK = Terra.CHUNK;
const REGION_R = 8;                 // a region spans REGION_R×REGION_R chunks; roads gather from its centre
const CLIP_PAD = 8;                 // world units of overhang so a road stroke stays continuous across a chunk seam
const REGION_EDGE_PAD = 48;         // only route/keep edges whose polyline comes within this of the region box
const MAX_REGION_MEMO = 64;         // bound the per-tseed region cache (each region holds full routed polylines)
const MAX_KERNELS = 6;              // bound the per-tseed isolated-kernel cache

// which region a chunk belongs to, and that region's fixed gather-centre chunk
function regionIndex(c) { return Math.floor(c / REGION_R); }
function regionCenterChunk(ri) { return ri * REGION_R + (REGION_R >> 1); }

// per-tseed state: a pool of isolated kernels (each used for exactly one region build) + a region memo
const _state = new Map();
function stateFor(tseed) {
  let s = _state.get(tseed);
  if (!s) { if (_state.size > 8) _state.clear(); s = { kernels: [], regions: new Map() }; _state.set(tseed, s); }
  return s;
}
// a clean kernel for one region build — analytic capital seats (ownership never moves a road)
function makeKernel(tseed) {
  const T = Terra.make(tseed);
  T.capitalsProvider = () => T._caps || (T._caps = T.capitalSeats());
  return T;
}

// the same per-edge culls the client applies in roadRebuild, so the client just renders what it gets
function edgeSurvives(T, e, pts) {
  if (!pts || pts.length < 2) return false;
  let wet = 0, run = 0, maxRun = 0;
  for (let w = 0; w < pts.length; w++) {
    if (T.isWater(pts[w].x, pts[w].z)) { wet++; run++; if (run > maxRun) maxRun = run; } else run = 0;
  }
  if (wet / pts.length > 0.18 || maxRun >= 3) return false;   // no bridges yet — a road never fords open water
  // a road NEVER crosses a wall away from a gate (interior city:/street: beds are exempt, as on the client)
  if (!e.key.startsWith('city:') && !e.key.startsWith('street:') && !T.edgeWallSafe(e, pts)) return false;
  return true;
}

// broad-phase: does the straight chord a→b pass within pad of the [x0,z0,x1,z1] box?
function chordNearBox(ax, az, bx, bz, x0, z0, x1, z1, pad) {
  if (ax < x0 - pad && bx < x0 - pad) return false;
  if (ax > x1 + pad && bx > x1 + pad) return false;
  if (az < z0 - pad && bz < z0 - pad) return false;
  if (az > z1 + pad && bz > z1 + pad) return false;
  return true;
}

// build one region's roads on a throwaway isolated kernel: gather at the region's fixed centre, knit +
// route, cull, keep survivors as {tier, pts:[{x,z}...]} full polylines (clipped per chunk later)
function buildRegion(tseed, rix, riz) {
  const T = makeKernel(tseed);
  const ccx = regionCenterChunk(rix), ccz = regionCenterChunk(riz);
  const x0 = rix * REGION_R * CHUNK, z0 = riz * REGION_R * CHUNK;
  const x1 = x0 + REGION_R * CHUNK, z1 = z0 + REGION_R * CHUNK;
  const nodes = T.roadGatherNodes(ccx, ccz);
  const edges = T.roadBuildNetwork(nodes);
  const kept = [];
  for (const e of edges) {
    if (!chordNearBox(e.a.x, e.a.z, e.b.x, e.b.z, x0, z0, x1, z1, REGION_EDGE_PAD)) continue;
    const pts = e.pts || (e.pts = T.roadRoute(e));
    if (!edgeSurvives(T, e, pts)) continue;
    kept.push({ tier: e.tier, pts });
  }
  return { rix, riz, x0, z0, x1, z1, edges: kept };
}

function ensureRegion(tseed, rix, riz) {
  const s = stateFor(tseed);
  const key = rix + ',' + riz;
  let reg = s.regions.get(key);
  if (!reg) {
    if (s.regions.size >= MAX_REGION_MEMO) s.regions.clear();
    reg = buildRegion(tseed, rix, riz);
    s.regions.set(key, reg);
  }
  return reg;
}

// split a polyline into the maximal runs that touch the padded chunk box, with one lead-in/out vertex
// on each end so strokes join cleanly across the seam. Returns an array of point-runs.
function clipPolyline(pts, x0, z0, x1, z1) {
  const inBox = (p) => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1;
  const runs = [];
  let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const segHit = inBox(p) || (i + 1 < pts.length && inBox(pts[i + 1])) || (i > 0 && inBox(pts[i - 1]));
    if (segHit) {
      if (!cur) { cur = []; if (i > 0) cur.push(pts[i - 1]); } // lead-in vertex for continuity
      cur.push(p);
    } else if (cur) {
      cur.push(p);                                             // lead-out vertex, then close the run
      runs.push(cur); cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

// the public call chunks.js uses: the routed road segments that fall in chunk (cx,cz), tier-tagged,
// as compact [[x,z],...] point lists (0.1u quantised, JSON-friendly). Empty array = a roadless chunk.
function roadsForChunk(tseed, cx, cz) {
  const reg = ensureRegion(tseed, regionIndex(cx), regionIndex(cz));
  const x0 = cx * CHUNK - CLIP_PAD, z0 = cz * CHUNK - CLIP_PAD;
  const x1 = cx * CHUNK + CHUNK + CLIP_PAD, z1 = cz * CHUNK + CHUNK + CLIP_PAD;
  const out = [];
  for (const e of reg.edges) {
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const p of e.pts) { if (p.x < bx0) bx0 = p.x; if (p.x > bx1) bx1 = p.x; if (p.z < bz0) bz0 = p.z; if (p.z > bz1) bz1 = p.z; }
    if (bx1 < x0 || bx0 > x1 || bz1 < z0 || bz0 > z1) continue;
    for (const run of clipPolyline(e.pts, x0, z0, x1, z1)) {
      if (run.length < 2) continue;
      out.push({ tier: e.tier, pts: run.map(p => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]) });
    }
  }
  return out;
}

module.exports = {
  REGION_R, CLIP_PAD, regionIndex, regionCenterChunk, buildRegion, ensureRegion, roadsForChunk, clipPolyline,
};
