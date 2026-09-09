// retarget.js — pure math: MediaPipe Pose world landmarks -> local joint quaternions
// for the Blade Vale humanoid rig (see ../game.js buildHumanoid, line ~479).
//
// Deliberately dependency-free (no THREE): plain {x,y,z} vectors and {x,y,z,w}
// quaternions, so this module runs unchanged in the browser AND under `node --test`.
//
// Coordinate conventions
// ----------------------
// MediaPipe pose WORLD landmarks: meters, origin at the mid-point of the hips,
//   x = image-right, y = DOWN, z = away from camera (negative = toward camera).
// Game/three space: y = UP, and the rig faces +Z with its anatomical LEFT on +X
//   (game.js: "facing +Z, the anatomical RIGHT side is -X").
//
// TRUE mode   (mirror=false): person's left drives rig left; conversion (x, -y, -z).
//   A person facing the camera comes out facing +Z (toward the viewer).
// MIRROR mode (mirror=true, default): like looking in a mirror — your right hand
//   moves the puppet hand on the SAME side of the screen. Implemented as: swap
//   left/right landmark roles AND negate x, i.e. conversion (-x, -y, -z).
//
// Solver: per bone segment, the rig's rest direction is straight down (0,-1,0)
// from its pivot. We compute the bone's target direction from landmarks, express
// it in the pivot's PARENT world frame, and take the minimal rotation. Because
// every child re-expresses its own direction in the parent's solved frame, the
// joint chain reproduces all bone directions exactly (twist is unconstrained,
// which is invisible on capsule limbs).

// ---------- MediaPipe landmark indices (Pose, 33 points) ----------
export const LM = {
  NOSE: 0, LEYE: 2, REYE: 5, LEAR: 7, REAR: 8,
  LSHO: 11, RSHO: 12, LELB: 13, RELB: 14, LWRI: 15, RWRI: 16,
  LHIP: 23, RHIP: 24, LKNE: 25, RKNE: 26, LANK: 27, RANK: 28,
};

// The raw head-forward (nose relative to the ear mid-point) sits ~24 degrees
// below the ear axis on a level head; subtract it so "looking at the camera"
// is a neutral neck. Refined live via calibration (captureHeadOffset).
export const HEAD_PITCH_OFFSET = 0.42;

const EPS = 1e-9;

// ---------- vec3 ----------
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
export const mid = (a, b) => scale(add(a, b), 0.5);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = a => Math.sqrt(dot(a, a));
export function norm(a) {
  const l = len(a);
  return l < EPS ? null : scale(a, 1 / l); // null = degenerate; callers must guard
}

// ---------- quat ----------
export const qIdent = () => ({ x: 0, y: 0, z: 0, w: 1 });
export function qMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export const qConj = q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export function qNorm(q) {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  return l < EPS ? qIdent() : { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}
export function qAxisAngle(axis, angle) {
  const h = angle / 2, s = Math.sin(h);
  return qNorm({ x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) });
}
// rotate vector by quaternion: q * v * q^-1
export function qRotV(q, v) {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return v3(
    ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  );
}
// minimal rotation taking unit vector a onto unit vector b
export function qFromUnitVectors(a, b) {
  const d = dot(a, b);
  if (d < -0.999999) {
    // antiparallel: 180 degrees about any axis orthogonal to a
    let axis = cross(v3(1, 0, 0), a);
    if (len(axis) < 1e-6) axis = cross(v3(0, 1, 0), a);
    return qAxisAngle(norm(axis), Math.PI);
  }
  const c = cross(a, b);
  return qNorm({ x: c.x, y: c.y, z: c.z, w: 1 + d });
}
// quaternion from an orthonormal basis given as COLUMN vectors (local X/Y/Z axes in world)
export function qFromBasis(bx, by, bz) {
  const m00 = bx.x, m01 = by.x, m02 = bz.x;
  const m10 = bx.y, m11 = by.y, m12 = bz.y;
  const m20 = bx.z, m21 = by.z, m22 = bz.z;
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
  }
  return qNorm(q);
}
export function qAngle(q) { // total rotation angle, radians
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}
export function qSlerp(a, b, t) {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (d > 0.9995) {
    return qNorm({ x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t, z: a.z + (bz - a.z) * t, w: a.w + (bw - a.w) * t });
  }
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return qNorm({ x: a.x * ka + bx * kb, y: a.y * ka + by * kb, z: a.z * ka + bz * kb, w: a.w * ka + bw * kb });
}

const DOWN = v3(0, -1, 0);
const UP = v3(0, 1, 0);
const X = v3(1, 0, 0);

// ---------- landmark conversion ----------
// Returns rig-semantic points in game space. Keys are RIG sides: in mirror mode
// the rig's LEFT is driven by the person's RIGHT landmarks (and x is negated).
export function pick(lms, mirror) {
  const sx = mirror ? -1 : 1;
  const cv = i => {
    const l = lms[i];
    return { x: sx * l.x, y: -l.y, z: -l.z, vis: l.visibility ?? 1 };
  };
  const S = mirror
    ? { sho: [LM.RSHO, LM.LSHO], elb: [LM.RELB, LM.LELB], wri: [LM.RWRI, LM.LWRI],
        hip: [LM.RHIP, LM.LHIP], kne: [LM.RKNE, LM.LKNE], ank: [LM.RANK, LM.LANK],
        ear: [LM.REAR, LM.LEAR] }
    : { sho: [LM.LSHO, LM.RSHO], elb: [LM.LELB, LM.RELB], wri: [LM.LWRI, LM.RWRI],
        hip: [LM.LHIP, LM.RHIP], kne: [LM.LKNE, LM.RKNE], ank: [LM.LANK, LM.RANK],
        ear: [LM.LEAR, LM.REAR] };
  return {
    shoL: cv(S.sho[0]), shoR: cv(S.sho[1]),
    elbL: cv(S.elb[0]), elbR: cv(S.elb[1]),
    wriL: cv(S.wri[0]), wriR: cv(S.wri[1]),
    hipL: cv(S.hip[0]), hipR: cv(S.hip[1]),
    kneL: cv(S.kne[0]), kneR: cv(S.kne[1]),
    ankL: cv(S.ank[0]), ankR: cv(S.ank[1]),
    earL: cv(S.ear[0]), earR: cv(S.ear[1]),
    nose: cv(LM.NOSE),
  };
}

const groupVis = (...pts) => Math.min(...pts.map(p => p.vis));

// Solve a bone chain segment: direction from a->b expressed in parentWorld frame,
// rotated from the rig's rest direction (straight down).
//
// Twist continuity: the minimal rotation qFromUnitVectors(DOWN, dir) is
// discontinuous in twist when dir approaches straight UP (antiparallel to rest)
// — a hand-held sword would snap ~180° from frame-to-frame noise with an arm
// raised overhead. So when the previous frame's solution is available we
// parallel-transport it onto today's direction (continuous everywhere), then
// relax toward the canonical minimal rotation with a strength that fades to
// zero near the pole, and finally re-project so the bone direction stays exact.
const POLE_FADE = 0.9;   // dLocal.y above this: pure transport, no relaxation
const TWIST_RELAX = 0.25; // per-frame pull back to the canonical twist away from the pole
function solveBone(parentWorld, a, b, prev) {
  const d = norm(sub(b, a));
  if (!d) {
    const q = prev ?? qIdent();
    return { local: q, world: qMul(parentWorld, q) };
  }
  const dLocal = qRotV(qConj(parentWorld), d);
  let local = qFromUnitVectors(DOWN, dLocal); // canonical minimal rotation
  if (prev) {
    const prevDir = qRotV(prev, DOWN);
    const transported = qNorm(qMul(qFromUnitVectors(prevDir, dLocal), prev));
    const k = TWIST_RELAX * Math.min(1, Math.max(0, (POLE_FADE - dLocal.y) / POLE_FADE));
    local = qSlerp(transported, local, k);
    // slerp can drift off the direction constraint by a hair — re-project
    local = qNorm(qMul(qFromUnitVectors(qRotV(local, DOWN), dLocal), local));
  }
  return { local, world: qMul(parentWorld, local) };
}

// ---------- the solver ----------
// worldLandmarks: array of 33 {x,y,z,visibility} in MediaPipe world convention.
// opts.mirror   : mirror-mode mapping (default true)
// opts.headOffset: calibration quat applied to the raw neck rotation (from captureHeadOffset)
// opts.prev     : previous frame's solved `q` map — enables twist continuity on the limbs
//
// Returns null if the torso frame is degenerate (can't orient anything), else:
// { yaw, q: {upperBody, neck, shoulderL/R, elbowL/R, hipL/R, kneeL/R}, vis: {...}, p }
export function solvePose(worldLandmarks, opts = {}) {
  const mirror = opts.mirror ?? true;
  const prev = opts.prev ?? {};
  const P = pick(worldLandmarks, mirror);

  const hipC = mid(P.hipL, P.hipR);
  const shoC = mid(P.shoL, P.shoR);
  const spine = norm(sub(shoC, hipC));
  const acrossHip = norm(sub(P.hipL, P.hipR));
  if (!spine || !acrossHip) return null;

  // Root: yaw only — the rig stays upright and planted; lean lives in upperBody,
  // leg orientation in the hip pivots (both solved relative to this yaw frame).
  const fwdHip = norm(cross(acrossHip, spine));
  if (!fwdHip) return null;
  let yaw;
  const fl = Math.hypot(fwdHip.x, fwdHip.z);
  if (fl < 0.05) { // facing straight up/down the Y axis: yaw is unobservable
    yaw = opts.prevYaw ?? 0;
  } else {
    yaw = Math.atan2(fwdHip.x, fwdHip.z);
  }
  const qRoot = qAxisAngle(UP, yaw);

  // Torso world orientation from the shoulder line + spine.
  const acrossSho = norm(sub(P.shoL, P.shoR)) ?? acrossHip;
  let fwdSho = norm(cross(acrossSho, spine));
  if (!fwdSho) fwdSho = fwdHip;
  const acrossOrtho = norm(cross(spine, fwdSho)) ?? acrossSho;
  const qTorsoWorld = qFromBasis(acrossOrtho, spine, fwdSho);
  const qUpper = qMul(qConj(qRoot), qTorsoWorld);

  // Arms hang off the torso; legs hang off the yaw-only root.
  const shoLs = solveBone(qTorsoWorld, P.shoL, P.elbL, prev.shoulderL);
  const elbLs = solveBone(shoLs.world, P.elbL, P.wriL, prev.elbowL);
  const shoRs = solveBone(qTorsoWorld, P.shoR, P.elbR, prev.shoulderR);
  const elbRs = solveBone(shoRs.world, P.elbR, P.wriR, prev.elbowR);
  const hipLs = solveBone(qRoot, P.hipL, P.kneL, prev.hipL);
  const kneLs = solveBone(hipLs.world, P.kneL, P.ankL, prev.kneeL);
  const hipRs = solveBone(qRoot, P.hipR, P.kneR, prev.hipR);
  const kneRs = solveBone(hipRs.world, P.kneR, P.ankR, prev.kneeR);

  // Head: frame from the ear axis + nose direction, then cancel the anatomical
  // nose-below-ears pitch so a level gaze is a neutral neck.
  let qNeck = qIdent();
  const acrossH = norm(sub(P.earL, P.earR));
  if (acrossH) {
    const earC = mid(P.earL, P.earR);
    const fwdRaw = sub(P.nose, earC);
    const fwdH = norm(sub(fwdRaw, scale(acrossH, dot(fwdRaw, acrossH))));
    if (fwdH) {
      const upH = cross(fwdH, acrossH);
      let qHeadWorld = qFromBasis(acrossH, upH, fwdH);
      qHeadWorld = qMul(qHeadWorld, qAxisAngle(X, -HEAD_PITCH_OFFSET));
      qNeck = qMul(qConj(qTorsoWorld), qHeadWorld);
      if (opts.headOffset) qNeck = qMul(qNeck, opts.headOffset);
    }
  }

  return {
    yaw,
    q: {
      upperBody: qUpper, neck: qNeck,
      shoulderL: shoLs.local, elbowL: elbLs.local,
      shoulderR: shoRs.local, elbowR: elbRs.local,
      hipL: hipLs.local, kneeL: kneLs.local,
      hipR: hipRs.local, kneeR: kneRs.local,
    },
    vis: {
      torso: groupVis(P.shoL, P.shoR, P.hipL, P.hipR),
      armL: groupVis(P.shoL, P.elbL, P.wriL),
      armR: groupVis(P.shoR, P.elbR, P.wriR),
      legL: groupVis(P.hipL, P.kneL, P.ankL),
      legR: groupVis(P.hipR, P.kneR, P.ankR),
      head: groupVis(P.earL, P.earR, P.nose),
    },
    p: P,
  };
}

// Capture a head calibration offset from the CURRENT solve so that "now" becomes
// the neutral head pose: solvePose(..., {headOffset}) then yields ~identity.
export function captureHeadOffset(solved) {
  return qConj(solved.q.neck);
}
