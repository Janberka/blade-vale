'use strict';
// Blade Vale — terminal NPC bot. A *manual puppet*: it connects to the live server exactly like a
// real player (an X-Player-Token identity plus a presence heartbeat in the shared world) and does
// nothing on its own — you drive every action with typed commands. It goes through the public API
// only (never the DB), which is what makes it genuinely "another player". Run `node bot/bot.js
// --help` or type `help` once it's running.
//
//   node bot/bot.js --name "Grimwald the Bold" --token bot-grimwald [--faction "..."]
//                   [--archetype sword|long|archer|thrower] [--band 10] [--server http://host:port]

const readline = require('readline');
const WorldSim = require('../sim/world-sim.js');
const { makeHttp } = require('./net-http');
const { makeCoop } = require('./coop');

const MAP_HALF = 90, CLASH_RANGE = 9, CAP_RANGE = 8;            // mirror server/tick.js
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const pad = (v, n) => { const s = String(v); return s.length >= n ? s : s + ' '.repeat(n - s.length); };

function parseArgs(argv) {
  const a = { server: 'http://localhost:8787', token: 'bot', name: 'Bot', faction: null, archetype: 'sword', band: 10 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--server') { a.server = v; i++; }
    else if (k === '--token') { a.token = v; i++; }
    else if (k === '--name') { a.name = v; i++; }
    else if (k === '--faction') { a.faction = v; i++; }
    else if (k === '--archetype') { a.archetype = v; i++; }
    else if (k === '--band') { a.band = Math.max(0, v | 0); i++; }
    else if (k === '--help' || k === '-h') { a.help = true; }
  }
  if (!a.faction) a.faction = a.name + "'s Host";
  return a;
}

function freshChar(cfg) {
  return {
    id: 1, name: cfg.name, archetype: cfg.archetype, isPlayer: true, trait: null,
    skills: { strike: 6, guard: 4, lead: 3, aim: cfg.archetype === 'archer' || cfg.archetype === 'thrower' ? 6 : 0 },
    xp: 0, renown: 0, popularity: 0, rank: 'Recruit',
    kills: 0, battles: 0, battlesLed: 0, battlesWon: 0, deaths: 0, notability: 1,
  };
}
function freshWarband(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: 100 + i, name: 'Sworn ' + (i + 1), archetype: 'sword', isPlayer: false, skills: { strike: 4, guard: 3, lead: 0, aim: 0 }, renown: 0, kills: 0, battles: 0, battlesWon: 0, deaths: 0, notability: 1 });
  return out;
}
// the API exposes an enemy army's size + renown but not its skills_json — approximate the leader's
// strike from renown (a renowned warlord is a harder fight), the same spirit as server/tick.js band()
function approxStrike(renown) { return Math.min(20, Math.sqrt(Math.max(0, renown || 0)) * 2); }

async function main() {
  const cfg = parseArgs(process.argv);
  const out = (s) => process.stdout.write(s + '\n');
  if (cfg.help) { out(HELP); return; }

  const http = makeHttp(cfg);
  const me = { token: cfg.token, name: cfg.name, faction: cfg.faction, x: 0, z: 0, char: null, warband: [], world: null, lastTick: 0 };

  // load (or create) this token's career — exactly like a player's profile pre-fetch
  try {
    const prof = await http.profile();
    if (prof && prof.player) {
      me.char = prof.player; me.warband = prof.warband || [];
      out('loaded career: ' + me.char.name + ' (renown ' + Math.round(me.char.renown) + ', kills ' + me.char.kills + ', band ' + (1 + me.warband.length) + ')');
    }
  } catch (e) { out('(server profile unreachable — starting fresh)'); }
  if (!me.char) { me.char = freshChar(cfg); me.warband = freshWarband(cfg.band); out('new character: ' + me.char.name + ' with ' + cfg.band + ' sworn followers'); }
  me.name = me.char.name || me.name;

  const aliveBand = () => me.warband.filter((c) => !c.fallen && c.status !== 'gone');
  const bandSize = () => 1 + aliveBand().length;
  const myBand = () => ({ size: bandSize(), quality: 1.05, leader: { skills: me.char.skills || {}, renown: me.char.renown || 0 } });
  const rosterPayload = () => [{ name: me.char.name, archetype: me.char.archetype, skills: me.char.skills }]
    .concat(aliveBand().map((c) => ({ name: c.name, archetype: c.archetype, skills: c.skills }))).slice(0, 60);

  const coop = makeCoop({
    url: cfg.server.replace(/^http/, 'ws').replace(/\/$/, '') + '/coop',
    name: me.name, world: 'shared', rosterFn: rosterPayload, log: out,
  });

  // ---- presence heartbeat (TTL is 30s server-side; pulse every 10s so the banner never lapses) ----
  let beat = null;
  const heartbeat = async () => { try { await http.sendPresence({ name: me.name, faction: me.faction, x: me.x, z: me.z, size: bandSize(), renown: me.char.renown || 0 }); } catch (e) {} };
  const startBeat = () => { if (!beat) { heartbeat(); beat = setInterval(heartbeat, 10000); } };

  // ---- world helpers ----
  const refreshWorld = async () => { const w = await http.loadWorld(me.lastTick); if (w) { me.world = w; me.lastTick = w.simTick || me.lastTick; } return w; };
  const armyById = (id) => ((me.world && me.world.armies) || []).find((a) => a.id === id);
  const capByIdx = (idx) => ((me.world && me.world.capitals) || []).find((c) => c.idx === idx);
  function closeTo(tx, tz, within) {                 // move just inside `within` units of a target
    const d = dist(me.x, me.z, tx, tz); if (d <= within) return;
    me.x = clamp(tx - (tx - me.x) / d * within, -MAP_HALF, MAP_HALF);
    me.z = clamp(tz - (tz - me.z) / d * within, -MAP_HALF, MAP_HALF);
  }
  function applyLosses(n) {                           // legible casualties: followers fall first, leader endures
    let loss = n;
    for (let i = me.warband.length - 1; i >= 0 && loss > 0; i--) { const c = me.warband[i]; if (c.fallen || c.status === 'gone') continue; c.fallen = true; loss--; }
  }

  // ---- commands ----
  const cmds = {};
  cmds.help = () => out(HELP);
  cmds.whoami = () => { out(`${me.name}  [token ${me.token}]  banner "${me.faction}"`); out(`  at (${me.x.toFixed(1)}, ${me.z.toFixed(1)})  band ${bandSize()}  renown ${Math.round(me.char.renown || 0)}  kills ${me.char.kills || 0}  battles ${me.char.battles || 0}`); };
  cmds.pos = () => out(`position (${me.x.toFixed(1)}, ${me.z.toFixed(1)})`);
  cmds.presence = async () => { await heartbeat(); out('presence beacon sent.'); };

  cmds.goto = async (xs, zs) => {
    const x = +xs, z = +zs; if (!isFinite(x) || !isFinite(z) || xs == null || zs == null) return out('usage: goto <x> <z>   (range -90..90)');
    me.x = clamp(x, -MAP_HALF, MAP_HALF); me.z = clamp(z, -MAP_HALF, MAP_HALF); await heartbeat(); out(`moved to (${me.x.toFixed(1)}, ${me.z.toFixed(1)})`);
  };
  cmds.move = async (dxs, dzs) => {
    const dx = +dxs, dz = +dzs; if (!isFinite(dx) || !isFinite(dz) || dxs == null || dzs == null) return out('usage: move <dx> <dz>');
    me.x = clamp(me.x + dx, -MAP_HALF, MAP_HALF); me.z = clamp(me.z + dz, -MAP_HALF, MAP_HALF); await heartbeat(); out(`moved to (${me.x.toFixed(1)}, ${me.z.toFixed(1)})`);
  };

  cmds.look = async () => {
    const w = await refreshWorld(); if (!w) return out('world unreachable.');
    out(`— shared world @ tick ${w.simTick} —  you at (${me.x.toFixed(1)}, ${me.z.toFixed(1)}), band ${bandSize()}`);
    const armies = (w.armies || []).map((a) => Object.assign({ d: dist(me.x, me.z, a.x, a.z) }, a)).sort((p, q) => p.d - q.d);
    out('armies (nearest first):');
    for (const a of armies.slice(0, 8)) out(`  #${pad(a.id, 3)} ${pad(a.faction, 9)} size ${pad(a.size, 3)} renown ${pad(Math.round(a.renown), 4)}  ${a.d.toFixed(1)} away${a.d <= CLASH_RANGE ? '   <-- in reach' : ''}`);
    out('capitals:');
    for (const c of (w.capitals || [])) { const d = dist(me.x, me.z, c.x, c.z); out(`  [${c.idx}] ${pad(c.def_name, 9)} owner ${pad(c.owner_name, 9)} garrison ${pad(c.garrison, 3)}  ${d.toFixed(1)} away${d <= CAP_RANGE ? '   <-- in reach' : ''}`); }
    const players = w.players || [];
    out('other players present: ' + (players.length ? players.map((p) => `${p.name}(${p.faction})`).join(', ') : 'none'));
    if (w.events && w.events.length) { out('recent events:'); for (const e of w.events.slice(0, 5)) out('  · ' + e.summary); }
  };

  cmds.hunt = async (ids) => {
    const id = +ids; if (!isFinite(id) || ids == null) return out('usage: hunt <armyId>   (ids from "look")');
    await refreshWorld();
    const a = armyById(id); if (!a) return out('no army #' + id + ' in view — run "look" first.');
    closeTo(a.x, a.z, CLASH_RANGE - 1); await heartbeat();          // march into reach
    const enemy = { size: a.size, quality: 1.05, leader: { skills: { strike: approxStrike(a.renown) }, renown: a.renown } };
    const r = WorldSim.resolveClash(myBand(), enemy, Math.random); // honest resolution — same kernel as the server
    me.char.battles = (me.char.battles || 0) + 1;
    const before = bandSize();
    if (r.aWins) {
      applyLosses(r.winnerLoss);
      me.char.renown = (me.char.renown || 0) + 3 + 0.12 * a.size; me.char.kills = (me.char.kills || 0) + 1; me.char.battlesWon = (me.char.battlesWon || 0) + 1;
      await http.reportArmyDefeat(id);
      await http.saveDeeds([{ kind: 'kill', actor: me.name, target: a.name || ('army #' + id), summary: `${me.name} cut down ${a.name || 'a warlord'} of ${a.faction}` }]);
      out(`victory over #${id} (${a.faction})! lost ${before - bandSize()} troops, band ${bandSize()}, renown now ${Math.round(me.char.renown)}.`);
    } else {
      applyLosses(r.loserLoss);
      out(`routed by #${id} (${a.faction}). lost ${before - bandSize()} troops, band ${bandSize()} — no kill reported.`);
      if (bandSize() === 1) out('only you remain — pick weaker prey before the next charge.');
    }
  };

  cmds.siege = async (idxs) => {
    const idx = +idxs; if (!isFinite(idx) || idxs == null) return out('usage: siege <capIdx>   (idx from "look")');
    await refreshWorld();
    const c = capByIdx(idx); if (!c) return out('no capital [' + idx + '] in view — run "look" first.');
    if (c.owner_name === me.faction) return out('you already hold ' + c.def_name + '.');
    closeTo(c.x, c.z, CAP_RANGE - 1); await heartbeat();
    if (bandSize() >= c.garrison * 0.5) {                            // same threshold as server/tick.js conquest
      await http.reportCapital(idx, me.faction, `${me.name} seized ${c.def_name}`);
      me.char.renown = (me.char.renown || 0) + 10;
      out(`seized ${c.def_name}! it now flies "${me.faction}". renown now ${Math.round(me.char.renown)}.`);
    } else out(`too weak to take ${c.def_name}: need ${Math.ceil(c.garrison * 0.5)} troops, have ${bandSize()}.`);
  };

  cmds.career = async (sub) => {
    if (sub !== 'save') return out('usage: career save');
    const r = await http.saveCareers({ v: 1, mapLevel: 1, player: me.char, warband: aliveBand() });
    out(r ? 'career saved.' : 'save failed.');
  };

  cmds.coop = async (sub, ...rest) => {
    if (sub === 'connect') out((await coop.connect()) ? 'co-op relay connected.' : 'co-op connect failed.');
    else if (sub === 'list') coop.list();
    else if (sub === 'join') { if (!rest[0]) return out('usage: coop join <room>'); coop.join(rest[0]); }
    else if (sub === 'input') { coop.input(rest[0] || 0, rest[1] || 0); out('input sent.'); }
    else if (sub === 'leave') { coop.leave(); out('left battle.'); }
    else if (sub === 'status') out(JSON.stringify(coop.status()));
    else out('usage: coop connect|list|join <room>|input <dx> <dz>|leave|status');
  };

  // ---- REPL ----
  startBeat();
  out(`\nBlade Vale bot — ${me.name} ready. Type "help" for commands. (heartbeat live in the shared world)\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: me.name.split(' ')[0].toLowerCase() + '> ' });
  const cleanup = () => { if (beat) clearInterval(beat); coop.disconnect(); };
  rl.prompt();
  rl.on('line', async (line) => {
    const parts = line.trim().split(/\s+/), cmd = parts[0];
    if (!cmd) { rl.prompt(); return; }
    if (cmd === 'quit' || cmd === 'exit') { cleanup(); rl.close(); return; }
    const fn = cmds[cmd];
    if (!fn) { out('unknown command: ' + cmd + ' (try "help")'); rl.prompt(); return; }
    try { await fn(...parts.slice(1)); } catch (e) { out('error: ' + ((e && e.message) || e)); }
    rl.prompt();
  });
  rl.on('close', () => { cleanup(); process.exit(0); });
}

const HELP = [
  'Blade Vale bot — manual-puppet commands:',
  '  whoami                 — identity, band, renown, position',
  '  look                   — refresh & print the shared world around you',
  '  pos                    — print your map position',
  '  goto <x> <z>           — move to a map point (-90..90) and heartbeat',
  '  move <dx> <dz>         — nudge your position and heartbeat',
  '  presence               — force a presence heartbeat now',
  '  hunt <armyId>          — close on a server army and fight it (honest — you can lose)',
  '  siege <capIdx>         — close on a capital and take it if strong enough',
  '  career save            — persist your character + warband to the server',
  '  coop connect           — open the /coop battle relay',
  '  coop list              — list joinable co-op battles',
  '  coop join <room>       — join a battle as an ally (announces your roster)',
  '  coop input <dx> <dz>   — drive your fighter in the host battle (e.g. coop input 1 0)',
  '  coop leave | coop status',
  '  help | quit',
].join('\n');

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
