#!/usr/bin/env node
// Blade Vale — chunk-store parity gate.
// Regenerates a chunk's payload from the kernel and diffs it against the stored blob: any byte
// drift means the generation math changed without a Terra.VERSION bump (forbidden — payloads
// persist forever). Also prints the kernel field hash for cross-side comparison with the
// browser's BV.terraHash(seed).
//
//   node server/tools/parity.js --hash 2275024391
//   node server/tools/parity.js --world 5 --tseed 2275024391 --chunk 0,0
//   node server/tools/parity.js --world 5 --all          # every stored chunk of that world
const zlib = require('zlib');
const path = require('path');
process.env.BV_DB = process.env.BV_DB || path.join(__dirname, '..', 'world.db');
const { db } = require('../db');
const Terra = require('../../sim/terra.js');
const chunksMod = require('../chunks');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };

if (opt('hash')) {
  const s = parseInt(opt('hash'), 10) >>> 0;
  console.log('Terra.VERSION', Terra.VERSION, 'hash(' + s + ') =', Terra.hash(s));
  process.exit(0);
}

const worldId = parseInt(opt('world') || '0', 10);
if (!worldId) { console.error('usage: parity.js --hash SEED | --world ID [--tseed T] [--chunk cx,cz | --all]'); process.exit(2); }

function regen(tseed, cx, cz) {
  // rebuild the payload the way ensureChunk would — read-only (no DB writes)
  const T = chunksMod.terraFor(tseed);
  const w = db.prepare('SELECT map_level FROM worlds WHERE id=?').get(worldId);
  return chunksMod.buildPayload(T, tseed, (w && w.map_level) | 0, cx, cz, chunksMod.nationOwnerMap(worldId));
}

let rows;
if (args.includes('--all')) {
  rows = db.prepare('SELECT tseed, cx, cz, version, payload FROM chunks WHERE world_id=?').all(worldId);
} else {
  const tseed = parseInt(opt('tseed'), 10) >>> 0;
  const m = /^(-?\d+),(-?\d+)$/.exec(opt('chunk') || '');
  if (!m) { console.error('need --chunk cx,cz (or --all)'); process.exit(2); }
  rows = db.prepare('SELECT tseed, cx, cz, version, payload FROM chunks WHERE world_id=? AND tseed=? AND cx=? AND cz=?')
    .all(worldId, tseed, +m[1], +m[2]);
}
if (!rows.length) { console.error('no stored chunks matched'); process.exit(2); }

let bad = 0;
for (const r of rows) {
  if (r.version !== Terra.VERSION) { console.log(`SKIP ${r.tseed}/${r.cx},${r.cz}: stored v${r.version} != kernel v${Terra.VERSION} (historic blob — fine)`); continue; }
  const stored = zlib.gunzipSync(r.payload).toString('utf8');
  const fresh = JSON.stringify(regen(r.tseed, r.cx, r.cz));
  if (stored === fresh) console.log(`OK   ${r.tseed}/${r.cx},${r.cz}`);
  else {
    bad++;
    const a = JSON.parse(stored), b = JSON.parse(fresh);
    const keys = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    console.log(`DIFF ${r.tseed}/${r.cx},${r.cz}: fields [${keys.join(', ')}] — kernel drifted without a VERSION bump!`);
  }
}
console.log(bad === 0 ? `PARITY OK (${rows.length} chunks)` : `PARITY FAILED (${bad}/${rows.length})`);
process.exit(bad ? 1 : 0);
