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
const { ARENA_RANKS, ARENA_ITEMS, ARENA_SLOTS, ARENA_ACHIEVEMENTS, skillLevel, rankOf, rankInfo, lockReason } = ARENA;

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
    lastSeed: r.last_seed || null, lastReward: r.last_reward_json ? JSON.parse(r.last_reward_json) : null };
}
const SAVE_SQL = `UPDATE arena_careers SET xp=?, gold=?, trophies=?, matches=?, wins=?, kills=?, deaths=?, damage=?, stars=?,
  items_json=?, equipped_json=?, skills_json=?, achievements_json=?, last_seed=?, last_reward_json=?, updated_at=unixepoch() WHERE account_id=?`;
function saveStmt(db, acctId, c) {
  return q(db, SAVE_SQL, c.xp | 0, c.gold | 0, c.trophies | 0, c.matches | 0, c.wins | 0, c.kills | 0, c.deaths | 0, c.damage | 0, c.stars | 0,
    JSON.stringify(c.items), JSON.stringify(c.equipped), JSON.stringify(c.skills), JSON.stringify(c.achievements), c.lastSeed, c.lastReward ? JSON.stringify(c.lastReward) : null, acctId);
}
function view(c, seed) {
  const skills = {}; for (const k of ['sword', 'bow', 'riding']) skills[k] = { count: c.skills[k] | 0, level: skillLevel(c.skills[k]) };
  return { xp: c.xp, gold: c.gold, trophies: c.trophies, matches: c.matches, wins: c.wins, kills: c.kills, deaths: c.deaths, damage: c.damage, stars: c.stars,
    items: c.items, equipped: c.equipped, skills, achievements: c.achievements, rank: rankInfo(c.xp), lastSeed: c.lastSeed, lastReward: (!seed || c.lastSeed === String(seed)) ? c.lastReward : null };
}
async function career(db, acctId, seed) { return view(parse(await careerRow(db, acctId)), seed); }
async function buy(db, acctId, id) {
  const c = parse(await careerRow(db, acctId)), why = lockReason(id, c);
  if (why) return { ok: false, error: why, career: view(c) };
  const it = ARENA_ITEMS[id]; c.gold -= it.price; c.items.push(id); c.equipped[it.slot] = id;
  await saveStmt(db, acctId, c).run(); return { ok: true, career: view(c) };
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
  for (const p of players) {
    const a = accts.get(p.handle); if (!a || rewards[p.handle]) continue; const c = cs.get(p.handle), won = (p.team | 0) === winner, draw = winner < 0;
    const r = rewardFor(p, won, draw), before = rankOf(c.xp);
    c.xp += r.xp; c.gold += r.gold; c.trophies += r.trophies; c.matches++; if (won) c.wins++; c.kills += clamp(p.kills | 0, 0, 500); if (!p.alive) c.deaths++; c.damage += Math.round(clamp(+p.dmg || 0, 0, 1e5)); if (p.star) c.stars++;
    const sk = p.skills || {}; for (const k of ['sword', 'bow', 'riding']) c.skills[k] = (c.skills[k] | 0) + clamp(sk[k] | 0, 0, 200);
    const reward = Object.assign({ seed, won, draw, star: !!p.star }, r);
    if (pvp && won) { const share = Math.floor(pot / winners.length); c.gold += share; reward.purse = share; }
    if (pvp && !won) reward.purse = -(paidCut[p.handle] || 0);
    if (won) {
      if (Math.random() < 0.25) { const g = 10 + Math.floor(Math.random() * 31); c.gold += g; reward.lootGold = g; }
      if (Math.random() < 0.05) { const pool = Object.keys(ARENA_ITEMS).filter((id) => ARENA_ITEMS[id].unique && c.items.indexOf(id) < 0);
        if (pool.length) { const id = pool[Math.floor(Math.random() * pool.length)]; c.items.push(id); c.equipped[ARENA_ITEMS[id].slot] = id; reward.loot = id; } else { c.gold += 50; reward.lootGold = (reward.lootGold || 0) + 50; } }
    }
    const after = rankOf(c.xp); if (after > before) reward.rankUp = ARENA_RANKS[after][0];
    const earned = []; for (const [id, label, stat, at] of ARENA_ACHIEVEMENTS) if (c[stat] >= at && c.achievements.indexOf(id) < 0) { c.achievements.push(id); earned.push(label); }
    if (earned.length) reward.achievements = earned;
    c.lastSeed = seed; c.lastReward = reward; rewards[p.handle] = reward;
    writes.push(saveStmt(db, a.id, c), q(db, 'INSERT OR IGNORE INTO arena_results(seed, account_id) VALUES (?,?)', seed, a.id));
  }
  if (writes.length) await db.batch(writes);
  return { ok: true, rewards };
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
    if (!acct.pass_hash) return json(401, { ok: false, error: 'sign in to keep an arena career' });
    if (method === 'GET' && p === '/api/v1/arena/career') return json(200, { ok: true, career: await career(db, acct.id, url.searchParams.get('seed')) });
    if (method === 'POST' && p === '/api/v1/arena/buy') { const b = await readBody(request); return json(200, await buy(db, acct.id, String(b.item || ''))); }
    if (method === 'POST' && p === '/api/v1/arena/equip') { const b = await readBody(request); return json(200, await equip(db, acct.id, String(b.slot || ''), b.item == null ? null : String(b.item))); }
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
    await this.save();
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
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (p === '/coop') return env.RELAY.get(env.RELAY.idFromName('lobby')).fetch(request);
    if (p.startsWith('/api/')) { try { return await api(request, env, url); } catch (e) { return json(500, { error: String((e && e.message) || e) }); } }
    return env.ASSETS.fetch(request);
  },
};
