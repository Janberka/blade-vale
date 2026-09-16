#!/usr/bin/env node
// Arena TACTICS probe — the bench the captains are tuned on. Seeded team fights run headless through the real sim
// (BV.arena / BV.arenaStep) with every man an NPC, sampled every 0.5 s through BV.arenaTactics(), and read for what
// the tactics DID: where the lines met (0.5 = the dead centre of the pit — the old "everyone runs to the middle"),
// how far and how long each rider went before his first blow and on whom, when the archers opened and who killed
// them, which doctrines the captains drew and who won.
//
//   node perf/arena-tactics.js --per 5 --seeds 30                       the user's 5-a-side (one of each class)
//   node perf/arena-tactics.js --per 8 --mix swordsman,swordsman,guardsman,brute,archer,archer,rider,rider
//   node perf/arena-tactics.js --per 5 --seeds 1 --seed0 6 --trace 6 --rider 4      one rider, every half second
//   node perf/arena-tactics.js --gamejs /path/to/other/game.js          A/B: the same seeds through another build
//   node perf/arena-tactics.js --smoke                                  odd lobbies (FFA, the pits, all horse, all bows, a standing human, 30 a side): no page errors, every fight resolves
//
// Chrome: CHROME_BIN (the perf harness's default is the Mac's Google Chrome; Playwright's /opt/pw-browsers/chromium works too).
// Seeds: Math.random is replaced by a seeded stream before the page loads, so a seed is the same fight every run (until the sim changes).
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { start } = require('./serve');
const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const CHROME_ARGS = ['--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PER = +opt('per', 5), SEEDS = +opt('seeds', 6), SEED0 = +opt('seed0', 1), VERBOSE = args.includes('--verbose');
const MIX = opt('mix', 'swordsman,guardsman,brute,archer,rider').split(',');
const MIXB = opt('mixb', null) ? opt('mixb').split(',') : MIX;
const OUT = opt('json', null);
const SEED_RNG = `(() => { let a = 1; Math.random = function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; window.__reseed = (s) => { a = s >>> 0; }; })();`;

async function runOne(browser, url, seed) {
  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 320 });
  await page.evaluateOnNewDocument(SEED_RNG);
  const errs = []; page.on('pageerror', e => errs.push(String(e && e.message || e)));
  const alt = opt('gamejs', null);
  if (alt) { await page.setRequestInterception(true); page.on('request', rq => { if (/\/game\.js(\?|$)/.test(rq.url())) rq.respond({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(alt, 'utf8') }); else rq.continue(); }); }
  await page.goto(url + '?arena&nooutro', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.BV && typeof BV.arena === 'function' && typeof BV.arenaTactics === 'function', { timeout: 60000 });
  const res = await page.evaluate(async (seed, per, mixA, mixB) => {
    window.__reseed(seed);
    BV.arena({ teams: 2, per, intro: false, outro: false, xp: 'mixed' });
    BV.arenaMix([mixA, mixB]);
    BV.arenaStart();
    BV.arenaAutoMe();
    const samples = [];
    let s = BV.arenaTactics();
    samples.push(s);
    for (let i = 0; i < 260 && !s.over; i++) { BV.arenaStep(30, 1 / 60); s = BV.arenaTactics(); samples.push(s); }
    return { samples, status: BV.arenaStatus() };
  }, seed, PER, MIX, MIXB);
  await page.close();
  return { res, errs };
}

function analyse(seed, res) {
  const S = res.samples, first = S[0], last = S[S.length - 1];
  const bodies = first.bodies;
  const foot = b => !b.mounted && b.weapon !== 'bow';
  const byI = i => bodies[i];
  // spawn axis: team centroids at t0
  const cen = (t, s) => { const bs = s.bodies.filter(b => b.team === t && !b.dead); return { x: bs.reduce((a, b) => a + b.x, 0) / (bs.length || 1), z: bs.reduce((a, b) => a + b.z, 0) / (bs.length || 1) }; };
  const c0 = cen(0, first), c1 = cen(1, first), ax = c1.x - c0.x, az = c1.z - c0.z, al = Math.hypot(ax, az) || 1;
  const along = (x, z) => ((x - c0.x) * ax + (z - c0.z) * az) / (al * al);   // 0 = team0 home, 1 = team1 home
  // first foot-on-foot contact
  let meet = null;
  for (const s of S) { for (const a of s.bodies) { if (a.dead || !foot(byI(a.i)) || a.team !== 0) continue; for (const b of s.bodies) { if (b.dead || b.team !== 1 || !foot(byI(b.i))) continue; if (Math.hypot(a.x - b.x, a.z - b.z) < 5) { meet = { t: s.t, k: along((a.x + b.x) / 2, (a.z + b.z) / 2) }; break; } } if (meet) break; } if (meet) break; }
  // cavalry: path before first damage, time to first damage, first victim class, idle-far time
  const cav = [];
  for (const b0 of bodies) {
    if (!b0.mounted) continue;
    let path = 0, prev = null, tHit = null, victim = null, far = 0;
    for (const s of S) { const b = s.bodies[b0.i]; if (b.dead) break; if (prev) path += Math.hypot(b.x - prev.x, b.z - prev.z); prev = b;
      if (tHit == null && b.dmg > 0) { tHit = s.t; victim = b.target >= 0 ? byI(b.target).arch : '?'; break; }
      let nd = 1e9; for (const o of s.bodies) if (!o.dead && o.team !== b.team) nd = Math.min(nd, Math.hypot(o.x - b.x, o.z - b.z)); if (nd > 20) far += 0.5; }
    const bl = last.bodies[b0.i];
    cav.push({ team: b0.team, pathToHit: +path.toFixed(0), tHit, victim, farSecs: far, kills: bl.kills, dead: bl.dead, killedBy: bl.dead ? (byI(bl.killedBy) ? byI(bl.killedBy).arch : '-') : null });
  }
  // archers: first shot time, shots, death time and killer class
  const arch = [];
  for (const b0 of bodies) {
    if (b0.weapon !== 'bow') continue;
    let tShot = null; for (const s of S) { const b = s.bodies[b0.i]; if (b.shots > 0) { tShot = s.t; break; } }
    const bl = last.bodies[b0.i];
    arch.push({ team: b0.team, tShot, shots: bl.shots, kills: bl.kills, dead: bl.dead, diedAt: bl.diedAt, killedBy: bl.dead ? (byI(bl.killedBy) ? (byI(bl.killedBy).mounted ? 'rider' : byI(bl.killedBy).arch) : '-') : null });
  }
  const orders = S.map(s => s.teams.map(T => T.order + '/' + T.riderOrder + (T.riderRole ? ':' + T.riderRole : '')).join(' | '));
  const seq = []; for (const o of orders) if (seq[seq.length - 1] !== o) seq.push(o);
  const doct = first.teams.map(T => T.doctrine);
  const alive = [0, 1].map(t => last.bodies.filter(b => b.team === t && !b.dead).length);
  const roles = last.teams.map(T => T.riderRole || '-');
  return { seed, doct, roles, meet, cav, arch, winner: last.winner, t: last.t, alive, orderSeq: seq };
}

// the smoke lobbies: nothing measured, just that the odd shapes of a lobby all run clean and resolve
const CASES = [
  { name: 'ffa 3x4', cfg: { teams: 3, per: 4 }, mix: [['swordsman','archer','rider','brute'],['guardsman','archer','rider','duelist'],['swordsman','swordsman','archer','rider']] },
  { name: 'pit 1v1', cfg: { teams: 2, per: 1, venue: 'pit' } },
  { name: 'all horse 4v4', cfg: { teams: 2, per: 4 }, mix: [['rider','rider','rider','rider'],['rider','rider','rider','rider']] },
  { name: 'all bows 4v4', cfg: { teams: 2, per: 4 }, mix: [['archer','archer','archer','archer'],['archer','archer','archer','archer']] },
  { name: 'bows vs swords 5v5', cfg: { teams: 2, per: 5 }, mix: [['archer','archer','archer','archer','guardsman'],['swordsman','swordsman','brute','guardsman','duelist']] },
  { name: 'human stands 5v5', cfg: { teams: 2, per: 5 }, mix: [['swordsman','guardsman','brute','archer','rider'],['swordsman','guardsman','brute','archer','rider']], human: true },
  { name: 'big 30v30', cfg: { teams: 2, per: 30 }, seeds: 1 },
];
async function smoke() {
  const { server, port } = await start();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 600000, args: CHROME_ARGS });
  let bad = 0;
  try {
    for (const C of CASES) {
      const page = await browser.newPage(); await page.setViewport({ width: 480, height: 320 });
      const errs = []; page.on('pageerror', e => errs.push(String(e && e.message || e)));
      await page.goto(`http://127.0.0.1:${port}/index.html?arena&nooutro`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.BV && typeof BV.arenaTactics === 'function', { timeout: 60000 });
      const t0 = Date.now();
      const r = await page.evaluate(async (C) => {
        BV.arena({ intro: false, outro: false, ...C.cfg });
        if (C.mix) BV.arenaMix(C.mix);
        BV.arenaStart();
        if (!C.human) BV.arenaAutoMe();
        let s, n = 0; const t1 = performance.now();
        for (let i = 0; i < 260; i++) { s = BV.arenaStep(30, 1 / 60); n += 30; if (s.over) break; }
        const T = BV.arenaTactics();
        return { over: s.over, winner: s.winner, t: s.t, ticks: n, msPerTick: +((performance.now() - t1) / n).toFixed(3), doct: T.teams.map(x => x.doctrine + '/' + (x.riderRole || '-')), alive: T.bodies.filter(b => !b.dead).map(b => b.team), orders: T.teams.map(x => x.phase) };
      }, C);
      await page.close();
      const ok = !errs.length && (r.over || C.name.startsWith('human'));
      if (!ok) bad++;
      console.log(`${ok ? 'ok ' : 'BAD'} ${C.name.padEnd(20)} over=${r.over} winner=${r.winner} t=${r.t} ms/tick=${r.msPerTick} doct=${r.doct.join(',')} alive=${JSON.stringify(r.alive)} (${((Date.now() - t0) / 1000).toFixed(0)}s)${errs.length ? '\n    ' + errs.slice(0, 3).join('\n    ') : ''}`);
    }
  } finally { await browser.close(); server.close(); }
  process.exit(bad ? 1 : 0);
}

(async () => {
  const { server, port } = await start();
  if (args.includes('--smoke')) { await smoke(); return; }
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 600000, args: CHROME_ARGS });
  const out = [];
  try {
    for (let k = 0; k < SEEDS; k++) {
      const seed = SEED0 + k;
      const t0 = Date.now();
      const { res, errs } = await runOne(browser, `http://127.0.0.1:${port}/index.html`, seed);
      if (errs.length) console.log('  page errors:', errs.slice(0, 3));
      const A = analyse(seed, res);
      out.push(A);
      console.log(`seed ${seed}  doct ${A.doct.join(' vs ')} (${A.roles.join('/')})  meet@${A.meet ? A.meet.k.toFixed(2) + ' t=' + A.meet.t : 'none'}  winner ${A.winner} t=${A.t} alive ${A.alive.join('-')}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      for (const c of A.cav) console.log(`   rider t${c.team}: path ${c.pathToHit} to first hit at t=${c.tHit} on ${c.victim}, far ${c.farSecs}s, kills ${c.kills}${c.dead ? ', died to ' + c.killedBy : ''}`);
      for (const a of A.arch) console.log(`   archer t${a.team}: first shot t=${a.tShot}, ${a.shots} shots, ${a.kills} kills${a.dead ? ', died t=' + a.diedAt + ' to ' + a.killedBy : ''}`);
      if (VERBOSE) console.log('   orders:', A.orderSeq.join(' -> '));
      if (opt('trace', null) != null && +opt('trace') === seed) {
        const ri = +opt('rider', -1);
        for (const s of res.samples) { const T = s.teams.map(t => t.phase + '/' + t.riderOrder + ':' + (t.riderRole || '-') + (t.wp ? '@' + t.wp.join(',') : '')).join(' | ');
          const rs = s.bodies.filter(b => b.mounted && (ri < 0 || b.i === ri) && !b.dead).map(b => { const tg = b.target >= 0 ? s.bodies[b.target] : null; return `r${b.i}(${b.x},${b.z}) ${b.cav || '-'}${b.waiting ? 'W' : ''} ->${tg ? tg.arch + '#' + tg.i + ' d' + Math.hypot(tg.x - b.x, tg.z - b.z).toFixed(0) : '-'} dmg${b.dmg}`; }).join('  ');
          console.log(`   t=${s.t.toFixed(1).padStart(5)} ${T}  ${rs}`); }
      }
    }
  } finally { await browser.close(); server.close(); }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  // summary
  const cav = out.flatMap(a => a.cav), arch = out.flatMap(a => a.arch), meets = out.map(a => a.meet).filter(Boolean);
  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : NaN;
  console.log('\nSUMMARY over', out.length, 'fights');
  console.log(' meeting point k (0.5 = dead centre): mean', avg(meets.map(m => m.k)).toFixed(2), 'spread', meets.length ? (Math.max(...meets.map(m => m.k)) - Math.min(...meets.map(m => m.k))).toFixed(2) : '-', ' first contact t', avg(meets.map(m => m.t)).toFixed(1));
  console.log(' riders: path to first hit', avg(cav.filter(c => c.tHit != null).map(c => c.pathToHit)).toFixed(0), ' t first hit', avg(cav.filter(c => c.tHit != null).map(c => c.tHit)).toFixed(1), ' far-from-foe secs', avg(cav.map(c => c.farSecs)).toFixed(1), ' first victims', JSON.stringify(cav.reduce((m, c) => (m[c.victim] = (m[c.victim] || 0) + 1, m), {})), ' kills/rider', avg(cav.map(c => c.kills)).toFixed(2), ' died', cav.filter(c => c.dead).length + '/' + cav.length);
  console.log(' archers: first shot t', avg(arch.filter(a => a.tShot != null).map(a => a.tShot)).toFixed(1), ' shots', avg(arch.map(a => a.shots)).toFixed(1), ' kills', avg(arch.map(a => a.kills)).toFixed(2), ' died', arch.filter(a => a.dead).length + '/' + arch.length, ' killers', JSON.stringify(arch.filter(a => a.dead).reduce((m, a) => (m[a.killedBy] = (m[a.killedBy] || 0) + 1, m), {})));
  console.log(' doctrines:', JSON.stringify(out.reduce((m, a) => (m[a.doct.join('/')] = (m[a.doct.join('/')] || 0) + 1, m), {})), ' winners', JSON.stringify(out.reduce((m, a) => (m[a.winner] = (m[a.winner] || 0) + 1, m), {})));
  console.log(' rider jobs:', JSON.stringify(out.flatMap(a => a.roles).reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {})));
})().catch(e => { console.error(e); process.exit(1); });
