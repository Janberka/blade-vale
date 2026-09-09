# Mocap Puppet — sub-project

Webcam body tracking that drives the Blade Vale soldier in real time: stand in
front of your camera and the knight mirrors you — knees, elbows, torso lean,
head turns, squats. Sword and shield stay in hand.

**Deliberately isolated from the game.** Nothing in `game.js`, `index.html` or
the server touches this directory; deleting `mocap/` removes the feature
completely. The soldier model is a hand-synced *copy* of the game's
`buildHumanoid` (see provenance note in `soldier.js`) so the page never loads
the 10k-line game script.

## Run

Serve the repo root (same static server as the game — sync to `/tmp/blade-vale`
and use the `blade-vale` preview on :8099) and open:

- **http://localhost:8099/mocap/** — live webcam (browser will ask for camera)
- **http://localhost:8099/mocap/?demo=1** — no camera needed: a synthetic
  figure waves/squats/head-shakes through the exact same solver pipeline

Everything runs locally: MediaPipe's pose model + wasm are vendored in
`vendor/`, no frames ever leave the machine.

## Controls

| key / control | effect |
|---|---|
| `M` | mirror mode on/off (default ON: your right hand moves the puppet hand on the same side of the screen) |
| `C` | calibrate head — look straight at the screen, press, that becomes the neutral neck |
| `D` | toggle demo pose |
| smooth slider | landmark EMA responsiveness (right = snappy, left = floaty) |
| drag / wheel | orbit / zoom the 3D camera |

## How it works

```
getUserMedia video
  -> PoseLandmarker.detectForVideo (33 world landmarks, meters, hip-centered)
  -> EMA smoothing (mocap.js)
  -> solvePose (retarget.js): landmarks -> local joint quaternions
  -> soldier rig pivots (soldier.js): shoulders, elbows, hips, knees, waist, neck
  -> ground clamp: lowest sole planted so squats read as squats
```

`retarget.js` is the heart and is **dependency-free** (own vec3/quat lib): per
bone it takes the landmark direction, expresses it in the solved parent frame,
and applies the minimal rotation from the rig's rest direction. That makes the
joint chain reproduce every bone direction exactly (twist along a bone is
unconstrained — invisible on capsule limbs). The root takes yaw only; lean
lives in the waist pivot, so the puppet stays planted.

Low-visibility limb groups (out of frame) hold their last pose instead of
glitching. Head orientation comes from the ear axis + nose, with the anatomical
nose-below-ears pitch cancelled (`HEAD_PITCH_OFFSET`, refinable live with `C`).

## Files

- `retarget.js` — pure solver math (browser + node), unit-tested
- `soldier.js` — standalone copy of the game rig + a mocap-only neck pivot
- `mocap.js` — app glue: camera, landmarker, smoothing, scene, HUD
- `demo.js` — synthetic landmark stream (MediaPipe conventions)
- `test/retarget.test.js` — `cd mocap && npm test` (or `node --test test/`)
- `vendor/` — three.min.js copy + MediaPipe tasks-vision 0.10.35 bundle, wasm,
  `pose_landmarker_lite.task`

## Known limits (v1)

- Wrists/fingers aren't tracked (pose model has no finger landmarks); the sword
  rides the forearm at the game's grip angle.
- Single person only (`numPoses: 1`).
- Jumps don't lift the puppet — world landmarks are hip-centered, so airtime is
  unobservable; squats work via the ground clamp instead.
- If the in-game soldier look changes, re-sync `soldier.js` from `game.js`.
