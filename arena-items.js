/* Blade Vale — the ARENA CAREER catalogue: ranks and marketplace items. ONE file for both sides — the
   server prices, locks and pays out from it; the client shows the same numbers and applies the stats
   to the fighter. Loaded in the browser before game.js (window.ARENA_CAT), and require()d by server/arena.js. */
(function (root) {
  'use strict';
  // rank titles by XP earned (an XP lock on the marketplace: gold alone never buys the top gear)
  var ARENA_RANKS = [['Rookie', 0], ['Fighter', 150], ['Veteran', 500], ['Champion', 1200], ['Master', 2500], ['Legend', 5000]];
  // a fighter's four slots (sword, armor, bow, horse) plus two cosmetic slots that only loot fills (plume, trim).
  // rank = the rank index needed; skill = [use-skill, level] also needed; stats are what the item does in the pit.
  var ARENA_ITEMS = {
    wood_sword:     { slot: 'sword', name: 'Wooden sword',      price: 0,    rank: 0, dmg: 0.8,  desc: 'the training blade every fighter starts with' },
    iron_sword:     { slot: 'sword', name: 'Iron sword',        price: 120,  rank: 0, dmg: 1.0,  desc: 'a plain, honest blade' },
    steel_sword:    { slot: 'sword', name: 'Steel sword',       price: 400,  rank: 1, dmg: 1.1,  desc: 'keeps an edge through a whole fight' },
    vale_blade:     { slot: 'sword', name: 'Blade of the Vale', price: 1200, rank: 2, dmg: 1.2,  reach: 0.15, desc: 'long, light and quick' },
    master_sword:   { slot: 'sword', name: "Master's sword",    price: 3000, rank: 4, skill: ['sword', 4], dmg: 1.32, reach: 0.2, desc: 'forged for a hand that has earned it' },
    leather:        { slot: 'armor', name: 'Leather jerkin',    price: 150,  rank: 0, hp: 15, desc: 'turns a glancing cut' },
    mail:           { slot: 'armor', name: 'Mail hauberk',      price: 500,  rank: 1, hp: 35, poise: 5, desc: 'rings over padding' },
    plate:          { slot: 'armor', name: 'Plate harness',     price: 1500, rank: 2, hp: 60, poise: 15, move: -0.05, desc: 'heavy, and worth it' },
    champion_plate: { slot: 'armor', name: "Champion's plate",  price: 3500, rank: 4, hp: 90, poise: 25, move: -0.06, desc: 'the pit has seen nothing harder' },
    hunting_bow:    { slot: 'bow',   name: 'Hunting bow',       price: 200,  rank: 0, dmg: 1.0,  desc: 'lets you ride in with a bow at all' },
    longbow:        { slot: 'bow',   name: 'Longbow',           price: 700,  rank: 1, dmg: 1.15, desc: 'a heavier draw, a harder arrow' },
    warbow:         { slot: 'bow',   name: 'Warbow',            price: 2000, rank: 2, skill: ['bow', 3], dmg: 1.32, desc: 'punches through mail' },
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
  };
  var ARENA_SLOTS = ['sword', 'armor', 'bow', 'horse', 'plume', 'trim'];
  var ARENA_ACHIEVEMENTS = [                                 // [id, label, stat, threshold] — the milestones a profile lists
    ['first_blood', 'First blood', 'kills', 1], ['kills_10', '10 foes felled', 'kills', 10], ['kills_50', '50 foes felled', 'kills', 50], ['kills_200', '200 foes felled', 'kills', 200], ['kills_500', '500 foes felled', 'kills', 500],
    ['match_1', 'First fight', 'matches', 1], ['match_10', '10 fights', 'matches', 10], ['match_50', '50 fights', 'matches', 50], ['match_100', '100 fights', 'matches', 100],
    ['wins_5', '5 wins', 'wins', 5], ['wins_25', '25 wins', 'wins', 25], ['wins_100', '100 wins', 'wins', 100],
    ['star_1', 'Star of the match', 'stars', 1], ['star_10', 'Star ten times over', 'stars', 10],
    ['trophies_50', '50 trophies', 'trophies', 50], ['trophies_200', '200 trophies', 'trophies', 200],
  ];
  // use-skills: swing hits, arrow hits, ten-second stretches in the saddle — level = floor(sqrt(count / 5))
  function skillLevel(count) { return Math.floor(Math.sqrt(Math.max(0, count | 0) / 5)); }
  function rankOf(xp) { var i = 0; for (var k = 0; k < ARENA_RANKS.length; k++) if (xp >= ARENA_RANKS[k][1]) i = k; return i; }
  function rankInfo(xp) { var i = rankOf(xp), next = ARENA_RANKS[i + 1]; return { idx: i, name: ARENA_RANKS[i][0], next: next ? next[0] : null, nextAt: next ? next[1] : null }; }
  // why an item can't be bought (null = it can)
  function lockReason(id, career) {
    var it = ARENA_ITEMS[id]; if (!it) return 'no such item';
    if (it.unique) return 'loot only';
    if ((career.items || []).indexOf(id) >= 0) return 'owned';
    var r = rankOf(career.xp | 0); if (r < it.rank) return 'needs ' + ARENA_RANKS[it.rank][0];
    if (it.skill) { var lv = skillLevel((career.skills || {})[it.skill[0]]); if (lv < it.skill[1]) return 'needs ' + it.skill[0] + ' skill ' + it.skill[1]; }
    if ((career.gold | 0) < it.price) return 'needs ' + it.price + ' gold';
    return null;
  }
  var api = { ARENA_RANKS: ARENA_RANKS, ARENA_ITEMS: ARENA_ITEMS, ARENA_SLOTS: ARENA_SLOTS, ARENA_ACHIEVEMENTS: ARENA_ACHIEVEMENTS, skillLevel: skillLevel, rankOf: rankOf, rankInfo: rankInfo, lockReason: lockReason };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ARENA_CAT = api;
})(typeof window !== 'undefined' ? window : this);
