# tools/chared — the char editor

**This is where Blade Vale's fighter is judged and where his gear is built.** Every change to the character —
his body, his wear, a new armour piece — is looked at here first, in the pane, before it goes near the game.

```bash
python3 tools/chared/serve.py          # then open http://localhost:8120/tools/chared/index.html
```

**CHAR SIZE** (top of the panel): `normal` · `huge`. One skeleton, several bodies — `huge` is the base built from the Thor
sculpt, `normal` is *Gladiator* by huyunited (CC-BY-4.0), **adopted** onto the base's bones and bone frames by
`tools/realmesh/adopt/` (read its README: it is the recipe for every model still to come). Because the bodies are
congruent, the clips, the combos, the fist, the grip and every ware are the SAME files for all of them; a switch keeps the
clip, the items, the shading and the lens. The list is `sizes.json` beside this page (`{ id, name, rig, default }`); an
adopted rig lives in `tools/chared/rigs/<id>` until it is signed off and shipped. `source.html?src=sources/<id>` is the
inspector for a model AS IT CAME IN — meshes, joints by name, bind against rest pose, weights per joint.

It loads the game's own rig, `assets/rigs/base`, exactly as the game ships it — there is no second copy of the
character to drift. (`?rig=<path>` points it at a build you are testing before it ships.) The one file it keeps of
its own is `items/atlas_raw.jpg`, the atlas as it was PAINTED: the shipped `atlas.jpg` has its skin normalised for
the game's tints (`headbake.py`) and the game paints the tone back on, which the editor has no look system to do.

| panel | what |
| --- | --- |
| MOTION | the clips in `motions/` played on him: pick one, pause, step a frame, scrub, slow it down. A clip owns the skeleton while it is picked, and the POSE sliders become an OFFSET over it: the arms' turns into the **ARM CARRIAGE** knob, −10…+10 (below), the legs' is zeroed; "none" hands him back to the sliders |
| SHOW | every mesh in the file, its triangle count, on/off |
| CHAR SIZE | which body: `normal` (the adopted gladiator) or `huge` (the base). Two poses live in a file — BIND, where the skin was bound (every geometry job works there), and REST, the zero a pose is laid on: an adopted body is bound where IT stood and RESTS in the base's stance (`rig.json` `rest: "nodes"`). The fingers rest closed round a hilt on every body, as in the game (`?openhand=1` for the base's open bind) |
| ITEMS | built from the rig's own `rig.json.wear` table — what is always on, what a slot carries, what a piece `covers` and `hides`. What he WEARS, by the game's rules: the leather wrist bands always (there are no bare wrists), a steel arm either side, a leather pauldron either side, the helm. A steel arm takes that side's band and pauldron off; the helm takes the hair — the same table the game reads from `rig.json.wear` |
| SHADING | textured / clay (judge the form, no paint) / normals / vertex class / silhouette; wireframe, smooth normals, double-sided (finds flipped faces), skeleton, grid + ruler |
| ISOLATE | one body class at a time (the head, a forearm, the torso…) |
| POSE | the bind pose, arms down, a T — and sliders for the arms and legs, to see a piece where it will crease |
| the readout | height, heads tall, shoulder span, chest/waist/hips girth, limb lengths, and the ratios against a real man's |

Hooks in the console: `__view(az, el, dist, cy, cx)` sets the lens, `__motion(id, frame)` picks a clip and holds it on a
frame (no frame = playing; `?motion=<id>` does it from the URL), `__save(name)` writes a screenshot to `shots/`, `__exportArmor()` bakes the finished plates (below), `?twist=<deg>` nudges a tile's angle.

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

## Motions: somebody else's clip on our man

A motion is ONE json in `motions/` (a local quaternion per moving bone per frame at 60 fps + the pelvis' place), listed in
`motions/index.json`. They are made by retargeting — added ONE AT A TIME and judged here before the next:

```bash
node tools/realmesh/base/gltfanim.js <scene.gltf | model.glb> /tmp/anim.json   # glTF: EVERY clip, by name (run it without the out file to list them)
#   …or, from a .usdz (which can only ever hold ONE clip):
swiftc -O tools/realmesh/base/usdanim.swift -o /tmp/usdanim
/tmp/usdanim <model.usdz> /tmp/anim.json                                  # the skeleton, its clip, the hip's travel
node tools/realmesh/base/motion.js /tmp/anim.json <id> "<Name>" --credit "<author, licence>"   # → motions/<id>.json
```

`motion.js` works in world space, bone by bone (its header has the rule): their turn away from THEIR rest pose laid on
OUR bone, after our rest pose (Thor's A, soft knees) is brought to theirs (a T) — limbs by the shortest arc carried down
the chain, feet about the vertical only, the collar bones by their LIFT only, the trunk not at all (his posture stays his).
**His hands stay HIS: thumbs to the front, palm to the body** — the clip gives the hand its direction, and it is then rolled
about the forearm until it sits as his own model carries it (half the roll in the forearm bone, half at the wrist);
`--theirhands` keeps the clip's roll, for a cut or a parry where the turn of the wrist is the move. The hip's travel is scaled by hip
height, and the clip is then lifted frame by frame so his lowest sole point is ON the ground (`--air` for a jump or a
fall, `--noloop` for a clip that must not be closed). A new SOURCE skeleton is a new entry in its `PROFILES` (which of
their joints drives which of our bones).

**The arm carriage.** A clip made on a slighter man carries the arms too close for this build, so over a clip the arm
slider is a knob across the only turns that make sense on him (the user's call, 2026-09-20, on the angry walk): **−10 =
−33° over the clip = his arms 45° open, +10 = −8° = as close as they go**; past −6° the arms are in his lats; −12…−8°
looks best, so the knob rests at **+8 (−10.5°)**. `CARRY` in `index.html`; the knob is remembered per browser so the next
clip is first seen with the same carriage. It is a live offset (`poseOver`, in the clavicle's frame) — when clips go into
the game this is the turn to bake into them.

**A BLOW IS BAKED BY ITS BLADE (`--blade`, 2026-09-21).** The user, on the cut down: "the sword is not pointing front at the peak
of the attack". At the top of that cut his forearm reached straight ahead and the blade stood 77° off it, pointing at the sky —
and measured against the performer, EVERY blow was out: the blade 34–60° from his on average, the thrust landing aimed at the
ground, the spin tilted 33° down. A hand retargeted bone for bone does not put a blade where the performer's was: his sword
leaves his fist its own way, ours leaves ours another (48° apart at the reference pose — the eye had found 51° of it and called
it the zero's tilt), and the walk's rules (thumbs to the front, the zero turn) hold the wrist in a CARRY all through a cut.
So for a blow the sword hand is SOLVED, not retargeted: the performer's own sword is a rigid prop under his hand
(`gltfanim.js` writes every such prop — its long axis, width and flat in its bone's frame — as `props`), its frame in the world
is known every frame, and our hand is turned until OUR blade (`rig.json grip.sword` axis + flat) lies in it. A double-edged
blade rolled half a turn is the same blade, so of the two hands that do it the one nearer the plain retarget is taken, once;
half the twist this asks of the wrist goes into the forearm bone. The other hand keeps the walk's rule. motion.js prints where
the blade points at each mark and how far the wrist is asked off its rest (45–98° in the cut down: read it, then LOOK at the
wrist). All eight attack clips and the six game blows (`assets/motions/g_*`) are baked this way; the walks are NOT — a walk's
carriage is the user's own, set by eye (below). `flow.js --check` still agrees with the table: the same blows meet.
And the blade leaves EVERY body's fist the same way: `wardrobe.js` puts the hilt in an adopted body's own finger loops but
keeps the base's axis and flat in the hand's frame, or a clip baked for the base's blade would land 7.8° wide on him.

| clip | how it is baked (`motion.js <glad_gltf.json> <id> "<Name>" --profile cc_gltf --credit "…"` +) |
| --- | --- |
| `angry_walk`, `walk_backward`, `walk_back_cycle` | `--clip 0` · `--clip 2` · `--clip 2 --cut 205:261` |
| `walk_forward`, `walk_cycle` | `--clip 1 --overR 22,-54,0` · `--clip 1 --cut 13:109 --overR 22,-54,0` (the user's hand state for this carriage: the blade upright behind the shield) |
| `atk_jump` … `atk_stab` | `--clip 3 --air --blade` · `--clip 4…10 --blade` (+ `--marks` for the log) |
| `g_slashdown` · `g_slashup` · `g_stab` | `--clip 7 --keep 2:136 --marks top=52,land=60` · `--clip 8 --keep 4:146 --marks top=59,land=74` · `--clip 10 --keep 36:164 --marks top=79,land=92`, all `--fps 30 --blade` |
| `g_spin` · `g_swipe` · `g_jump` | `--clip 9 --keep 0:134 --marks top=41,land=51 --inplace` · `--clip 6 --keep 4:130 --marks top=50,land=73` · `--clip 3 --keep 44:150 --marks takeoff=49,apex=60,top=72,land=82 --inplace`, all `--fps 30 --blade` (then move `tools/chared/motions/g_*.json` to `assets/motions/` and take them back out of the editor's index) |

**What the eye adds, clip by clip (`--overR x,y,z` / `--overL`).** The hand sliders read 0 at whatever turn a clip was baked with
and lay theirs ON TOP of it; `--overR` bakes exactly those numbers, as they are read under the sliders, and the sliders are
back at 0 for that clip (checked: old hand · slider turn = baked hand to 0.014°, and only `handR`'s track changes).
`--handR` REPLACES the zero; `--overR` is laid over it — and over a `--blade` solve too. (The sliders' lines are read off the
BIND pose, as motion.js reads them: off the rest pose, where the fist is closed, they sat a hair elsewhere.)

**The sword hand's zero.** Every clip is baked with the fist turned as it HOLDS A SWORD — **right −30 bend, +51 tilt, +40
roll** (`HAND_ZERO` in `motion.js`, the user's own numbers, 2026-09-20). So a fighter carries his blade the same way in
every motion, and the editor's hand sliders start from it at **0**. A clip where that hand is empty or doing something of
its own (an open palm, a fist to the face) is baked with `--handR 0,0,0`.

**A hand's own turn.** POSE → *hand*: pick right / left / both (or click the hand in the view) and turn it on its own three
lines — **x bend** about the knuckle line (palm ↔ back of the hand), **y tilt** about the palm's normal (thumb ↔ little
finger: the way a sword is pointed), **z roll** about wrist→knuckles. It rides on top of the clip (or the pose), the left
hand is the right's mirror, the numbers under the sliders are remembered per browser — and they are what gets baked, turn
for turn (checked: 0.00° between the sliders and the bake, fingertips included): `motion.js … --handR x,y,z --handL x,y,z`
(or `--hands`). Settle a carriage on the sliders, read the numbers off, bake them, and the sliders go back to 0.

**The sword in his fist.** The rig's sword is bound to `handR` but still stands where the OLD warrior's hand held it —
upright, 10 cm off the wrist. `node tools/realmesh/base/grip.js` seats it from the geometry: the fist is read off a clip
that closes it (each finger makes a loop — knuckle, two joints, fingertip — whose centre is a point on the handle's line),
the sword's own axis, guard and flat come from its mesh, and the grip is laid through the fist: blade out of the thumb
side, guard 1 cm clear of the index finger, an edge leading the way the knuckles point. It writes
`items/sword_grip.json` (a bind-space matrix) and the editor lays it on at load (`?rawsword=1` shows the rig's own).
(GOTCHA: `BufferAttribute.applyMatrix4` does not flag the attribute — with the pane in view a frame is drawn while the
seat's fetch is out, the raw sword is on the GPU by then, and without `needsUpdate` it stayed across the wrist while every
number read off the bones said it was in the fist. A render that disagrees with the bone data: suspect a stale buffer.)
Knobs for the eye: `--tilt` (blade toward the knuckles), `--turn` (about the handle), `--push` (along it), `--gap`.
NOT YET IN THE GAME: baking it into `assets/rigs/base` also moves the sheathed sword at the hip (`modelPropGeo` reads the
same mesh), so `MODEL_HIP` has to take the inverse — a step of its own, after the grip is signed off here.

`--profile` says whose skeleton it is: `cc_sketchfab` (the usdz: anonymised joints, hip outside the skeleton), `cc_gltf`
(the same Character Creator man from Sketchfab's glTF — real names, numbered: `CC_Base_L_Thigh_04`; a joint is found by its
stem), `mixamo` (`mixamorig:*`; proved on a T-pose clip: he stands in a clean T). `--clip N` picks the clip. A clip that
CARRIES him (WalkForward02 crosses the floor and snaps back) is baked with its `travel` and `speed`; the MOTION panel
then shows **in place**, which takes the travel back out evenly — the speed is what the game will need to keep his feet
from skating.

**The source has 11 clips** (Sketchfab's own count): `01_Angry Walk` ✓, `WalkForward02`, `WalkBackward02`, `Atk_Jump`,
`Atk_Kick`, `Atk_ShieldCharge`, `Atk_ShieldSwipe02`, `Atk_SlashDown`, `Atk_SlashUp`, `Atk_Spin`, `Atk_Stab`. The `.usdz`
we were given holds only the first; the rest need the model's **glTF** download (Download 3D Model → glTF, a Sketchfab
login), dropped next to it.

| clip | source clip | what it is |
| --- | --- | --- |
| `angry_walk` | 01_Angry Walk | 0.93 s loop, treads on the spot |
| `walk_forward` | WalkForward02 | 5.0 s loop, a crouched advance behind the shield in BURSTS — 250 cm |
| `walk_backward` | WalkBackward02 | 5.0 s loop, a guard retreat, shield leading — 226 cm back |
| `atk_jump` | Atk_Jump | 3.25 s once, `--air`: crouch, 0.38 s off the ground, the cut buried on the landing — 195 cm |
| `atk_kick` | Atk_Kick | 2.43 s loop, a front kick off the shield side — 135 cm |
| `atk_shieldcharge` | Atk_ShieldCharge | 2.08 s loop, shoulder behind the shield, hips down to 61 cm — 167 cm at 80 cm/s |
| `atk_shieldswipe` | Atk_ShieldSwipe02 | 2.38 s once, the shield thrown wide and up, on the spot |
| `atk_slashdown` | Atk_SlashDown | 2.28 s loop, overhead raise and chop, on the spot |
| `atk_slashup` | Atk_SlashUp | 2.55 s once, a rising cut from low to overhead, on the spot |
| `atk_spin` | Atk_Spin | 2.27 s loop, a full turn with the blade out — 216 cm at 95 cm/s |
| `atk_stab` | Atk_Stab | 4.2 s loop, thrusts, on the spot |

All eleven are **"Gladiator 1+motions" by Kapi777 (Sketchfab), CC-BY-4.0** — credit him wherever they ship.
Each opens and closes in the same guard, so they blend into one another.

GOTCHAS, all met on the first clip: a `.usdz` binds ONE animation — Sketchfab's conversion of an "N motions" model
carries only the first (the glTF download has them all, by name); its joints come out anonymised (`n36`…), each under a
`*_scaleCompensation` joint; the HIP is left OUTSIDE the skeleton as an animated Xform, so no joint carries the bob, the
sway or the yaw — `usdanim.swift` samples the skeleton prim's own world matrix per key for that (`clip.world`); keys are
not evenly spaced and the loop is padded past its closing key (`motion.js` resamples by time and stops where the first
pose comes round). "The neck became too big" was the SHOULDERS: a T holds the collar bones 8° up and a walk drops them
11–25° from there; his A already has them down, so unaligned their drop landed on top of his, the shoulders sank 4–9 cm
and the traps were dragged into one slope from skull to shoulder (how the nod is split between neck and head made no
visible difference — tried, dropped). Check `armL/armR` in the chest's frame against the bind pose before blaming a neck.
"The hand made a twist" was their carriage — elbows out, knuckles forward — and it comes down the whole ARM: with
the hand riding the forearm untouched its thumb line still swung 90° through the cycle, so taking the wrist's turn out
is not enough; hence the rule above. **THE BASE'S FINGER CHAINS ARE MIS-NAMED**: from the thumb across the palm they are
called pinky, ring, index, middle (the skin's vertices say so, and "ring" is the longest, "middle" the shortest). The rig
keeps its names (`motion.js` maps by what a finger IS, `PHYS`, and refuses to run if the geometry stops agreeing) — aiming
the hand down the chain called "middle" aimed it down the LITTLE finger's knuckle, a wrist skewed ~20° in every frame.
The pane does not run `requestAnimationFrame` while it is hidden: a clip that "does not play" in a
test is a hidden pane — hold frames with `__motion(id, f)`.

**...and into the game** — `node tools/realmesh/base/grip.js --bake` writes three things into `assets/rigs/base`, none of
which touches the bind pose (skinning is unchanged), then bump `game.js?v=`:

1. the **sword's vertices take the seat** — `mSword` in game.js is this very mesh, so it lands in his fist;
2. the **fingers' node matrices take the fist** the clip closes. game.js already prefers a hand bone's node matrix over
   its bind ("the model was saved gripping") — the base was saved with an OPEN hand, so the game drew splayed fingers
   round a hilt. Writing the fist there closes it with no game code at all;
3. **`rig.json.grip`** carries the seat and the hand's turn: `modelPropGeo` UNDOES the seat for a prop taken off the hand
   (the sheathed blade at the hip, the shop's — they are placed in the old bind orientation and must not move, checked:
   0.0009 mm), and `syncModelRigs` lays the turn on the sword hand, on top of whatever pose asks of it (a bow takes it off).

**How big a sword is on him** — `node tools/realmesh/base/swordsize.js` (no arguments: the sizes as they stand). The steel
was sized for the old plastic rig: a plain built blade stood 74 % of this man's height with a flat as wide as his forearm,
and the rig's own iron sword 60 % ("all the swords are too big for our char"). Two numbers in `rig.json.grip.sword`, both
set so a plain sword is ~53 % of his height — an arming sword on a man:

* `own` (0.88) — the rig's OWN sword, scaled **in the file** (`--own <k>`) about the point where its guard meets the handle
  line, so the guard stays a finger clear of his index and the hip copy hangs where it did. The editor, `dress.js` and the
  game all read the rig as it stands, so nothing else changes;
* `size` (0.71) — a **built** loadout sword (`afBuildSword`, game units): `wearModelRig` scales the sword group on his hand
  and re-lands its guard, `afBuildSword` keeps the scale through every gear pass (`userData.modelK`), and the home page's
  planted sword takes it too. Nothing is baked — `--size <k>` only writes the number. Trails and sparks are sampled in the
  group's own frame and follow. The sim's reach is a number and does not move; **VR keeps the old size** on the controller,
  because there the blade itself is the reach (`vrFitHands`).

**Into the game.** A clip the game should play is copied to `assets/motions/` (with an `index.json`) — `assets` is already
a tree in `tools/build-site.js`, so it deploys. game.js loads one on demand (`motionClip`), and `motionPose` lays it over
the pose the plastic rig drives, by a weight that eases in and out. Two rules keep it honest:

* **the whole man while he walks, and not a moment longer**. Legs alone were faithful to the frame — 1° off the clip — and
  still read as somebody else's walk, because a walk is the lean of the back and the swing of the arms as much as the feet;
  under a torso the game held in a fixed guard, the right legs looked wrong. So a walking man belongs to the clip, all 52
  bones. The moment he blocks, swings, charges, rolls, is thrown or mounts, `motionWanted` lets go and the game's own poses
  have him back — those are the ones tied to what actually lands;
* **on the game's own cadence**: `b.phase` is the walk cycle the sim already keeps for its procedural legs — faster as he
  speeds up, backwards when he gives ground, all of it long since tuned against the ground he covers. One procedural cycle
  (2π) is one of the clip's, and both are two steps, so they line up and there is no stride speed to guess at. (A clip's
  own `speed` is measured and written down, but it is only worth trusting where the clip travels: read off the planted foot
  it came out 3× apart on clips that are really a bladed shuffle.)

**Which clip is the walk matters more than the retarget.** The first one in was `walk_cycle`, cut from WalkForward02 — and
it is a bladed crouch, right for a man turned side-on behind his shield and wrong under a torso the game points straight
ahead (the user: "guard legs but body top isn't turned like that anim, so it doesn't make any sense"). The ordinary
`angry_walk` is the one whose legs belong under an upright man. Judge a clip by the body it was performed with, not just
by whether it retargets cleanly.

**A walk is not a run.** `angry_walk` covers ground at 1.42 m/s (motion.js measures it off the flat, backward-sliding feet —
checked against travelling clips: 53 vs a true 53 cm/s); a fighter here jogs at 3.5 units/s and sprints at 5.9. The walk is
played at the pace he really covers (rate = his speed ÷ the clip's) up to 1.9×, and past that the game's own run has him —
riding the sim's run cadence instead put the walk at 2.5× ("we are running weirdly"). **The pack has no run and no idle;
until it does, sprinting and standing are the game's.**

**The blows are SCRUBBED, not played.** The sim's blow is `wind` + `strike` + `rec` (~0.5 s, after a hold that loads it); the
pack's are 2–4 s performances. Each game clip (`assets/motions/g_*.json`, 30 fps, sliced with `--keep A:B`) carries `marks`
— `top` of the wind-up and `land` of the cut, read off the blade tip's speed — and `motionBlow` lays the sim's clock on them:
the hold draws guard → top, `strike` runs top → land so the cut ARRIVES when the sim says it hits, `rec` runs on and the
ease back to guard covers the tail. WHICH clip is the flow's (below): the sim names it by where the blade is (`afFlowPick` →
`a.clip`); by count — slashR `g_slashup`, slashL `g_stab`, chop `g_slashdown`, heavy `g_spin` — only until the table is in.
Shield bash `g_swipe`. What lands, when and on whom stays the sim's.

**Giving ground is a guard** (the user: "walking backwards can be slow and you go guard mode, otherwise you could just turn
and run"). A man with a shield who steps back from the way he faces (`b.backing`: move·facing < −0.5 in, −0.3 out; not with a
bow, in the saddle or mid-blow) has his guard up FOR REAL (`b.blocking` — blows from the front ring on the shield as if he
held BLOCK), moves at `AF_F.backpedal` (0.18 of his pace: ~1 unit/s against a 3.5 jog) and plays `walk_back_cycle`, the
stride cut from WalkBackward02 — here its bladed crouch is the point. The pace was set FROM the clip: at 0.18 it plays at
~1.25× its own speed, so the feet hold the ground. (Measure speed against wall-clock with the pane visible — `arenaStep`
adds to the live loop, it does not replace it, and a stepped measurement reads 2× high.)

**The jump attack** (`g_jump`, from Atk_Jump; in the game: attack inside the first 0.4 s of a leap → `b.airAtk`). The sim owns
the flight, so the clip is baked `--inplace` (the hips' SLOW travel along the floor low-passed out — evenly removing it, as
the editor's "in place" does, slides a scrubbed clip back through its wind-up and forward through its flight) and without
`--air`, so its own flight is pinned out and the sim's arc is the only one. Marks `takeoff / apex / top / land`; `motionLeap`
runs take-off → the blade's top while he flies to where the blow falls, top → the cut in the time left before his feet
touch (the blade comes down WITH him), then on through the hard landing. The frame only ever moves forward: a man under
him can call the blow early, and the blade must not jump back up.

**THE FLOW OF THE BLADE — combos, judged in the editor first** (the user: "bring momentum to our attacks… if I attack when
my sword is near my left foot after a swing and tap again, the system should pick the correct attack animation instead of
random, so we won't look like our char is jumping from one anim to another real fast" — then: "show me how the combos will
work in the editor screen, not the game… don't add long long… also add moves, jump, guard to combos"). A chain that picks
its next clip by COUNT (1st rising cut, 2nd thrust, 3rd cut down) drags the blade from wherever the last cut left it to
wherever the next wind-up wants it, in 0.06 s. The flow picks by WHERE THE BLADE IS:

| the blade is… | because he has just… | a tap is | held (heavy) |
|---|---|---|---|
| in his guard, standing | — | CUT DOWN (right-top → left-bottom) | SPIN |
| in his guard, moving in | — | THRUST | SPIN |
| cocked behind the raised shield | raised his guard / is backing off under it | THRUST (past the shield's edge) | SPIN |
| low by his left foot | cut down | RISING CUT (left-bottom → overhead) | the rising cut, loaded |
| overhead, behind | cut up — or let the cut down's moulinet run | CUT DOWN | the cut down, loaded |
| out ahead, right shoulder forward | thrust | RISING CUT | the rising cut, loaded |
| low at his right hip | spun | THRUST | — (a heavy never chains into a heavy) |
| low ahead, crouched | landed a jump attack | RISING CUT | loaded |
| forward on the right | swiped the shield (the bash) | RISING CUT | loaded |

So `tap tap tap` = cut down → rising cut → cut down (the finisher); `tap tap LONG` = down → up → the BIG cut down;
`tap LONG tap` = down → coiled low-left, the big rising cut → down; `LONG tap tap` = spin → thrust → rising cut;
`move-in tap tap tap` = thrust → rising cut → cut down; `JUMP tap tap` = the jump attack → rising cut out of the landing
crouch → cut down; `guard tap tap` = thrust from behind the shield → rising cut; `bash tap tap` = shield swipe → rising
cut → cut down. There is no `LONG LONG`: the second heavy starts from his guard, after the first has recovered.
The pairs were found, not invented: `node tools/realmesh/base/flow.js` prints, for every frame of every blow's
follow-through, the pose distance (hand + ½ tip + the chest's and hips' turn + the feet) to every frame of every wind-up —
cut-down f30 ≈ rising-cut f23 (0.84) and rising-cut f37 ≈ cut-down f17 (0.84): the performer made them as a pair; the spin
ends in the thrust's coil; the guard-retreat stance IS the spin's early wind-up (0.62). What a TAP can reach in its 0.06 s
decides the openers: from the guard the thrust costs 0.65 against 3.6 for the cut down — the cut down is kept as the
STANDING opener anyway, because its raise reads as a quick overhead and it puts the user's own example (down, then up from
the left foot) on the first two clicks. The table is **`assets/motions/flow.json`** — written BY HAND from those numbers
(`--check` fails when a range's clip is no longer the nearest): `after.<blow>` = `[frames past its landing, what follows,
the frame of THAT clip to take it up at]`; past the last range he is back in his guard and `open.<stance>` applies.

Three things make it read as one motion, all in the editor's **COMBO** panel (and `__combo('t,L,t', {flow, late}, t)` —
pieces `t` tap · `L` LONG · `J` jump + a tap in the air · `G` guard · `B` bash · `F` moves in · `K` backs off; "your own"
builds any sequence): the **entry** frame (the next clip is taken up where its pose is nearest, not from its frame 0); the
**pre-wind** (the click came DURING the blow, so the moment the strike is over the next clip's wind-up begins — there is no
walk back to the guard in between; the chain still fires when the sim says, ¾ through the follow-through); and the
**crossfade** (every change of clip starts from the pose he is in, 0.12 s, never a cut). "late taps" shows why it is a table
of RANGES: click after the cut has landed and the blade has already swung up the left side, so the cut down follows itself
as a moulinet. "flow" off is the game as it is today — watch the blade trail: the straight strokes in it are the jumps.
The panel scrubs the clips on the SIM's clock with the sim's numbers (`CBF` = game.js `AF_F`: wind 0.06 + 0.08 k, strike
0.10 → 0.12, rec 0.28 → 0.50, chain at ¾, the third light a finisher with twice the follow-through, a press held past
0.51 s a heavy; the bash 0.10 / 0.10 / 0.26; the leap v 6.6, g 18, the blow at 0.5 up on the way down, a hard landing of
0.35 s). The standing GUARD is a planted frame of the guard-retreat cycle (`moves.guardFrame`), so guard, retreat and the
blows out of them are one stance. What the editor cannot show is the game's own procedural poses (a plain leap, the roll,
the run): those stay the game's.

**In the game (game.js v=308).** The SIM names the blow: `afFlowPick` when a load begins (`b.charge.clip/entry/n`), carried onto
`b.atk`; `b.flow = { k, past, age }` keeps count of where the blade is (frames past the landing while the follow-through runs,
then how long his hands have been free; struck, floored, locked or rolling ends it); a click that came during a blow is
named the moment its strike is over (`a.next`) so the figure's wind-up can begin there. Rules that came with it: a button
STILL HELD at the chain point starts a LOAD from there ("tap LONG" — it used to queue a light and throw the hold away); a
heavy never chains into a heavy (held through a heavy's follow-through, the press counts when his hands are free, from his
guard); the load changes to the heavy's clip where it BECOMES a heavy (0.51 s), not where the plastic arm coils (0.35 s); a
blow thrown within 0.25 s of the guard coming down still opens from behind the shield (you cannot swing while BLOCK is
held); a tap during a jump attack's hard landing is KEPT and comes out the tick he can move. The flash a blow leaves
follows the clip (`AF_ARC`: a thrust leaves a dart). The FIGURE: `motionBlow` scrubs ONE blow (numbered `n`) through its
pre-wind, load and swing from the `entry`; `motionPose` starts every new clip — and every new blow on the same clip — from
the pose the figure last SHOWED (`L.shown`, captured after the bones are set), at full weight; a blow that is over runs ON
while it fades (0.3 s; cut short when he is struck). And the hips come home: `b.position` is set from `inst.restPos` every
frame — it used to be lerped from wherever it stood, so after any clip the pelvis stayed where the clip left it (half a
pace ahead of the man after a thrust). `BV.arenaFlow(i)` = the blow the sim has named and where it thinks the blade is;
`BV.arenaBody(i)` = the man (still his brain with `ctrl = 'none'`); `BV.motion()` now carries the frame, the crossfade and
the hips. NOT in yet: the standing guard is still the game's own block pose (the editor holds the retreat stance), and on a
GUEST the other fighters' ground blows are still the plastic rig's (no `b.atk` there — it would key off states 2/3/4 and a
clip slot in the snapshot row).

`BV.motion()` says which clip each figure is on and how strongly. A long take is no good for this — cut a cycle out of it
first (`--cycle` finds one, `--cut A:B` takes it, and the last frames are eased into the first so the loop does not pop).

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
