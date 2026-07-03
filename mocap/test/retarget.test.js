// Unit tests for the landmark -> rig solver. Pure math, no browser.
// Fixtures are authored in MediaPipe WORLD convention: meters, origin at the
// hip mid-point, x = image-right, y = DOWN, z = toward camera negative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LM, solvePose, captureHeadOffset,
  v3, sub, norm, dot, qMul, qRotV, qAxisAngle, qAngle,
} from '../retarget.js';

const pt = (x, y, z) => ({ x, y, z, visibility: 1 });

// A person standing upright facing the camera, arms hanging, legs straight.
function standing() {
  const L = new Array(33).fill(null).map(() => pt(0, 0, 0));
  L[LM.LHIP] = pt(0.13, 0, 0);    L[LM.RHIP] = pt(-0.13, 0, 0);
  L[LM.LSHO] = pt(0.18, -0.5, 0); L[LM.RSHO] = pt(-0.18, -0.5, 0);
  L[LM.LELB] = pt(0.20, -0.22, 0); L[LM.RELB] = pt(-0.20, -0.22, 0);
  L[LM.LWRI] = pt(0.21, 0.04, 0);  L[LM.RWRI] = pt(-0.21, 0.04, 0);
  L[LM.LKNE] = pt(0.13, 0.42, 0);  L[LM.RKNE] = pt(-0.13, 0.42, 0);
  L[LM.LANK] = pt(0.13, 0.84, 0);  L[LM.RANK] = pt(-0.13, 0.84, 0);
  L[LM.LEAR] = pt(0.09, -0.75, 0); L[LM.REAR] = pt(-0.09, -0.75, 0);
  L[LM.NOSE] = pt(0, -0.71, -0.10);
  return L;
}

const UP = v3(0, 1, 0), DOWN = v3(0, -1, 0);
const angleBetween = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));

// Forward kinematics mirror of how mocap.js applies the solve: compose local
// quats down each chain and rotate the rest direction (straight down).
function fk(solved) {
  const qRoot = qAxisAngle(UP, solved.yaw);
  const torso = qMul(qRoot, solved.q.upperBody);
  const shoL = qMul(torso, solved.q.shoulderL), shoR = qMul(torso, solved.q.shoulderR);
  const hipL = qMul(qRoot, solved.q.hipL), hipR = qMul(qRoot, solved.q.hipR);
  return {
    upperArmL: qRotV(shoL, DOWN), foreArmL: qRotV(qMul(shoL, solved.q.elbowL), DOWN),
    upperArmR: qRotV(shoR, DOWN), foreArmR: qRotV(qMul(shoR, solved.q.elbowR), DOWN),
    thighL: qRotV(hipL, DOWN), shinL: qRotV(qMul(hipL, solved.q.kneeL), DOWN),
    thighR: qRotV(hipR, DOWN), shinR: qRotV(qMul(hipR, solved.q.kneeR), DOWN),
  };
}
// what each bone direction SHOULD be, straight from the converted landmarks
function boneDirs(p) {
  return {
    upperArmL: norm(sub(p.elbL, p.shoL)), foreArmL: norm(sub(p.wriL, p.elbL)),
    upperArmR: norm(sub(p.elbR, p.shoR)), foreArmR: norm(sub(p.wriR, p.elbR)),
    thighL: norm(sub(p.kneL, p.hipL)), shinL: norm(sub(p.ankL, p.kneL)),
    thighR: norm(sub(p.kneR, p.hipR)), shinR: norm(sub(p.ankR, p.kneR)),
  };
}

test('standing figure facing the camera solves to a near-rest pose (true mode)', () => {
  const s = solvePose(standing(), { mirror: false });
  assert.ok(s, 'solver returned a pose');
  // facing the camera = facing +Z in game space = yaw ~0
  assert.ok(Math.abs(s.yaw) < 0.15, `yaw ~0, got ${s.yaw}`);
  assert.ok(qAngle(s.q.upperBody) < 0.12, 'torso near identity');
  for (const j of ['shoulderL', 'shoulderR', 'hipL', 'hipR', 'kneeL', 'kneeR']) {
    assert.ok(qAngle(s.q[j]) < 0.15, `${j} near identity, got ${qAngle(s.q[j])}`);
  }
  // level gaze reads as a neutral neck (nose-below-ears pitch cancelled)
  assert.ok(qAngle(s.q.neck) < 0.12, `neck near identity, got ${qAngle(s.q.neck)}`);
  assert.ok(s.vis.torso === 1 && s.vis.armL === 1, 'full visibility propagates');
});

test('FK through the solved chain reproduces every bone direction exactly', () => {
  // a deliberately awkward pose: right arm overhead, left arm forward, deep knee bend
  const L = standing();
  L[LM.RELB] = pt(-0.31, -0.72, -0.08);
  L[LM.RWRI] = pt(-0.26, -0.95, -0.18);
  L[LM.LELB] = pt(0.24, -0.38, -0.18);
  L[LM.LWRI] = pt(0.20, -0.30, -0.42);
  L[LM.LKNE] = pt(0.14, 0.30, -0.26); L[LM.LANK] = pt(0.13, 0.68, -0.04);
  L[LM.RKNE] = pt(-0.15, 0.28, -0.29); L[LM.RANK] = pt(-0.13, 0.66, -0.01);
  L[LM.LSHO] = pt(0.17, -0.52, 0.05); L[LM.RSHO] = pt(-0.18, -0.49, -0.05); // slight twist

  for (const mirror of [false, true]) {
    const s = solvePose(L, { mirror });
    const got = fk(s), want = boneDirs(s.p);
    for (const k of Object.keys(want)) {
      const err = angleBetween(got[k], want[k]);
      assert.ok(err < 1e-6, `${k} (mirror=${mirror}): FK deviates by ${err} rad`);
    }
  }
});

test('mirror mode maps your right hand onto the rig LEFT arm; true mode onto the right', () => {
  const L = standing();
  // person raises their RIGHT hand straight overhead
  L[LM.RELB] = pt(-0.20, -0.78, 0);
  L[LM.RWRI] = pt(-0.20, -1.04, 0);

  const mir = solvePose(L, { mirror: true });
  const tru = solvePose(L, { mirror: false });
  assert.ok(fk(mir).upperArmL.y > 0.7, 'mirror: rig LEFT upper arm points up');
  assert.ok(fk(mir).upperArmR.y < 0, 'mirror: rig right arm still hangs');
  assert.ok(fk(tru).upperArmR.y > 0.7, 'true: rig RIGHT upper arm points up');
  assert.ok(fk(tru).upperArmL.y < 0, 'true: rig left arm still hangs');
});

test('a squat bends the knees', () => {
  const L = standing();
  for (const [kne, ank, sx] of [[LM.LKNE, LM.LANK, 1], [LM.RKNE, LM.RANK, -1]]) {
    L[kne] = pt(0.13 * sx, 0.30, -0.28);
    L[ank] = pt(0.13 * sx, 0.66, -0.02);
  }
  const s = solvePose(L, { mirror: false });
  assert.ok(qAngle(s.q.kneeL) > 0.5, `left knee bent, got ${qAngle(s.q.kneeL)}`);
  assert.ok(qAngle(s.q.kneeR) > 0.5, `right knee bent, got ${qAngle(s.q.kneeR)}`);
});

test('turning the head yaws the neck; calibration re-zeroes it', () => {
  const L = standing();
  // head turned ~40 degrees: rotate ears + nose about the vertical through the ear center
  const hy = 0.7, c = Math.cos(hy), sn = Math.sin(hy);
  const earY = -0.75;
  L[LM.LEAR] = pt(0.09 * c, earY, 0.09 * sn);
  L[LM.REAR] = pt(-0.09 * c, earY, -0.09 * sn);
  L[LM.NOSE] = pt(0.10 * sn, -0.71, -0.10 * c);

  const s = solvePose(L, { mirror: false });
  assert.ok(qAngle(s.q.neck) > 0.4, `neck rotated, got ${qAngle(s.q.neck)}`);
  // the rotation should be mostly yaw: rotating local +Z should keep y small
  const f = qRotV(s.q.neck, v3(0, 0, 1));
  assert.ok(Math.abs(f.y) < 0.25, `mostly yaw, vertical drift ${f.y}`);

  const off = captureHeadOffset(s);
  const s2 = solvePose(L, { mirror: false, headOffset: off });
  assert.ok(qAngle(s2.q.neck) < 1e-6, 'same pose after calibration = neutral neck');
});

test('whole-body turn shows up as root yaw, not as limb contortion', () => {
  // rotate the standing figure 90 deg about the vertical axis
  const rot = l => pt(-l.z, l.y, l.x); // (x,z) -> (-z,x): quarter turn about y
  const L = standing().map(rot);
  const s = solvePose(L, { mirror: false });
  assert.ok(Math.abs(Math.abs(s.yaw) - Math.PI / 2) < 0.15, `|yaw| ~ pi/2, got ${s.yaw}`);
  for (const j of ['shoulderL', 'shoulderR', 'hipL', 'hipR']) {
    assert.ok(qAngle(s.q[j]) < 0.15, `${j} stays near rest, got ${qAngle(s.q[j])}`);
  }
});

test('twist stays continuous when an arm sweeps through straight-overhead', () => {
  // The canonical minimal rotation flips twist ~180deg when the bone direction
  // wobbles across straight-up (this is what made the sword snap). With
  // opts.prev threading, successive solves must stay continuous AND keep the
  // bone directions exact.
  // landmark-noise-style azimuth hops (~90deg/frame) in a tight 4deg cone around
  // straight-overhead: without prev threading the worst frame-to-frame shoulder
  // jump measures ~2.9 rad (the sword snap); with it, ~0.1 rad.
  let prev = null, maxJump = 0;
  for (let i = 0; i < 40; i++) {
    const a = i * (Math.PI / 2 + 0.13);
    const L = standing();
    const tilt = 0.07;
    const dir = {
      x: Math.sin(tilt) * Math.cos(a),
      y: -1 * Math.cos(tilt),               // up in mediapipe coords is -y
      z: Math.sin(tilt) * Math.sin(a),
    };
    L[LM.RELB] = pt(-0.18 + 0.28 * dir.x, -0.5 + 0.28 * dir.y, 0.28 * dir.z);
    L[LM.RWRI] = pt(-0.18 + 0.54 * dir.x, -0.5 + 0.54 * dir.y, 0.54 * dir.z);
    const s = solvePose(L, { mirror: false, prev: prev?.q });
    // direction tracking must remain exact even with the continuity blend
    const err = angleBetween(fk(s).upperArmR, boneDirs(s.p).upperArmR);
    assert.ok(err < 1e-6, `FK stays exact at step ${i}, err ${err}`);
    if (prev) {
      const dq = qMul(s.q.shoulderR, { x: -prev.q.shoulderR.x, y: -prev.q.shoulderR.y, z: -prev.q.shoulderR.z, w: prev.q.shoulderR.w });
      maxJump = Math.max(maxJump, qAngle(dq));
    }
    prev = s;
  }
  assert.ok(maxJump < 0.5, `no frame-to-frame twist snap through the pole, worst jump ${maxJump} rad`);
});

test('degenerate input (all landmarks coincident) returns null instead of NaN', () => {
  const L = new Array(33).fill(null).map(() => pt(0, 0, 0));
  assert.equal(solvePose(L, { mirror: false }), null);
});

test('low-visibility landmarks surface in the per-group confidence', () => {
  const L = standing();
  L[LM.LWRI].visibility = 0.1;
  const s = solvePose(L, { mirror: false });
  assert.ok(s.vis.armL <= 0.1, 'left arm group confidence drops with its wrist');
  assert.equal(s.vis.armR, 1, 'right arm unaffected');
  // in mirror mode the person's LEFT wrist drives the rig RIGHT arm
  const m = solvePose(L, { mirror: true });
  assert.ok(m.vis.armR <= 0.1, 'mirror: confidence follows the side swap');
});
