# tools/chared — the char editor

**This is where Blade Vale's fighter is judged and where his gear is built.** Every change to the character —
his body, his wear, a new armour piece — is looked at here first, in the pane, before it goes near the game.

```bash
python3 tools/chared/serve.py          # then open http://localhost:8120/tools/chared/index.html
```

It loads the game's own rig, `assets/rigs/base`, exactly as the game ships it — there is no second copy of the
character to drift. (`?rig=<path>` points it at a build you are testing before it ships.) The one file it keeps of
its own is `items/atlas_raw.jpg`, the atlas as it was PAINTED: the shipped `atlas.jpg` has its skin normalised for
the game's tints (`headbake.py`) and the game paints the tone back on, which the editor has no look system to do.

| panel | what |
| --- | --- |
| SHOW | every mesh in the file, its triangle count, on/off |
| ITEMS | what he WEARS, by the game's rules: the leather wrist bands always (there are no bare wrists), a steel arm either side, a leather pauldron either side, the helm. A steel arm takes that side's band and pauldron off; the helm takes the hair — the same table the game reads from `rig.json.wear` |
| SHADING | textured / clay (judge the form, no paint) / normals / vertex class / silhouette; wireframe, smooth normals, double-sided (finds flipped faces), skeleton, grid + ruler |
| ISOLATE | one body class at a time (the head, a forearm, the torso…) |
| POSE | the bind pose, arms down, a T — and sliders for the arms and legs, to see a piece where it will crease |
| the readout | height, heads tall, shoulder span, chest/waist/hips girth, limb lengths, and the ratios against a real man's |

Hooks in the console: `__view(az, el, dist, cy, cx)` sets the lens, `__save(name)` writes a screenshot to
`shots/`, `__exportArmor()` bakes the finished plates (below), `?twist=<deg>` nudges a tile's angle.

## Armour pieces: the generator, and the LEATHER style

`armorPart(model, mesh, axis, opts)` turns a fitted plate (an open shell over a rim) into a finished piece:
a bevelled **border** round its silhouette (the 2-D convex hull of its vertices in the plate's own plane — the
plate is several overlapping lames sharing no edges, so there is no boundary loop to follow), a **floor** that
closes the underside off the skin, and a **tile** repeated at world scale instead of one patch stretched into a
blur. The ribs are laid along the plate's own lames, measured from its triangle edges at double angle.

```js
STYLES.leather   // border out 1.5 cm / up 0.8 / down 2 / tucked 1, tile 10 × 4 cm, roughness 0.62, metalness 0.25
```

**`leather` is the style the shoulder plate was signed off in (2026-09-20), and every leather piece is built the
same way** — call `armorPart(…, { style: 'leather' })` and change nothing. An `iron` style is to be ADDED beside
it in `STYLES`, never by editing `leather`.

## From the editor into the game

The editor shows the pieces live; the game gets them baked, so what you judged is what ships.

```bash
node tools/realmesh/base/dress.js <built base>            # plates in RAW → the editor fits and finishes them live
#   open the editor, look at them, then in the console:
#   await __exportArmor()                                 # → items/pauldron_baked.json + items/leather_tile.png
node tools/realmesh/base/dress.js <built base> --baked    # → assets/rigs/base, the finished plates on the `leather` material
python3 tools/realmesh/base/headbake.py assets/rigs/base/ # pieces.json + the game's atlas.jpg
#   then bump game.js?v= in index.html
```

`<built base>` is what `basebuild.js` writes — see `tools/realmesh/base/README.md`. `items/pauldron.json` holds the
raw plates (cut out of the old warrior kit once, `dress.js extract`); `items/pauldron_baked.json` is what the
editor made of them.

## House rules

- Nothing here ships: `tools/` never enters `dist/` (`tools/build-site.js` asserts it).
- A new ware is a mesh in `assets/rigs/base` + an entry in `rig.json.wear` (its kind, its slot, what it covers,
  what it takes off) + an item in `arena-items.js` whose id IS the mesh name. game.js needs no new code.
- Judge the form in **clay** before the paint: texture hides a bad silhouette.
- If geometry looks missing, check the material's `side` before rebuilding anything — a one-sided shell seen from
  inside reads exactly like a hole. That mistake cost three rebuilds of a floor that was there all along.
