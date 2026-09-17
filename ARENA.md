# Blade Vale — Arena Fights

**The way into the game** (since 2026-09-12 the title screen offers only **⚔ Enter the Arena**;
the open world is parked behind `?world` — see `VISION.md`). You choose how many
teams fight and how many fighters each team has, invite players who are online, and every
seat nobody takes is filled by an NPC fighter. Everyone drops into a walled pit; the last team
standing wins.

Companion docs: `BATTLES.md` (the army-scale battle system this reuses primitives from) and
`BATTLE_CONTROLS.md`.

---

## 1. Playing

1. Sign in (or not — without an account you can still fight NPCs, you just can't invite anyone).
2. Title screen → **⚔ Enter the Arena**. Signed in, the title screen is the **home**: your fighter stands on the
   left at ease (the market's preview, wearing what you own; click the name card under him and the career
   sheet — record, skills, achievements — takes the right pane, ← Menu brings the menu back), the menu on
   the right (Enter the Arena, Marketplace; Enter the Vale with `?world`). `#home` in `index.html`, `afHomeOpen` / `afHomeRender` / `afCareerSheetHtml` in `game.js`. The
   market itself sells wares only now.
3. In the lobby: **Teams** (2–6), **Fighters per team** (1–200; « » step by ten), what **you ride in with** (sword, bow, or a horse — the class rule: an archer carries a bow *and* a sword, a swordsman or a rider carries no bow), the **Pit** (cosy / wide / vast / colossal — it keeps growing past colossal to fit a legion-sized roster), **Hour** (day / dusk / night), **Sky** (clear / rain) and the **Ground** (sand / hills / rocks / broken — the terrain of the pit).
   The team cards show every seat: you, invited players who accepted, and *fighter of the vale*
   (an NPC) for each empty seat.
4. **Players online** lists everyone connected to the war-net right now. **Invite** sends them
   a challenge; you can also invite by username. Their card shows *invited…*, *joined*,
   *declined*, or *in a fight*.
5. **Start Fight**. A 3-second countdown, then the bell.

An invited player sees the challenge wherever they are — on the title screen or out in the
vale — and can **Accept** or **Decline**. Accepting from inside the vale brings them back to
the title screen and straight into your lobby. Guests can switch to any team with a free seat
and pick their own weapon; only the host changes the team layout and sends invitations.

`?arena` in the URL opens the lobby immediately. `?world` (or `localStorage['bv-world']='1'`)
shows the hidden **Enter the Vale** button and the open-world title copy again (`WORLD_ON` in `game.js`,
`body.world` / `.world-only` / `.arena-only` in `index.html`).

### Controls

| | Desktop | Touch |
|---|---|---|
| Move — **the run builds**: the first strides are a jog, hold forward (the way you face — nobody sprints sideways or backwards) and you reach full stride in about a second and a half; at full stride you carry momentum (slower to stop, wide to turn); backing up, cutting across your own line, blocking or loading a blow bleed it away | WASD | left thumb stick |
| **Jump** — a leap from wherever you stand, with the blade at rest; you fly the way you left the ground. Attack in the air and the leap is an **overhead blow** that comes down with you instead (a heavy: it cracks a guard). Come down on a man at full stride and he is **FLOORED** (the horse's trick on foot: a second and a half on the sand, open) and your own stride is spent on him; a slow hop onto a man is nothing | Space | JUMP |
| Aim | mouse (click the pit to lock the cursor) | drag the right half of the screen |
| Attack: **hold to load, release to swing** — a tap is a quick light (three chain into a combo), a full hold is a heavy that cracks a raised guard; the bow draws the same way | hold / release left click | hold / release ATK |
| Block (hold; 85% less damage from the front) | Shift or right click | BLOCK |
| **Shield bash** — TAP block (press and let go inside a fifth of a second) and the shield is punched out in front: little damage, a hard shove, and a man behind a raised guard is **guard-broken** for half a second — a light tapped behind the bash lands in the opening (an execution); a man loading a blow loses the load. Costs breath; not from the saddle, not with a bow in hand. A tap that only cancelled your own load is a cancel, not a bash | tap Shift / right click | tap BLOCK |
| **Shield charge** — hold block at full stride and the shield comes down in front, you keep the stride and go through: square on, a man on foot is **RUN DOWN** (two of them, if the first doesn't stop you), a man behind his own raised shield is guard-broken instead, a horse at a walk loses its rider; a horse under way is a wall. Costs breath; ends when you drop the guard, ease off, or run out of men | Shift at full stride | BLOCK at full stride |
| Swap sword-and-shield ↔ bow (archers only — a swordsman or rider has no bow, and the SWAP button is hidden) | F | SWAP |

On touch, the thumb that holds ATK or BLOCK also aims: press, drag to turn, release to swing where you
face (the other thumb is on the stick, so there is no third finger). A mouse or pen on a device that also
has a touchscreen (a touch laptop, an iPad with a keyboard and trackpad) gets the desk's aim: a click asks
for pointer lock; where no lock can be had (iPadOS Safari has none) the held button aims by drag, like
the thumb. The canvas is re-fitted to the window every frame, not only on the resize event, so a rotation
or fullscreen change that fired resize early can never leave the picture in half the screen.
| Roll — forward, back, either side or anything between (invulnerable for most of it; you come up still facing your man) | C rolls the way you're moving (a side if you stand still); Q / E are always the sides | tap JUMP twice — you roll the way the stick leans (a side if it rests) |

When you fall you spectate: drag to orbit the pit, wheel to zoom. The fight ends when one
team is left standing, or after 3 minutes (most fighters standing, then most health, wins).
The host can call a **Rematch** (same seats, fresh pit) or everyone can **Leave the pit**.

---

## 2. Where it lives

| Piece | File | Notes |
|---|---|---|
| Lobby markup + CSS, challenge prompt | `index.html` — `#arena-btn`, `#arena-lobby`, `#arena-invite` | |
| The whole mode | `game.js` — the `ARENA FIGHTS` section (state object `AF`, functions `af*`) | the main loop hands the frame to `afFrame` while `AF.on` |
| Directed invites on the relay | `server/ws.js` — `who`, `invite`, `dm` | `hello` now carries `acct` (the signed-in username) — the address invites go to |
| Socket client | `net-battle.js` — `coop.who / invite / dm`, multiple handlers per event, reconnect with seat resume, dead-link watchdog | |

### The fight

Every fighter — you, an NPC, a remote player — is the same object driven by **one control
routine**, `afDrive`, from an input record `{mx, mz, yaw, atk, heavy, dodge, block}`. Your
keyboard/mouse writes yours (`afReadLocalInput`), the NPC brain writes its own (`afThink`), and a
remote player's arrives over the socket.

The feel is borrowed from the field fights, not re-invented: a **velocity model** with friction
(weighty starts and stops, knockback as an impulse), a **lunge** with every blow, slash arcs and
blade trails on the strike, **hit-stop**, camera shake, a directional kick and an FOV punch on your
own hits and wounds, a queued **3-hit combo** that chains from the follow-through, **block-cancel**
out of a light windup, aim assist that tracks a foe in front while you wind up, and the run/walk
gaits with backpedal. Damage (`afDamage`) runs the **poise** model: light hits chip poise and
flinch, a raised guard stops a light from the front (see *Steel on steel* below), a heavy on a guard is a *guard break*, and when
poise runs out the fighter is **staggered** for 1.2 s — any hit on a staggered fighter is an
**execution** (2.2× damage). Arrows only chip poise lightly.

**The shield bash** (2026-09-16, the user: "tapping on guard (without holding) should do a shield attack"):
`afDrive` times every BLOCK press of a human fighter (`b.blkT`); let go inside `AF_F.bash.tapBy` (0.22 s) with nothing
else going on (no swing, no load, no charge, not landing, not winded, a shield in hand) and `b.bash` starts: `wind` 0.10 s
with the arm cocked (`bashWind`), the punch (`bashHit`, a lunge of `lunge` × move through wind + strike), `rec` 0.26 s
back to guard. At the strike frame `afBashHit` (host) takes the nearest foe square in front within `reach` 1.7 and puts
him through `afDamage` as a **heavy of weight `k` 0.6**: little damage (`dmg` 3–6), the heavy's knock, a raised guard is
GUARD-BROKEN but the stagger is capped at `open` 0.6 s (a heavy's is 0.75) — a light tapped during the bash is kept and
comes out behind it (0.26 + 0.24 ≈ 0.52 s to the hit: inside the opening, so it executes; `cd` after the bash is 0 — any pause there eats the buffered tap); a man loading a heavy loses
the load (k ≥ 0.5 rides through the armour rule); a man with no guard up is flinched `flinch` 0.4 and shoved. A tap that
cancelled your own load (`b.blkCancel`) stays a cancel. NPCs never tap (their guard is a timer). State code 18 on the wire,
the move slot 1 once the shield has gone out.

**The chain has an end** (2026-09-12, after the pits were "super easy even against veterans": tapping
the button stun-locked anyone to death — a tapped light lands 0.06 s after the press, every hit cancelled
the other man's swing and flinched him, the next tap chained before he recovered, and three lights broke
poise for a 2.2× execution). The light chain is **three blows** (`comboMax`): the next chains at ¾ of the
follow-through (`chainAt`, ~0.37 s hit to hit — a hair longer than the 0.32 s flinch, so a man who reads
the chain can get his guard up for the second), the **third** swings wide with twice the follow-through
(`comboRest`) and nothing queues behind it, then a 0.35 s breath (`comboCd`) before a tap counts again.
Three lights **chip** a guard (14 poise each, 42 of 45) and never stagger by themselves; a heavy on the
chipped guard breaks it. A blow that lands breaks the chain the victim was cutting. A light's knock is a
nudge (3), a heavy's a shove (14). The flinch (0.32 s) outlasts the light's recovery (0.28 s), so whoever
lands the blow keeps the initiative instead of being punished for it. Measured headless (a scripted
button-masher vs veteran NPCs in the pit): before, the masher killed a 174-hp champion guardsman in
4.8 s taking one swing in return; after, he loses four fights in six and wins the other two with under
20 hp left, while a scripted player who blocks the swing, rolls the heavy and loads a heavy into a raised
guard still wins three in four. Rookies (`green`) still fall to a masher — the pits are for rookies.

**The NPC brain** is a pack director (`afAssignTargets`, every 0.3 s): each NPC claims a foe,
closest first, a victim accepts at most **two** committed attackers, the overflow spreads to another
foe with a free slot, and only when every duel is full does a man *wait* — circling to a slot in his
mark's rear arc and committing only from behind, where guards can't reach. In a duel (`afThink`) he
closes at a charge and circles near contact, keeps the blade's length between blows, cracks a raised
guard with a heavy or goes around it, **punishes** a foe's follow-through or stagger, rolls away from
heavies, blocks or dodges a seen light by skill, and when badly hurt and outnumbered backs off toward
his team with his guard up. Archers stay behind and try the long shot: they hold range (`AF_TACT.bowNear`–`bowFar`,
11–30 paces from the nearest foe, loosing out to `bowShot` = 38, the approach volley from `bowVolley` = 40 — 2026-09-16,
the user: "Archers can stay behind and try long shots"), drift sideways between shots, keep `bowRoom` of clear sand from their own
swordsmen (`afArcherRoom` — a bowman in the press is neither seen nor useful), and when a foe comes inside
`bowNear` leave the line and give ground away from the enemy's mass, shooting a swordsman who keeps coming.

Bodies are `buildHumanoid` figures animated by the shared pose system (`setPose`/`MOVES`/
`walkLegs`), exactly like the battle editor, so any change to the rig or poses shows up here.

### The look

Arena fighters are built with `buildHumanoid(..., { hero: true, plume })`: the whole head rides a
pivot so it can look at a foe, a plume in the team colour crowns the helm, a tabard carries the team
cloth on the chest, and a cape hangs off the shoulders. The hosts of the world map never get this
dressing, so the 1000-man battles cost the same as before.

On top of the authored poses, `afCommit` layers **secondary motion** every frame: contralateral
arm swing and a forward lean on the run (with the walk/run gaits and backpedal), breathing, a head
that tracks the mark, a directional flinch when hit (shoulders thrown back, head snapped), a cape
that flares with speed and streams behind a roll, and dust at the planted foot. Deaths **crumple**
(`afStepDead`): the knees buckle, the torso folds, and the body goes over sideways and lies where it
fell; blood soaks into the sand (`afSplat`) at every wound and stays for the round.

The set (`afBuildGround` / `afBuildWall` / `afBuildSky`, all seeded so every client builds the same
pit): a gradient sky dome, warm key light with a cool fill, filmic tone mapping, full-resolution
rendering with 2048² sun shadows over the whole ring (on phones too — the pit is small enough), sand
with patches and a trampled middle, and the **amphitheatre** (below). The sun hangs in the sky as a
soft disc, dust motes drift over the sand, and pebbles and a snapped blade or two lie about. These
renderer settings apply only while the arena runs; leaving the pit reloads the page.

**The amphitheatre** (`afBuildWall`, after the Flavian one; `AF_AMPH` holds the plan, `afAmphH` the levels, which
all hang off the podium's height). Radially from the sand: a 10 m **podium wall** (three knights tall — the old one
was 2 m) of rusticated courses with recessed joints on a plinth, pilasters with iron torch brackets (six lit) and
capitals, a frieze with gilt studs, a cornice and a balustrade; the teams' drapes hang over the balustrade above
their gates; against it on the sand, either side of every gate, a marble **colossus** on a stepped plinth with a bronze
shield and a raised blade (the gate guardians — `colossus` rock records with a collision circle, drawn by
`afBuildPitClutter`). Behind it the podium walkway with the dignitaries, **bronze figures** with gilt blades along its
edge between the aisles (`afStatue` builds every statue in the house, at any scale), and the **imperial box** (a marble dais, gilded columns,
a crimson canopy, a throne, two robed figures) midway between the first two gates; then two **maenianae** of five
stone rows split by a praecinctio, cut by stair aisles every ~21 m with dark **vomitoria** under the upper rows and
doors out of the top gallery; the **gallery** itself, a colonnade under a tiled roof with the teams' long drapes on
the wall behind; the **attic** with a parapet of robed statues and the masts of the **velarium** — striped sails roped to
a ring over the seats, two bays of cloth to one of sky, shading the stands and leaving the sand in the sun. Outside,
three storeys of **arcades** (piers, spandrels, arch rings and keystones, engaged columns with Tuscan / Ionic /
Corinthian capitals, statues in the upper arches) and a pilastered attic hung with bronze shields. The gate tunnels
run under the seating. **Ruins** lie on the grass round the building (`afBuildRuins`, 11–16 sites: broken colonnades
with a lintel still up, a lone arch, wall stubs, a toppled statue, in a belt 4–13 m out from the wall; and, when
`assets/ruins-pack.json` has loaded, the user's *Ancient Ruins* pack — four rocks, a fallen building's shell, and one
giant runic **sword** standing on its point far out at the imperial box's bearing, alone, for the entrance film). The pack was exported from its USDZ with `ModelIO` and its textures baked to vertex colours
(`assets/ruins-pack-export.swift`, then `BV`-free node compaction to `assets/ruins-pack.json`, ~48 KB), so it needs no
texture at run time; the plants in it are alpha-cut cards and were left out.

Everything but the crowd bakes into **two vertex-coloured meshes** (`afMesher`: boxes, cylinders, extruded arch
shapes and lathes transformed on the CPU into one flat-shaded buffer — the seating bowl is a single lathe profile;
`afArchTop(d)` gives the bowl's height at a radius for the cameras). The **crowd** (2 400 seated and standing for a
cosy pit, ~4 300 colossal, capped by `AF_AMPH.crowdCap`) is four `InstancedMesh`es — bodies with per-instance colours
(partisan near each team's gate, whites and purples on the podium, drab in the gallery), heads, arms and the flags
one in eight holds — and moves in its **vertex shader** (`afCrowdMat` / `AF_CROWD_U`): the same restless bob, leap on a
roar and Mexican wave the old per-body step did, plus arms that rise with the roar and flags that flutter. **The pit itself is crowded too** (`afGenTerrain` → `afBuildPitClutter`, on every Ground, most on bare sand via
`AF_GROUNDS.clutter`): broken columns (a few still whole), fallen drums, wall stubs, a toppled statue, a building's
shell from the pack (three collision circles under one mesh), and barrels and crates in clusters — all of them rock
records with a kind, so the men, horses, arrows, marks and cameras treat them exactly like stones — plus dressing
nobody walks round (`T.deco`: spears in the sand, dropped shields in the nearest team's colour, bones, planks, fallen
Vale helms, a cart wheel, stakes with pennants). Muster grounds and gate corridors stay clear. The pit's boulders and
scree are the pack's rocks fitted to their circles (`afBuildRocksPack`). Cameras:
follow lenses stay inside the sand (`afCamInPit` — the wall is solid now), the free camera rides over the seats
(`afCamOverBuilding`), the countdown sweep starts over the lower rows under the sails, and the intro's *stands* shot
is taken from the balustrade. The ground under the ring is flat (`afY`'s bowl now begins beyond the outer wall). Test
hooks: `BV.arenaCam` (place the lens), `BV.renderInfo` (a frame's draw calls / triangles), `BV.ruinPreview` (the pack's
pieces in a row), `BV.arena({time, weather, pit, ground})`.

**Post-processing** (`afPostInit` / `afPostRender`, three core only — no addon library): the scene
renders to a target, a bright pass + separable blur at quarter resolution makes a bloom that lifts the
torches, sparks, blade trails and the sun, and a composite adds a vignette, a touch of contrast and
saturation, and a red flush at the edges when you are hit (pulsing when you are near death).

**The Pits** (lobby *Venue*: 🏛 Colosseum / 🕯 The Pits; `AF_PIT` holds the plan, `afBuildPitHouse` the
house, `afApplyPitLight` the light): an illegal fighting cellar under the tanners' quarter — the small,
shady counterpart to the Colosseum where rookies cut their teeth. Picking it shrinks the lobby: two or
three **fighters**, one a side (every man for himself), **swords only** (no room to draw a bow, no door
a horse fits through — bow/horse are hidden, every seat rides in with a sword, the body's `canBow` is
off), foes default to *green*, and the size / hour / sky / ground rows disappear (it is always night
underground on bare sand). NPCs are rolled one a side from the four foot classes (`AF_PIT.arch`) so the
two foes differ. The venue travels in the go spec (`venue: 'pit'`), the lobby broadcast, the beacon and
the invite (`calls you down to the pits`); `afSetVenue` switches a lobby and restores the Colosseum's
per/foes on the way back; `afLim(L)` gives the seat limits for either house. The house itself: a sunken
ring of sand `AF_PIT.r` (11) wide behind three courses of rough stone and a plank cap, the patrons'
flagstone floor a chest height (`lip` 2.4) above it behind a timber rail, six braziers on the lip and
eight brackets on the brick (all `AF.torches`, lit by the night table and damped by `userData.lightK`),
barrels, crates and straw against the walls, a bookmaker's table with the strongbox by the stair's black
doorway (skulls on spikes either side), an iron candle-wheel on chains over the sand with the lantern key
light under it, a beamed plank roof three men up (in a second, non-casting mesh so the near-vertical sun
that stands in for the wheel still throws body shadows), and four rings of dark-cloaked patrons in the
same instanced vertex-shader crowd as the Colosseum (`afBuildCrowdMeshes`). No gates, no tunnels: the
pits have their **own entrance film** (`afPitIntroStart`, on the Colosseum's machinery — `AF.intro`,
`afIntroStep` / `afIntroBody`, the lens kit): the cellar from the foot of the stair under its candle-wheel
(`THE PITS · N in the ring · every man for himself`, the stake if there is one), the bookmaker's table from
the punters' side (`THE STAKES`; the outer rings keep clear of it), then each fighter in turn — the foes
first, you last (`AND YOU`) — stepping out of the black doorway between the skulls, walking the lane the
patrons keep open through every ring, and **dropping over the lip** onto the sand in slow motion through
a gap in the rail (`afIntroDrop`: a hop, the fall, the knees taking it, dust; the men carry `b.yOff`
while they are up on the flagstones or the stair, zero in the fight), a turn under the candle-wheel while
the others take their marks (the `THE PITS` banner) before you come down, and then **the walk-in**: the lens
behind you as you land and cross to your mark, settling into the fight camera (`afFightLens`), so the
countdown starts without a cut (watching only: the turn, then the face-off over your star's shoulder). The
drop's lens picks the side of the stair clear of every mark (`marksClear`). Timings in `AF_PIT_INTRO`; ~22 s for
two, ~26 s for three. The cameras know the room: the free lens
stays under the beams, over the patrons and inside the walls (`afCamOverBuilding`), the countdown sweep
starts under the roof, `afArchTop` is flat. The end panel names the fighter, not the team (`Ysolde holds
the pit`, *You won.*). The result report carries `venue` (the server ignores it for now — a pit fight
pays like a small Colosseum fight). Cost: ~55k tris and ~80 draw calls with three fighters. Test:
`BV.arena({ venue: 'pit', teams: 3, intro: false, start: true })`.

**The entrance** (`afIntroStart` / `afIntroStep` / `afIntroCamera`, phase `intro` before `countdown`): a
procedural cinematic staged after the Zucchabar scene in *Gladiator*, about 20 s for two teams. Every team has a
**gate and a tunnel** in the ring wall behind its muster point (`afBuildGates`: pillars, a lintel, two plank doors on
hinge pivots, a roofed corridor out under the seating with a black mouth at the far end, torches on its
walls, sun through the door slats while it is shut and a wash of light when it opens). The **stars** of each team
(`afPickStars`: the two highest-XP fighters, a player only if nobody outranks them; one star below three a side)
take the front rank's middle — they swap muster points with whoever held them — and the team waits in the tunnel
as a column three abreast (riders one to a rank, at the back); a roster longer than the tunnel comes up out of the
dark. The cut: the pens (over the helmets at the shut gate, with a caption naming the team and its stars) → the
gates swing open to a horn, a creak and the roar, low from the sand → the stars' walk-outs in **slow motion**
(`AF.timeScale` 0.35; a low lens ahead of each man tracking back through the doorway) → the column pouring out of
my tunnel → a crane up over the whole pit → over my star's shoulder at the enemy line. Meanwhile the columns march
in (`afIntroBody`: down the tunnel, then each man to his own muster point; a star raises his blade on arrival),
and at the end everyone snaps to his point under a blink of black, the gates close behind them and the countdown
sweep takes over. Before any act, in the Colosseum, an **establishing shot** (`L.outside`, captioned THE COLOSSEUM):
eight seconds, low on the grass outside my gate's bearing among the ruins, sweeping along the facade with the
statues in the arches sliding past, then a crane up the facade, over the masts and the sails, and down into the bowl.
Half the time (a coin from the seed, when the ruins pack placed the giant sword) it opens on the **sword** instead:
the blade alone against grass and sky, seen from the house's side; the lens circles it until the house rises behind
the blade, and the circle flows straight into the sweep: the sweep begins where the circle ends and its radius, height
and gaze blend over during its first seconds while the lens keeps moving at the same pace — no cut, no stop, no push-in
(11.6 s in all). The sword stands far out at the imperial box's bearing (`AF.sword`, recorded by `afBuildRuins`; radius the
lesser of wall + 30 m and 2.45 R) with nothing within 30 m of it; the other ruins hug the wall (4–13 m out), inside
the sweep's radius, so the lens passes them and never through them. **Six acts, a bill per fight** (`AF_ACTS` / `AF_ACT_DIRECTORS` / `afIntroCompose`): every
*team* is dealt its own entrance style from the seed — a different one from the other teams' where the roster
allows, and for your own team never the one this device saw last (`localStorage['bv-intro-last']`) — so one fight
might open with Azure's champion walking out alone and Crimson's cavalry lapping the ring. The acts: *the pen* (the
cut above, per team), *the champion* (the team's best comes out alone — a seat in the stands, low in the tunnel, his
profile, a backlit walk into the sun — then the rest), *the legion* (drums, an aerial over their side, the gate from
a seat, a dolly along the column, the front rank coming on, the block from above; weighted toward big rosters), *the
captain* (the star strides out alone to the middle and holds it, rallying, while the camera circles him; then his
men), *the riders* (the horse leads out and laps the ring at a canter, tracked alongside; only for a team with
cavalry) and *the duel* (a lone fighter, low in the pen, the run out in slow motion; teams of one or two). Two
captains or duellists meet in the middle. The other teams march first and **yours last**, so the film ends on your
own entrance; after every act the shared finale: the crane over the pit with the banner, then **the walk-in**
(`afIntroWalkIn`, 2026-09-14): from wherever the lens was it eases in behind you as you and your men walk onto your
marks, and by the end it *is* the fight camera (`afFightLens` — the same place `afCamera`'s follow puts it, wall and
ground clamps included; in a headset your own eyes), so the countdown starts with no cut, no fade and no sweep
(`AF.noSweep`). The shot lasts until you stand on your mark and a beat more (`until` in `afIntroStep`, at most
`maxDur`); anyone still walking then finishes during the countdown (`AF.introTail`, `afIntroBody` keeps marching him)
and takes his mark at the bell at the latest (`afIntroTailEnd`). A star holding the middle lets go at the walk-in's
start. When you only watch, the finale is the face-off over your star's shoulder as before, with the cut.
**Bareheaded, helm in hand, blade at the hip** (2026-09-16): every man walks in with his helm carried in his sword
hand and his sword sheathed at his left hip (`afDonReset` at the start — `parts.sheathed`, `lookHelmOff`, `L.helmHand`).
The carried helm is the body's own sculpted helmet lifted off as a rigid piece (`lookHelmBuild`: its triangles copied
into a geometry in the head bone's space, every helmet vertex rides that bone; painted like the body's — `lookHelmPaint`;
hung on the hand bone at `MODEL_HELM_HAND`). The hip blade is a copy of the figure's own sword on the hips bone (`mHip`
in `wearModelRig`), shown by `syncModelRigs` while sheathed and on an archer while his bow is out. A star rallies with
the helm (or his fist) raised, not a blade. In the countdown's last breaths (`AF_DON.at`, a per-man jitter) `afDonStep`
runs the beats: the hand rises to the crown (`donHelm`) and the helm rides up with it, lerping from the hand onto the
head (`L.helmK` 0→1, `modelHelmPlace`) where the body's own helmet takes over (index rebuild only — `lookDraw`); the
hand comes down, crosses to the hip (`drawHip`), the blade comes out and up (`drawOut`), then guard. A man without a
helm skips the first, an archer keeps the bow. Whoever is still walking in at the bell does it all at once (`afDonAll`
in `afIntroTailEnd`). Test: `BV.arenaDon()` (each man's sheathed / bareheaded / in-hand / beat), `BV.previewHelm(true, k)`
puts the home figure's helm in his hand (k lifts it onto his head), `BV.helmHand({x,y,z,rx,ry,rz})` and
`BV.hipSword({...})` re-hang the pieces on every live figure. The HOME figure carries his helm the same way
(`afPreviewHelm`), and when he takes up his sword from the floor he sets the helm on first with the same lift
(`afPreviewPickup`, `P.helmLift`) and keeps it on (`P.helmOn`); the barber's chair is always bareheaded. Every act
is built from the same lens kit (`afIntroLens`: pen, gate,
star, profile, backlit, ride, behind, column, dolly, front, stands, crane, aerial, top, orbit, face-off, walk-in) and the same
route system (`afIntroRoute`: waypoints with speed, gait, a pause and a facing). The **stars rally** their men
(`AF_RALLIES`, poses `rally` / `rallyPump` / `point`): in the pen they turn to the ranks with the blade up and pump
it, and on taking their place they raise it to the crowd or point it across the sand — three routines each, dealt
per star. `?film=champion,riders` (or `BV.arena({ film })`) forces the acts, your team's first. Camera sides, star order and beats are dealt from the seed, so every client sees the same film;
nothing is simulated in the phase (no `afTick`), so the net cannot drift, and a guest still watching when the host's
first `fight` snapshot arrives is snapped forward. Skip with Space / Enter / Esc or the button; `?nointro` in the
URL (or `BV.arena({ intro: false })`) turns it off. Test hooks: `BV.arenaIntro()` reads it, `BV.arenaIntro(n)` jumps
to shot n, `BV.arenaIntro({ advance: secs })` steps it, `BV.arenaIntro('skip')`.

**The victory** (`afVictoryStart` / `afVictoryBody` / `afOutroCompose`, phase `over`): when the last man falls the
pit freezes where it stands. Every fighter still on his feet keeps the spot he held at the bell — `afVictoryBody`
drives the living for the whole `over` phase, on the host and on every guest alike, so nobody is left mid-swing and a
guest never replays the host's stale states — and the **winners put their swords up** (`rally`, each a beat after
the last with a pump of the blade now and then; an archer sheathes the bow first, it is the sword that goes up; the
beaten who are still standing come to rest). Then a short film, `AF.outro`, a shot list like the entrance's: **the
star of the match** low and close as the steel goes up (a fallen star: the sand where he lies), **the line** — a slow
circle round the star with his men behind him (or, if the star fell, the winner nearest the middle of them), **the
crowd** — the lens rides the rim of the bowl for five seconds with the tiers rising ahead of it while the house is on
its feet (a wave runs with it; in the cellar it rides the ring among the patrons), and **the crane** back down onto the
sand and the man holding it. The pits have their own cut: the star, then **the last man down** — from the sand where he
lies, up at the man who put him there (only if he fell within ten paces of the winner), **the cellar** (the ring among
the patrons, four seconds), **the purse** — the bookmaker's table, the strongbox and the gold (`the bookmaker pays
out`, the stake a man if there was one), and the crane, which ends on `THE RING IS HIS · name`. The subject sits in the **left third** of the frame (`afOutroShift`: a lens shift via
`camera.setViewOffset`, cleared when the film ends; portrait screens shift up instead) and the **board** fills the
right (`afOutroBoard`, in the letterbox overlay): the result and the star, then every team's tally — standing, kills,
damage dealt and taken — and its men row by row (kills / dealt / taken / standing or fallen, the star in gold, you in
bold; past 24 a side the top eight of each and a count of the rest), the rows sliding in one after another. Guests
get the numbers from the host's `over` message (`ledger`: kills, dealt, taken per body index — `dmgTaken` is kept on
the target in `afDamage`). Letterboxed with captions, ~15 s, skippable (the button, space / enter / escape), then
the end panel. `?nooutro` (or `BV.arena({ outro: false })`) drops the film — the poses stay; ⏭ *Skip to the end*
and *Leave* never run it. Test hooks: `BV.arenaOutro()` reads it, `BV.arenaOutro(n)` jumps to shot n,
`BV.arenaOutro({ advance: secs })` steps it (sim included), `BV.arenaOutro('skip')`. Durations in `AF_OUTRO.shots`.

**Camera**: during the countdown the camera sweeps from high over the pit down onto your shoulder,
the lens widens slightly on a run, and the field-fight shake / kick / FOV punch land on your hits.
Strikes use an ease-out-back so the blade whips past the mark and settles; every hit puts a white
impact frame on the victim.

**Loading a blow**: there is one attack input. Pressing raises the blade (the load); past ~0.35 s the arm
coils into the heavy windup; releasing swings with a weight `k` = hold time / `chargeMax`. Damage, reach,
arc, knockback, poise damage, the lunge and the slash arc all scale with `k`; past `heavyAt` the blow is
a heavy (cracks guards, resets the combo). A HUD meter under your fighter shows the load and turns red
at the heavy line. NPCs load their swings the same way, so a long visible hold is a heavy you can roll from.

**The HUD** (`afHud` / `afUpdateHud`): the sand stays clear. One small card top-left reads `AZURE 3 / CRIMSON 1 · 2:14`
(your team underlined, a fallen team dimmed) with your health as a thin bar under it; nothing else sits on
screen but the load meter and, once you are down, the spectator bar. A tap on the card (Tab on a keyboard,
also under pointer lock) opens the full sheet — the captain's order, every team's standing/total, your name
and kills, and the **lens** slider (`AF.fovUser`, 40–100°, `[` / `]` on a keyboard, kept in
`localStorage['bv-fov']`; a run still widens it a touch). The open/closed state is kept in `bv-hud-open`.
On touch, a **pinch** on the sand zooms the way the wheel does on a desk: while you stand both fingers must
be on the right half (the left thumb is the stick) and it ends the drag-look; dead or spectating, anywhere.
Controls are written nowhere else: the title screen, the home, the lobby and the pit share one small **?**
top-right (`#help-btn` → `#help` key map in index.html, desktop and touch sections; `?` opens it, Esc or
Close shuts it, `BV.help(true|false)` in tests). The kill log sits under the ? at top 44 px.

**The shell** (`afShellPage` / `afShellBack` / `SHELL`): every screen outside the fight uses ONE layout — the
fighter on the left (`#shell-left`: the preview figure, and the name card for a signed-in player), the page on the
right (`#shell-right`: a bar with **Back** always in the same place, the page title, the **?**; then the scrolling
page). `#start` IS the shell, so everything that used to hide the title screen still hides it. Pages are its
`.page` children: `title` (guest: pitch, Enter the Arena, sign-in), `home` (menu), `career`, `lobby` (Arena Fights),
`market`, `help` (the key map — a page, not a modal). Back walks a stack (help over the market goes back to the
market; leaving the lobby drops its trail and leaves the war-net room); in the pit the fixed **?** opens the help page
over the fight and Back returns to it. Test hook `BV.shell()`.

**The home figure** (`afPreviewFloor` / `afPreviewClick` / `afPreviewPickup`): on the signed-in home he stands
empty-handed, breathing hard, with his sword planted in the sand before him (tip buried, `modelPropGeo` lifts the
figure's own sword and shield meshes out as plain props) and the shield leaning on the blade. A tap on either (no
drag) turns him to it, he stoops (`POSES.pickR` / `pickL`, a knee crouch) and rises holding it; the market always
shows him armed, and what he has not taken up is back in the sand when you return. Picking is forgiving: the ray's
distance to the blade's axis, the shield's box. Test hook `BV.previewPick('sword'|'shield')`.

**The marketplace page**: five tabs (Swords · Armor · Bows · Horses · Uniques, `AF.marketTab`), one at a time, a
picture card per ware — the image is the ware's own mesh shot by a small offscreen orthographic lens (`afThumb`:
swords/trims via `afBuildSword`, plumes a capsule, horses `buildCavalry` minus the rider, bows off a shared figure's
hand, armour a bust of the shared warrior figure tinted — that one waits for the model), cached in `AF.thumbs` as data
URLs. A card is a try-on; its foot is the price / Buy / Wear / worn / a lock. Text is one short stat line.

**Gear on the warrior figure** (`afDressGear` + `syncModelRigs`): the figure's own sword is the plain iron one; any
other sword (or a blade trim) sets `parts.gearSword` and the BUILT sword (`afBuildSword`) shows in his hand instead —
a falchion looks like a falchion, in the market and in the pit. The sculpted armour is one mesh, tinted by the piece
worn (`AF_LOOK.armor[x].torso`, gold for the champion; rig.json `meshes.armor`). A bought plume rides the head bone
on the helmet's crown (rig.json `plumeY`). The planted home sword follows the loadout too (built swords sink past
their tip and are clipped at the sand plane).

**The captain** (`afPlanTeams` / `afCaptainThink`): each team's NPCs are organised, not a mob. At the
bell the captain reads his roster and draws a formation — guardsmen centre-front, swordsmen and brutes
filling the front rank, duelists on its ends, the archers in their own block `AF_TACT.bowGap` (6) behind the last
rank of swords so they read as a separate line, riders on the wing — and issues orders
through the fight: *form up* (1.6 s), *advance* as a line at a walk toward the enemy, *send the riders
wide* to a flanking mark, *charge* at contact, *regroup* when the line has scattered and the fight is
even, *fall back* a dozen paces to re-form when losing badly (it used to be a long walk to the wall with backs turned — a massacre at legion scale) and charge
again when the enemy comes on or the moment passes, and *press the rout* when winning big. Until the
charge is released a man keeps his place and only fights what reaches him. Humans are never commanded
but see their captain's order in the HUD; the log narrates every shift, on guests too.

**Army-scale mixes**: bigger rosters field proportionally more archers and cavalry, the way a
real army's specialist ranks grow with its size — `afArchWeights(per)` slides the archetype odds
from a skirmish mix (a quarter archers, the rest mostly swords) toward a legion mix (a third archers, a
fifth riders) as `per` climbs toward ~40. Even a small fight fields a visible rank of bowmen (one in
eight was invisible in the press); a 200-a-side legion fields deep ranks of them and real wings of horse.

**Fighters of the vale** (`AF_ARCH`): the NPCs come in six archetypes, each a build (rig, weapon, size),
a body (health, poise, speed, damage) and a temperament. *Swordsman*: sword and shield, the baseline.
*Brute*: a big man with a two-hander — more health and poise, slower, hits harder, loads almost every
swing, never blocks, rarely rolls, never retreats. *Duelist*: lean and quick, no shield — light chains,
rolls rather than blocks, circles, and **feints** (loads, cancels into a guard to bait your roll, then
strikes). *Guardsman*: a heavy shield and a thick hide — keeps his guard up between swings, ripostes
after a lock, and edges toward fellow guardsmen to form a **wall**. *Archer* and *rider* as above. The
host's lobby pre-rolls the mix seat by seat and shows it to everyone; name tags carry the archetype.

**NPC XP** (0–100, `b.xp`, `b.skill = xp/100`). The archetype is a fighter's body; XP is his head.
The brain as first tuned plays at about **90**. XP sets:

* **How early he sees a swing.** Under 45 he never reads a raised arm, only the moving blade. His
  reaction lag runs from 0.42 s at XP 0 to 0.05 s at 100.
* **How often he guards or rolls.** The archetype's odds are scaled by ×0.15 at XP 0 up to ×1.15
  at 100. A green fighter also drops his guard too soon.
* **Whether he spots an opening.** Stagger, flinch, a blade lock or a follow-through: he takes one
  15% of the time at XP 0, rising to 100%, and he is slower to react.
* **The breath between blows.** About 1.3 s for a recruit, down to about 0.2 s for a champion.
* **He reads the chain.** A tapped light can't be seen coming, but the rhythm of a chain can: from XP 45
  a man mid-chain (a light landed, the next tap coming) is an *incoming* like a raised arm, and he blocks
  or rolls for the second and third blow by his archetype's odds. A man reeling, locked on his guard or
  resting after a finisher throws no next blow — that is when he strikes instead.
* **He chains too.** A light that lands on a reeling foe is followed by the next of the same three-blow
  chain with odds rising with XP; the third has the same long follow-through and rest a player's has.
* **He decides when he can.** Reeling, staggered, locked in a blade clash, mid-roll or ridden down, nothing
  is decided (the press used to expire before the hands were free — and the pause after it still ran, which
  is why a champion under a chain of blows swung once in a long while). A guard he raised drops the moment
  he commits to a blow, a cancelled load lets go of the hold, and a light is a *tap* as quick as a player's
  (a 0.06 s hold was three frames slower: every race for the first blow went to the mouse). After a full
  chain of the foe's, a veteran answers with the **heavy** — the guard that meets it breaks. He strikes from
  the edge of reach (the lunge covers the last pace); a recruit walks onto the blade.
* **The brute loads through the jabs.** His heavy is armoured from the first frame of the load
  (`AF_ARCH.brute.armour`): a chain doesn't cancel it, the blow comes anyway.
* **Skill habits.** How much he circles, whether he cracks a raised guard, whether a duelist
  feints, whether a guardsman re-raises his shield, and whether he retreats when hurt.
* **The class rule.** Who carries what is the archetype's `bow` flag (`AF_ARCH`, on the body as `b.canBow`): only
  the **archer** carries a bow, and he carries a sword too (steel when a foe is at his face, the bow again once
  clear). A **swordsman**, brute, duelist, guardsman or **rider** carries no bow at all — `afSetWeapon` refuses the
  swap, the player gets a "no bow" popup, and the SWAP touch button is hidden. An archer who takes a loose horse
  (walk into it — `afMountCheck`) **shoots from the saddle**: the arrow leaves from saddle height, the rider's aim
  twist points it, a draw holds the horse to a canter (no gallop while loading). NPC archers who mount become
  **horse archers** (`afHorseArcher`): they never charge home but ride a ring round their mark `AF_TACT.hbNear`–`hbFar`
  (9–16) out at `hbPace` throttle, loosing across their own line all the way round, opening the ring when a foe
  closes and drawing steel (the cavalry cycle) only when he is at the stirrup.
* **Archers.** The bow is a skill (`AF_BOW`, `afBowSk`): a full draw takes 2.4 s for a recruit and 0.55 s for a
  master (`afDrawSecs`), the arrow wanders by skill, range and how far it was drawn (`afBowScatter` — measured
  at 20 paces on a standing man: a recruit lands about 1 in 16, a middling archer half, the very experienced 4 in 5,
  a master nearly all), a recruit fumbles the nock between shots, and target lead grows with XP (from 60 % of the
  hang time for a recruit to all of it for a master). An under-drawn arrow is weak, and falls short of a far mark.
  **The arrow is LOBBED** (`arrowLob`, shared with the valley battle — 2026-09-16, the user: "Archers are not shooting
  arches. They try to shoot direct all the time"): the loft climbs with the range (8° at the muzzle, 38° at the bow's
  `range`), the launch speed is solved so the arc comes DOWN on the mark, uphill or down, capped by the draw's power
  (`AF_F.bow.speed` × 0.75–1.2), and the same arc is what `afShotBlocker` samples against the stones and the hills.
  A guest replays the arrow under the gravity the event carries (`g`). A player's bow skill is the career's `skills.bow.level` (carried in the gear as `bowLv`,
  `AF_BOW.masterLv` = 6 is a master); the draw meter fills at his own pace. An NPC never looses at a stone: the arc
  is tested before the draw and again at release (`afShotBlocker`, `afArcherLoose`); with no line he sidesteps for
  one, or, holding a place in the line, waits. The aim assist prefers a foe with a clear line.
* **Damage.** A mild factor from ×0.85 to ×1.05.

The lobby's **Foes** row picks the band:

| Band | XP range |
|---|---|
| Green | 8–45 |
| Mixed (default) | 30% recruits 10–35, 35% soldiers 35–60, 22% veterans 60–82, 13% champions 82–98 |
| Veteran | 60–97 |

**Dealing XP: different men, level armies.** For each archetype, the lobby draws one pool of XP
scores for all teams together. The pool is spread across the band, so every class runs from
recruit to champion, and it is dealt out at random. One team's duelists might be XP 20 and 78,
another's 42 and 60. Swaps between teams, always within the same class, then level each team's XP
total, with each class's total as a softer second aim. Small rosters are dealt 24 times and the
fairest deal is kept.

A player's seat counts as XP 70 (`AF_PLAYER_XP`). Whenever seats change, `afBalanceXp` levels
the teams again, so a team with two human players gets weaker NPCs. The team header shows the
result, for example "AZURE avg 52xp". Seats show "51xp soldier", and name tags show
"Lorne · 82xp".

**Fair to the player.** Against a player who holds to load and releases, like a phone player
(`__xptest.js`), 1v1 results are:

| Foe XP | Player wins |
|---|---|
| 15 | 10/10 |
| 35 | 10/10 |
| 55 | 7/10 |
| 75 | 6/10 |
| 90 | 2/10 |
| 100 | 0/10 |

These rules make that possible:

* **An NPC's pause between blows starts when his swing ends.** The end of a swing used to reset it
  to 0.04 s, which made a machine-gun of jabs.
* **Heavy armour.** A blow loaded past the heavy windup rides through a light hit; you take the
  wound, but your swing still lands.
* **A player is the hero.** Players get ×1.6 poise (a whole chain chips well under half of it) and a 0.78 s
  stagger instead of 1.2 s.
* **One blade at a time.** Only one NPC under XP 60 actively presses a player; the others circle
  and wait for an opening.

**Organised armies, not a mob** — the fixes below turn a 50-a-side clash from three accidental
skirmishes into one continuous front:
- **A real block, not one giant thread** (`afPlanTeams`): the front line used to be a SINGLE rank —
  at 50 a side that's a ~70-unit-wide single file of men, and a line that thin shears into separate
  pockets the instant contact along it goes uneven. It's now files ∝ √N, a few ranks deep — the same
  idiom the world-map armies already muster with — so the line holds together as it closes.
- **A living melee centre and an engagement radius** (`T.center`, `T.engageR`, recomputed by the
  captain every tick): once the charge is on, a man whose nearest foe is well beyond his own side's
  current engagement radius falls back toward his team's centre instead of soloing across the pit
  after one distant straggler — the mechanism that keeps a big battle as ONE fight. Riders get a
  longer leash (cavalry should range) but the same rule.
- **The squadron** (`afFlankPoint`, `afSquadronMarks`): riders flank to a mark 22 paces off the
  enemy's end of the point where the lines will meet (62% of the way from our centre to theirs),
  clamped inside the ring. That point hardly moves. A mark that followed the marching enemy centre
  kept every horse turning to catch up. The mark moves only if the point shifts more than 5
  paces.

  Each rider gets his own place in a line abreast (two ranks past eight, 3.4 paces apart) facing
  the enemy. Many riders were once sent to one single spot. They fought over it, spun there, and
  the "all arrived" check never passed. A rider is `formed` within 2.5 paces and only rides again
  once his place is more than 7 away, so he never fidgets.

  The squadron goes in when the lines meet and 60% of it is formed up, after 6 s of waiting, or
  after 16 s on the flank in any case. An army whose infantry is less than 1.5× its riders doesn't
  flank at all; its horse is the army and charges straight in. Before this, an all-cavalry fight
  deadlocked with both squadrons waiting for infantry that didn't exist.
- **Cavalry is a cycle** (`b.cav`), not a dogfight:
  1. *charge*: full tilt at the mark with a little lead.
  2. *out*: ride through and past, holding the line of the charge and cutting at whoever is in
     reach, until nothing is within 6 paces.
  3. *wheel*: one direction round, easing to a canter for the turn; a galloping horse turns at
     ~0.55 rad/s, a 27-pace circle that ends in the wall.
  4. Then charge again.

  A rider always drives along his facing and steers with the reins, so he never brakes to
  pivot. A target that slips inside the turning circle (more than 1.2 rad off, within 9 paces)
  sends him out and round, instead of circling a man he can never reach. This was the "squadron
  spinning together" behaviour. In 40–100-a-side battles, the share of riders spinning slowly on
  the spot fell from ~80% on the flank and ~18% in the charge to 3–8%.
- **The lines meet on foot**: only infantry touching infantry releases the charge — a rider's first
  blow (ours or theirs) used to release the whole army from 150 units out, so the cavalry charged
  alone and was spent before the foot arrived. Cavalry now waits on its flanking mark and goes in
  as the lines meet. A rider bogged down inside a block wheels OUT to regain speed before the next
  pass instead of dying as a slow target in the press.
- **No fight is no fight**: when the lines come apart (no foot-on-foot contact for a few seconds
  with a gap between the masses), the captain dresses ranks where the men stand and marches them
  again as a line. And an isolated man heads for the *enemy's* mass, never his own side's centre —
  walking to our own centre is what turned a lull into two piles spinning at each other.
- **Archers close**: late in a big fight the survivors are mostly bowmen; they used to hold at 22
  and strafe in circles at each other forever. They now close to `bowFar` (22 → the stand-off band
  starts at 11) and strafe less; a bow-only endgame still resolves because the band's near edge is
  inside their own decisive range.
- **Regroup scales with roster size** (`T.regroupSpread`): a fixed 9-unit trigger either never fired
  for a 50-man block or fired constantly; it's now proportional to √(team size).

**The plan (2026-09-16)** — the user: *"if I have a 5v5 it will be almost the same pattern: infantry runs
straight to the middle, cavalry runs to some random place and then attacks the infantry mess, archers
running late, the infantry left over from the middle starts on the archers"*. It was: the captain
computed a doctrine and never used it, every fight was `advance → charge` for both sides (the lines
always met at the dead centre), the riders always rode to a fixed mark 22 paces off the meeting
point (a trip across a small pit, up the middle behind their own foot at a walk) and then wheeled in
a 30-pace circle at the gallop, and nobody answered for the bows. Now (`afPlanTeams`,
`afCaptainThink`, `afAssignTargets`; every number in `AF_TACT`):

- **A doctrine from the matchup** (`afPickDoctrine`): the captain reads both rosters at the bell
  and draws a plan — a weighted roll, so the same lobby opens differently twice. *line*: advance
  and meet. *hold*: the swords stay behind and let the bows kill as much as they can before the
  lines meet (likelier with archers, or weaker foot) — they only fight what reaches them, for as
  long as the bows have someone within `bowVolley` to shoot; once the bows have been idle
  `holdIdle` past `holdSecs` (a stand-off with nobody in range) the stronger side goes to them,
  and with no bows left the foot at `holdOut` is met. *skirmish* (bow-heavy): the archers stand `screenAhead`
  in FRONT of the swords as a screen and fall back through them (`screenback`) when a foe comes
  within `screenIn`. *oblique*: the block angles for one END of the enemy line and refuses the
  other. *rush*: straight in from the bell (the stronger foot, or no bows against bows). *hammer*:
  the foot pins, the horse is sent for the bows or the back of the line. A team with a human in it
  rarely draws a standing plan (his men go with him), and the moment he is blade to blade the line
  charges. Plans and orders are logged ("AZURE means to hold", "CRIMSON sends the riders for the
  bows"), and a human sees his captain's order on the HUD as before.
- **The squadron has a job** (`afPickRiderRole`, `afRiderMark`): *hunt* — form up beside the
  enemy's bows, on the side they lean to, and go into them once the lines meet (or once formed and
  the foot is committed); a hunting rider reads a bowman as thirty paces nearer, and beyond his
  leash he heads for the bows, not the scrum. *flank* — off the end of the enemy line, into its side
  when it is engaged. *trample* — the same mark, but the squadron goes into the enemy's FOOT the
  moment it comes on across the open (closing faster than `trampleApproach` inside `trampleGap`):
  a horse at speed throws men down, and a charging line is caught in the open — a holding line's
  natural partner (they charge under the arrows, the horse rides them down), so `hold` raises it.
  A trampling rider prefers foot to bows. *screen* — beside our own bows, meeting the enemy's
  riders when they come within `screenR` of them (their horse all fallen, it turns to a hunt or a
  flank). *charge* — the
  horse IS the army (foot under 1.5× the riders). Every mark is scaled to the line's width
  (`halfW + huntOff/flankOff`, capped at `flankMax`): a 5-a-side mark sits a dozen paces off, not
  22. The ride to a mark goes ROUND the lines — out through the flank corridor (`T.axis.corridor`)
  and up it at the gallop — never up the middle behind the foot. The wheel brakes INTO the turn
  (throttle 0.3 past 0.8 rad of error): a canter wheels in a few paces where the gallop carved a lap
  of the pit; and the charge only opens up once the horse is lined up on its mark.
- **The bodyguard** (`afGuardTheBows`): a foe within `guardR` of one of our bowmen with no swordsman
  beside him gets the nearest free swordsman (not mid-duel, within `guardReach`) sent for him
  (`b.detail`, `detailSecs`); a horse he can't catch he meets at the bowman's side, between them,
  shield up. A pressed archer now gives ground BEHIND HIS OWN SWORDS (`afArcherRetreat` pulls to
  `bowGap` behind the foot's centre) instead of into open sand.
- **The claim is weighed by the job** (`afAssignTargets`): a swordsman leaves the bows to the horse
  while an enemy line stands (+6) and a galloping horse to itself (+4); a bowman shoots the rider
  bearing down (−6), a man in the open over one already in a scrum with a friend (+5), and the
  wounded; a rider never waits his turn on a victim (he strikes in passing); a bodyguard's detail
  is his mark before anything. Archers walking in with the line loose an approach volley from
  `bowVolley` (a longer draw).
- **The bench** (`perf/arena-tactics.js`): seeded headless fights through the real sim, every man an
  NPC, read for what the tactics did — where the lines met (0.5 = the dead centre), each rider's
  path and time to his first blow and on whom, when the archers opened and who killed them, the
  doctrines drawn, the winner. `--trace seed --rider idx` prints one horse every half second;
  `--gamejs other.js` runs the same seeds through another build; `--smoke` runs the odd lobbies (a
  free-for-all, the pits, all horse, all bows, a standing human, 30 a side). Same 30 seeds, the
  user's 5-a-side (a swordsman, guardsman, brute, archer and rider each), before → after:

  | | before | after |
  |---|---|---|
  | where the lines met, spread over 30 fights (0 = the same spot every time) | 0.04 | 0.71 |
  | doctrine pairings seen | 1 (line vs line) | 14 |
  | rider: paces ridden before his first blow / when it landed | 92 / 16.9 s | 76 / 15.0 s |
  | seed 6's hunting rider: first blow | 38.5 s (a lap of the pit) | 12 s |
  | fights that ran to the 120 s clock | 5 / 30 | 0 / 30 |
  | mean fight length | 69.8 s | 48.4 s |
  | archers felled / of them by horse | 50 of 60 / 41 | 43 of 60 / 29 |

  With the patient hold and the ride-down (same seeds): one side or both hold in 14 of 30 fights,
  the horse draws *trample* in 12 of 60 squadrons, the archers loose 6.5 arrows each (5.4 before,
  6.0 in the old always-advance fights), and every fight still resolves inside the clock.

  The bows are still what every horse is for — they die to riders, on both sides, by design; the
  leftover-infantry mop-up is met by the bodyguard in the fights where a free swordsman is left
  (5 of 6 seeds detail one), which at five a side is not many. An 8-a-side (two bows, two riders)
  reads the same way. The world-map battles (`BATTLES.md`, `warHostThink`) are a separate brain and
  are not touched by this.

**Perf at scale**: `afSepFrom` (called once per NPC, every tick) and `afSeparate` were both true
O(n²) full scans — fine at a dozen fighters, a real cost at hundreds. Both now use a shared spatial
grid rebuilt once per tick (`afRebuildGrid`, the same idiom the world-map battle sim already uses),
turning the per-tick cost roughly linear. A 200-a-side legion (400 bodies) ticks in ~7ms.

**Big fights**: a team musters as a rank-and-file block (`afSlotOffset`), the pit grows to fit the
roster (`afPitFor`), the clock doubles, and above 24 bodies only the humans wear the hero dressing
and name tags show only up close, so a hundred fighters stay cheap (about 1 ms of sim per tick).

**The gallop and the ride-down**: hold a horse at the top of its canter (about 10) and after a second
it finds another gear — a surge to 15, with a GALLOP cue and a wider turn. The hooves keep time with
the ground (stride rate follows speed, ~2.4 strides a second at a run), and a horse at speed goes
*through* men on foot: each is thrown to the side of the horse's line and knocked flat for a second or
so (`downT`), and costs the horse only a little way — a deep block still stops it eventually. A friend
is shouldered aside, not ridden down. A guardsman bracing his shield toward the horse is the one thing
that stops it dead (BRACED). A horse at speed is never shoved back by the man it hits.

**The roll** (`afRollPose`): a dodge is a full tumble along its heading — over the shoulder for a sideways
roll, head over heels forward or back — tucked into a ball and pivoted about its middle, the feet swinging over
and landing on the far side. It never changes your facing. A player rolls the way he asks: C takes the direction he is
moving, Q / E force a side; on touch a **double-tap of JUMP** (2026-09-16 — the stick's own double-tap-and-push is gone:
the stick only runs, so a hurried thumb never tumbles you by accident) rolls the way the stick leans, or as C does with
the stick at rest. The first tap of JUMP waits `JUMP_DBL_MS` 280 ms before it leaps, since the sim refuses a roll to a
man in the air; the second tap inside that window is the roll instead. The heading goes over the wire as a world angle
(`locIn.rollDir`, null = the way you move) so host and guest agree.
NPCs always roll to a side, away from the danger (a roll along their line of advance would carry them onto the
blade). The heading relative to the facing (`rollRel`) rides the snapshot's move slot for state 7 so guests
draw the same tumble.

**Riding controls** (players): on horseback the stick is the reins. Left and right turn the horse,
up and down set the pace (A/D and W/S on a keyboard); it no longer points the horse at a spot on
the screen. The right side of the screen (the mouse on desktop) aims the **rider**: his shoulders
twist up to ±1.25 rad in the saddle and his head takes the rest. Cuts and arrows go where he is
turned (`afAimOf`, up to ±2 rad off the horse's line), so you can gallop past a man and cut to the
flank. Aim assist bends the rider's cut, never the horse's line. After 0.9 s without aiming, the
camera settles back behind the horse.

Your own horse turns at 2.4 rad/s standing and about 1 rad/s at a gallop. A guest's input carries
`st`/`th` (reins) and `hy`, the horse's heading, which the host adopts. A horse's heading is
steered, not aimed, so without this the two copies drifted apart. Snapshots carry each rider's
twist (row[9]), so other players see riders turn in the saddle. NPC riders now look at their mark
and cut to either flank as they pass.

**Horses are their own creatures** (`AF.horses`, `afNewHorse`). Every horse has its own health
(`AF_HORSE.hp` 100), shown as a small tan bar under its rider's. A blow at a mounted man finds the
horse 60% of the time (arrows 50%, another rider's blow 25%; `afBlowHitsHorse`), for 90% of its
damage. What happens then:

* **The horse is cut down** (`afKillHorse`): the rider is *thrown*, `afDismount(b, thrown)`. He
  swaps to a foot rig beside the horse, goes flat for 1.4 s, then gets up and fights on foot with
  his own health untouched. A player sees THROWN. The horse crumples on its side and the pit
  takes it after 14 s.
* **The man dies in the saddle**: `afKill` dismounts him first, so the corpse is a man on the sand
  and the horse is left **loose**.
* **A loose horse** (`afStepHorse`) shies from fighting: it trots away from any fighting men
  within 8 paces (swinging, loading, staggered, or a horse at speed), and from any crowd of four
  or more, keeping off the wall. Otherwise it ambles to a random spot every few seconds, stands,
  and drops its head to graze. A lone man walking up does not scare it, so it can be caught.
* **Anyone can take it** (`afMountCheck`, `afMount`): a man on foot within 1.9 paces swings into
  the saddle — a player just walks into a loose horse; an NPC has to have chosen it. NPCs on foot
  with no foe within 7 paces go for a loose horse within 16 (`b.wantHorse`). A captured horse
  keeps its old team's saddle cloth. Two seconds of `mountCd` after a dismount stop a man
  re-mounting the horse that just threw him.

Rigs are swapped in place (`buildHumanoid` on foot, a 0.88-scale rider seated with `saddleRider`
in the horse's group); each body remembers its palette and dressing (`b.pal`, `b.rigOpts`).
Over the net the host is the authority: snapshots carry a horse row per horse
(`[id, x, z, yaw, hp, riderIdx, dead]`) and the guest mirrors mounts, dismounts and deaths from
it, so even the guest's own body is thrown or seated on the host's word; `hhit` and `horse`
events carry the sparks, the banner and the log line.

**Hitting a horse**: a mounted man is checked against the nearest point of the *horse* (a
2.6-pace body along its facing, `afHitPoint`), so a cut at the head or the rump connects as well
as one at the saddle; arrows use the same test. A horse at speed still rides a foot man down
before he can swing — catch it standing, or cut as it passes.

**The bow is hold-and-release only.** A tap never looses an arrow, and a draw let go inside
0.12 s is lowered without a shot. Taps never queue a follow-up on a bow (a tap in the bow's
follow-through used to queue the *sword* combo, so an archer swung his bow like a blade), and
`afStartAttack` on a bow looses instead of swinging.

**Spectating** (`AF.spec`): when your fighter falls, or you have no fighter, a bar appears —
◀ name ▶ · Free · − +. ◀ ▶ (or the arrow keys) put the camera on any living fighter's
shoulder, players first; it settles behind him unless you drag to look round; wheel or − +
zooms in to 3.5 paces. On death the camera picks the nearest fellow after the banner. *Free*
(or F) is a free camera that starts where the last fighter stood: WASD or the stick glide it
across the sand, drag turns it, and it zooms right down to the ground. The watched fighter
falling hands you the free camera where he fell.

**Being ridden down takes a good hit.** A horse floors a man on foot only near the gallop (speed
above 70% of its top) *and* square on (within 0.75 paces of its line — its own chest width). A
cantering horse, or a clip off the shoulder at speed, only shoves: a flinch, a step sideways,
3–8 damage, and he keeps his feet. (A walk past the line used to floor everyone in reach.)

**The character look** is documented in `CHARACTERS.md`: the faceted knight (domed Y-visor helm,
square pauldrons, hero-chunk proportions), the brass Vale crescent on every helm, the lit visor,
brass trim, the Vale mark on tabard, cape and shield, the big left shoulder.

**Horsemen** (`afRide`): a rider steers, he does not strafe — the stick's forward component is the
throttle along the facing, momentum is dragged onto the facing (hooves grip), and the yaw rate collapses
as speed grows (a galloping horse carves a wide arc, `MOUNT`). Top speed is 1.9× a man's, the reach is
longer from the saddle, a blow at full tilt lands harder, and a horse at speed **tramples** foot
soldiers in its path. NPC riders charge, strike in passing, ride through and wheel for another pass (the cycle above);
foot soldiers roll clear of a charge. A rider's dodge is a spur.

**On foot: the run builds, and the leap** (2026-09-14, `AF_F.run` / `AF_F.jump`, `afDrive`'s movement branch,
`afJump` / `afAirPose` / `afTackle`, `afIntegrate`): a body no longer goes from a stand to full speed in a third of
a second. `run01` climbs while the stick is held forward along the facing (`up` 1.4 s) and falls when it isn't
(`down` 0.45 s, twice as fast on a reversal); the stride is `lerp(jog 0.62, top 1.05)` of `move` on a smoothstep of
it, and at full stride the push in `afDrive` and the drag in `afIntegrate` both scale by `1 − inertia·run01` — the
same terminal speed, a slower response (0.14 s → 0.47 s), so a sprinter slides half a stride to a stop and swings
wide through a turn. A hit, a stagger, a clash or being ridden down zero it. The leap (`I.jump`, Space / the JUMP
button — on touch a single tap, held 280 ms for the double-tap that is the roll — edge-triggered like the roll and carried on the wire) needs both feet on the ground and no blow in hand:
`v` 6.6 up under `g` 18 (a ~1.2-unit hop, 0.73 s), nothing steers in the air and there is no ground to drag on, so
you fly where you left it. A standing hop draws the knees up and lands on bent knees (`land` 0.22 s, no load allowed); a RUNNING leap (2026-09-15) is a **dive** — the body pitches head-first about the hips (`diveAng` 1.15 rad by mid-flight, the 'dive' pose flings both arms open, legs trail) and lands in a **roll** over the shoulder along the line of flight (`roll` 0.5 s, `afRollPose`, state code 16) and comes up through the crouch. **The jump attack** (`b.airAtk`): a tap or a press in the first `atkBy` 0.4 s of any leap turns it into an overhead blow instead — no dive, no tackle; the blade coils over the head on the way up (windupHeavy) and comes down with the body at `strikeY` 0.5 on the way down as a HEAVY at full weight (it cracks a raised guard) with `atkReach` 0.6 more reach; the landing is hard (landT × 1.6) with a breath before the next blow. State code 17 (move slot 1 once the blade has come down). `afTackle` (host,
in the air): with `leapSp` ≥ `tackleAt` × move behind the leap, the nearest foe within `tackleR` and not behind you — and the men within `knot` 1.6 of him, up to `men` 3 (a knot of soldiers goes down under you) —
takes 5–14 damage and the trample's `downT` (1–1.5 s) plus a shove along your line; your own speed is cut to 30 %
and the landing is half again as long. The press ignores a man in the air (`afShove`), which is how he comes down
ON a man. Remote bodies play the leap from state code 14 on their own clock (`afApplyRemotePose`) — it is always the
same arc. NPCs never jump (yet).

**The shield charge** (`AF_F.rush`, afDrive's movement branch, `afRushHit` / `afRushEnd`): block held at `at` 0.85 of
the stride (forward, along the line, feet on the ground, `stam` in hand) starts `rushT`; the stride is kept (× `speed`)
instead of the guard's walk, `straight` still climbs, the legs run a little low (`walkLegs` crouch 0.12), the shield
comes UP before the face with the head tucked behind it and the sword hand cocked back (`POSES.charge` — not the sprint's
head-first lean: the back stays up, the shield shoulder leads, afCommit), the stamina drain doubles. Every host tick `afRushHit` looks
`reach` ahead in a `cone`: square on (within 0.75 of the line) a man on foot takes 8–16 and the trample's `downT`
(1–1.4 s) with a shove along the line ("RUN DOWN"); a man blocking toward you takes half through `afDamage`'s heavy on a
raised guard (GUARD BREAK, on his feet); off the line he is only shouldered (a third, a flinch, a shove); a friend is
pushed aside. A mounted man square on with his horse under `horseAt` 0.55: the horse takes 6–14 and the rider is thrown
(`afDismount` thrown, "UNHORSED") and the charge is spent; a horse faster than that is a wall (you lose half your speed
into it) — and if it is cantering, `afRide`'s trample has you. Each man costs 30 % of the speed; after `men` (2), a horse,
a dropped guard, a slack stick, a cut across the line, a wall, the wind, `max` 1.8 s or `after` 0.35 s past the last man hit (a lone man ends it; a second right behind him goes down too) the charge ends — with a stumble
of `rec` 0.4 s (`landT`: half speed, no load) if it landed on anyone. State code 15 carries it to guests. NPCs: a
shield-bearer at full stride with 5–12 m to cover holds his guard up (`holdBlock`) and comes on — the same charge — with a
chance that grows with skill; and a man sees a charge coming as he sees a horse: veterans roll clear (the horse-charge
reaction in afThink now reads `rushT` too).

**Auto-turn** (`afAutoTurn`): after a swing or a roll, if a foe is at your elbow but not in front of
you, the camera eases onto him — on a phone the thumb can't chase a man who slipped behind you. It
yields the moment you move the aim yourself.

**Blade locks**: a light blow into a raised guard is a *clash* — steel bites steel with a white flare,
both fighters freeze for a beat, then shove apart, the attacker further and reeling (his swing is
spent and he is open for a riposte; the NPC brain punishes exactly that window).

**Steel on steel, the shield's side, the bare head** (2026-09-16, the user: "if a sword comes to another sword it
should stop, that's like another guard. Even if we don't guard, if a sword hits our shield we shouldn't get damage. If I
get a sword to my naked head that's big damage, it should make me fall"). All three live in `afDamage`, tuned in `AF_F`:

* **A blade out in front is a guard.** A man whose own swing is in its wind, its strike or the first `steel.after` (0.10 s)
  of the follow-through meets a blow from the front (facing > 0.15) as a raised guard would: a light is a *blade lock*
  (`PARRY` — both swings spent, both men in the clash, no wound), a heavy *beats a light aside* (`BEATEN`: the guard-break
  stagger, half damage), heavy on heavy locks. A light thrown at a man in a **heavy's** wind is parried and the heavy comes
  on — the heavier steel wins, as it does against a guard. Not an arrow (it flies past a blade), not on a staggered man,
  not from the saddle, not with a bow or a sheathed sword. Event `b: 4`; a parry sets the riposte window like a block.
* **The shield is on his arm whether he guards or not.** A blow from his LEFT flank — its side component past
  `shield.side` (0.5) of the way round from his front and not from behind him (`shield.behind`, −0.25) — rings on the
  shield: no wound, a clang, `shield`. A light glances off; a heavy drives the shield into him (half the knock, a flinch of
  `shield.heavyFlinch` 0.3 s, his load lost). Only while he stands: a staggered or floored man's shield hangs, and a brute
  (`noShield`) or a man with his bow out has none. Event `b: 3`. (The rig: `makeArm(1)` is the left arm at local +x, so the
  side is `ax·cos yaw − az·sin yaw` — the same expression as `hitSide`.)
* **A raised shield stops a light whole**: `blockMul` 0.15 → 0. The heavy's guard break and the bash are the answers to a
  wall, not a trickle.
* **The bare head.** An OVERHEAD cut — the chain's third blow (the chop, `atk.move` 2) or any heavy — that lands
  unblocked on a man with NO HELM ON (`afBareHead`: none in his look, or the one he owns still in his hand during the
  don) is a blow to the skull: `head.mul` 1.7 × the wound and he is **floored** (the trample's `downT`, `head.down`
  1.1 s light / 1.5 s heavy, `HEAD`), his load, guard and chain gone. A side slash is not a head blow. Not a bash, a
  tackle or a charge (no `from.atk`); a rider's blow finds the horse first as before. The don matters: a slow walk in
  and the first chop finds your naked head; a helm is a marketplace item. Event `hd: 1` (the guest shows `HEAD` and the
  pose row carries the fall). Test: `BV.arenaBare(idx, off)` takes a fighter's helm off / puts it on (if he owns one) and
  reports `bare`; `BV.arenaSwing(idx, heavy)` throws an instant swing (set `b.combo = 2` first for the chop).

**Cloth**: the cape is a chain of five hinged panels (`afCape`); each hinge is a damped spring
chasing a target set by its parent, pushed out by the air flowing past a running body, tugged by a
gust, never folding through the back — it hangs, flares on a sprint, streams behind a roll and
ripples as it settles.

**Hour and weather** (lobby: *Hour* day / dusk / night, *Sky* clear / rain — the host picks, every
client builds the same): dusk drops the sun to the rim in orange and lights every torch; night is
lit by the torches under a starfield; rain overcasts the sky, closes the fog, wets the sand (specular
floor) and falls as streaks around the camera (`afApplyTime`, `afStepWeather`).

**The ground** (lobby: *Ground* sand / hills / rocks / broken — the host picks, every client deals the
same pit from the seed; `afGenTerrain`): **hills** are smooth mounds and long low ridges the ground
mesh rises over — a run uphill drags and a slope gives a little downhill (`afIntegrate`), arrows fall
short of a crest, an archer on one shoots over his own line, and the camera never sinks into a hill
behind you (`afCamAboveGround`). **Rocks** are boulders, outcrops (a big stone with fallen ones about
it) and standing crags twice a man's height: collision circles that fighters, horses and arrows
respect (`afRockPush`, `afRockAt`) and that the NPCs steer round instead of pushing against
(`afSteerRocks` / `afAvoidRocks`; a formation slot or flank mark that lands on a stone is moved to
its edge, `afFreePoint`). **Broken** deals both plus *tors* — knolls crowned with rock and ridges
with a spine of stones along the crest. Nothing is placed on a team's muster ground or in the
corridor its column marches down from the gate (`afMusterZones`). The stones are each their own
jittered icosahedron with vertex colours (lit crown, mossy foot, scree round the base,
`afBuildRocks`); the ground colours dry scrub up the slopes and bare stone on a crest, and takes a
finer mesh when there are hills.

**The crowd** (`afStepCrowd`): the spectators shuffle in their seats, leap and **roar** when someone
falls (louder for your kills and your death — the roar is synthesised, a swell of band-passed noise,
`afRoar`), cheer the bell, and every half-minute or so the wave goes round the stands.

### The arena menu (2026-09-14 redesign)

Every screen outside the fight is the shell in `index.html` (`#start`): the fighter on the left,
the page on the right, Back always in the same place. The 2026-09-14 redesign (Claude Design
"Blade Vale - Arena Menu", phone landscape 844×390) gave it one look — gold-foil Cinzel titles,
Oswald labels, blood-red FIGHT, cards on a dark plum ground — and turned the **home** into a HUD
round the fighter: `#start.home` lays the shell's own preview under the whole screen and
`#page-home` over it as a grid. The name card sits top-left; the rank bar (`afHomeHud`: counts up,
"+N XP" pops when it grew) and the purse along the top; the bout of the day (name, sand, a clock to
midnight UTC, where you stand on the board — FIGHT IT goes straight into the sand, the card opens
the page) and the rival down the left; FIGHT (who is online, else the vale's men), the three doors
with a reason on each (wares you can afford, places moved since last time, uniques held) and the
achievement nearest to done down the right; his kit as chips along the bottom (a tap opens that
stall of the market). The market cards carry a rarity tier (`tier-common/rare/epic/legend` from the
catalogue's rank lock; a unique is legendary and shimmers), the ladder and the day's board put
the top three on a podium (`top1..3`), the hall shows a unique you lack as a locked "?", and the
career sheet draws the road to Legend (`.rank-road`). `BV.homeHud()` returns what the HUD says.
Bigger screens zoom the home grid (1.25× from 1100×620, 1.5× from 1500×820).

### The career: XP, gold, ranks, the marketplace

Signed-in accounts keep an **arena career** on the server (`server/arena.js`, table
`arena_careers`, catalogue shared by both sides in `arena-items.js`). Without an account the pit
lends plain gear (iron sword, hunting bow, courser) and pays nothing.

* **Start**: a wooden sword (damage ×0.8) and nothing else. No bow or horse until you buy one; the
  lobby's Bow / Horse buttons are locked until you do.
* **Two currencies**: XP ranks you and unlocks the top gear; gold buys from the marketplace.
* **Ranks** (`ARENA_RANKS`): Rookie 0 · Fighter 150 · Veteran 500 · Champion 1200 · Master 2500 ·
  Legend 5000 XP. The rank shows on your seat, your name tag and the career sheet.
* **The payout** (`rewardFor`): base = 6 × enemyPower^0.6, where enemyPower is what your team faced
  (each NPC 0.6 + XP/100, each player 1.3, summed at the bell). A win ×1.5, a loss ×0.6, a draw ×1;
  plus 4 XP / 3 gold per kill and damage/50 XP, damage/80 gold. The **★ star of the match** — the
  best fighter in the pit, players and NPCs alike, by kills×100 + damage + 150 if still standing —
  earns ×1.6. Trophies: a win adds 1 + √enemyPower/3; a loss takes none. A 2v2 green skirmish
  pays a star winner ~32 XP / 24 gold; a 50-a-side legion ~240 XP.
* **Reporting**: the host (or a solo fighter) POSTs `/arena/result` once — `{seed, winner,
  players:[{handle, team, kills, dmg, alive, star, enemyPower, skills}]}` — and the server pays every
  account in it, idempotently per `(seed, account)`. Guests poll `/arena/career?seed=` until their
  reward lands. The end panel shows the purse.
* **PvP purse**: when real players lose to real players, each loser pays 8% of his gold (cap 60)
  into a pot split among the winning players. No item theft.
* **Loot on a win**: 25% a purse of 10–40 gold; 5% a **unique** (plumes, blade tints) — a look and
  at most +2% damage, never a stat that decides fights.
* **Marketplace** (`afMarketOpen`): swords, armor, bows, horses; every item has a gold price and a
  rank lock, and the top of each class also needs a **use-skill** level (sword hits, arrow hits, ten-
  second stretches in the saddle; level = √(count/5)): Master's sword needs sword 4, Warbow bow 3,
  Warhorse riding 3. Buying equips at once; you can wear another owned piece or take armor/bow/
  horse off.
* **What gear does**: sword damage ×0.8–1.32 and reach; armor +15–90 health, +5–25 poise, −5/6%
  speed at the top; bow damage ×1.0–1.32 (arrows carry `bowDmg`); horse health 80–170 and pace
  ×0.9–1.1. The loadout rides in the roster (`gear` per player), so every client builds the same
  fighter; a wooden sword is brown, a tinted blade shows its tint.
* **You see what you wear** (`AF_LOOK`, `afDressGear`): no armor is a padded jack in the team cloth
  with no pauldrons; leather, mail, plate and the champion's gold-trimmed harness recolour the
  breastplate and pauldrons (plate and above add a gorget); swords change blade colour and length
  (wood is brown and short, the master's has a gold hilt; a unique tint wins); bows grow and darken;
  a nag is small, a warhorse big. The same dressing runs in the pit and in the **fighter preview**
  pinned to the left of the marketplace for the whole visit — a turning 3D figure on its own
  renderer (`afPreviewEl` / `afPreviewSet`) filling the pane, the purse floating over the top and
  the try-on strip over the bottom, while the wares scroll on the right. Drag to turn him; "In
  the saddle" when a horse is owned. **Tap any card to try it on** (`AF.tryItem`): the figure
  wears it, nothing is bought, and the strip shows the price with a Buy (or the lock reason) and
  "What I own" to take it off. Trying a bow draws it; trying a horse seats him.
* **Armor, bows and horses are built too.** The padded jack is quilted in darker rows; leather
  adds a baldric and studs; brigandine a rivet grid over red cloth with dark sleeves; mail a coif
  and mail sleeves; plate a gorget, arm plates and tassets; the champion's plate gold pauldron
  rims, gorget and helm crest; **Dragon plate** (Legend, 7000 g, sword skill 5: +110 health, +30
  poise, −8% speed) black steel with red trim, spiked pauldrons and crest. Bows: the longbow and
  warbow take a leather grip wrap, the warbow gold tips, the **Horn recurve** (Champion, 3500 g,
  bow skill 4, ×1.4) pale horn with turned-back tips. Horses: the nag is dull-coated with a
  drooping, thin neck; the destrier wears a caparison in the team cloth; the warhorse a caparison,
  a steel chamfron and crinet plates on the neck. NPCs roll these by XP like everything else
  (brigandine or plate at 60–82, dragon plate for some 95+, recurves for 90+ archers).
* **The shield is strapped, not gripped**: it rides the left *elbow* group (`makeShield`), turned so
  the forearm runs across its back with the point down, and whenever a shield shows the animator
  twists the left elbow (`elbowL.rotation.z = −90°`) so the forearm lies across the chest — the
  face to the foe, the fist at the shield's inner edge — while the pose's own elbow flex only
  tilts it (level in guard, raised for a block). It used to hang off the fist by an imaginary
  centre grip, face-up like a tray.
* **The bow is built around the grip** (`makeBow`): the arc's middle sits at the hand, the string
  joins the tips 0.6 behind (it used to run through the hand), and the group is turned so that in
  the aim pose the limbs stand up and the belly faces the target. (Rotating the old, off-centre
  bow put it over the archer's head.)
* **The grip is real**: the sword is spun 90° about its blade (`rotation.y` in `makeSword` /
  `afBuildSword`) so the edge faces the foe and the crossguard stands vertical to the wrist — it
  used to sit flat like a display piece — and the bow is held edge-on to the target with the string
  toward the archer, not flat like a shield. A curved blade's sweep therefore runs up toward the
  enemy. This is the base rig, so the world's fighters hold them the same way.
* **Swords are built, not recoloured** (`AF_LOOK.sword`, `afBuildSword`): each item is a
  silhouette — straight, a curve of stacked slabs (falchion, scimitar, Black Night), a zigzag
  flamberge (Serpent flamberge, Ember blade), a thin cup-hilted rapier (Needle), a broad
  cleaver with an upswept nose, a greatsword with a fuller (Doomsword, Sun-forged blade), a
  serrated edge (Frost fang) — with gold hilts and glowing (emissive) steel for the rare ones.
  The marketplace's sword row runs Wooden 0 g → Iron 120 → Falchion 250 → Steel 400 →
  Needle 550 (reach +0.28) → Cleaver 600 → Blade of the Vale 1200 → Dune scimitar 1400 →
  Serpent flamberge 1600 → Doomsword 2400 (Champion, reach +0.3, −3% speed) → Master's 3000 →
  Sun-forged 6000 (Legend, sword skill 5, ×1.4). Ember blade, Frost fang and Black Night are
  loot-only unique swords (×1.12).
* **NPCs dress by XP** (`afNpcGear`, rolled from the roster seed so every client builds the same
  man): a recruit under 25 carries wood or iron in cloth; 25–45 iron or a falchion in leather;
  45–60 steel, a cleaver or a Needle in mail; 60–82 the Blade of the Vale, a scimitar or a
  flamberge in plate; 82+ a Doomsword or Master's sword in the champion's plate; 95+ may carry a
  Sun-forged blade or one of the unique blades. Brutes swing cleavers and Doomswords; archers'
  bows and riders' horses climb the same way. NPC gear is worth `AF_NPC_GEAR_K` = 60% of a
  player's stats (the sword now carries the XP damage step), so the XP difficulty curve keeps
  its shape. Champions' name tags name their blade.
* **The record**: fights, wins, kills, deaths, damage, stars, trophies and achievements (first
  blood, 10/50/200/500 kills, 1/10/50/100 fights, 5/25/100 wins, stars, trophies) on the career
  sheet.

Not built yet from the design note: daily/weekly quests, a seasonal battle pass, trophy-based
matchmaking. Guests' loadouts are trusted as sent (sanitised against the catalogue, not verified
against their account) — fine for the beta.

### Profiles and the ladder

Every fighter who has stood in a pit has a page you can visit — players **and the vale's own men**.
An NPC's identity is his name: the lobby draws from a fixed pool (`GIVEN_NAMES` × `BYNAMES`), so
Bram is the same Bram fight after fight, and his record grows like anyone's.

* **Storage**: players in `arena_careers` (+ a `renown` column), NPCs in `npc_careers` (name,
  last archetype, `archs_json` tally, last lobby skill, xp, matches, wins, kills, deaths, damage,
  stars), and `arena_bouts` — one row per fighter per fight (`seed, kind, fighter`) that feeds a
  profile's recent fights, the network ladder and the NPC payout's idempotency. Schema in
  `worker/schema.sql` (D1, applied by hand) and `server/migrations/016_arena_profiles.sql` (Node).
* **The report** (`afReportResult`) now carries `npcs: [{name, team, kills, dmg, alive, star,
  arch, skill, enemyPower}]` next to `players`; the server (`applyNpcs`) pays NPCs XP by the same
  `rewardFor` (no gold — they have no purse) and writes their record in chunks of 40.
* **Renown** (`renownOf` in `arena-items.js`, one formula for both kinds) is what the ladder sorts by:
  XP + 25 a win + 5 a loss + 60 a star of the match + 3 a kill + 6 a trophy + 30 a use-skill level +
  damage/100. Stored on every save; the **position** (#N of M) is `COUNT(renown > yours) + 1` among
  fighters with at least one match — players rank among players, NPCs among NPCs (they stand in
  every pit, so one list would be all NPCs).
* **API** (public reads, before the sign-in gate): `GET /arena/profile?name=&kind=player|npc` (kind
  optional — a player first, then an NPC; `COLLATE NOCASE`) → `{profile}` with the record, skills /
  loadout / achievements (players) or archetype tally (NPCs), `position`, `of` and the last ten
  bouts — never gold or the inventory. `GET /arena/rankings?kind=player|npc&scope=global|network&limit=&offset=`
  → `{rows:[{pos, name, kind, title, renown, matches, wins, stars, kills}], total}`; `network` needs a
  signed-in reader and is everyone who shared a seed with you in `arena_bouts`. Your own
  `/arena/career` carries `renown`, `position`, `of` as well (the name card shows `#N`).
* **Client**: shell pages `profile` (`afProfileOpen(name, kind)` / `afProfileRender`; the figure on
  the left is *that* fighter — a player's `equipped`, an NPC in `afNpcGear` seeded from his name,
  in the crimson cloth) and `ladder` (`afLadderOpen(scope, kind)`: Players / The vale's men ×
  Global / Your network, 50 a page, you highlighted). **Every name is a link**: `afProfLink(body |
  name, kind)` renders `<span class="prof-link" data-prof="kind|name">` — the end panel, the
  victory board, the lobby's seats and online list, the career sheet ("Your public profile"), the
  ladder rows — and one capturing click handler in `afWireHome` routes `[data-prof]`,
  `[data-act="ladder…"]` and `[data-act="career"]`. From the pit the page opens over the fight (Back = ← Fight).
* **The vale's men fight among themselves** (`arena-sim.js`, shared by both backends): the Worker's
  cron (`wrangler.jsonc` triggers, every 15 min → `scheduled` → `simulateRound`) and the Node server's
  timer stage one or two bouts with no player in them — a roster from the NPC name pool (`NPC_GIVEN` ×
  `NPC_BYNAMES` in `arena-items.js`, about six seats in ten to men who already have a record, so the
  same Bram carries on), archetypes and skills rolled, and the outcome from a small strength model
  (team power ∝ Σ arch × (0.55 + skill/100) × noise, winner by power³, losers all fall, a share of the
  winners with them, every fallen man credited to an enemy, the star by the client's own score). It is
  paid through `applyNpcs` like a reported fight, so the NPC ladder lives whether anyone is online.
  Seeded (`sim-<ms>-<i>-<hex>`), so a seed replays. Local: `wrangler dev --test-scheduled` and
  `curl http://127.0.0.1:8790/__scheduled`; Node: `arena.simulateRound(n)`.
* **Links you can share**: `#profile/<kind>/<name>` and `#rankings` open the page at boot
  (`SHELL.bootHash` — the first page shown strips the hash; `afProfileOpen`/`afLadderOpen` set it
  with `replaceState`, leaving them clears it). Test hooks: `BV.profile(name, kind)`, `BV.ladder(scope, kind)`.

### The hooks: what makes a fight feel like something happened (2026-09-14)

Eleven small systems that pull on the same few levers — anticipation, a variable reward, competence feedback, a goal
gradient, social comparison, collection, novelty, stakes — without a timer, a streak penalty or a loot box (see
`ROADMAP.md` → *We Will NOT Do*). All of it rides on the existing payout; the client sends a little more in the
report (`bests`, `killedBy`, `wager`, `daily`) and the server answers with a richer `reward`.

* **Callouts in the pit** (`afCallout`, a stack under the banner): FIRST BLOOD, DOUBLE / TRIPLE / RAMPAGE (kills
  within 12 s of each other — `afKillHooks`), RIPOSTE (a blow that lands within 1.4 s of your block — `riposteAt` in
  `afDamage`, mirrored for guests from the `hit` event), COMEBACK (a kill under a quarter health), LAST MAN STANDING.
  Each one lifts the crowd (`afCrowdReact`). YOU FELL names who felled you.
* **The near-miss line** (`afNearMiss`) under the result: how close it was — the last man's health, how long you
  lasted, who will be back.
* **The staged reveal** (`afRevealStart`): the purse comes one line at a time — XP ticks up into the rank bar (from
  `reward.xpBefore`), the gold drops, "the crowd decides…" spins the unique names for a second and a half before the
  loot lands, then the bests, the rival, the belt, whom you passed, the bout of the day, the achievements. A tap on
  the box shows it all. A **Share** button (`afShare`) uses the phone's share sheet, else the clipboard.
* **Loot pity** (`uniqueChance` in arena-items.js): a unique is 5% on a win and the odds climb with every win that
  rolled none (`meta.pity`), certain at `PITY_AT` = 20. The reveal shows the odds for the next win.
* **Personal bests** (`ARENA_BESTS`: kills, damage, longest life, biggest blow, kill streak — `meta.bests`): the
  client reports life / blow / streak; a beaten record is a line on the reveal and a tile in the hall.
* **The rival** (`meta.rival`): the vale's man who felled you in a lost fight. He takes the first empty seat against
  you in your next lobby fight (`afStartFight`, `entry.rival`), the lobby says so, and a win in a fight he stands in
  pays `rivalBonus` (+40 XP +30 gold, plus half his skill) and settles the score (`rivalsBeaten`).
* **The champion's belt** (`arena_belt`, one row): players only. Taken on a win by whoever has more renown than the
  holder; every win while holding it is a defense. The ladder badges the holder, the profile and the home say so.
* **Whom you passed** (`reward.passed`): the highest-renown player you overtook this fight, and how many.
* **The wager** (`WAGERS` = 0 / 25 / 50 / 100 / 200, a lobby row for signed-in hosts, carried in the `lobby` and
  `go` messages): every signed-in player in the pit stakes it, never past what he has at payout. Win: the stake and
  as much again. Lose: the stake. Draw: nothing.
* **The bout of the day** (`dailyOf(day)` in arena-items.js, `arena_daily`, `GET /arena/daily`): one fight for the
  whole vale — the seed, pit, hour, sky, ground and foes come from the UTC date, the men are rolled from it too
  (`L.mixSeed` = the seed, names from `seed ^ 0x9e3779b9`), so everyone faces the same lot. Solo, no lobby. Each try
  reports as its own fight (`AF.reportSeed` = `d<day>-<seed>-<try>`) and pays normally; the board keeps your best
  (`dailyScore` = 100 a kill + damage + 150 alive + 300 a win) and resets at midnight. Buttons on the title and the
  home carry today's name.
* **The hall of trophies** (`afHallRender`, page `hall`): the belt, the rival, the bests, every unique lit or dim
  with the odds, every achievement with the road to it (`statOf`), the daily record.
* **Since you were away** (`afHomeNews`, `bv-seen-<handle>` in localStorage): after half an hour away the home
  says what moved — climbed or passed on the ladder, the belt lost, the rival beaten — and always the belt, the
  rival and the XP to the next rank.

Storage: one `meta_json` blob on `arena_careers` (bests, rival, pity, rivalsBeaten, dailies, dailyTops, belts —
`metaOf`), `arena_belt`, `arena_daily`. Achievements now check `statOf(career, stat)` so the new ones (scores settled,
bouts of the day, the belt, streaks) read the blob. Test hooks: `BV.arenaFell(idx)` (I fell the man at idx —
streaks, first blood), `BV.callout()`, `BV.reveal()`, `BV.nearMiss()`, `BV.daily()`, `BV.dailyStart()`,
`BV.hall()`, `BV.homeNews()`.

### Network model

Host-authoritative over the `/coop` relay. The host runs the sim and broadcasts a snapshot
(`{k:'snap'}`: per body position, yaw, hp, animation state code, plus `hit` / `kill` / `arrow`
events) at 30 Hz in a small room (≤ 12 bodies) and 20 Hz above. Guests send their input record
at the same rate (`{k:'in'}`, addressed to the host alone), drive their **own** body locally
so movement never waits for the round trip (reconciled against the host's truth), and
interpolate everyone else. Every client builds the identical pit from the shared `seed` + roster
in the `{k:'go'}` message, so bodies are addressed by roster index. If a guest leaves for good, an
NPC takes over their fighter; if the host leaves, the fight ends for everyone.

**Phones drop their socket** whenever the player switches apps, locks the screen or changes
network, so the arena survives it instead of treating a drop as leaving:

* **The start is acknowledged.** Each guest answers the `go` with `{k:'go-ack', seed}`. The host
  re-sends the `go` to that guest alone every 1.5 s, then every 5 s after the first minute, for as
  long as they hold a seat. A duplicate `go` for the running fight is just re-acked. This fixed the
  first real two-phone test, where the invited player never saw the fight start.
* **The relay holds the seat** (`server/ws.js`). A socket that dies without a `leave` keeps its room
  membership for 25 s. The host hears `peer-away` (the guests hear `host-away`) instead of
  `peer-leave` / `host-gone`. While a guest is away, their fighter fights on its own (AI).
* **Reconnects resume.** `net-battle.js` remembers `coop.lastRoom` and puts `resume: room` in the
  reconnect `hello`. The relay matches the account and hands the seat to the new socket
  (`resumed`). The host hears `peer-rejoin {oldId, id}` and remaps every roster entry, body and
  input to the new id. The resumed guest then sends `{k:'lobby-req'}` or `{k:'rejoin', seed}`, and
  the host answers with the lobby, the `go` they missed, or the final `over`. If the old socket is
  still listed, it is told `superseded` and closed.
* **Dead links are noticed.** The relay pings every socket and sends `{t:'beat'}` every 10 s, and
  it reaps sockets that have been silent for 35 s (ghost connections used to pile up in `who`). The
  client drops its own socket after 25 s without a message, or on returning to the tab after
  12 s of silence, then reconnects at once.
* A seat not reclaimed within the grace period is released for real: `peer-leave` (the fighter
  becomes an NPC) or `host-gone`. A player who stays offline for 45 s falls back to the menu, or
  to a solo fight if they were the host.

Caveat: the host runs the simulation, so if the **host's** phone backgrounds the page, the browser
throttles it and the fight freezes for everyone until they come back.

**The wire** (the 2026-09-13 smoothing pass — `AF_NET` in `game.js`; all of it client-side, nothing
new on the relay):

* **Sub-stepped sim.** `afSubstep` never lets the host's sim take a step longer than 1/60 s: a
  dropped frame becomes several steps, not a slower fight (the frame dt is clamped at 0.1 s). The
  host's own hit-stop no longer slows the shared sim (guests used to see the world freeze on every
  blow the host landed); his shake, kick and FOV punch stay.
* **Button edges go out at once.** A press, release, roll or swap is sent the frame it happens
  (`afNetTick` compares a signature of the buttons); only the sticks wait for the tick.
* **Interpolation buffer.** Every remote body keeps its last rows with the host's time (`b.buf`).
  Guests estimate the host's clock (`afRenderTime`: the offset is held at the least-delayed row and
  let down slowly) and draw each body `delay` in the past between two rows (`afInterp`), where
  `delay` = 1.5 row intervals + 2 × jitter, grown while rows keep arriving too late
  (`n.extra`), and longer for a body that comes at half rate (`b.rowDt`, a running minimum of
  its gaps, eased into `b.dly`). Past the newest row a body carries its speed on for 150 ms, then
  holds. Nothing chases the latest row any more, so bunched packets no longer rubber-band.
* **Reconciliation with a memory.** The host's word on a guest's own position is a round trip old,
  so it is held against the closest point of the guest's recent path (`n.hist`) inside a jitter
  window around that moment, not against where he is now (a running man used to be dragged back a
  stride on every row). If he was ever there, nothing is corrected; a disagreement under 4 m is
  eased out a quarter per row; one past 4 m that lasts 150 ms snaps him over.
* **Predicted blows.** A guest's swing runs the host's reach-and-cone test locally against the men
  as drawn (`afPredictStrike`): sparks, the clang or the thud, hit-stop and the kick play at once,
  and a foe drawn blocking gets a clang. The host's `hit` event is matched to it (`afPredicted`)
  so only the damage number is news; a blow the host never confirms within 0.6 s counts as a miss
  in the readout (`pred ok/all`).
* **Lean snapshots.** Rows are 7 numbers (8 for a rider); kills and the weapon in hand ride a
  separate `m` list only when they change, with a full refresh every 2 s for late joiners; a dead
  man gets one row when he falls, then only the refresh; above 16 bodies the NPC rank and file go
  out on alternate snaps (10 Hz), the men with a player behind them every time. A 9-a-side fight
  sends 4–10 rows per snap instead of 18.
* **The readout.** Guests ping the host once a second; the open HUD sheet (tap the card / Tab)
  shows round trip, jitter, snaps per second, bytes in, the host's sim rate, the delay, predicted
  blows and the local frame rate; the host sees his sim rate, guests and bytes out. The **net
  readout** box on the home page (localStorage `bv-net`) pins the same line bottom-right during
  fights; `BV.net()` returns the numbers. (No URL flags for settings: they live on the home page.)

What this pass did **not** do, and why: binary frames (JSON rows are ~1.5× the bytes, not the
bottleneck), a Durable Object per room, WebRTC or a dedicated sim server — those cost money or
weeks; see the measurements first. Loose horses still use the old lerp toward the latest row.

A guest in a **headset** (`VR.md`) sends `{k:'vrhit', i, w, heavy}` when his blade touches a man — the host checks reach and a per-target cooldown and lands it as his blow — and his `{k:'in'}` carries `px, pz` (where his head walked him), believed within three units. The entrance and the end-game films play in the headset too: the same shot lists, `afIntroCam` / `afOutroCam` placing the rig instead of the camera (`vrFilmCam` — a cut turns the rig so the subject is where the player looks; within a shot the rig only glides).

Lobby messages (`{k:'lobby'}` host→guests, `{k:'team'}` / `{k:'weapon'}` guest→host,
`{k:'invite-declined'}` via `dm`) ride the same room.

### Stamina (2026-09-14)
The user: "we should also have stamina — when we run, swing sword, draw arrows it should go lower and you need to catch
a breath sometimes." Every body carries `stam` / `maxStam` (`AF_F.stam`, 100). The FULL STRIDE spends it (the jog is free;
the stride past 0.4 costs up to 11/s), a drawn bow spends 7/s while it is held, a light swing 7, a heavy 16, an arrow 4, a
roll 14, a leap 12 — whether or not the blow lands. Standing refills 12/s, walking 7/s, nothing while a blow, a load, a
roll or a leap is in progress; plate slows the refill (`stamRegen` from the gear's speed penalty: −22 % speed is a third off
the breath). At zero a man is WINDED (a popup for you, the body bent double and panting — afCommit's breath deepens and
quickens as the wind goes): he walks at 0.6, can't roll, leap or coil a heavy (the load caps under `heavyAt`), and his
blows land soft (`afStamMul`: ×0.65 at empty, full again above 30 %). He is winded until `recover` (35) is back, a touch
faster than the normal refill. The vale's men: `afAiSwing` refuses a swing under `aiRest` (22) — he covers up (`holdBlock`)
and breathes, the opening a patient foe waits for. The HUD shows a gold bar under your health (red when winded).
`BV.arenaStatus().stam / .winded` read yours. Guests predict their own stamina from their own inputs like the rest of
their body; the host's copy decides the damage. Not yet on the headset's panel.

### Tuning

`AF_F` in `game.js` is the whole feel table: hp, speed, reach, light/heavy/bow timings and
damage, block multiplier, guard-break stun, poise (max/chip/regen/stagger/execute), knockback
impulses, acceleration/friction/lunge, dodge duration/speed/i-frames, pit radius, time limit. The
camera juice uses the game's shared `FEEL` numbers.

### Debug hooks

```
BV.arena({ teams: 3, per: 2, start: true })   // open the lobby (optionally start at once)
BV.arenaStatus()                              // phase, roster, every body's hp/state/position
BV.arenaStep(steps, dt)                       // headless sim ticks (no render)
BV.arenaOutro(cmd)                            // the end-game film: read / jump to shot n / { advance } / 'skip'
BV.arenaPump(frames, dt)                      // whole frames incl. network + camera, without rAF
BV.arenaInput({ atk: n })                     // poke the local input record
BV.arena({ xp: 'green', npcXp, arch })       // test overrides: XP band, per-seat XP, one archetype for all
BV.arenaAutoMe(xp)                            // hand my fighter to the brain (pure NPC battles)
BV.arenaTactics()                             // the captains' plans and orders, every man's mark / cavalry cycle / bodyguard detail, shots, kills, who felled whom
BV.arenaMix([[...team 0 archetypes], [...]]) // deal the NPC seats' classes by hand before arenaStart (the tactics bench uses it)
BV.arenaHorses() / BV.arenaHorseHit(id, dmg)  // every horse's state; wound one (test the throw)
BV.arenaKill(idx)                             // fell a man (his horse goes loose)
BV.arenaInvite(name) / BV.arenaAccept()       // send / accept a challenge without the UI
BV.arenaNet()                                 // socket id, room, lobby seats, roster peers, go-acks
BV.net()                                      // the wire: rtt, jit, snapHz, rxHz/txHz, hostHz, delay, extra, pred*, hist, clk (the settings page's 'net readout' box pins the line on screen)
coop._drop()                                  // kill the socket as a phone would (it reconnects and resumes)
```

## Running it, and opening it to the world

One process serves everything — the page, the `/api/v1` routes and the `/coop` relay — on one port, from the repo:

    cd ~/Documents/GitHub/blade-vale && node server/index.js

Open http://localhost:8787 (or the Mac's LAN address, port 8787, on a phone). The database is `server/play.db`
(accounts, careers, worlds; `BV_DB=` overrides; `BV_PORT=` the port). The server does not hot-reload: restart it
after a server-side change. The client uses the page's own origin for the API and the relay when the page came
from the game server or something in front of it (no port, or 8787); a plain static dev server on 8099/8102 still
talks to `:8787` next door.

Without buying a server: keep the Mac awake and put a free tunnel in front of that one port —

    brew install cloudflared
    cloudflared tunnel --url http://localhost:8787

prints a public `https://…trycloudflare.com` address that carries the page, the API and the websocket relay.
The address changes every run; a free Cloudflare account plus a domain you own gives a fixed one (`cloudflared
tunnel create …`). Anything that reaches that address reaches the Mac, so keep the play DB backed up.

