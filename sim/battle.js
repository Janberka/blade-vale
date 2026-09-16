/* Blade Vale — headless tactical battle KERNEL (UMD).
   The same commander-led valley battle the ?battle editor plays, but pure: no THREE, no DOM, no
   rendering. Runs in Node (self-play / training) and in the browser (the editor renders on top).
   Deterministic: one seeded RNG per battle, so (seed, policies) replays identically.

   Two learning tiers plug in as GENOMES (plain weight objects, default = current hand-tuned feel):
     θ_C  commander  — doctrine choice, temperament, lead-vs-watch, in-battle order thresholds
     θ_S  soldier    — per-man tactics: reach/press/leash, target choice, nerve, archery; plus
                       per-INDIVIDUAL trait sampling so soldiers vary and can be selected.
   Distress-driven exploration: a side that is losing badly raises an exploration temperature τ that
   makes its commander and soldiers "try new things" mid-battle. Every battle emits a record (features
   + timeline + outcome) AND per-soldier samples (survived / kills / damage / held-formation) — the
   training signal for sim/trainer.js. See ~/.claude/plans/how-to-build-a-dynamic-torvalds.md. */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BattleKernel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- small pure helpers ----------
  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  // ---------- genomes: default = the shipped constants; params perturb around a neutral point ----------
  // Soldier genome — multiplicative *Mul (neutral 1) / additive *Delta (neutral 0) around a base table.
  var SOLDIER_BASE = {
    reach: 2.3, move: 4.6, windMin: 0.28, windMax: 0.55, rec: 0.36, coolMin: 0.30, coolMax: 0.9,
    dmgMin: 8, dmgMax: 16, flinch: 0.30, knock: 0.22, deathDur: 1.1, hpMin: 34, hpMax: 54,
    gapX: 3.2, gapZ: 3.0, frontStand: 34, marchSpeed: 3.6, contactGap: 3.2, leash: 4.2, percept: 9, bodyR: 1.15,
    mBreak: 0.30, mRally: 0.60, senseR: 8, fallbackDepth: 16, fallbackSpeed: 6.2, hitShock: 0.14, allyDeathShock: 0.05,
    mBase: 0.12, mLocal: 0.48, mHp: 0.22, mArmy: 0.24, mOutnumber: 0.15,
    archRange: 60, archMin: 11, archCdMin: 1.6, archCdMax: 2.7, archDraw: 0.55, archSpeed: 47, archDmgMin: 9, archDmgMax: 17, archHpMul: 0.8,
    archStand: 0.75, archBehind: 8, archGrav: 9, archLoftNear: 8 * Math.PI / 180, archLoftFar: 38 * Math.PI / 180, archHitR: 1.3,   // the archers' stand-off (of range) and THE LOB: an arrow flies an arc that climbs with the range and comes down on the mark
  };
  function defaultSoldierGenome() {
    return {
      reachMul: 1, moveMul: 1, leashMul: 1, perceptMul: 1, dmgMul: 1, coolMul: 1, windMul: 1,
      breakDelta: 0, rallyDelta: 0, senseRMul: 1, hitShockMul: 1, fallbackSpeedMul: 1,
      mLocal: SOLDIER_BASE.mLocal, mHp: SOLDIER_BASE.mHp, mArmy: SOLDIER_BASE.mArmy,
      archRangeMul: 1, archCdMul: 1, archDmgMul: 1,
      targetWeak: 0, targetThreat: 0,               // 0 = pick nearest (shipped); >0 favours weak/threatening
      braveryMean: 0, braverySpread: 0.08, aggrMean: 0, aggrSpread: 0.12, // per-individual traits
      exploreGain: 0.5,                             // how hard distress makes a soldier try new tactics
    };
  }
  // resolve a soldier genome into a concrete per-army constant table
  function resolveSoldier(g) {
    g = Object.assign(defaultSoldierGenome(), g || {});
    var B = SOLDIER_BASE;
    return {
      g: g,
      reach: B.reach * g.reachMul, move: B.move * g.moveMul, windMin: B.windMin * g.windMul, windMax: B.windMax * g.windMul,
      rec: B.rec, coolMin: B.coolMin * g.coolMul, coolMax: B.coolMax * g.coolMul,
      dmgMin: B.dmgMin * g.dmgMul, dmgMax: B.dmgMax * g.dmgMul, flinch: B.flinch, knock: B.knock, deathDur: B.deathDur,
      hpMin: B.hpMin, hpMax: B.hpMax,
      gapX: B.gapX, gapZ: B.gapZ, frontStand: B.frontStand, marchSpeed: B.marchSpeed, contactGap: B.contactGap,
      leash: B.leash * g.leashMul, percept: B.percept * g.perceptMul, bodyR: B.bodyR,
      mBreak: clamp(B.mBreak + g.breakDelta, 0.05, 0.6), mRally: clamp(B.mRally + g.rallyDelta, 0.2, 0.9),
      senseR: B.senseR * g.senseRMul, fallbackDepth: B.fallbackDepth, fallbackSpeed: B.fallbackSpeed * g.fallbackSpeedMul,
      hitShock: B.hitShock * g.hitShockMul, allyDeathShock: B.allyDeathShock,
      mBase: B.mBase, mLocal: g.mLocal, mHp: g.mHp, mArmy: g.mArmy, mOutnumber: B.mOutnumber,
      archRange: B.archRange * g.archRangeMul, archMin: B.archMin, archCdMin: B.archCdMin * g.archCdMul, archCdMax: B.archCdMax * g.archCdMul,
      archDraw: B.archDraw, archSpeed: B.archSpeed, archDmgMin: B.archDmgMin * g.archDmgMul, archDmgMax: B.archDmgMax * g.archDmgMul, archHpMul: B.archHpMul,
      archStand: B.archStand, archBehind: B.archBehind, archGrav: B.archGrav, archLoftNear: B.archLoftNear, archLoftFar: B.archLoftFar, archHitR: B.archHitR,
    };
  }
  var DOCTRINES = ['line', 'wings', 'oblique', 'defensive', 'skirmish'];
  function defaultCommanderGenome() {
    return {
      docLogit: { line: 0, wings: 0, oblique: 0, defensive: 0, skirmish: 0 }, doctrineTemp: 1, archerDocCoef: 1.6,
      aggrMean: 0.6, aggrSpread: 0.3, cautMean: 0.55, cautSpread: 0.25, leadBias: 0, leadAggrK: 2.2,
      reserveCommitRatio: 1.02, wingFallbackK: 0.65, centerHoldRatio: 0.5, centerHoldAggr: 0.7,
      brokenFallbackFrac: 0.55, routBase: 0.16, routCautionK: 0.14,
      exploreGain: 0.35,                            // distress → commander gambles a unit onto a fresh order
    };
  }
  function resolveCommander(g) { return Object.assign(defaultCommanderGenome(), g || {}); }

  // ---------- the lob (mirrors game.js arrowLob) ----------
  // An arrow is flown on an ARC, not a line: the loft climbs with the range (a man at ten paces is shot nearly flat; the far
  // mark gets a volley arc that comes DOWN on him) and the launch speed is solved so the arc lands on the mark, uphill or
  // down. Past the bow's power (vmax) the arrow leaves at full speed and falls short.
  function arrowLob(sx, sy, sz, tx, ty, tz, range, vmax, g, loftNear, loftFar) {
    var dx = tx - sx, dz = tz - sz, dy = ty - sy, d = Math.hypot(dx, dz), ux = d > 1e-4 ? dx / d : 0, uz = d > 1e-4 ? dz / d : 1;
    var th = loftNear + (loftFar - loftNear) * clamp(d / range, 0, 1);
    var up = Math.atan2(dy, Math.max(d, 0.5)); if (th < up + 0.15) th = Math.min(up + 0.15, 1.45);
    var c = Math.cos(th), sn = Math.sin(th), dd = Math.max(d, 0.5);
    var v = Math.sqrt(g * dd * dd / (2 * c * c * Math.max(dd * Math.tan(th) - dy, 0.05)));
    if (vmax && v > vmax) v = vmax;
    var flight = dd / (v * c);
    return { vx: ux * v * c, vy: v * sn, vz: uz * v * c, flight: flight, grav: g };
  }

  // ---------- terrain (pure) ----------
  function rollTerrain(rng) {
    var R = rng, t = {
      half: 24 + R() * 12, rise: 52 + R() * 26, peakL: 50 + R() * 30, peakR: 50 + R() * 30,
      freqL: 0.03 + R() * 0.05, phaseL: R() * TAU, ampL: 0.06 + R() * 0.10,
      freqR: 0.03 + R() * 0.05, phaseR: R() * TAU, ampR: 0.06 + R() * 0.10,
      bend: (R() * 2 - 1) * 4, bendFreq: 0.008 + R() * 0.012, floorRough: 0.7 + R() * 1.1, knolls: [],
    };
    var nk = Math.floor(R() * 3);
    for (var i = 0; i < nk; i++) t.knolls.push({ x: (R() * 2 - 1) * t.half * 0.55, z: (R() * 2 - 1) * 26, h: 3 + R() * 5, r: 6 + R() * 6 });
    t.peakRef = Math.max(t.peakL, t.peakR);
    return t;
  }
  function floorCx(T, z) { return T.bend * Math.sin(z * T.bendFreq); }
  function valleyY(T, x, z) {
    var rel = x - floorCx(T, z), ax = Math.abs(rel), right = rel >= 0, peak = right ? T.peakR : T.peakL, h = 0;
    if (ax > T.half) { var tt = Math.min(1, (ax - T.half) / T.rise); h = peak * tt * tt * (3 - 2 * tt); }
    var flank = Math.max(0, Math.min(1, (ax - T.half) / T.rise)), fold = flank * (1 - flank) * 4;
    h += Math.sin(z * (right ? T.freqR : T.freqL) + (right ? T.phaseR : T.phaseL)) * peak * (right ? T.ampR : T.ampL) * fold;
    h += Math.sin(x * 0.08) * Math.cos(z * 0.06) * T.floorRough * (1 - Math.min(1, ax / T.half));
    for (var i = 0; i < T.knolls.length; i++) { var k = T.knolls[i], dx = x - k.x, dz = z - k.z; h += k.h * Math.exp(-(dx * dx + dz * dz) / (2 * k.r * k.r)); }
    return Math.max(0, h);
  }

  // ============================ the battle ============================
  function createBattle(cfg) {
    cfg = cfg || {};
    var seed = (cfg.seed >>> 0) || 1, rng = mulberry32(seed);
    var rand = function (a, b) { return a + (b - a) * rng(); };
    var TEAMS = [{ name: 'A', sign: 1 }, { name: 'B', sign: -1 }];
    var pol = cfg.policies || {};
    var T = rollTerrain(rng);

    var B = {
      terr: T, rng: rng, rand: rand, bodies: [], armies: [], arrows: [], idc: 0,
      phase: 'deploy', deployT: 1.8, over: false, winner: null, t: 0, ticks: 0, teamLive: [[], []],
      // record scratch
      rec: null,
    };
    function rebuildLive() { var la = [], lb = []; for (var i = 0; i < B.bodies.length; i++) { var b = B.bodies[i]; if (b.dead) continue; (b.ti === 0 ? la : lb).push(b); } B.teamLive = [la, lb]; }

    // ---- army composition (seeded; honours cfg overrides) ----
    function armySpec(i) {
      var fixed = cfg.fixed;
      var per = fixed && cfg.per ? cfg.per : (18 + Math.floor(rng() * 60));
      if (cfg.perA != null && i === 0) per = cfg.perA;
      if (cfg.perB != null && i === 1) per = cfg.perB;
      var af = fixed && cfg.archerFrac != null ? cfg.archerFrac : (0.1 + rng() * 0.45);
      if (cfg.archerA != null && i === 0) af = cfg.archerA;
      if (cfg.archerB != null && i === 1) af = cfg.archerB;
      return { per: Math.max(6, per | 0), archerFrac: clamp(af, 0, 0.7) };
    }

    function slot(b) {
      var u = b.unit, cx = floorCx(T, u.az);
      var fwx = Math.sin(u.faceYaw), fwz = Math.cos(u.faceYaw), rgx = Math.cos(u.faceYaw), rgz = -Math.sin(u.faceYaw);
      return { x: u.ax + cx + rgx * b.slotX - fwx * b.slotBack, z: u.az + rgz * b.slotX - fwz * b.slotBack };
    }
    function makeBody(army, unit, slotX, slotBack, role) {
      var S = army.S;
      var maxHp = rand(S.hpMin, S.hpMax) * (role === 'archer' ? S.archHpMul : 1);
      var b = {
        id: B.idc++, team: army.team, ti: army.team === TEAMS[0] ? 0 : 1, army: army, unit: unit, role: role, sign: army.sign,
        x: 0, z: 0, yaw: army.sign > 0 ? 0 : Math.PI, slotX: slotX, slotBack: slotBack,
        phase: rng() * TAU, speed: 0.85 + rng() * 0.35, hp: maxHp, maxHp: maxHp, morale: 1, broken: false, moraleCd: rng() * 0.4,
        state: 'engage', mt: 0, move: null, target: null, shotCd: 0.3 + rng() * 1.8, drawT: 0,
        isCommander: false, watching: false, fleeing: false, dead: false, deadT: 0, flinch: 0,
        // per-individual traits (sampled from the soldier genome) + training tallies
        bravery: S.g.braveryMean + (rng() * 2 - 1) * S.g.braverySpread,
        aggr: S.g.aggrMean + (rng() * 2 - 1) * S.g.aggrSpread,
        kills: 0, dmgDealt: 0, slotDistAcc: 0, slotDistN: 0,
      };
      var s = slot(b); b.x = s.x + (rng() - 0.5) * 0.3; b.z = s.z;
      return b;
    }
    function buildUnit(army, spec) {
      var F = army.sign > 0 ? 0 : Math.PI, S = army.S;
      var u = { army: army, role: spec.role, kind: spec.kind, order: spec.order, sign: army.sign,
                ax: spec.ax, az: spec.az, homeAx: spec.ax, homeAz: spec.az, faceYaw: F, wp: spec.wp || null, bodies: [] };
      army.units.push(u);
      var files = Math.max(3, Math.round(Math.sqrt(spec.count * (spec.role === 'archer' ? 1.4 : 1.9))));
      var ranks = Math.ceil(spec.count / files), idx = 0;
      for (var rk = 0; rk < ranks; rk++) for (var fi = 0; fi < files && idx < spec.count; fi++, idx++) {
        var slotX = (fi - (files - 1) / 2) * S.gapX + (rng() - 0.5) * 0.5;
        var b = makeBody(army, u, slotX, rk * S.gapZ, spec.role);
        u.bodies.push(b); B.bodies.push(b);
      }
      return u;
    }
    // commander plan (θ_C drives doctrine / temperament / lead / deployment)
    function planArmy(army, per, archerFrac) {
      var C = army.C, S = army.S;
      var archers = Math.min(per - 1, Math.round(per * archerFrac)), melee = per - archers;
      var aggression = clamp(C.aggrMean + (rng() * 2 - 1) * C.aggrSpread, 0.05, 0.98);
      var caution = clamp(C.cautMean + (rng() * 2 - 1) * C.cautSpread, 0.05, 0.95);
      // doctrine via softmax over genome logits, archer-heavy hosts biased to defensive/skirmish
      var logit = {}, sum = 0, chosen;
      for (var i = 0; i < DOCTRINES.length; i++) {
        var d = DOCTRINES[i], L = C.docLogit[d] || 0;
        if (d === 'defensive' || d === 'skirmish') L += C.archerDocCoef * (archerFrac - 0.3);
        logit[d] = Math.exp(L / Math.max(0.1, C.doctrineTemp));
        sum += logit[d];
      }
      var roll = rng() * sum, acc = 0;
      for (var j = 0; j < DOCTRINES.length; j++) { acc += logit[DOCTRINES[j]]; if (roll <= acc) { chosen = DOCTRINES[j]; break; } }
      var strategy = chosen || 'line';
      var H = T.half, wing = H * 0.5, sign = army.sign, base = -sign * S.frontStand, fwd = sign, specs = [];
      function add(kind, role, count, ax, az, order, wp) { if (count > 0) specs.push({ kind: kind, role: role, count: count, ax: ax, az: az, order: order, wp: wp || null }); }
      if (strategy === 'line') {
        var res = Math.round(melee * 0.18); add('center', 'melee', melee - res, 0, base, 'advance'); add('reserve', 'melee', res, 0, base - fwd * 11, 'hold');
      } else if (strategy === 'wings') {
        var res2 = Math.round(melee * 0.12), rem = melee - res2, cen = Math.round(rem * 0.5), lw = Math.round((rem - cen) / 2), rw = rem - cen - lw;
        add('center', 'melee', cen, 0, base, 'advance');
        add('left', 'melee', lw, -wing, base - fwd * 3, 'flank', { ax: -H * 0.92, az: base + fwd * 6 });
        add('right', 'melee', rw, wing, base - fwd * 3, 'flank', { ax: H * 0.92, az: base + fwd * 6 });
        add('reserve', 'melee', res2, 0, base - fwd * 12, 'hold');
      } else if (strategy === 'oblique') {
        var strongR = rng() < 0.5, strong = Math.round(melee * 0.5), cen2 = Math.round(melee * 0.32), weak = melee - strong - cen2;
        add('center', 'melee', cen2, 0, base, 'advance');
        add(strongR ? 'right' : 'left', 'melee', strong, strongR ? wing : -wing, base, 'charge');
        add(strongR ? 'left' : 'right', 'melee', weak, strongR ? -wing : wing, base - fwd * 8, 'hold');
      } else if (strategy === 'defensive') {
        var res3 = Math.round(melee * 0.35); add('center', 'melee', melee - res3, 0, base, 'hold'); add('reserve', 'melee', res3, 0, base - fwd * 10, 'hold');
      } else { add('center', 'melee', melee, 0, base - fwd * 6, 'advance'); }
      if (archers > 0) add(strategy === 'skirmish' || strategy === 'defensive' ? 'skirmish' : 'archers', 'archer', archers,
        0, base + fwd * (strategy === 'skirmish' || strategy === 'defensive' ? 4 : -7), 'skirmish');
      var lead = strategy !== 'defensive' && rng() < sigmoid(C.leadBias + C.leadAggrK * (aggression - 0.5));
      return { strategy: strategy, aggression: aggression, caution: caution, lead: lead, specs: specs };
    }
    function addCommander(army, plan) {
      var cen = null, S = army.S;
      for (var i = 0; i < army.units.length; i++) { var u = army.units[i]; if (u.kind === 'center') { cen = u; break; } if (!cen && u.role === 'melee') cen = u; }
      var sign = army.sign, base = -sign * S.frontStand;
      var cu = { army: army, role: 'melee', kind: 'command', order: plan.lead ? 'advance' : 'hold', sign: sign,
                 ax: 0, az: plan.lead ? base + sign * 2 : base - sign * 22, homeAx: 0, homeAz: base - sign * 22,
                 faceYaw: sign > 0 ? 0 : Math.PI, wp: null, bodies: [] };
      army.units.push(cu);
      var c = makeBody(army, cu, 0, 0, 'melee');
      c.isCommander = true; c.watching = !plan.lead; c.maxHp *= 2.2; c.hp = c.maxHp; c.speed *= 0.95;
      cu.bodies.push(c); B.bodies.push(c); army.commander = c;
      return c;
    }
    function raiseArmy(team, spec) {
      var army = { team: team, sign: team.sign, start: 0, alive: 0, units: [], commander: null,
                   cmd: null, routing: false, thinkCd: 1.0, distress: 0,
                   S: resolveSoldier((pol[team.name] || {}).soldier), C: resolveCommander((pol[team.name] || {}).commander) };
      B.armies.push(army);
      var plan = planArmy(army, spec.per, spec.archerFrac);
      army.cmd = { aggression: plan.aggression, caution: plan.caution, lead: plan.lead, strategy: plan.strategy };
      for (var i = 0; i < plan.specs.length; i++) buildUnit(army, plan.specs[i]);
      addCommander(army, plan);
      var n = 0; for (var j = 0; j < B.bodies.length; j++) if (B.bodies[j].army === army) n++;
      army.start = army.alive = n;
      return army;
    }

    // ---------- per-frame sim ----------
    function nearestEnemyWithin(b, R) {
      var S = b.army.S, best = null, R2 = R * R, bd = R2, foes = B.teamLive[b.ti ^ 1];
      // exploration: a distressed soldier sometimes lunges at a RANDOM foe instead of the best one
      var explore = b.army.distress * S.g.exploreGain > rng();
      var pool = explore ? [] : null;
      for (var i = 0; i < foes.length; i++) {
        var o = foes[i]; if (o.dead) continue;
        var dx = o.x - b.x, dz = o.z - b.z, d = dx * dx + dz * dz; if (d >= R2) continue;
        if (explore) { pool.push(o); continue; }
        var score = d - S.g.targetWeak * (1 - o.hp / o.maxHp) * 40 - S.g.targetThreat * (o.target === b ? 25 : 0);
        if (score < bd) { bd = score; best = o; }
      }
      if (explore && pool.length) return pool[(rng() * pool.length) | 0];
      return best;
    }
    function assessMorale(b) {
      var S = b.army.S, friends = 0, foes = 0, R2 = S.senseR * S.senseR, mine = B.teamLive[b.ti], enemy = B.teamLive[b.ti ^ 1], i, o, dx, dz;
      for (i = 0; i < mine.length; i++) { o = mine[i]; if (o.dead || o === b) continue; dx = o.x - b.x; dz = o.z - b.z; if (dx * dx + dz * dz <= R2) friends++; }
      for (i = 0; i < enemy.length; i++) { o = enemy[i]; if (o.dead) continue; dx = o.x - b.x; dz = o.z - b.z; if (dx * dx + dz * dz <= R2) foes++; }
      var localBal = (friends + 1) / (friends + foes + 1), hpFrac = clamp(b.hp / b.maxHp, 0, 1);
      var armyFrac = b.army.start ? b.army.alive / b.army.start : 1;
      var target = clamp(S.mBase + S.mLocal * localBal + S.mHp * hpFrac + S.mArmy * armyFrac + b.bravery, 0, 1);
      if (foes > friends + 1) target -= S.mOutnumber;
      var k = target < b.morale ? 0.6 : 0.28;
      b.morale = clamp(b.morale + (target - b.morale) * k, 0, 1);
      if (!b.broken && b.morale < S.mBreak) b.broken = true;
      else if (b.broken && b.morale > S.mRally) b.broken = false;
    }
    function damage(t, amt, fx, fz, from) {
      var S = t.army.S;
      t.hp -= amt; t.flinch = Math.max(t.flinch, S.flinch); t.morale = Math.max(0, t.morale - S.hitShock);
      var dx = t.x - fx, dz = t.z - fz, dd = Math.hypot(dx, dz) || 1e-4;
      t.x += dx / dd * S.knock; t.z += dz / dd * S.knock;
      if (from) from.dmgDealt += amt;
      if (t.hp <= 0 && !t.dead) {
        t.dead = true; t.deadT = 0; t.target = null; if (from) from.kills++;
        if (t.isCommander) { t.army.commander = null; logEvent('commander-down', t.team.name);
          for (var i = 0; i < B.bodies.length; i++) { var o = B.bodies[i]; if (!o.dead && o.army === t.army) o.morale = Math.max(0, o.morale - 0.32); }
        } else for (var j = 0; j < B.bodies.length; j++) { var o2 = B.bodies[j]; if (o2.dead || o2.team !== t.team) continue; var ddx = o2.x - t.x, ddz = o2.z - t.z; if (ddx * ddx + ddz * ddz < 36) o2.morale = Math.max(0, o2.morale - S.allyDeathShock); }
      }
    }
    function moveToward(b, tx, tz, dt, spd) { var dx = tx - b.x, dz = tz - b.z, dd = Math.hypot(dx, dz); if (dd > 1e-3) { var step = Math.min(spd * dt, dd); b.x += dx / dd * step; b.z += dz / dd * step; b.yaw = Math.atan2(dx, dz); } return dd; }
    function meleeCycle(b, t, dd, reach, dt) {
      var S = b.army.S; b.mt -= dt;
      if (b.state === 'engage') { if (b.mt <= 0) { b.state = 'windup'; b.mt = rand(S.windMin, S.windMax); } }
      else if (b.state === 'windup') { if (b.mt <= 0) { if (!t.dead && dd <= reach * 1.2) damage(t, rand(S.dmgMin, S.dmgMax), b.x, b.z, b); b.state = 'recover'; b.mt = S.rec; } }
      else { if (b.mt <= 0) { b.state = 'engage'; b.mt = rand(S.coolMin, S.coolMax); } }
    }
    function stepMelee(b, dt, s) {
      var S = b.army.S;
      if (b.flinch > 0) { b.flinch -= dt; b.state = 'engage'; b.mt = rand(0.15, 0.4); return; }
      var retreating = b.unit.order === 'fallback', leash = (b.unit.order === 'charge' ? S.leash * 1.9 : S.leash) * (1 + 0.4 * b.aggr);
      var t = retreating ? null : nearestEnemyWithin(b, S.percept);
      if (t) {
        var dx = t.x - b.x, dz = t.z - b.z, dd = Math.hypot(dx, dz) || 1e-4; b.yaw = Math.atan2(dx, dz); b.target = t;
        var reach = S.reach; if (dd <= reach) { meleeCycle(b, t, dd, reach, dt); return; }
        var step = Math.min(S.move * b.speed * dt, dd - reach * 0.85), nx = b.x + dx / dd * step, nz = b.z + dz / dd * step;
        if (Math.hypot(nx - s.x, nz - s.z) <= leash) { b.x = nx; b.z = nz; b.state = 'engage'; b.mt = 0; return; }
      }
      var rem = moveToward(b, s.x, s.z, dt, S.marchSpeed * b.speed); if (rem < 0.2) b.yaw = b.unit.faceYaw;
    }
    function stepArcher(b, dt, s) {
      var S = b.army.S, threat = nearestEnemyWithin(b, S.archMin);
      if (threat) { moveToward(b, s.x, s.z - b.army.sign * 7, dt, S.move * b.speed); b.yaw = Math.atan2(threat.x - b.x, threat.z - b.z); b.drawT = 0; return; }
      if (moveToward(b, s.x, s.z, dt, S.marchSpeed * b.speed) > 0.3) return;
      var foe = nearestEnemyWithin(b, S.archRange); if (!foe) return;
      b.yaw = Math.atan2(foe.x - b.x, foe.z - b.z);
      if (b.drawT > 0) { b.drawT -= dt; if (b.drawT <= 0) { shootArrow(b, foe); b.shotCd = rand(S.archCdMin, S.archCdMax); } }
      else if ((b.shotCd -= dt) <= 0) { b.drawT = S.archDraw; }
    }
    function stepFallback(b, dt, s) { var S = b.army.S; moveToward(b, s.x, s.z - b.army.sign * S.fallbackDepth, dt, S.fallbackSpeed * b.speed); }
    function stepCommanderWatch(b, dt) {
      var S = b.army.S, u = b.unit, cx = floorCx(T, u.az);
      b.fleeing = b.army.alive < b.army.start * 0.22;
      var tz = b.fleeing ? u.az - b.army.sign * 46 : u.az;
      var rem = moveToward(b, u.ax + cx, tz, dt, (b.fleeing ? S.fallbackSpeed : S.marchSpeed) * b.speed);
      if (rem < 0.3) b.yaw = b.army.sign > 0 ? 0 : Math.PI;
    }
    function stepBody(b, dt) {
      if (b.dead) { b.deadT += dt; return; }
      if (dt > 1e-4) { b.vx = (b.x - (b.px != null ? b.px : b.x)) / dt; b.vz = (b.z - (b.pz != null ? b.pz : b.z)) / dt; } b.px = b.x; b.pz = b.z;   // his pace over the last tick — what an archer leads him by
      if (b.isCommander && b.watching) { stepCommanderWatch(b, dt); return; }
      if ((b.moraleCd -= dt) <= 0) { assessMorale(b); b.moraleCd = rand(0.3, 0.55); }
      var s = slot(b);
      // training telemetry: how well did this man keep his commanded position?
      var sdx = b.x - s.x, sdz = b.z - s.z; b.slotDistAcc += Math.sqrt(sdx * sdx + sdz * sdz); b.slotDistN++;
      if (b.broken) stepFallback(b, dt, s);
      else if (b.role === 'archer') stepArcher(b, dt, s);
      else stepMelee(b, dt, s);
    }

    // ---- arrows (ballistic, pure) ----
    function shootArrow(from, target) {
      var S = from.army.S, sx = from.x, sy = valleyY(T, from.x, from.z) + 1.6, sz = from.z;
      var lob = function (tx, tz) { return arrowLob(sx, sy, sz, tx, valleyY(T, tx, tz) + 1.1, tz, S.archRange, S.archSpeed, S.archGrav, S.archLoftNear, S.archLoftFar); };
      // a lobbed arrow hangs for seconds: the mark is where the man WILL be (his last tick's pace, damped), solved twice
      var tx = target.x, tz = target.z, L = lob(tx, tz);
      if (target.vx || target.vz) for (var i = 0; i < 2; i++) { tx = target.x + (target.vx || 0) * L.flight * 0.85; tz = target.z + (target.vz || 0) * L.flight * 0.85; L = lob(tx, tz); }
      B.arrows.push({ x: sx, y: sy, z: sz, vx: L.vx, vy: L.vy, vz: L.vz,
                      grav: L.grav, team: from.team, ti: from.ti, from: from, target: target, dmg: rand(S.archDmgMin, S.archDmgMax), life: L.flight + 0.6 });
    }
    // an arrow coming down through head height hits whoever stands there: the mark first, else any foe under the fall
    function arrowVictim(a, gy) {
      if (Math.abs(a.y - (gy + 1.1)) >= 1.8) return null;
      var R2 = a.from.army.S.archHitR * a.from.army.S.archHitR, t = a.target;
      if (t && !t.dead) { var dx = t.x - a.x, dz = t.z - a.z; if (dx * dx + dz * dz < R2) return t; }
      var foes = B.teamLive[a.ti ^ 1];
      for (var i = 0; i < foes.length; i++) { var o = foes[i]; if (o.dead) continue; var ox = o.x - a.x, oz = o.z - a.z; if (ox * ox + oz * oz < R2) return o; }
      return null;
    }
    function stepArrows(dt) {
      for (var i = B.arrows.length - 1; i >= 0; i--) {
        var a = B.arrows[i]; a.vy -= a.grav * dt; a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt; a.life -= dt;
        var gy = valleyY(T, a.x, a.z), done = a.life <= 0 || a.y <= gy;
        if (!done && a.y < gy + 2.9) { var v = arrowVictim(a, gy); if (v) { damage(v, a.dmg, a.x - a.vx * 0.02, a.z - a.vz * 0.02, a.from); done = true; } }
        if (done) B.arrows.splice(i, 1);
      }
    }

    // ---- commander maneuver + think ----
    function unitAlive(u) { var n = 0; for (var i = 0; i < u.bodies.length; i++) if (!u.bodies[i].dead) n++; return n; }
    // the line a kiting archer division stops at: archBehind behind its army's rearmost living sword division (null: no swords left — it kites free).
    // Kiting at march pace from a line advancing at march pace was a chase nobody won: the fight ran to the clock.
    function rearLine(A, S) {
      var rear = null;
      for (var i = 0; i < A.units.length; i++) { var v = A.units[i]; if (v.role !== 'melee' || v.kind === 'command' || !unitAlive(v)) continue; if (rear == null || (v.az - rear) * A.sign < 0) rear = v.az; }
      return rear == null ? null : rear - A.sign * S.archBehind;
    }
    function advanceUnits(dt) {
      if (B.phase !== 'battle') return;
      var S0 = B.armies[0].S; // marchSpeed shared feel
      for (var ai = 0; ai < B.armies.length; ai++) for (var ui = 0; ui < B.armies[ai].units.length; ui++) { var u = B.armies[ai].units[ui]; u.wx = u.ax + floorCx(T, u.az); u.wz = u.az; }
      for (var a = 0; a < B.armies.length; a++) {
        var A = B.armies[a], S = A.S;
        for (var k = 0; k < A.units.length; k++) {
          var u = A.units[k]; if (!unitAlive(u)) continue;
          var en = null, ed = Infinity;
          for (var b2 = 0; b2 < B.armies.length; b2++) { if (B.armies[b2] === A) continue; var Bu = B.armies[b2].units; for (var vi = 0; vi < Bu.length; vi++) { var v = Bu[vi]; if (!unitAlive(v)) continue; var dx = v.wx - u.wx, dz = v.wz - u.wz, d = dx * dx + dz * dz; if (d < ed) { ed = d; en = v; } } }
          if (!en) continue;
          var bx = en.wx - u.wx, bz = en.wz - u.wz, bd = Math.hypot(bx, bz) || 1e-4, bearing = Math.atan2(bx, bz), M = S.marchSpeed;
          var da = bearing - u.faceYaw; da = Math.atan2(Math.sin(da), Math.cos(da)); u.faceYaw += da * Math.min(1, dt * 2.5);
          switch (u.order) {
            case 'hold': u.ax += (u.homeAx - u.ax) * Math.min(1, dt); u.az += (u.homeAz - u.az) * Math.min(1, dt); break;
            case 'advance': if (bd > S.contactGap + 3) { u.az += (bz / bd) * M * dt; u.ax += (bx / bd) * M * dt * 0.4; } break;
            case 'charge': if (bd > S.contactGap + 1) { u.az += (bz / bd) * M * 1.7 * dt; u.ax += (bx / bd) * M * 1.7 * dt; } break;
            case 'flank': if (u.wp) { var wx = u.wp.ax - u.ax, wz = u.wp.az - u.az, wd = Math.hypot(wx, wz); if (wd < 3) { u.order = 'charge'; u.wp = null; } else { u.ax += (wx / wd) * M * 1.15 * dt; u.az += (wz / wd) * M * 1.15 * dt; } } else u.order = 'charge'; break;
            case 'fallback': u.az -= A.sign * S.fallbackSpeed * 0.6 * dt; break;
            case 'skirmish': var stand = S.archRange * S.archStand;   // the bows stay behind and try the long shot: they give ground down to archBehind behind their own rearmost swords, and no further
              if (bd < stand - 2) { var rear = rearLine(A, S); u.az -= (bz / bd) * M * dt; if (rear != null && (u.az - rear) * A.sign < 0) u.az = rear; }
              else if (bd > stand + 3) u.az += (bz / bd) * M * 0.7 * dt; break;
          }
        }
      }
    }
    // when a losing side "tries new things" it GAMBLES aggressively (a desperate press), not passivity —
    // this both matches the intent and keeps the battle decisive instead of grinding to a stalemate.
    var ORDERS_EXPLORE = ['charge', 'charge', 'flank', 'advance', 'hold'];
    function commanderThink(A) {
      if (B.phase !== 'battle') return;
      var C = A.C, other = B.armies[0] === A ? B.armies[1] : B.armies[0]; if (!other) return;
      var my = A.alive, foe = other.alive, ratio = my / (foe + 1), p = A.cmd, tau = A.distress * C.exploreGain;
      // a wise leader refuses a hopeless fight: badly outnumbered while still largely intact → withdraw and
      // save the men (extracting the army in good order is scored as HIS win, not a rout).
      if (!A.withdrawing && ratio < 0.42 && my > A.start * 0.68) A.withdrawing = true;
      if (A.withdrawing) { for (var wi = 0; wi < A.units.length; wi++) { var wu = A.units[wi]; if (wu.kind !== 'command') wu.order = 'fallback'; } return; }
      var winningBig = ratio > 1.12 || foe < A.start * 0.5;  // the moment he holds an edge — press to finish it fast
      var weakFriend = false;
      for (var i = 0; i < A.units.length; i++) { var x = A.units[i]; if (x.role === 'melee' && x.kind !== 'command') { var al = unitAlive(x); if (al > 0 && al < x.bodies.length * 0.4) { weakFriend = true; break; } } }
      for (var u2 = 0; u2 < A.units.length; u2++) {
        var u = A.units[u2], alive = unitAlive(u); if (!alive || u.kind === 'command') continue;
        if (u.role === 'archer') { u.order = 'skirmish'; continue; }
        var broken = 0; for (var bi = 0; bi < u.bodies.length; bi++) { var bb = u.bodies[bi]; if (!bb.dead && bb.broken) broken++; }
        if (broken > alive * C.brokenFallbackFrac) { u.order = 'fallback'; continue; }
        if (winningBig) { u.order = u.wp ? 'flank' : 'charge'; continue; }                       // press hard to finish quickly
        // distress exploration: a losing commander sometimes gambles a unit onto a fresh order
        if (tau > rng()) { u.order = ORDERS_EXPLORE[(rng() * ORDERS_EXPLORE.length) | 0]; continue; }
        if (u.kind === 'reserve') { u.order = (ratio > C.reserveCommitRatio || foe < A.start * 0.55 || weakFriend) ? 'charge' : 'hold'; continue; }
        if (u.kind === 'left' || u.kind === 'right') { u.order = ratio < C.wingFallbackK * p.caution ? 'fallback' : u.wp ? 'flank' : 'charge'; continue; }
        u.order = (ratio < C.centerHoldRatio && p.aggression < C.centerHoldAggr) ? 'hold' : 'advance';
      }
      A.routing = my < A.start * (C.routBase + C.routCautionK * p.caution);
      if (A.routing) for (var r2 = 0; r2 < A.units.length; r2++) { var ru = A.units[r2]; if (ru.role !== 'archer' && ru.kind !== 'command') ru.order = 'fallback'; }
    }

    // ---- shove pass ----
    var grid = {};
    function separate() {
      var R = B.armies[0].S.bodyR, cs = R; grid = {};
      for (var i = 0; i < B.bodies.length; i++) { var b = B.bodies[i]; if (b.dead) continue; b._cx = Math.floor(b.x / cs); b._cz = Math.floor(b.z / cs); var key = b._cx + ':' + b._cz; (grid[key] || (grid[key] = [])).push(b); }
      for (var j = 0; j < B.bodies.length; j++) {
        var b1 = B.bodies[j]; if (b1.dead) continue;
        for (var ox = -1; ox <= 1; ox++) for (var oz = -1; oz <= 1; oz++) {
          var arr = grid[(b1._cx + ox) + ':' + (b1._cz + oz)]; if (!arr) continue;
          for (var m = 0; m < arr.length; m++) {
            var o = arr[m]; if (o.id <= b1.id) continue;
            var dx = o.x - b1.x, dz = o.z - b1.z, d2 = dx * dx + dz * dz; if (d2 >= R * R || d2 < 1e-6) continue;
            var d = Math.sqrt(d2), overlap = R - d, nx = dx / d, nz = dz / d;
            b1.x -= nx * overlap * 0.5; b1.z -= nz * overlap * 0.5; o.x += nx * overlap * 0.5; o.z += nz * overlap * 0.5;
          }
        }
      }
    }

    // ---- counts, distress, records ----
    function counts() {
      var a = 0, c = 0; for (var i = 0; i < B.armies.length; i++) { B.armies[i].alive = 0; B.armies[i]._sx = 0; B.armies[i]._sz = 0; }
      for (var j = 0; j < B.bodies.length; j++) { var b = B.bodies[j]; if (b.dead) continue; b.army.alive++; b.army._sx += b.x; b.army._sz += b.z; (b.team === TEAMS[0] ? a++ : c++); }
      for (var k2 = 0; k2 < B.armies.length; k2++) { var Ac = B.armies[k2]; if (Ac.alive) { Ac.cx = Ac._sx / Ac.alive; Ac.cz = Ac._sz / Ac.alive; } } // living centroid (break-of-contact)
      // distress: how much worse my host fares than the enemy's (drives "try new things")
      if (B.armies.length === 2) {
        var fa = B.armies[0].start ? B.armies[0].alive / B.armies[0].start : 1, fb = B.armies[1].start ? B.armies[1].alive / B.armies[1].start : 1;
        B.armies[0].distress = clamp(fb - fa, 0, 1); B.armies[1].distress = clamp(fa - fb, 0, 1);
      }
      return [a, c];
    }
    function routing() { var a = 0, c = 0; for (var i = 0; i < B.bodies.length; i++) { var b = B.bodies[i]; if (b.dead || !b.broken) continue; (b.team === TEAMS[0] ? a++ : c++); } return [a, c]; }
    function armyFeatures(A) {
      var units = []; for (var i = 0; i < A.units.length; i++) { var u = A.units[i]; if (u.kind !== 'command') units.push({ kind: u.kind, role: u.role, n: u.bodies.length }); }
      var archers = 0; for (var j = 0; j < A.units.length; j++) if (A.units[j].role === 'archer') archers += A.units[j].bodies.length;
      return { team: A.team.name, doctrine: A.cmd.strategy, aggression: +A.cmd.aggression.toFixed(3), caution: +A.cmd.caution.toFixed(3), lead: A.cmd.lead, start: A.start, archers: archers, units: units };
    }
    function logEvent(type, team) { var r = B.rec; if (!r || r.done) return; r.events.push({ t: +B.t.toFixed(1), type: type, team: team }); }
    function recordStart() {
      B.rec = { seed: seed, terrain: { half: +T.half.toFixed(1), rise: +T.rise.toFixed(1), peakL: +T.peakL.toFixed(1), peakR: +T.peakR.toFixed(1), bend: +T.bend.toFixed(1), knolls: T.knolls.length },
        armies: [armyFeatures(B.armies[0]), armyFeatures(B.armies[1])], samples: [], events: [], _sampleAt: 0, _blood: false, _routed: [false, false], done: false };
    }
    function recordTick(dt, a, c) {
      var r = B.rec; if (!r || r.done) return;
      if (!r._blood && (a + c) < (B.armies[0].start + B.armies[1].start)) { r._blood = true; logEvent('first-blood'); }
      var rr = routing();
      for (var i = 0; i < 2; i++) { var al = i === 0 ? a : c; if (!r._routed[i] && al > 0 && rr[i] >= Math.max(3, B.armies[i].start * 0.25)) { r._routed[i] = true; logEvent('mass-rout', TEAMS[i].name); } }
      if (B.t >= r._sampleAt) { r.samples.push([+B.t.toFixed(1), a, c]); r._sampleAt += 1.0; }
    }
    function soldierSamples(winnerName) {
      var out = [];
      for (var i = 0; i < B.bodies.length; i++) {
        var b = B.bodies[i]; if (b.isCommander) continue;
        var held = b.slotDistN ? b.slotDistAcc / b.slotDistN : 0;
        out.push({ side: b.team.name, role: b.role, unit: b.unit.kind, doctrine: b.army.cmd.strategy,
          bravery: +b.bravery.toFixed(3), aggr: +b.aggr.toFixed(3), survived: b.dead ? 0 : 1, kills: b.kills, damage: +b.dmgDealt.toFixed(1),
          heldSlot: +held.toFixed(2), sideWon: b.team.name === winnerName ? 1 : 0 });
      }
      return out;
    }
    function finish(winner, withdrawer) {
      var r = B.rec; if (!r || r.done) return; r.done = true;
      var cc = counts(), a = cc[0], c = cc[1];
      if (!winner) winner = a > c ? 'A' : c > a ? 'B' : 'draw';
      var leaderWin = withdrawer || winner;                    // the withdrawer's LEADER wins by saving his army
      r.durationSec = +B.t.toFixed(1); logEvent('over', winner);
      r.outcome = { winner: winner, leaderWin: leaderWin, type: withdrawer ? 'withdrawal' : 'decisive', withdrawer: withdrawer || null, aSurvivors: a, bSurvivors: c, margin: Math.abs(a - c) };
      for (var i = 0; i < 2; i++) { var A = B.armies[i], af = r.armies[i]; af.survivors = A.alive; af.dead = A.start - A.alive; af.commanderSurvived = !!A.commander; af.won = leaderWin === af.team; af.withdrew = withdrawer === af.team; }
      B.winner = winner; B.rec.soldierSamples = soldierSamples(leaderWin);
    }

    // ---- build the two hosts + start the record ----
    raiseArmy(TEAMS[0], armySpec(0));
    raiseArmy(TEAMS[1], armySpec(1));
    recordStart();

    // ---------- public: tick / status / record ----------
    function tick(dt) {
      if (B.over) return;
      rebuildLive();
      var cc0 = counts();
      if (B.phase === 'deploy') { B.deployT -= dt; if (B.deployT <= 0) { B.phase = 'battle'; logEvent('engage'); commanderThink(B.armies[0]); commanderThink(B.armies[1]); } }
      else { for (var i = 0; i < B.armies.length; i++) { var A = B.armies[i]; if ((A.thinkCd -= dt) <= 0) { commanderThink(A); A.thinkCd = 0.7 + rng() * 0.7; } } } // leaders re-decide more often
      advanceUnits(dt);
      for (var b = 0; b < B.bodies.length; b++) stepBody(B.bodies[b], dt);
      separate();
      stepArrows(dt);
      B.t += dt; B.ticks++;
      var cc = counts(), a = cc[0], c = cc[1];
      recordTick(dt, a, c);
      if (B.phase === 'battle') {
        var A0 = B.armies[0], A1 = B.armies[1];
        // successful withdrawal: a retreating side broke contact (hosts far apart) with most of its men → leader wins
        var gap = (A0.alive && A1.alive) ? Math.hypot((A0.cx || 0) - (A1.cx || 0), (A0.cz || 0) - (A1.cz || 0)) : 999;
        var wp = [[A0, A1, a], [A1, A0, c]];
        for (var wpi = 0; wpi < 2; wpi++) { var W = wp[wpi][0], F = wp[wpi][1], wc = wp[wpi][2];
          if (!B.over && W.withdrawing && wc >= W.start * 0.45 && gap > 60 && B.t > 6) { B.over = true; finish(F.team.name, W.team.name); } }
        if (B.over) return;
        var rr = routing();
        var broken = function (al, rt, st, en) { return al === 0 || (al < st * 0.35 && al < en * 0.6) || (al > 0 && al < st * 0.55 && rt / al > 0.55); };
        var bA = broken(a, rr[0], A0.start, c), bB = broken(c, rr[1], A1.start, a);
        if (bA || bB || B.t > 70) {
          var winner = (bA && !bB) ? 'B' : (bB && !bA) ? 'A' : a > c ? 'A' : c > a ? 'B' : 'draw';
          B.over = true; finish(winner);
        }
      }
    }
    function status() { var cc = counts(); return { phase: B.phase, over: B.over, winner: B.winner, t: +B.t.toFixed(1), a: cc[0], b: cc[1], armies: B.armies.map(function (A) { return { team: A.team.name, doctrine: A.cmd.strategy, lead: A.cmd.lead, alive: A.alive, start: A.start, distress: +A.distress.toFixed(2) }; }) }; }
    function record() { return B.rec; }
    return { tick: tick, status: status, record: record, get over() { return B.over; }, _state: B };
  }

  // convenience: run a whole battle to resolution and return { record, winner }
  function run(cfg) {
    var dt = (cfg && cfg.dt) || 1 / 30, maxT = (cfg && cfg.maxSeconds) || 80, b = createBattle(cfg);
    var steps = Math.ceil(maxT / dt);
    for (var i = 0; i < steps && !b.over; i++) b.tick(dt);
    return { record: b.record(), winner: b._state.winner, ticks: b._state.ticks };
  }

  return {
    createBattle: createBattle, run: run, rollTerrain: rollTerrain, valleyY: valleyY,
    defaultCommanderGenome: defaultCommanderGenome, defaultSoldierGenome: defaultSoldierGenome,
    DOCTRINES: DOCTRINES, mulberry32: mulberry32,
  };
});
