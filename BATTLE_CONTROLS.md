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
- **Mid-battle command (real time):** you **command while you fight** — no pause, no slow. Keep
  playing (mouse-look, move, swing) and tap a hotkey to order your squads live: pick a squad with
  **1–9 / G**, then **H** hold · **T** charge · **B** free · **R** regroup, and **Z / X** for pace. A
  short toast confirms each order and the troops **start marching** to it (they don't teleport).
- **The command deck (optional):** for cursor work — drawing hold-zones, box-selecting, fine
  positioning — press **Esc** to open the overhead deck. It frees the cursor (and slows time to a
  tactical ~0.18× while open) and shows a **⚔ COMMAND** tab on the screen edge; **Enter / Resume /
  Esc** returns you to the fight. You no longer *need* it for everyday orders.

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

- **Charge** — seek and destroy the enemy host (live key **T**; **A** in the deck).
- **Hold** — stand and defend the squad's *current* ground (key **H**).
- **Regroup** — fall back and re-form on the player (key **R**).
- **Free** — fight at will; drift back toward the player when there's no foe (live key **B**; **F** in the deck).
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

## The overworld & the allied war (map layer)

The strategic map is where battles are *chosen* and alliances are forged. It now wars in real time
and lets allies fight together.

### Living battles you can see — and join
Rival hosts that meet no longer resolve in a blink. They **lock together and fight over time** at a
contested point: a glowing disc, a two-colour strength bar, and the banners' troop counts ticking
down before your eyes. A clash's length is computed from the hosts (a **1-on-1 of swordsmen ≈ 3s**,
scaling ~`size^0.4` up to a ~70s siege; a lopsided fight routs faster). Fresh hosts can march in and
**reinforce either side mid-fight**, turning the tide. **Ride into a clash** to throw in beside the
host you reach. *(This plays out client-side in offline/solo worlds; in a server-driven shared world
the macro war is still resolved by the backend.)*

### Your army marches as columns — split it into detachments
On the map your host is no longer a lone flag: the **lead column** (the men riding *with you*) walks as
a small banner-topped cluster of soldiers, and you can peel off **detachments** that roam, fight, and
hold ground on their own.

Press **C** (or tap **⚑ Command**) to open **command mode** — the cursor frees and the map holds still.
From the panel on the right:

- **Form a detachment** — pick a class mix and press *Form detachment*. Those men leave the lead column
  and march at your side (up to 6 detachments).
- **Select** a detachment (click its column, its panel card, or press **1–9**), then order it:
  - **Click open ground → March** there and hold.
  - **Click a hold → Garrison** it (parks there to guard it; storms it first if it's a weak-enough
    enemy hold).
  - **Patrol (P)** → click to drop waypoints, then **Enter / right-click** to set; the detachment walks
    the route back and forth forever, intercepting enemy bands that cross it.
  - **Follow (F)** / **Hold (H)** / **Recall (R)** (rejoins the lead column) · pace **Z/X** (March/Rush).

A detachment fights rival bands on its own through the same visible living-clash system — **ride in to
reinforce** it, or let it auto-resolve. A detachment that loses a clash is broken and its men are lost,
so weigh what you send where. Press **C** / **Esc** to leave command mode.

### Pacts & alliances
Ride into a neutral band → **Propose Pact** (acceptance rises with your renown). Allied bands fly a
**✦** marker, can't be attacked by accident, and **answer your call to arms**. In a shared world,
other players are allies too. Ride into an allied band to **Break Pact** or greet them.

### Call to Arms / Crusade — press **G** on the map
- **Near an enemy castle → CRUSADE:** every ally on the map is summoned to its walls. Let them
  muster, then storm it together as one host.
- **In open field → RALLY:** allied bands within reach march to your banner.
- A beacon + pulsing ring marks the muster point; a HUD banner counts the answering banners and the
  time left. Press **G** again to cancel.

### Working together is a real edge
When you start a fight, **nearby pacted bands (and any host you rode in to aid, and everyone a call
summoned) join your side** as reinforcements — their named soldiers fight beside yours but return
home afterward (they never join your permanent warband, and their losses don't dock your XP). Each
answering **banner grants a coordination bonus** (up to +50% might to your whole side). A crusade
that gathers many banners hits a castle like an avalanche.

### Co-op: two players, one arena — press **J** on the map (shared world)
In a shared world you can **ride into an ally's live battle**. Press **J** to list allied battles and
**Join** one: your warband is handed to the host's arena and fights at their side, and you watch the
clash unfold and share the victory. Co-op runs over the server's WebSocket relay (`/coop`),
**host-authoritative** — the host runs the sim and broadcasts snapshots. *(v1: the host simulates and
the guest's troops + spoils are shared and rendered live; direct guest-avatar sword control is the
next step and needs two-device testing.)*

---

## Full input reference

### Mouse (Plan or mid-battle command — deck open)
| Input | Nothing selected | Squad selected |
|---|---|---|
| **Left click — soldier** | select his squad | select his squad |
| **Left click — ground** | clear selection | **march there & hold** (flag) |
| **Left drag — box** | band-select soldiers | **hold that zone** (rectangle) |
| **Click card / 1–9** | select that squad | select that squad |

### Keyboard — command live (while fighting, full speed)
| Key | Action |
|---|---|
| **1–9** | select squad 1–9 |
| **G** | select all soldiers |
| **H** | Hold (current ground) |
| **T** | Charge |
| **B** | Free (fight at will) |
| **R** | Regroup on the player |
| **Z** / **X** | March / Rush pace |

*(Charge is **T** and Free is **B** here because **A** is strafe and **F** swaps your weapon during
the fight. Selecting a squad rings it; with nothing selected, an order applies to your whole army,
and the selection rings fade after a couple of seconds.)*

### Keyboard — Plan / command deck (cursor open)
| Key | Action |
|---|---|
| **1–9 / G** | select squad / all |
| **A** *(or **T**)* | Charge |
| **H** | Hold (current ground) |
| **R** | Regroup |
| **F** *(or **B**)* | Free |
| **Z** / **X** | March / Rush pace |
| **N** | new squad (Plan only) |
| **Enter** | Begin Battle / Resume |
| **Esc** | open command deck (mid-battle) / resume |

### Keyboard (overworld map)
| Key | Action |
|---|---|
| **WASD** | roam the map |
| **L / P** | **zoom rungs**: L steps *in* (overworld → strategic map → **action mode**, 3rd-person hero with full battle controls), P steps *out* toward the wide overview. *(The old T / mouse-wheel zoom is removed.)* |
| **F** | **flare every party** on the map (yours + allies') and open a compass you can march by; flares burn ~12s |
| **U** | **characters drawer**: switch between your characters, split/give troops, multi-select for bulk join/follow/patrol orders |
| **C** | toggle **command mode** (split & order detachments); **Esc** to leave |
| **1–9** | (command mode) select detachment 1–9 |
| **P** | (command mode, detachment selected) draw a patrol route — **Enter / right-click** to set |
| **F / H / R** | (command mode) Follow · Hold · Recall the selected detachment · **Z/X** = March/Rush |
| **G** | Call to Arms (near an enemy hold → Crusade); press again to cancel |
| **J** | find & join an ally's live battle (shared world) |
| **V** | warband charsheet |

*(`G` is context-sensitive: on the map it sounds the call; in a battle/plan it selects all soldiers.
`C` is overworld-only — in a battle it's crouch. `F` and `P` are likewise contextual: outside command
mode they are flares / zoom-out, inside it they are Follow / patrol.)*

### Touch devices
On phones/tablets (or with `?touch=1` on desktop) the full control set is mirrored to a touch HUD:
a floating left-thumb stick for movement, drag-anywhere-else to look, and context-sensitive button
clusters that swap per mode (combat verbs in a fight, kingdom/map verbs on the overworld). Panels
that would cover the left thumb start collapsed to a chip — tap to expand.

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
  groups(), selCount(), commandPanelOpen(), battleKey(code), battleOrder(preset), battlePace(pace),
  selLabel() }` — the `battle*` hooks drive the real-time field-command layer (no deck, no slow).
- `BV.advance(secs)` — step the battle deterministically (no rendering) for timing checks.
- `BV.advanceMap(secs)` — step the overworld (living battles, marches, calls) deterministically.
- `BV.startClash(a,b)` → duration · `BV.mapBattles()` — living-battle timing/inspection.
- `BV.pacts()` · `BV.allyWith(i)` · `BV.alliedBandsNear(r)` — diplomacy.
- `BV.raiseCall()` · `BV.activeCall()` · `BV.tp(x,z)` — call to arms / crusade.
- `BV.coopState()` — reinforcement/coordination state in the current battle.
- `BV.coop()` · `BV.coopBuildSnapshot()` · `BV.coopApplySnap(s)` — co-op transport + snapshot codec.

### The overworld / co-op layer (where the code lives)
- **Living battles:** `startMapBattle` / `joinMapBattle` / `updateMapBattles` / `finishMapBattle` in
  `game.js`; calibrated by `clashDuration`. Bands carry `inBattle`; markers are disposed on finish.
- **Detachments (player map columns):** `detachments[]`; `makeColumn`/`animateColumn` (reuse
  `buildHumanoid` + `walkLegs`); `detach`/`mergeDetachment`/`reconcileDetachment`; `updateDetachments`
  (the per-frame order AI: follow/move/patrol/hold/garrison/regroup); they clash via the same
  `startMapBattle` path (gated on `areFactionEnemies`, so only declared foes). Command UX:
  `toggleCmdMode` + `renderDetPanel` + `onMapCmdClick` (reuses `groundPointAt`); overlays
  `buildRouteMarker`/`updateRouteOverlay`/`buildDetFlag`. `warbandComp`/`warbandRoster` stay the LEAD
  column; each detachment owns a disjoint `comp`/`roster` (every Character is in exactly one). Test
  hooks: `BV.map.*` (`detach`/`patrol`/`orderDet`/`garrison`/`engage`/`merge`/`armyTotal`), `BV.enterMap`.
  *(Cross-reload save/load of detachments is a follow-up — they live for the session; region advance
  re-seats them via `reseatDetachments`.)*
- **Diplomacy:** `playerPacts` (Set of NATION defs), `isAllyFaction`, the `enc-ally` button.
- **Call to arms:** `raiseCall` / `updateActiveCall` / `clearCall`; allied bands steer to `activeCall`.
- **Reinforcements:** `assembleAllies` → `buildAllyReinforcement` (borrowed allies, excluded from the
  persistent roster in `applyBattleGrowth`); `coopMult` is the coordination buff applied in `spawnAlly`.
- **Co-op netcode:** server `server/ws.js` (dependency-free WebSocket relay on `/coop`, rooms +
  beacons), client `net-battle.js` (`window.coop`), and the `coop*` functions in `game.js`
  (host beacon + `coopHostTick` snapshot broadcast; guest discovery `J` + `enterCoopGuest` /
  `updateCoopGuest` puppet render). All co-op paths are gated on `coopOnline()` / shared world, so
  offline play is untouched.

> Previewing: the sandboxed dev server can't read the project dir — files are served from
> `/tmp/blade-vale`, so `cp game.js index.html net-battle.js client-net.js /tmp/blade-vale/` (and
> `sim/world-sim.js` → `/tmp/blade-vale/sim/`) after every edit, and bump `game.js?v=N` in
> `index.html` to bust the cache. Co-op needs the backend (`npm run server`, :8787) for its `/coop`
> WebSocket relay; offline play needs no server.
