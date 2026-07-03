// Blade Vale — backend HTTP API (Step 3): persist named-character careers.
// Plain node:http (no framework). Authority for the player's careers; the real-time battle
// stays client-side and reports its results here. The always-on world tick lands in Step 4.
const http = require('http');
const { db, migrate } = require('./db');
const { ensureAccount, ensureWorldFor, ensureSharedWorld } = require('./seed');
const tick = require('./tick');
const auth = require('./auth');
const chars = require('./chars');
const diplomacy = require('./diplomacy');
const destiny = require('./destiny');
const validate = require('./validate');
const coop = require('./ws'); // real-time co-op battle relay (WebSocket, no external deps)
const chunks = require('./chunks');
const zlib = require('zlib');

migrate();
// seed every world's macro state and start the always-on heartbeat (advances inactive worlds)
for (const w of db.prepare('SELECT id FROM worlds').all()) tick.seedWorld(w.id);
setInterval(() => { try { tick.tickInactiveWorlds(); } catch (e) { console.error('tick error:', e.message); } }, tick.TICK_SECONDS * 1000);
const PORT = process.env.BV_PORT || 8787;

// ----- runtime feature flags: client-tunable knobs served at boot (GET /api/v1/config). Change them
// HERE (or via the BV_* env overrides) to retune the live client without a redeploy. The client keeps
// matching defaults, so an unreachable server just leaves the built-in feel in place. -----
const FLAGS = {
  // camera settle/transition speed when switching combat<->map (1 = snappy, lower = slower glide; 0.6 = a
  // gentler-than-original settle, the shipped default)
  modeXfadeSpeed: process.env.BV_MODE_XFADE_SPEED ? +process.env.BV_MODE_XFADE_SPEED : 0.6,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Player-Token, X-World',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS));
  res.end(body);
}
// like send(), but gzips large payloads when the client accepts it (chunk batches compress ~5x)
function sendZ(req, res, code, obj) {
  const body = JSON.stringify(obj);
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, CORS));
    return res.end(gz);
  }
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); }); // 2MB cap
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}

function rowToChar(r) {
  return {
    id: r.client_id, name: r.name, archetype: r.archetype, isPlayer: !!r.is_player, trait: r.trait,
    skills: JSON.parse(r.skills_json || '{}'),
    xp: r.xp, renown: r.renown, popularity: r.popularity, rank: r.rank,
    kills: r.kills, battles: r.battles, battlesLed: r.battles_led, battlesWon: r.battles_won,
    deaths: r.deaths, notability: r.notability,
    destiny: r.destiny || null, fate: r.fate || 0   // server-computed fated arc (chronicle-only)
  };
}
function charParams(c, worldId, accountId) {
  return {
    world_id: worldId, owner_account: accountId, client_id: c.id | 0,
    name: String(c.name || 'Unknown'), archetype: c.archetype || 'sword',
    is_player: c.isPlayer ? 1 : 0, controller: c.isPlayer ? 'player' : 'ai', trait: c.trait || null,
    skills_json: JSON.stringify(c.skills || {}),
    xp: c.xp | 0, renown: +c.renown || 0, popularity: +c.popularity || 0, rank: c.rank || 'Recruit',
    kills: c.kills | 0, battles: c.battles | 0, battles_led: c.battlesLed | 0, battles_won: c.battlesWon | 0,
    deaths: c.deaths | 0, notability: c.notability | 0 || 1
  };
}
const upsertChar = db.prepare(`INSERT INTO characters
  (world_id, owner_account, client_id, name, archetype, is_player, controller, trait, skills_json,
   xp, renown, popularity, rank, kills, battles, battles_led, battles_won, deaths, notability, status, updated_at)
  VALUES (@world_id, @owner_account, @client_id, @name, @archetype, @is_player, @controller, @trait, @skills_json,
   @xp, @renown, @popularity, @rank, @kills, @battles, @battles_led, @battles_won, @deaths, @notability, 'alive', unixepoch())
  ON CONFLICT(world_id, client_id) DO UPDATE SET
   name=excluded.name, archetype=excluded.archetype, is_player=excluded.is_player, controller=excluded.controller,
   trait=excluded.trait, skills_json=excluded.skills_json, xp=excluded.xp, renown=excluded.renown,
   popularity=excluded.popularity, rank=excluded.rank, kills=excluded.kills, battles=excluded.battles,
   battles_led=excluded.battles_led, battles_won=excluded.battles_won, deaths=excluded.deaths,
   notability=excluded.notability, status='alive', updated_at=unixepoch()`);
const insDeed = db.prepare('INSERT INTO deeds(world_id, kind, actor, target, summary) VALUES (?,?,?,?,?)');

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/v1/health') {
      return send(res, 200, { ok: true, ts: Date.now() });
    }

    // client-tunable feature flags (camera feel, etc.) — fetched once at boot
    if (req.method === 'GET' && p === '/api/v1/config') {
      return send(res, 200, { ok: true, flags: FLAGS });
    }

    // ----- auth: super-simple username/password (before the account seam — no token needed) -----
    if (req.method === 'POST' && p === '/api/v1/auth/register') {
      const b = await readBody(req);
      const r = auth.register(b.username, b.password);
      return send(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/v1/auth/login') {
      const b = await readBody(req);
      const r = auth.login(b.username, b.password);
      return send(res, r.ok ? 200 : 401, r);
    }

    // auth seam: token → account+world. A session token (s-…) wins; otherwise the legacy
    // handle-as-token path — refused when that handle is password-protected (no bypass).
    const token = req.headers['x-player-token'] || 'local'; // single-player = 'local'
    let acct = auth.resolveSession(token), world;
    if (acct) world = ensureWorldFor(acct);
    else if (auth.handleLocked(token)) return send(res, 401, { error: 'that name is password-protected — sign in' });
    else ({ acct, world } = ensureAccount(token));
    const viewWorldId = (req.headers['x-world'] === 'shared') ? ensureSharedWorld().id : world.id; // solo world (own) or the shared multiplayer world

    if (req.method === 'GET' && p === '/api/v1/profile') {
      const player = db.prepare('SELECT * FROM characters WHERE world_id=? AND is_player=1').get(world.id);
      const warband = db.prepare("SELECT * FROM characters WHERE world_id=? AND is_player=0 AND status='alive' ORDER BY renown DESC").all(world.id);
      return send(res, 200, {
        account: { id: acct.id, handle: acct.handle },
        world: { id: world.id, seed: world.seed, mapLevel: world.map_level },
        player: player ? rowToChar(player) : null,
        warband: warband.map(rowToChar)
      });
    }

    if (req.method === 'POST' && p === '/api/v1/careers') {
      const body = await readBody(req);
      db.transaction(() => {
        const keep = new Set();
        if (body.player) { const v = validate.clampChar(body.player); v.isPlayer = true; upsertChar.run(charParams(v, world.id, acct.id)); keep.add(v.id); }
        for (const c of (body.warband || [])) { const v = validate.clampChar(c); upsertChar.run(charParams(v, world.id, acct.id)); keep.add(v.id); }
        // anyone no longer in the roster (fallen/sold) is retired — the player row is never dropped
        const rows = db.prepare('SELECT id, client_id, is_player FROM characters WHERE world_id=? AND status=\'alive\'').all(world.id);
        const retire = db.prepare("UPDATE characters SET status='gone', updated_at=unixepoch() WHERE id=?");
        for (const r of rows) if (!r.is_player && !keep.has(r.client_id)) retire.run(r.id);
        if (body.mapLevel != null) db.prepare('UPDATE worlds SET map_level=?, updated_at=unixepoch() WHERE id=?').run(body.mapLevel | 0, world.id);
      })();
      return send(res, 200, { ok: true, savedAt: Date.now() });
    }

    if (req.method === 'POST' && p === '/api/v1/deeds') {
      const body = await readBody(req);
      db.transaction(() => {
        for (const d of (body.deeds || [])) insDeed.run(world.id, d.kind || 'kill', d.actor || null, d.target || null, String(d.summary || ''));
      })();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/v1/deeds') {
      const rows = db.prepare('SELECT kind, actor, target, summary, created_at FROM deeds WHERE world_id=? ORDER BY id DESC LIMIT 50').all(world.id);
      return send(res, 200, { deeds: rows });
    }

    if (req.method === 'GET' && p === '/api/v1/world') {
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      const wid = viewWorldId;
      const isShared = req.headers['x-world'] === 'shared';
      if (isShared) {
        // the SHARED world never sleeps: live players are pure VIEWERS of it, so it keeps ticking
        // under them — patrols ride their circuits, campaigns march, battles bleed in real time.
        tick.advanceWorld(wid);
        tick.touchActive(wid);                         // presence marker only — does NOT freeze the tick
      } else {
        if (!tick.isActive(wid)) tick.advanceWorld(wid); // catch up the away gap on return
        tick.markActive(wid);                            // solo: the live client owns motion (no double-sim)
      }
      // the viewer's position scopes which patrols ship (every host + anyone in a battle/campaign
      // always ships); an old client that sends no coords gets the legacy hosts-only list
      const px = url.searchParams.get('x'), pz = url.searchParams.get('z');
      const armies = (px != null && pz != null)
        ? tick.getArmiesNear(wid, +px || 0, +pz || 0, url.searchParams.get('r'))
        : tick.getArmies(wid);
      const warlords = armies.filter(a => a.role !== 'patrol').sort((a, b) => b.renown - a.renown).slice(0, 8);
      const events = db.prepare('SELECT tick, type, summary FROM world_events WHERE world_id=? AND tick>? ORDER BY id DESC LIMIT 40').all(wid, since);
      const simTick = db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(wid).sim_tick;
      return sendZ(req, res, 200, {
        worldId: wid, shared: wid !== world.id, account: acct.id, simTick,
        capitals: tick.getCapitals(wid), armies, warlords, holdings: tick.getHoldings(wid),
        battles: tick.getBattles(wid), campaigns: tick.getCampaigns(wid), // the visible war: ⚔ markers + muster beacons
        players: tick.getPresence(wid, acct.id).concat(chars.idleCharsOf(wid, acct.id)), // live banners + camped characters
        chars: chars.roster(wid, acct.id), events,
        relations: diplomacy.relationsForApi(wid), factionState: diplomacy.factionStateForApi(wid),
        destiny: destiny.destinyForApi(wid)
      });
    }

    if (req.method === 'POST' && p === '/api/v1/world/presence') { // a player's banner heartbeat
      const b = await readBody(req);
      tick.updatePresence(viewWorldId, acct.id, b);
      chars.trackActive(viewWorldId, acct.id, b); // the ACTIVE character's row follows the live banner
      // the server owns the whole map: pre-warm the chunk store (terrain + holds) around this
      // navigating player so factions have ground to contest — solo AND shared alike (a solo
      // world only generates once its client has claimed a universe via /chunks).
      if (b && b.x != null) tick.ensureRegion(viewWorldId, +b.x || 0, +b.z || 0);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/v1/world/army/defeat') { // the player broke this host in person
      const b = await readBody(req);
      const st = db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(viewWorldId).sim_tick;
      return send(res, 200, { ok: tick.defeatArmy(viewWorldId, b.armyId | 0, st) });
    }

    if (req.method === 'POST' && p === '/api/v1/world/capital') {
      const b = await readBody(req);
      const st = db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(viewWorldId).sim_tick;
      db.prepare('UPDATE capitals SET owner_name=? WHERE world_id=? AND idx=?').run(String(b.owner || ''), viewWorldId, b.idx | 0);
      db.prepare('INSERT INTO world_events(world_id, tick, type, summary) VALUES (?,?,?,?)').run(viewWorldId, st, 'capital_taken', String(b.summary || 'A hold changed hands'));
      return send(res, 200, { ok: true });
    }

    // ----- the world itself: server-generated terrain chunks (Phase 1 of server-side worldgen) -----
    // GET /api/v1/chunks?list=cx:cz,cx:cz[&level=N][&u=SEED]
    // Shared world: level/universe are pinned server-side. Solo: the client passes its mapLevel +
    // universeSeed; the first call CLAIMS that universe on the world row (the background tick then
    // contests that terrain). Chunks are generated at most once and persist forever.
    if (req.method === 'GET' && (p === '/api/v1/chunks' || p === '/api/v1/chunks/detail' || p === '/api/v1/territory')) {
      const q = url.searchParams;
      const w = db.prepare('SELECT kind, map_level, universe_seed FROM worlds WHERE id=?').get(viewWorldId);
      let level, useed;
      if (w.kind === 'shared') { level = 0; useed = chunks.SHARED_WORLD_SEED; }
      else {
        level = Math.max(0, Math.min(9999, parseInt(q.get('level') || '0', 10) || 0));
        useed = (parseInt(q.get('u') || '0', 10) || w.universe_seed || 0) >>> 0;
        if (!useed) return send(res, 400, { error: 'no universe seed claimed — pass ?u=<universeSeed>' });
        if (w.universe_seed !== useed || (w.map_level | 0) !== level)
          db.prepare('UPDATE worlds SET universe_seed=?, map_level=? WHERE id=?').run(useed, level, viewWorldId);
      }
      const list = String(q.get('list') || '').split(',').filter(Boolean).slice(0, 81);
      if (!list.length) return send(res, 400, { error: 'empty chunk list' });
      // /chunks/detail = the street-level tier: scatter rows + expanded groves, generated once and
      // saved (chunk_detail) — the action zoom rung's persisted "zoomed-in" version of the ground
      if (p === '/api/v1/chunks/detail') return sendZ(req, res, 200, chunks.serveDetailBatch(viewWorldId, level, useed, list));
      // /territory = the political heat-map layer: per-hex owner + heat, generated from live
      // ownership (holds/capitals/warlords/presence), persisted in `territory`, served per chunk
      if (p === '/api/v1/territory') return sendZ(req, res, 200, chunks.serveTerritoryBatch(viewWorldId, level, useed, list));
      return sendZ(req, res, 200, chunks.serveBatch(viewWorldId, level, useed, list));
    }

    // server-owned frontier settlements: who currently holds each generated village/town/city.
    // Optional x/z/r bound the result to a box around a point (the client passes its view centre);
    // omit them for every hold in the world.
    if (req.method === 'GET' && p === '/api/v1/holds') {
      const q = url.searchParams, hasBox = q.has('x') && q.has('z');
      const holds = hasBox ? tick.getHolds(viewWorldId, +q.get('x') || 0, +q.get('z') || 0, +q.get('r') || 150) : tick.getHolds(viewWorldId);
      return send(res, 200, { holds });
    }

    // one realm's card, aggregated live: capital, holdings by tier, relations, posture —
    // the map's click-for-details panel reads THIS, so what it shows is the server's truth.
    if (req.method === 'GET' && p === '/api/v1/nation') {
      const name = String(url.searchParams.get('name') || '').slice(0, 48);
      if (!name) return send(res, 400, { error: 'pass ?name=<faction>' });
      const NATIONS = require('../sim/terra.js').NATION_HOMES.map(n => n.name);
      const capRow = db.prepare('SELECT idx, def_name, owner_name, garrison FROM capitals WHERE world_id=?')
        .all(viewWorldId).find(c => NATIONS[c.idx] === name || c.owner_name === name);
      const capital = capRow ? Object.assign({ idx: capRow.idx, defName: capRow.def_name, owner: capRow.owner_name, garrison: capRow.garrison, founder: NATIONS[capRow.idx] }, tick.capPos(capRow.idx)) : null;
      const tp = chunks.tseedParams(viewWorldId);
      const holdCounts = { village: 0, town: 0, city: 0, total: 0 };
      if (tp) for (const r of db.prepare('SELECT tier, COUNT(*) n FROM holds WHERE world_id=? AND tseed=? AND owner_name=? GROUP BY tier').all(viewWorldId, tp.tseed, name)) {
        holdCounts[r.tier] = r.n; holdCounts.total += r.n;
      }
      const relations = diplomacy.relationsForApi(viewWorldId).filter(r => r.a === name || r.b === name);
      const state = diplomacy.factionStateForApi(viewWorldId).find(s => s.faction === name) || null;
      const armies = tick.getArmies(viewWorldId).filter(a => a.faction === name).length;
      return send(res, 200, { name, capital, holds: holdCounts, relations, state, armies });
    }

    // ----- town management: player holdings (server-backed economy) -----
    if (req.method === 'GET' && p === '/api/v1/holdings') {
      const wid = viewWorldId;
      if (!tick.isActive(wid)) tick.advanceWorld(wid); // current as of the away-gap catch-up
      return send(res, 200, { holdings: tick.getHoldings(wid) });
    }
    if (req.method === 'POST' && p === '/api/v1/holdings/claim') {
      const b = await readBody(req);
      const st = db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(viewWorldId).sim_tick;
      return send(res, 200, tick.claimHolding(viewWorldId, st, b));
    }
    if (req.method === 'POST' && p === '/api/v1/holdings/build') {
      return send(res, 200, tick.buildHolding(viewWorldId, await readBody(req)));
    }
    if (req.method === 'POST' && p === '/api/v1/holdings/assign') {
      return send(res, 200, tick.assignJobs(viewWorldId, await readBody(req)));
    }
    if (req.method === 'POST' && p === '/api/v1/holdings/levy') {
      return send(res, 200, tick.levyHolding(viewWorldId, await readBody(req)));
    }

    // ----- multiple characters per account, same map: adopt / switch / split / give -----
    if (req.method === 'GET' && p === '/api/v1/chars') {
      return send(res, 200, { ok: true, chars: chars.roster(viewWorldId, acct.id) });
    }
    if (req.method === 'POST' && p === '/api/v1/chars/adopt') {      // first contact: roster (creates char #1 from the live hero)
      return send(res, 200, chars.adopt(viewWorldId, acct.id, await readBody(req)));
    }
    if (req.method === 'POST' && p === '/api/v1/chars/switch') {     // play another character; the old one waits where it stands
      const r = chars.switchChar(viewWorldId, acct.id, await readBody(req));
      return send(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/v1/chars/split') {      // split men off under a brand-new character
      const r = chars.splitChar(viewWorldId, acct.id, await readBody(req));
      return send(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/v1/chars/create') {     // brand-new independent random character
      const r = chars.createChar(viewWorldId, acct.id, await readBody(req));
      return send(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/v1/chars/give') {       // move men between two of your characters (they must have met)
      const r = chars.giveMen(viewWorldId, acct.id, await readBody(req));
      return send(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/v1/chars/merge') {      // fold one character into another as a member (rally / join)
      const r = chars.mergeChar(viewWorldId, acct.id, await readBody(req));
      return send(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/v1/chars/detach') {     // re-split a member back out with some men
      const r = chars.detachMember(viewWorldId, acct.id, await readBody(req));
      return send(res, r.ok ? 200 : 400, r);
    }

    if (req.method === 'POST' && p === '/api/v1/_advance') { // dev/test: force N world ticks immediately (X-World: shared targets the shared world)
      const b = await readBody(req);
      return send(res, 200, { ok: true, advanced: tick.forceTicks(viewWorldId, Math.min(1000, (b.n | 0) || 50)) });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

coop.attach(server); // upgrade /coop WebSocket connections into the co-op battle relay
server.listen(PORT, () => console.log('Blade Vale server on http://localhost:' + PORT + '  (db: better-sqlite3, co-op relay on /coop)'));
