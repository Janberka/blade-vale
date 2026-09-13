# Blade Vale VR — first-person arena fighting on an Oculus Rift

Status: PLAN ONLY (2026-09-12). Nothing below is built. Decision taken: skip the spectator-only
mode and go straight to first-person fighting, behind a `?vr` flag, Arena Fights only.

## 0. What we have to work with

- three.js **r128**, global `THREE` build (`vendor/three.min.js`). r128 ships WebXR: `renderer.xr`,
  `renderer.xr.getController(i)` / `getControllerGrip(i)`, `select`/`squeeze` events, and
  `session.inputSources[i].gamepad` for sticks and buttons. No upgrade needed; do NOT upgrade three
  for this (20k lines on the global API).
- Arena Fights is an **input-driven, host-authoritative sim**. Every fighter is a body in
  `AF.bodies`; the local one is `AF.me`; the keyboard/touch layer only fills `AF.locIn`
  (`mx, mz, yaw, atk, heavy, dodge, block, hold, swap`) in `afReadLocalInput` (game.js:19353).
  `afDrive` consumes that input; timed swings resolve in `afStrike` (game.js:18764), which does a
  reach + cone test and calls `afDamage` (game.js:18777) — the single place blocks, guard breaks,
  poise, stagger, knockback, splats, popups, career ledger and net events all happen.
- Camera: `afCamera` (game.js:19704) writes `camera.position` / `lookAt` every frame, plus shake,
  kick and FOV punch from `afJuice`. Countdown does a big sweep shot; the entrance cinematic
  (`afIntroStart`) has its own shot list.
- Post: `AF_POST` bloom path renders to offscreen targets (`afPostRender`, game.js:19838).
- HUD, banners, log, combo, countdown are all DOM.
- Loop: `loop(now)` → `afFrame(now, noRaf)`; `afFrame` already has a `noRaf` argument, so it can be
  driven by `renderer.setAnimationLoop` unchanged.
- The rig already has a **shield on the left forearm** and a sword in the right hand
  (`makeShield`, game.js:758). Head is `parts.headPivot`.

## 1. Hardware and runtime (do this first, it gates everything)

1. **A Windows PC is required.** The Rift (CV1 or S) has no macOS runtime. Install the Oculus PC
   app, plug the headset in, and in Oculus app → Settings → General set Oculus as the **active
   OpenXR runtime**. If the app refuses the headset (Meta has been winding Rift support down), the
   fallback is a Quest over Link, or the Quest's own browser.
2. **Browser:** Chrome or Edge on that PC. Both expose WebXR through OpenXR with no flags.
3. **Secure context:** WebXR only works on `https://` or `localhost`. Options, simplest first:
   - run the static server and the `:8787` API on the Windows PC itself and open `http://localhost`;
   - or a self-signed https static server on the Mac and accept the cert on the PC;
   - the LAN IP over plain http will NOT work.
4. **Dev without the headset:** the "Immersive Web Emulator" Chrome extension on the Mac fakes a
   headset and two controllers, enough to develop everything below. Real-headset sessions are for
   feel and comfort tuning only.

## 2. Phases

### Phase 1 — XR foundation (`?vr`)  ~1 day
- `VR_ON = /[?&]vr\b/.test(location.search)`.
- `renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor')`.
- Inline an "Enter VR" button (three's VRButton is ~80 lines; we use the global build so copy it in).
- Replace the rAF chain with `renderer.setAnimationLoop(loop)` when VR_ON. `afFrame` gets
  `noRaf = true`. Other modes keep rAF (they are not VR targets).
- A `VR.rig = new THREE.Group()` that owns the camera. While presenting, nothing else may touch
  `camera.position / rotation / fov` — three overwrites them from the headset each frame.
- Turn off while presenting: `AF_POST`, `addShake` / `addKick` / `addFovPunch` (never shake a VR
  camera), pixel-ratio changes, `setSize` on resize (XR owns the framebuffer).
- Quality: force the `low` shadow tier and `renderer.xr.setFramebufferScaleFactor(0.9)`; the
  colosseum + shader crowd is the perf risk at 90 Hz × 2 eyes. Measure on the PC before tuning.

### Phase 2 — first-person body  ~1 day
- Skip the entrance cinematic in VR (`AF.introOff = true`) and the countdown sweep; you stand in the
  body from the first frame. Countdown numbers become a sprite in front of the head.
- Each frame: `rig.position.set(me.x, afY(me.x, me.z), me.z)`. The rig's yaw is only changed by
  snap turns; the **body yaw follows the head**: `me.yaw = I.yaw = rigYaw + headYaw`, so
  `afAimOf`, the block facing test in `afDamage`, and AI targeting all keep working untouched.
- Hide `parts.headPivot` and both arms on the local body; keep torso and legs so looking down shows
  your own body. Detach the sword and shield meshes from the rig and parent them to
  `renderer.xr.getControllerGrip(1)` (sword) and `getControllerGrip(0)` (shield), with a fixed
  offset so the blade sits along the Touch controller's natural pointing axis.
- Never set `I.atk / I.hold`, so the sim never plays a timed swing on this body.

### Phase 3 — physical combat  ~2–3 days
- **Blade tracking:** each frame take hilt and tip world positions; tip speed = displacement / dt
  smoothed over ~4 frames. A swing is `tipSpeed > SWING_MIN` (start at 3.5 m/s, tune on hardware).
  Load `k = clamp((tipSpeed - 3.5) / 6, 0, 1)`; `heavy = k > 0.6`. This maps a fast, committed
  swing onto the sim's existing light → heavy scale.
- **Hit test:** blade segment vs each enemy capsule (centre from `afHitPoint`, radius ~0.45 × scale,
  y from 0.4 to 2.0 × scale). On overlap during a swing, and if that target has not been hit in
  the last 0.45 s, call `afDamage(o, dmg, me, heavy, exec, false, k)` with the same damage formula
  `afStrike` uses (`AF_F.light/heavy.dmg`, combo, `dmgMul`, execute on stagger). One helper,
  `vrStrike`, mirrors `afStrike` minus the reach/cone test. Nothing downstream changes: blocks,
  clashes, poise, splats, popups, ledger and the `hit` net event all come for free.
- **Guard:** `I.block = true` when the shield controller is between chest and eye height, within
  ~60° of the head yaw, and forward of the shoulders. The existing `facing > 0.15` test in
  `afDamage` then decides whether a blow is stopped. Later: a physical parry — if the sword
  segment crosses the attacker's blade line during their strike window, treat it as a block with a
  clang and a haptic pulse.
- **Dodge:** A/X button sets `I.dodge` for iframes, but the VR body does not somersault: it
  sidesteps (a 1.2 m lateral impulse over 0.2 s). Rolling the camera is the fastest way to make
  someone sick.
- **AI awareness:** `afThink` reads a target's `atk` / `charge` to decide when to guard or step in.
  A physical swing has neither, so set `me.vrSwing = { t, k }` while the blade is fast and patch
  the two or three reads in `afThink` to treat it like a charge. Otherwise NPCs never block you.
- **Scope out of v1:** bow (archer class), horses. Force `arch = 'swordsman'` in VR.

### Phase 4 — locomotion, comfort, HUD  ~2 days
- Left stick → `I.mx / I.mz` relative to head yaw (same maths as `afReadLocalInput`). The sim's
  speed, separation, wall and rock steering all apply, so you cannot walk through anyone.
- Right stick → 30° snap turn on the rig. No smooth turning by default.
- **Involuntary motion:** knockback (`t.vx/vz` in `afDamage`) and the blade-lock shove move the
  rig. Halve `AF_F.knock` for the VR body and fade a vignette (a black inverted sphere on the
  camera) whenever the rig moves faster than the stick asked for. Hit-stop is fine; it does not
  move the head.
- **HUD in-scene:** a canvas-texture panel on the shield hand (hp, poise, timer, fighters left) and
  a head-locked sprite for banners (`afBanner` → sprite when VR_ON). The DOM HUD, log and combo are
  left as they are for the desktop mirror window.
- Haptics: `gamepad.hapticActuators[0].pulse()` on hit, block, and guard break.

### Phase 5 — networked fights  ~2–3 days (after solo is fun)
- v1 works for **host or solo** only, because `afDamage` is a sim-side call. A guest body is a
  snapshot mirror (`afApplySnap`), so a guest in VR has to send a `vrhit` message
  `{ i: targetIdx, k }` and the host validates range and applies the damage.
- Others should see your sword move: add optional hand transforms (two pos+quat) to the snapshot
  for VR bodies and IK the rig's arms to them on remote clients.

### Phase 6 — polish, in order of payoff
1. Two-bone arm IK so the local body's arms reach the controllers (looking down at stubs is ugly).
2. Blade trails on fast swings (`updateTrails` exists), sparks at the contact point.
3. Sword-on-sword parry as above; shield bash on a fast shield push.
4. Archer class: two-hand draw (grip both, pull back, release) feeding the existing arrow sim.
5. Performance pass: crowd LOD, arcade instancing, foveated scale.
6. Quest native path: same code, its browser is already WebXR; only the https rule matters.

## 3. Test hooks (keep the existing style)
- `BV.vr = { rig, head, hands }` and `BV.vrPose(handIdx, pos, quat)` to inject controller poses so
  the blade tracker and hit test can be exercised headless with `BV.arenaStep`.
- A `?vr&sim` mode that plays back a recorded swing to verify damage numbers match `afStrike`.

## 4. Risks
- **Hardware availability**: Rift on the Oculus PC app is the single biggest unknown; verify on
  day one before writing code.
- **Comfort**: knockback, clashes and the countdown/intro cameras are all head-movers. Every one of
  them has an entry above; none may ship to the headset untouched.
- **Balance**: a physical swing has no wind-up the AI can read, and can hit every frame. The
  per-target cooldown, the speed floor and the `vrSwing` hint to `afThink` are what keep it honest.
- **Perf**: r128 has no foveation control worth much; if the colosseum cannot hold 90 Hz, the pits
  venue (small, dark, fewer bodies) is the launch venue for VR.

## 5. Estimate
Playable solo fight vs NPCs (phases 1–4): about two weeks with headset time most days.
Networked VR (phase 5): another week. Everything hinges on step 1 of section 1.
