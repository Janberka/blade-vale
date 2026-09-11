# Blade Vale — Arena Fights

A second way into the game from the title screen: **⚔ Arena Fights**. You choose how many
teams fight and how many fighters each team has, invite players who are online, and every
seat nobody takes is filled by an NPC fighter. Everyone drops into a walled pit; the last team
standing wins.

Companion docs: `BATTLES.md` (the army-scale battle system this reuses primitives from) and
`BATTLE_CONTROLS.md`.

---

## 1. Playing

1. Sign in (or not — without an account you can still fight NPCs, you just can't invite anyone).
2. Title screen → **⚔ Arena Fights**.
3. In the lobby: **Teams** (2–6), **Fighters per team** (1–200; « » step by ten), what **you ride in with** (sword, bow, or a horse — everyone carries sword and bow), the **Pit** (cosy / wide / vast / colossal — it keeps growing past colossal to fit a legion-sized roster), **Hour** (day / dusk / night) and **Sky** (clear / rain).
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

`?arena` in the URL opens the lobby immediately.

### Controls

| | Desktop | Touch |
|---|---|---|
| Move | WASD | left thumb stick |
| Aim | mouse (click the pit to lock the cursor) | drag the right half of the screen |
| Attack: **hold to load, release to swing** — a tap is a quick light (three chain into a combo), a full hold is a heavy that cracks a raised guard; the bow draws the same way | hold / release left click | hold / release ATK |
| Block (hold; 85% less damage from the front) | Shift or right click | BLOCK |
| Swap sword-and-shield ↔ bow (everyone carries both) | F | SWAP |

On touch, the thumb that holds ATK or BLOCK also aims: press, drag to turn, release to swing where you
face (the other thumb is on the stick, so there is no third finger).
| Roll left / right (invulnerable for most of the roll; you come up still facing your man) | Q / E, or Space toward the side you're moving | ◀ ROLL / ROLL ▶ |

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
flinch, a raised guard eats 85% from the front, a heavy on a guard is a *guard break*, and when
poise runs out the fighter is **staggered** for 1.2 s — any hit on a staggered fighter is an
**execution** (2.2× damage). Arrows only chip poise lightly.

**The NPC brain** is a pack director (`afAssignTargets`, every 0.3 s): each NPC claims a foe,
closest first, a victim accepts at most **two** committed attackers, the overflow spreads to another
foe with a free slot, and only when every duel is full does a man *wait* — circling to a slot in his
mark's rear arc and committing only from behind, where guards can't reach. In a duel (`afThink`) he
closes at a charge and circles near contact, keeps the blade's length between blows, cracks a raised
guard with a heavy or goes around it, **punishes** a foe's follow-through or stagger, rolls away from
heavies, blocks or dodges a seen light by skill, and when badly hurt and outnumbered backs off toward
his team with his guard up. Archers hold range, drift sideways between shots, and shoot a swordsman
who keeps coming even while giving ground.

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
with patches and a trampled middle, a stone ring wall with rope posts, three tiers of timber stands
with a crowd, banner poles in the fighting teams' colours, and torches (lit on the desktop tier).
Pennant strings sag between the poles with little flags in the fighting colours, the sun hangs in
the sky as a soft disc, dust motes drift over the sand, and pebbles and a snapped blade or two lie
about. These renderer settings apply only while the arena runs; leaving the pit reloads the page.

**Post-processing** (`afPostInit` / `afPostRender`, three core only — no addon library): the scene
renders to a target, a bright pass + separable blur at quarter resolution makes a bloom that lifts the
torches, sparks, blade trails and the sun, and a composite adds a vignette, a touch of contrast and
saturation, and a red flush at the edges when you are hit (pulsing when you are near death).

**Camera**: during the countdown the camera sweeps from high over the pit down onto your shoulder,
the lens widens slightly on a run, and the field-fight shake / kick / FOV punch land on your hits.
Strikes use an ease-out-back so the blade whips past the mark and settles; every hit puts a white
impact frame on the victim.

**Loading a blow**: there is one attack input. Pressing raises the blade (the load); past ~0.35 s the arm
coils into the heavy windup; releasing swings with a weight `k` = hold time / `chargeMax`. Damage, reach,
arc, knockback, poise damage, the lunge and the slash arc all scale with `k`; past `heavyAt` the blow is
a heavy (cracks guards, resets the combo). A HUD meter under your fighter shows the load and turns red
at the heavy line. NPCs load their swings the same way, so a long visible hold is a heavy you can roll from.

**The captain** (`afPlanTeams` / `afCaptainThink`): each team's NPCs are organised, not a mob. At the
bell the captain reads his roster and draws a formation — guardsmen centre-front, swordsmen and brutes
filling the front rank, duelists on its ends, archers a rank behind, riders on the wing — and issues orders
through the fight: *form up* (1.6 s), *advance* as a line at a walk toward the enemy, *send the riders
wide* to a flanking mark, *charge* at contact, *regroup* when the line has scattered and the fight is
even, *fall back* a dozen paces to re-form when losing badly (it used to be a long walk to the wall with backs turned — a massacre at legion scale) and charge
again when the enemy comes on or the moment passes, and *press the rout* when winning big. Until the
charge is released a man keeps his place and only fights what reaches him. Humans are never commanded
but see their captain's order in the HUD; the log narrates every shift, on guests too.

**Army-scale mixes**: bigger rosters field proportionally more archers and cavalry, the way a
real army's specialist ranks grow with its size — `afArchWeights(per)` slides the archetype odds
from a skirmish mix (mostly swordsmen) toward a legion mix (a third archers, a quarter riders) as
`per` climbs toward ~40. A tiny duel still rolls mostly swordsmen; a 200-a-side legion fields ranks
of bowmen and real wings of horse.

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
* **Skill habits.** How much he circles, whether he cracks a raised guard, whether a duelist
  feints, whether a guardsman re-raises his shield, and whether he retreats when hurt.
* **Archers.** Aim scatter shrinks and target lead grows with XP.
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
* **A player is the hero.** Players get ×1.6 poise (four jabs to stagger, not three) and a 0.78 s
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
  and strafe in circles at each other forever. They now close to 14 and strafe less.
- **Regroup scales with roster size** (`T.regroupSpread`): a fixed 9-unit trigger either never fired
  for a 50-man block or fired constantly; it's now proportional to √(team size).

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

**The roll** (`afRollPose`): a dodge is a sideways shoulder roll — a full turn about the body's forward axis,
tucked into a ball and pivoted about its middle, the feet swinging over and landing on the far side. It goes
left or right (Q / E, the two touch buttons, or Space toward the side the stick leans) and never changes your
facing. NPCs roll away from the side the danger comes from. The side rides the state code so guests see it.

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

**Auto-turn** (`afAutoTurn`): after a swing or a roll, if a foe is at your elbow but not in front of
you, the camera eases onto him — on a phone the thumb can't chase a man who slipped behind you. It
yields the moment you move the aim yourself.

**Blade locks**: a light blow into a raised guard is a *clash* — steel bites steel with a white flare,
both fighters freeze for a beat, then shove apart, the attacker further and reeling (his swing is
spent and he is open for a riposte; the NPC brain punishes exactly that window).

**Cloth**: the cape is a chain of five hinged panels (`afCape`); each hinge is a damped spring
chasing a target set by its parent, pushed out by the air flowing past a running body, tugged by a
gust, never folding through the back — it hangs, flares on a sprint, streams behind a roll and
ripples as it settles.

**Hour and weather** (lobby: *Hour* day / dusk / night, *Sky* clear / rain — the host picks, every
client builds the same): dusk drops the sun to the rim in orange and lights every torch; night is
lit by the torches under a starfield; rain overcasts the sky, closes the fog, wets the sand (specular
floor) and falls as streaks around the camera (`afApplyTime`, `afStepWeather`).

**The crowd** (`afStepCrowd`): the spectators shuffle in their seats, leap and **roar** when someone
falls (louder for your kills and your death — the roar is synthesised, a swell of band-passed noise,
`afRoar`), cheer the bell, and every half-minute or so the wave goes round the stands.

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

### Network model

Host-authoritative over the `/coop` relay. The host runs the sim and broadcasts a 20 Hz snapshot
(`{k:'snap'}`: per body position, yaw, hp, animation state code, plus `hit` / `kill` / `arrow`
events). Guests send their input record at 20 Hz (`{k:'in'}`), drive their **own** body locally
so movement never waits for the round trip (softly corrected toward the host's truth), and
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

Lobby messages (`{k:'lobby'}` host→guests, `{k:'team'}` / `{k:'weapon'}` guest→host,
`{k:'invite-declined'}` via `dm`) ride the same room.

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
BV.arenaPump(frames, dt)                      // whole frames incl. network + camera, without rAF
BV.arenaInput({ atk: n })                     // poke the local input record
BV.arena({ xp: 'green', npcXp, arch })       // test overrides: XP band, per-seat XP, one archetype for all
BV.arenaAutoMe(xp)                            // hand my fighter to the brain (pure NPC battles)
BV.arenaHorses() / BV.arenaHorseHit(id, dmg)  // every horse's state; wound one (test the throw)
BV.arenaKill(idx)                             // fell a man (his horse goes loose)
BV.arenaInvite(name) / BV.arenaAccept()       // send / accept a challenge without the UI
BV.arenaNet()                                 // socket id, room, lobby seats, roster peers, go-acks
coop._drop()                                  // kill the socket as a phone would (it reconnects and resumes)
```
