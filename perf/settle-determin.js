// Settlement-layout determinism guard (Phase 3). Pure Node — no browser, no DB. Proves the server's
// settlement primitive list is a deterministic function of (tseed, x, z, tier, seed), independent of
// kernel instance or request order — the invariant the client relies on when it renders a
// server-shipped descriptor (a drifted descriptor would render a DIFFERENT city than the client would
// have built locally). Run: node perf/settle-determin.js
const Terra = require('../sim/terra.js');
const Settle = require('../sim/settle.js');

const SHARED = 0x51A3F00D;
const TSEED = (((0) * 1000 + 7) ^ (SHARED * 2654435761)) >>> 0;
function kernel() { const T = Terra.make(TSEED); T.capitalsProvider = () => T._c || (T._c = T.capitalSeats()); return T; }
function fp(layout) {
  let h = 0x811c9dc5 | 0; const mix = v => { v = Math.round(v * 128) | 0; h = Math.imul(h ^ (v & 255), 0x01000193); h = Math.imul(h ^ ((v >>> 8) & 255), 0x01000193); };
  mix(layout.prims.length); for (const pr of layout.prims) for (const n of pr) mix(n);
  return (h >>> 0).toString(16);
}

// the golden oracle positions (absolute, from the shared world) + seeds used in the client verification
const CASES = [['village', 573.925, 641.599, 111], ['town', 593.925, 641.599, 222], ['city', 613.925, 661.599, 333], ['capital', 633.925, 641.599, 444]];

let fail = 0;
const assert = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; };

console.log('[1] a settlement layout hashes the same across kernel instances + request order');
const base = new Map();
{ const T = kernel(); for (const [tier, x, z, seed] of CASES) base.set(tier, fp(Settle.settlementLayout(T, x, z, tier, seed))); }
{ const T = kernel(); for (const c of CASES.slice().reverse()) { const [tier, x, z, seed] = c; assert(fp(Settle.settlementLayout(T, x, z, tier, seed)) === base.get(tier), `${tier} stable (0x${base.get(tier)})`); } }

console.log('\n[2] prim counts (sanity — must match the client golden vertex structure)');
{ const T = kernel(); for (const [tier, x, z, seed] of CASES) { const L = Settle.settlementLayout(T, x, z, tier, seed); console.log(`  ${tier}: ${L.prims.length} prims, ${L.dbg.buildings} buildings, cls=${L.cls}`); } }

console.log('\n' + (fail ? `SETTLE DETERMINISM: ${fail} FAILURE(S)` : 'SETTLE DETERMINISM: all green'));
process.exit(fail ? 1 : 0);
