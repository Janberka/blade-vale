# Blade Vale — Battle Controls

How you command your warband, before and during a fight. The whole system lives in
`game.js` (the *Command Deck* section) with markup/styles in `index.html`.

---

## The mental model: **Orders × Pace**

Every squad has two independent settings:

| You set… | …which decides | Options |
|---|---|---|
| **Order** | *what* the squad does / where it goes | Charge · Hold · Hold Zone · Regroup · Free |
| **Pace** | *how fast* it moves to get there | 🐢 March · ⚡ Rush |

They're orthogonal: a squad can *Charge at a Rush* or *hold a zone while Marching*. "One group
holds this area, the other rushes in" = Group A → Hold Zone + March, Group B → Charge + Rush.

There is **no right-click** — the left mouse does everything.

---

## When you command

There are two moments, both using the same controls:

- **Battle Plan (pre-battle):** after you pick a fight, the field is staged and frozen. Lay out
  your squads, give orders, then press **Begin Battle**. Orders here *position* troops instantly.
- **Mid-battle command:** press **Esc** during the fight to open the deck. Time slows to a
  tactical crawl (~0.18×) while you issue orders; troops **start marching** to new orders (they do
  not teleport). Press **Enter / Resume / Esc** to return to the fight. The collapsed deck shows a
  **⚔ COMMAND** tab on the screen edge.

---

## Step 1 — Select a squad

- **Click its card** in the Command Deck (right side), or
- **Click any soldier** on the field → selects his whole squad, or
- Press **1–9** → selects squad 1–9, or
- Press **G** → selects every soldier.

A selected squad's soldiers wear a **green ring**; squad members always wear a **coloured ring**
matching their squad's card.

> With **nothing** selected, the left mouse selects instead of commanding: click a soldier to pick
> him, or drag a box to band-select. This is how you form squads at the start.

## Step 2 — Order it on the field (left mouse)

With a squad selected, act anywhere on the ground:

- **Click a spot → march there & hold.** A **rally flag** in the squad's colour marks the
  destination. (Pre-battle they snap into place there; mid-battle they march to it.)
- **Drag a box → hold that zone.** The squad spreads to cover the rectangle, which draws on the
  ground in the squad's colour.

## Step 3 — Tune order & pace from the card

Each squad card has order buttons and a pace toggle:

- **Charge** — seek and destroy the enemy host.
- **Hold** — stand and defend the squad's *current* ground (also key **H**).
- **Regroup** — fall back and re-form on the player (also key **R**).
- **Free** — fight at will; drift back toward the player when there's no foe (also key **F**).
- **🐢 March / ⚡ Rush** — the pace toggle (keys **Z** / **X**).

(Hold Zone and "march here & hold" are set by the map gestures above, not buttons. The card's
status text shows the live order: *Charging · Holding · Holding zone · Regrouping · At will*.)

---

## The orders in detail

### Charge
Advances on the enemy and presses the attack, pursuing freely. Pace controls the advance — Rush
sprints into contact, March holds a disciplined line and only breaks into a full charge near
contact.

### Hold (a point)
Marches to a spot and defends it. Set by **clicking the field** (a flag marks the spot) or the
**Hold** button (holds current ground). Units fight what comes into reach but won't chase far from
the point.

### Hold Zone (a rectangle)
**Drag a box** on the field. The squad distributes across the rectangle (melee toward the leading
edge, ranged behind). **Melee** soldiers engage any enemy that enters the zone — or comes within a
short margin (`ZONE_LEASH`) of it — then **fall back into the zone**. **Archers and throwers loose
at any enemy within their weapon range without leaving the zone** (so a garrison rains fire while
its melee holds the line). This is the tool for garrisoning ground, holding a flank, or staging a
reserve.

### Regroup
Falls back and re-forms a tidy block on the player. Good for pulling a battered squad out.

### Free
No leash: fights the nearest foe, and when none is near, regroups loosely on the player.

---

## Pace: March vs Rush

- **🐢 March (default):** measured advance — moves at ~42% speed until close to contact, then
  charges the last stretch. Keeps formation and timing; use it to hold a line or arrive together.
- **⚡ Rush:** full speed to the objective the whole way.

Concretely, while crossing open ground a Rush squad travels **~2.4× farther** than a March squad in
the same time. Pace applies to charging, marching to a point, and moving into a zone.

---

## Squads carry over between battles

Set your squads up once and they **persist**. At the start of each battle the warband is freshly
mustered and your remembered squads are automatically re-filled from it — same composition, same
orders, same pace, same zones/positions — so you can just press **Begin Battle** and go.

- Survivors refill the squads first; if a squad's whole class was lost it stays empty and refills
  once you recruit replacements.
- Disband a squad any time with the **×** on its card. Adjust composition with the **− / +**
  steppers, or **Split into N** for instant even squads.

---

## Full input reference

### Mouse (Plan or mid-battle command — deck open)
| Input | Nothing selected | Squad selected |
|---|---|---|
| **Left click — soldier** | select his squad | select his squad |
| **Left click — ground** | clear selection | **march there & hold** (flag) |
| **Left drag — box** | band-select soldiers | **hold that zone** (rectangle) |
| **Click card / 1–9** | select that squad | select that squad |

### Keyboard
| Key | Action |
|---|---|
| **1–9** | select squad 1–9 |
| **G** | select all soldiers |
| **A** | Charge |
| **H** | Hold (current ground) |
| **R** | Regroup on the player |
| **F** | Free |
| **Z** | March pace |
| **X** | Rush pace |
| **N** | new squad (Plan only) |
| **Enter** | Begin Battle / Resume |
| **Esc** | open command (mid-battle) / resume |

### Reading the field
- **Green ring** — selected soldier.
- **Coloured ring** — belongs to that-coloured squad.
- **Coloured rally flag** — a squad's Hold point.
- **Translucent coloured rectangle** — a squad's Hold Zone.

---

## Developer notes

State and behaviour, for when this needs changing.

### Per-soldier (ally) fields — `spawnAlly`
- `order`: `'free' | 'hold' | 'zone' | 'attackmove'` — the compiled AI mode the fighter runs.
- `holdPos`: `Vector3` target for `hold`.
- `zone`: `{minX, maxX, minZ, maxZ}` and `homeSlot`: `Vector3` slot inside it, for `zone`.
- `pace`: `'march' | 'rush'`. Enemies have no `pace` → treated as March.

### Per-squad (group) fields — `newGroup`
`{ id, name, color, order, pace, anchor, zone, zoneMesh, holdMarker, recipe, lastPreset }`
where `order` ∈ `attack | hold | zone | regroup | free`, `recipe` is the remembered class count
`{sword, long, archer, thrower}`, and `anchor` is the Hold point.

### Key functions
- `paceFactor(f, dist)` — `rush ? 1 : (dist > 26 ? MARCH_PACE : 1)`; threaded through every advance
  in `stepFighter`. Constants: `MARCH_PACE = 0.42`, `ZONE_LEASH = 7`.
- `stepFighter` (the `chase` branch) — runs the `hold` / `zone` / `attackmove` / `free` AI.
  `nearestFoeInRect(f, z, m)` finds the foe a zone-holder defends against.
- Orders: `applyPresetToMembers`, `orderGroup`, `commandSelection` (keys). Pace: `setGroupPace`,
  `commandPace`. Zone: `assignZone`, `setGroupZone`, `commandZone`. Point: `deploySelected` /
  `arrayGroupAt`.
- Overlays: `buildZoneOverlay`/`updateZoneOverlay`/`disposeZoneOverlay` and
  `buildHoldMarker`/`updateHoldMarker`/`disposeHoldMarker`.
- Persistence: `refreshGroupRecipe` (on membership change) + `rebindGroupsToPool`
  (called by `enterPlanPhase` instead of the old `resetGroups`).
- Input: a single left-mouse handler block. `planDrag.command = selected.size > 0` is captured at
  mousedown and decides command-vs-select for the whole gesture. `planActive()` gates it to the
  Plan phase and the mid-battle command deck.

### Constants in the UI
`ORDERS = [['attack','Charge'],['hold','Hold'],['regroup','Regroup'],['free','Free']]`,
`PACES = [['march','🐢 March'],['rush','⚡ Rush']]`,
`ORDER_LABEL` maps the internal order to the card's status text.

### Gotchas
- **Ground orders only resolve where the camera ray hits the `y=0` plane.** The Plan camera lerps
  into place over ~1s; a command issued in the same synchronous tick as entering the Plan can read a
  stale camera and miss. In normal play (settled camera) the whole visible field is clickable.
- Mid-battle, `mode === 'battle'` ⇒ orders set targets without teleporting (troops march); in the
  Plan, `mode === 'plan'` ⇒ orders teleport troops into position.

### Headless test hooks (`window.BV`)
- `BV.enterBattleWith(size)` — jump straight into a battle's Plan (enemy `size` < 16 avoids the
  hero deck the normal flow seeds).
- `BV.plan.{ newGroup, assignToGroup, splitIntoGroups, selectGroup(i), orderG(i,preset),
  zoneG(i,rect), paceG(i,pace), deploySelected(vec3), beginBattle, openCommandDeck, resumeBattle,
  groups(), selCount(), commandPanelOpen() }`.
- `BV.advance(secs)` — step the battle deterministically (no rendering) for timing checks.

> Previewing: the sandboxed dev server can't read the project dir — files are served from
> `/tmp/blade-vale`, so `cp game.js index.html /tmp/blade-vale/` after every edit and bump
> `game.js?v=N` in `index.html` to bust the cache.
