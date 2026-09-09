// Blade Vale — the AI TRAINING database. A SEPARATE SQLite file (train/ai.db), deliberately kept out of
// the game's server/world.db, holding everything the self-improving battle AI learns from:
//   battle          one row per resolved battle (features + outcome + full record json)
//   soldier_sample  one row per individual soldier per battle — the SOLDIER-AI training signal
//   policy          versioned {commander, soldier} genomes; the current champion is what gets served
//   metric          the improvement curve (champion win% vs the frozen baseline, per generation)
// Shared by the Node self-play daemon (sim/trainer.js, direct require) and the server ingest endpoint.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BV_AIDB || path.join(__dirname, 'ai.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS battle (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL DEFAULT (unixepoch()),
    seed INTEGER, source TEXT DEFAULT 'selfplay', had_player INTEGER DEFAULT 0,
    winner TEXT, margin INTEGER, duration REAL,
    doctrine_a TEXT, doctrine_b TEXT, start_a INTEGER, start_b INTEGER,
    policy_a INTEGER, policy_b INTEGER, full_json TEXT
  );
  CREATE INDEX IF NOT EXISTS battle_ts ON battle(ts);
  CREATE TABLE IF NOT EXISTS soldier_sample (
    id INTEGER PRIMARY KEY, battle_id INTEGER NOT NULL,
    side TEXT, role TEXT, unit TEXT, doctrine TEXT,
    bravery REAL, aggr REAL, survived INTEGER, kills INTEGER, damage REAL, held_slot REAL, side_won INTEGER
  );
  CREATE INDEX IF NOT EXISTS sample_battle ON soldier_sample(battle_id);
  CREATE TABLE IF NOT EXISTS policy (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL DEFAULT (unixepoch()),
    tier TEXT DEFAULT 'pair', generation INTEGER, genome_json TEXT,
    fitness REAL, battles INTEGER DEFAULT 0, is_champion INTEGER DEFAULT 0, note TEXT
  );
  CREATE TABLE IF NOT EXISTS metric (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL DEFAULT (unixepoch()),
    generation INTEGER, battles INTEGER, champ_vs_baseline REAL, diversity REAL, note TEXT
  );
`);

const _insBattle = db.prepare(`INSERT INTO battle
  (seed, source, had_player, winner, margin, duration, doctrine_a, doctrine_b, start_a, start_b, policy_a, policy_b, full_json)
  VALUES (@seed, @source, @had_player, @winner, @margin, @duration, @doctrine_a, @doctrine_b, @start_a, @start_b, @policy_a, @policy_b, @full_json)`);
const _insSample = db.prepare(`INSERT INTO soldier_sample
  (battle_id, side, role, unit, doctrine, bravery, aggr, survived, kills, damage, held_slot, side_won)
  VALUES (@battle_id, @side, @role, @unit, @doctrine, @bravery, @aggr, @survived, @kills, @damage, @held_slot, @side_won)`);

// insert one battle record (kernel- or editor-shaped) + its per-soldier samples, atomically → battle id
const _insManySamples = db.transaction((battleId, samples) => {
  for (const s of samples) _insSample.run({ battle_id: battleId, side: s.side, role: s.role, unit: s.unit, doctrine: s.doctrine,
    bravery: s.bravery, aggr: s.aggr, survived: s.survived | 0, kills: s.kills | 0, damage: s.damage, held_slot: s.heldSlot, side_won: s.sideWon | 0 });
});
function insertBattle(rec, meta) {
  meta = meta || {};
  const o = rec.outcome || {}, A = (rec.armies && rec.armies[0]) || {}, C = (rec.armies && rec.armies[1]) || {};
  const info = db.transaction(() => {
    const r = _insBattle.run({
      seed: rec.seed | 0, source: meta.source || 'selfplay', had_player: rec.hadPlayer ? 1 : 0,
      winner: o.winner || null, margin: o.margin | 0, duration: rec.durationSec || 0,
      doctrine_a: A.doctrine || null, doctrine_b: C.doctrine || null, start_a: A.start | 0, start_b: C.start | 0,
      policy_a: meta.policyA || null, policy_b: meta.policyB || null, full_json: JSON.stringify(rec),
    });
    const id = r.lastInsertRowid;
    if (rec.soldierSamples && rec.soldierSamples.length) _insManySamples(id, rec.soldierSamples);
    return id;
  })();
  return info;
}

// ---- policy store (the served champion + the league) ----
const _insPolicy = db.prepare(`INSERT INTO policy (tier, generation, genome_json, fitness, battles, is_champion, note)
  VALUES (@tier, @generation, @genome_json, @fitness, @battles, @is_champion, @note)`);
function savePolicy(p) {
  return _insPolicy.run({ tier: p.tier || 'pair', generation: p.generation | 0, genome_json: JSON.stringify(p.genome),
    fitness: p.fitness == null ? null : p.fitness, battles: p.battles | 0, is_champion: p.isChampion ? 1 : 0, note: p.note || null }).lastInsertRowid;
}
function promoteChampion(id) { db.transaction(() => { db.prepare('UPDATE policy SET is_champion=0 WHERE is_champion=1').run(); db.prepare('UPDATE policy SET is_champion=1 WHERE id=?').run(id); })(); }
function getChampion() {
  const row = db.prepare("SELECT id, generation, genome_json, fitness FROM policy WHERE is_champion=1 ORDER BY id DESC LIMIT 1").get()
    || db.prepare("SELECT id, generation, genome_json, fitness FROM policy ORDER BY id DESC LIMIT 1").get();
  if (!row) return null;
  return { id: row.id, generation: row.generation, fitness: row.fitness, genome: JSON.parse(row.genome_json) };
}
function league(n) { // recent distinct champions to duel against (anti-cycling)
  return db.prepare("SELECT id, generation, genome_json FROM policy WHERE is_champion=1 OR generation % 5 = 0 ORDER BY id DESC LIMIT ?").all(n | 0 || 8)
    .map(r => ({ id: r.id, generation: r.generation, genome: JSON.parse(r.genome_json) }));
}

function insertMetric(m) { db.prepare('INSERT INTO metric (generation, battles, champ_vs_baseline, diversity, note) VALUES (?,?,?,?,?)')
  .run(m.generation | 0, m.battles | 0, m.champVsBaseline, m.diversity == null ? null : m.diversity, m.note || null); }

function counts() {
  return { battles: db.prepare('SELECT COUNT(*) n FROM battle').get().n, samples: db.prepare('SELECT COUNT(*) n FROM soldier_sample').get().n,
    policies: db.prepare('SELECT COUNT(*) n FROM policy').get().n, generation: (db.prepare('SELECT MAX(generation) g FROM policy').get().g) || 0 };
}
// aggregate readout (server /stats + trainer logging): doctrine win rates from the last N battles
function stats(limit) {
  const rows = db.prepare('SELECT winner, doctrine_a, doctrine_b, start_a, start_b FROM battle ORDER BY id DESC LIMIT ?').all(limit | 0 || 500);
  const doc = {}; let biggerWon = 0, decided = 0;
  for (const r of rows) {
    const wA = r.winner === 'A' || r.winner === 'AZURE', wB = r.winner === 'B' || r.winner === 'CRIMSON';
    for (const [d, won] of [[r.doctrine_a, wA], [r.doctrine_b, wB]]) { if (!d) continue; (doc[d] || (doc[d] = { g: 0, w: 0 })); doc[d].g++; if (won) doc[d].w++; }
    if (wA || wB) { decided++; if ((wA && r.start_a >= r.start_b) || (wB && r.start_b >= r.start_a)) biggerWon++; }
  }
  const pct = (w, g) => g ? Math.round(100 * w / g) : 0;
  return { battles: rows.length, doctrines: Object.entries(doc).map(([k, v]) => ({ doctrine: k, games: v.g, winPct: pct(v.w, v.g) })).sort((a, b) => b.winPct - a.winPct),
    biggerArmyWinPct: pct(biggerWon, decided) };
}

module.exports = { db, DB_PATH, insertBattle, savePolicy, promoteChampion, getChampion, league, insertMetric, counts, stats };
