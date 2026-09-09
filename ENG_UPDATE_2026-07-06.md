# Engineering Update — Blade Vale

**Date:** 2026-07-06  ·  **From:** Engineering  ·  **For:** CEO, CTO
**Cycle:** the three commits landed since the last update (`209c01f`, `d0a4ea9`, `565831b`)

---

## TL;DR

This cycle delivered the first *learning* system in the game and then rebuilt the
world's geography so the living war has room to happen.

- **The battle AI now trains itself.** The valley battle became a pure headless
  kernel that runs in Node, a self-play daemon plays it around the clock, and the
  policy it breeds — commander doctrine *and* per-soldier nerve — is served live.
  Champion-vs-baseline win rate climbed 40% → 80% under a byte-identical
  determinism guard.
- **That trained commander now runs the whole world's armies.** The WAR HOST layer
  gives every fielded NPC host the champion brain: doctrines, divisions with
  standing orders re-tasked live, morale, and a genuine withdraw-in-good-order.
  The same genome issues strategic orders (hunt/mass/probe/storm/guard/withdraw)
  to free hosts on the server map.
- **The world got real geography.** Capitals no longer crowd each other; cities
  sit ~660 world-units apart as true landmarks with villages and towns filling
  the country between; settlements are bigger and never overlap — enforced
  deterministically so client and server always agree. A kernel-version stamp now
  regenerates stale chunks in place: **a worldgen math change no longer needs a
  database wipe.**
- **The map got legible and tunable.** War markers, pins, and flags moved to a
  screen-space painted layer (constant pixel size at any zoom, hoverable), and a
  new march editor (`?march`) is the sandbox for tuning how armies *walk* —
  formation, road-following, terrain handling — on real worldgen ground.

One roadmap-level risk moved: battle resolution now has a real determinism test.
The server warfare tick still lacks one — that half of the gap stays open.

---

## For the CEO — outcomes & narrative

**"Living NPC AI" stopped being a slogan.** Until this cycle every army in the
world followed hand-written rules. Now there is a closed loop: battles play
themselves headlessly all day, a trainer breeds better commanders out of the
results, and the best one takes command of every NPC army players actually meet
— in field battles, in watched clashes, and on the strategic map. When the enemy
line refuses your charge, holds a ridge, commits its reserve late, or quits a
hopeless field in good order, that behaviour was *learned, in our own gym*. This
is the third pillar demoing itself, and the flywheel spins without anyone
touching it.

**The endless world now looks like a world.** Testers' first complaint about the
old map was quiet but consistent: everything was on top of everything. Capitals
almost touching, cities every few screens, walls colliding. After this cycle the
five crowns hold court far apart, a city is a *journey*, and the road between
passes villages and market towns instead of empty noise or clutter. Distance is
back — and distance is what makes claiming far frontier mean something.

**We can now change the world's math without breaking anyone's world.** Chunk
payloads carry the generator version; when the kernel improves, stale ground
regenerates itself on next visit. That converts worldgen iteration from a
scary migration into a routine deploy — velocity we'll be using every week from
here on.

**For the CTO hire:** the self-play stack (headless kernel → trainer daemon →
policy store → live serving, all under a determinism guard) is exactly the
author-and-gate pattern the generative pillar needs, proven end-to-end on the
battle domain first. It's the best artifact we have to show a candidate.

---

## For the CTO — technical detail

### 1. Self-play battle AI — `sim/battle.js`, `sim/trainer.js`, `train/aidb.js`, `perf/battle-determin.js` (`209c01f`)
The valley battle is now a pure kernel: no THREE, no DOM, one seeded RNG per
battle, so `(seed, policies)` replays byte-identically in Node and browser. On
top of it: an always-on (1+1)-ES trainer daemon that nudges a two-tier policy —
commander genome θ_C (doctrine choice, aggression, caution, reserve timing) and
soldier genome θ_S (nerve, spacing, engagement) — after every self-played fight,
with raw-power genes frozen so it learns *tactics*, not stat inflation.
Policies persist in a separate `train/ai.db`; the champion is served at
`/api/v1/policy/champion`. `perf/battle-determin.js` plays every seed twice
(bare + mutated genome pair) and asserts byte-identical traces — green on all
seeds. Verified champion-vs-baseline: 40% → 80% win rate.

### 2. WAR HOST — the champion commands the live game — `game.js`, `server/warfare.js`, `sim/battle.js` (`d0a4ea9`)
Every fielded NPC host now plans a doctrine from θ_C, carves its men into
divisions with standing orders that re-task live, carries per-soldier θ_S nerve,
and withdraws in good order when the field is lost ("The Enemy Withdraws" —
survivors re-form — vs. "They Break and Run!"). Applies to field battles and
watched NPC-vs-NPC clashes (higher fighter caps, stall-detect fold, per-frame
shove so lines crush rather than interpenetrate). Server-side, `strategizeHosts`
gives free hosts champion-steered standing strategic orders — hunt / mass /
probe / storm / guard / withdraw — persisted per-army; `keepClear` makes
bystander columns skirt battles and walled towns on both engines. Full doc:
`BATTLES.md`.

### 3. World spacing overhaul — `sim/terra.js` (VERSION 2→4), `sim/world-sim.js` (`565831b`)
- **Capitals:** the five-crown ring pushed out to `MAP_HALF·2.4` (~216u), plus a
  deterministic pair-relaxation pass guaranteeing ≥80u of open country between
  capital walls regardless of coastline snapping; `HEARTLAND_R` widened to match.
- **Cities as landmarks:** `CITY_BLOCK` 7→11 (~660u minimum between cities);
  villages/towns now fill ~50% of chunks so the space between cities is country,
  not void.
- **Bigger holds, zero overlaps:** settlement radii/houses bumped across every
  tier (capital R58, city R48, town R21, village R10), and a new deterministic
  cross-chunk overlap cull — rank + stable hold-key tie-break over a ±4-chunk
  neighbour scan through a reseat cache — so exactly one of every colliding pair
  survives, and client and server independently agree on which.

### 4. Server keeps up with an infinite world — `server/chunks.js`, `server/tick.js`, `server/warfare.js` (`565831b`)
- **Kernel-stamp regeneration:** stored chunk payloads are validated against
  `Terra.VERSION`; a math bump regenerates stale chunks in place on next touch —
  no manual DB wipe, holds reseat automatically. (This is the "kernel migration
  story" the roadmap called for: lazy per-chunk regeneration is now the policy.)
- **Garrison-on-generate:** freshly generated ground gets its full patrol
  complement in the same transaction, so fast travel never lands you in a
  ghost settlement waiting on the next patrol tick.
- **No more play boundary:** the old 640u patrol clamp stranded far-frontier
  watches mid-map; it's now a pure NaN guard (1e7). Towns and villages gained
  real watch quotas, and keep-out radii were rescaled to the new footprints.

### 5. Screen-space marker layer + march editor — `game.js`, `index.html` (`565831b`)
All painted map symbols (war ⚔ with a live two-faction tug-of-war bar, owned-hold
pins, character pins) moved off 3D-scaled sprites onto a projected DOM layer —
constant pixel size at any zoom, hoverable/clickable, one projection pass per
frame. And `?march` boots a spectator sandbox: two NPC hosts patrol two real
towns on real worldgen terrain with roads, clash where their circuits cross —
the tuning bench for formation walking, road-following, and foot animation
(`BV.march*` / `BV.marchTune` console dials, live narration log). Also: server
armies fade in instead of popping, and a `Line`/`Points` disposal leak was fixed.

---

## Risks & honest gaps (one advanced, one still open)

1. **Battle determinism is now test-covered — warfare tick determinism is not.**
   `perf/battle-determin.js` pins battle resolution to byte-identical replays,
   which closes the *battle* half of the roadmap's top gap. The server warfare
   tick (musters, campaigns, patrol focus) still has no golden-trace test and
   mutates the most rows per tick. Still the first test the new hire should own.
2. **Single-engine float determinism** — unchanged: it holds because it's all
   one engine today; no cross-engine guard exists. Known, bounded, documented.
3. **New this cycle — two battle brains.** The in-game WAR HOST logic and the
   headless kernel (`sim/battle.js`) implement the same tactics twice. They can
   drift; folding them into one code path is queued (roadmap §3) and matters
   more now that the kernel is the thing being trained.

---

## Next up (proposed)

- **Warfare-tick determinism harness** — extend the golden-seed approach from
  battles to the server tick (closes the remaining half of risk #1).
- **Unify the two battle implementations** — one tactical code path for the
  in-game host and the headless trainer, so the gym can never drift from the
  game (risk #3).
- **March quality pass** — use the new `?march` bench to make army movement read
  as *soldiers marching* (formation cohesion on roads, terrain-aware pace)
  before the next tester round; it's the thing every player watches most.
- **Interest management** — the denser hold map means more patrols per explored
  area; the tick-cost bucket work the roadmap already flags gets more urgent
  with every world this size.

---

*Commits this cycle:*
`209c01f` headless battle kernel + self-play trainer + determinism guard ·
`d0a4ea9` WAR HOST — the trained champion commands NPC armies in the live game ·
`565831b` settlement-spacing overhaul + kernel-stamp chunk regeneration +
screen-space markers + march editor.
