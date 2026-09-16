# Blade Vale — the character look

The rules that make a Blade Vale fighter recognisable at a glance, whatever team colour they
wear and whatever gear they bought. They live in one place, `buildHumanoid` in `game.js`, so every
fighter — the player, the arena's NPCs, the thousand-man hosts of the vale — carries them.

## The five signatures

1. **The Vale crescent.** A brass crescent-blade fin rises from the crown of every helm — a domed,
   faceted helm with a brow ridge and a Y visor (`cachedGeo('knightHelm')`) — swept a little back. It is the silhouette: the "blade" in the name, readable across the pit and in a
   crowd of a hundred. (`cachedGeo('valeCrest')`, one extruded crescent, shared by every rig.)
2. **The lit visor.** The great helm's T-slit glows in the wearer's colour — team cloth in the
   arena. The bloom pass catches it; at night in the pit a line of fighters is a line of coloured
   eyes.
3. **Brass everywhere.** One trim colour, `VALE_BRASS` (0xc9a24a), on every fighter regardless
   of faction: the crescent, a band at the brow of the helm, a rim under each pauldron, the belt
   buckle, the hem of the faulds. Team colour is for cloth only (tabard, cape, plume, the jack).
   Steel stays steel. This is what makes a crimson knight and an azure knight look like the same
   game.
4. **The Vale mark.** The sigil: a V for the vale with a sword rising through it (`valeSigil()`,
   a canvas texture drawn once). It sits on the chest of the tabard, on the hem of the cape and on
   the face of every shield.
5. **One big shoulder.** The left pauldron — the shield side — is oversized (×1.22); the sword
   arm's is trim so the swing reads. Asymmetry is the cheapest way to make a silhouette yours.

Hero rigs (players, and NPCs in fights under 24 bodies) also carry a back scabbard, the tabard,
the cape and the plume; the plain rig used at legion scale keeps 1–3 and 5, so the brand holds
at 400 bodies.

## What gear may and may not change

The marketplace (`ARENA.md`, `arena-items.js`) dresses the *body*: armor recolours the breastplate
and pauldrons and adds its own pieces (straps, rivets, mail sleeves, tassets, gold rims, spikes),
swords, bows and horses are built per item. None of it touches the five signatures: the crescent
stays brass, the visor stays lit, the mark stays on the tabard and shield, the left shoulder stays
big. A unique may recolour the plume or the blade; it never removes the crescent.

## Proportions — the knight

The reference is the faceted low-poly knight: a big domed helm with a brow ridge and a Y visor,
square pauldrons, a barrel chest over a belted faulds skirt, thick forearms and big fists, short
thick legs on a wide stance. ~5.5 heads tall ("hero chunk"): `hipY` 1.52, the upper body at
1.68, torso ×1.38 wide, forearm radius 0.15, fists 0.16, and the head sits inside the helm.
Total height stays ~3.3 so the hit heights (1.8 / 2.1 / 2.6 × scale) and every animation still
land; the cavalry seat moved with it (`rider.group.position.y` 1.22).

Flat-shaded low poly, so plates read as angular facets — that IS the look; do not smooth it and do
not cel-shade it. No faces: the helm is the identity.

## Adding a new fighter type

Build it through `buildHumanoid` (or `buildCavalry`, which seats the same rig). Do not hand-roll
another figure — it will not carry the signatures, and it will not take gear.

## Experiments

A day of work toward a realistic soldier (scanned figures skinned or warped onto this rig, a physically based
materials pass, cut armour plates) is written up in `CHARACTER_EXPERIMENTS.md`. All of it is off by default; the
knight above is still the game's fighter.

## Hands (2026-09-12)
The warrior's finger bones are unmapped, and an unmapped bone keeps the BIND pose — where the fingers lie open, so a
fist round a hilt showed splayed fingers. `instanceModelRig` now gives every bone under a hand (`swordHand`, `bowHand`
in rig.json) the file's own stance, a closed grip. Keep it that way for any new rig: save the model gripping.


## Looks (2026-09-14) — no two fighters alike
The warrior's armour is one sculpted mesh, so every man used to be the same plate knight. `tools/realmesh/warrior_pieces.py`
bakes `assets/rigs/warrior/pieces.json`: the PIECE every armour triangle belongs to (helmet, pauldron, sleeve, elbow,
vambrace, cuirass, skirt, straps, knee, greaves, pouch), what the palette makes each vertex of (steel, cloth, leather,
dark, skin) and the hair/beard regions of the bald head that sits under the helmet. In game.js `lookRoll(name, arch,
gear, pal)` rolls a LOOK from the fighter's name (host and guests roll the same man), his class and the armour he wears
— which pieces he has on, what each is painted (`LOOK_ARMOR`, odds per class in `LOOK_CLASS`), skin, hair, beard,
cloak, and his shield: the figure's heater, a low-poly round shield (`lookRoundShield`, skinned to the same bone, painted
plain/halves/quarters/rays) or none (brutes and duelists). `lookApply` paints it as vertex colours over the palette and
drops the missing pieces from the body's own index; the blue cloth is re-pointed at a white palette cell at load so the
team dye takes. The shop's mannequin (`parts.lookFull`) shows every piece. Test hooks: `BV.look.live()`,
`BV.showcase({name, arch, gear:{armor}})`. Re-run the bake after any change to the warrior model.
Faces (same day, "put some alpha male look on the faces"): `lookRuggedHead` roughens the shared head once at load —
wider jaw, chin and brow forward and the brow lowered, cheekbones out, the eye meshes narrowed to a squint — and the
roll gives dark cropped hair or a shaved head, a full beard on most, heavy dark brows (`brow`), shadowed eye sockets
(`socket`), weathered skin, dimmed eye whites, no painted lips, and a scar across one cheek on a third (`scarL`/`scarR`).

## The wardrobe is the marketplace (2026-09-14, "any item we add should be available in the marketplace")
Six slots now: sword, armor, helm, shield, bow, horse (`ARENA_SLOTS` in arena-items.js; the server validates against the
same list). No armour = a linen shirt in the team dye and wool breeches; the market sells a padded gambeson, a wolf pelt
(bare-chested, fur pauldrons, fur cloak, fur boots — the barbarian, with a round shield and the beard the name rolls),
leather, mail, brigandine, plate and up. A helm is a ware (`sallet`) — without one you fight bareheaded; a bought plume
forces one on. Shields are wares too: the round shield is lent to everyone (`AF_GEAR_LENT`), the heater is bought; whether
a man carries one at all is still his class (`AF_ARCH.shield`). NPCs roll all of it in `afNpcGear` (helm odds from
`lookOdds`). Plate is heavy now: plate −22 % speed, champion's −25 %, dragon −30 %, mail −6 % (arena-items `move`).
Adding a ware: an entry in ARENA_ITEMS (slot, price, rank, stats), a `LOOK_ARMOR` row if it is armour (paint per piece,
`bare: true` for skin), the plastic fallback in `AF_LOOK.armor`, and a thumbnail branch in `afThumb` if the slot is new.

## The barber (2026-09-14, "we should be able to edit the hair style, hair color, beard style, skin color")
The "✂ Look" chip in the home's gear row opens THE BARBER, a page of the shell like the market (`page-barber`,
`afBarberOpen` / `afBarberRender`; the user: "the barber cannot be a modal on the home page, it should be a separate
page"): the figure on the left, rows on the right — skin tone (6), face (hard, square, long, round, hawk, broken), hair style
(shaved, short crop, crown, long, mohawk), hair colour (9), beard style (clean, stubble, full beard, goatee, moustache), and
"Let the barber choose" (`afLookClear`, the server clears the look on `{clear: true}`). Every tap repaints the figure and
saves: `gear.look = { s, f, h, c, b }` (indexes; ranges in `ARENA_LOOK`, validated by `cleanLook` in arena-items.js)
travels with the loadout, so guests and profile pages paint the same face; the server keeps it in the career's meta
(`POST /api/v1/arena/look`, both server/arena.js and worker/index.js) and this browser keeps a copy (`bv-look`). Beard
styles are regions of the baked beard class cut by position in `lookFaceColour` (the chin for a goatee, the upper lip for
a moustache). The vale's men roll their own.

### The hair is geometry, the face is bones (2026-09-16, "these hairs look stupid, they always be drawn to the forehead. Add different faces too")
Hair painted on the head's vertices smeared every cut down the forehead: the head is a few big triangles, so a painted
vertex at the hairline bled its colour to the brow. Now a cut is a CAP of real geometry (`lookHairGeo`, once per style per
rig, shared by every figure): rays from the skull's centre find the surface at each bearing and height, the hairline is a
curve by bearing (`LOOK_HAIRLINE` — high at the brow, down past the temple, over the ear, to the nape), the cap is pushed
out by a pad with a lip down to the skin; long hair adds a drape down the neck to a hem over the collar, the mohawk is a
fin along the midline (tallest over the front of the crown). The cap is a `SkinnedMesh` bound to the body's skeleton on
the head bone (`lookHairApply`, like the round shield on its arm), in the hair colour, flat-shaded, hidden under a helm.
The scalp is still painted under it, but only 3 cm inside the hairline (`lookHairUnder`) — never at the edge. FACES:
`LOOK_FACE_SHAPES` are displacements of the head's vertices in the bind pose (`lookFacePoint`: jaw, chin, cheeks, nose,
brow; all below the hairline, so one cap fits every face), applied on this body's own copy of the positions and normals
(`lookFaceApply`; shape 0 'hard' shares the rig's). Rolled from the name on its own stream, so nobody's hair or kit changed.

## The bare man's waist (2026-09-16, "why my char has a naked ass and a box on it")
A bare look (the pelt, the berserker's mantle) drops the cuirass, and two things went with it. THE BOX: the two belt pouches on the
back of the belt (`pouch` in pieces.json, painted leather) only read tucked under a back plate — on a bare back they were a black
block; a naked look now hides them too (`lookRoll`, odds 0 on those rows). THE NAKED ASS: the plate's own skirt overlaps the sash,
so a torso lathed to the plate's width stood out THROUGH the sash — bare skin below the waist, the cloth's top edge lost inside it —
and the waist belt is the cuirass' leather, gone with the plate. `modelBodyBuild` now holds every ring at hip height inside the skirt's
cloth (`inSash`: the cloth's centre and 93 % of its width) and lathes a BELT of its own — a leather band a finger thick, class `belt`,
mat `leather` on the white palette cell so `look.leather` paints it — over the sash's ragged back edge, so the sash hangs from the belt.
The sculpted belt is not split out and shown instead: it lies on the plate's surface, where the body cuts through it.
Same day, "he looks like he is wearing a sweater which is skin color … make the arms and upper body thinner": the body has ITS OWN
TONE, `look.body` — the man's skin unweathered and a shade paler (the chest that never sees the sun), the face's weather returning at
the collar (a tan line), painted per vertex by `lookBodyColour` with the muscle read as shade: the midline dark from the sternum to
the belly and down the spine (20 segments a ring now, so a vertex sits on the midline, set in a little for a real groove), a crease
under the pecs, the belly shaded into the sash. And it is slimmer than the plate: 0.90 × the cuirass's width and 0.87 × its depth
with an 8 % waist (the padding under armour, the plate's own stand-off) and shoulders broadening ×1.34 toward the collar, the arms 0.66 of the sleeve's girth — and an arm is an
ELLIPSE, 0.84 across by 1.04 front-to-back ("from front and back the arms look still a bit wide"): the narrow way round is what
the front and the back see, the side keeps the biceps' depth.
THE CHEST ("add some chest muscle detail"): the torso is lathed on 22 rings now (the plate's 12 bands interpolated, `bandAt`), and
`chestShape` moves each ring's vertices by their place round it — the pecs a plate of muscle either side of the sternum (the two
vertices next to the midline out 7.5 %, the next 3 %), fullest at three quarters of the torso's height (just under the collar bone; "too low" at two thirds) and fading toward the crease
and the collar bone, the sternum sinking between them, a crease under them (the front set in 4 %) that the paint darkens too.
THE SHOULDER ("arms are too close to body, the top of the arm joins the body with a weird angle"): the shoulder bone sits INSIDE
the torso (x 0.176 against a torso edge near 0.19) and the upper arm runs 35° outward to the elbow, so a tube from the bone came
out of the body at an angle and lay against it. The tube starts from the deltoid instead — 5.5 cm out past the torso's edge and
1.2 cm up, in the bone's own frame so it holds in every pose — and runs to the elbow, where the bracer is: more upright, clear of
the body. Test hook: `BV.showcasePose('relax')` puts the showcase figure in one of the animator's poses.
THE V ("now we have a gap between body and arms and head — slightly more v shaped and the chest bigger"): the torso broadens
to half again the plate's width at the shoulder line (`prof`: ×1.5 from 45 % of the height up to 85 %, held to the top), the
chest is deepened 12 % where the pecs are and the pec vertices go out 10 % (the next pair 5 %), and the ring that closes toward
the neck stays at 62 % of the top band's width (was 50 %) so the traps fill the gap under the jaw.
THE NECK ("still a bit gap between body and the neck, maybe put the head lower"): the head mesh's own neck is 4 cm of thin stalk
(r 0.04) before the jaw, and a body closed flat under it showed that stalk as a gap. The head bone stays where it is (the helm rides
it, and every armoured man's collar); instead the traps slope up to a thick neck of the body's own — a ring at 4.2 cm above the
head mesh's base (r 0.082 × 0.076) and a top ring inside the jaw's width at 7.5 cm (r 0.072 × 0.068, weighted 40 % chest / 60 %
head bone so it turns with the head) — so the head sits down on the shoulders.

## The ink is the barber's (2026-09-16, "the ink in market does literally nothing visually … move it to customize instead, it can be free")
Two faults. The ink WAS drawn, but at `inkTile` 1.4 the mask tiled every 71 cm: a whole torso got one band of rings hidden under the
pauldrons and one rune, and on the LOW tier the plain material has no kind branch at all, so a phone never saw it. Now the mask tiles
every 29 cm (3.5) with a second band (a chain of lozenges), and the low tier's Phong material takes the ink and the engraving branch
alone (`fragHeadInk` / `fragMapInk`: the kind attribute and one mask sample, no normal maps, no sky). And it is no ware: `gear.look.i`
(`ARENA_LOOK.i`, 0 none / 1 wolf knotwork / 2 blood marks) is a row in the barber, free, saved with the look like the face; the
market's Ink tab is gone, 'ink' is no slot (the server refuses to sell or equip it), and the two wares stay in the catalogue as
`retired` only so a career that bought one still reads — the vale's northerners roll theirs onto their look in `afNpcGear`.
Same day, "they work but look so lame — big abstract shapes that go through your arms and face": the knotwork is the ENGRAVING's
now (`tKnot`, the bracers, at its own fixed tile), and the ink has a bold mask of its own (`tInk`, 512 px on a 70 cm tile): a great
wave that runs across the whole tile and round again (its ends meet, so it wraps without a seam), a thinner second wave, a curling fan
of five spikes, a crescent, three claw marks and bold dots — round-brush strokes that swell and taper, every shape drawn wrapped so the
tile's edges cut nothing. Projected by position (triplanar), one stroke runs off the chest onto an arm, and the great wave crosses the
face at the eyes. THE FACE AND THE HANDS take the ink now (`lookApply`, the head mesh on its own copy of the kinds): the face, the eye
sockets, a scar, the hands, the chin where no beard grows and the scalp when it is shaved; the eyes, hair, beard and brows never.
Then "they look so random, no continuity": a stamp by position can never follow a body. The ink is a DESIGN IN BODY SPACE now: the lathed
body carries its own ink uv (`inkUv` — bearing round the ring × height; the torso hips → neck, each arm shoulder → wrist, mirrored on the
right), the head gets one at load (bearing round the skull × height chin → crown), and `tInk` is an ATLAS of panels those uvs point into
(the torso the left half, an arm the third quarter, the head the last): a chest piece — a swoosh from each shoulder sweeping in to the
sternum, a sun there, one spike down the belly, a hook under each pec — that meets the sleeves at a shoulder band and climbs the neck into
the face (two lines to the eyes, a band across them, three stripes down one cheek); a back piece of two wings off the spine; a sleeve that
spirals once and a half down the arm with spikes off it and a cuff. Strokes are drawn wrapped in their panel (the bearing wraps), the
atlas clamps (panels never bleed), and its black corner is what the belt, the hands and the armour sample. The hands stay bare.

## The surface pass (2026-09-16, "our chars look too low poly")

The user brought a "game-ready" Knight Templar USDZ to compare. It has ~2,200 triangles a figure (ours has 8,250) and 37
bones with no clips: its detail is five 1K PBR texture sets. Ours cannot take such maps — the warrior is palette-textured,
every face's uvs sit in one cell of a 256px swatch — and the flat swatch under Phong with hard split normals was the "low
poly" look. So the detail is made in the shader instead (`modelMaterial` and the block above `loadModelRig` in game.js):

- the palette stays the COLOUR (every dye, look roll and barber pick keeps working); the material is MeshStandardMaterial
  lit by the prefiltered sky in `scene.environment` (the pit's hour rebuilds it; the home/market preview has its own on its
  own renderer, `modelEnvFor`);
- small tileable normal/roughness maps are drawn once in a canvas (`modelDetailTextures`: mail rings, hammered plate with
  scratches, a plain weave) and laid on in the figure's own space along three axes (triplanar — no uvs needed);
- which map a vertex gets is its `kind` attribute — plate steel, mail, cloth, leather, skin, flat — from the bake's
  material per vertex (`modelKindAttr`) and then per body from the LOOK (`lookKind`, in lookApply): a poor man's
  "cuirass" painted as a shirt is cloth, a mail hauberk's body pieces are rings, the pelt-wearer's chest is skin;
- normals are averaged across the split vertices under a 55° crease (`modelSmoothNormals`), so plate reads as curved
  metal and keeps its rims;
- the LOW tier keeps the cheap Phong; `modelRefreshMaterials` swaps every figure piece when the tier changes.
  `BV.modelDetail({ tile, mailTile, str, plateTile, plateStr, plateR0, plateR1, envI })` tunes the uniforms live.

Same day, "the resolution is a bit low, I'm seeing pixels": the low tier drew at 1× pixels with no MSAA (a 3× phone screen
at a third of its density), and the governor's step-down was saved for ever — one slow afternoon locked a machine at 1×.
Now low is 1.5× with MSAA (the governor falls to 1× only as a last resort below low), the saved tier holds for the day it
happened (`bv-quality` = tier@date), and the home page has a resolution pick (`bv-res`: auto / sharp = the screen's full
density up to 3× / soft = 1×) next to the graphics pick — `afSetRes`, `resRatio`.

## The north (2026-09-16, "make it possible to have a look like this" — a Viking berserker reference)

The reference: a bare, tattooed chest under a grey wolf mantle, a blond mohawk and a long beard, engraved steel bracers, a
sash and wool breeches, a curved axe. Everything is a ware, on the one warrior mesh:

- **Berserker's mantle** (`berserker`, armor): `bare: true` like the pelt, pauldrons always on and painted grey fur (the
  mantle), vambraces iron, straps and pouch leather, the skirt's cloth a `sash` (the team dye deepened — teams must
  still read), skirt plates and greaves wool, boots leather, cloak seldom. The plastic fallback is in `AF_LOOK.armor`.
- **Ink**, a slot of its own (`ARENA_SLOTS` has `ink`; both backends validate against the shared list, nothing to migrate):
  `wolf_ink` (blue-black knotwork) and `blood_ink` (red war-marks). Cosmetic. It shows wherever the kit leaves skin bare —
  the pelt, the mantle — through the surface pass: `lookKind` hands skin-painted vertices the `inkWolf` / `inkBlood`
  kinds (6, 7) and the shader lays a knotwork mask (`modelDetailTextures().inkT`, drawn with the 2D canvas: rings on
  a line, triskeles, chevrons, runes) over the skin tone. The market's Ink tab shows it on a bare-chested bust; the
  thumbnails' renderer now takes the surface pass too (its own sky, `modelEnvFor('thumb')`).
- **Seax, bearded axe, Dane axe** (swords): `afBuildSword` grew an `axe` silhouette — a haft, a socket, the bit forward,
  the beard hooking down, a bright edge; the Dane axe adds a poll. The seax is a short `cleaver`.
- The vale's men roll it: a northerner (`afNpcGear`, ~14 %) wears the pelt or the mantle, most are inked, and from 25 XP
  most swing an axe. Hair and beard are the barber's (mohawk, full beard) — nothing new needed there.

Two fixes on the way: a bare chest read as cream because its steel is re-pointed at the WHITE cell while the face is
palette skin × a tint — the bare-skin paint is now skin × (0.98, 0.76, 0.74) so both land on the same colour; and the
bake files the cloth showing at the elbows under "skirt" (one connected cloth component), so a sash coloured the elbows —
`lookClassOf` calls skirt cloth past |x| 0.24 a sleeve (arms hang at waist height in the bind pose; only the flank tells).

## The body under the armour (2026-09-16, "we need a naked body and armours should be attached to it")

The warrior came as armour + a head + hands. A bare-chested look used to paint the CUIRASS skin-colour, so a berserker was a
man in a flesh-toned breastplate. Now `modelBodyBuild` (game.js, above `instanceModelRig`) lathes a body once per rig from the
armour's own measurements: the torso from the cuirass's cross-sections (an ellipse per band, a waist, shoulders broadening
under the mantle where the plate narrows, up to the neck's girth measured on the head class), the arms as tubes down the bones
sized by the sleeves and vambraces — skinned to the same bones (pelvis → chest blend, shoulder → elbow → hand), bound to the
armour's skeleton as the `naked` skinned mesh of every instance, painted through its own pieces map (torso / armL / armR, all
skin, the face's tint) and inked like any other piece. A look with `naked: true` in LOOK_ARMOR (the wolf pelt, the mantle)
drops `cuirass` and `sleeve` and shows it. Two load-time fixes to the bake for it: the elbow cloth is re-filed from `skirt`
to `sleeve` (vertices and triangles), and the skirt cloth above the belt (y > 0.99) becomes `skirtTop`, always hidden.

Same day: the axes are carried head-UP when a man is at ease (`updateAnimator` turns the sword group by π about its own z
for `userData.axe` while the pose is `relax`; drawn, the head leads), the axe head is a 2D profile extruded (socket, a bit
sweeping out and up, a convex edge, the beard hooking down and back; the Dane axe adds a poll), the barber has a sixth beard
— `braided`: the full beard's paint plus a plait of beads on the head bone (`lookBraidGeo` / `lookBraidApply`; ARENA_LOOK.b is
6 now) — and the berserker's bracers are `ironEngraved`: steel kind 8, the ink's knotwork cut in as dark, rougher grooves.

## The face's surface (2026-09-16, "character faces are too low poly now, let's add them some detail and smoothing like the body and armors")

The surface pass gave the plate and the cloth their smoothing and their grain; the head stayed a paper mask — ~750 triangles for
the skull and its features (the eyes ~290 more), split at every palette seam, a nose of four planes — and `lookFaceApply` threw
even the crease pass away (`computeVertexNormals` on split vertices is flat shading, so any face but 'hard' was faceted). Four
things, all in game.js by `lookRuggedHead`:

- **Refinement** (`lookHeadRefine`, once per rig at load, before the head is roughened): the head's and the eyes' triangles are
  subdivided one level by Phong tessellation — interpolating, so every vertex the artist placed stays put and every position band
  in the file (the rugged head, the bake's regions, `lookFacePoint`, the hairline) still means what it did; each edge gains a
  midpoint lifted onto the surface the vertex normals imply (the midpoint dropped onto the tangent plane at either end, averaged,
  `LOOK_REFINE_LIFT` of the way). Local, no fans or valences: a butterfly stencil was tried first and furrowed the forehead's tall
  thin triangles. The lift uses the welded normals (every triangle at a position, across the seams) and the new vertices are
  emitted per split edge, so seams and palette cells survive. A new vertex keeps its edge's piece; at a seam between two pieces
  the bake's own position rules say which side (`lookBakeHeadClass`, a port of `warrior_pieces.py` — keep the two in step); its
  cell and skin weights come from the edge's ends. `pieces.json`'s per-vertex and per-triangle arrays grow with it in memory (the
  file is untouched). ~3 100 triangles more a bare head, 20 ms at load.
- **Normals** (`lookFaceNormals`): after the 55° crease pass, the face's and the eyes' normals are averaged across seams and
  facets under a 120° crease (`LOOK_FACE_CREASE`), then softened — two rounds of each welded vertex's normal averaged with its
  ring's (`LOOK_FACE_SOFTEN`; the welded neighbourhood is `lookFaceAdj`, built once per rig). `lookFaceApply` runs the same passes
  on a body's own copy after it casts a face. `modelSmoothNormals` takes a vertex filter for it.
- **Pores** (`modelDetailTextures().skinN` / `skinR`): a skin height field — two octaves of swell under a grain of round
  dimples — laid on every skin kind (bare or inked) as a triplanar normal map, with an oily sheen over the swells and matte pores
  in the roughness. `BV.modelDetail({ skinTile, skinStr })` tunes it (defaults 14 × tile, 0.35 × str).
- **The paint's edges** (`lookScalpMask`, `lookBrowMask`): the finer head showed what the coarse one hid — the forehead is tall
  slivers fanning from the crown to the brow row, and a dark vertex at either end (the hair colour painted on the scalp under the
  cap; the bake's brow box, which takes the skin round the eyebrow's root as well as the ridge) ran its colour the length of every
  sliver it touched: a comb of dark bands. Found by swapping materials in the render (the normals were clean, the vertex colours
  alone carried it). Now a scalp vertex is painted only when every neighbour is under the cap too (one mask per style per rig),
  and a brow vertex only when every neighbour is brow — the ridge stays dark, the skin round it stays skin.

Hands are not refined (the user asked for faces); `LOOK_REFINE_CLASSES` is the list if they should be.
