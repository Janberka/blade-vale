// THE SWORD IN HIS FIST. The kit's sword is bound rigidly to handR but still stands where the OLD warrior's hand held it —
// upright, 10 cm off the wrist, nowhere near the palm. This seats it from the geometry and writes the seat for the editor:
//   node tools/realmesh/base/grip.js [clip id = angry_walk] [--gap 1.0] [--tilt 0] [--turn 0] [--push 0]   → tools/chared/items/sword_grip.json
//   node tools/realmesh/base/grip.js --bake     …and INTO THE GAME: assets/rigs/base gets the seated sword, a closed fist
//                                               and rig.json.grip (see THE BAKE at the foot of this file)
//
// HOW. The fist is taken from a clip that closes it (the fingers' local turns, laid on the hand in its BIND pose — the sword
// rides the hand bone, so a seat found there holds in every pose). Each finger then makes a loop round the handle: knuckle,
// second joint, third joint, fingertip (the tip = the farthest skin vertex the last bone carries). The centre of a loop is a
// point on the handle's line; the four of them, little finger → index, give the line and its middle. The sword gives its own:
// long axis by PCA, the guard where its radius jumps, the flat of the blade by PCA across it. The grip is laid along the
// fist's line, blade out of the THUMB side, guard `gap` cm clear of the index finger, the blade's flat square to the
// forearm-to-knuckles line (so an edge leads a cut the way the knuckles point). Fingers go by what they ARE (motion.js PHYS).
// Knobs for the eye: --tilt (deg, blade toward/away from the knuckles), --turn (deg, about the handle), --push (cm, along it).
const fs = require('fs'), path = require('path');
const THREE = require('../../../vendor/three.min.js'), IO = require('./gltfio.js');
const ROOT = path.join(__dirname, '..', '..', '..'), RIG = path.join(ROOT, 'assets', 'rigs', 'base'), CHARED = path.join(ROOT, 'tools', 'chared');
const V3 = THREE.Vector3, Q4 = THREE.Quaternion, M4 = THREE.Matrix4;
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = +args[i + 1]; args.splice(i, 2); return v; };
const BAKE = args.includes('--bake'); if (BAKE) args.splice(args.indexOf('--bake'), 1);
const GEAR = args.includes('--gear'); if (GEAR) args.splice(args.indexOf('--gear'), 1);   // only (re)write where a LOADOUT sword sits in the fist — rig.json.grip.sword.at/axis/flat — and touch nothing else
const GAP = flag('gap', 1.0) / 100, TILT = flag('tilt', 0) * Math.PI / 180, TURN = flag('turn', 0) * Math.PI / 180, PUSH = flag('push', 0) / 100, clipId = args[0] || 'angry_walk';
const SIDE = 'R', HAND = 'hand' + SIDE, FINGERS = [['index', 'pinky', 0], ['middle', 'ring', 1], ['ring', 'index', 1], ['little', 'middle', 1]];   // what it IS, what the rig calls it, where its knuckle is in the chain

const R = IO.read(RIG), W = IO.bindWorlds(R), ix = nm => R.names.indexOf(nm), rig = JSON.parse(fs.readFileSync(path.join(RIG, 'rig.json')));
const HAND_ZERO = { R: [-30, 51, 40], L: [0, 0, 0] };            // the user's own numbers — kept in step with motion.js
const wm = nm => new M4().fromArray(W[ix(nm)]), rot = m => new Q4().setFromRotationMatrix(new M4().extractRotation(m)), posOf = m => new V3().setFromMatrixPosition(m);
const clip = JSON.parse(fs.readFileSync(path.join(CHARED, 'motions', clipId + '.json')));
// the hand's own three lines, in its own frame — the SAME ones the editor's sliders turn about and motion.js bakes
// (t: little knuckle → index knuckle, d: out to the middle knuckle square to t, n = t × d), so a number set by eye there
// means the same turn here and in the game.
function handAxes(sd) { const h = 'hand' + sd, inv = rot(wm(h)).invert();
  const t = posOf(wm('pinky' + sd + '0')).sub(posOf(wm('middle' + sd + '1'))).normalize();
  const d = posOf(wm('ring' + sd + '1')).sub(posOf(wm(h))); d.addScaledVector(t, -d.dot(t)).normalize();
  return { t: t.clone().applyQuaternion(inv), d: d.clone().applyQuaternion(inv), n: t.clone().cross(d).normalize().applyQuaternion(inv) }; }

// ---- the fist, in bind space: the hand where the rig binds it, the fingers as the clip curls them (mean over the clip)
const restLocalQ = nm => rot(wm(R.names[R.parent[ix(nm)]]).invert().multiply(wm(nm))), restLocalP = nm => posOf(wm(R.names[R.parent[ix(nm)]]).invert().multiply(wm(nm)));
const clipQ = (nm, f) => { const k = clip.bones.indexOf(nm); return k < 0 ? restLocalQ(nm) : new Q4().fromArray(clip.q[k], f * 4); };
const body = R.meshes.find(m => m.name === rig.meshes.body), tipOf = nm => { const j = body.joints.indexOf(ix(nm)), o = posOf(wm(nm)); let far = null, fd = -1;   // the fingertip: the farthest vertex the last bone leads
  for (let v = 0; v < body.pos.length / 3; v++) { let bw = 0, bj = -1; for (let k = 0; k < 4; k++) if (body.w[v * 4 + k] > bw) { bw = body.w[v * 4 + k]; bj = body.ji[v * 4 + k]; } if (bj !== j) continue; const p = new V3(body.pos[v * 3], body.pos[v * 3 + 1], body.pos[v * 3 + 2]), d = p.distanceTo(o); if (d > fd) { fd = d; far = p; } }
  return far.applyMatrix4(wm(nm).invert()); };                                                       // …in that bone's own frame
const loops = FINGERS.map(([is, named, k0]) => { const chain = [0, 1, 2].map(k => named + SIDE + (k0 + k)), tipL = tipOf(chain[2]), sum = [0, 1, 2, 3].map(() => new V3());
  for (let f = 0; f < clip.frames; f++) { let q = rot(wm(HAND)), p = posOf(wm(HAND)); const up = []; let b = chain[0]; while (R.names[R.parent[ix(b)]] !== HAND) { b = R.names[R.parent[ix(b)]]; up.unshift(b); }   // a metacarpal between the hand and the knuckle
    for (const nm of up.concat(chain)) { p = p.clone().add(restLocalP(nm).applyQuaternion(q)); q = q.clone().multiply(clipQ(nm, f)); const at = chain.indexOf(nm); if (at >= 0) sum[at].add(p); }
    sum[3].add(tipL.clone().applyQuaternion(q).add(p)); }
  const pts = sum.map(s => s.multiplyScalar(1 / clip.frames)), c = pts.reduce((a, p) => a.add(p), new V3()).multiplyScalar(0.25);
  return { is, pts, c, r: pts.reduce((a, p) => a + p.distanceTo(c), 0) / 4 }; });
const C = loops.reduce((a, l) => a.add(l.c), new V3()).multiplyScalar(0.25), axis = loops[0].c.clone().sub(loops[3].c).normalize();   // little finger → index: the blade leaves by the thumb
const wrist = posOf(wm(HAND)), knuckles = loops.reduce((a, l) => a.add(l.pts[0]), new V3()).multiplyScalar(0.25), distal = knuckles.clone().sub(wrist); distal.addScaledVector(axis, -distal.dot(axis)).normalize();
const flatH = axis.clone().cross(distal).normalize();

// ---- the sword, as it lies in the file
const sw = R.meshes.find(m => m.name === rig.meshes.sword), n = sw.pos.length / 3, P = []; for (let i = 0; i < n; i++) P.push(new V3(sw.pos[i * 3], sw.pos[i * 3 + 1], sw.pos[i * 3 + 2]));
const pca = (pts, skip) => { const c = pts.reduce((a, p) => a.add(p), new V3()).multiplyScalar(1 / pts.length), cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { const d = p.clone().sub(c); if (skip) d.addScaledVector(skip, -d.dot(skip)); const a = d.toArray(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += a[i] * a[j]; }
  let v = new V3(0.31, 0.72, 0.62); for (let it = 0; it < 200; it++) { v = new V3(cov[0][0] * v.x + cov[0][1] * v.y + cov[0][2] * v.z, cov[1][0] * v.x + cov[1][1] * v.y + cov[1][2] * v.z, cov[2][0] * v.x + cov[2][1] * v.y + cov[2][2] * v.z); if (skip) v.addScaledVector(skip, -v.dot(skip)); v.normalize(); } return { c, v }; };
const { c: sc, v: L0 } = pca(P), s0 = P.map(p => p.clone().sub(sc).dot(L0)), rad = P.map((p, i) => p.clone().sub(sc).addScaledVector(L0, -s0[i]).length());
const widest = rad.indexOf(Math.max(...rad)), sMid = (Math.min(...s0) + Math.max(...s0)) / 2, L = s0[widest] < sMid ? L0.clone() : L0.clone().negate();   // the guard sits toward the pommel: the blade is the long side
const s = P.map(p => p.clone().sub(sc).dot(L)), sG = s[widest];
const guardLow = Math.min(...s.filter((_, i) => rad[i] > 0.05)), grip = P.filter((_, i) => s[i] < guardLow - 0.005), gripR = Math.max(...P.map((_, i) => s[i] < guardLow - 0.01 && s[i] > guardLow - 0.12 ? rad[i] : 0));
const sPommel = Math.min(...s), blade = P.filter((_, i) => s[i] > sG + 0.05), widthDir = pca(blade, L).v, flatS = L.clone().cross(widthDir).normalize();

// ---- the seat: grip along the fist's line, the guard `gap` clear of the index finger's loop, flat square to wrist→knuckles
const fingerHalf = 0.012, along = (loops[0].c.clone().sub(C)).dot(axis);                         // the index loop's place on the line, from the middle
const sAtC = guardLow - GAP - fingerHalf - along + PUSH, O = sc.clone().addScaledVector(L, sAtC);
const basis = (a, f) => new M4().makeBasis(a, f, a.clone().cross(f)), pick = [flatH, flatH.clone().negate()].map(f => basis(axis, f).multiply(basis(L, flatS).transpose())).map(m => ({ m, ang: rot(m).angleTo(new Q4()) })).sort((a, b) => a.ang - b.ang)[0];   // a blade has two flats: take the smaller turn
let Rm = pick.m; Rm = new M4().makeRotationAxis(axis, TURN).multiply(new M4().makeRotationAxis(flatH, TILT)).multiply(Rm);
const seat = new M4().makeTranslation(C.x, C.y, C.z).multiply(Rm).multiply(new M4().makeTranslation(-O.x, -O.y, -O.z));
const out = { mesh: sw.name, bone: HAND, clip: clipId, knobs: { gap: GAP * 100, tilt: TILT * 180 / Math.PI, turn: TURN * 180 / Math.PI, push: PUSH * 100 }, matrix: seat.elements.map(x => +x.toFixed(6)),
  note: 'bind-space seat of the sword in the fist (tools/realmesh/base/grip.js): applied by the char editor at load; to be baked into assets/rigs/base once signed off' };
fs.writeFileSync(path.join(CHARED, 'items', 'sword_grip.json'), JSON.stringify(out, null, 1));

// ---- THE BAKE: the same seat into the game's own rig, so a fighter holds his sword right in the arena, not only here.
// Three things go in, and none of them touches the bind pose (the skinning is unchanged):
//   1. the SWORD's vertices take the seat — `mSword` in game.js is this very mesh, so it lands in his fist;
//   2. the FINGERS' node matrices take the fist the clip closes (mean over the clip). game.js already prefers a hand
//      bone's node matrix over its bind ("the model was saved gripping") — the base was saved with an OPEN hand, so the
//      game showed splayed fingers round a hilt. Writing the fist there closes it with no game code at all;
//   3. rig.json.grip carries the seat and the hand's own turn: the seat so `modelPropGeo` can UNDO it for the props it
//      detaches from the hand (the sheathed blade at the hip, the shop's), which are placed in the old bind orientation
//      and must not move; the turn (the user's −30 / 51 / 40) so the drive can lay it on the sword hand.
function bake() {
  const gl = JSON.parse(fs.readFileSync(path.join(RIG, 'scene.gltf'), 'utf8')), buf = fs.readFileSync(path.join(RIG, 'scene.bin'));
  const node = gl.nodes.find(n => n.name === sw.name), prim = gl.meshes[node.mesh].primitives[0];
  const put = (accIx, xf) => { const a = gl.accessors[accIx], bv = gl.bufferViews[a.bufferView], base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < a.count; i++) { const o = base + i * 12, p = new V3(buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8));
      xf(p); buf.writeFloatLE(p.x, o); buf.writeFloatLE(p.y, o + 4); buf.writeFloatLE(p.z, o + 8);
      for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], p.getComponent ? p.getComponent(c) : p.toArray()[c]); mx[c] = Math.max(mx[c], p.toArray()[c]); } }
    if (a.min) { a.min = mn; a.max = mx; } };                                        // (POSITION carries min/max and glTF wants them right)
  put(prim.attributes.POSITION, p => p.applyMatrix4(seat));
  const N = new THREE.Matrix3().getNormalMatrix(seat); if (prim.attributes.NORMAL != null) put(prim.attributes.NORMAL, p => p.applyMatrix3(N).normalize());
  // the fist: every bone under either hand takes its mean local turn over the clip (quaternions summed sign-aligned)
  let fists = 0; for (const hand of [HAND, 'hand' + (SIDE === 'R' ? 'L' : 'R')]) { const kids = []; (function down(nm) { R.names.forEach((n, i) => { if (R.parent[i] === ix(nm)) { kids.push(n); down(n); } }); })(hand);
    for (const nm of kids) { const k = clip.bones.indexOf(nm); if (k < 0) continue; const acc = new Q4(0, 0, 0, 0), q = new Q4();
      for (let f = 0; f < clip.frames; f++) { q.fromArray(clip.q[k], f * 4); if (acc.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); acc.set(acc.x + q.x, acc.y + q.y, acc.z + q.z, acc.w + q.w); }
      acc.normalize(); const n = gl.nodes[ix(nm)]; n.matrix = new M4().compose(restLocalP(nm), acc, new V3(1, 1, 1)).elements.map(x => +x.toFixed(6)); fists++; } }
  fs.writeFileSync(path.join(RIG, 'scene.bin'), buf); fs.writeFileSync(path.join(RIG, 'scene.gltf'), JSON.stringify(gl));
  const zero = HAND_ZERO[SIDE], ax = handAxes(SIDE), m = SIDE === 'L' ? -1 : 1, D = Math.PI / 180;
  const turn = new Q4().setFromAxisAngle(ax.d, zero[2] * D * m).multiply(new Q4().setFromAxisAngle(ax.n, zero[1] * D)).multiply(new Q4().setFromAxisAngle(ax.t, zero[0] * D * m));
  rig.grip = { sword: { hand: HAND, seat: seat.elements.map(x => +x.toFixed(6)), turn: turn.toArray().map(x => +x.toFixed(6)), deg: zero,
    note: 'grip.js --bake: the sword mesh carries `seat` already (modelPropGeo UNDOES it for a prop taken off the hand); `turn` is the hand\'s own, laid on the sword hand by syncModelRigs' } };
  fs.writeFileSync(path.join(RIG, 'rig.json'), JSON.stringify(rig, null, 1));
  console.log(`BAKED into ${path.relative(ROOT, RIG)}: the sword seated, ${fists} finger bones closed into the fist, rig.json.grip (turn ${zero.join(' / ')}°)`);
  console.log(`  now: modelPropGeo undoes the seat for the hip blade, syncModelRigs lays the turn on ${HAND} — and bump game.js?v=`);
}

const cm = x => (x * 100).toFixed(1), v = a => a.toArray().map(x => +x.toFixed(2)).join(', ');
console.log(`fist (${clipId}): loop centres index→little ${loops.map(l => '[' + l.c.toArray().map(cm).join(' ') + ']').join(' ')} cm · loop radius ${loops.map(l => cm(l.r)).join(' / ')} cm`);
console.log(`  handle line ${v(axis)} (bind space) · its middle ${C.toArray().map(cm).join(' ')} · knuckles face ${v(distal)} · span index↔little ${cm(loops[0].c.distanceTo(loops[3].c))} cm`);
console.log(`sword: ${cm(Math.max(...s) - sPommel)} cm, grip ${cm(guardLow - sPommel)} cm from pommel end to guard, grip radius ${cm(gripR)} cm, was ${cm(posOf(wm(HAND)).clone().sub(sc).addScaledVector(L, -posOf(wm(HAND)).clone().sub(sc).dot(L)).length())} cm off the wrist, pointing ${v(L)}`);
// A LOADOUT sword (game.js afBuildSword: grip along its own +Y about the origin, flat facing its Z, guard 0.2 game units up)
// is not this mesh, so the seat cannot be baked into it — the game mounts it on the hand bone, and used to pin its origin to
// the bone itself: the WRIST, a hand's length short of the fist. So the fist is handed over in the HAND's own frame:
// `at` the middle of the handle's line, `axis` the way the blade leaves, `flat` the blade's flat — game.js lays the sword on them.
if (GEAR || BAKE) { const hw = wm(HAND), inv = rot(hw).invert(), r5 = a => a.toArray().map(x => +x.toFixed(5));
  const live = JSON.parse(fs.readFileSync(path.join(RIG, 'rig.json'))); live.grip = live.grip || {}; live.grip.sword = live.grip.sword || { hand: HAND };
  Object.assign(live.grip.sword, { at: r5(C.clone().applyMatrix4(hw.clone().invert())), axis: r5(axis.clone().applyQuaternion(inv)), flat: r5(flatH.clone().applyQuaternion(inv)), reach: +(along + fingerHalf + GAP).toFixed(5) });
  if (!BAKE) { fs.writeFileSync(path.join(RIG, 'rig.json'), JSON.stringify(live, null, 1)); console.log('GEAR: rig.json.grip.sword.at/axis/flat/reach written (the seat and the mesh untouched)'); } else Object.assign(rig, { grip: live.grip }); }
if (BAKE) bake();
console.log(`seat: turned ${(pick.ang * 180 / Math.PI).toFixed(0)}°, guard ${cm(GAP)} cm clear of the index finger, ${cm((sAtC - sPommel) - (loops[0].c.distanceTo(loops[3].c) - along) - fingerHalf)} cm of grip and pommel past the little finger → ${path.relative(ROOT, path.join(CHARED, 'items', 'sword_grip.json'))}`);
