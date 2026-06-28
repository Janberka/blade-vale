/* Blade Vale — shared world simulation (UMD).
   Runs in BOTH the browser (window.WorldSim) and Node (require('./world-sim')) so the
   character-weighted battle resolver and skill math are written ONCE. Pure & deterministic:
   no DOM, no three.js, no Math.random inside the resolver (callers pass a PRNG). The Node
   server becomes the authority in a later step; today the client calls it directly. */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorldSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SKILL_SCALE = 60, SKILL_CAP = 100;
  // saturating skill curve — the first fights matter most, nobody runs away to infinity
  function effSkill(raw) { return SKILL_CAP * (1 - Math.exp(-Math.max(0, raw || 0) / SKILL_SCALE)); }

  // deterministic PRNG so a given (seed, tick) replays identically on client and server
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function leaderStrike(leader) {
    if (!leader) return 0;
    return effSkill(leader.skills ? leader.skills.strike : leader.strikeRaw);
  }

  // a host's fighting power = headcount^0.95 × troop quality × leadership.
  // the ^0.95 lets a skilled, well-led small band punch above its numbers.
  function bandPower(band) {
    var q = band.quality || 1;
    var L = band.leader
      ? (1 + 0.010 * leaderStrike(band.leader) + 0.006 * Math.sqrt(Math.max(0, band.leader.renown || 0)))
      : 0.9;
    return Math.pow(Math.max(1, band.size), 0.95) * q * L;
  }

  // character-weighted clash: who wins, casualties per side, and whether the losing
  // leader falls (weighted so a skilled commander is more likely to escape the rout).
  function resolveClash(a, b, rnd) {
    rnd = rnd || Math.random;
    var Pa = bandPower(a), Pb = bandPower(b);
    var winA = Math.pow(Pa, 1.8) / (Math.pow(Pa, 1.8) + Math.pow(Pb, 1.8));
    var aWins = rnd() < winA;
    var winner = aWins ? a : b, loser = aWins ? b : a;
    var Pw = aWins ? Pa : Pb, Pl = aWins ? Pb : Pa;
    var ratio = Pw / Math.max(0.001, Pl);
    var loserLossFrac = Math.min(0.92, Math.max(0.55, 0.55 + 0.30 / ratio)); // the broken side bleeds
    var winnerLossFrac = Math.min(0.30, Math.max(0.06, 0.28 / ratio));        // the victor, bloodied
    var pLeaderFalls = 0.08 * loserLossFrac * (1 - 0.004 * leaderStrike(loser.leader));
    return {
      aWins: aWins, winner: winner, loser: loser, winChance: winA,
      winnerLoss: Math.max(1, Math.round(winner.size * winnerLossFrac)),
      loserLoss: Math.max(1, Math.round(loser.size * loserLossFrac)),
      leaderFell: !!(loser.leader && rnd() < pLeaderFalls)
    };
  }

  // ============================================================================
  // Diplomacy + intent kernel (Step 6). Pure & deterministic — same math runs on
  // the server (authority) and the client (solo + between-poll projection), so a
  // given (relations, world snapshot, tick) yields the same relations everywhere.
  // ============================================================================

  // opinion -100..100 → stance, with a hysteresis dead-band so a relation hovering
  // on a boundary doesn't flip every tick.
  var STANCE_TH = { war: -60, hostile: -20, nonaggression: 20, alliance: 60 };
  var STANCE_DEAD = 8;
  var STANCE_RANGE = { // [lo, hi) per stance, in opinion units
    war: [-1000, -60], hostile: [-60, -20], neutral: [-20, 20],
    nonaggression: [20, 60], alliance: [60, 1000]
  };
  function rawStance(o) {
    if (o < STANCE_TH.war) return 'war';
    if (o < STANCE_TH.hostile) return 'hostile';
    if (o < STANCE_TH.nonaggression) return 'neutral';
    if (o < STANCE_TH.alliance) return 'nonaggression';
    return 'alliance';
  }
  function stanceFromOpinion(opinion, prevStance) {
    var raw = rawStance(opinion);
    if (prevStance && prevStance !== raw && STANCE_RANGE[prevStance]) {
      var r = STANCE_RANGE[prevStance];                 // keep prev until we've cleared its
      if (opinion > r[0] - STANCE_DEAD && opinion < r[1] + STANCE_DEAD) return prevStance; // sticky band
    }
    return raw;
  }
  function areEnemies(stance) { return stance === 'war' || stance === 'hostile'; }
  function areAllies(stance) { return stance === 'alliance'; }
  function areNonAggression(stance) { return stance === 'nonaggression' || stance === 'alliance'; }

  // canonical unordered-pair key so the matrix stores ONE row per pair (faction_a < faction_b)
  function canonPair(a, b) { return a <= b ? { a: a, b: b, swapped: false } : { a: b, b: a, swapped: true }; }
  function pairKey(a, b) { var c = canonPair(a, b); return c.a + '' + c.b; }

  function balanceOfPower(factions) {
    var live = factions.filter(function (f) { return f.alive !== 0; });
    var ranked = live.slice().sort(function (x, y) { return y.power - x.power; });
    var sum = 0; for (var i = 0; i < live.length; i++) sum += live[i].power;
    var mean = live.length ? sum / live.length : 0;
    return { ranked: ranked, strongest: ranked[0] || null, weakest: ranked[ranked.length - 1] || null, mean: mean };
  }

  // one diplomacy step. factions:[{name,power,alive,warWeariness,posture}], relations:[{a,b,opinion,stance,truceUntil}].
  // Drivers (all bounded per tick): gang-up on the strong, my-enemy's-enemy bonding, war-weariness pull
  // toward peace, slow mean-reversion of grudges. Returns FULL new relation rows + posture updates +
  // the human-readable transitions worth recording in the chronicle.
  var DIP = { GANG: 0.9, SHARED: 0.5, HEAL: 0.012, WEARY_PULL: 0.8, WEARY_TH: 55, MAX_STEP: 2.0,
    PLAYER: 'Your Banner' };
  function updateDiplomacy(factions, relations, ctx, rnd) {
    ctx = ctx || {}; var tick = ctx.tick || 0;
    var bop = balanceOfPower(factions);
    var powerOf = {}, aliveOf = {}, wearyOf = {};
    for (var i = 0; i < factions.length; i++) { var f = factions[i]; powerOf[f.name] = f.power || 0; aliveOf[f.name] = f.alive !== 0; wearyOf[f.name] = f.warWeariness || 0; }
    // who is at war/hostile with whom (for the shared-enemy bonus)
    var enemiesOf = {};
    for (var r2 = 0; r2 < relations.length; r2++) {
      var rr = relations[r2];
      if (areEnemies(rr.stance)) { (enemiesOf[rr.a] = enemiesOf[rr.a] || {})[rr.b] = 1; (enemiesOf[rr.b] = enemiesOf[rr.b] || {})[rr.a] = 1; }
    }
    var relationUpdates = [], decisions = [], events = [];
    for (var k = 0; k < relations.length; k++) {
      var rel = relations[k], a = rel.a, b = rel.b;
      // the player's standing is earned, not drifted: it moves ONLY on real contact (combat, parley),
      // never from balance-of-power — so an idle/offline player is never ganged up on.
      if (a === DIP.PLAYER || b === DIP.PLAYER) {
        relationUpdates.push({ a: a, b: b, opinion: rel.opinion, stance: rel.stance, truceUntil: rel.truceUntil || 0, changed: false });
        continue;
      }
      var truced = (rel.truceUntil || 0) > tick;
      var d = 0;
      if (aliveOf[a] !== false && aliveOf[b] !== false) {
        // gang-up: the stronger of the pair attracts resentment scaled by how far above the mean it sits
        var strong = powerOf[a] >= powerOf[b] ? a : b;
        var edge = bop.mean > 0 ? (powerOf[strong] - bop.mean) / bop.mean : 0;
        if (edge > 0.1) d -= DIP.GANG * Math.min(1, edge);
        // my enemy's enemy is my friend: bond per shared foe
        var ea = enemiesOf[a] || {}, eb = enemiesOf[b] || {}, shared = 0;
        for (var c in ea) if (eb[c] && c !== a && c !== b) shared++;
        d += DIP.SHARED * shared;
        // exhausted combatants drift back toward peace
        if (areEnemies(rel.stance) && (wearyOf[a] > DIP.WEARY_TH || wearyOf[b] > DIP.WEARY_TH)) d += DIP.WEARY_PULL;
        // grudges fade / friendships cool toward neutral, slowly
        d += (0 - rel.opinion) * DIP.HEAL;
        // a forced truce gently warms and never lets the pair slide deeper into war
        if (truced) d = Math.max(d, 0.4);
      }
      if (d > DIP.MAX_STEP) d = DIP.MAX_STEP; else if (d < -DIP.MAX_STEP) d = -DIP.MAX_STEP;
      var newOpinion = Math.max(-100, Math.min(100, rel.opinion + d));
      var newStance = truced && areEnemies(rawStance(newOpinion)) ? 'neutral' : stanceFromOpinion(newOpinion, rel.stance);
      relationUpdates.push({ a: a, b: b, opinion: newOpinion, stance: newStance, truceUntil: rel.truceUntil || 0, changed: newStance !== rel.stance });
      if (newStance !== rel.stance) {
        var t = transition(a, b, rel.stance, newStance);
        if (t.decision) decisions.push({ kind: t.decision, a: a, b: b });
        events.push({ type: 'diplomacy', summary: t.summary });
      }
    }
    // posture + war-weariness per faction
    var postureUpdates = [];
    for (var p = 0; p < factions.length; p++) {
      var ff = factions[p]; if (ff.alive === 0) continue;
      var atWar = 0, e3 = enemiesOf[ff.name] || {}; for (var x in e3) atWar++;
      var weary = Math.max(0, Math.min(100, (ff.warWeariness || 0) + (atWar > 0 ? 0.6 * atWar : -1.2)));
      var posture = 'consolidate';
      if (powerOf[ff.name] < bop.mean * 0.4) posture = 'desperate';
      else if (powerOf[ff.name] < bop.mean * 0.85 && atWar > 0) posture = 'defend';
      else if (powerOf[ff.name] > bop.mean * 1.2) posture = 'expand';
      postureUpdates.push({ faction: ff.name, posture: posture, warWeariness: weary });
    }
    return { relationUpdates: relationUpdates, decisions: decisions, events: events, postureUpdates: postureUpdates };
  }

  var STANCE_ORDER = { war: 0, hostile: 1, neutral: 2, nonaggression: 3, alliance: 4 };
  function transition(a, b, from, to) {
    var up = STANCE_ORDER[to] > STANCE_ORDER[from];
    if (to === 'war') return { decision: 'declare_war', summary: a + ' declares war on ' + b };
    if (to === 'alliance') return { decision: 'form_alliance', summary: a + ' and ' + b + ' forge an alliance' };
    if (from === 'alliance') return { decision: 'break_alliance', summary: 'The alliance between ' + a + ' and ' + b + ' fractures' };
    if (to === 'nonaggression') return { decision: 'sue_peace', summary: a + ' and ' + b + ' swear non-aggression' };
    if (to === 'hostile' && !up) return { decision: 'sue_peace', summary: a + ' and ' + b + ' pull back from open war' };
    if (to === 'hostile') return { decision: null, summary: a + ' and ' + b + ' eye each other with suspicion' };
    if (to === 'neutral') return { decision: null, summary: a + ' and ' + b + (up ? ' let old grudges fade' : ' cool toward each other') };
    return { decision: null, summary: a + ' and ' + b + ' shift their standing' };
  }

  return {
    SKILL_SCALE: SKILL_SCALE, SKILL_CAP: SKILL_CAP,
    effSkill: effSkill, mulberry32: mulberry32,
    bandPower: bandPower, resolveClash: resolveClash,
    // diplomacy kernel
    stanceFromOpinion: stanceFromOpinion, rawStance: rawStance,
    areEnemies: areEnemies, areAllies: areAllies, areNonAggression: areNonAggression,
    canonPair: canonPair, pairKey: pairKey, balanceOfPower: balanceOfPower,
    updateDiplomacy: updateDiplomacy, STANCE_TH: STANCE_TH
  };
});
