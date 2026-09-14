// Blade Vale — the ARENA CAREER: XP + gold from every match, ranks, the marketplace, use-skills,
// trophies, achievements, PvP purse and loot. The host reports a finished match ONCE (POST /arena/result)
// and the server pays every player named in it; each player's client then reads its own career.
const { db } = require('./db');
const { ARENA_RANKS, ARENA_ITEMS, ARENA_SLOTS, ARENA_ACHIEVEMENTS: ACHIEVEMENTS, ARENA_BESTS, PITY_AT, WAGERS, skillLevel, rankOf, rankInfo, renownOf, lockReason, statOf, uniqueChance, rivalBonus, dayKey, dailyOf, dailyScore } = require('../arena-items');

const SIM = require('../arena-sim');
const PVP_CUT = 0.08, PVP_CAP = 60;                       // a beaten player pays 8% of his purse (at most 60) to the winners

// (statements are prepared on first use — index.js runs the migrations after this module loads)
const _st = {}; const Q = (k, sql) => _st[k] || (_st[k] = db.prepare(sql));
function row(acctId) { const get = Q('get', 'SELECT * FROM arena_careers WHERE account_id=?'); let r = get.get(acctId); if (!r) { Q('ins', 'INSERT OR IGNORE INTO arena_careers(account_id) VALUES (?)').run(acctId); r = get.get(acctId); } return r; }
function parse(r) {
  return { xp: r.xp, gold: r.gold, trophies: r.trophies, matches: r.matches, wins: r.wins, kills: r.kills, deaths: r.deaths, damage: r.damage, stars: r.stars,
    items: JSON.parse(r.items_json || '[]'), equipped: JSON.parse(r.equipped_json || '{}'), skills: JSON.parse(r.skills_json || '{}'), achievements: JSON.parse(r.achievements_json || '[]'),
    lastSeed: r.last_seed || null, lastReward: r.last_reward_json ? JSON.parse(r.last_reward_json) : null, meta: metaOf(r.meta_json) };
}
// THE HOOKS' blob (worker/index.js metaOf is the twin): bests, the rival, loot pity, the counters behind the newer achievements
function metaOf(txt) { let m = {}; try { m = JSON.parse(txt || '{}') || {}; } catch (e) {} if (!m.bests) m.bests = {}; m.pity = m.pity | 0; return m; }
const SAVE_SQL = `UPDATE arena_careers SET xp=@xp, gold=@gold, trophies=@trophies, matches=@matches, wins=@wins, kills=@kills, deaths=@deaths, damage=@damage, stars=@stars,
  items_json=@items, equipped_json=@equipped, skills_json=@skills, achievements_json=@achievements, last_seed=@lastSeed, last_reward_json=@lastReward, renown=@renown, meta_json=@meta, updated_at=unixepoch() WHERE account_id=@id`;
function write(acctId, c) {
  Q('save', SAVE_SQL).run({ id: acctId, xp: c.xp | 0, gold: c.gold | 0, trophies: c.trophies | 0, matches: c.matches | 0, wins: c.wins | 0, kills: c.kills | 0, deaths: c.deaths | 0, damage: c.damage | 0, stars: c.stars | 0,
    items: JSON.stringify(c.items), equipped: JSON.stringify(c.equipped), skills: JSON.stringify(c.skills), achievements: JSON.stringify(c.achievements), lastSeed: c.lastSeed, lastReward: c.lastReward ? JSON.stringify(c.lastReward) : null, renown: renownOf(c), meta: JSON.stringify(c.meta || {}) });
}
// what the client sees
function view(c, seed) {
  const skills = {}; for (const k of ['sword', 'bow', 'riding']) skills[k] = { count: c.skills[k] | 0, level: skillLevel(c.skills[k]) }; const m = c.meta || metaOf('{}');
  return { xp: c.xp, gold: c.gold, trophies: c.trophies, matches: c.matches, wins: c.wins, kills: c.kills, deaths: c.deaths, damage: c.damage, stars: c.stars,
    items: c.items, equipped: c.equipped, skills, achievements: c.achievements, rank: rankInfo(c.xp), lastSeed: c.lastSeed, lastReward: (!seed || c.lastSeed === String(seed)) ? c.lastReward : null,
    meta: { bests: m.bests || {}, rival: m.rival || null, pity: m.pity | 0, pityAt: PITY_AT, rivalsBeaten: m.rivalsBeaten | 0, dailies: m.dailies | 0, dailyTops: m.dailyTops | 0, belts: m.belts | 0 } };
}
function beltRow() { return db.prepare('SELECT holder, renown, since, defenses FROM arena_belt WHERE id=1').get() || { holder: null, renown: 0, since: 0, defenses: 0 }; }
function career(acctId, seed) { const c = parse(row(acctId)), v = view(c, seed); v.renown = renownOf(c); Object.assign(v, position('player', v.renown, c.matches)); v.belt = beltRow(); return v; }

function buy(acctId, id) {
  const c = parse(row(acctId)), why = lockReason(id, c);
  if (why) return { ok: false, error: why, career: view(c) };
  const it = ARENA_ITEMS[id]; c.gold -= it.price; c.items.push(id); c.equipped[it.slot] = id;   // a new piece is worn at once
  write(acctId, c); return { ok: true, career: view(c) };
}
function equip(acctId, slot, id) {
  const c = parse(row(acctId));
  if (ARENA_SLOTS.indexOf(slot) < 0) return { ok: false, error: 'no such slot', career: view(c) };
  if (id == null || id === '') { if (slot === 'sword') return { ok: false, error: 'a fighter needs a sword', career: view(c) }; delete c.equipped[slot]; }
  else { const it = ARENA_ITEMS[id]; if (!it || it.slot !== slot) return { ok: false, error: 'that does not go there', career: view(c) }; if (c.items.indexOf(id) < 0) return { ok: false, error: 'not yours', career: view(c) }; c.equipped[slot] = id; }
  write(acctId, c); return { ok: true, career: view(c) };
}

// ---- the payout. players: [{ handle, team, kills, dmg, alive, star, enemyPower, skills:{sword,bow,riding} }] ----
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function rewardFor(p, won, draw) {
  const base = 6 * Math.pow(clamp(+p.enemyPower || 1, 1, 600), 0.6);      // the size and quality of what you faced
  const outcome = won ? 1.5 : draw ? 1 : 0.6, star = p.star ? 1.6 : 1;   // the STAR of the match earns noticeably more
  const kills = clamp(p.kills | 0, 0, 500), dmg = clamp(+p.dmg || 0, 0, 1e5);
  return { xp: Math.round((base * outcome + 4 * kills + dmg / 50) * star), gold: Math.round((base * 0.8 * outcome + 3 * kills + dmg / 80) * star),
    trophies: won ? 1 + Math.floor(Math.sqrt(clamp(+p.enemyPower || 1, 1, 600)) / 3) : 0 };
}
function applyResult(reporterAcct, body) {
  const findAcct = Q('acct', 'SELECT id, handle FROM accounts WHERE handle=?'), paid = Q('paid', 'SELECT 1 FROM arena_results WHERE seed=? AND account_id=?'), markPaid = Q('mark', 'INSERT OR IGNORE INTO arena_results(seed, account_id) VALUES (?, ?)');
  const seed = String(body.seed || ''), winner = body.winner | 0, players = Array.isArray(body.players) ? body.players.slice(0, 64) : [];
  if (!seed || !players.length) return { ok: false, error: 'no result' };
  if (!players.some(p => p.handle === reporterAcct.handle)) return { ok: false, error: 'not your fight' };   // only a player in the fight may report it
  const npcs = Array.isArray(body.npcs) ? body.npcs.slice(0, 400).filter(n => n && typeof n.name === 'string' && n.name.length >= 2 && n.name.length <= 40) : [];
  const size = players.length + npcs.length, venue = String(body.venue || 'colosseum').slice(0, 16);
  const bout = boutFn(seed, venue, size);
  const rewards = {};
  db.transaction(() => {
    const accts = new Map(); for (const p of players) { const a = findAcct.get(String(p.handle || '')); if (a && !paid.get(seed, a.id)) accts.set(p.handle, a); }
    const cs = new Map(); for (const [h, a] of accts) cs.set(h, parse(row(a.id)));
    // the PvP purse: real players who lost to real players pay a cut, split among the winning players
    const teams = new Set(players.map(p => p.team | 0)), winners = players.filter(p => (p.team | 0) === winner && accts.has(p.handle)), losers = players.filter(p => (p.team | 0) !== winner && accts.has(p.handle));
    let pot = 0; const pvp = winner >= 0 && teams.size >= 2 && winners.length && losers.length; const paidCut = {};
    if (pvp) for (const p of losers) { const c = cs.get(p.handle), cut = Math.min(PVP_CAP, Math.floor(c.gold * PVP_CUT)); c.gold -= cut; pot += cut; paidCut[p.handle] = cut; }
    const wager = WAGERS.indexOf(body.wager | 0) > 0 ? body.wager | 0 : 0, daily = dailyDayOf(body.daily, seed);
    const belt = beltRow(); let beltHolder = belt.holder, beltRenown = belt.renown | 0;
    for (const p of players) {
      const a = accts.get(p.handle); if (!a) continue; const c = cs.get(p.handle), won = (p.team | 0) === winner, draw = winner < 0;
      const r = rewardFor(p, won, draw), before = rankOf(c.xp), renownBefore = renownOf(c), m = c.meta;
      c.xp += r.xp; c.gold += r.gold; c.trophies += r.trophies; c.matches++; if (won) c.wins++; c.kills += clamp(p.kills | 0, 0, 500); if (!p.alive) c.deaths++; c.damage += Math.round(clamp(+p.dmg || 0, 0, 1e5)); if (p.star) c.stars++;
      const sk = p.skills || {}; for (const k of ['sword', 'bow', 'riding']) c.skills[k] = (c.skills[k] | 0) + clamp(sk[k] | 0, 0, 200);
      const reward = Object.assign({ seed, won, draw, star: !!p.star, xpBefore: c.xp - r.xp }, r);
      if (pvp && won) { const share = Math.floor(pot / winners.length); c.gold += share; reward.purse = share; }
      if (pvp && !won) reward.purse = -(paidCut[p.handle] || 0);
      if (wager && !draw) { const stake = Math.min(wager, Math.max(0, c.gold)); if (won) c.gold += stake; else c.gold -= stake; reward.wager = won ? stake : -stake; }
      if (won) {                                               // LOOT: the odd purse, and a unique whose odds climb with every win that rolled none (PITY)
        if (Math.random() < 0.25) { const g = 10 + Math.floor(Math.random() * 31); c.gold += g; reward.lootGold = g; }
        if (Math.random() < uniqueChance(m.pity)) { const pool = Object.keys(ARENA_ITEMS).filter(id => ARENA_ITEMS[id].unique && c.items.indexOf(id) < 0);
          if (pool.length) { const id = pool[Math.floor(Math.random() * pool.length)]; c.items.push(id); c.equipped[ARENA_ITEMS[id].slot] = id; reward.loot = id; m.pity = 0; } else { c.gold += 50; reward.lootGold = (reward.lootGold || 0) + 50; } }
        else m.pity++;
        reward.pity = m.pity; reward.pityAt = PITY_AT;
      }
      { const B = p.bests || {}, cand = { kills: p.kills, dmg: p.dmg, life: B.life, blow: B.blow, streak: B.streak }, beat = [];   // PERSONAL BESTS
        for (const [k, , cap] of ARENA_BESTS) { const v = Math.round(clamp(+cand[k] || 0, 0, cap)), was = m.bests[k] | 0; if (v > was) { m.bests[k] = v; beat.push({ k, v, was }); } }
        if (beat.length) reward.bests = beat; }
      { const rv = m.rival, inPit = rv && npcs.some(n => n.name === rv.name);   // THE RIVAL
        if (inPit && won) { const bn = rivalBonus(rv); c.xp += bn.xp; c.gold += bn.gold; m.rivalsBeaten = (m.rivalsBeaten | 0) + 1; reward.rival = { name: rv.name, beaten: true, xp: bn.xp, gold: bn.gold, times: rv.times | 0 }; m.rival = null; }
        else if (!won && p.killedBy && p.killedBy.kind === 'npc' && typeof p.killedBy.name === 'string') { const n = npcs.find(x => x.name === p.killedBy.name);
          if (n) { const same = rv && rv.name === n.name; m.rival = { name: n.name, arch: n.arch, skill: n.skill | 0, times: same ? (rv.times | 0) + 1 : 1, since: same ? rv.since : Math.floor(Date.now() / 1000) }; reward.rival = { name: n.name, beaten: false, times: m.rival.times }; } }
        else if (inPit && !won && rv) { rv.times = (rv.times | 0) + 1; reward.rival = { name: rv.name, beaten: false, times: rv.times }; } }
      if (daily) {                                             // THE BOUT OF THE DAY
        const sc = dailyScore(p, won, draw), old = db.prepare('SELECT score, tries FROM arena_daily WHERE day=? AND fighter=?').get(daily, a.handle);
        const top = (db.prepare('SELECT MAX(score) AS s FROM arena_daily WHERE day=? AND fighter<>?').get(daily, a.handle) || {}).s | 0, best = Math.max(sc, old ? old.score | 0 : 0);
        if (!old) db.prepare('INSERT INTO arena_daily(day, fighter, score, kills, dmg, alive, won, tries) VALUES (?,?,?,?,?,?,?,1)').run(daily, a.handle, sc, clamp(p.kills | 0, 0, 500), Math.round(clamp(+p.dmg || 0, 0, 1e5)), p.alive ? 1 : 0, won ? 1 : 0);
        else if (sc > (old.score | 0)) db.prepare('UPDATE arena_daily SET score=?, kills=?, dmg=?, alive=?, won=?, tries=tries+1, updated_at=unixepoch() WHERE day=? AND fighter=?').run(sc, clamp(p.kills | 0, 0, 500), Math.round(clamp(+p.dmg || 0, 0, 1e5)), p.alive ? 1 : 0, won ? 1 : 0, daily, a.handle);
        else db.prepare('UPDATE arena_daily SET tries=tries+1, updated_at=unixepoch() WHERE day=? AND fighter=?').run(daily, a.handle);
        if (!old) m.dailies = (m.dailies | 0) + 1;
        const topped = best > top && !(old && (old.score | 0) > top); if (topped) m.dailyTops = (m.dailyTops | 0) + 1;
        reward.daily = { day: daily, score: sc, best, tries: old ? (old.tries | 0) + 1 : 1, top: topped, toBeat: best > top ? 0 : top - best + 1 }; }
      const renownAfter = renownOf(c);                        // THE LADDER: whom you passed; the champion's belt
      if (renownAfter > renownBefore) { const passed = db.prepare('SELECT a.handle, COUNT(*) OVER () AS n FROM arena_careers c JOIN accounts a ON a.id=c.account_id WHERE c.matches>0 AND a.id<>? AND c.renown>=? AND c.renown<? ORDER BY c.renown DESC LIMIT 1').get(a.id, renownBefore, renownAfter); if (passed) reward.passed = { name: passed.handle, n: passed.n | 0 }; }
      if (won && (!beltHolder || (beltHolder !== a.handle && renownAfter > beltRenown))) {   // (taken on a win only — a loss never crowns anyone) reward.belt = { taken: beltHolder || null, defenses: 0 }; m.belts = (m.belts | 0) + 1; beltHolder = a.handle; beltRenown = renownAfter;
        db.prepare('INSERT INTO arena_belt(id, holder, renown, since, defenses) VALUES (1,?,?,unixepoch(),0) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, renown=excluded.renown, since=excluded.since, defenses=0').run(a.handle, renownAfter); }
      else if (beltHolder === a.handle) { const d = (belt.defenses | 0) + (won ? 1 : 0); beltRenown = renownAfter; reward.belt = { held: true, defenses: d, since: belt.since }; db.prepare('UPDATE arena_belt SET renown=?, defenses=? WHERE id=1').run(renownAfter, d); }
      const after = rankOf(c.xp); if (after > before) reward.rankUp = ARENA_RANKS[after][0];
      const earned = []; for (const [id, label, stat, at] of ACHIEVEMENTS) if (statOf(c, stat) >= at && c.achievements.indexOf(id) < 0) { c.achievements.push(id); earned.push(label); }
      if (earned.length) reward.achievements = earned;
      reward.position = position('player', renownAfter, c.matches).position; reward.renown = renownAfter;
      c.lastSeed = seed; c.lastReward = reward; write(a.id, c); markPaid.run(seed, a.id); bout('player', a.handle, p, won, draw); rewards[p.handle] = reward;
    }
    applyNpcs(seed, winner, npcs, bout);
  })();
  return { ok: true, rewards };
}
const boutFn = (seed, venue, size) => (kind, name, p, won, draw) => Q('bout', 'INSERT OR IGNORE INTO arena_bouts(seed, kind, fighter, team, won, draw, kills, dmg, alive, star, venue, size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(seed, kind, name, p.team | 0, won ? 1 : 0, draw ? 1 : 0, clamp(p.kills | 0, 0, 500), Math.round(clamp(+p.dmg || 0, 0, 1e5)), p.alive ? 1 : 0, p.star ? 1 : 0, venue, size);
// the vale's men fight among themselves (worker/index.js simulateRound is the twin): n bouts with no player in them
function simulateRound(n) {
  const known = db.prepare('SELECT name, arch, skill FROM npc_careers ORDER BY updated_at DESC LIMIT 200').all(), out = [];
  for (let i = 0; i < n; i++) {
    const f = SIM.simulateFight('sim-' + Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2, 8), known);
    db.transaction(() => applyNpcs(f.seed, f.winner, f.npcs, boutFn(f.seed, f.venue, f.size)))();
    out.push({ seed: f.seed, venue: f.venue, teams: f.teams, per: f.per, winner: f.winner, star: (f.npcs.find(m => m.star) || {}).name });
  }
  return out;
}
// the vale's own men keep a record too (see worker/index.js applyNpcs — the same rules): XP as a player would earn,
// wins, kills, stars, the archetype tally; idempotent through arena_bouts
const NPC_ARCHS = new Set(['swordsman', 'brute', 'duelist', 'guardsman', 'archer', 'rider']);
const NPC_BLANK = { arch: 'swordsman', archs_json: '{}', skill: 50, xp: 0, matches: 0, wins: 0, kills: 0, deaths: 0, damage: 0, stars: 0 };
function applyNpcs(seed, winner, npcs, bout) {
  const has = Q('boutHas', "SELECT 1 FROM arena_bouts WHERE seed=? AND kind='npc' AND fighter=?"), get = Q('npcGet', 'SELECT * FROM npc_careers WHERE name=?');
  const up = Q('npcUp', `INSERT INTO npc_careers(name, arch, archs_json, skill, xp, matches, wins, kills, deaths, damage, stars, renown) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET arch=excluded.arch, archs_json=excluded.archs_json, skill=excluded.skill, xp=excluded.xp, matches=excluded.matches, wins=excluded.wins, kills=excluded.kills, deaths=excluded.deaths, damage=excluded.damage, stars=excluded.stars, renown=excluded.renown, updated_at=unixepoch()`);
  const seen = new Set();
  for (const n of npcs) {
    if (seen.has(n.name) || has.get(seed, n.name)) continue; seen.add(n.name);
    const r = get.get(n.name) || NPC_BLANK, won = (n.team | 0) === winner, draw = winner < 0, rw = rewardFor(n, won, draw);
    const c = { xp: r.xp + rw.xp, matches: r.matches + 1, wins: r.wins + (won ? 1 : 0), kills: r.kills + clamp(n.kills | 0, 0, 500), deaths: r.deaths + (n.alive ? 0 : 1), damage: r.damage + Math.round(clamp(+n.dmg || 0, 0, 1e5)), stars: r.stars + (n.star ? 1 : 0) };
    const arch = NPC_ARCHS.has(n.arch) ? n.arch : 'swordsman'; let archs = {}; try { archs = JSON.parse(r.archs_json || '{}'); } catch (e) {} archs[arch] = (archs[arch] | 0) + 1;
    up.run(n.name, arch, JSON.stringify(archs), clamp(n.skill | 0, 0, 100), c.xp, c.matches, c.wins, c.kills, c.deaths, c.damage, c.stars, renownOf(c));
    bout('npc', n.name, n, won, draw);
  }
}

// THE BOUT OF THE DAY (worker/index.js dailyDayOf / dailyBoard are the twins)
function dailyDayOf(day, seed) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !String(seed).startsWith('d' + day + '-')) return null;
  const today = dayKey(), yest = dayKey(new Date(Date.now() - 86400e3)); return day === today || day === yest ? day : null;
}
function dailyBoard(me) {
  const day = dayKey(), spec = dailyOf(day);
  const rows = db.prepare('SELECT fighter AS name, score, kills, dmg, alive, won, tries, updated_at FROM arena_daily WHERE day=? ORDER BY score DESC, updated_at ASC LIMIT 10').all(day); rows.forEach((r, i) => { r.pos = i + 1; });
  const total = db.prepare('SELECT COUNT(*) AS n FROM arena_daily WHERE day=?').get(day).n;
  let mine = null; if (me) { const r = db.prepare('SELECT score, kills, dmg, alive, won, tries FROM arena_daily WHERE day=? AND fighter=?').get(day, me); if (r) { r.pos = db.prepare('SELECT COUNT(*) AS n FROM arena_daily WHERE day=? AND score>?').get(day, r.score).n + 1; mine = r; } }
  const endsIn = Math.max(0, Math.floor((Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1) - Date.now()) / 1000));
  return { ok: true, day, spec, board: rows, total, mine, endsIn };
}

// ---- profiles + the ladder (the Worker's twin: see worker/index.js "profiles + the ladder") ----
const npcTier = skill => skill >= 82 ? 'champion' : skill >= 60 ? 'veteran' : skill >= 35 ? 'soldier' : 'recruit';
const LADDER = {
  player: { from: 'FROM arena_careers c JOIN accounts a ON a.id=c.account_id', name: 'a.handle', cols: "a.handle AS name, 'player' AS kind, c.renown, c.xp, c.matches, c.wins, c.stars, c.kills, c.trophies", table: 'arena_careers' },
  npc: { from: 'FROM npc_careers c', name: 'c.name', cols: "c.name, 'npc' AS kind, c.renown, c.xp, c.matches, c.wins, c.stars, c.kills, c.arch, c.skill", table: 'npc_careers' },
};
const ladderTitle = r => r.kind === 'player' ? rankInfo(r.xp).name : npcTier(r.skill) + ' ' + r.arch;
function rankings(o) {
  const kind = o.kind === 'npc' ? 'npc' : 'player', L = LADDER[kind], scope = o.scope === 'network' ? 'network' : 'global';
  const lim = clamp(parseInt(o.limit, 10) || 50, 1, 200), off = Math.max(0, parseInt(o.offset, 10) || 0);
  let where = 'WHERE c.matches > 0'; const args = [];
  if (scope === 'network') {
    if (!o.me) return { ok: false, error: 'sign in to see your network' };
    where += ` AND ${L.name} IN (SELECT fighter FROM arena_bouts WHERE kind=? AND seed IN (SELECT seed FROM arena_bouts WHERE kind='player' AND fighter=?))`; args.push(kind, o.me);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n ${L.from} ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT ${L.cols} ${L.from} ${where} ORDER BY c.renown DESC, c.wins DESC, name ASC LIMIT ? OFFSET ?`).all(...args, lim, off);
  rows.forEach((r, i) => { r.pos = off + i + 1; r.title = ladderTitle(r); });
  const belt = kind === 'player' ? beltRow() : null; if (belt && belt.holder) for (const r of rows) if (r.name === belt.holder) r.belt = { since: belt.since, defenses: belt.defenses };
  return { ok: true, kind, scope, total, rows, belt: belt && belt.holder ? belt : null };
}
function position(kind, renown, matches) {
  const t = LADDER[kind].table, of = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE matches > 0`).get().n;
  if (!(matches > 0)) return { position: null, of };
  return { position: db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE matches > 0 AND renown > ?`).get(renown).n + 1, of };
}
const BLANK_ROW = { xp: 0, gold: 0, trophies: 0, matches: 0, wins: 0, kills: 0, deaths: 0, damage: 0, stars: 0, items_json: '["wood_sword"]', equipped_json: '{"sword":"wood_sword"}', skills_json: '{}', achievements_json: '[]', last_seed: null, last_reward_json: null, meta_json: '{}' };
function profile(name, kind) {
  name = String(name || '').trim().slice(0, 64); if (!name) return { ok: false, error: 'who?' };
  let p = null;
  if (kind !== 'npc') {
    const a = db.prepare('SELECT id, handle, created_at FROM accounts WHERE handle=? COLLATE NOCASE').get(name);
    if (a) { const c = parse(db.prepare('SELECT * FROM arena_careers WHERE account_id=?').get(a.id) || BLANK_ROW);
      const skills = {}; for (const k of ['sword', 'bow', 'riding']) skills[k] = { level: skillLevel(c.skills[k]) };
      p = { name: a.handle, kind: 'player', rank: rankInfo(c.xp), title: rankInfo(c.xp).name, xp: c.xp, matches: c.matches, wins: c.wins, losses: Math.max(0, c.matches - c.wins), kills: c.kills, deaths: c.deaths, damage: c.damage, stars: c.stars, trophies: c.trophies,
        skills, achievements: c.achievements, equipped: c.equipped, renown: renownOf(c), since: a.created_at, bests: c.meta.bests || {}, rivalsBeaten: c.meta.rivalsBeaten | 0, dailyTops: c.meta.dailyTops | 0 };
      const belt = beltRow(); if (belt.holder === a.handle) p.belt = { since: belt.since, defenses: belt.defenses }; }
  }
  if (!p && kind !== 'player') {
    const r = db.prepare('SELECT * FROM npc_careers WHERE name=? COLLATE NOCASE').get(name);
    if (r) { let archs = {}; try { archs = JSON.parse(r.archs_json || '{}'); } catch (e) {}
      p = { name: r.name, kind: 'npc', arch: r.arch, archs, skill: r.skill, tier: npcTier(r.skill), title: npcTier(r.skill) + ' ' + r.arch, xp: r.xp, matches: r.matches, wins: r.wins, losses: Math.max(0, r.matches - r.wins), kills: r.kills, deaths: r.deaths, damage: r.damage, stars: r.stars, renown: r.renown, since: r.created_at, lastFought: r.updated_at }; }
  }
  if (!p) return { ok: false, error: 'no fighter of that name has stood in the pit' };
  Object.assign(p, position(p.kind, p.renown, p.matches));
  p.recent = db.prepare('SELECT seed, team, won, draw, kills, dmg, alive, star, venue, size, created_at FROM arena_bouts WHERE kind=? AND fighter=? ORDER BY created_at DESC LIMIT 10').all(p.kind, p.name);
  return { ok: true, profile: p };
}
module.exports = { career, buy, equip, applyResult, profile, rankings, dailyBoard, simulateRound, ACHIEVEMENTS };
