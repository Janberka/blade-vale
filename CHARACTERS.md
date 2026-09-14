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
