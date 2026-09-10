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
3. In the lobby: **Teams** (2–6), **Fighters per team** (1–50; « » step by ten), what **you ride in with** (sword, bow, or a horse — everyone carries sword and bow), the **Pit** (cosy / wide / vast / colossal — it grows by itself to fit a big roster), **Hour** (day / dusk / night) and **Sky** (clear / rain).
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
| Dodge roll (invulnerable for most of the roll) | Space | DODGE |

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
| Socket client | `net-battle.js` — `coop.who / invite / dm`, multiple handlers per event, re-`hello` on reconnect | |

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

**Big fights**: a team musters as a rank-and-file block (`afSlotOffset`), the pit grows to fit the
roster (`afPitFor`), the clock doubles, and above 24 bodies only the humans wear the hero dressing
and name tags show only up close, so a hundred fighters stay cheap (about 1 ms of sim per tick).

**Horsemen** (`afRide`): a rider steers, he does not strafe — the stick's forward component is the
throttle along the facing, momentum is dragged onto the facing (hooves grip), and the yaw rate collapses
as speed grows (a galloping horse carves a wide arc, `MOUNT`). Top speed is 1.9× a man's, the reach is
longer from the saddle, a blow at full tilt lands harder, and a horse at speed **tramples** foot
soldiers in its path. NPC riders charge, strike in passing, ride through and wheel for another pass;
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

### Network model

Host-authoritative over the `/coop` relay. The host runs the sim and broadcasts a 20 Hz snapshot
(`{k:'snap'}`: per body position, yaw, hp, animation state code, plus `hit` / `kill` / `arrow`
events). Guests send their input record at 20 Hz (`{k:'in'}`), drive their **own** body locally
so movement never waits for the round trip (softly corrected toward the host's truth), and
interpolate everyone else. Every client builds the identical pit from the shared `seed` + roster
in the `{k:'go'}` message, so bodies are addressed by roster index. If a guest drops, an NPC
takes over their fighter; if the host leaves, the fight ends for everyone.

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
```
