# tools/realmesh/base — the base fighter built from the Thor sculpt (2026-09-17)

The game's figure (`assets/rigs/base/`, `MODEL_NAME = 'base'` in game.js) is built by this pipeline from the user's
`Thor_UNWORTHY_THOR.usdz` (a rigged, painted Fortnite-style sculpt: 319 joints, a torso + right arm + hands body mesh,
a head, eyeballs, hair cards, three equipment meshes, a hammer). Only the naked man is kept; the OLD palette warrior's
kit (`assets/rigs/warrior/`: armour, cloak, shield, sword, the Corinthian helm) is carried over onto him, so every look,
piece, paint and ware in game.js keeps working unchanged (`pieces.json`'s armour entry is the warrior's, vertex for vertex).

Run from a scratch folder holding `thor/` (the unzipped usdz), `thor-gltf/` and `view/models/warrior` (a copy of
`assets/rigs/warrior`), then copy `view/models/base/*` into `assets/rigs/base/` and bump `game.js?v=` in index.html:

| step | what |
| --- | --- |
| `swiftc -O usd2gltf.swift && ./usd2gltf Thor.usdz thor-gltf thor/0` | USD → glTF with skins, one material per mesh (ModelIO; the bind pose in the IBMs, the rest pose in the node matrices — Z-up, equal to the bind here) |
| `python3 analyze_thor.py` | which bones carry weight per mesh, the bone tree with bind positions |
| `python3 atlas.py` | one 2048² atlas: body colour (0,0), head (1024,0), eyes (0,1024) 256², a plain skin patch (256,1024) tinted to the body's mean → `atlas_raw.jpg` |
| `node basebuild.js` | the base body: reduced skeleton (60 bones: pelvis, spine ×5, neck, head, clav/arm/fore/hand + fingers ×2, thigh/shin/foot/toe ×2 — every other Thor bone folds into its nearest kept ancestor; the upper arms and thighs had NO bind transform in the file, their positions come from the rest pose), the right forearm lofted from the upper arm's cut to the wrist, the hips closed and lofted, the RIGHT side mirrored past x = 0.33 and zipped to the left torso (the left arm was a metal prosthetic), legs and feet as tubes on the bones, head + eyeballs merged, winding repaired (`fixOrientation` — the file had inside-out patches under its bracers), meshopt to 8k tris → `scene.gltf`, `parts.json`, `rig.json` |
| `node retarget.js` | the warrior kit onto the base: per body segment (torso, head, arm/fore/hand, thigh/shin/foot ×2) every kit vertex keeps its place along and around the bone; its radius is pushed out by the base's girth in that (band, sector) bin minus the kit's inner layer (+ MARGIN, default 6 mm); the head is rigid (eyes on the eyes, scaled by the heads' width ratio); the sword and shield move by translation to the new hand / forearm bone and scale ×1.123 (hips 1.092 / 0.972); the Corinthian helm gets the same head carry |
| `python3 headbake.py` | `pieces.json` body entry: head / hair (dark paint on the crown) / beard (the jaw by position) / brow / socket / eye + the body parts (torso, armL/R, foreL/R, handL/R, thighL/R, shinL/R, footL/R), `sculpted: true`; and the game's `atlas.jpg`: skin scaled so its bright (92nd pct) colour is the palette's skin cell #ffdcb4 (lookApply divides the tone by it; a sculpted body's tint is lifted ×1.16 for the darker mean), the painted hair flattened to skin so the look's hair colour paints it |
| `viewer.html` | the pane viewer (serve the scratch `view/` folder: three r128, `?m=base,warrior`, `?hide=…`, `?cls=1` colours the body by class, `?nn=1` no normal maps; `__view(az, el, dist, cy, cx)`, `__save(name)`) |

What the game does with it (game.js): `loadModelRig` reads one texture per material and the rig's own head measures
(`rig.json` skull / hairline / face override LOOK_SKULL / LOOK_HAIRLINE / LOOK_FACE), skips the head sculpting passes for a
`sculpted` body, `modelBodyBuild` is off for a `fullBody` rig (the base IS the body under the armour), and `lookDraw` hides
each body part under the kit piece that covers it (`LOOK_UNDER`: torso under the cuirass, upper arms under sleeves, forearms
under vambraces, thighs under the skirt, shins under greaves, feet in boots) so a stride never pushes skin through cloth;
a naked look (pelt, berserker) drops cuirass and sleeves and the chest and arms show — inked, if he bought ink.

Open: the kit's fit is a first pass (MARGIN, the girth percentile 0.9 and the sector count in retarget.js are the knobs);
Thor's own equipment (cape, bracers, belts, pants, boots, the hammer) and his hair cards are not used yet — candidates
for marketplace wares; the tube forearms and legs are plain skin (the patch), not painted muscle; no normal map is used
(the surface pass's triplanar skin detail stands in).
