// ARCHERY — the range in the char editor. The archer is the editor's own man (whichever CHAR SIZE is picked), a bow in his
// left fist, an arrow on the string, a straw boss with a 122 cm face down the range. It is where the bow, the draw and the
// flight are built and judged before they go near the game.
//
// THE RANGE. He stands where he always stands, facing +Z; the target is on his LEFT, down +X, so his shoulder line already
// points at it (side-on, as an archer stands). The head turns to the target; both arms are laid by a two-bone IK:
//   bow arm   the fist's tunnel (where a hilt would sit) is put on the arrow line, ~one arm's reach out from the shoulder
//   draw arm  the right fist's tunnel holds the string — at brace height off the bow at draw 0, at the anchor (the corner of
//             his jaw) at full draw
// Each hand is turned so its fist's own lines — little→index knuckle up, wrist→knuckles down the arrow — match the bow.
// THE BOW is built, not loaded: a longbow, riser + two limbs bent as circular arcs. The string is kept the same length, so
// the draw decides how far the limbs bend (bisection on the arc's angle) — the bow bends because he pulls, not by a slider.
// THE FLIGHT: the arrow leaves along its own line (nock → rest) at a speed set by how far it was drawn, falls under gravity,
// and sticks where it hits: the face scores 10…1 (X inside the 10), the straw, or the sand.
// Keys: hold SPACE to draw, let go to loose. Hooks: __arch({ on, dist, draw, elev, auto, follow }), __loose(), __pull().
(() => {
  const el$ = id => document.getElementById(id), V = () => new THREE.Vector3(), Qn = () => new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const A = {
    on: false, dist: 18, draw: 0, want: 0, elev: 0, az: 0, auto: true, follow: true, cmdE: 0, cmdA: 0,
    vmax: 56, g: 9.81, brace: 0.20, limb: 0.80, riser: 0.13,   // m/s at full draw · brace height · limb arc length · half the riser
    flying: [], stuck: [], ends: [], loosed: 0, snap: 0, renock: 0, hold: 0, view: 'side', camBack: null,
  };
  window.__ARCH = A;

  // ---- the panel (its own section at the top of the editor's)
  const ui = el$('ui'), box = document.createElement('div');
  box.innerHTML = `<h4>archery <span class=sm>— hold <span class=k>space</span> to draw</span></h4>
  <label><input type=checkbox id=ar_on> the range: bow, arrow, target</label>
  <div id=ar_box style=display:none>
    <label class=sm>target at <span id=ar_vd>18 m</span></label><input type=range id=ar_dist min=5 max=70 value=18>
    <label class=sm>draw <span id=ar_vk>0%</span></label><input type=range id=ar_draw min=0 max=100 value=0>
    <label class=sm>aim up <span id=ar_ve>0.0°</span></label><input type=range id=ar_elev min=-50 max=250 value=0>
    <label title="lay the arrow's line so a full draw lands in the gold at this distance"><input type=checkbox id=ar_auto checked> aim for the gold</label>
    <label title="the lens rides behind the arrow to the boss, then comes back"><input type=checkbox id=ar_follow checked> follow the arrow</label>
    <div class=row style=margin-top:4px><button id=ar_shoot title="draw, hold, loose">shoot</button><button id=ar_loose>loose</button><button id=ar_pull title="pull the arrows, a new end">pull</button></div>
    <div class=row style=margin-top:4px><button data-av=side>side</button><button data-av=behind>behind</button><button data-av=front>front</button><button data-av=bow>bow</button><button data-av=target>target</button></div>
    <div class=sm id=ar_say style="white-space:pre-line;margin-top:4px"></div>
  </div>`;
  ui.insertBefore(box, ui.firstChild);

  // ---- materials
  const canvasTex = (w, h, paint) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; paint(cv.getContext('2d'), w, h); const t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8; return t; };
  const woodTex = canvasTex(64, 512, (x, w, h) => { x.fillStyle = '#6a4526'; x.fillRect(0, 0, w, h); for (let i = 0; i < 90; i++) { x.strokeStyle = `rgba(${30 + Math.random() * 40 | 0},${18 + Math.random() * 20 | 0},8,${0.15 + Math.random() * 0.3})`; x.lineWidth = 1 + Math.random() * 2; x.beginPath(); const X0 = Math.random() * w; x.moveTo(X0, 0); for (let y = 0; y <= h; y += 32) x.lineTo(X0 + Math.sin(y * 0.02 + i) * 3, y); x.stroke(); } });
  const MAT = {
    wood: new THREE.MeshStandardMaterial({ map: woodTex, color: 0xb88a5a, roughness: 0.55, metalness: 0.05 }),
    wrap: new THREE.MeshStandardMaterial({ color: 0x3b2416, roughness: 0.85 }),
    horn: new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.4 }),
    string: new THREE.MeshStandardMaterial({ color: 0xe8e0c8, roughness: 0.7 }),
    shaft: new THREE.MeshStandardMaterial({ color: 0xc8a472, roughness: 0.6 }),
    point: new THREE.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.35, metalness: 0.7 }),
    cock: new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 0.8, side: THREE.DoubleSide }),
    hen: new THREE.MeshStandardMaterial({ color: 0xece6da, roughness: 0.8, side: THREE.DoubleSide }),
    nock: new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.5 }),
  };

  // ---- THE BOW. Bow frame: +Y along the limbs (up = the index knuckle's side), +X the BACK (toward the target), the string
  // on −X; the grip — the fist's tunnel — at the origin. One tube swept tip to tip, rebuilt in place as the limbs bend.
  const RING = 10, NR = 8, NL = 22, NS = 2 * NL + NR + 1;
  const bowGeo = new THREE.BufferGeometry(); { const idx = []; for (let i = 0; i < NS - 1; i++) for (let j = 0; j < RING; j++) { const a = i * RING + j, b = i * RING + (j + 1) % RING, c = a + RING, d = b + RING; idx.push(a, c, b, b, c, d); }
    bowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NS * RING * 3), 3)); bowGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(NS * RING * 2), 2)); bowGeo.setIndex(idx); }
  const bow = new THREE.Group(), bowMesh = new THREE.Mesh(bowGeo, MAT.wood); bow.add(bowMesh);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.12, 14), MAT.wrap); grip.scale.set(1.05, 1, 0.8); grip.position.y = 0.005; bow.add(grip);
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.006, 0.016), MAT.wrap); shelf.position.set(0.004, 0.066, -0.014); bow.add(shelf);   // the arrow's rest, on the archer's side
  const nocks = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.05, 8), MAT.horn); bow.add(m); return m; });
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 6); unitCyl.translate(0, 0.5, 0);
  const strings = [0, 1].map(() => { const m = new THREE.Mesh(unitCyl, MAT.string); bow.add(m); return m; });
  const seg = (m, a, b, r) => { const d = V().subVectors(b, a), L = d.length(); m.position.copy(a); m.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / (L || 1))); m.scale.set(r, L, r); };
  const limbAt = (phi, s) => { const L = A.limb, th = phi * s / L, rho = L / phi; return { x: -rho * (1 - Math.cos(th)), y: A.riser + rho * Math.sin(th), tx: -Math.sin(th), ty: Math.cos(th) }; };
  const tip = phi => limbAt(phi, A.limb);
  const bisect = (f, lo, hi) => { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; } return (lo + hi) / 2; };
  const PHI_B = bisect(p => A.brace - (-tip(p).x), 0.05, 2.5);                 // braced: the tips stand one brace height behind the back
  const HALF = tip(PHI_B).y;                                                    // half the string — kept through the draw
  const phiFor = D => D <= A.brace ? PHI_B : bisect(p => { const t = tip(p); return Math.hypot(t.x + D, t.y) - HALF; }, PHI_B, 2.6);
  const width = s => 0.031 - 0.018 * s, thick = s => 0.028 - 0.015 * s;         // s: 0 at the riser, 1 at the tip
  function bowBuild(phi) {
    const P = bowGeo.getAttribute('position').array, U = bowGeo.getAttribute('uv').array; let k = 0;
    const put = (x, y, tx, ty, w, t, v) => { const nx = ty, ny = -tx; for (let j = 0; j < RING; j++) { const a = j / RING * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a); P[k * 3] = x + nx * c * t / 2; P[k * 3 + 1] = y + ny * c * t / 2; P[k * 3 + 2] = sn * w / 2; U[k * 2] = j / RING; U[k * 2 + 1] = v; k++; } };
    for (let i = NL; i >= 1; i--) { const s = i / NL, p = limbAt(phi, s * A.limb); put(p.x, -p.y, -p.tx, p.ty, width(s), thick(s), 0.5 - 0.5 * (A.riser + s * A.limb) / (A.riser + A.limb)); }   // the lower limb, tip first
    for (let i = 0; i <= NR; i++) { const y = -A.riser + 2 * A.riser * i / NR; put(0.004, y, 0, 1, 0.034, 0.044, 0.5 + 0.5 * y / (A.riser + A.limb)); }
    for (let i = 1; i <= NL; i++) { const s = i / NL, p = limbAt(phi, s * A.limb); put(p.x, p.y, p.tx, p.ty, width(s), thick(s), 0.5 + 0.5 * (A.riser + s * A.limb) / (A.riser + A.limb)); }
    bowGeo.getAttribute('position').needsUpdate = true; bowGeo.getAttribute('uv').needsUpdate = true; bowGeo.computeVertexNormals(); bowGeo.computeBoundingSphere();
    const t = tip(phi), ends = [new THREE.Vector3(t.x - 0.006, t.y - 0.02, 0), new THREE.Vector3(t.x - 0.006, -t.y + 0.02, 0)];
    nocks[0].position.set(t.x, t.y + 0.01, 0); nocks[0].rotation.z = Math.atan2(t.tx, t.ty) * -1; nocks[1].position.set(t.x, -t.y - 0.01, 0); nocks[1].rotation.z = Math.PI + Math.atan2(t.tx, t.ty);
    return ends;
  }

  // ---- AN ARROW: nock at the origin, the point up +Y (laid along its line with one quaternion)
  function makeArrow(L) {
    const g = new THREE.Group();
    const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, L - 0.045, 8), MAT.shaft); sh.position.y = (L - 0.045) / 2 + 0.01; g.add(sh);
    const pt = new THREE.Mesh(new THREE.ConeGeometry(0.0075, 0.045, 4), MAT.point); pt.position.y = L - 0.035 + 0.0225; g.add(pt);
    const nk = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0045, 0.016, 8), MAT.nock); nk.position.y = 0.008; g.add(nk);
    const vane = new THREE.Shape(); vane.moveTo(0, 0); vane.lineTo(0.02, 0.012); vane.lineTo(0.02, 0.105); vane.quadraticCurveTo(0.012, 0.13, 0, 0.13); vane.closePath();
    const vg = new THREE.ShapeGeometry(vane); vg.translate(0.004, 0.03, 0);
    for (let i = 0; i < 3; i++) { const v = new THREE.Mesh(vg, i ? MAT.hen : MAT.cock); v.rotation.y = i * Math.PI * 2 / 3 + Math.PI / 2; g.add(v); }   // the cock feather stands away from the bow
    g.userData.L = L; return g;
  }

  // ---- THE TARGET: a straw boss on an easel, a 10-ring 122 cm face, its middle 1.3 m up, leaning back 12°
  const FACE_R = 0.61, BOSS_R = 0.68, BOSS_T = 0.34, CENTRE_Y = 1.3;
  const faceTex = canvasTex(1024, 1024, (x, w) => { const c = w / 2, px = c / FACE_R * 0.995, RING_W = FACE_R / 10;
    const col = ['#ffffff', '#ffffff', '#231f20', '#231f20', '#00a9e0', '#00a9e0', '#ee2e3a', '#ee2e3a', '#ffe14f', '#ffe14f'];
    for (let i = 0; i < 10; i++) { const rr = (FACE_R - i * RING_W) * px; x.beginPath(); x.arc(c, c, rr, 0, Math.PI * 2); x.fillStyle = col[i]; x.fill(); x.lineWidth = 2; x.strokeStyle = i === 2 || i === 3 ? '#e8e8e8' : '#1a1a1a'; x.stroke(); }
    x.beginPath(); x.arc(c, c, RING_W / 2 * px, 0, Math.PI * 2); x.lineWidth = 1.5; x.strokeStyle = '#6d5a10'; x.stroke(); x.fillStyle = '#333'; x.fillRect(c - 5, c - 1, 10, 2); x.fillRect(c - 1, c - 5, 2, 10); });
  const strawTex = canvasTex(256, 256, (x, w, h) => { x.fillStyle = '#b89a55'; x.fillRect(0, 0, w, h); for (let i = 0; i < 2600; i++) { const a = Math.random() * Math.PI, l = 6 + Math.random() * 22, X = Math.random() * w, Y = Math.random() * h; x.strokeStyle = `rgba(${120 + Math.random() * 110 | 0},${95 + Math.random() * 80 | 0},${40 + Math.random() * 40 | 0},0.7)`; x.lineWidth = 1; x.beginPath(); x.moveTo(X, Y); x.lineTo(X + Math.cos(a) * l, Y + Math.sin(a) * l * 0.35); x.stroke(); } });
  strawTex.wrapS = strawTex.wrapT = THREE.RepeatWrapping;
  const range = new THREE.Group(); range.visible = false; s.add(range);
  const target = new THREE.Group(); range.add(target);
  const boss = new THREE.Group(); boss.position.y = CENTRE_Y; boss.rotation.x = -12 * Math.PI / 180; target.add(boss);   // (boss local +Z = the face's normal, toward the archer once the target is turned)
  { const cyl = new THREE.Mesh(new THREE.CylinderGeometry(BOSS_R, BOSS_R, BOSS_T, 48, 1), [new THREE.MeshStandardMaterial({ map: strawTex, roughness: 1 }), new THREE.MeshStandardMaterial({ map: strawTex, roughness: 1 }), new THREE.MeshStandardMaterial({ map: strawTex, roughness: 1 })]);
    cyl.rotation.x = Math.PI / 2; boss.add(cyl);
    for (const z of [-0.08, 0.08]) { const band = new THREE.Mesh(new THREE.TorusGeometry(BOSS_R + 0.004, 0.01, 6, 48), MAT.wrap); band.position.z = z; boss.add(band); }
    const face = new THREE.Mesh(new THREE.CircleGeometry(FACE_R, 96), new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.9 })); face.position.z = BOSS_T / 2 + 0.003; boss.add(face);
    const leg = (x, z, h, rx) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, h, 0.07), MAT.wood); m.position.set(x, h / 2 * Math.cos(rx), z); m.rotation.x = rx; target.add(m); };
    leg(-0.5, 0.12, 2.0, -0.12); leg(0.5, 0.12, 2.0, -0.12); leg(0, -0.55, 2.0, 0.34);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.07, 0.07), MAT.wood); bar.position.set(0, CENTRE_Y - BOSS_R - 0.03, 0.22); target.add(bar); }
  target.rotation.y = -Math.PI / 2;                                             // its face toward −X: to the archer
  // the ground of the range: sand, a shooting line, a mark every 10 m
  { const sand = new THREE.Mesh(new THREE.PlaneGeometry(90, 14), new THREE.MeshStandardMaterial({ color: 0x5f5646, roughness: 1 })); sand.rotation.x = -Math.PI / 2; sand.position.set(38, -0.004, 0); range.add(sand);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 8), new THREE.MeshBasicMaterial({ color: 0xd8d2c0 })); line.rotation.x = -Math.PI / 2; line.position.set(-0.45, 0, 0); range.add(line);
    for (let d = 10; d <= 70; d += 10) { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 3), new THREE.MeshBasicMaterial({ color: 0x8a8272 })); m.rotation.x = -Math.PI / 2; m.position.set(d, -0.001, 0); range.add(m); } }
  range.add(bow);
  let nocked = null;

  // ---- the man's joints
  const B = n => BONE[n];
  const TOUCH = ['clavL', 'armL', 'foreL', 'handL', 'clavR', 'armR', 'foreR', 'handR', 'neck', 'head'];
  const qW = b => b.getWorldQuaternion(Qn()), pW = b => b.getWorldPosition(V());
  const setWQ = (b, q) => { b.quaternion.copy(qW(b.parent).invert().multiply(q)); b.updateMatrixWorld(true); };
  const turnW = (b, dq) => setWQ(b, dq.clone().multiply(qW(b)));
  let FIST = null, JAW = null;
  function readFists() {                                                         // the fist's own lines and its tunnel, in the hand's frame (fingers as the rest pose closes them)
    for (const n of TOUCH) { const r0 = REST.get(n); if (B(n) && r0) { B(n).quaternion.copy(r0.q); B(n).position.copy(r0.p); } } M.root.updateMatrixWorld(true);
    FIST = {};
    for (const sd of ['L', 'R']) {
      const h = B('hand' + sd), inv = qW(h).invert(), hp = pW(h);
      // what a finger IS, what the rig calls it (tools/realmesh/base/grip.js FINGERS): the index is 'pinky', from joint 0; the little finger 'middle', from 1
      const chains = [['pinky', 0], ['ring', 1], ['index', 1], ['middle', 1]].map(([nm, k0]) => [0, 1, 2].map(k => B(nm + sd + (k0 + k))).filter(Boolean));
      const pts = []; for (const ch of chains) { const P = ch.map(pW); P.forEach(p => pts.push(p)); if (P.length > 1) pts.push(P[P.length - 1].clone().lerp(P[P.length - 2], -0.8)); }
      const C = pts.reduce((a, p) => a.add(p), V()).multiplyScalar(1 / pts.length);
      const g = pW(chains[0][0]).sub(pW(chains[3][0])).normalize();                // little knuckle → index knuckle
      const kn = chains.reduce((a, ch) => a.add(pW(ch[0])), V()).multiplyScalar(0.25), d = kn.sub(hp); d.addScaledVector(g, -d.dot(g)).normalize();
      FIST[sd] = { g: g.applyQuaternion(inv), d: d.applyQuaternion(inv), c: h.worldToLocal(C.clone()) };
      FIST[sd].n = FIST[sd].g.clone().cross(FIST[sd].d);
    }
    const hd = B('head'), hp = pW(hd); JAW = hd.worldToLocal(hp.clone().add(new THREE.Vector3(-0.05, -0.075, 0.095)));   // the corner of the jaw, right side (bind: he faces +Z, his right is −X)
    const len = (a, b) => pW(B(a)).distanceTo(pW(B(b)));
    A.armLen = { L: [len('armL', 'foreL'), len('foreL', 'handL')], R: [len('armR', 'foreR'), len('foreR', 'handR')] };
  }
  const fistQ = (sd, gw, dw) => { const F = FIST[sd], d = dw.clone().addScaledVector(gw, -dw.dot(gw)).normalize(), n = gw.clone().cross(d);   // the hand turned so its fist's lines lie on (gw, dw)
    const Ml = new THREE.Matrix4().makeBasis(F.g, F.d, F.n), Mw = new THREE.Matrix4().makeBasis(gw, d, n); return Qn().setFromRotationMatrix(Mw.multiply(Ml.transpose())); };
  function ik(sd, wrist, pole) {
    const arm = B('arm' + sd), fore = B('fore' + sd), hand = B('hand' + sd), [a, b] = A.armLen[sd];
    const S = pW(arm), T = wrist.clone().sub(S), dd = Math.min(Math.max(T.length(), 0.05), (a + b) * 0.999), u = T.normalize();
    const cosA = Math.min(1, Math.max(-1, (a * a + dd * dd - b * b) / (2 * a * dd))), v = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
    const E = S.clone().addScaledVector(u, a * cosA).addScaledVector(v, a * Math.sqrt(1 - cosA * cosA));
    turnW(arm, Qn().setFromUnitVectors(pW(fore).sub(S).normalize(), E.sub(S).normalize())); arm.updateMatrixWorld(true);
    const E1 = pW(fore); turnW(fore, Qn().setFromUnitVectors(pW(hand).sub(E1).normalize(), S.clone().addScaledVector(u, dd).sub(E1).normalize()));
  }
  function seatHand(sd, q) {                                                     // the hand's turn, half of its twist taken up by the forearm (no candy-wrapper wrist)
    const fore = B('fore' + sd), hand = B('hand' + sd); setWQ(hand, q);
    const ax = hand.position.clone().normalize(), rel = hand.quaternion.clone(), p = ax.dot(new THREE.Vector3(rel.x, rel.y, rel.z));
    const tw = new THREE.Quaternion(ax.x * p, ax.y * p, ax.z * p, rel.w).normalize(), half = Qn().slerp(tw, 0.5);
    fore.quaternion.multiply(half); fore.updateMatrixWorld(true); setWQ(hand, q);
  }
  const aimDir = (e, a) => new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));

  // ---- each frame, before the editor draws: the stance, the bow, the string, the arrows
  function stance(dt) {
    for (const n of TOUCH) { const r0 = REST.get(n); if (B(n) && r0) B(n).quaternion.copy(r0.q); } M.root.updateMatrixWorld(true);
    const Y = n => Qn().setFromAxisAngle(UP, n);
    turnW(B('neck'), Y(0.62)); turnW(B('head'), Y(0.78)); turnW(B('head'), Qn().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.06));   // turned to the target, cheek down onto the string
    const anchor = B('head').localToWorld(JAW.clone());
    const e = A.cmdE, dir = aimDir(e, A.cmdA), bup = UP.clone().addScaledVector(dir, -dir.dot(UP)).normalize();
    // the bow fist: on the arrow line one reach out — the rest (5.5 cm over the tunnel) on the line, the arm all but straight
    const SL = pW(B('armL')), reach = (A.armLen.L[0] + A.armLen.L[1]) * 0.975 + FIST.L.c.length() * 0.8, P0 = anchor.clone().addScaledVector(bup, -0.062).sub(SL);
    const bq = P0.dot(dir), t = -bq + Math.sqrt(Math.max(0, bq * bq - (P0.lengthSq() - reach * reach)));
    A.full = t; const tunnelL = anchor.clone().addScaledVector(dir, t).addScaledVector(bup, -0.062);
    const qL = fistQ('L', bup, dir); ik('L', tunnelL.clone().sub(FIST.L.c.clone().applyQuaternion(qL)), new THREE.Vector3(0, -0.6, -1)); seatHand('L', qL);
    // the draw fist: the string in its tunnel, back along the line from brace to the anchor; after the loose it runs on past the jaw
    const k = A.draw, follow = A.snap > 0 ? Math.min(1, A.snap / 0.15) * 0.07 : 0;
    const back = A.brace + 0.02 + (t - A.brace - 0.02) * k + follow;
    const tunnelR = anchor.clone().addScaledVector(dir, t - back).addScaledVector(bup, -0.012);
    const qR = fistQ('R', bup, dir); ik('R', tunnelR.clone().sub(FIST.R.c.clone().applyQuaternion(qR)), new THREE.Vector3(-0.35, 0.35, 1)); seatHand('R', qR);
    M.root.updateMatrixWorld(true);
    // the bow in the left fist, as the fist actually came out
    const hL = B('handL'), qh = qW(hL), gw = FIST.L.g.clone().applyQuaternion(qh), dw = FIST.L.d.clone().applyQuaternion(qh); dw.addScaledVector(gw, -dw.dot(gw)).normalize();
    bow.position.copy(hL.localToWorld(FIST.L.c.clone())); bow.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dw, gw, dw.clone().cross(gw))); bow.updateMatrixWorld(true);
    const hR = B('handR'), nockW = hR.localToWorld(FIST.R.c.clone()).addScaledVector(gw, 0.012), nockB = bow.worldToLocal(nockW.clone());
    const free = A.snap > 0 || !nocked || A.renock > 0, D = free ? A.brace : Math.max(A.brace, -nockB.x);
    const ends = bowBuild(phiFor(D));
    let mid;
    if (free) { const wob = A.snap > 0 ? Math.sin(A.snap * 90) * A.snap * 0.08 : 0; mid = new THREE.Vector3(-A.brace + wob, 0.02, 0); }
    else mid = new THREE.Vector3(Math.min(-A.brace, nockB.x), nockB.y, nockB.z);
    seg(strings[0], ends[1], mid, 0.0032); seg(strings[1], mid, ends[0], 0.0032);
    // the arrow on the string: nock in the string, shaft over the rest
    if (nocked) { nocked.visible = A.renock <= 0; const nk = bow.localToWorld(mid.clone().setZ(-0.004)), rest = bow.localToWorld(new THREE.Vector3(0.004, 0.072, -0.014)); nocked.position.copy(nk); nocked.quaternion.setFromUnitVectors(UP, rest.clone().sub(nk).normalize()); A.drawn = D; }
    return dir;
  }
  // the aim: the elevation that puts a full-draw arrow in the gold, found by the lob formula and then servoed on the arrow's
  // ACTUAL line (the arms land where they can, not exactly where they were asked), so what you see is what flies
  function aimFor() {
    const T = boss.localToWorld(new THREE.Vector3(0, 0, BOSS_T / 2)), P = nocked ? nocked.position : new THREE.Vector3(0, 1.7, 0), x = Math.hypot(T.x - P.x, T.z - P.z), y = T.y - P.y, v = A.vmax, g = A.g;
    const disc = v ** 4 - g * (g * x * x + 2 * y * v * v); return { e: disc < 0 ? Math.PI / 4 : Math.atan((v * v - Math.sqrt(disc)) / (g * x)), a: Math.atan2(T.z - P.z, T.x - P.x) };
  }
  function arrowLine() { if (!nocked) return null; const d = UP.clone().applyQuaternion(nocked.quaternion); return { e: Math.asin(Math.max(-1, Math.min(1, d.y))), a: Math.atan2(d.z, d.x), d }; }

  function loose() {
    if (!nocked || A.renock > 0 || A.snap > 0) return false;
    const k = Math.max(0, Math.min(1, (A.drawn - A.brace) / Math.max(0.05, A.full - A.brace)));
    if (k < 0.15) { A.want = 0; return false; }
    const a = nocked; nocked = null; const d = UP.clone().applyQuaternion(a.quaternion);
    a.userData.v = d.multiplyScalar(A.vmax * Math.sqrt(k)); a.userData.t = 0; A.flying.push(a); A.loosed++;
    A.snap = 0.45; A.draw = 0; A.want = 0; A.hold = 0; A.renock = 0.9;
    if (A.follow) { A.camBack = { az, el, dist, t: tgt.clone() }; A.chase = a; }
    try { const ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createBufferSource(), n = ac.sampleRate * 0.12, buf = ac.createBuffer(1, n, ac.sampleRate), ch = buf.getChannelData(0); for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / n * 9) * 0.5 + Math.sin(i / ac.sampleRate * 2 * Math.PI * 180) * Math.exp(-i / n * 14) * 0.6; o.buffer = buf; o.connect(ac.destination); o.start(); setTimeout(() => ac.close(), 400); } catch (e) {}
    return true;
  }
  function score(local) { const r = Math.hypot(local.x, local.y); if (r > FACE_R) return { r, pts: 0, say: 'straw' }; const ring = 10 - Math.floor(r / (FACE_R / 10)); return { r, pts: ring, say: r < FACE_R / 20 ? 'X' : String(ring) }; }
  function fly(dt) {
    for (const a of A.flying.slice()) {
      const u = a.userData, N = 6, h = dt / N;
      for (let i = 0; i < N; i++) {
        const p0 = a.position.clone(); u.v.y -= A.g * h; a.position.addScaledVector(u.v, h); u.t += h;
        const L = u.L, tipW0 = p0.clone().addScaledVector(u.v.clone().normalize(), L), tipW1 = a.position.clone().addScaledVector(u.v.clone().normalize(), L);
        const b0 = boss.worldToLocal(tipW0.clone()), b1 = boss.worldToLocal(tipW1.clone()), fz = BOSS_T / 2 + 0.003;
        let hit = null;
        if (b0.z >= fz && b1.z < fz) { const f = (b0.z - fz) / (b0.z - b1.z), at = b0.clone().lerp(b1, f); if (Math.hypot(at.x, at.y) < BOSS_R) hit = { at, where: score(at) }; }
        if (hit) { const into = 0.12 + 0.12 * Math.min(1, u.v.length() / A.vmax), vd = u.v.clone().normalize(); a.position.copy(boss.localToWorld(hit.at.clone())).addScaledVector(vd, into - L); boss.attach(a); stick(a, hit.where); break; }
        if (tipW1.y <= 0.0 || u.t > 6) { a.position.addScaledVector(u.v.clone().normalize(), -0.1); stick(a, { pts: 0, say: tipW1.y <= 0 ? 'in the sand' : 'lost' }); break; }
        a.quaternion.setFromUnitVectors(UP, u.v.clone().normalize());
      }
    }
  }
  function stick(a, w) { A.flying.splice(A.flying.indexOf(a), 1); A.stuck.push(a); A.ends.push(w); if (A.chase === a) { A.chase = null; A.lookT = 1.4; A.lastHit = a; } say(); }
  function pull() { for (const a of A.stuck.concat(A.flying)) a.parent && a.parent.remove(a); A.stuck = []; A.flying = []; A.ends = []; say(); }
  function say() {
    const pts = A.ends.reduce((a, w) => a + w.pts, 0), last = A.ends[A.ends.length - 1];
    const r = aimFor(), line = arrowLine();
    el$('ar_say').textContent = (last ? 'last: ' + last.say + (last.r != null ? '  (' + (last.r * 100).toFixed(0) + ' cm off the middle)' : '') + '\n' : '') + 'this end: ' + A.ends.map(w => w.say).join(' · ') + (A.ends.length ? '  = ' + pts : '—') +
      '\ndraw length ' + ((A.full || 0) * 100).toFixed(0) + ' cm · ' + A.vmax + ' m/s full' + (line ? '\nline ' + (line.e * 180 / Math.PI).toFixed(1) + '° · gold wants ' + (r.e * 180 / Math.PI).toFixed(1) + '°' : '');
  }

  // ---- the lens
  function view(v) {
    A.view = v; const T = s => tgt.set(...s);
    if (v === 'side') { T([0.4, 1.3, 0]); az = 0; el = 4 * Math.PI / 180; dist = 5.2; }
    if (v === 'front') { T([0.2, 1.5, 0]); az = 60 * Math.PI / 180; el = 6 * Math.PI / 180; dist = 3.6; }
    if (v === 'behind') { T([2.6, 1.55, 0.1]); az = -90 * Math.PI / 180; el = 5 * Math.PI / 180; dist = 4.2; }
    if (v === 'bow') { T([0.55, 1.62, 0.08]); az = 25 * Math.PI / 180; el = 8 * Math.PI / 180; dist = 1.7; }
    if (v === 'target') { const p = boss.localToWorld(new THREE.Vector3()); T([p.x, p.y, p.z]); az = -90 * Math.PI / 180; el = 3 * Math.PI / 180; dist = 3.2; }
    document.querySelectorAll('[data-av]').forEach(b => b.classList.toggle('on', b.dataset.av === v)); cam();
  }
  function chaseCam(dt) {
    if (A.chase) { const a = A.chase, v = a.userData.v.clone().normalize(); tgt.copy(a.position).addScaledVector(v, 0.6); const back = v.clone().multiplyScalar(-1); az = Math.atan2(back.x, back.z) + 0.25; el = 0.12; dist = 1.8; cam(); return; }
    if (A.lookT > 0) { A.lookT -= dt; const p = A.lastHit.getWorldPosition(V()); tgt.lerp(p, Math.min(1, dt * 6)); dist += (1.6 - dist) * Math.min(1, dt * 4); cam(); if (A.lookT <= 0 && A.camBack) { az = A.camBack.az; el = A.camBack.el; dist = A.camBack.dist; tgt.copy(A.camBack.t); A.camBack = null; cam(); } }
  }

  // ---- on / off, and the frame
  let armed = false, prev = performance.now();
  function setOn(on) {
    A.on = on; el$('ar_on').checked = on; el$('ar_box').style.display = on ? '' : 'none'; range.visible = on;
    if (on) { if (!FIST) readFists(); if (typeof cbStop === 'function') cbStop(); if (MO.clip && typeof setMotion === 'function') setMotion(''); preset(0, 10, 'p_bind');
      if (!nocked) { nocked = makeArrow(0.95); range.add(nocked); } setDist(A.dist); view(A.view); }
    else { restPose(); }
    applyShow();
  }
  function setDist(d) { A.dist = d; target.position.set(d, 0, 0); el$('ar_vd').textContent = d + ' m'; el$('ar_dist').value = d; }
  const origRender = r.render.bind(r);
  r.render = (sc, ca) => {
    if (A.on && M && FIST) {
      const now = performance.now(), dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      if (A.hold > 0) { A.hold -= dt; if (A.hold <= 0) loose(); }
      if (A.draw < A.want) A.draw = Math.min(A.want, A.draw + dt / 1.25 * (1.15 - A.draw * 0.6)); else if (A.draw > A.want) A.draw = Math.max(A.want, A.draw - dt / 0.5);
      if (A.snap > 0) A.snap = Math.max(0, A.snap - dt);
      if (A.renock > 0) { A.renock -= dt; if (A.renock <= 0 || !nocked) { if (!nocked) { nocked = makeArrow(Math.max(0.8, (A.full || 0.9) + 0.06)); range.add(nocked); } A.renock = Math.max(0, A.renock); } }
      if (A.auto) { for (let i = 0; i < 2; i++) { stance(dt); const w = aimFor(), l = arrowLine(); if (!l) break; A.cmdE += (w.e - l.e) * 0.8; A.cmdA += (w.a - l.a) * 0.8; } A.elev = A.cmdE; el$('ar_elev').value = Math.round(A.elev * 1800 / Math.PI); }
      else { A.cmdE = A.elev; A.cmdA = 0; }
      stance(dt); fly(dt); chaseCam(dt);
      el$('ar_vk').textContent = Math.round(A.draw * 100) + '%'; el$('ar_draw').value = Math.round(A.draw * 100); { const l = arrowLine(); el$('ar_ve').textContent = (l ? l.e * 180 / Math.PI : 0).toFixed(1) + '° (the arrow\'s line)'; }
      for (const m of ALL()) if (/sword|shield/i.test(m.name)) m.visible = false;
      if (!armed || (now | 0) % 20 === 0) say(); armed = true;
    } else prev = performance.now();
    origRender(sc, ca);
  };

  // ---- controls
  el$('ar_on').onchange = e => setOn(e.target.checked);
  el$('ar_dist').oninput = e => setDist(+e.target.value);
  el$('ar_draw').oninput = e => { A.want = A.draw = +e.target.value / 100; };
  el$('ar_elev').oninput = e => { A.auto = false; el$('ar_auto').checked = false; A.elev = +e.target.value / 10 * Math.PI / 180; };
  el$('ar_auto').onchange = e => { A.auto = e.target.checked; };
  el$('ar_follow').onchange = e => { A.follow = e.target.checked; };
  el$('ar_shoot').onclick = () => { A.want = 1; A.hold = 2.1; };
  el$('ar_loose').onclick = () => loose();
  el$('ar_pull').onclick = pull;
  document.querySelectorAll('[data-av]').forEach(b => b.onclick = () => view(b.dataset.av));
  addEventListener('keydown', e => { if (!A.on || e.code !== 'Space' || e.repeat) return; e.preventDefault(); A.want = 1; A.hold = 0; });
  addEventListener('keyup', e => { if (!A.on || e.code !== 'Space') return; e.preventDefault(); if (!loose()) A.want = 0; });

  window.__arch = o => { o = o || {}; if (o.on != null) setOn(!!o.on); if (o.dist != null) setDist(o.dist); if (o.draw != null) A.want = A.draw = o.draw; if (o.elev != null) { A.auto = false; A.elev = o.elev * Math.PI / 180; } if (o.auto != null) A.auto = !!o.auto; if (o.follow != null) A.follow = !!o.follow; if (o.view) view(o.view); return { draw: A.draw, full: A.full, elev: A.elev * 180 / Math.PI, ends: A.ends.map(w => w.say) }; };
  window.__loose = loose; window.__pull = pull;
  const start = () => { if (!window.__ready) return setTimeout(start, 100); if (new URLSearchParams(location.search).get('archery')) setOn(true); };
  start();
})();
