#!/usr/bin/env node
// Determinism guard for the headless battle kernel (sim/battle.js).
//   node perf/battle-determin.js
// Self-play/training is only reproducible if a battle replays identically from the same (seed, genomes).
// This runs each of several seeds twice — once bare, once with a mutated genome pair — and asserts the
// full record (features + timeline + per-soldier samples + outcome) is byte-identical across the pair.
// Mirrors the pure-Node pattern of perf/settle-determin.js (no browser, no THREE).

const K = require('../sim/battle.js');

function mutate(genome, rng, sigma) { // small perturbation, like the trainer's mutation step
  const g = JSON.parse(JSON.stringify(genome));
  for (const k in g) if (typeof g[k] === 'number') g[k] = g[k] + (rng() * 2 - 1) * sigma;
  return g;
}

const rng = K.mulberry32(12345);
const polA = { commander: mutate(K.defaultCommanderGenome(), rng, 0.15), soldier: mutate(K.defaultSoldierGenome(), rng, 0.1) };
const polB = { commander: mutate(K.defaultCommanderGenome(), rng, 0.15), soldier: mutate(K.defaultSoldierGenome(), rng, 0.1) };

let fails = 0, checked = 0;
for (const cfg of [
  { seed: 1, perA: 24, perB: 24 },
  { seed: 2, perA: 30, perB: 18 },
  { seed: 3, perA: 26, perB: 26, policies: { A: polA, B: polB } },
  { seed: 99, perA: 40, perB: 22, policies: { A: polB, B: polA } },
]) {
  const r1 = JSON.stringify(K.run(cfg).record);
  const r2 = JSON.stringify(K.run(cfg).record);
  checked++;
  if (r1 !== r2) {
    fails++;
    console.log(`  ✗ seed ${cfg.seed}: records DIFFER (${r1.length} vs ${r2.length} chars)`);
    // show the first divergence for debugging
    for (let i = 0; i < Math.min(r1.length, r2.length); i++) if (r1[i] !== r2[i]) { console.log('    first diff at char', i, ':', JSON.stringify(r1.slice(i, i + 60)), 'vs', JSON.stringify(r2.slice(i, i + 60))); break; }
  } else {
    const o = JSON.parse(r1).outcome;
    console.log(`  ✓ seed ${cfg.seed}: identical (${r1.length} chars) — winner ${o.winner} +${o.margin}`);
  }
}
console.log(fails ? `\nFAIL: ${fails}/${checked} non-deterministic` : `\nOK: all ${checked} battles are byte-identical across replays`);
process.exit(fails ? 1 : 0);
