# Battle Editor & Self-Improving Battle AI

A sandbox for staging AI-commanded army-vs-army battles in the game's real terrain — and, layered on top of it, a **continuously-improving two-tier battle AI** that gets smarter after every fight. The editor is both the thing you play with and the training environment for the AI that will eventually drive NPC warfare.

Open it at **`?battle`** (e.g. `http://localhost:8787/?battle`). It bypasses the normal world boot.

---

## 1. Quick start

| Action | How |
|---|---|
| Open the editor | append `?battle` to the game URL |
| Pause / resume | ⏸ **Pause** button (also gates training + auto-loop) |
| Restart a fresh battle | ↻ **Restart** |
| Toggle Baseline ↔ Champion AI | 🧠 **AI** button |
| Open the live status panel | 📋 **Status** |
| Open the raw battle log | 📊 **Log** |
| Open the learning-curve graph | 📈 **Graph** |
| Speed up the sim (1–10×) | **Speed** slider |
| Army size cap (40–1000) | **Size** slider |
| Commander creativity (0–100%) | **Creativity** slider |
| Possess a soldier (WASD + mouse-look) | click any soldier |
| Release possession | Esc / release |

Two armies muster automatically — **🧠 AZURE** (left) and **💪 CRIMSON** (right) — deploy under AI commanders, and fight. When a winner is decided the battle is logged, the AI trains on it, and a new battle starts ~2.4s later. **Training and auto-restart are always on unless you pause.**

### URL parameters
- `?battle` — enter the editor.
- `?valley` — use the synthetic V-valley terrain instead of real overworld terrain.
- `?n=<count>` — fixed per-side count (cap 1000).
- `?maxn=<count>` — army size cap (drives the Size slider).
- `?fixed=1` — both sides get identical counts (no mismatch roll).

---

## 2. What you're looking at

- **Two armies** of low-poly humanoids (`buildHumanoid`) — melee and archers — deploy into formation, advance, and fight man-to-man with pushing (no clipping), morale, fallback, and death.
- **AI commanders** plan a deployment *before* the battle (doctrine + divisions + posture), then issue *live orders* to their divisions during the fight, and decide whether to lead from the front, hold in reserve, press to finish, or withdraw.
- **Real terrain** — by default the battlefield is a random patch of the actual game overworld (rolling hills sampled from `Terra`), so high ground and valleys are genuine features the commanders can exploit.
- **The AI improves as you watch** — after each battle a self-play trainer runs, and the 📈 graph tracks how leadership skill and individual-soldier skill climb against a frozen baseline.

---

## 3. The two-tier AI (what actually learns)

Everything the AI does is driven by a small JSON **genome** — a few dozen inspectable weights. A policy served to one side is a pair `{ commander: θ_C, soldier: θ_S }`.

### Commander tier — θ_C (strategic)
Controls doctrine and command decisions:
- **Doctrine** — chosen by a softmax over per-doctrine logits (`line`, `wings`, `oblique`, `defensive`, `skirmish`), keyed on battle context (archer fraction, army size, terrain width).
- **Temperament** — aggression / caution means, lead-from-front vs. watch-from-distance bias.
- **Order thresholds** — when to commit the reserve, when a wing falls back, center-hold gates, rout thresholds — all lifted out of magic numbers into θ_C.
- **Creativity** — probability of planning an **ambush**: hold the melee in the valley while placing archer bands on flanking high ground, then spring once the enemy closes.
- **Withdrawal** — when badly outnumbered but still intact, break contact and save the army (see §5).

### Soldier tier — θ_S (individual tactics)
Every soldier is its own agent. At spawn it **samples personal traits** (bravery, aggression, target bias ± noise) from θ_S's distributions, so individuals vary. θ_S controls:
- engage-vs-hold leash, target selection (nearest / weakest / most-threatening weighted score),
- melee wind-up / press aggression, archer kite distance and cadence,
- morale break / rally thresholds, flinch recovery.

Each soldier's outcome — survived? kills? damage dealt? held its slot? side won? — becomes a **training sample** (`soldier_sample`), which is how the individual tier learns.

### Distress-driven exploration (the "try new things when losing" rule)
Each think-tick a side computes **distress** = its casualty rate relative to the enemy's. Distress raises an exploration temperature **τ** that feeds both tiers *mid-battle* (a losing commander deviates from the greedy plan; distressed soldiers switch tactics). It's biased toward **aggression**, not passivity, so losing sides gamble decisively rather than grinding to a timeout. Across battles, a policy on a losing streak mutates harder (σ) — see §6.

---

## 4. Architecture — the flywheel

A closed self-play loop, always on, updating after every battle:

```
 reproducible sim (environment)
        │
        ▼
 genome-driven commanders + soldiers (agents)
        │
        ▼
 logged battles + per-soldier samples (experience)
        │
        ▼
 online (1+1)-ES trainer → smarter champion (learning)
        │
        ▼
 champion served back to the editor ───┐
        ▲                              │
        └──────────────────────────────┘
```

### Files

| File | Role |
|---|---|
| `sim/battle.js` | **Headless kernel** (UMD — runs in Node *and* the browser as `window.BattleKernel`). A faithful, THREE/DOM-free port of the editor's tactical sim. One seeded `mulberry32` RNG → `(seed, policies)` is byte-deterministic. `createBattle(cfg)` / `run(cfg)`; `defaultCommanderGenome()` / `defaultSoldierGenome()` / `DOCTRINES`. Emits a record (features + timeline + outcome) plus `soldierSamples[]`. ~2 battles/sec/core. |
| `sim/trainer.js` | **Always-on online trainer** (`npm run trainer`). (1+1)-ES self-play; the served champion climbs battle by battle. |
| `train/aidb.js` + `train/ai.db` | **Separate** better-sqlite3 database (NOT `server/world.db`) for all learning data. |
| `game.js` | The `?battle` editor: renders the sim, drives the in-browser trainer, HUD, panels, graph. All `BATTLE.*` functions + `BV.battle*` hooks. |
| `server/index.js` | Public routes to ingest editor battles and serve the champion (§7). |
| `perf/battle-determin.js` | Determinism test — same seed + genomes → byte-identical record. `npm run battle:determin`. |

### `train/ai.db` schema
- `battle` — one row per battle: seed, both genomes, winner, features, outcome, full record, source, had_player.
- `soldier_sample` — per-individual experience (side, role, traits, survived, kills, damage, held_slot, side_won). The soldier-AI training signal.
- `policy` — versioned `{commander, soldier}` genomes with generation, fitness, champion flag.
- `metric` — the improvement curve (champion win% vs. frozen baseline per generation).

---

## 5. Battle rules & tactics

- **Fair fights by default.** `battleArmySpecs` musters both hosts around the same base (±10%). Only ~10% of battles are a real mismatch (the weaker side ×0.32–0.57). Verified ~55/60 within 35% ratio.
- **Up to 1000 per side.** A spatial hash grid (`battleRebuildSpatial`, cell 12, rebuilt per tick) makes neighbor scans near-linear so large hosts stay tractable (rendering the humanoids is the heavy part, not the sim).
- **Who holds the field = who's still standing on it.** The winner is decided by the **holding count** (`battleHolding`: men alive *and* nerve intact *and* not fleeing/falling back/routing/withdrawing), never by raw survivor count. A side whose men all ran away has abandoned the field even if more of them are still breathing off in the hills — so it loses. If one side's holding count collapses to zero while the other still stands, the battle resolves at once. This is what stops a fleeing army from being wrongly credited with "holds the field."
- **End fast, few casualties.** Leaders re-decide ~2× more often, and the moment they hold a clear edge (`ratio > 1.12` or foe below half strength) they press/charge/flank to end the fight — a shorter fight means fewer losses.
- **Withdrawal is a WIN for that leader.** A commander badly outnumbered (`ratio < 0.42`) while still intact (`> 68%` strength) orders a fallback; if the army breaks contact (living-centroid gap > 60) keeping ≥45% of its men, that's `outcome.type='withdrawal'` and `outcome.leaderWin` credits the *withdrawer*, not the field-holder. The AI learns to run from a hopeless fight. (Mirrored in both the editor and the kernel; the trainers select on `leaderWin`.)
- **Ambush (creativity).** With the Creativity dial up and ≥3 archers, a commander may plan an ambush: melee holds, two archer bands deploy on the best flanking hills, everyone waits until the enemy is close (or blood is drawn, or 28s elapse), then springs into a full charge.
- **Real terrain.** `battleRollTerrain` samples a random land patch of the overworld via `Terra.make(seed).elevationAt(...)`; `battleValleyY` returns the elevation so high ground is a real advantage. `?valley` forces the synthetic valley.

---

## 6. The trainer (`sim/trainer.js`)

```bash
npm run trainer                 # run forever (background daemon)
node sim/trainer.js --games 400 # bounded batch (for verification), then stop
node sim/trainer.js --quiet     # no per-generation log lines
node sim/trainer.js --seed 1234 # fixed RNG seed
```

How it improves, online, no offline batch required:
- **(1+1)-ES:** each round a *mutant* of the champion duels the champion (4 battles, sides swapped to cancel bias). A mutant that clearly wins becomes the new champion. So the served policy climbs battle by battle.
- **Raw power is FROZEN.** Damage, reach, move speed, and HP are never mutated — the AI can only win by getting *smarter* (doctrine, positioning, targeting, morale, traits), never by cranking stats. See `MUTABLE` in `sim/trainer.js`.
- **Soldier credit:** after each duel, the champion's soldier traits are nudged toward the bravery/aggression of the individuals who actually survived and dealt damage on the winning side.
- **Adaptive exploration:** the mutation σ follows the ES 1/5-success rule — explore harder when there's room to improve, refine when winning.
- **League:** the champion also duels frozen past champions to avoid self-play cycling (A beats B beats C beats A).
- **Benchmark:** every few generations the champion plays the frozen baseline; that win% is the improvement curve, written to `metric`.

**Verified result:** champion-vs-baseline climbed **~40% → 80% over ~260 battles** (14.9k soldier samples, 11 generations), converging on higher aggression + braver soldiers.

### In-editor trainer
The same kernel loads in the browser, so the editor trains too. After each visible battle, `battleTrainStep()` runs a (1+1)-ES burst (4 kernel duels, champ-vs-mutant), evolves `BATTLE.train.champion` (both tiers), nudges soldier traits, adapts σ, persists to `localStorage['bv-champion']`, and sets AZURE to play the champion. **Adoption is conservative** (`mutantWins − champWins ≥ 2`) so gains are monotonic despite 4-battle noise. Verified in-browser: 40% → 70% vs baseline over 16 rounds.

### The learning-curve graph (📈)
`battleTrainMeasure()` isolates each tier against the frozen baseline via the kernel:
- `{champion.commander, baseline.soldier}` → **leadership** skill (blue),
- `{baseline.commander, champion.soldier}` → **individual-soldier** skill (orange),
- combined (green), with a dashed 50% parity line.

EMA-smoothed (α = 0.25), 3 battles per point, appended to `BATTLE.train.history`. Only runs while the graph is open (its 9 extra kernel battles/step are the cost).

---

## 7. Server integration (serving the champion)

Public routes in `server/index.js` (before the auth seam, lazy-guarded by `aidbSafe()` so the game server boots fine even without the training subsystem):

- `POST /api/v1/battle-log` — ingest a battle from the editor into `train/ai.db` (source `'editor'`).
- `GET  /api/v1/policy/champion` — serve the current champion genome `{commander, soldier}`.
- `GET  /api/v1/battle-log/stats` — battle/sample counts and champion generation.

The editor calls `battleFetchChampion()` at boot (`GET :8787/api/v1/policy/champion`), with a graceful null fallback to the bundled default. When `BATTLE.policyMode === 'champion'`, AZURE plays the served champion vs. CRIMSON on baseline.

---

## 8. Config & test hooks

### `BATTLE.cfg` defaults
```js
{ perSide: 40, seed: 1, archerFrac: 0.34, fixed: false, sink: null,
  maxArmy: 200, worldTerrain: true, creativity: 0.5 }
```

### `BV.*` console hooks (headless testing / live control)
| Hook | Purpose |
|---|---|
| `BV.battle(cfg)` | boot / reconfigure the editor |
| `BV.battleRestart()` | new battle |
| `BV.battlePause(on)` | pause (also gates training + loop) |
| `BV.battleStep(steps, dt)` | **advance the sim without waiting on rAF** (essential for headless verification) |
| `BV.battleStatus()` | current armies / winner / policy mode |
| `BV.battleSpeed(n)` | 1–10× speed |
| `BV.battleSize(n)` | army cap 40–1000 |
| `BV.battleCreativity(pct)` | commander creativity 0–100 |
| `BV.battleWorldTerrain(on)` | real terrain ↔ synthetic valley |
| `BV.battlePolicy('champion'\|'baseline')` | which AI AZURE plays |
| `BV.battleChampion()` | current champion generation / mode |
| `BV.battleLoadChampion(genome, gen)` | inject an offline/bundled champion |
| `BV.battleTrainStep()` | one manual training step (headless) |
| `BV.battleGraph(on)` | toggle the learning graph |
| `BV.battlePossess(i)` / `BV.battleRelease()` | control / release a soldier |
| `BV.battleLog()` / `BV.battleIntel()` / `BV.battleLogExport()` | the dataset + aggregate readout + JSON export |
| `BV.battleOrder(teamIdx, order)` | force `'advance'` / `'hold'` on an army |
| `BV.battleTune(patch)` | live-dial the melee feel (`BATTLE_MELEE`) |

> **Testing note:** the preview browser tab pauses `requestAnimationFrame` when idle, so wall-clock ≠ sim time. Drive the sim headlessly with `BV.battleStep(n)` rather than waiting.

---

## 9. Known gaps & next steps

- **Fidelity gap (top follow-up).** The editor currently applies only the *commander* tier (+ a per-soldier bravery) to its animated sim; the editor's soldier step functions still read the global `BATTLE_MELEE/FORM/MORALE/ARCHER` constants. So the champion's *soldier-tactics* edge doesn't transfer to the visible editor — the champion looks ~parity in the editor even though it's ~80% in the kernel. Fix = **kernel-render unification**: have the editor render `sim/battle.js` via a per-army resolved soldier table (`army.S`), defaulting to the current constants for zero regression.
- **Ambush/creativity not in the training kernel yet.** The kernel `commanderThink` is synthetic-valley-only and doesn't plan ambushes, so the trainer can't *learn* those tactics. Mirror them into the kernel.
- **Winner casualties stay ~48%** (frontal-attrition sim). Driving it lower means rewarding fast/low-casualty wins in the trainer *fitness* (currently win-only) and adding envelopment tactics.
- **Phase 4 — `train/train.py`** (offline win-probability + soldier-value models as surrogate fitness / selection heads) — planned, not built.
- **Phase 6 — bridge to server NPC battles** (`server/warfare.js` / `WorldSim.resolveClash`). The seam (served champion + shared kernel) is built; the integration is future work.

---

## 10. Verification checklist

1. **Determinism:** `npm run battle:determin` — same seed + genomes → identical record.
2. **Data:** `npm run trainer -- --games 300` → `battle` + `soldier_sample` rows accrue in `train/ai.db`; `server/world.db` untouched.
3. **Continuous learning:** the trainer's champion-vs-baseline win% rises across battles (the `metric` curve).
4. **Serving:** `npm run server`, open `?battle`, toggle 🧠 AI to Champion → AZURE plays the served champion.
5. **In-editor:** watch the 📈 graph climb above the 50% parity line over successive battles.
