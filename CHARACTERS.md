# Blade Vale — the character look

The rules that make a Blade Vale fighter recognisable at a glance, whatever team colour they
wear and whatever gear they bought. They live in one place, `buildHumanoid` in `game.js`, so every
fighter — the player, the arena's NPCs, the thousand-man hosts of the vale — carries them.

## The five signatures

1. **The Vale crescent.** A brass crescent-blade fin rises from the crown of every helm, swept a
   little back. It is the silhouette: the "blade" in the name, readable across the pit and in a
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

## Proportions

~6.5 heads tall, a broad deep chest, thick legs on a wide stance, big fists, a great helm that
hides the head. Heroic, not realistic; low-poly flat shading, so plates read as angular facets.
Keep it: hit heights (1.8 / 2.1 / 2.6 × scale) and every animation assume it.

## Adding a new fighter type

Build it through `buildHumanoid` (or `buildCavalry`, which seats the same rig). Do not hand-roll
another figure — it will not carry the signatures, and it will not take gear.
