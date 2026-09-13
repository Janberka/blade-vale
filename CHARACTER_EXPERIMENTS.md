# Character look experiments — 2026-09-12 (parked)

The soldier in the game is the one described in `CHARACTERS.md`: the procedural, flat-shaded Vale knight built by
`buildHumanoid`. This file records a day of experiments toward a more realistic soldier, why each was stopped, and how
to switch each one back on. Nothing here is on by default.

## The brief

The user brought three Sketchfab models by illustros (Tripo AI generations, Sketchfab Standard licence): a full-plate
sallet knight, a red-crested centurion, a blue/gold Byzantine warrior — and wanted our soldiers to look like them.
Constraints that shaped everything: the arena runs up to 200 a side on phones; the fighters' mechanics (reach, hit
heights, shield strap, weapon swap, the tuned animator) live on the procedural rig's pivots; the brand signatures
(crescent, lit visor, brass, sigil, big left pauldron) must survive.

## What the models are

Single static shells: no skeleton, no animation, 370–500k triangles, one baked 4K texture each. Decimated copies at
12k / ~4–9k triangles with 1K textures are in `assets/rigs/<knight|centurion|hoplite>/` (about 2 MB per figure).

## Attempt 1 — procedural restyle after the references ("sallet / legion / hoplite" looks)

New helms, lames, pteruges, cheek guards etc. built from primitives on the existing rig.
**Verdict:** rejected on sight ("not even close… lego men… you make everything from spheres and boxes").
Removed from the code.

## Attempt 2 — the scans themselves, skinned (`?real`)

`real-skin.js` + `loadRealRig`/`wearRealRig` in `game.js`: the decimated scan becomes a `SkinnedMesh` whose bones ARE
the rig's pivot groups (two bones per vertex from joint segments; the cape bound to the hinged cape chain so `afCape`
swings it; a `tint` vertex flag dyes cape/crest in the team colour; the knight's own sword lifted out with a cut box).
The first version moved the rig's pivots onto the scan's anatomy.
**Verdict:** looked right, played worse — proportions changed every reach and swing, the shield was gone, joints
candy-wrapped. "Old figures are mechanically much better."
**Still available:** `?real` on the arena URL (teams cycle knight / centurion / hoplite). `BV.realRig.load(name)`,
`BV.realRig.wear(h, name, {team, lo, realSword})`.

## Attempt 3 — keep the rig, upgrade the surface

### 3a. Materials pass (`?pbr`)
`mat()` gained a physically based path (`pbrMat`: steel / brass / cloth / skin / leather `MeshStandardMaterial` with
canvas-generated wear textures from `charTextures()`), a prefiltered sky the steel reflects (`makeEnvMap` /
`setEnvMap`, rebuilt per arena hour in `afApplyTime`, restored on `afLeaveToMenu`), and neutral steel
(`plateCol` lerps 0.84 to silver under PBR). Rounder geometry was tried and reverted: the facets are the original look.
**Verdict:** materials alone still read as toy shapes. Kept, off by default: `?pbr` or `localStorage bv-pbr=1`.

### 3b. Armour pieces cut from the scan (`opts.armor`)
`tools/realmesh/pieces.js` cuts the scan by per-slot boxes into rigid plates hung on the pivots (`loadArmorSet`,
`assets/armor/plate/`, a `legion` set drafted from the centurion). Luminance-smoothed cloth removal, welded-component
flake filtering, seam-locked decimation and joint anchoring were all added to fight the scraps.
**Verdict:** "a ripped apart paper statue" — a single-shell scan cannot be cut into clean plates. Opt-in only:
`buildHumanoid(..., { armor: 'plate' })` after `BV.armorSets.load('plate')`.

### 3c. Whole scan warped onto the rig (the one that worked visually)
`RealSkin.fitToRig`: every vertex rides its bone segment; the scan's joints are mapped onto the plastic rig's joints
(`RIG_FIT` in `game.js`, per-bone radial fattening, cape narrowed and its pooled hem cut). `wearRealRig` no longer
moves a pivot, so reach, hit heights, shield strap, weapon swap and animations are exactly the old rig's; the surface
is the scan. Renders (bust / front / back / three-quarter) looked like one solid knight in the pit — standing still (see the bug below).
**Status when parked:** not the default; the rig's own sword is used; the plume and lit visor are hidden on it; cape hem
jagged; figure a little dark; centurion and hoplite go through the same code but were not reviewed.
**To try again:** `BV.realRig.load('knight').then(() => BV.showcase({ team: 0, real: 'knight', armor: false }))` in an
arena fight, then `BV.shot(1280, 800, { pos, look, fov })` for a still (the follow camera overrides `arenaShot`).

### The bug that coloured every verdict
Until the very end, `realMaterial()` created its `MeshPhongMaterial` without `skinning: true`. In three r128 a
`SkinnedMesh` with such a material renders frozen in its bind pose — the sword, shield and crescent moved with the
rig, the body did not. So the first skinned version "played worse" and the fitted one "did not walk" for the same
reason, and no judgement about deformation quality was ever made on a moving body. Fixed (`skinning: true`) just before
the experiment was stopped; the first frames after the fix showed the body deforming, with the cape and skirt scraps
flying — not reviewed further. The user decided to bring a better model instead of continuing with these scans.

## Tooling and hooks that stay

- `BV.showcase(o)` stands one fighter in front of the camera; `BV.showcase(null)` clears. `BV.shot(w, h, pose)` renders
  a still with a fixed camera and no sim step.
- `tools/realmesh/` — decimation, joint drafting, luminance sampling, the cutter, standalone viewers, the rig specs.
- `real-skin.js` is loaded by `index.html` before `game.js`; it is inert unless one of the flags above is used.

## If this is picked up again

Start from 3c. The open questions are: the lit visor and plume on the sallet, a real sword and shield face, team
colour beyond the cape dye, a lighter 3–4k mesh for the legion tier, and whether the overworld player and the
marketplace preview should wear it too.
