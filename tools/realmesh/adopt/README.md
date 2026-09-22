# tools/realmesh/adopt — adopting a model (2026-09-21)

**How somebody else's rigged character becomes a Blade Vale fighter** — a *size* in the char editor (`normal`, `huge`, …)
and, once it is signed off there, a body in the game. First done for `Gladiator 2.usdz` (*Gladiator* by huyunited,
Sketchfab, CC-BY-4.0): the `normal` size, beside the Thor-built base, which is `huge`.

## The idea: one standard, congruent bodies

The standard is the base rig, `assets/rigs/base`: its 60 bone names, its hierarchy and — the point — **its bone frames**.
Everything the game owns is written in those frames: a clip in `assets/motions` is LOCAL quaternions on the base's bones,
the fist is a set of finger locals, the hilt's seat is a point and two axes in the hand's frame, the helm hangs by an
offset in the hand's, a ware is skinned to bones by name.

So a new body is not retargeted *to*. It is made **congruent**: bone for bone, its limb lies in its bone's frame exactly
as the base's limb lies in the base's.

```
bind(b) = A(b) · bindBase(b)     A(b): the turn that carries the base's limb, as it lies in the base's bind pose, onto
                                 this model's limb as it lies in ITS bind pose — from an ANATOMICAL frame read the same
                                 way off both rigs (joint → next joint, plus the hinge: the elbow's axis from the arm's
                                 own bend, the knee's from where the foot points, a finger's from its own curl, the
                                 palm's from the knuckle line)
rest(b) = restBase(b)            written in the file's NODES, and rig.json says `"rest": "nodes"`: posed like that he
                                 stands in the base's stance, limb for limb — the zero every pose is laid on
trunk, neck, head, collar bones: A = 1   (where a rig puts its spine joints is a convention, not anatomy)
feet: about the vertical only            (both stand flat; lining up ankle → toe pitches a foot by the ankles' heights)
```

Then **one clip, one fist, one grip, one wardrobe serve every body**, with no per-body bake of any of them. The only thing
a clip needs on another body is its hips' road re-laid for his legs (scaled by the legs' ratio, then every grounded frame
put back ON the floor from his own soles; a flight is kept) — the editor does it when it loads a clip (`fitClip`), the
game the first time a rig plays it (`motionFit`).

## The steps

```bash
# 0. LOOK AT IT FIRST — the model as it came: meshes, joints, the pose it was bound in, weights per joint
swiftc -O tools/realmesh/base/usd2gltf.swift -o /tmp/usd2gltf          # (.usdz; a .gltf/.glb needs no conversion)
unzip -o model.usdz -d /tmp/m && /tmp/usd2gltf model.usdz tools/chared/sources/<id> /tmp/m/0
python3 tools/chared/serve.py                                          # → http://localhost:8120/tools/chared/source.html?src=sources/<id>

# 1. THE PROFILE — tools/realmesh/adopt/profiles/<id>.json: which of their joints are which of ours, which meshes are the
#    body / the eyes / his own wear, triangle budgets, the credit line. Everything else is found.
# 2. THE BODY  → tools/chared/build/<id>.body
node tools/realmesh/adopt/adopt.js tools/realmesh/adopt/profiles/<id>.json
# 3. THE WARDROBE → tools/chared/rigs/<id>   (shoulder plates RAW)
node tools/realmesh/adopt/wardrobe.js tools/realmesh/adopt/profiles/<id>.json
#    open the editor on him (sizes.json), look at the plates, then in the console:  await __exportArmor()
node tools/realmesh/adopt/wardrobe.js tools/realmesh/adopt/profiles/<id>.json --baked
# 4. JUDGE HIM IN THE CHAR EDITOR — every clip, the combos, every item, clay first. Add him to tools/chared/sizes.json.
# 5. (the game, when he is signed off)  … --baked --ship  → assets/rigs/<id>; see "In the game" below
```

`tools/chared/sources/` (converted source models: big, somebody else's files) and `tools/chared/build/` (the intermediate)
are git-ignored; the profile and the finished rig in `tools/chared/rigs/<id>` are committed. Nothing under `tools/` ships.

## What `adopt.js` takes from the source, and what it makes

Taken: the **mesh**, the **weights**, and **where the joints are**. Not taken: its bone frames, names, clips.

| found / made | how |
| --- | --- |
| the middle | the MESH's own (median mid-span of trunk and head slices), not the skeleton's — this rig sat 1 cm off its skin, and a man built about his joints' middle wears every mirrored ware a centimetre to one side |
| a bad joint | L/R pairs are averaged in the mirror; a pair more than 4 cm apart is settled by the SKIN — the joint nearer its own weight seam (the vertices it shares with its parent) wins, the other becomes its mirror. The gladiator's shield elbow stood 20 cm in front of his arm |
| the trunk | their 3 spine joints → our 5: ours are laid along THEIR line pelvis → neck at the fractions the base has, and the trunk's weights are re-laid by height with a smooth blend at every joint (limb ↔ trunk blending stays as painted) |
| **fingers** (`hands.js`) | his hands came rigid (sword hand) and as a mitten (shield hand). The hand is what lies beyond the wrist plane; geodesic distance from the wrist ring over the welded skin has five local maxima = the fingertips; the thumb is the one apart, the rest are ordered along their arc; the shortest skin path between neighbouring tips dips through the WEB; ring centroids by distance from the tip are the finger's medial axis; joints by anatomy (knuckle→tip = 1.27 × the free finger, last joint 26 %, middle 54.5 %, the knuckle INSIDE the palm on the first phalanx' line; thumb 51 % / 111 %); weights by projection on the axis, blended across each joint. Closed with the base's own fist they grip a hilt. **A finger's hinge is read ACROSS THE PALM** (`frames()`, the finger's line × the palm's normal), not off its own bend: a hand modelled relaxed bends each finger only 15–30°, and a little sideways drift tipped the gladiator's hinges 7–22° off, so the fist crossed his fingers and left the little one sticking out (2026-09-22) |
| badly painted side | profile `mirrorWeights: { from: "R", bones: ["fore","hand"] }` — each vertex takes the weights of the vertex nearest its mirror image **that faces the same way** (an arm hangs a finger's width off the flank: without the normal test a flank vertex took arm weights and became a sail when the arm lifted) |
| body classes | by dominant bone: torso, arm/fore/hand, thigh/shin/foot per side, head, eye (+ `hips`: the pelvis' skin below the waist — what trousers cover besides the legs). `pieces.json` `sculpted: true`. Hair / beard / brow / socket are NOT cut yet (see below) |
| fewer triangles | meshoptimizer per region (hands, head, eyes, the rest) with locked borders. **0.18's wasm heap does not survive a big call** — the next call on the same buffer comes back untouched with error 0 — so every call gets a fresh instance |
| his own wear | the meshes the profile lists (`loin`, `sandals`): re-weighted the same way, decimated, `always` on |

## What `wardrobe.js` does

A ware is never re-modelled for a new body. It is **carried** from the base's bind pose into this body's by the bones it
already hangs on — every bone has a map *base space → this body's space* in its anatomical frame, and a vertex goes where
its own skin weights send it, `p' = Σ w(b) · map_b(p)`:

* a **limb** (upper arm, forearm, thigh, shin) and the **trunk** are cylinders: a vertex keeps its place ALONG the bone
  (as a fraction) and its bearing ROUND it, and radially keeps its offset from the skin, shrunk with the limb —
  `r' = skin_his(t,θ) + (r − skin_base(t,θ)) · min(1, skin_his/skin_base)`, never less than 4 mm off his raw skin. Both
  skins are read by rays from the bone's axis and smoothed, so a strap still stands proud and a bolt is still a bolt.
  The trunk's cylinder runs CROTCH → pelvis joint → neck (rigs put the pelvis joint at different heights; the body says
  how far down the trunk goes). The base's trousers are his legs, so for them the base's "skin" is their own smoothed outside.
* a **hand, finger, foot, collar bone**: the box of that body part in the bone's frame onto the box of his.
* **rigid** things keep their shape: the **sword** goes to HIS fist — the handle line through the four finger loops, read
  the same way off both rigs' closed fists — and is scaled with the MAN (a plain sword is 53 % of a man's height), and
  `rig.json.grip.sword` (`seat`, `at`, `axis`, `flat`, `reach`, `size`) is said again for his hand; the **shield** keeps
  its place along the forearm and its distance off the skin; the **helm** and the **hair cards** go about the EYES,
  scaled with the skull measured ABOVE the ears; a **shoulder plate** goes whole to the shoulder (middle by the upper
  arm's map, sized with the deltoid), and the editor seats, borders, floors and tiles it on his skin — the base's own loop.
  The right plate is kept and mirrored for the left (the sculpt is not vertex-symmetric; two fits came out 425 / 557 tris).
* what the base already ships (hair sheet, kit palette, leather tile, helm maps) is REFERENCED (`../base/…`), not copied;
  the wares' paint is the lower half of the base's atlas (`wear.jpg`).
* `rig.json`: `wear` (his own + the carried wares — on a man with wrists and legs of his own the bands and the trousers
  are wares, not `always`; trousers `covers` hips + legs and `hides` his own legwear), `grip`, `skull` / `face` /
  `hairline` / `plumeY` / `helmHand` / `roundX` carried by the same head and hand maps, `hipY` = the hip JOINTS' height.

GOTCHA that cost an hour: a LEFT limb's anatomical frame is its right twin seen in the mirror, so its first axis runs from
the joint back UP the limb. Congruence does not care (both rigs are read the same way); walking along a bone does —
the left leg's skin was being read above the hip, and the left trouser leg ballooned (`ALONG`).

## In the game (2026-09-21, game.js v=313)

`node tools/realmesh/adopt/wardrobe.js <profile> --baked --ship` writes `assets/rigs/<id>` (no debug files) and runs
`skinbake.py` on it. What the game does with an adopted rig, and what a NEW one needs:

| what | where |
| --- | --- |
| which body a man wears | `MODEL_BY_SIZE = { normal: 'glad', huge: 'base' }`, `modelSizeOf(name, gear, npc)`, `modelNameFor(size)`. The build is part of the LOOK — `gear.look.z` (`ARENA_LOOK.z` in arena-items.js, so server, worker and guests validate it); a player without a pick is normal, an NPC rolls huge from his name (`AF_HUGE_ODDS`). A third body = a new entry there + a bigger `ARENA_LOOK.z` + a name in `LOOK_BUILD_NAMES` (the barber's BUILD row). Every body in the table loads at the start (`BV.modelLoadAll`); only the default is waited for |
| rest pose | `rig.json.rest === "nodes"` → `instanceModelRig` keeps the nodes (the base's stance) instead of writing the bind pose into them |
| the head's and the hand's measures | `lookRigUse(R)` points the look tables (`LOOK_SKULL/FACE/HAIRLINE`, `MODEL_HELM_HAND`, `LOOK_HAIR_TEX`) at the rig of the man being dressed — they were globals the last rig loaded overwrote |
| a clip on his legs | `rig.json.clipFit = { pelvis, k }` (where the BASE's pelvis rests, his legs over the base's) → `motionFit` re-lays the hips' road per clip and rig (the editor's `fitClip`), and a stride's pace follows the legs (`clipK`) |
| the sheathed sword | `rig.json.hip` (x, y, z of the hang at his hip; wardrobe.js, by the pelvis' half-width) over `MODEL_HIP` |
| skin tones | the game lays a TONE on as a vertex tint, tone × paint, and expects the paint's bright skin AT the palette's skin cell `#ffdcb4`. `skinbake.py` normalises the SKIN texels only (the body mesh's own triangles in uv space; what he wears on the same sheet keeps its paint). The painted sheet is kept for the editor in `tools/chared/items/atlas_raw.<id>.jpg` |
| brow / socket classes | carried from the base's head by the head map (wardrobe.js) so the brow tint and the eye sockets work |
| credit | the start page's credit line (index.html, twice) + `assets/rigs/CREDITS.md` |

Still open on the gladiator: he is BALD — no `hair` / `beard` class, so the barber's hair colour does nothing on him (a crop
painted into his sheet + `rig.json.hairTex`, which `lookRigUse` already honours, or hair cards carried like the helm); both
bodies stand ~2.9 game units (the game scales a rig by hip height, and his legs are as long as the base's), the difference
is BULK — 41 cm against 58 cm across the shoulders. If `normal` should also stand shorter, that is one factor on `S` in
`wearModelRig`. Body size is cosmetic: the sim's capsules and reach are the same for both.
