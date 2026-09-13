# Blade Vale VR — first-person arena fighting on a WebXR headset

Status: **BUILT, v1.2 (2026-09-13) — VR FIRST.** The headset goes on at the title screen and nothing sends you back
to the flat screen: home, **sign-in with an on-panel keyboard**, the **marketplace** (try on, buy, wear, take off),
your **career**, the **rankings**, any fighter's **profile**, the controls, the lobby, a challenge and the end of the
fight are one **panel in the headset** with a laser pointer; your fighter stands beside it in what you own. Guests
fight in VR too (`vrhit`, `px/pz`). Sign-in / sign-out and leaving a pit happen in place (no page reload — a reload
would end the session). Verified end to end against a fake headset (`?xrshim`), host and guest; not yet felt on real
hardware. The original plan (Rift, six phases) is kept at the bottom.

## 1. Try it on a Quest

bladevale.com is https, and the Quest's own browser has WebXR, so nothing is installed:

1. Put the headset on, open the **Browser**, go to `https://bladevale.com` and tap **🥽 Enter VR** — it sits
   bottom-right on every screen, title included. Not signed in? **Sign in / Create account** on the panel: a keyboard
   under the fields, point and squeeze.
2. You stand in a dark hall with a **panel** in front of you: point the right controller at it, squeeze the trigger.
   **Enter the Arena** opens the lobby on the panel — venue, teams, fighters a side, the seats, who is online with an
   Invite button each, Start Fight. A challenge from a friend arrives on the panel too, Accept / Decline.
3. Start (or the host's start, if you were invited): the panel goes, the entrance film and the countdown sweep are
   skipped, and you are standing in your fighter. The **pits** venue is the safest first try — small, dark, few bodies.
4. At the bell the panel comes back with the result, the purse when it lands, the standings, **Rematch** (host) and
   **Leave the pit** — which tears the pit down in place and puts you back in the hall, headset still on.
5. The headset's own system gesture ends the session at any point; the flat screen carries on from the same state.

A PC headset works the same way from Chrome/Edge on Windows with the Oculus/SteamVR OpenXR runtime
active, at `https://bladevale.com` (or `http://localhost:8787` from the node server; a LAN IP over plain
http will NOT expose WebXR).

**Not yet true:** a guest's blade seen moving by the others, the market's picture cards (the panel lists wares as
rows; the try-on shows on the figure beside the panel), the string pulled back on the bow as you draw.

## 2. How it plays

| You do | The sim sees |
| --- | --- |
| look somewhere | the body faces that way (`I.yaw` = head yaw; `afAimOf`, the block facing test and the AI read it unchanged) |
| step in the room | the body moves the same way (`me.x/z` follow the head; walls, rocks and the press push back) |
| left stick | walk, relative to where you look (`I.mx / I.mz`, the sim's speed and steering apply) |
| right stick left/right | 30° snap turn (no smooth turning) |
| right stick up/down | tilt the blade in your fist (saved on the device, `bv-vr-sword`) |
| A / X | roll (`I.dodge`, the sim's i-frames; the head is never rolled) |
| Y / B | sword ↔ bow (an archer only: the class rule from the lobby, `afSetWeapon`; through `I.swap`, so a guest's host swaps too) |
| the bow (`vrBow`): squeeze the right trigger with the string hand near the bow hand, pull back, let go | a draw — its weight is how far the hands came apart (`VR_BOWT`); the arrow flies from the string hand toward the bow hand through `afShoot` (aim assist and the archer's own scatter); a guest sends `vrshot` and the host shoots for him |
| ride in on a horse (the lobby's class row) | the sim's `afRide` with the head as the reins (the horse turns toward where you look, the left stick is the pace); the rig sits `VR_BOWT.saddle` higher; a real step does not move a mounted man |
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

### The menus in the headset (`VR MENUS` in game.js, after the VR section)

- **One panel, every page.** `vrMenuPage()` reads the same state the DOM shows: a fight that is over → `end`; no
  fight and `AF.invite` → `invite`; `VRM.signin` → `signin`; `AF.lobby` → `lobby`; `SHELL.page` market / career /
  ladder / profile / help → that page; else `home`. During a fight the panel is hidden. The sub-pages are opened
  through the DOM's own functions (`afMarketOpen`, `afLadderOpen`, `afProfileOpen`, `afShellPage('career')`) and
  read their data where the DOM does (`AF.career`, `LADDER`, `AF.profile`, `ARENA_CAT`); Back is `afShellBack`.
- **Sign-in in place.** `client-net.js`: `net.login / register(u, p, stay)` and `net.logout(stay)` — with `stay`
  the session (and the player token) change in place instead of reloading the page; `vrSignedIn` then runs what
  the reload used to: the auth gate, the home, presence on the war-net, the career. The keyboard is `VRM_KEYS`
  (digits, letters, `- _ . @`), shift, space, backspace, next/done.
- **Your fighter in the hall** (`vrHallFigure`): built like the market's preview (`buildHumanoid` →
  `afWearModel` → `afDressGear`) from `afPreviewGear()` (what you own, with the piece you are trying on), or a
  profile's `gear`; half size, because the hall is in the player's metres; rebuilt when the gear changes.
  `vrMenuDraw()` paints the page on a 1024×768 canvas (`vrPanel`, 1.28 × 0.96 m in the rig's metres, so it is the
  same size in the hall and in the pit) at 12 Hz; every button is a rect in `VRM.items` with an action name.
- **The pointer.** A line down the right controller's ray space (`VR.ray.right`), a dot where it meets the panel
  (`THREE.Raycaster` against the panel mesh, the hit's `uv`), trigger (`buttons[0]`) edge = click →
  `vrMenuAct(act)`, which calls exactly what the DOM buttons call: `afOpenLobby('host')`, `afSetVenue`,
  the teams / per bump, `afInvite(name)`, `afStartFight`, `afShellBack` (leave lobby), `afAcceptInvite` /
  `afDeclineInvite`, `afRematch`, and `vrLeavePit`.
- **Placement.** `vrMenuPlace()` puts the panel 1.5 m in front of the eyes at eye height, facing you, from the
  first real head pose (before it the head sits on the floor); it comes round again after a snap turn or when you
  look more than ~60° away.
- **The hall.** Outside a fight the scene's boot-time clutter is hidden (as `afBoot` does at the first bell), the
  background goes dark and `VRM.hall` — a floor disc and a torch-coloured light — is shown; the rig stands at the
  origin. A fight hides the hall; `vrLeavePit` shows it again.
- **Leaving without a reload.** `afLeaveToMenu` reloads the page, and a reload ends the XR session, so while
  presenting `afLeaveToMenu` itself calls `vrLeavePit`, which tears the pit down in place: `coop.leave()`, `afClear()`, the arena flags reset, the shell back on
  home / title, the crowd bed silenced, the hall back.
- **The class row on the panel's lobby page** (sword / bow / horse, locked until owned, hidden in the pits) calls
  `afLobbyWeapon`, the same function the DOM's buttons call; the bow hangs on the left grip next to the shield
  (`VR_BOW.pre` turns makeBow's hand-frame rotation into the grip's), `afSetWeapon` shows one or the other.
- **Guests.** The Enter VR button no longer hides for guests. A guest's `vrBlade` runs like the host's, but
  `vrStrike` sends `{k:'vrhit', i, w, heavy}` instead of calling `afDamage`; the host (`afOnFightMsg`) checks the
  guest's body is his and alive, the target is a living foe within `VR_T.reach` + a stride, and a per-target
  cooldown (`VR_T.hitCd`), then lands it as the guest's blow — the hit event brings the popup, sparks and haptics
  back. A VR guest's `{k:'in'}` also carries `px, pz` (where the head walked him); the host believes it within
  three units, and the guest's own body skips the snapshot's soft correction (only a real disagreement snaps).
- **Hooks.** `BV.vrMenu()` reads the panel (page, visible, items, pointer uv); `BV.vrMenu('start')` presses a
  button by name; `BV.VRM` is the live state.

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
5. Hand transforms in the snapshot so the others see your blade move.
6. The bow: two-hand draw feeding the existing arrow sim.
7. The market's picture cards on the panel; the bow and the horse tried on in the hall.

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
