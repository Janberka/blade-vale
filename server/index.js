// Blade Vale — backend HTTP API (Step 3): persist named-character careers.
// Plain node:http (no framework). Authority for the player's careers; the real-time battle
// stays client-side and reports its results here. The always-on world tick lands in Step 4.
const http = require('http');
const { db, migrate } = require('./db');
const { ensureAccount } = require('./seed');
const tick = require('./tick');
const validate = require('./validate');

migrate();
// seed every world's macro state and start the always-on heartbeat (advances inactive worlds)
for (const w of db.prepare('SELECT id FROM worlds').all()) tick.seedWorld(w.id);
setInterval(() => { try { tick.tickInactiveWorlds(); } catch (e) { console.error('tick error:', e.message); } }, tick.TICK_SECONDS * 1000);
const PORT = process.env.BV_PORT || 8787;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Player-Token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function send(res, code, obj) {
  const body = JSON.stringify(obj);
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
    deaths: r.deaths, notability: r.notability
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
    const token = req.headers['x-player-token'] || 'local'; // auth seam: token → account+world (single-player = 'local')
    const { acct, world } = ensureAccount(token);

    if (req.method === 'GET' && p === '/api/v1/health') {
      return send(res, 200, { ok: true, ts: Date.now() });
    }

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
      if (!tick.isActive(world.id)) tick.advanceWorld(world.id); // catch up the away gap on return
      tick.markActive(world.id);                                  // freeze the tick for this live session (no double-sim)
      const caps = db.prepare('SELECT idx, def_name, owner_name, garrison FROM capitals WHERE world_id=? ORDER BY idx').all(world.id);
      const warlords = db.prepare("SELECT name, faction, archetype, renown, size, kills, battles_won FROM warlords WHERE world_id=? AND status='alive' ORDER BY renown DESC LIMIT 8").all(world.id);
      const events = db.prepare('SELECT tick, type, summary FROM world_events WHERE world_id=? AND tick>? ORDER BY id DESC LIMIT 40').all(world.id, since);
      const simTick = db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(world.id).sim_tick;
      return send(res, 200, { simTick, capitals: caps, warlords, events });
    }

    if (req.method === 'POST' && p === '/api/v1/world/capital') {
      const b = await readBody(req);
      const st = db.prepare('SELECT sim_tick FROM worlds WHERE id=?').get(world.id).sim_tick;
      db.prepare('UPDATE capitals SET owner_name=? WHERE world_id=? AND idx=?').run(String(b.owner || ''), world.id, b.idx | 0);
      db.prepare('INSERT INTO world_events(world_id, tick, type, summary) VALUES (?,?,?,?)').run(world.id, st, 'capital_taken', String(b.summary || 'A hold changed hands'));
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/v1/_advance') { // dev/test: force N world ticks immediately
      const b = await readBody(req);
      return send(res, 200, { ok: true, advanced: tick.forceTicks(world.id, Math.min(1000, (b.n | 0) || 50)) });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => console.log('Blade Vale server on http://localhost:' + PORT + '  (db: better-sqlite3)'));
