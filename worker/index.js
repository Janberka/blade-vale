// Blade Vale on Cloudflare Workers — the Arena Fights backend, in front of the static client.
//
// One Worker carries everything bladevale.com needs:
//   * the game files, served as static assets (dist/, built by tools/build-site.js)
//   * /api/v1/*  — accounts, sessions, the arena career and the marketplace, on D1
//   * /coop      — the co-op relay, a single Durable Object holding every WebSocket
//
// It is a port of server/index.js + auth.js + arena.js + ws.js, cut down to what the arena uses. The
// living world (server/tick.js, warfare.js, chunks.js …) is parked and does not run here: /world and
// the other open-world routes answer 404, which the client already treats as "offline" for that layer.
// Password hashes are PBKDF2-SHA256 through WebCrypto (Workers have no scrypt), so accounts made on the
// Node server do not carry over — bladevale.com starts with a fresh ledger.
import ARENA from '../arena-items.js';
import SIM from '../arena-sim.js';
const { ARENA_RANKS, ARENA_ITEMS, ARENA_SLOTS, cleanLook, ARENA_ACHIEVEMENTS, ARENA_BESTS, PITY_AT, WAGERS, skillLevel, rankOf, rankInfo, renownOf, lockReason, statOf, uniqueChance, rivalBonus, dayKey, dailyOf, dailyScore } = ARENA;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Player-Token, X-World',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
async function readBody(request) { try { const t = await request.text(); return t ? JSON.parse(t) : {}; } catch (e) { return {}; } }

// ---------- crypto (WebCrypto only) ----------
const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((h) => parseInt(h, 16)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const PBKDF2_ITERS = 100000;
async function hashPw(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: PBKDF2_ITERS }, key, 256);
  return hex(bits);
}
async function checkPw(acct, password) {
  if (!acct.pass_hash || !acct.pass_salt) return false;
  const h = unhex(await hashPw(password, acct.pass_salt)), w = unhex(acct.pass_hash);
  return h.length === w.length && crypto.subtle.timingSafeEqual(h, w);
}

// ---------- accounts + sessions (server/auth.js, server/seed.js) ----------
const NAME_RE = /^[a-zA-Z0-9_\-]{2,24}$/;
const q = (db, sql, ...args) => db.prepare(sql).bind(...args);
async function mintSession(db, accountId) {
  const token = 's-' + randomHex(24);
  await q(db, 'INSERT INTO sessions(token, account_id) VALUES (?,?)', token, accountId).run();
  return token;
}
async function register(db, username, password) {
  username = String(username || '').trim(); password = String(password || '');
  if (!NAME_RE.test(username)) return { ok: false, error: 'username: 2-24 letters/digits/_/-' };
  if (password.length < 4) return { ok: false, error: 'password: at least 4 characters' };
  let acct = await q(db, 'SELECT * FROM accounts WHERE handle=?', username).first();
  if (acct && acct.pass_hash) return { ok: false, error: 'that name is taken' };
  const salt = randomHex(12), hash = await hashPw(password, salt);
  if (acct) await q(db, 'UPDATE accounts SET pass_salt=?, pass_hash=? WHERE id=?', salt, hash, acct.id).run();   // claim a legacy handle
  else { const r = await q(db, 'INSERT INTO accounts(handle, pass_salt, pass_hash) VALUES (?,?,?)', username, salt, hash).run(); acct = { id: r.meta.last_row_id, handle: username }; }
  return { ok: true, token: await mintSession(db, acct.id), username };
}
async function login(db, username, password) {
  const acct = await q(db, 'SELECT * FROM accounts WHERE handle=?', String(username || '').trim()).first();
  if (!acct || !acct.pass_hash) return { ok: false, error: 'no such user — create the account first' };
  if (!(await checkPw(acct, password))) return { ok: false, error: 'wrong password' };
  return { ok: true, token: await mintSession(db, acct.id), username: acct.handle };
}
async function resolveSession(db, token) {
  if (!token || token.slice(0, 2) !== 's-') return null;
  return (await q(db, 'SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token=?', token).first()) || null;
}
async function handleLocked(db, handle) {
  const a = await q(db, 'SELECT pass_hash FROM accounts WHERE handle=?', String(handle || '')).first();
  return !!(a && a.pass_hash);
}
async function ensureAccount(db, handle) {
  handle = (handle && String(handle).slice(0, 64)) || 'local';
  let acct = await q(db, 'SELECT * FROM accounts WHERE handle=?', handle).first();
  if (!acct) { const r = await q(db, 'INSERT INTO accounts(handle) VALUES (?)', handle).run(); acct = { id: r.meta.last_row_id, handle }; }
  return acct;
}
async function ensureWorldFor(db, acct) {
  let w = await q(db, 'SELECT * FROM worlds WHERE account_id=?', acct.id).first();
  if (!w) {
    const seed = (Date.now() % 1000000000) | 0;
    await q(db, 'INSERT OR IGNORE INTO worlds(account_id, seed) VALUES (?,?)', acct.id, seed).run();
    w = await q(db, 'SELECT * FROM worlds WHERE account_id=?', acct.id).first();
  }
  return w;
}

// ---------- the arena career (server/arena.js) ----------
const PVP_CUT = 0.08, PVP_CAP = 60;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
async function careerRow(db, acctId) {
  let r = await q(db, 'SELECT * FROM arena_careers WHERE account_id=?', acctId).first();
  if (!r) { await q(db, 'INSERT OR IGNORE INTO arena_careers(account_id) VALUES (?)', acctId).run(); r = await q(db, 'SELECT * FROM arena_careers WHERE account_id=?', acctId).first(); }
  return r;
}
function parse(r) {
  return { xp: r.xp, gold: r.gold, trophies: r.trophies, matches: r.matches, wins: r.wins, kills: r.kills, deaths: r.deaths, damage: r.damage, stars: r.stars,
    items: JSON.parse(r.items_json || '[]'), equipped: JSON.parse(r.equipped_json || '{}'), skills: JSON.parse(r.skills_json || '{}'), achievements: JSON.parse(r.achievements_json || '[]'),
    lastSeed: r.last_seed || null, lastReward: r.last_reward_json ? JSON.parse(r.last_reward_json) : null, meta: metaOf(r.meta_json) };
}
// THE HOOKS' blob on the career: personal bests, the rival waiting in the pit, the loot pity count, the counters
// behind the newer achievements (rivalsBeaten, dailies, dailyTops, belts)
function metaOf(txt) { let m = {}; try { m = JSON.parse(txt || '{}') || {}; } catch (e) {} if (!m.bests) m.bests = {}; m.pity = m.pity | 0; return m; }
const SAVE_SQL = `UPDATE arena_careers SET xp=?, gold=?, trophies=?, matches=?, wins=?, kills=?, deaths=?, damage=?, stars=?,
  items_json=?, equipped_json=?, skills_json=?, achievements_json=?, last_seed=?, last_reward_json=?, renown=?, meta_json=?, updated_at=unixepoch() WHERE account_id=?`;
function saveStmt(db, acctId, c) {
  return q(db, SAVE_SQL, c.xp | 0, c.gold | 0, c.trophies | 0, c.matches | 0, c.wins | 0, c.kills | 0, c.deaths | 0, c.damage | 0, c.stars | 0,
    JSON.stringify(c.items), JSON.stringify(c.equipped), JSON.stringify(c.skills), JSON.stringify(c.achievements), c.lastSeed, c.lastReward ? JSON.stringify(c.lastReward) : null, renownOf(c), JSON.stringify(c.meta || {}), acctId);
}
const BLANK_ROW = { xp: 0, gold: 0, trophies: 0, matches: 0, wins: 0, kills: 0, deaths: 0, damage: 0, stars: 0, items_json: '["wood_sword"]', equipped_json: '{"sword":"wood_sword"}', skills_json: '{}', achievements_json: '[]', last_seed: null, last_reward_json: null, meta_json: '{}' };
function view(c, seed) {
  const skills = {}; for (const k of ['sword', 'bow', 'riding']) skills[k] = { count: c.skills[k] | 0, level: skillLevel(c.skills[k]) };
  const m = c.meta || metaOf('{}');
  return { xp: c.xp, gold: c.gold, trophies: c.trophies, matches: c.matches, wins: c.wins, kills: c.kills, deaths: c.deaths, damage: c.damage, stars: c.stars,
    items: c.items, equipped: c.equipped, skills, achievements: c.achievements, rank: rankInfo(c.xp), lastSeed: c.lastSeed, lastReward: (!seed || c.lastSeed === String(seed)) ? c.lastReward : null,
    meta: { bests: m.bests || {}, rival: m.rival || null, pity: m.pity | 0, pityAt: PITY_AT, rivalsBeaten: m.rivalsBeaten | 0, dailies: m.dailies | 0, dailyTops: m.dailyTops | 0, belts: m.belts | 0, look: m.look || null } };
}
async function beltRow(db) { return (await q(db, 'SELECT holder, renown, since, defenses FROM arena_belt WHERE id=1').first()) || { holder: null, renown: 0, since: 0, defenses: 0 }; }
async function career(db, acctId, seed) { const c = parse(await careerRow(db, acctId)), v = view(c, seed); v.renown = renownOf(c); Object.assign(v, await position(db, 'player', v.renown, c.matches)); v.belt = await beltRow(db); return v; }
async function buy(db, acctId, id) {
  const c = parse(await careerRow(db, acctId)), why = lockReason(id, c);
  if (why) return { ok: false, error: why, career: view(c) };
  const it = ARENA_ITEMS[id]; c.gold -= it.price; c.items.push(id); c.equipped[it.slot] = id;
  await saveStmt(db, acctId, c).run(); return { ok: true, career: view(c) };
}
async function setLook(db, acctId, look) {                 // the barber: skin, hair, hair colour, beard — kept in the career's meta
  const c = parse(await careerRow(db, acctId)), L = cleanLook(look); if (!L) return { ok: false, error: 'no such look', career: view(c) };
  c.meta.look = Object.assign({}, c.meta.look || {}, L); await saveStmt(db, acctId, c).run(); return { ok: true, career: view(c) };
}
async function equip(db, acctId, slot, id) {
  const c = parse(await careerRow(db, acctId));
  if (ARENA_SLOTS.indexOf(slot) < 0) return { ok: false, error: 'no such slot', career: view(c) };
  if (id == null || id === '') { if (slot === 'sword') return { ok: false, error: 'a fighter needs a sword', career: view(c) }; delete c.equipped[slot]; }
  else { const it = ARENA_ITEMS[id]; if (!it || it.slot !== slot) return { ok: false, error: 'that does not go there', career: view(c) }; if (c.items.indexOf(id) < 0) return { ok: false, error: 'not yours', career: view(c) }; c.equipped[slot] = id; }
  await saveStmt(db, acctId, c).run(); return { ok: true, career: view(c) };
}
function rewardFor(p, won, draw) {
  const base = 6 * Math.pow(clamp(+p.enemyPower || 1, 1, 600), 0.6);
  const outcome = won ? 1.5 : draw ? 1 : 0.6, star = p.star ? 1.6 : 1;
  const kills = clamp(p.kills | 0, 0, 500), dmg = clamp(+p.dmg || 0, 0, 1e5);
  return { xp: Math.round((base * outcome + 4 * kills + dmg / 50) * star), gold: Math.round((base * 0.8 * outcome + 3 * kills + dmg / 80) * star),
    trophies: won ? 1 + Math.floor(Math.sqrt(clamp(+p.enemyPower || 1, 1, 600)) / 3) : 0 };
}
// the payout: reads for everyone in the fight, then ONE atomic batch of writes (D1 has no interactive
// transactions; the batch is all-or-nothing, and arena_results keeps a re-sent report from paying twice)
async function applyResult(db, reporter, body) {
  const seed = String(body.seed || ''), winner = body.winner | 0, players = Array.isArray(body.players) ? body.players.slice(0, 64) : [];
  if (!seed || !players.length) return { ok: false, error: 'no result' };
  if (!players.some((p) => p.handle === reporter.handle)) return { ok: false, error: 'not your fight' };
  // the vale's own men are in the report too (npcs: [{name, team, kills, dmg, alive, star, arch, skill, enemyPower}]) — they keep a record like anyone
  const npcs = Array.isArray(body.npcs) ? body.npcs.slice(0, 400).filter((n) => n && typeof n.name === 'string' && n.name.length >= 2 && n.name.length <= 40) : [];
  const size = players.length + npcs.length, venue = String(body.venue || 'colosseum').slice(0, 16);
  const done = new Set(); for (const r of (await q(db, 'SELECT kind, fighter FROM arena_bouts WHERE seed=?', seed).all()).results) done.add(r.kind + '|' + r.fighter);
  const bout = boutStmt(db, seed, venue, size);
  const accts = new Map(), cs = new Map();
  for (const p of players) {
    const h = String(p.handle || ''); if (accts.has(h)) continue;
    const a = await q(db, 'SELECT id, handle FROM accounts WHERE handle=?', h).first(); if (!a) continue;
    if (await q(db, 'SELECT 1 AS x FROM arena_results WHERE seed=? AND account_id=?', seed, a.id).first()) continue;
    accts.set(h, a); cs.set(h, parse(await careerRow(db, a.id)));
  }
  const teams = new Set(players.map((p) => p.team | 0)), winners = players.filter((p) => (p.team | 0) === winner && accts.has(p.handle)), losers = players.filter((p) => (p.team | 0) !== winner && accts.has(p.handle));
  let pot = 0; const pvp = winner >= 0 && teams.size >= 2 && winners.length && losers.length; const paidCut = {};
  if (pvp) for (const p of losers) { const c = cs.get(p.handle), cut = Math.min(PVP_CAP, Math.floor(c.gold * PVP_CUT)); c.gold -= cut; pot += cut; paidCut[p.handle] = cut; }
  const rewards = {}, writes = [];
  const wager = WAGERS.indexOf(body.wager | 0) > 0 ? body.wager | 0 : 0;   // the host's stake, one of the lobby's steps (every signed-in player in the pit stakes it)
  const daily = dailyDayOf(body.daily, seed);                             // the bout of the day this fight was, if it was one (null otherwise)
  const belt = await beltRow(db); let beltHolder = belt.holder, beltRenown = belt.renown | 0;
  for (const p of players) {
    const a = accts.get(p.handle); if (!a || rewards[p.handle]) continue; const c = cs.get(p.handle), won = (p.team | 0) === winner, draw = winner < 0;
    const r = rewardFor(p, won, draw), before = rankOf(c.xp), renownBefore = renownOf(c), m = c.meta;
    c.xp += r.xp; c.gold += r.gold; c.trophies += r.trophies; c.matches++; if (won) c.wins++; c.kills += clamp(p.kills | 0, 0, 500); if (!p.alive) c.deaths++; c.damage += Math.round(clamp(+p.dmg || 0, 0, 1e5)); if (p.star) c.stars++;
    const sk = p.skills || {}; for (const k of ['sword', 'bow', 'riding']) c.skills[k] = (c.skills[k] | 0) + clamp(sk[k] | 0, 0, 200);
    const reward = Object.assign({ seed, won, draw, star: !!p.star, xpBefore: c.xp - r.xp }, r);
    if (pvp && won) { const share = Math.floor(pot / winners.length); c.gold += share; reward.purse = share; }
    if (pvp && !won) reward.purse = -(paidCut[p.handle] || 0);
    if (wager && !draw) { const stake = Math.min(wager, Math.max(0, c.gold)); if (won) c.gold += stake; else c.gold -= stake; reward.wager = won ? stake : -stake; }   // THE WAGER (never past what he has)
    if (won) {                                               // LOOT: the odd purse, and a unique whose odds climb with every win that rolled none (PITY)
      if (Math.random() < 0.25) { const g = 10 + Math.floor(Math.random() * 31); c.gold += g; reward.lootGold = g; }
      if (Math.random() < uniqueChance(m.pity)) { const pool = Object.keys(ARENA_ITEMS).filter((id) => ARENA_ITEMS[id].unique && c.items.indexOf(id) < 0);
        if (pool.length) { const id = pool[Math.floor(Math.random() * pool.length)]; c.items.push(id); c.equipped[ARENA_ITEMS[id].slot] = id; reward.loot = id; m.pity = 0; } else { c.gold += 50; reward.lootGold = (reward.lootGold || 0) + 50; } }
      else m.pity++;
      reward.pity = m.pity; reward.pityAt = PITY_AT;
    }
    // PERSONAL BESTS: kills and damage from the report, life / blow / streak from the client's own ledger
    { const B = p.bests || {}, cand = { kills: p.kills, dmg: p.dmg, life: B.life, blow: B.blow, streak: B.streak }, beat = [];
      for (const [k, , cap] of ARENA_BESTS) { const v = Math.round(clamp(+cand[k] || 0, 0, cap)), was = m.bests[k] | 0; if (v > was) { m.bests[k] = v; beat.push({ k, v, was }); } }
      if (beat.length) reward.bests = beat; }
    // THE RIVAL: the vale's man who felled you is named, and waits in your next pit; beat him (win a fight he stood in) and the purse is heavier
    { const rv = m.rival, inPit = rv && npcs.some((n) => n.name === rv.name);
      if (inPit && won) { const bn = rivalBonus(rv); c.xp += bn.xp; c.gold += bn.gold; m.rivalsBeaten = (m.rivalsBeaten | 0) + 1; reward.rival = { name: rv.name, beaten: true, xp: bn.xp, gold: bn.gold, times: rv.times | 0 }; m.rival = null; }
      else if (!won && p.killedBy && p.killedBy.kind === 'npc' && typeof p.killedBy.name === 'string') { const n = npcs.find((x) => x.name === p.killedBy.name);
        if (n) { const same = rv && rv.name === n.name; m.rival = { name: n.name, arch: n.arch, skill: n.skill | 0, times: same ? (rv.times | 0) + 1 : 1, since: same ? rv.since : Math.floor(Date.now() / 1000) }; reward.rival = { name: n.name, beaten: false, times: m.rival.times }; } }
      else if (inPit && !won && rv) { rv.times = (rv.times | 0) + 1; reward.rival = { name: rv.name, beaten: false, times: rv.times }; } }   // he stood there and you lost again
    // THE BOUT OF THE DAY: the board keeps your best try
    if (daily) { const sc = dailyScore(p, won, draw), old = await q(db, 'SELECT score, tries FROM arena_daily WHERE day=? AND fighter=?', daily, a.handle).first();
      const top = (await q(db, 'SELECT MAX(score) AS s FROM arena_daily WHERE day=? AND fighter<>?', daily, a.handle).first() || {}).s | 0;
      const best = Math.max(sc, old ? old.score | 0 : 0);
      writes.push(q(db, `INSERT INTO arena_daily(day, fighter, score, kills, dmg, alive, won, tries) VALUES (?,?,?,?,?,?,?,1)
        ON CONFLICT(day, fighter) DO UPDATE SET tries=tries+1, updated_at=unixepoch(), score=CASE WHEN excluded.score>score THEN excluded.score ELSE score END, kills=CASE WHEN excluded.score>score THEN excluded.kills ELSE kills END, dmg=CASE WHEN excluded.score>score THEN excluded.dmg ELSE dmg END, alive=CASE WHEN excluded.score>score THEN excluded.alive ELSE alive END, won=CASE WHEN excluded.score>score THEN excluded.won ELSE won END`,
        daily, a.handle, sc, clamp(p.kills | 0, 0, 500), Math.round(clamp(+p.dmg || 0, 0, 1e5)), p.alive ? 1 : 0, won ? 1 : 0));
      if (!old) m.dailies = (m.dailies | 0) + 1;
      const topped = best > top && !(old && (old.score | 0) > top); if (topped) m.dailyTops = (m.dailyTops | 0) + 1;
      reward.daily = { day: daily, score: sc, best, tries: old ? (old.tries | 0) + 1 : 1, top: topped, toBeat: best > top ? 0 : top - best + 1 }; }
    // THE LADDER: whom you passed, and the champion's belt (the player with the most renown holds it; pass him and it is yours)
    const renownAfter = renownOf(c);
    if (renownAfter > renownBefore) { const passed = (await q(db, 'SELECT a.handle, COUNT(*) OVER () AS n FROM arena_careers c JOIN accounts a ON a.id=c.account_id WHERE c.matches>0 AND a.id<>? AND c.renown>=? AND c.renown<? ORDER BY c.renown DESC LIMIT 1', a.id, renownBefore, renownAfter).first());
      if (passed) reward.passed = { name: passed.handle, n: passed.n | 0 }; }
    if (won && (!beltHolder || (beltHolder !== a.handle && renownAfter > beltRenown))) {   // (taken on a win only — a loss never crowns anyone) reward.belt = { taken: beltHolder || null, defenses: 0 }; m.belts = (m.belts | 0) + 1; beltHolder = a.handle; beltRenown = renownAfter;
      writes.push(q(db, 'INSERT INTO arena_belt(id, holder, renown, since, defenses) VALUES (1,?,?,unixepoch(),0) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, renown=excluded.renown, since=excluded.since, defenses=0', a.handle, renownAfter)); }
    else if (beltHolder === a.handle) { const d = (belt.defenses | 0) + (won ? 1 : 0); beltRenown = renownAfter; reward.belt = { held: true, defenses: d, since: belt.since }; writes.push(q(db, 'UPDATE arena_belt SET renown=?, defenses=? WHERE id=1', renownAfter, d)); }
    const after = rankOf(c.xp); if (after > before) reward.rankUp = ARENA_RANKS[after][0];
    const earned = []; for (const [id, label, stat, at] of ARENA_ACHIEVEMENTS) if (statOf(c, stat) >= at && c.achievements.indexOf(id) < 0) { c.achievements.push(id); earned.push(label); }
    if (earned.length) reward.achievements = earned;
    reward.position = (await position(db, 'player', renownAfter, c.matches)).position; reward.renown = renownAfter;
    c.lastSeed = seed; c.lastReward = reward; rewards[p.handle] = reward;
    writes.push(saveStmt(db, a.id, c), q(db, 'INSERT OR IGNORE INTO arena_results(seed, account_id) VALUES (?,?)', seed, a.id), bout('player', a.handle, p, won, draw));
  }
  if (writes.length) await db.batch(writes);
  await applyNpcs(db, seed, winner, npcs, done, bout);
  return { ok: true, rewards };
}
const boutStmt = (db, seed, venue, size) => (kind, name, p, won, draw) => q(db, 'INSERT OR IGNORE INTO arena_bouts(seed, kind, fighter, team, won, draw, kills, dmg, alive, star, venue, size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  seed, kind, name, p.team | 0, won ? 1 : 0, draw ? 1 : 0, clamp(p.kills | 0, 0, 500), Math.round(clamp(+p.dmg || 0, 0, 1e5)), p.alive ? 1 : 0, p.star ? 1 : 0, venue, size);
// THE VALE'S MEN FIGHT AMONG THEMSELVES: the cron (wrangler.jsonc triggers, every 15 min) stages a bout or two with no
// player in it — arena-sim.js rolls the roster (known men first, so records carry on) and the outcome, and it is paid
// through applyNpcs like a reported fight. So the ladder of the vale's men lives whether anyone is online or not.
async function simulateRound(db, n) {
  const known = (await q(db, 'SELECT name, arch, skill FROM npc_careers ORDER BY updated_at DESC LIMIT 200').all()).results, out = [];
  for (let i = 0; i < n; i++) {
    const f = SIM.simulateFight('sim-' + Date.now() + '-' + i + '-' + randomHex(3), known);
    await applyNpcs(db, f.seed, f.winner, f.npcs, new Set(), boutStmt(db, f.seed, f.venue, f.size));
    out.push({ seed: f.seed, venue: f.venue, teams: f.teams, per: f.per, winner: f.winner, star: (f.npcs.find((m) => m.star) || {}).name });
  }
  return out;
}
// the NPCs' side of the payout: XP as a player would earn (no gold — they have no purse), the record, the
// archetype tally. Idempotent through arena_bouts; written in chunks of 40 men (D1 batches are not unbounded).
const NPC_ARCHS = new Set(['swordsman', 'brute', 'duelist', 'guardsman', 'archer', 'rider']);
const NPC_BLANK = { arch: 'swordsman', archs_json: '{}', skill: 50, xp: 0, matches: 0, wins: 0, kills: 0, deaths: 0, damage: 0, stars: 0 };
async function applyNpcs(db, seed, winner, npcs, done, bout) {
  const names = [...new Set(npcs.map((n) => n.name))].filter((n) => !done.has('npc|' + n)); if (!names.length) return;
  const rows = new Map();
  for (let i = 0; i < names.length; i += 50) { const chunk = names.slice(i, i + 50); for (const r of (await q(db, `SELECT * FROM npc_careers WHERE name IN (${chunk.map(() => '?').join(',')})`, ...chunk).all()).results) rows.set(r.name, r); }
  const seen = new Set(), writes = [];
  for (const n of npcs) {
    if (seen.has(n.name) || done.has('npc|' + n.name)) continue; seen.add(n.name);
    const r = rows.get(n.name) || NPC_BLANK, won = (n.team | 0) === winner, draw = winner < 0, rw = rewardFor(n, won, draw);
    const c = { xp: r.xp + rw.xp, matches: r.matches + 1, wins: r.wins + (won ? 1 : 0), kills: r.kills + clamp(n.kills | 0, 0, 500), deaths: r.deaths + (n.alive ? 0 : 1), damage: r.damage + Math.round(clamp(+n.dmg || 0, 0, 1e5)), stars: r.stars + (n.star ? 1 : 0) };
    const arch = NPC_ARCHS.has(n.arch) ? n.arch : 'swordsman'; let archs = {}; try { archs = JSON.parse(r.archs_json || '{}'); } catch (e) {} archs[arch] = (archs[arch] | 0) + 1;
    writes.push(q(db, `INSERT INTO npc_careers(name, arch, archs_json, skill, xp, matches, wins, kills, deaths, damage, stars, renown) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET arch=excluded.arch, archs_json=excluded.archs_json, skill=excluded.skill, xp=excluded.xp, matches=excluded.matches, wins=excluded.wins, kills=excluded.kills, deaths=excluded.deaths, damage=excluded.damage, stars=excluded.stars, renown=excluded.renown, updated_at=unixepoch()`,
      n.name, arch, JSON.stringify(archs), clamp(n.skill | 0, 0, 100), c.xp, c.matches, c.wins, c.kills, c.deaths, c.damage, c.stars, renownOf(c)), bout('npc', n.name, n, won, draw));
  }
  for (let i = 0; i < writes.length; i += 80) await db.batch(writes.slice(i, i + 80));
}

// THE BOUT OF THE DAY: a fight reported as one carries daily: 'YYYY-MM-DD' and a seed of the form d<day>-<try>; only
// today's (or yesterday's, for a fight that ran over midnight) counts. GET /arena/daily is the bout and its board.
function dailyDayOf(day, seed) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !String(seed).startsWith('d' + day + '-')) return null;
  const today = dayKey(), yest = dayKey(new Date(Date.now() - 86400e3)); return day === today || day === yest ? day : null;
}
async function dailyBoard(db, me) {
  const day = dayKey(), spec = dailyOf(day);
  const rows = (await q(db, 'SELECT fighter AS name, score, kills, dmg, alive, won, tries, updated_at FROM arena_daily WHERE day=? ORDER BY score DESC, updated_at ASC LIMIT 10', day).all()).results;
  rows.forEach((r, i) => { r.pos = i + 1; });
  const total = (await q(db, 'SELECT COUNT(*) AS n FROM arena_daily WHERE day=?', day).first()).n;
  let mine = null; if (me) { const r = await q(db, 'SELECT score, kills, dmg, alive, won, tries FROM arena_daily WHERE day=? AND fighter=?', day, me).first(); if (r) { r.pos = (await q(db, 'SELECT COUNT(*) AS n FROM arena_daily WHERE day=? AND score>?', day, r.score).first()).n + 1; mine = r; } }
  const endsIn = Math.max(0, Math.floor((Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1) - Date.now()) / 1000));
  return { ok: true, day, spec, board: rows, total, mine, endsIn };
}

// ---------- profiles + the ladder ----------
// Every fighter has a page: a player's from arena_careers (public parts only — no gold, no inventory), one of the
// vale's men from npc_careers. The ladder is per kind — players rank among players, the vale's men among
// themselves (they stand in every pit, so one list would be all NPCs) — sorted by renown (renownOf, arena-items.js).
// scope=network narrows it to everyone who has shared a pit with you (arena_bouts).
const npcTier = (skill) => skill >= 82 ? 'champion' : skill >= 60 ? 'veteran' : skill >= 35 ? 'soldier' : 'recruit';
const LADDER = {
  player: { from: 'FROM arena_careers c JOIN accounts a ON a.id=c.account_id', name: 'a.handle', cols: "a.handle AS name, 'player' AS kind, c.renown, c.xp, c.matches, c.wins, c.stars, c.kills, c.trophies", table: 'arena_careers' },
  npc: { from: 'FROM npc_careers c', name: 'c.name', cols: "c.name, 'npc' AS kind, c.renown, c.xp, c.matches, c.wins, c.stars, c.kills, c.arch, c.skill", table: 'npc_careers' },
};
const ladderTitle = (r) => r.kind === 'player' ? rankInfo(r.xp).name : npcTier(r.skill) + ' ' + r.arch;
async function rankings(db, o) {
  const kind = o.kind === 'npc' ? 'npc' : 'player', L = LADDER[kind], scope = o.scope === 'network' ? 'network' : 'global';
  const lim = clamp(parseInt(o.limit, 10) || 50, 1, 200), off = Math.max(0, parseInt(o.offset, 10) || 0);
  let where = 'WHERE c.matches > 0'; const args = [];
  if (scope === 'network') {
    if (!o.me) return { ok: false, error: 'sign in to see your network' };
    where += ` AND ${L.name} IN (SELECT fighter FROM arena_bouts WHERE kind=? AND seed IN (SELECT seed FROM arena_bouts WHERE kind='player' AND fighter=?))`; args.push(kind, o.me);
  }
  const total = (await q(db, `SELECT COUNT(*) AS n ${L.from} ${where}`, ...args).first()).n;
  const rows = (await q(db, `SELECT ${L.cols} ${L.from} ${where} ORDER BY c.renown DESC, c.wins DESC, name ASC LIMIT ? OFFSET ?`, ...args, lim, off).all()).results;
  rows.forEach((r, i) => { r.pos = off + i + 1; r.title = ladderTitle(r); });
  const belt = kind === 'player' ? await beltRow(db) : null; if (belt && belt.holder) for (const r of rows) if (r.name === belt.holder) r.belt = { since: belt.since, defenses: belt.defenses };
  return { ok: true, kind, scope, total, rows, belt: belt && belt.holder ? belt : null };
}
async function position(db, kind, renown, matches) {
  const t = LADDER[kind].table, of = (await q(db, `SELECT COUNT(*) AS n FROM ${t} WHERE matches > 0`).first()).n;
  if (!(matches > 0)) return { position: null, of };
  return { position: (await q(db, `SELECT COUNT(*) AS n FROM ${t} WHERE matches > 0 AND renown > ?`, renown).first()).n + 1, of };
}
async function profile(db, name, kind) {
  name = String(name || '').trim().slice(0, 64); if (!name) return { ok: false, error: 'who?' };
  let p = null;
  if (kind !== 'npc') {
    const a = await q(db, 'SELECT id, handle, created_at FROM accounts WHERE handle=? COLLATE NOCASE', name).first();
    if (a) { const c = parse((await q(db, 'SELECT * FROM arena_careers WHERE account_id=?', a.id).first()) || BLANK_ROW);
      const skills = {}; for (const k of ['sword', 'bow', 'riding']) skills[k] = { level: skillLevel(c.skills[k]) };
      p = { name: a.handle, kind: 'player', rank: rankInfo(c.xp), title: rankInfo(c.xp).name, xp: c.xp, matches: c.matches, wins: c.wins, losses: Math.max(0, c.matches - c.wins), kills: c.kills, deaths: c.deaths, damage: c.damage, stars: c.stars, trophies: c.trophies,
        skills, achievements: c.achievements, equipped: c.equipped, look: c.meta.look || null, renown: renownOf(c), since: a.created_at, bests: c.meta.bests || {}, rivalsBeaten: c.meta.rivalsBeaten | 0, dailyTops: c.meta.dailyTops | 0 };
      const belt = await beltRow(db); if (belt.holder === a.handle) p.belt = { since: belt.since, defenses: belt.defenses }; }
  }
  if (!p && kind !== 'player') {
    const r = await q(db, 'SELECT * FROM npc_careers WHERE name=? COLLATE NOCASE', name).first();
    if (r) { let archs = {}; try { archs = JSON.parse(r.archs_json || '{}'); } catch (e) {}
      p = { name: r.name, kind: 'npc', arch: r.arch, archs, skill: r.skill, tier: npcTier(r.skill), title: npcTier(r.skill) + ' ' + r.arch, xp: r.xp, matches: r.matches, wins: r.wins, losses: Math.max(0, r.matches - r.wins), kills: r.kills, deaths: r.deaths, damage: r.damage, stars: r.stars, renown: r.renown, since: r.created_at, lastFought: r.updated_at }; }
  }
  if (!p) return { ok: false, error: 'no fighter of that name has stood in the pit' };
  Object.assign(p, await position(db, p.kind, p.renown, p.matches));
  p.recent = (await q(db, 'SELECT seed, team, won, draw, kills, dmg, alive, star, venue, size, created_at FROM arena_bouts WHERE kind=? AND fighter=? ORDER BY created_at DESC LIMIT 10', p.kind, p.name).all()).results;
  return { ok: true, profile: p };
}

// ---------- the HTTP API ----------
const FLAGS = { modeXfadeSpeed: 0.6 };
async function api(request, env, url) {
  const db = env.DB, p = url.pathname, method = request.method;
  if (method === 'GET' && p === '/api/v1/health') return json(200, { ok: true, ts: Date.now() });
  if (method === 'GET' && p === '/api/v1/config') return json(200, { ok: true, flags: FLAGS });
  if (method === 'POST' && p === '/api/v1/auth/register') { const b = await readBody(request); const r = await register(db, b.username, b.password); return json(r.ok ? 200 : 400, r); }
  if (method === 'POST' && p === '/api/v1/auth/login') { const b = await readBody(request); const r = await login(db, b.username, b.password); return json(r.ok ? 200 : 401, r); }

  // the auth seam: a session token wins; a bare handle is refused once that name has a password
  const token = request.headers.get('x-player-token') || 'local';
  let acct = await resolveSession(db, token);
  if (!acct) { if (await handleLocked(db, token)) return json(401, { error: 'that name is password-protected — sign in' }); acct = await ensureAccount(db, token); }

  if (method === 'GET' && p === '/api/v1/profile') {
    const w = await ensureWorldFor(db, acct);
    const saved = await q(db, 'SELECT payload FROM careers WHERE account_id=?', acct.id).first();
    let player = null, warband = []; if (saved) { try { const c = JSON.parse(saved.payload); player = c.player || null; warband = c.warband || []; } catch (e) {} }
    return json(200, { account: { id: acct.id, handle: acct.handle }, world: { id: w.id, seed: w.seed, mapLevel: w.map_level }, player, warband });
  }
  if (method === 'POST' && p === '/api/v1/careers') {
    const body = await readBody(request);
    await q(db, 'INSERT INTO careers(account_id, payload) VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload, updated_at=unixepoch()', acct.id, JSON.stringify({ player: body.player || null, warband: body.warband || [] })).run();
    return json(200, { ok: true, savedAt: Date.now() });
  }
  if (method === 'POST' && p === '/api/v1/deeds') return json(200, { ok: true });

  if (p.startsWith('/api/v1/arena/')) {
    // public reads: anyone may visit a profile or read the ladder (the network scope needs a signed-in reader)
    if (method === 'GET' && p === '/api/v1/arena/profile') return json(200, await profile(db, url.searchParams.get('name'), url.searchParams.get('kind')));
    if (method === 'GET' && p === '/api/v1/arena/rankings') return json(200, await rankings(db, { scope: url.searchParams.get('scope'), kind: url.searchParams.get('kind'), limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset'), me: acct.pass_hash ? acct.handle : null }));
    if (method === 'GET' && p === '/api/v1/arena/daily') return json(200, await dailyBoard(db, acct.pass_hash ? acct.handle : null));
    if (!acct.pass_hash) return json(401, { ok: false, error: 'sign in to keep an arena career' });
    if (method === 'GET' && p === '/api/v1/arena/career') return json(200, { ok: true, career: await career(db, acct.id, url.searchParams.get('seed')) });
    if (method === 'POST' && p === '/api/v1/arena/buy') { const b = await readBody(request); return json(200, await buy(db, acct.id, String(b.item || ''))); }
    if (method === 'POST' && p === '/api/v1/arena/equip') { const b = await readBody(request); return json(200, await equip(db, acct.id, String(b.slot || ''), b.item == null ? null : String(b.item))); }
    if (method === 'POST' && p === '/api/v1/arena/look') { const b = await readBody(request); return json(200, await setLook(db, acct.id, b)); }
    if (method === 'POST' && p === '/api/v1/arena/result') { const b = await readBody(request); return json(200, await applyResult(db, acct, b)); }
    return json(404, { ok: false, error: 'no such arena call' });
  }
  return json(404, { error: 'not found' });   // the living world (/world, /chunks, /holdings …) does not run here
}

// ---------- the co-op relay (server/ws.js) as one Durable Object ----------
// Every player online shares this object (who / invite need the whole roster), with the WebSocket
// Hibernation API so an idle lobby costs nothing. Per-socket state rides in the socket's attachment;
// the rooms live in storage so a wake-up finds them; a 10 s alarm is the heartbeat.
const GRACE_MS = 25000, BEAT_MS = 10000;
const RELAY_SAVES = new Set(['hello', 'host', 'beacon', 'join', 'leave']);
const RELAY_HINT = 'eeur', RELAY_NAME = 'lobby-' + RELAY_HINT;   // change the hint → a fresh object is created where the hint says (see /coop below)   // the message types that change rooms / nextId (hello: a resume adopts a seat)
export class Relay {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.rooms = {}; this.nextId = 1;
    ctx.blockConcurrencyWhile(async () => { this.rooms = (await ctx.storage.get('rooms')) || {}; this.nextId = (await ctx.storage.get('nextId')) || 1; });
  }
  save() { return Promise.all([this.ctx.storage.put('rooms', this.rooms), this.ctx.storage.put('nextId', this.nextId)]); }
  // socket helpers — the attachment is the conn record {id, world, name, acct, room, hello}
  st(ws) { return ws.deserializeAttachment() || {}; }
  set(ws, patch) { const s = Object.assign(this.st(ws), patch); ws.serializeAttachment(s); return s; }
  conns() { const m = new Map(); for (const ws of this.ctx.getWebSockets()) { const s = this.st(ws); if (s.id && !s.superseded) m.set(s.id, { ws, s }); } return m; }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  sendTo(conns, id, obj) { const c = conns.get(id); if (c) this.send(c.ws, obj); }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('coop relay', { status: 200 });
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: this.nextId++, world: 'default', name: 'Ally', acct: '', room: null, hello: false });
    await this.save();
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + BEAT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }
  async alarm() {
    const conns = this.conns(), now = Date.now();
    for (const [, c] of conns) this.send(c.ws, { t: 'beat' });
    this.expireAway(conns, now);
    await this.save();
    if (conns.size || Object.keys(this.rooms).length) await this.ctx.storage.setAlarm(now + BEAT_MS);
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const conns = this.conns(), s = this.st(ws), conn = { ws, s };
    switch (m.t) {
      case 'hello':
        this.set(ws, { world: String(m.world || 'default'), name: String(m.name || 'Ally').slice(0, 40), acct: String(m.acct || '').slice(0, 40), hello: true });
        this.send(ws, { t: 'hello-ok', id: s.id });
        conn.s = this.st(ws);                                   // (the record read above predates the name/acct just set)
        if (m.resume && !conn.s.room) this.resume(conns, conn, String(m.resume));
        break;
      case 'who': {
        const list = []; for (const [id, c] of conns) if (id !== s.id && c.s.hello) list.push({ id, name: c.s.acct || c.s.name, busy: !!c.s.room });
        this.send(ws, { t: 'who', list }); break;
      }
      case 'invite': {
        const to = String(m.to || '').slice(0, 40); if (!to || !s.room) break;
        let sent = 0;
        for (const [id, c] of conns) { if (id === s.id || !c.s.hello) continue; if (c.s.acct === to || (!c.s.acct && c.s.name === to)) { this.send(c.ws, { t: 'invite', from: s.id, name: s.acct || s.name, room: s.room, cfg: m.cfg || {} }); sent++; } }
        if (!sent) this.send(ws, { t: 'invite-fail', to });
        break;
      }
      case 'dm': this.sendTo(conns, m.to | 0, { t: 'msg', from: s.id, data: m.data, dm: true }); break;
      case 'host': {
        this.leaveRoom(conns, conn);
        const room = String(m.room || ('r' + s.id + '_' + (this.nextId++)));
        this.rooms[room] = { hostId: s.id, beacon: m.beacon || {}, members: [s.id], world: s.world, away: {} };
        this.set(ws, { room }); this.send(ws, { t: 'hosting', room }); break;
      }
      case 'beacon': { const r = this.rooms[s.room]; if (r && r.hostId === s.id && m.beacon) r.beacon = m.beacon; break; }
      case 'list': {
        const list = []; for (const room in this.rooms) { const r = this.rooms[room]; if (r.world === s.world && r.hostId !== s.id) list.push({ room, beacon: r.beacon, players: r.members.length }); }
        this.send(ws, { t: 'beacons', list }); break;
      }
      case 'join': {
        const room = String(m.room), r = this.rooms[room]; if (!r) { this.send(ws, { t: 'join-fail', room: m.room }); break; }
        this.leaveRoom(conns, conn);
        if (r.members.indexOf(s.id) < 0) r.members.push(s.id); this.set(ws, { room });
        this.send(ws, { t: 'joined', room, beacon: r.beacon });
        this.sendTo(conns, r.hostId, { t: 'peer-join', room, id: s.id, name: s.name }); break;
      }
      case 'leave': this.leaveRoom(conns, conn); this.send(ws, { t: 'left' }); break;
      case 'msg': {
        const r = this.rooms[s.room]; if (!r) break;
        for (const mid of r.members) { if (mid === s.id) continue; if (m.to && mid !== m.to) continue; this.sendTo(conns, mid, { t: 'msg', from: s.id, data: m.data }); }
        break;
      }
    }
    // Persist only when the rooms changed. A fight relays 40 messages a second (the host's 20 Hz snapshots, each guest's
    // 20 Hz inputs) and none of them touch the rooms — but saving after every one queued a durable write per message,
    // and the output gate held every relayed snapshot behind it: that was the guests' lag on bladevale.com (2026-09-13).
    if (RELAY_SAVES.has(m.t)) await this.save();
  }
  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }
  async gone(ws) {
    const s = this.st(ws); if (s.superseded) return;
    this.set(ws, { superseded: true });                       // out of the roster at once; the seat is held below
    this.dropConn(this.conns(), s);
    await this.save();
  }
  // the socket died (not an explicit leave): hold the seat for GRACE_MS instead of giving it away
  dropConn(conns, s) {
    const r = s.room && this.rooms[s.room]; if (!r) return;
    const wasHost = r.hostId === s.id;
    r.away[s.id] = { acct: s.acct, name: s.name, at: Date.now(), wasHost };
    if (wasHost) { for (const mid of r.members) if (mid !== s.id) this.sendTo(conns, mid, { t: 'host-away', room: s.room }); }
    else this.sendTo(conns, r.hostId, { t: 'peer-away', room: s.room, id: s.id, name: s.name });
  }
  expireAway(conns, now) {
    for (const room in this.rooms) {
      const r = this.rooms[room];
      for (const oidKey in r.away) {
        const a = r.away[oidKey], oid = +oidKey; if (now - a.at < GRACE_MS) continue;
        delete r.away[oidKey]; r.members = r.members.filter((x) => x !== oid);
        if (a.wasHost) { for (const mid of r.members) { const c = conns.get(mid); if (c) { this.send(c.ws, { t: 'host-gone', room }); this.set(c.ws, { room: null }); } } delete this.rooms[room]; break; }
        this.sendTo(conns, r.hostId, { t: 'peer-leave', room, id: oid });
        if (!r.members.length) delete this.rooms[room];
      }
    }
  }
  adopt(conns, r, room, oldId, conn, wasHost) {
    const s = conn.s;
    r.members = r.members.filter((x) => x !== oldId); if (r.members.indexOf(s.id) < 0) r.members.push(s.id); delete r.away[oldId];
    if (wasHost) r.hostId = s.id;
    this.set(conn.ws, { room });
    const peers = []; if (wasHost) for (const mid of r.members) { if (mid === s.id) continue; const c = conns.get(mid); if (c) peers.push({ id: mid, name: c.s.name }); }
    this.send(conn.ws, { t: 'resumed', room, isHost: wasHost, oldId, beacon: r.beacon, peers });
    if (wasHost) { for (const mid of r.members) if (mid !== s.id) this.sendTo(conns, mid, { t: 'host-back', room }); }
    else this.sendTo(conns, r.hostId, { t: 'peer-rejoin', room, oldId, id: s.id, name: s.name });
  }
  resume(conns, conn, room) {
    const r = this.rooms[room]; if (!r) { this.send(conn.ws, { t: 'resume-fail', room }); return; }
    const me = this.st(conn.ws), same = (a, n) => (me.acct && a === me.acct) || (!me.acct && n === me.name);
    for (const oid in r.away) { const a = r.away[oid]; if (same(a.acct, a.name)) { this.adopt(conns, r, room, +oid, conn, a.wasHost); return; } }
    for (const mid of r.members) {                            // the old socket is still listed: supersede it
      const c = conns.get(mid); if (!c || c.ws === conn.ws || !same(c.s.acct, c.s.name)) continue;
      const wasHost = r.hostId === mid;
      this.set(c.ws, { superseded: true }); this.send(c.ws, { t: 'superseded' }); try { c.ws.close(1000, 'superseded'); } catch (e) {}
      this.adopt(conns, r, room, mid, conn, wasHost); return;
    }
    this.send(conn.ws, { t: 'resume-fail', room });
  }
  leaveRoom(conns, conn) {
    const s = conn.s, room = s.room, r = room && this.rooms[room]; if (!r) { this.set(conn.ws, { room: null }); return; }
    r.members = r.members.filter((x) => x !== s.id);
    if (s.id === r.hostId) {
      for (const mid of r.members) { const c = conns.get(mid); if (c) { this.send(c.ws, { t: 'host-gone', room }); this.set(c.ws, { room: null }); } }
      delete this.rooms[room];
    } else {
      this.sendTo(conns, r.hostId, { t: 'peer-leave', room, id: s.id });
      if (!r.members.length) delete this.rooms[room];
    }
    this.set(conn.ws, { room: null });
  }
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(simulateRound(env.DB, 1 + (Math.random() < 0.5 ? 1 : 0))); },
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    // The relay lives in ONE Durable Object, and every snapshot of every fight passes through it — so where it runs is
    // the players' ping. The players are in Eastern Europe / the Middle East (2026-09-13), so the hint asks for `eeur`.
    // A hint only counts when the object is CREATED: the original 'lobby' object was born wherever the first request
    // came from, so the name changes with the hint (the rooms it held are transient — nothing to migrate).
    if (p === '/coop') return env.RELAY.get(env.RELAY.idFromName(RELAY_NAME), { locationHint: RELAY_HINT }).fetch(request);
    if (p.startsWith('/api/')) { try { return await api(request, env, url); } catch (e) { return json(500, { error: String((e && e.message) || e) }); } }
    return env.ASSETS.fetch(request);
  },
};
