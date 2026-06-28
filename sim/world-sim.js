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

  return {
    SKILL_SCALE: SKILL_SCALE, SKILL_CAP: SKILL_CAP,
    effSkill: effSkill, mulberry32: mulberry32,
    bandPower: bandPower, resolveClash: resolveClash
  };
});
