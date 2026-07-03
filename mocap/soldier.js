// soldier.js — standalone copy of the game's humanoid rig for the mocap sub-project.
//
// PROVENANCE: hand-copied from ../game.js (buildHumanoid, ~line 479, plus its
// helpers mat/cachedGeo/boxMesh/softCapsule/sphereMesh). The game remains the
// source of truth for the soldier's look — if the in-game model changes, re-sync
// this file. Kept as a copy (not an import) so the sub-project never loads the
// 10k-line game script.
//
// Two deliberate deltas from the game version:
//   1. A `neckPivot` group: neck/head/helm/visor now hang off one pivot under
//      upperBody so mocap can turn the head (parts.neck). The game rig welds
//      these straight onto upperBody.
//   2. The 'bow' and 'rock' weapon variants are dropped — mocap only needs
//      sword / longsword / sword-and-board.
//
// Uses the global THREE (vendor/three.min.js r128), same as the game.

/* global THREE */

export const PLAYER_PALETTE = { skin: 0xe0a878, cloth: 0x2f5fae, accent: 0x223a66, blade: 0xeaf2ff };
export const SWORD_BASE_X = 1.4;

// Geometry cache: identical shapes share one GPU buffer.
const geoCache = new Map();
function cachedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); g.userData.cached = true; geoCache.set(key, g); }
  return g;
}

// Phong instead of Standard: flat-shaded low-poly reads near-identical and is far cheaper.
const matCache = new Map();
export function mat(color, opts = {}) {
  const make = () => new THREE.MeshPhongMaterial({
    color, flatShading: opts.smooth ? false : true,
    shininess: opts.metal ? 28 : 5,
    specular: opts.metal ? 0x555555 : 0x0a0a0a,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveI ?? 1,
  });
  if (opts.shared === false) return make();
  const key = color + '|' + (opts.smooth ? 1 : 0) + (opts.metal ? 'm' : '') +
              '|' + (opts.emissive ?? 0) + '|' + (opts.emissiveI ?? 1);
  let m = matCache.get(key);
  if (!m) { m = make(); m.userData.cached = true; matCache.set(key, m); }
  return m;
}
function boxMesh(w, h, d, m) {
  const me = new THREE.Mesh(cachedGeo('box:' + w + ',' + h + ',' + d, () => new THREE.BoxGeometry(w, h, d)), m);
  me.castShadow = true; me.receiveShadow = true;
  return me;
}
// Rounded capsule as a SINGLE lathed mesh. Centered at origin, axis along Y.
function softCapsule(radius, length, m, seg = 10) {
  const geo = cachedGeo('capsule:' + radius + ',' + length + ',' + seg, () => {
    const pts = [];
    const half = length / 2, STEPS = 4;
    for (let i = 0; i <= STEPS; i++) {
      const a = -Math.PI / 2 + (i / STEPS) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.cos(a) * radius, -half + Math.sin(a) * radius));
    }
    for (let i = 0; i <= STEPS; i++) {
      const a = (i / STEPS) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.cos(a) * radius, half + Math.sin(a) * radius));
    }
    return new THREE.LatheGeometry(pts, seg);
  });
  const me = new THREE.Mesh(geo, m);
  me.castShadow = true;
  return me;
}
function sphereMesh(r, m, wseg = 12, hseg = 9) {
  const me = new THREE.Mesh(cachedGeo('sph:' + r + ',' + wseg + ',' + hseg,
    () => new THREE.SphereGeometry(r, wseg, hseg)), m);
  me.castShadow = true; me.receiveShadow = true;
  return me;
}

// ---------- Humanoid builder ----------
// Anatomical low-poly rig:
//   root
//   ├─ hipL/hipR (pivot) ─ thigh ─ kneeL/kneeR (pivot) ─ shin + foot
//   ├─ pelvis
//   └─ upperBody (pivot at waist: lean/twist)
//       ├─ torso, shoulder pads
//       ├─ neckPivot (MOCAP DELTA) ─ neck, head, helm, visor slits
//       └─ shoulderL/R (pivot) ─ upper arm ─ elbowL/R (pivot) ─ forearm ─ hand (+ sword R)
export function buildHumanoid(palette = PLAYER_PALETTE, scale = 1, weapon = 'sword') {
  const g = new THREE.Group();
  const casters = [];
  const skin = mat(palette.skin, { shared: false });
  const cloth = mat(palette.cloth, { shared: false });
  const accent = mat(palette.accent, { shared: false });
  const plateCol = new THREE.Color(palette.accent).lerp(new THREE.Color(0xc8ccd4), 0.35);
  const plate = mat(plateCol.getHex(), { metal: 1, shared: false });

  // --- Legs (attached to root so torso lean doesn't drag them) ---
  const hipY = 1.7;
  function makeLeg(side) {
    const hip = new THREE.Group(); hip.position.set(0.185 * side, hipY, 0);
    const thigh = softCapsule(0.16, 0.44, cloth, 6); thigh.position.y = -0.34; hip.add(thigh);
    const knee = new THREE.Group(); knee.position.y = -0.7; hip.add(knee);
    const cop = sphereMesh(0.15, plate, 6, 4); cop.position.set(0, 0.02, 0.05); knee.add(cop);
    const shin = new THREE.Mesh(cachedGeo('greave', () =>
      new THREE.CylinderGeometry(0.15, 0.11, 0.62, 6)), plate);
    shin.position.y = -0.34; knee.add(shin);
    casters.push(thigh, shin);
    const foot = sphereMesh(0.17, plate, 7, 5);
    foot.position.set(0, -0.87, 0.1); foot.scale.set(0.95, 0.68, 1.5); knee.add(foot);
    g.add(hip);
    return { hip, knee };
  }
  // facing +Z, the anatomical RIGHT side is -X
  const legL = makeLeg(1), legR = makeLeg(-1);

  // --- Pelvis: the faulds ---
  const pelvis = new THREE.Mesh(cachedGeo('faulds', () =>
    new THREE.CylinderGeometry(0.33, 0.46, 0.5, 7)), cloth);
  pelvis.position.y = 1.56; pelvis.scale.z = 0.88; g.add(pelvis);

  // --- Upper body (pivots at the waist for lean / twist) ---
  const upperBody = new THREE.Group(); upperBody.position.y = 1.86; g.add(upperBody);

  const torso = new THREE.Mesh(cachedGeo('breastplate', () =>
    new THREE.CylinderGeometry(0.4, 0.28, 0.78, 7)), plate);
  torso.position.y = 0.42; torso.scale.z = 0.72;
  upperBody.add(torso);

  const belt = boxMesh(0.72, 0.16, 0.52, accent);
  belt.position.y = 0.02; upperBody.add(belt);

  // MOCAP DELTA: neck + head + helm hang off one pivot so the head can turn.
  // Pivot sits at the neck base (y=0.94 in upperBody space); the children keep
  // their game-authored world offsets, re-expressed relative to the pivot.
  const neckPivot = new THREE.Group(); neckPivot.position.y = 0.94; upperBody.add(neckPivot);
  const neck = softCapsule(0.09, 0.14, skin, 6); neckPivot.add(neck);
  const head = sphereMesh(0.22, skin, 10, 7);
  head.position.y = 0.22; neckPivot.add(head);
  const helm = new THREE.Mesh(cachedGeo('greatHelm', () => new THREE.LatheGeometry([
    new THREE.Vector2(0.26, 0), new THREE.Vector2(0.275, 0.08), new THREE.Vector2(0.26, 0.3),
    new THREE.Vector2(0.17, 0.46), new THREE.Vector2(0, 0.56),
  ], 7)), plate);
  helm.position.y = 0.04; neckPivot.add(helm);
  const crest = boxMesh(0.055, 0.14, 0.4, plate);
  crest.position.y = 0.56; neckPivot.add(crest);
  const slitM = mat(0x14161c, {});
  const eyeSlit = boxMesh(0.3, 0.05, 0.06, slitM);
  eyeSlit.position.set(0, 0.32, 0.235); neckPivot.add(eyeSlit);
  const noseSlit = boxMesh(0.05, 0.16, 0.06, slitM);
  noseSlit.position.set(0, 0.23, 0.24); neckPivot.add(noseSlit);

  // --- Arms: shoulder pivot → upper arm → elbow pivot → forearm → hand ---
  function makeArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.37 * side, 0.82, 0);
    const pad = sphereMesh(0.2, plate, 7, 4);
    pad.position.set(0.05 * side, 0.06, 0); pad.scale.set(1.15, 0.75, 1.05); shoulder.add(pad);
    const upper = softCapsule(0.1, 0.28, cloth, 6);
    upper.position.y = -0.24; shoulder.add(upper);
    const elbow = new THREE.Group(); elbow.position.y = -0.46; shoulder.add(elbow);
    const fore = new THREE.Mesh(cachedGeo('bracer', () =>
      new THREE.CylinderGeometry(0.105, 0.085, 0.36, 6)), plate);
    fore.position.y = -0.21; elbow.add(fore);
    const hand = new THREE.Group(); hand.position.y = -0.44; elbow.add(hand);
    const fist = sphereMesh(0.105, skin, 7, 5); hand.add(fist);
    upperBody.add(shoulder);
    return { shoulder, elbow, hand };
  }
  const armL = makeArm(1);
  const armR = makeArm(-1); // sword arm on the true anatomical right

  // --- Held weapon ---
  function makeSword(longer) {
    const bladeLen = 1.35 * (longer ? 1.45 : 1);
    const sw = new THREE.Group();
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, longer ? 0.46 : 0.34, 8), mat(0x241812, { smooth: true }));
    sw.add(grip);
    const pommel = sphereMesh(0.07, mat(0x6a5630, { metal: 0.5, smooth: true }), 8, 6);
    pommel.position.y = longer ? -0.27 : -0.21; sw.add(pommel);
    const guard = boxMesh(longer ? 0.52 : 0.42, 0.07, 0.14, mat(0x3a2a18, { metal: 0.4 }));
    guard.position.y = 0.2; sw.add(guard);
    const blade = boxMesh(longer ? 0.1 : 0.085, bladeLen, 0.2, mat(palette.blade ?? 0xd9e2ec, { metal: 0.6 }));
    blade.position.y = 0.2 + bladeLen / 2 + 0.02; sw.add(blade);
    casters.push(blade);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.22, 4), blade.material);
    tip.position.y = 0.2 + bladeLen + 0.13; tip.rotation.y = Math.PI / 4; tip.castShadow = true; sw.add(tip);
    sw.rotation.x = SWORD_BASE_X;
    armR.hand.add(sw);
    return sw;
  }

  const sword = makeSword(weapon === 'longsword');
  if (weapon === 'sword') { // sword-and-board: heater shield strapped to the left hand
    const shield = new THREE.Mesh(cachedGeo('heaterShield', () => {
      const s = new THREE.Shape();
      s.moveTo(-0.34, 0.42); s.lineTo(0.34, 0.42); s.lineTo(0.3, 0.02);
      s.lineTo(0, -0.5); s.lineTo(-0.3, 0.02); s.closePath();
      return new THREE.ExtrudeGeometry(s, { depth: 0.06, bevelEnabled: false });
    }), plate);
    shield.position.set(0.08, -0.02, 0.12);
    shield.userData.fixedGrip = true;
    armL.hand.add(shield);
    casters.push(shield);
  }

  // shadow budget: only big silhouette parts cast (same policy as the game)
  g.traverse(c => { if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; } });
  casters.push(torso, helm, pelvis);
  for (const c of casters) c.castShadow = true;

  g.scale.setScalar(scale);
  return {
    group: g,
    parts: {
      torso, head, upperBody, sword,
      neck: neckPivot,
      shoulderL: armL.shoulder, elbowL: armL.elbow,
      shoulderR: armR.shoulder, elbowR: armR.elbow,
      hipL: legL.hip, kneeL: legL.knee,
      hipR: legR.hip, kneeR: legR.knee,
      handL: armL.hand, handR: armR.hand,
    },
  };
}
