# Blade Vale VR — first-person arena fighting on a WebXR headset

Status: **BUILT, v1 (2026-09-13)** — solo / host fights, swordsman only. Verified end to end against a fake
headset in the browser (`?xrshim`); not yet felt on real hardware. The original plan (Rift, six phases) is
kept at the bottom; what follows is what exists.

## 1. Try it on a Quest

bladevale.com is https, and the Quest's own browser has WebXR, so nothing is installed:

1. Put the headset on, open the **Browser**, go to `https://bladevale.com`, sign in, **Enter the Arena**.
2. Set up a fight (a solo one vs NPCs is fine; the **pits** venue is the safest first try — small, dark,
   few bodies) and start it.
3. A **🥽 Enter VR** button appears bottom-right once the pit has booted. Tap it. The browser goes
   immersive; the entrance film and the countdown sweep are skipped and you are standing in your fighter.
4. The headset's own system gesture ends the session; the fight carries on on the flat screen from the
   same body.

A PC headset works the same way from Chrome/Edge on Windows with the Oculus/SteamVR OpenXR runtime
active, at `https://bladevale.com` (or `http://localhost:8787` from the node server; a LAN IP over plain
http will NOT expose WebXR).

**Not yet true in v1:** the bow (archers are forced to the sword), horses, joining a friend's fight as a
guest in VR (the button is hidden for guests: hits are a sim-side call, so v1 is host/solo only), the end
panel in-headset (a banner says the fight is over; take the headset off for the results).

## 2. How it plays

| You do | The sim sees |
| --- | --- |
| look somewhere | the body faces that way (`I.yaw` = head yaw; `afAimOf`, the block facing test and the AI read it unchanged) |
| step in the room | the body moves the same way (`me.x/z` follow the head; walls, rocks and the press push back) |
| left stick | walk, relative to where you look (`I.mx / I.mz`, the sim's speed and steering apply) |
| right stick left/right | 30° snap turn (no smooth turning) |
| right stick up/down | tilt the blade in your fist (saved on the device, `bv-vr-sword`) |
| A / X | roll (`I.dodge`, the sim's i-frames; the head is never rolled) |
| stick click | re-measure your eye height |
| swing the sword fast | a strike: tip speed ≥ 3.2 m/s is a swing, ≥ 8.5 m/s a fully loaded one (`k`), heavy from `k ≥ 0.6`; the blade segment is tested against every foe's capsule and lands through `afDamage` with `afStrike`'s damage formula. One hit per target per 0.45 s. |
| hold the shield up | guard: shield hand between chest and eye height, in front of you, within ~60° of where you look — or squeeze the left grip. `I.block` → the usual facing test in `afDamage`. |
| get hit / land a hit | haptics in the hands instead of camera shake |
| get thrown (a roll, a shove, a guard break) | the vignette closes in while the world moves you faster than the stick asked |

The HUD is a head-locked strip under the eyes (teams alive, clock, hp, poise, GUARD) and a head-locked
banner for what `afBanner` says (FIGHT, VICTORY…). NPCs read a fast blade as a swing in the air
(`b.vrSwing` in `afThink`), so they guard and dodge it like a timed one.

## 3. How it is built (game.js, the `VR` section after `const AF`)

- **Scale.** A Vale fighter is ~3.3 units tall; the player is ~1.7 m. The rig — the `THREE.Group` the
  camera and both controllers live in — is scaled by `2.95 / (your eye height from the first pose)`, so the
  player's eyes land on the fighter's. Everything under the rig is authored in metres.
- **Anchoring.** Each frame the rig is placed so the head is exactly on the fighter (`vrAnchor`); before
  the sim the fighter is moved to where the head went (`vrInput`). Snap turns rotate the rig and re-anchor,
  so the head stays put.
- **Body.** `vrDress` hides the rig's head and both arms and hangs the plastic sword and shield on the
  controller grips (`renderer.xr.getControllerGrip`, right = sword, left = shield). Under the warrior
  figure (`wearModelRig`) the head and shoulder *bones* are scaled to nothing and `parts.vrGear` tells
  `syncModelRigs` to show the plastic steel and hide the figure's own. `vrUndress` puts every transform
  back (`userData.vrHome`); it runs on session end and in `afClear`.
- **Blade.** `vrBlade` samples hilt and tip in world space, smooths the tip speed, spawns the blade trail
  while fast, and `vrStrike` runs a segment-vs-capsule test (`vrSegDist`) against foes within 6 units.
- **What is bypassed while presenting:** `afCamera` (and so the shake/kick/FOV punch), `afJuice`
  (haptics instead), `AF_POST` (XR owns the framebuffer), the entrance and end-game films, the resize
  handler, and the rAF chain (`renderer.setAnimationLoop` drives `afFrame(now, true)`).
- **Quality on entry:** shadow map 1024 PCF (restored on exit), framebuffer scale 1.0 (`VR.q`). Nothing
  has been measured on a Quest; if the colosseum cannot hold 72 Hz, lower `VR.q.fbScale`, drop shadows,
  or make the pits the VR venue.
- **Hooks:** `BV.vrEnter()`, `BV.vrExit()`, `BV.vrStatus()`; `BV.VR` is the live state.

## 4. Testing without a headset

`?xrshim` loads `xr-shim.js` (repo root, deliberately not in `tools/build-site.js`'s allowlist, so it
never ships): a fake `navigator.xr` with a two-eyed viewer, two Touch-shaped controllers with
xr-standard gamepads and haptics, enough for three r128's WebXRManager. Poses are read each frame from
`window.XRSHIM` (`head.p/q`, `hands[i].p/q/buttons/axes`, metres). In a hidden tab rAF never fires:
`XRSHIM.tick(t)` runs one XR frame by hand.

A typical check (done 2026-09-13, all passed): `BV.arena({start:true, intro:false})`, `BV.vrEnter()`,
tick; scale ≈ 1.79 for a 1.65 m viewer; sword on the right grip, shield on the left; a hand sweep at
~6 m/s across a foe two units ahead lands 18 (light) / 26 (heavy) through `afDamage` with a right-hand
haptic pulse; the shield raised before the chest sets `me.blocking`; the left stick walks the body; a
right flick snap-turns −30° with the head moving < 6 cm; a 0.5 m real step moves the body 0.5 × scale;
A rolls and the vignette rises; `BV.vrExit()` restores the body, the steel, the camera and the button.
Stereo frames were read back from the canvas and checked as images.

## 5. Next

1. **Hardware feel pass** — the whole reason to own a headset: swing thresholds (`VR_T`), the blade's
   default tilt, the shield's position on the forearm (`VR_SHIELD`), snap angle, vignette strength.
2. Perf on Quest 2/3: measure; crowd LOD and shadow budget if needed.
3. Arm IK so the figure's arms reach the controllers (they are collapsed now; looking down shows chest
   and legs only).
4. Sword-on-sword parry with a clang and both hands buzzing; shield bash.
5. Guests in VR: a `vrhit` message the host validates (range, cooldown) and applies.
6. Hand transforms in the snapshot so the others see your blade move.
7. The bow: two-hand draw feeding the existing arrow sim.
8. The lobby and the end panel in-headset (a laser pointer on a DOM-in-scene panel).

---

## Appendix — the original plan (2026-09-12), for the record

Decision taken: skip the spectator-only mode and go straight to first-person fighting, Arena Fights
only. Phases: (1) XR foundation — `renderer.xr`, an Enter VR button, `setAnimationLoop`, a rig that owns
the camera, everything that moves the camera off; (2) first-person body — rig follows the sim body, body
yaw follows the head, head and arms hidden, sword and shield on the grips; (3) physical combat — blade
tracking, blade-vs-capsule hits through `afDamage`, pose-based guard, a sidestep dodge, `vrSwing` for the
AI; (4) locomotion, comfort, HUD — sticks, snap turn, vignette, in-scene HUD, haptics; (5) networked
fights; (6) polish (IK, trails, parry, bow, perf, Quest). Phases 1–4 are what section 3 describes; 5–6
are section 5. The Rift-on-Windows hardware gate that opened the plan is moot now that bladevale.com is
https: the Quest's browser is the first target.
