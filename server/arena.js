// Blade Vale — the ARENA CAREER: XP + gold from every match, ranks, the marketplace, use-skills,
// trophies, achievements, PvP purse and loot. The host reports a finished match ONCE (POST /arena/result)
// and the server pays every player named in it; each player's client then reads its own career.
const { db } = require('./db');
const { ARENA_RANKS, ARENA_ITEMS, ARENA_SLOTS, ARENA_ACHIEVEMENTS: ACHIEVEMENTS, skillLevel, rankOf, rankInfo, lockReason } = require('../arena-items');

const PVP_CUT = 0.08, PVP_CAP = 60;                       // a beaten player pays 8% of his purse (at most 60) to the winners

// (statements are prepared on first use — index.js runs the migrations after this module loads)
const _st = {}; const Q = (k, sql) => _st[k] || (_st[k] = db.prepare(sql));
function row(acctId) { const get = Q('get', 'SELECT * FROM arena_careers WHERE account_id=?'); let r = get.get(acctId); if (!r) { Q('ins', 'INSERT OR IGNORE INTO arena_careers(account_id) VALUES (?)').run(acctId); r = get.get(acctId); } return r; }
function parse(r) {
  return { xp: r.xp, gold: r.gold, trophies: r.trophies, matches: r.matches, wins: r.wins, kills: r.kills, deaths: r.deaths, damage: r.damage, stars: r.stars,
    items: JSON.parse(r.items_json || '[]'), equipped: JSON.parse(r.equipped_json || '{}'), skills: JSON.parse(r.skills_json || '{}'), achievements: JSON.parse(r.achievements_json || '[]'),
    lastSeed: r.last_seed || null, lastReward: r.last_reward_json ? JSON.parse(r.last_reward_json) : null };
}
const SAVE_SQL = `UPDATE arena_careers SET xp=@xp, gold=@gold, trophies=@trophies, matches=@matches, wins=@wins, kills=@kills, deaths=@deaths, damage=@damage, stars=@stars,
  items_json=@items, equipped_json=@equipped, skills_json=@skills, achievements_json=@achievements, last_seed=@lastSeed, last_reward_json=@lastReward, updated_at=unixepoch() WHERE account_id=@id`;
function write(acctId, c) {
  Q('save', SAVE_SQL).run({ id: acctId, xp: c.xp | 0, gold: c.gold | 0, trophies: c.trophies | 0, matches: c.matches | 0, wins: c.wins | 0, kills: c.kills | 0, deaths: c.deaths | 0, damage: c.damage | 0, stars: c.stars | 0,
    items: JSON.stringify(c.items), equipped: JSON.stringify(c.equipped), skills: JSON.stringify(c.skills), achievements: JSON.stringify(c.achievements), lastSeed: c.lastSeed, lastReward: c.lastReward ? JSON.stringify(c.lastReward) : null });
}
// what the client sees
function view(c, seed) {
  const skills = {}; for (const k of ['sword', 'bow', 'riding']) skills[k] = { count: c.skills[k] | 0, level: skillLevel(c.skills[k]) };
  return { xp: c.xp, gold: c.gold, trophies: c.trophies, matches: c.matches, wins: c.wins, kills: c.kills, deaths: c.deaths, damage: c.damage, stars: c.stars,
    items: c.items, equipped: c.equipped, skills, achievements: c.achievements, rank: rankInfo(c.xp), lastSeed: c.lastSeed, lastReward: (!seed || c.lastSeed === String(seed)) ? c.lastReward : null };
}
function career(acctId, seed) { return view(parse(row(acctId)), seed); }

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
  const rewards = {};
  db.transaction(() => {
    const accts = new Map(); for (const p of players) { const a = findAcct.get(String(p.handle || '')); if (a && !paid.get(seed, a.id)) accts.set(p.handle, a); }
    const cs = new Map(); for (const [h, a] of accts) cs.set(h, parse(row(a.id)));
    // the PvP purse: real players who lost to real players pay a cut, split among the winning players
    const teams = new Set(players.map(p => p.team | 0)), winners = players.filter(p => (p.team | 0) === winner && accts.has(p.handle)), losers = players.filter(p => (p.team | 0) !== winner && accts.has(p.handle));
    let pot = 0; const pvp = winner >= 0 && teams.size >= 2 && winners.length && losers.length; const paidCut = {};
    if (pvp) for (const p of losers) { const c = cs.get(p.handle), cut = Math.min(PVP_CAP, Math.floor(c.gold * PVP_CUT)); c.gold -= cut; pot += cut; paidCut[p.handle] = cut; }
    for (const p of players) {
      const a = accts.get(p.handle); if (!a) continue; const c = cs.get(p.handle), won = (p.team | 0) === winner, draw = winner < 0;
      const r = rewardFor(p, won, draw), before = rankOf(c.xp);
      c.xp += r.xp; c.gold += r.gold; c.trophies += r.trophies; c.matches++; if (won) c.wins++; c.kills += clamp(p.kills | 0, 0, 500); if (!p.alive) c.deaths++; c.damage += Math.round(clamp(+p.dmg || 0, 0, 1e5)); if (p.star) c.stars++;
      const sk = p.skills || {}; for (const k of ['sword', 'bow', 'riding']) c.skills[k] = (c.skills[k] | 0) + clamp(sk[k] | 0, 0, 200);
      const reward = Object.assign({ seed, won, draw, star: !!p.star }, r);
      if (pvp && won) { const share = Math.floor(pot / winners.length); c.gold += share; reward.purse = share; }
      if (pvp && !won) reward.purse = -(paidCut[p.handle] || 0);
      if (won) {                                               // LOOT: the odd purse, and rarely a unique — a look, not a stat
        if (Math.random() < 0.25) { const g = 10 + Math.floor(Math.random() * 31); c.gold += g; reward.lootGold = g; }
        if (Math.random() < 0.05) { const pool = Object.keys(ARENA_ITEMS).filter(id => ARENA_ITEMS[id].unique && c.items.indexOf(id) < 0);
          if (pool.length) { const id = pool[Math.floor(Math.random() * pool.length)]; c.items.push(id); c.equipped[ARENA_ITEMS[id].slot] = id; reward.loot = id; } else { c.gold += 50; reward.lootGold = (reward.lootGold || 0) + 50; } }
      }
      const after = rankOf(c.xp); if (after > before) reward.rankUp = ARENA_RANKS[after][0];
      const earned = []; for (const [id, label, stat, at] of ACHIEVEMENTS) if (c[stat] >= at && c.achievements.indexOf(id) < 0) { c.achievements.push(id); earned.push(label); }
      if (earned.length) reward.achievements = earned;
      c.lastSeed = seed; c.lastReward = reward; write(a.id, c); markPaid.run(seed, a.id); rewards[p.handle] = reward;
    }
  })();
  return { ok: true, rewards };
}
module.exports = { career, buy, equip, applyResult, ACHIEVEMENTS };
