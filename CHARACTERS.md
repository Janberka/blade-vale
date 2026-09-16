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
