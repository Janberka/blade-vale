// demo.js — synthetic pose stream in MediaPipe WORLD-landmark convention
// (meters, origin at hip mid-point, x = image-right, y = DOWN, z = toward camera
// negative). Used when there is no webcam (?demo=1 or camera denied) and by the
// smoke test: it exercises the exact same convert->solve pipeline as live video,
// so if the demo puppet moves right, the coordinate chain is right.
//
// The figure faces the camera, waves its right arm overhead, sways the left arm,
// bobs into a light squat and shakes its head.

const SEG = {
  hipHalf: 0.13, shoHalf: 0.18, torso: 0.5,
  upperArm: 0.28, foreArm: 0.26, thigh: 0.42, shin: 0.42,
  earUp: 0.25, earHalf: 0.09, noseFwd: 0.10, noseDrop: 0.04,
};

const pt = (x, y, z) => ({ x, y, z, visibility: 1 });

// direction of a limb hanging at angle `a` from straight-down, swinging outward
// along +-x and (optionally) forward along -z. y is DOWN, so hanging = +y.
function limbDir(a, outSign, fwd = 0) {
  const d = { x: outSign * Math.sin(a), y: Math.cos(a), z: fwd };
  const l = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}
const along = (p, dir, dist) => pt(p.x + dir.x * dist, p.y + dir.y * dist, p.z + dir.z * dist);

export function demoLandmarks(t) {
  const L = new Array(33).fill(null).map(() => pt(0, 0, 0));

  // torso: hips at the origin, shoulders straight up, slight breathing twist
  const twist = 0.18 * Math.sin(t * 0.7);
  const c = Math.cos(twist), s = Math.sin(twist);
  L[23] = pt(SEG.hipHalf, 0, 0);   // left hip
  L[24] = pt(-SEG.hipHalf, 0, 0);  // right hip
  const shoY = -SEG.torso;
  L[11] = pt(SEG.shoHalf * c, shoY, SEG.shoHalf * s);    // left shoulder
  L[12] = pt(-SEG.shoHalf * c, shoY, -SEG.shoHalf * s);  // right shoulder

  // right arm: raised overhead, forearm waving
  const aR = 2.35 + 0.1 * Math.sin(t * 4);
  L[14] = along(L[12], limbDir(aR, -1), SEG.upperArm);                     // right elbow
  L[16] = along(L[14], limbDir(aR + 0.9 * Math.sin(t * 4), -1), SEG.foreArm); // right wrist

  // left arm: easy pendulum with a little forward drift
  const aL = 0.3 + 0.18 * Math.sin(t * 1.3);
  L[13] = along(L[11], limbDir(aL, 1), SEG.upperArm);                      // left elbow
  L[15] = along(L[13], limbDir(aL + 0.3, 1, -0.35 - 0.2 * Math.sin(t * 1.3)), SEG.foreArm); // left wrist

  // legs: light squat bob — thigh pitches forward (knee toward camera, -z),
  // shin pitches back so the ankle stays under the hip
  const k = 0.25 + 0.22 * Math.sin(t * 0.9);
  for (const [hip, kne, ank] of [[23, 25, 27], [24, 26, 28]]) {
    const dT = { x: 0, y: Math.cos(k), z: -Math.sin(k) };
    L[kne] = along(L[hip], dT, SEG.thigh);
    const dS = { x: 0, y: Math.cos(k), z: Math.sin(k) };
    L[ank] = along(L[kne], dS, SEG.shin);
  }

  // head: yaw shake about the vertical
  const hy = 0.55 * Math.sin(t * 1.7);
  const earC = pt(0, shoY - SEG.earUp, 0);
  const hc = Math.cos(hy), hs = Math.sin(hy);
  L[7] = pt(earC.x + SEG.earHalf * hc, earC.y, earC.z + SEG.earHalf * hs);  // left ear
  L[8] = pt(earC.x - SEG.earHalf * hc, earC.y, earC.z - SEG.earHalf * hs);  // right ear
  L[0] = pt(earC.x + SEG.noseFwd * hs, earC.y + SEG.noseDrop, earC.z - SEG.noseFwd * hc); // nose
  L[2] = pt(L[0].x + 0.03 * hc, L[0].y - 0.03, L[0].z + 0.03 * hs);  // left eye (unused by solver)
  L[5] = pt(L[0].x - 0.03 * hc, L[0].y - 0.03, L[0].z - 0.03 * hs);  // right eye

  // hands/feet extras (17-22, 29-32): park near their wrist/ankle so any consumer
  // that touches them gets something sane
  for (const [src, ids] of [[15, [17, 19, 21]], [16, [18, 20, 22]], [27, [29, 31]], [28, [30, 32]]]) {
    for (const i of ids) L[i] = pt(L[src].x, L[src].y + 0.03, L[src].z - 0.03);
  }
  return L;
}
