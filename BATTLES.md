# Blade Vale — Battles

Everything about the battle system: the **?battle editor** where it was built, the **headless
kernel** that makes it trainable, the **self-play AI** that keeps getting smarter, and how the
same battles run **inside the game** — when NPCs fight you, and when they fight each other.

Companion doc: `BATTLE_CONTROLS.md` covers how *you* command your own warband (Orders × Pace).
This doc covers how the *world* fights.

---

## 1. What a battle is

Two commanded hosts meet on real terrain and fight as **armies**, not mobs:

- Each side has an **AI commander** who plans a doctrine before contact, carves his men into
  **divisions** (center, wings, reserve, archers), deploys them, and **re-reads the fight every
  couple of seconds**, re-tasking divisions live: charge, hold, flank, fall back.
- Each **soldier** is an individual: he holds a commanded slot in his division's rank-and-file
  block, fights the enemy in front of him (never straying more than a leash from his place),
  weighs *real* morale facts — local odds, his wounds, how the whole host fares — and **routs to
  the rear when his nerve breaks**, rallying if he reaches safety.
- Bodies take up space: a spatial-hash shove pass (`battleSeparate`) turns two lines meeting
  into a **shoving crush**, not overlapping ghosts.
- Archers stay behind, loose **lobbed volleys** (a real arc that comes down on the mark, led by his pace), and kite when threatened — but only as far as their own rear line.
- Battles end the way real ones do: a host **breaks and quits the field** when it's gutted or
  mostly routing — or its leader **refuses a hopeless fight and withdraws in good order**, which
  is scored as *his* win (he saved the army), even though the enemy holds the field.

No side ever fights to the last man unless it's truly cornered.

---

## 2. Where it lives (two synchronized implementations)

| | Rendered editor | Headless kernel |
|---|---|---|
| File | `game.js` — the `BATTLE EDITOR` section (`?battle`) | `sim/battle.js` (UMD: Node + browser) |
| Renders | THREE.js — every soldier is `buildHumanoid`, shared pose system (`setPose`/`MOVES`/`walkLegs`) | nothing — pure state |
| RNG | `Math.random` + per-army seeded `_mulberry32` | one seeded `mulberry32` per battle — **(seed, policies) replays identically** |
| Used for | watching, iterating on feel, possessing a soldier, live training | self-play training (`sim/trainer.js`), in-editor training bursts, determinism tests |

The kernel is the same commander-led valley battle, kept pure so millions of battles can run
off-screen. **When you tune the fight, tune both** (`BATTLE_MELEE`/`BATTLE_FORM`/`BATTLE_MORALE`/
`BATTLE_ARCHER` in `game.js` ↔ `SOLDIER_BASE` and the default genomes in `sim/battle.js`).

### Opening the editor

```
?battle                      # two random hosts, auto-looping battles + always-on training
?battle&n=60&seed=7&fixed=1  # pinned, deterministic armies
?battle&archers=0.5          # archer fraction 0..0.7
?battle&maxn=600             # army-size ceiling for the random rolls (40..1000)
?battle&log=server           # POST every finished battle to /api/v1/battle-log
```

Controls: **drag** orbit · **scroll** zoom · **Space** pause · **R** restart · **click a
soldier to possess him** (WASD + mouse-look + click to strike/shoot, Esc to release).

---

## 3. Terrain

`battleRollTerrain()` — rolled fresh every battle:

- **Real-overworld mode (default):** picks a random patch of the actual `sim/terra.js` world
  (re-rolled up to 30 times until it's on land with *some* relief but no sheer cliff) and fights
  on it — hills, ridges, dips and all. `BV.battleWorldTerrain(false)` switches it off.
- **Synthetic valley mode:** a floor that snakes gently down its length (`bend`), walled by
  mountains of independently-rolled heights on ±X, with faint floor undulation and 1–3 **knolls**
  of high ground a commander can use.

`battleValleyY(x,z)` is the single elevation truth: soldiers, arrows, deployment, and the
terrain mesh all ride it. It's also plugged into `editTerrainFn` so map-elevation probes work.
The kernel has an identical pure copy (`rollTerrain`/`valleyY`).

---

## 4. Raising an army

`battleRaiseArmy(team, per, seed, archerFrac, policyC, policyS)`:

1. **Composition** — `per` men, `archerFrac` of them archers (0..0.7). In the editor, restarts
   roll both hosts near the *same* strength (fair fight, ±10%); ~1 in 10 battles one side is
   genuinely outnumbered (32–57% strength). `?fixed=1` pins the URL values.
2. **The plan** — `battlePlanArmy` picks a **doctrine** and carves divisions (below).
3. **Muster** — each division is a rank-and-file block (`battleBuildUnit`): files ∝ √count,
   melee blocks wider than archer blocks, per-man slot jitter so lines look human.
4. **The commander** — `battleAddCommander`: 2.2× hp, banner overhead, slightly slower.
   **Aggressive generals lead from the front** (their death craters the whole host's morale);
   **cautious ones watch from a rise at the rear** — and ride for their lives if the host breaks.

Teams are **AZURE** (musters at −Z, faces +Z) and **CRIMSON** (+Z, faces −Z).

### Doctrines

Chosen by softmax over the commander genome's `docLogit` (temperature `doctrineTemp`),
archer-heavy hosts biased toward defensive/skirmish via `archerDocCoef`:

| Doctrine | Layout |
|---|---|
| **line** | one strong center advancing + 18% held reserve |
| **wings** | center + two flanking divisions with waypoints wide up the valley sides + reserve |
| **oblique** | one *strong* wing charges, center advances, the weak wing is refused (holds back) |
| **defensive** | center holds ground, 35% reserve |
| **skirmish** | archer screen forward, melee behind it |
| **ambush** *(creative)* | archers planted on flanking **high ground** (`battleHighGround`), melee holds a strong spot and *refuses to advance* until the enemy closes and bleeds — then springs the trap with a full charge. Rolled with probability scaled by the 🎨 **Creativity** slider × the general's caution. |

Temperament: `aggression` and `caution` are sampled per-battle from the genome's mean/spread —
they gate lead-from-the-front, when the center holds vs advances, and when wings are pulled back.

---

## 5. Units and orders

A division is an **anchor** (`ax,az`) + facing that the commander maneuvers
(`battleAdvanceUnits`); bodies dress to slots on that moving anchor. Standing orders:

| Order | Anchor behavior |
|---|---|
| `advance` | close on the nearest enemy division at march speed (mostly straight, mild lateral drift) |
| `charge` | 1.7× speed, direct pursuit |
| `flank` | run to a waypoint wide on the valley shoulder, then convert to `charge` |
| `hold` | ease back to the planned home position |
| `fallback` | withdraw toward its own rear |
| `skirmish` | archer standoff — keep ~75% of bow range (`BATTLE_ARCHER.stand`): give ground when pressed (down to `behind` = 8 behind the rearmost sword division, never further — a kite at march pace from a line advancing at march pace was a chase nobody won), creep forward when out of range |

### The commander's running read (`battleCommanderThink`, every ~0.7–1.4 s)

In priority order:

1. **Withdrawal** — badly outnumbered (`ratio < 0.42`) while the host is still largely intact
   (>68% alive): order a general fallback and *save the army*. If they break contact (centroids
   > 60 apart) with ≥45% of the men alive, the battle ends and **the withdrawer's leader wins**.
2. **Ambush spring** — hold the trap until the enemy is inside 30 units or has drawn blood, then
   everything charges.
3. **Press a win** — the moment he holds an edge (`ratio > 1.12` or the foe is below half
   strength) *everything* charges/flanks: a good general seeks a quick decisive end, fewer men
   bleed on both sides.
4. **Cracked divisions** are pulled out (`fallback`) when their broken fraction passes
   `brokenFallbackFrac`.
5. **Reserve committed** when winning (`reserveCommitRatio`), when the enemy is half-gone, or
   when a friendly division is in trouble.
6. **Wings** fall back when losing badly (scaled by caution), otherwise flank/charge.
7. **Center** holds when losing *and* the general is cautious; otherwise advances.
8. **Army rout** — below a survivor floor (`routBase + routCautionK·caution`) the whole host
   falls back.

Every threshold above is a **learned parameter** (θ_C) — see §8.

---

## 6. The individual soldier

Per-man state machine (`battleStepBody`), all constants in `BATTLE_MELEE` / `BATTLE_FORM` /
`BATTLE_MORALE` / `BATTLE_ARCHER` (live-tunable via `BV.battleTune`):

- **Melee** (`battleStepMelee`): hold your slot; if an enemy is within perception (9) *and*
  pressing him keeps you within the **leash** of your slot (4.2, ×1.9 when charging), close and
  fight — windup → strike → recover with real reach checks, damage 8–16, flinch interrupts,
  knockback shoves. Otherwise dress back into line and face the enemy. A commanded `fallback`
  will not turn to fight.
- **Archer** (`battleStepArcher`): threatened inside min range (11) → kite backward. Otherwise
  hold slot and work the bow: draw 0.55 s, loose a **lobbed** arrow at the nearest foe within
  range 60, cooldown 1.6–2.7 s. The arrow is flown on an arc (`arrowLob`, gravity 9): the loft
  climbs with the range (8° at the muzzle, 38° at full range — a far mark gets a volley arc
  ~12 m high that hangs ~3 s and comes DOWN on him), the launch speed is solved so the arc lands
  on the mark uphill or down, capped by the bow's power (47) beyond which it falls short. The
  mark is led by the man's pace over the last tick (damped 0.85, solved twice). Arrows are
  physically simulated: coming down through head height one hits its mark if he is under it,
  else any foe standing where it falls (`battleArrowVictim`, radius 1.3) — a volley into a
  block finds a man; a lob at a walking man who turned is a miss.
- **Morale** (`battleAssessMorale`, every 0.3–0.55 s): target nerve =
  `0.12 + 0.48·localOdds + 0.22·hpFrac + 0.24·armyFrac + bravery`, −0.15 when personally
  outnumbered. **Fear strikes fast, courage returns slow** (asymmetric smoothing). Break below
  0.30 → rout to the rear; rally above 0.60 → return to line (hysteresis so he doesn't dither).
  Wounds shock morale (−0.14); a comrade falling nearby shocks it (−0.05); **the general falling
  shocks the entire host (−0.32)**.
- **Traits** (θ_S): each man samples personal `bravery` and `aggr` from his side's soldier
  genome — soldiers vary, and the trainer selects on the ones who live and perform.
- **Death**: topple forward, darken, stay on the field.

The kernel adds two learned refinements the editor inherits through the genome: **target
choice** (`targetWeak`/`targetThreat` — favor wounded foes or the man attacking *you*, instead
of strictly nearest) and **distress exploration** (§8).

---

## 7. Resolution

Checked every tick once the deploy phase (1.8 s) ends:

- **Successful withdrawal** — see §5.1: withdrawer keeps ≥45% and breaks contact → his leader
  wins (`outcome.type = 'withdrawal'`); the enemy "holds the field" but the win is hollow.
- **Broken** — a host is beaten when it's wiped, or `alive < 35% of start` while badly
  outnumbered, or under 55% with most of the survivors routing. It quits the field.
- **70 s backstop** — an even grind / mutual archer-kite settles by survivor count.

---

## 8. The learning flywheel (what the AI built)

Two **genome tiers** plug into every battle as plain weight objects — defaults exactly equal
the shipped hand-tuned feel, so "no policy" and "baseline policy" are the same battle:

- **θ_C — commander**: doctrine logits + temperature, aggression/caution means & spreads,
  lead-from-front bias, and *every* in-battle order threshold from §5 (reserve commit, wing
  fallback, center hold, broken-division pull-out, rout floor), plus `exploreGain`.
- **θ_S — soldier**: leash/perception/cooldown/windup multipliers, morale weights and
  break/rally deltas, fallback speed, archery cadence/range, target choice
  (`targetWeak`/`targetThreat`), and the per-individual trait distributions
  (`braveryMean/Spread`, `aggrMean/Spread`), plus `exploreGain`.

**Raw power is frozen.** Damage, reach, base move speed and hp are *not* mutable — the AI can
only win by getting **smarter** (doctrine, positioning, targeting, morale, temperament), never
by cranking stats. (`MUTABLE` in `sim/trainer.js` is the whitelist; clamps keep every gene sane.)

**Distress exploration** — a side losing badly raises an exploration temperature τ
(`distress × exploreGain`): its commander gambles divisions onto fresh orders (biased toward
aggressive gambles — a desperate press, not passivity) and its soldiers occasionally lunge at
*random* foes instead of the tactically best one. Losing sides visibly "try new things," and
those gambles feed the training signal.

### The trainers

Both run **(1+1)-ES online evolution** — no offline batch, the served policy climbs battle by battle:

1. **`sim/trainer.js`** — the always-on Node daemon (`npm run trainer` / `--games N` for a
   bounded batch). Each round a **mutant** of the champion duels the champion over 4
   side-swapped battles; a winning mutant becomes the new champion. Every 3rd round the
   challenger is a frozen **league** past-champion (anti-cycling). Mutation σ adapts by the ES
   1/5-success rule. After each duel, **soldier credit**: champion trait means are nudged toward
   the bravery/aggression of the individuals who *survived and performed on the winning side*.
   Every generation the champion plays the **frozen baseline** — that win% is the honest
   improvement curve (verified 40% → 80%+).
2. **The in-editor trainer** (`battleTrainStep`) — the same ES loop in the browser via the
   kernel: after *every* decided editor battle, a quick champion-vs-mutant burst runs
   headlessly, the champion updates (adopted only on a *clear* 2-win margin — noise-robust), and
   **AZURE immediately plays the improved champion** in the next auto-looped battle. Watching
   battles literally trains the AI. The champion persists in `localStorage` (`bv-champion`).

### Storage & serving

- **`train/ai.db`** (separate from the game's `world.db`; `train/aidb.js`): `battle` rows
  (features + outcome + full record), `soldier_sample` rows (one per man per battle — the θ_S
  signal), versioned `policy` genomes with a promoted **champion**, and `metric` (the
  improvement curve).
- **Server endpoints** (public, no auth):
  - `GET /api/v1/policy/champion` → `{generation, fitness, genome:{commander, soldier}}`
  - `POST /api/v1/battle-log` — editor/game battle records ingest
  - `GET /api/v1/battle-log/stats` — counts + recent aggregates
- The editor fetches the champion at boot (`battleFetchChampion`) and seeds its in-editor
  trainer from it, so browser training continues from where the daemon left off.

### Telemetry (every battle, every man)

Each resolved battle emits an ML-ready **record**: terrain features, both armies' doctrine/
temperament/deployment, a casualty **timeline** (1 Hz samples) + tagged **events**
(first-blood, mass-rout, commander-down, reserve, ambush, withdraw, over…), the **outcome**
(winner, `leaderWin`, type, margin, survivors), and **per-soldier samples** (traits, survived,
kills, damage, held-formation, side-won). Editor battles also log to `localStorage` (📊 panel:
doctrine win rates, lead-vs-watch survival, matchups, bigger-army win%) and optionally POST to
the server. Battles you fought in are flagged `hadPlayer` so pure-AI data can be filtered.

---

## 9. Editor UI

- **HUD (left)**: live counts, routing tallies, phase, per-army doctrine + general status;
  pause/restart; **🧠 AI: Baseline/Champion** toggle; 📊 Log; 📋 Status; 📈 Graph;
  **⏩ Speed** (1–10× sub-ticks, 1× while possessing); **👥 Size** (40–1000 per side);
  **🎨 Creativity** (ambush/unorthodox-plan probability).
- **📋 Status panel**: both hosts — strength bar, doctrine, aggr/caut, distress %, withdrawing
  banner, every division with its standing order + broken count, the leader's state (leading /
  watching / fled / fallen), and a narrated live event log ("CRIMSON wheels to flank",
  "AZURE commits the reserve", "⚑ the lines are drawn — advance!").
- **📈 Learning curve**: win-rate vs baseline per generation, measured for **leaders alone
  (θ_C), soldiers alone (θ_S), and combined** — you watch leadership and soldiering improve as
  separate skills (EMA-smoothed).
- **📊 Battle Intelligence**: the dataset's first-cut analysis + JSON export.

### Hooks (console / tests)

`BV.battle(cfg)` · `BV.battleRestart()` · `BV.battlePause(on)` · `BV.battleStep(steps, dt)`
(headless advance, no rAF) · `BV.battleStatus()` (counts, phases, per-division orders) ·
`BV.battleTune(patch)` · `BV.battlePossess(i)` / `BV.battleRelease()` · `BV.battleSpeed(n)` ·
`BV.battleSize(n)` · `BV.battleCreativity(pct)` · `BV.battleWorldTerrain(on)` ·
`BV.battlePolicy('champion'|'baseline')` · `BV.battleChampion()` · `BV.battleLoadChampion(g)` ·
`BV.battleTrain(on)` · `BV.battleTrainStep()` · `BV.battleGraph(on)` · `BV.battleLog()` ·
`BV.battleIntel()` · `BV.battleLogExport()` / `Clear()` / `Sink(url)` · `BV.battleAutoLoop(on)`.

Kernel: `BattleKernel.run({seed, perA, perB, policies:{A,B}})` → `{record, winner, ticks}`;
`BattleKernel.createBattle(cfg)` → `{tick, status, record}`.

---

## 10. In the game — the same battles everywhere

The editor is the forge; the game is where the blade is worn. The rule: **whenever you can see
NPCs fighting — against you or each other — it is this battle system**, and the AI that
commands them is the **trained champion**, not the hand-tuned baseline.

This is implemented as the **WAR HOST** layer (`game.js`, search `WAR HOST`): any NPC army that
stands up as real fighters gets the editor's commander brain.

- **Field battles** (you on foot, `fieldBattle`): the host that turns on you plans a doctrine
  from the champion θ_C, carves its men into divisions with standing orders, re-tasks them
  live, and every man carries θ_S nerve traits. A beaten or badly-outnumbered host **quits the
  field** instead of feeding you its last man — "🏇 The Enemy Withdraws" (its commander saves
  the survivors, who re-form as a smaller band) or "🏳 They Break and Run!" (a true rout).
  Reinforcements trickling from the reserve fall into the thinnest division's rear ranks.
- **Watched NPC-vs-NPC clashes** (`mapBattles` → live mode): *both* hosts get champion
  commanders — you watch real doctrine-vs-doctrine fights (wings wheeling to flank, reserves
  committed, wavering wings pulled back). A side that chooses withdrawal and breaks contact
  folds back to numbers instead of being massacred.
- **Armies in sight are soldiers, not flags** (`game.js`, search `FIELD_ARMY`): on foot *and on
  the strategic map*, every host in sight — roaming bands, server patrols, your detachments,
  *and your own lead column* (`playerFieldBand`, a pseudo-band riding `player.pos`/`warbandComp`
  while zoomed out; on foot the company walks as real allies instead) — is drawn as a commander
  leading squad blocks in formation, out to the fog wall (`showR: 130`). Only the far overview
  (past `Z_CHART`) folds crowds back to tokens (`crowdRungOn`). The body budget (`capTotal`) is
  spent nearest-first (your columns dress first) and a host's crowd thins with distance (48 men
  close, a ~14-man block at the horizon), re-dressing as you approach — staggered a few hosts
  per frame so a zoom flip never hitches. Past `labelR` (always, on the strategic rungs) the
  floating name/count label stays over the crowd; up close on foot the men speak for
  themselves. Detachments and the lead column field their **true class mix** (horsemen and all);
  sizable enemy hosts trail a **lancer wing** (~8% of the roster, mirroring the battle muster).
  A watched clash still only upgrades to the real fighter sim at ringside range (`liveR: 36`,
  on foot only) — beyond that it's the crowd pantomime (`FIELD_MELEE` duels), so the
  live-fighter budget serves the fights you're actually standing at. `BV.fieldArmies()` lists
  every host currently standing as soldiers.
- **The champion is fetched at boot** (`npcChampionInit` → `/api/v1/policy/champion`, plus the
  locally-trained `bv-champion` from localStorage); with no server the hosts fall back to the
  shipped baseline (identical to the genome defaults). `BV.warHosts()` shows every fielded
  host's doctrine, per-division orders, and withdrawal/rout state live.
- **Strategic maneuvering (the map layer)** (`server/warfare.js`, search `STRATEGY`): free
  hosts are never parked. Every few ticks each commander re-reads the local balance of power
  and takes a **standing order** — *hunt* a beatable rival, *mass* with a stronger friendly
  stack, *probe* an enemy border at a caution-scaled standoff (pacing along it), *storm* a
  weakly-held wall, *guard* his own marches, or *withdraw* from hopeless ground — with
  temperament and doctrine weights from the same served champion θ_C. The map shows it as
  intents: "Hunting Garrec Frostbeard", "Massing with Doran Oakheart", "Probing the border at
  Wendmark", "Falling back in good order".
- **Cavalry** (`game.js`, search `MOUNT`): a game-side class — **Horsemen** (`horse`, 18 XP) in
  the warband and **lancers** (~8% of any sizable enemy roster; knight+ stations start with a
  wing). The rider is the real humanoid rig seated on a procedural horse (`buildCavalry`), so
  every pose/swing works from the saddle; `walkLegs`/`restLegs` route to a walk→gallop horse
  gait. Movement identity: **~1.7× infantry pace and a charge-shock damage bonus (up to +50% at
  full tilt), paid for with the worst manoeuvre on the field** — `mountSteer` caps yaw by speed
  and drags momentum onto the facing (no strafing), so a committed charge carves wide arcs and
  overshoots. Preview: `?edit=horseman` (walk/run buttons) or `?anim&horse=1`; in-game
  `BV.cav(n)` grants n horsemen. Cavalry is NOT in the kernel (`sim/battle.js`) yet — the
  self-play flywheel still trains on foot classes only.

The long game (see `VISION.md`): every battle the world fights — including the ones NPCs fight
against *you* — feeds the same dataset, and the served champion keeps climbing. The NPCs are
learning to make war.

---

## 11. Adjacent benches

- **March editor (`?march`)** — the sandbox for everything that happens *between* battles: two
  NPC hosts patrol two real towns on real worldgen terrain (roads included) and clash where
  their circuits cross. It tunes how armies **walk** — formation cohesion, road-following,
  terrain handling, foot animation — with a pause/speed/gap HUD, a path overlay (`P`), a live
  narration log, and `BV.march*` / `BV.marchTune(patch)` console dials
  (`?march&seed=7&n=44&sep=26` pins a scenario).
- **Battle markers on the map** — a battle you are *not* watching is shown by the screen-space
  marker layer (`#markers` + `MK` in `game.js`): a pulsing ⚔ over a live two-faction
  tug-of-war bar, constant pixel size at any zoom, hoverable/clickable. Painted symbols are
  never 3D-scaled world objects.
