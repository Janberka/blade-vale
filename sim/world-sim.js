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

  // ---------- Themed opening world ----------
  // Five powers ring an inner sea on the eve of a great upheaval: a vast empire long past its
  // peak, its ancient rival across the eastern water, a surging young power risen from the
  // southern wastes, the war-tribes of the cold north, and a merchant league that profits from
  // every quarrel. The opening alliances/feuds below set that stage; the kernel then drifts them.
  // (Keys are canonical: the two names alphabetically, joined by '|' — see canonPair.)
  var INITIAL_OPINION = {
    'Aurelia|Khorvane':  -35, // two old empires, generations of war, now an exhausted, wary lull
    'Aurelia|Maridor':    62, // the empire and the sea-league, bound by trade — a standing alliance
    'Aurelia|Sahir':     -75, // the surge tears the empire's southern provinces away — open war
    'Aurelia|Wendmark':  -55, // the northern tribes gnaw at the frayed frontier
    'Khorvane|Maridor':   28, // trade across the eastern water — a non-aggression understanding
    'Khorvane|Sahir':    -80, // the eastern empire all but shattered by the rising power
    'Khorvane|Wendmark':   0, // distant, no shared border, no quarrel
    'Maridor|Sahir':     -12, // the surge unsettles the trade lanes; the league stays watchful, neutral
    'Maridor|Wendmark':   24, // the league buys northern furs and hires northern blades
    'Sahir|Wendmark':    -15, // far apart, wary opposites, but not yet at blows
  };
  // opening opinion (-100..100) for a fresh world. Unknown pairs (e.g. an extra nation) open neutral.
  function initialOpinion(a, b) {
    var c = canonPair(a, b);
    var v = INITIAL_OPINION[c.a + '|' + c.b];
    return (typeof v === 'number') ? v : 0;
  }

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

  // ============================================================================
  // Destiny engine (Step 7). Pure & deterministic — the same math runs on the server
  // (authority) and the client (projection), so a given (population, world snapshot,
  // tick) yields the same fates everywhere. Reads the WHOLE population + macro state,
  // assigns each character a fated arc (advancing 0..1), then rolls the population up
  // into a world "age". CHRONICLE-ONLY: returns labels + lore + chronicle events,
  // never any mechanical modifier — nothing in combat/marching/diplomacy reads it.
  // ============================================================================
  var DESTINY_TITLES = {
    conqueror: 'Conqueror', champion: 'Champion of the Vale', kingslayer: 'Kingslayer',
    bulwark: 'The Bulwark', dynast: 'Founder of a Line', betrayer: 'The Faithless',
    doomed: 'The Doomed', wanderer: 'The Unremembered'
  };
  var AGE_TITLES = {
    age_of_ambition: 'The Age of Ambition', age_of_blood: 'The Age of Blood',
    the_uniting: 'The Uniting', the_long_dusk: 'The Long Dusk', the_long_peace: 'The Long Peace'
  };
  function destinyTitle(k) { return DESTINY_TITLES[k] || DESTINY_TITLES.wanderer; }
  function ageTitle(k) { return AGE_TITLES[k] || AGE_TITLES.age_of_ambition; }

  var DST = { FATE_STEP: 0.06, FATE_WOVEN: 0.35, FULFILL_TH: 0.85, SWITCH_MARGIN: 0.10,
    AGE_SWITCH_TH: 0.30, WANDER_FLOOR: 0.18 };
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  // saturating 0..1 — diminishing returns, nobody runs to infinity (same spirit as effSkill)
  function sat(x, scale) { return 1 - Math.exp(-Math.max(0, x || 0) / scale); }

  // score every eligible archetype for one character → {key: score in ~0..1}.
  // Player/warband (kind 'char') are scored from their OWN deeds only — their fate is never
  // dragged down by their banner's weakness (mirrors diplomacy's "the player's standing is earned").
  function destinyScores(ch, world) {
    var p = ch.personality || {};
    var amb = p.ambition != null ? p.ambition : 0.5;
    var cau = p.caution != null ? p.caution : 0.5;
    var ven = p.vengeance != null ? p.vengeance : 0.5;
    var loy01 = ch.loyalty != null ? clamp01(ch.loyalty / 100) : (p.loyalty != null ? p.loyalty : 0.6);
    var R = sat(ch.renown, 150), K = sat(ch.kills, 40), W = sat(ch.battlesWon, 20), S = sat(ch.size, 50);
    var isChar = ch.kind === 'char';
    var mean = world.mean || 1;
    var fpow = isChar ? 1 : ((world.powerOf[ch.faction] || 0) / (mean || 1));
    var weak = isChar ? 0 : clamp01(1 - fpow), strong = clamp01(fpow - 1);
    var posture = isChar ? 'consolidate' : (world.postureOf[ch.faction] || 'consolidate');
    var holdsCap = isChar ? 0 : ((world.capsOf[ch.faction] || 0) > 0 ? 1 : 0);
    var alive = isChar ? 1 : (world.aliveOf[ch.faction] === false ? 0 : 1);
    var age01 = (ch.bornTick != null && world.tick != null) ? sat(world.tick - ch.bornTick, 400) : R;

    var s = {};
    s.champion = clamp01(0.42 * R + 0.30 * W + 0.22 * K);            // earned in the field
    s.kingslayer = clamp01(0.55 * K + 0.28 * ven + 0.18 * W - 0.25 * S); // a feller of leaders, not a host-general
    s.wanderer = DST.WANDER_FLOOR;
    if (!isChar) {                                   // arcs that need a host / a banner / a holdfast
      // a faction holds its own capital by default, so holdsCap alone is no signal — the real
      // "we are on the defensive" cue is the DEFEND posture; that (not mere ownership) makes a bulwark.
      s.conqueror = clamp01(0.40 * S + 0.26 * R + 0.22 * amb + (posture === 'expand' ? 0.18 : 0) + 0.16 * strong);
      s.bulwark = clamp01((posture === 'defend' ? 0.34 : 0) + 0.28 * cau + 0.18 * holdsCap + 0.14 * R + 0.10 * weak);
      s.dynast = clamp01(0.45 * age01 + 0.20 * holdsCap + 0.15 * alive + 0.12 * R - 0.30 * weak); // an old, enduring name
      s.betrayer = clamp01(0.48 * (1 - loy01) + 0.34 * amb + 0.20 * weak - 0.20 * holdsCap);
      s.doomed = clamp01(0.42 * weak + 0.30 * (posture === 'desperate' ? 1 : 0) + 0.30 * (1 - S) - 0.40 * R);
    }
    return s;
  }
  function bestDestiny(scores) {
    var bk = 'wanderer', bs = -1;
    for (var k in scores) if (scores[k] > bs) { bs = scores[k]; bk = k; }
    return { key: bk, score: bs };
  }

  // the world age, from population-wide aggregates + balance of power. Sticky: it holds the
  // previous age until a rival reading's momentum clears a floor, so it doesn't flicker each tick.
  function ageOf(world, prevAge) {
    var conc = world.totalCaps ? (world.strongestShareCaps || 0) : 0; // strongest's share of all holds
    var nA = world.nationsAlive != null ? world.nationsAlive : 5;
    var wars = world.warPairs || 0;
    var age, mom;
    if (conc >= 0.6) { age = 'the_uniting'; mom = clamp01(conc); }
    else if (nA <= 2) { age = 'the_long_dusk'; mom = clamp01((5 - nA) / 4); }
    else if (wars >= 4) { age = 'age_of_blood'; mom = clamp01(wars / 6); }
    else if (wars === 0) { age = 'the_long_peace'; mom = 0.5; }
    else { age = 'age_of_ambition'; mom = clamp01(0.3 + wars / 8); }
    var changed = false;
    if (prevAge && prevAge !== age && mom < DST.AGE_SWITCH_TH) age = prevAge;  // hold until momentum builds
    else if (prevAge !== age) changed = true;
    return { age: age, momentum: mom, changed: changed };
  }
  function prophecyLine(age, top) {
    if (!top) return ageTitle(age) + ' settles over a silent vale.';
    var who = top.name + ' of ' + top.faction + ', marked as ' + destinyTitle(top.destiny);
    switch (age) {
      case 'age_of_blood': return 'The vale runs red — ' + who + '.';
      case 'the_uniting': return 'One crown nears — ' + who + '.';
      case 'the_long_dusk': return 'The long dusk falls — ' + who + '.';
      case 'the_long_peace': return 'A wary peace holds — ' + who + '.';
      default: return 'An age of ambition dawns — ' + who + '.';
    }
  }

  // one destiny step over the whole population.
  // characters: [{id, kind:'warlord'|'char', name, faction, renown, kills, battlesWon, size,
  //               bornTick, personality:{ambition,caution,loyalty,vengeance}, loyalty, destiny, fate}]
  // world: { tick, mean, powerOf, postureOf, aliveOf, capsOf, totalCaps, strongestShareCaps,
  //          nationsAlive, warPairs, prevAge }
  // Returns ONLY the character rows worth persisting, the new world destiny, and chronicle events.
  function computeDestiny(characters, world, ctx, rnd) {
    ctx = ctx || {}; rnd = rnd || Math.random; world = world || {};
    world.powerOf = world.powerOf || {}; world.postureOf = world.postureOf || {};
    world.aliveOf = world.aliveOf || {}; world.capsOf = world.capsOf || {};
    var charUpdates = [], events = [], top = null;
    for (var i = 0; i < characters.length; i++) {
      var ch = characters[i];
      var jitter = (rnd() - 0.5) * 1e-6;             // deterministic tie-break, one draw per char in load order
      var scores = destinyScores(ch, world);
      var best = bestDestiny(scores); best.score += jitter;
      var oldKey = ch.destiny || 'wanderer', oldFate = ch.fate || 0;
      var curScore = scores[oldKey] != null ? scores[oldKey] : -1;
      // hysteresis: keep the current arc unless a rival clears it by a margin
      var key = (best.key !== oldKey && best.score > curScore + DST.SWITCH_MARGIN) ? best.key : oldKey;
      var target = scores[key] != null ? scores[key] : best.score;
      var df = target - oldFate; if (df > DST.FATE_STEP) df = DST.FATE_STEP; else if (df < -DST.FATE_STEP) df = -DST.FATE_STEP;
      var fate = clamp01(oldFate + df);              // fate eases toward the strength of the chosen arc
      // chronicle milestones, gated by FATE (the measure of how marked one is) so each fires once as
      // a fate climbs — wanderers (fate near the floor) never trip them, so the log isn't spammed.
      var nonWander = key !== 'wanderer';
      if (nonWander && oldFate < DST.FATE_WOVEN && fate >= DST.FATE_WOVEN)
        events.push({ type: 'destiny', summary: 'A fate settles on ' + ch.name + ' of ' + ch.faction + ' — ' + destinyTitle(key) });
      if (nonWander && oldFate < DST.FULFILL_TH && fate >= DST.FULFILL_TH)
        events.push({ type: 'destiny', summary: 'The prophecy holds — ' + ch.name + ' of ' + ch.faction + ' is become ' + destinyTitle(key) });
      if (key !== oldKey || Math.abs(fate - oldFate) > 0.01) charUpdates.push({ id: ch.id, kind: ch.kind, destiny: key, fate: fate });
      // the prophecy's standard-bearer = the most-fated non-wanderer (renown breaks early ties before fate builds)
      var rank = nonWander ? (fate * 0.7 + sat(ch.renown, 150) * 0.3) : -1;
      if (rank >= 0 && (!top || rank > top._r)) top = { name: ch.name, faction: ch.faction, destiny: key, _r: rank };
    }
    var a = ageOf(world, world.prevAge);
    if (a.changed) events.push({ type: 'age', summary: 'The age turns: ' + ageTitle(a.age) });
    return { charUpdates: charUpdates, world: { age: a.age, prophecy: prophecyLine(a.age, top), momentum: a.momentum, changed: a.changed }, events: events };
  }

  return {
    SKILL_SCALE: SKILL_SCALE, SKILL_CAP: SKILL_CAP,
    effSkill: effSkill, mulberry32: mulberry32,
    bandPower: bandPower, resolveClash: resolveClash,
    // diplomacy kernel
    stanceFromOpinion: stanceFromOpinion, rawStance: rawStance,
    areEnemies: areEnemies, areAllies: areAllies, areNonAggression: areNonAggression,
    canonPair: canonPair, pairKey: pairKey, balanceOfPower: balanceOfPower,
    initialOpinion: initialOpinion,
    updateDiplomacy: updateDiplomacy, STANCE_TH: STANCE_TH,
    // destiny kernel
    computeDestiny: computeDestiny, destinyTitle: destinyTitle, ageTitle: ageTitle,
    DESTINY_TITLES: DESTINY_TITLES, AGE_TITLES: AGE_TITLES
  };
});
