---
name: object-editor
description: >-
  Render ONE procedural object from the game in an isolated preview stage and
  iterate on it by editing the real generator code. Use when the user says
  "show me a house / city / castle / knight", "load <X> in the editor / object
  editor", "build a city on a mountain and only that", or asks to change a model
  that is currently shown ("make the roofs taller", "thicker walls", "add a
  moat", "bigger keep"). The object is built by the game's actual generators, so
  edits land in both the editor AND the live game.
---

# Object Editor

An isolated 3D stage that shows a SINGLE procedural object (a house, a whole
city, a castle, a soldier, …) built by the game's **real** generators, with an
orbit camera and live-edit hooks. The user iterates on the model in plain
language; you translate each change into an edit of the responsible generator
function. Because the editor calls the same `buildHumanoid` / `buildSettlementGroup`
/ `sgHouse` / … the live game uses, every change you make shows up in the game too.

There is no separate "model file" to edit — **the model IS the generation
algorithm.** "Make the roofs pointier" = edit `sgRoof`. "Bigger cities" = edit
`SG_SPEC.city`. That is the whole point.

## Mental model: two modes

1. **VIEW** — open `index.html?edit=<kind>` (served from `/tmp/blade-vale`).
   game.js suppresses the normal world boot, hides everything else, builds just
   that object on a clean stage, and frames an auto-spinning orbit camera. Hand
   the user the URL and a screenshot.
2. **EDIT** — when the user asks for a change, find the generator function
   responsible (table below), edit it in `game.js`, re-sync, reload, screenshot.

## Workflow (every request)

1. **Map the noun → kind** (see table). One word ("house", "city", "knight")
   usually maps directly.
2. **Sync + serve.** Copy edited files to `/tmp/blade-vale` (the preview server
   is sandboxed out of the project dir — see the `serve-from-tmp-workaround`
   memory) and start/refresh the `blade-vale` preview (`preview_start`).
   ```bash
   cp index.html game.js client-net.js net-battle.js /tmp/blade-vale/
   cp sim/world-sim.js /tmp/blade-vale/sim/
   ```
3. **Open** `http://localhost:<port>/index.html?edit=<kind>` and screenshot.
   **Always give the user the URL** (the `always-provide-test-url` memory).
4. **On a change request:** grep for the responsible function, edit it, **bump
   `game.js?v=N`** in `index.html` (cache-bust), re-sync, reload, screenshot.
5. Repeat. Keep the same seed across iterations so you compare like-for-like.

## URL params

`?edit=<kind>` plus, optionally:
- `&seed=<n>` — deterministic variant (default 3)
- `&tier=village|town|city|capital` — settlement size
- `&weapon=sword|bow` — for humanoids
- `&at=<x>,<z>` — world position a settlement is seated at (it sits on the REAL
  `mapElevY` terrain there — use a peak's coords for "city on a mountain")
- `&spin=0` — stop the turntable (good for a clean screenshot)
- `&big=1` — a larger house

## Live hooks (drive without reloading, via `preview_eval`)

`window.BV` exposes:
- `BV.edit('city')` or `BV.edit({kind:'settlement',tier:'capital',seed:9})` — rebuild
- `BV.editSeed(42)` — re-roll the same kind at a new seed
- `BV.editSpin(false)` — toggle the turntable
- `BV.editFrameCam()` — re-frame the camera on the object
- `BV.editStatus()` — `{kind, tier, seed, weapon, spin, size:[w,h,d]}`

Use these to flip variants fast; use the URL when handing something to the user.

## Noun → kind → generator (where to edit)

| User says | `?edit=` | Built by | Edit these for changes |
|---|---|---|---|
| house, hut, cottage | `house` | `sgHouse` | `sgHouse` (size/roof/plinth), `sgRoof`, `settlePalette` (colors) |
| villa, manor | `house&big=1` | `sgHouse({big})` | same |
| village | `village` | `sgBuildVillage` → `sgHouse` | `sgBuildVillage` (layout), `SG_SPEC.village` |
| town | `town` | `sgBuildHold` + 1 castle + palisade | `sgFillHouses`, `sgBuildCastleAt`, `sgBuildCurtain`, `SG_SPEC.town` |
| city | `city` | `sgBuildHold` (4–5 castles + stone wall) | `sgCityWall`, `sgBuildCastleAt`, `sgFillHouses`, `SG_SPEC.city` |
| capital | `capital` | `buildSettlementGroup('capital')` | `SG_SPEC.capital`, `sgCityWall`, `sgBuildKeep` |
| castle, keep | `castle` (a town) | `sgBuildCastleAt` | `sgBuildCastleAt`, `sgCurtainMarch`, `sgBuildKeep`, `sgPrism` (towers) |
| knight, soldier, warrior | `knight` | `buildHumanoid(..,'sword')` | `buildHumanoid`, `makeSword` |
| archer | `archer` | `buildHumanoid(..,'bow')` | `buildHumanoid`, `makeBow` |
| banner | `banner` | `makeBanner` | `makeBanner` |

Settlement structure overview lives in the `terrain-aware-settlements` memory;
terrain in `hex-overworld-terrain`. The geometry primitives the settlement
builders use are `sgBox` / `sgRoof` / `sgPrism` / `sgCone8` (transform a shared
Three primitive into a vertex-colored buffer).

## Building blocks reference

- **Editor stage lives in `game.js`** in the block headed `OBJECT EDITOR` (near
  the bottom, before the boot tail). `EDIT` = state; `editBuild(spec)` routes a
  spec to the right generator; `editGround` lays the ground (displaced `mapElevY`
  terrain for settlements, a flat disc otherwise); `editorBoot` hides the world &
  frames the camera; `loop()` early-returns to `editFrame` when `EDIT.on`.
- **"City on a mountain"**: a settlement is seated on the real terrain at its
  `at=x,z`. Origin (`0,0`) lands on a mountain for some seeds (e.g. seed 7). To
  force a peak, scan with `BV.findHill(160, 12)` (returns KNOLL/RIDGE coords) and
  pass the best as `&at=`. For a *guaranteed huge* mountain you'd sculpt terrain —
  that means editing `mapElevY` / `elevationAt` (the terrain generator), which is
  itself a valid "edit the algorithm" request.

## Adding a NEW kind the game can't build yet

If the user asks for something with no generator (e.g. "a windmill"):
1. Write a new builder function in `game.js` near the other `make*`/`sg*`
   builders that returns a `THREE.Group` (reuse `mat`, `boxMesh`, `sphereMesh`,
   `sgBox`, etc.).
2. Add a keyword to `EDIT_KINDS` and a branch in `editBuild`, OR (quick test) use
   the built-in raw escape hatch from `preview_eval`:
   `BV.edit({kind:'raw', build: () => myWindmill()})` — pass `seated:true, at:[x,z]`
   too if it should sit on real terrain.
3. Decide whether the new object also belongs in the live game (drop it into a
   chunk / settlement) or stays editor-only.

## Gotchas

- **Always re-sync to `/tmp/blade-vale` and bump `game.js?v=N`** after an edit, or
  the browser runs the stale copy.
- `node --check game.js` before syncing — a syntax error blanks the whole game.
- Fog is disabled in editor mode (a city is ~100u wide and the game fog ends at
  95u). Don't re-enable it for the editor stage.
- Don't self-verify only headlessly — screenshot and hand the user a URL.
