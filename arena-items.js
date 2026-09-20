/* Blade Vale — the ARENA CAREER catalogue: ranks and marketplace items. ONE file for both sides — the
   server prices, locks and pays out from it; the client shows the same numbers and applies the stats
   to the fighter. Loaded in the browser before game.js (window.ARENA_CAT), and require()d by server/arena.js. */
(function (root) {
  'use strict';
  // rank titles by XP earned (an XP lock on the marketplace: gold alone never buys the top gear)
  var ARENA_RANKS = [['Rookie', 0], ['Fighter', 150], ['Veteran', 500], ['Champion', 1200], ['Master', 2500], ['Legend', 5000]];
  // a fighter's slots (sword, a steel arm and a pauldron either side, helm, shield, bow, horse) plus two cosmetic slots that only loot fills (plume, trim).
  // Nothing on = the base man as he is: bare-chested, leather wrist bands, trousers and boots; no helm = bareheaded; no shield = the round the pit lends.
  // rank = the rank index needed; skill = [use-skill, level] also needed; stats are what the item does in the pit.
  var ARENA_ITEMS = {
    wood_sword:     { slot: 'sword', name: 'Wooden sword',      price: 0,    rank: 0, dmg: 0.8,  desc: 'the training blade every fighter starts with' },
    iron_sword:     { slot: 'sword', name: 'Iron sword',        price: 120,  rank: 0, dmg: 1.0,  desc: 'a plain, honest blade' },
    steel_sword:    { slot: 'sword', name: 'Steel sword',       price: 400,  rank: 1, dmg: 1.1,  desc: 'keeps an edge through a whole fight' },
    vale_blade:     { slot: 'sword', name: 'Blade of the Vale', price: 1200, rank: 2, dmg: 1.2,  reach: 0.15, desc: 'long, light and quick' },
    master_sword:   { slot: 'sword', name: "Master's sword",    price: 3000, rank: 4, skill: ['sword', 4], dmg: 1.32, reach: 0.2, desc: 'forged for a hand that has earned it' },
    falchion:       { slot: 'sword', name: 'Falchion',          price: 250,  rank: 0, dmg: 1.05, desc: 'a broad curved chopper' },
    rapier:         { slot: 'sword', name: 'Needle',            price: 550,  rank: 1, dmg: 1.0,  reach: 0.28, desc: 'a thin rapier with a cup hilt — reach over weight' },
    cleaver:        { slot: 'sword', name: "Butcher's cleaver", price: 600,  rank: 1, dmg: 1.15, reach: -0.1, desc: 'short, wide, ugly, effective' },
    scimitar:       { slot: 'sword', name: 'Dune scimitar',     price: 1400, rank: 2, dmg: 1.18, desc: 'a golden-hilted curve from the south' },
    flamberge:      { slot: 'sword', name: 'Serpent flamberge', price: 1600, rank: 2, dmg: 1.22, desc: 'a wavy blade that bites on the draw' },
    doomsword:      { slot: 'sword', name: 'Doomsword',         price: 2400, rank: 3, dmg: 1.3,  reach: 0.3, move: -0.03, desc: 'a great blade as tall as a boy' },
    sun_blade:      { slot: 'sword', name: 'Sun-forged blade',  price: 6000, rank: 5, skill: ['sword', 5], dmg: 1.4, reach: 0.2, desc: 'it glows — the pit falls quiet when it is drawn' },
    // ARMOUR, PIECE BY PIECE (2026-09-20): the fighter is the base — his own skin, leather wrist bands, trousers and boots — and armour is
    // worn a piece at a time, each side of the body its own slot. The old armour-slot wares (gambeson … dragon plate) and the kit's sallet
    // went with the kit; the market sells what the char editor builds. Gauntlet = the whole steel arm, shoulder to fingertips.
    gauntlet_L:     { slot: 'gauntL', name: 'Steel arm (left)',        price: 350, rank: 0, hp: 10, poise: 4, move: -0.02, desc: 'a plated steel arm, shoulder to fingertips — the left' },
    gauntlet_R:     { slot: 'gauntR', name: 'Steel arm (right)',       price: 350, rank: 0, hp: 10, poise: 4, move: -0.02, desc: 'a plated steel arm, shoulder to fingertips — the sword arm' },
    pauldron_L:     { slot: 'pauldL', name: 'Leather pauldron (left)', price: 120, rank: 0, hp: 5,  poise: 2, desc: 'a ribbed leather plate laced over the left shoulder' },
    pauldron_R:     { slot: 'pauldR', name: 'Leather pauldron (right)', price: 120, rank: 0, hp: 5, poise: 2, desc: 'a ribbed leather plate laced over the right shoulder' },
    corinthian:     { slot: 'helm',  name: 'Corinthian helm',   price: 260,  rank: 0, hp: 8,  poise: 4, model: 'corinthian', desc: 'a bronze helm of the old south, cheek guards and a nasal round an open face, a crest on the crown' },   // (model: its own sculpt in place of the sallet — game.js loadHelmModel)
    round_shield:   { slot: 'shield', name: 'Round shield',     price: 0,    rank: 0, desc: 'a painted wooden round — the pit lends every fighter one' },
    heater_shield:  { slot: 'shield', name: 'Heater shield',    price: 350,  rank: 1, poise: 5, desc: 'steel-faced and team-painted' },
    hunting_bow:    { slot: 'bow',   name: 'Hunting bow',       price: 200,  rank: 0, dmg: 1.0,  desc: 'lets you ride in with a bow at all' },
    longbow:        { slot: 'bow',   name: 'Longbow',           price: 700,  rank: 1, dmg: 1.15, desc: 'a heavier draw, a harder arrow' },
    warbow:         { slot: 'bow',   name: 'Warbow',            price: 2000, rank: 2, skill: ['bow', 3], dmg: 1.32, desc: 'punches through mail' },
    recurve:        { slot: 'bow',   name: 'Horn recurve',      price: 3500, rank: 3, skill: ['bow', 4], dmg: 1.4, desc: 'horn and sinew, tips turned back — the fastest arrow in the pit' },
    nag:            { slot: 'horse', name: 'Nag',               price: 300,  rank: 0, hp: 80,  speed: 0.9,  desc: 'slow, but it carries you' },
    courser:        { slot: 'horse', name: 'Courser',           price: 1000, rank: 1, hp: 100, speed: 1.0,  desc: 'a sound riding horse' },
    destrier:       { slot: 'horse', name: 'Destrier',          price: 2500, rank: 2, hp: 140, speed: 1.05, desc: 'bred for the charge' },
    warhorse:       { slot: 'horse', name: 'Warhorse',          price: 5000, rank: 4, skill: ['riding', 3], hp: 170, speed: 1.1, desc: 'fears nothing' },
    // UNIQUES — loot only, never sold. The bragging is in the look; the power is a hair (the balance rule)
    crimson_plume:  { slot: 'plume', name: 'Crimson plume',     unique: true, plume: 0xd4342a, desc: 'a plume the whole pit can see' },
    gilded_plume:   { slot: 'plume', name: 'Gilded plume',      unique: true, plume: 0xffd34d, desc: 'gold thread, dyed feathers' },
    raven_plume:    { slot: 'plume', name: 'Raven plume',       unique: true, plume: 0x1b1b22, desc: 'black as a bad omen' },
    gilded_blade:   { slot: 'trim',  name: 'Gilded blade',      unique: true, blade: 0xe6b84a, dmg: 1.02, desc: 'a gold-washed edge' },
    moon_blade:     { slot: 'trim',  name: 'Moon-steel blade',  unique: true, blade: 0xbfd8ff, dmg: 1.02, desc: 'pale steel that never rusts' },
    ember_blade:    { slot: 'sword', name: 'Ember blade',       unique: true, dmg: 1.12, desc: 'a wavy blade that smoulders orange' },
    frost_fang:     { slot: 'sword', name: 'Frost fang',        unique: true, dmg: 1.12, reach: 0.1, desc: 'serrated ice-steel with a cold light' },
    black_night:    { slot: 'sword', name: 'Black Night',       unique: true, dmg: 1.12, desc: 'a black curve with a violet gleam' },
    // THE NORTH (2026-09-16): the berserker's kit — a knife, two axes, and INK, a slot of its own: tattoos wherever the armour leaves skin bare
    seax:           { slot: 'sword', name: 'Seax',              price: 180,  rank: 0, dmg: 0.95, reach: -0.15, desc: 'a broken-back northern knife — short, quick, close' },
    bearded_axe:    { slot: 'sword', name: 'Bearded axe',       price: 450,  rank: 1, dmg: 1.18, reach: -0.05, desc: 'a northern axe with a hooked beard — it bites deep' },
    dane_axe:       { slot: 'sword', name: 'Dane axe',          price: 1800, rank: 2, dmg: 1.28, reach: 0.25, desc: 'a long-hafted broad axe, swung with the whole body' },
    // RETIRED (2026-09-16, "we can just move it to customize instead, it can be free"): the ink is a pick in the barber now (ARENA_LOOK.i) — these two
    // stay in the catalogue only so a career that bought one still reads; 'ink' is no slot any more, so they cannot be bought or equipped
    wolf_ink:       { slot: 'ink',   name: 'Wolf ink',          price: 150,  rank: 0, ink: 'wolf', retired: true, desc: 'blue-black knotwork over chest and arms — now a free pick in the barber' },
    blood_ink:      { slot: 'ink',   name: 'Blood ink',         price: 150,  rank: 0, ink: 'blood', retired: true, desc: 'red war-marks over chest and arms — now a free pick in the barber' },
  };
  var ARENA_SLOTS = ['sword', 'gauntL', 'gauntR', 'pauldL', 'pauldR', 'helm', 'shield', 'bow', 'horse', 'plume', 'trim'];   // ('armor' was a slot until 2026-09-20: the base wears armour a piece at a time — see the wares above)   // (the ink was a slot here once; it is the barber's now — ARENA_LOOK.i)
  // YOUR LOOK (the barber): skin tone, face shape, hair style, hair colour, beard style — indexes into the client's lists;
  // the server keeps them in the career's meta and every guest paints the same face
  var ARENA_LOOK = { s: 10, f: 6, c: 9, b: 5, i: 6, k: 8 };   // (h, the hair's cut, went 2026-09-20 — one cut for every man, the base's own mane; a saved h is dropped here; b 5: clean, stubble, full, goatee, moustache — a braided sixth came and went 2026-09-16, a saved 5 falls out of range here and back to the roll; i: the ink's design — none, wolf, serpent, tide, sun, thorn — and k its colour, 8 dyes; free, on whatever skin the kit leaves bare)
  function cleanLook(l) { if (!l || typeof l !== 'object') return null; var o = {}, any = false; for (var k in ARENA_LOOK) { var v = l[k]; if (typeof v === 'number' && v === (v | 0) && v >= 0 && v < ARENA_LOOK[k]) { o[k] = v; any = true; } } return any ? o : null; }
  // THE VALE'S MEN — the NPC name pool. A name is an NPC's identity (his profile, his record), so the lobby, the
  // world's warbands and the server's own simulated bouts all draw from this one list.
  var NPC_GIVEN = ['Aldric','Bram','Cedwyn','Doran','Eadric','Falk','Garrec','Hale','Ivo','Joren','Kell','Lorne','Maddoc','Nael','Osric','Perrin','Quenn','Roderic','Sefton','Tomas','Ulf','Varin','Wend','Yorin','Ansel','Brand','Corin','Dunmar','Edra','Freya','Gerda','Halla','Ingrid','Jorah','Kara','Linnet','Mira','Nessa','Orla','Petra','Romilda','Sigrun','Thora','Ysolde'];
  var NPC_BYNAMES = ['the Bold','the Quiet','Ironhand','the Younger','Oakheart','the Swift','Stonefist','the Grim','Redmane','the Tall','Hawkeye','the Patient','Coldbrook','the Stout','Wolfsbane','the Lucky','Greycloak','the Fierce','Longstride','the Sly','Brightblade','the Steady','Hardwin','the Wary','Blackbriar','Frostbeard','Stormcrow'];
  var ARENA_ACHIEVEMENTS = [                                 // [id, label, stat, threshold] — the milestones a profile lists
    ['first_blood', 'First blood', 'kills', 1], ['kills_10', '10 foes felled', 'kills', 10], ['kills_50', '50 foes felled', 'kills', 50], ['kills_200', '200 foes felled', 'kills', 200], ['kills_500', '500 foes felled', 'kills', 500],
    ['match_1', 'First fight', 'matches', 1], ['match_10', '10 fights', 'matches', 10], ['match_50', '50 fights', 'matches', 50], ['match_100', '100 fights', 'matches', 100],
    ['wins_5', '5 wins', 'wins', 5], ['wins_25', '25 wins', 'wins', 25], ['wins_100', '100 wins', 'wins', 100],
    ['star_1', 'Star of the match', 'stars', 1], ['star_10', 'Star ten times over', 'stars', 10],
    ['trophies_50', '50 trophies', 'trophies', 50], ['trophies_200', '200 trophies', 'trophies', 200],
    // THE HOOKS (2026-09-14): scores settled with a rival, bouts of the day, the champion's belt, a streak
    ['rival_1', 'A score settled', 'rivalsBeaten', 1], ['rival_5', 'Five scores settled', 'rivalsBeaten', 5],
    ['daily_1', 'Fought a bout of the day', 'dailies', 1], ['daily_10', 'Ten bouts of the day', 'dailies', 10], ['daily_top', 'Topped a bout of the day', 'dailyTops', 1],
    ['belt_1', "Took the champion's belt", 'belts', 1],
    ['streak_3', 'Three in a row', 'streak', 3], ['streak_5', 'Rampage — five in a row', 'streak', 5],
  ];
  // PERSONAL BESTS — one fight's numbers a career remembers (meta.bests); the results screen calls a beaten one out.
  // [id, label, cap] — the client reports life / blow / streak beside the kills and damage it already sends.
  var ARENA_BESTS = [['kills', 'kills in one fight', 500], ['dmg', 'damage in one fight', 1e5], ['life', 'longest life', 3600], ['blow', 'biggest blow', 500], ['streak', 'kill streak', 100]];
  // a career stat, wherever it lives: the row (kills, wins…), the meta blob (rivalsBeaten, dailies, belts…), or a best (streak)
  function statOf(c, stat) { if (c[stat] != null) return c[stat] | 0; var m = c.meta || {}; if (m[stat] != null) return m[stat] | 0; return ((m.bests || {})[stat]) | 0; }
  // LOOT PITY: a unique is a 1-in-20 roll on a win, and the odds climb with every win that rolls nothing — at PITY_AT
  // wins without one it is certain. (No loot box: nothing is bought; the roll is on the fight.)
  var PITY_AT = 20;
  function uniqueChance(pity) { pity = Math.max(0, pity | 0); return Math.min(1, 0.05 + pity * pity * 0.0024); }
  // THE WAGER: the host may put gold on the fight; every signed-in player in it stakes the same (never more than he
  // has). Win: the stake back and as much again. Lose: the stake. Draw: nothing moves.
  var WAGERS = [0, 25, 50, 100, 200];
  // THE RIVAL: the vale's man who felled you waits in your next pit; beat him and the purse is heavier
  function rivalBonus(rival) { var sk = rival && rival.skill | 0; return { xp: 40 + Math.round(sk / 2), gold: 30 + Math.round(sk / 2) }; }
  // THE BOUT OF THE DAY — one fight the whole vale fights: the same seed, the same men, the same sand, a board of its
  // own that resets at midnight UTC. Everything below is derived from the day string, so client and server agree.
  function fnv(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var DAILY_ADJ = ['Broken', 'Bloody', 'Silent', 'Crimson', 'Iron', 'Hollow', 'Burning', 'Cold', 'Long', 'Bitter', 'Golden', 'Black', 'Grey', 'Last', 'Wild', 'Quiet', 'Red', 'Lost', 'Proud', 'Hungry'];
  var DAILY_NOUN = ['Shields', 'Sands', 'Gate', 'Spears', 'Crowns', 'Oath', 'Bell', 'Wolves', 'Banners', 'Steel', 'Dawn', 'Dusk', 'Hour', 'Ring', 'Torches', 'Helms', 'Hounds', 'Stones', 'Vigil', 'Reckoning'];
  function dayKey(d) { d = d || new Date(); return d.toISOString().slice(0, 10); }
  function dailyOf(day) {
    day = day || dayKey(); var seed = fnv('blade-vale-daily:' + day), r = mulberry(seed), pick = function (a) { return a[Math.floor(r() * a.length)]; };
    var name = 'The ' + pick(DAILY_ADJ) + ' ' + pick(DAILY_NOUN), pit = r() < 0.25;
    var per = pit ? 1 : 2 + Math.floor(r() * 4), teams = pit ? (r() < 0.3 ? 3 : 2) : 2;
    return { day: day, seed: seed, name: name, venue: pit ? 'pit' : 'colosseum', teams: teams, per: per,
      time: pit ? 'night' : pick(['day', 'day', 'dusk', 'night']), weather: pit ? 'clear' : (r() < 0.25 ? 'rain' : 'clear'), pit: pick(['cosy', 'wide', 'wide', 'vast']), ground: pit ? 'sand' : pick(['sand', 'hills', 'rocks', 'broken']),
      xp: pick(['mixed', 'mixed', 'veteran', 'green']) };
  }
  // the board's score: the star-of-the-match measure plus the outcome, so a win with kills tops a survival
  function dailyScore(p, won, draw) { return Math.round(Math.min(500, p.kills | 0) * 100 + Math.min(1e5, +p.dmg || 0) + (p.alive ? 150 : 0) + (won ? 300 : draw ? 100 : 0)); }
  // use-skills: swing hits, arrow hits, ten-second stretches in the saddle — level = floor(sqrt(count / 5))
  function skillLevel(count) { return Math.floor(Math.sqrt(Math.max(0, count | 0) / 5)); }
  function rankOf(xp) { var i = 0; for (var k = 0; k < ARENA_RANKS.length; k++) if (xp >= ARENA_RANKS[k][1]) i = k; return i; }
  function rankInfo(xp) { var i = rankOf(xp), next = ARENA_RANKS[i + 1]; return { idx: i, name: ARENA_RANKS[i][0], next: next ? next[0] : null, nextAt: next ? next[1] : null }; }
  // RENOWN — the one number the ladder sorts by, for players and the vale's own men alike. Everything a profile
  // shows feeds it: XP, every fight (a win worth five losses), every star of the match, kills, trophies, the
  // use-skill levels, and the damage dealt. The ladder position (#N among players, #N among the vale's men) is
  // the rank the user sees; the XP titles above are the marketplace locks.
  var RENOWN = { win: 25, loss: 5, star: 60, kill: 3, trophy: 6, skillLevel: 30, damage: 1 / 100 };
  function renownOf(c) {
    var sk = c.skills || {}, lv = 0, keys = ['sword', 'bow', 'riding'];
    for (var i = 0; i < keys.length; i++) { var v = sk[keys[i]]; lv += (v && typeof v === 'object') ? (v.level | 0) : skillLevel(v); }
    var wins = c.wins | 0, losses = Math.max(0, (c.matches | 0) - wins);
    return Math.round((c.xp | 0) + RENOWN.win * wins + RENOWN.loss * losses + RENOWN.star * (c.stars | 0) + RENOWN.kill * (c.kills | 0) + RENOWN.trophy * (c.trophies | 0) + RENOWN.skillLevel * lv + RENOWN.damage * (c.damage | 0));
  }
  // why an item can't be bought (null = it can)
  function lockReason(id, career) {
    var it = ARENA_ITEMS[id]; if (!it) return 'no such item';
    if (it.retired) return 'retired';                                       // (the ink: the barber's now, free — not for sale, not counted among what you can afford)
    if (it.unique) return 'loot only';
    if ((career.items || []).indexOf(id) >= 0) return 'owned';
    var r = rankOf(career.xp | 0); if (r < it.rank) return 'needs ' + ARENA_RANKS[it.rank][0];
    if (it.skill) { var lv = skillLevel((career.skills || {})[it.skill[0]]); if (lv < it.skill[1]) return 'needs ' + it.skill[0] + ' skill ' + it.skill[1]; }
    if ((career.gold | 0) < it.price) return 'needs ' + it.price + ' gold';
    return null;
  }
  var api = { ARENA_RANKS: ARENA_RANKS, ARENA_ITEMS: ARENA_ITEMS, ARENA_SLOTS: ARENA_SLOTS, ARENA_LOOK: ARENA_LOOK, cleanLook: cleanLook, ARENA_ACHIEVEMENTS: ARENA_ACHIEVEMENTS, ARENA_BESTS: ARENA_BESTS, RENOWN: RENOWN, NPC_GIVEN: NPC_GIVEN, NPC_BYNAMES: NPC_BYNAMES, PITY_AT: PITY_AT, WAGERS: WAGERS, skillLevel: skillLevel, rankOf: rankOf, rankInfo: rankInfo, renownOf: renownOf, lockReason: lockReason, statOf: statOf, uniqueChance: uniqueChance, rivalBonus: rivalBonus, dayKey: dayKey, dailyOf: dailyOf, dailyScore: dailyScore, fnv: fnv, mulberry: mulberry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ARENA_CAT = api;
})(typeof window !== 'undefined' ? window : this);
