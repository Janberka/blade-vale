/* Blade Vale — THE VALE'S MEN FIGHT AMONG THEMSELVES. A fight staged with no player in it: a roster drawn from the
   NPC name pool (known men first, so the same Bram keeps his record), archetypes and skills rolled, and an outcome
   from a small strength model — who won, who fell, who killed whom, who was the star. The record it writes is the
   same shape the client reports (applyNpcs), so a simulated bout and a real one are indistinguishable on a profile.
   ONE file for both backends: the Worker runs it from a cron (worker/index.js scheduled), the Node server from a
   timer (server/index.js). Not loaded in the browser. Seeded, so a seed replays the same fight. */
(function (root) {
  'use strict';
  var CAT = (typeof module !== 'undefined' && module.exports) ? require('./arena-items') : root.ARENA_CAT;
  // strength per archetype (the pit's own balance, roughly: riders and brutes hit hardest, archers get ridden down)
  var ARCHS = { swordsman: { w: 24, str: 1.0 }, brute: { w: 13, str: 1.15 }, duelist: { w: 13, str: 0.95 }, guardsman: { w: 14, str: 1.05 }, archer: { w: 26, str: 0.9 }, rider: { w: 10, str: 1.25 } };
  var SWORDS = ['swordsman', 'brute', 'duelist', 'guardsman'];                 // the pits: swords only
  var SHAPES = [[2, 2, 7], [2, 3, 8], [2, 4, 7], [2, 6, 5], [2, 8, 3], [3, 3, 3], [2, 12, 2], [2, 20, 1]];   // [teams, per, weight]
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
  function pickW(r, table) { var tot = 0, i; for (i = 0; i < table.length; i++) tot += table[i][1]; var x = r() * tot; for (i = 0; i < table.length; i++) { x -= table[i][1]; if (x <= 0) return table[i][0]; } return table[table.length - 1][0]; }
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  function rollName(r, used) { var nm, n = 0; do { nm = CAT.NPC_GIVEN[Math.floor(r() * CAT.NPC_GIVEN.length)] + (r() < 0.35 ? ' ' + CAT.NPC_BYNAMES[Math.floor(r() * CAT.NPC_BYNAMES.length)] : ''); } while (used[nm] && n++ < 50); used[nm] = true; return nm; }
  function rollArch(r, allowRider) { var t = []; for (var k in ARCHS) if (k !== 'rider' || allowRider) t.push([k, ARCHS[k].w]); return pickW(r, t); }

  // known: [{name, arch, skill}] the men with a record already — about six seats in ten go to them
  function simulateFight(seed, known) {
    var r = mulberry32(hash(String(seed))), pit = r() < 0.25, teams, per;
    if (pit) { teams = r() < 0.6 ? 2 : 3; per = 1; } else { var sh = pickW(r, SHAPES.map(function (s) { return [s, s[2]]; })); teams = sh[0]; per = sh[1]; }
    var pool = (known || []).slice(), used = {}, men = [], t, s, i;
    for (i = pool.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
    for (t = 0; t < teams; t++) for (s = 0; s < per; s++) {
      var k = pool.length && r() < 0.6 ? pool.pop() : null, m;
      if (k && !used[k.name]) { used[k.name] = true; m = { name: k.name, team: t, arch: k.arch, skill: clamp((k.skill | 0) + Math.round((r() - 0.5) * 10), 5, 100) }; }
      else m = { name: rollName(r, used), team: t, arch: null, skill: Math.round(15 + r() * 80) };
      if (!m.arch || !ARCHS[m.arch] || (pit && SWORDS.indexOf(m.arch) < 0)) m.arch = pit ? SWORDS[Math.floor(r() * SWORDS.length)] : rollArch(r, per >= 2);
      m.str = ARCHS[m.arch].str * (0.55 + m.skill / 100) * (0.8 + 0.4 * r()); m.kills = 0; m.alive = true; men.push(m);
    }
    var power = []; for (t = 0; t < teams; t++) { power[t] = 0; } men.forEach(function (m) { power[m.team] += m.str; });
    var draw = !pit && r() < 0.03, winner = -1;
    if (!draw) { var tbl = []; for (t = 0; t < teams; t++) tbl.push([t, Math.pow(power[t], 3)]); winner = pickW(r, tbl); }
    // who fell: every loser (last team standing), and a share of the winners set by how even it was
    var winners = men.filter(function (m) { return m.team === winner; }), losers = men.filter(function (m) { return m.team !== winner; });
    if (draw) { men.forEach(function (m) { if (r() < 0.45) m.alive = false; }); }
    else {
      losers.forEach(function (m) { m.alive = false; });
      var enemyPow = 0; for (t = 0; t < teams; t++) if (t !== winner) enemyPow += power[t];
      var fell = Math.min(winners.length - 1, Math.round(winners.length * clamp(enemyPow / power[winner] * 0.55 * (0.7 + 0.6 * r()), 0, 0.85)));
      winners.slice().sort(function (a, b) { return a.str - b.str; }).slice(0, Math.max(0, fell)).forEach(function (m) { m.alive = false; });
    }
    // kills: every fallen man was felled by an enemy, the strong (and the living) more often
    men.forEach(function (d) { if (d.alive) return; var tbl = men.filter(function (m) { return m.team !== d.team; }).map(function (m) { return [m, m.str * (m.alive ? 1.5 : 1)]; }); if (tbl.length) pickW(r, tbl).kills++; });
    var best = null, score = function (m) { return m.kills * 100 + m.dmg + (m.alive ? 150 : 0); };
    men.forEach(function (m) { m.dmg = Math.round(m.kills * (55 + r() * 45) + 15 + r() * 60 + (m.alive ? 20 : 0)); });
    men.forEach(function (m) { if (!best || score(m) > score(best)) best = m; });
    var npcs = men.map(function (m) {
      var ep = 0; men.forEach(function (o) { if (o.team !== m.team) ep += 0.6 + o.skill / 100; });
      return { name: m.name, team: m.team, kills: m.kills, dmg: m.dmg, alive: m.alive, star: m === best, arch: m.arch, skill: m.skill, enemyPower: +ep.toFixed(2) };
    });
    return { seed: String(seed), venue: pit ? 'pit' : 'colosseum', winner: winner, teams: teams, per: per, size: men.length, npcs: npcs };
  }
  var api = { simulateFight: simulateFight, ARCHS: ARCHS, SHAPES: SHAPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ARENA_SIM = api;
})(typeof window !== 'undefined' ? window : this);
