// Blade Vale — server-side settlement LAYOUT service (Phase 3 of the region service).
//
// A city/capital costs ~160-190ms to lay out on the client (house-collision, street frontage,
// footprint fitting). That placement runs in the shared kernel (sim/settle.js), so the server can do
// it and hand the client a primitive list — the browser then only EMITS geometry (~30ms, unavoidable).
// The client sends the (x,z,tier,seed) it will render with, so the descriptor is exactly what the
// client would have computed locally (same kernel), just off the browser's frame budget.
//
// Base (miniature) descriptors only — the street-rung variant depends on the client's STREET knobs and
// is a close-up with few settlements in view, so the client keeps computing that one locally.
const Settle = require('../sim/settle.js');
const chunks = require('./chunks.js');

const _cache = new Map();            // tseed -> Map(key -> descriptor); layouts are pure, cache forever
const MAX_TSEEDS = 6, MAX_PER_TSEED = 4000;

function serveSettlements(level, useed, items) {
  const tseed = chunks.tseedOf(level, useed);
  const T = chunks.terraFor(tseed);
  let c = _cache.get(tseed);
  if (!c) { if (_cache.size > MAX_TSEEDS) _cache.clear(); c = new Map(); _cache.set(tseed, c); }
  const out = {};
  for (const it of items) {
    if (!it || it.key == null) continue;
    let d = c.get(it.key);
    if (!d) {
      if (c.size >= MAX_PER_TSEED) c.clear();
      d = Settle.settlementLayout(T, +it.x, +it.z, String(it.tier), (it.seed >>> 0), {});
      c.set(it.key, d);
    }
    out[it.key] = d;
  }
  return { tseed, descriptors: out };
}

module.exports = { serveSettlements };
