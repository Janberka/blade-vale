#!/usr/bin/env node
// Blade Vale — the ALWAYS-ON battle-AI trainer. Plays battles continuously via the headless kernel and
// makes the served commander+soldier policy a little smarter after EVERY battle.
//
//   node sim/trainer.js               run forever (a background daemon)
//   node sim/trainer.js --games 400   run a bounded batch (for verification), then stop
//   node sim/trainer.js --quiet       no per-generation log lines
//
// How it improves (online, no offline batch needed):
//   • (1+1)-ES: each round a MUTANT of the champion duels the champion (sides swapped to cancel bias);
//     if the mutant wins the mini-match it becomes the new champion. So the served policy climbs battle
//     by battle. Raw-power params (damage/reach/move/hp) are FROZEN — the AI can only win by getting
//     SMARTER (doctrine, positioning, targeting, morale, individual traits), not by cranking stats.
//   • Soldier credit: after each duel the champion's soldier traits are nudged toward the bravery/aggression
//     of the individuals who actually survived and dealt damage on the winning side — each soldier trains θ_S.
//   • Distress exploration: in-battle, a side losing too many men gambles (kernel's τ); across battles the
//     mutation σ adapts by the ES 1/5-success rule (more exploration when there's room to improve).
//   • League: the champion also duels frozen past champions to avoid self-play cycling.
//   • Benchmark: every generation the champion plays the FROZEN BASELINE; that win% is the improvement curve.
// All battles + per-soldier samples land in the separate train/ai.db; the champion is promoted for serving.
const K = require('./battle.js');
const aidb = require('../train/aidb.js');

const args = process.argv.slice(2);
const GAMES = (() => { const i = args.indexOf('--games'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const QUIET = args.includes('--quiet');
const SEED = (() => { const i = args.indexOf('--seed'); return i >= 0 ? (parseInt(args[i + 1], 10) >>> 0) : 0x51EED; })();

// tuning
const DUEL_BATTLES = 4;      // battles per champion-vs-challenger mini-match (side-swapped)
const EVAL_EVERY = 5;        // rounds between a baseline benchmark + champion save
const EVAL_BATTLES = 6;      // champion-vs-baseline battles for the improvement metric
const LEAGUE_EVERY = 3;      // every Nth round the challenger is a league opponent instead of a mutant
const SOLDIER_LR = 0.03;     // per-duel nudge rate for soldier traits

// which genome fields the trainer may mutate. Raw power is deliberately EXCLUDED (see header).
const MUTABLE = {
  commander: ['doctrineTemp', 'archerDocCoef', 'aggrMean', 'cautMean', 'leadBias', 'leadAggrK',
    'reserveCommitRatio', 'wingFallbackK', 'centerHoldRatio', 'centerHoldAggr', 'brokenFallbackFrac', 'routBase', 'routCautionK', 'exploreGain'],
  commanderDoc: ['line', 'wings', 'oblique', 'defensive', 'skirmish'], // docLogit.*
  soldier: ['leashMul', 'perceptMul', 'coolMul', 'windMul', 'breakDelta', 'rallyDelta', 'senseRMul', 'fallbackSpeedMul',
    'mLocal', 'mHp', 'mArmy', 'archRangeMul', 'archCdMul', 'targetWeak', 'targetThreat', 'braveryMean', 'aggrMean', 'exploreGain'],
};
// keep genome values sane after a perturbation
function clampKey(k, v) {
  if (/Mul$/.test(k)) return Math.max(0.4, Math.min(2.2, v));
  if (/Delta$/.test(k)) return Math.max(-0.4, Math.min(0.4, v));
  if (k === 'doctrineTemp') return Math.max(0.2, Math.min(3, v));
  if (k === 'aggrMean' || k === 'cautMean') return Math.max(0.05, Math.min(0.95, v));
  if (k === 'braveryMean') return Math.max(-0.3, Math.min(0.3, v));
  if (/^(exploreGain|targetWeak|targetThreat|routBase|routCautionK)$/.test(k)) return Math.max(0, Math.min(2, v));
  if (/Ratio$|^wingFallbackK$|^centerHoldAggr$|^brokenFallbackFrac$|^leadAggrK$|^archerDocCoef$|^mLocal$|^mHp$|^mArmy$/.test(k)) return Math.max(0, Math.min(4, v));
  return Math.max(-3, Math.min(3, v)); // logits, leadBias
}
const clone = g => JSON.parse(JSON.stringify(g));
function mutate(pair, rng, sigma) {
  const p = clone(pair), C = p.commander, S = p.soldier, N = () => (rng() + rng() + rng() - 1.5) * sigma; // ~gaussian
  for (const k of MUTABLE.commander) C[k] = clampKey(k, C[k] + N());
  for (const k of MUTABLE.commanderDoc) C.docLogit[k] = clampKey('logit', C.docLogit[k] + N() * 3);
  for (const k of MUTABLE.soldier) S[k] = clampKey(k, S[k] + N());
  return p;
}
function defaultPair() { return { commander: K.defaultCommanderGenome(), soldier: K.defaultSoldierGenome() }; }

const rng = K.mulberry32(SEED);
let battlesRun = 0;
function nextSeed() { return (rng() * 0xffffffff) >>> 0; }
function sizes() { const n = 18 + Math.floor(rng() * 22); return [n, 18 + Math.floor(rng() * 22)]; } // varied → generalize

// one logged battle between two pair-genomes; returns winner side ('A'/'B'/'draw') and its record
function playBattle(gA, gB, source) {
  const sz = sizes();
  const rec = K.run({ seed: nextSeed(), perA: sz[0], perB: sz[1], policies: { A: gA, B: gB } }).record;
  aidb.insertBattle(rec, { source: source || 'selfplay' });
  battlesRun++;
  return rec;
}
// champion vs challenger, side-swapped; returns {champWins, chalWins} + the battle records (for soldier credit)
function duel(gChamp, gChal, n) {
  let champWins = 0, chalWins = 0; const recs = [];
  for (let i = 0; i < n; i++) {
    const champA = i % 2 === 0;                         // alternate which side the champion takes
    const rec = playBattle(champA ? gChamp : gChal, champA ? gChal : gChamp);
    recs.push(rec);
    const w = rec.outcome.leaderWin || rec.outcome.winner; if (w === 'draw') continue; // leaderWin credits a wise withdrawal
    const champSide = champA ? 'A' : 'B';
    if (w === champSide) champWins++; else chalWins++;
  }
  return { champWins, chalWins, recs };
}
// per-individual soldier learning: pull the champion's trait means toward the men who WON + performed
function nudgeSoldier(champ, recs) {
  let wB = 0, wA = 0, wN = 0, lN = 0, lB = 0, lA = 0;    // winners' vs losers' trait sums
  for (const rec of recs) {
    for (const s of rec.soldierSamples || []) {
      const good = s.sideWon && (s.survived || s.kills > 0 || s.damage > 8);
      if (good) { wB += s.bravery; wA += s.aggr; wN++; } else if (!s.sideWon) { lB += s.bravery; lA += s.aggr; lN++; }
    }
  }
  if (wN < 4 || lN < 4) return;
  const gap = (w, l, n, m) => (w / n) - (l / m);
  champ.soldier.braveryMean = clampKey('braveryMean', champ.soldier.braveryMean + SOLDIER_LR * gap(wB, lB, wN, lN));
  champ.soldier.aggrMean = clampKey('aggrMean_', champ.soldier.aggrMean + SOLDIER_LR * gap(wA, lA, wN, lN));
}

function benchmark(champ, baseline, n) {
  let champWins = 0, decided = 0;
  for (let i = 0; i < n; i++) {
    const champA = i % 2 === 0;
    const rec = playBattle(champA ? champ : baseline, champA ? baseline : champ, 'benchmark');
    const w = rec.outcome.leaderWin || rec.outcome.winner; if (w === 'draw') continue; decided++;
    if (w === (champA ? 'A' : 'B')) champWins++;
  }
  return decided ? champWins / decided : 0.5;
}

function main() {
  const baseline = defaultPair();                       // frozen benchmark — never changes
  let champion = defaultPair();
  let sigma = 0.12, gen = 0, round = 0, improved = 0, rounds5 = 0;
  const league = [clone(champion)];
  // seed the DB with the baseline as gen 0 champion so the editor has something to serve immediately
  aidb.promoteChampion(aidb.savePolicy({ tier: 'pair', generation: 0, genome: champion, fitness: 0.5, battles: 0, isChampion: true, note: 'baseline' }));
  if (!QUIET) console.log(`[trainer] seed=${SEED} games=${GAMES === Infinity ? '∞' : GAMES}  (raw power frozen — learning tactics only)`);

  while (battlesRun < GAMES) {
    round++;
    const useLeague = league.length > 1 && round % LEAGUE_EVERY === 0;
    const challenger = useLeague ? league[(rng() * league.length) | 0] : mutate(champion, rng, sigma);
    const d = duel(champion, challenger, DUEL_BATTLES);
    const win = d.chalWins > d.champWins;               // challenger beat the champion?
    if (win && !useLeague) { champion = challenger; improved++; }  // adopt a winning mutant
    nudgeSoldier(champion, d.recs);                     // soldier-trait learning from this round's men
    rounds5++;
    // ES 1/5-rule: if mutants win too often there's room to explore harder; if rarely, refine
    if (rounds5 >= 5) { const rate = improved / rounds5; sigma = Math.max(0.02, Math.min(0.35, rate > 0.2 ? sigma * 1.25 : sigma * 0.85)); improved = 0; rounds5 = 0; }

    if (round % EVAL_EVERY === 0) {
      gen++;
      const wr = benchmark(champion, baseline, EVAL_BATTLES);
      const id = aidb.savePolicy({ tier: 'pair', generation: gen, genome: champion, fitness: wr, battles: battlesRun, isChampion: true });
      aidb.promoteChampion(id);
      aidb.insertMetric({ generation: gen, battles: battlesRun, champVsBaseline: wr });
      if (gen % 4 === 0) league.push(clone(champion));  // enshrine a past champion for anti-cycling duels
      if (!QUIET) {
        const S = champion.soldier, C = champion.commander;
        const topDoc = K.DOCTRINES.map(dn => [dn, C.docLogit[dn]]).sort((a, b) => b[1] - a[1])[0][0];
        console.log(`gen ${String(gen).padStart(3)} | battles ${String(battlesRun).padStart(5)} | champ vs baseline ${(wr * 100).toFixed(0).padStart(3)}% | σ ${sigma.toFixed(3)} | pref:${topDoc} aggr:${C.aggrMean.toFixed(2)} brave:${S.braveryMean.toFixed(2)} target-weak:${S.targetWeak.toFixed(2)}`);
      }
    }
  }
  if (!QUIET) console.log(`[trainer] done: ${battlesRun} battles, generation ${gen}. Champion promoted in ${aidb.DB_PATH}`);
}

main();
