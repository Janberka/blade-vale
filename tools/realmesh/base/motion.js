// A MOTION for the base: a clip on somebody else's skeleton (usdanim.swift's JSON) retargeted onto assets/rigs/base, for the
// char editor's MOTION panel.
//   node tools/realmesh/base/motion.js <anim.json> <id> "<Name>" [--clip 0] [--profile cc_sketchfab] [--credit "…"] [--noloop] [--air]
//   → tools/chared/motions/<id>.json, listed in tools/chared/motions/index.json
//
// HOW: in WORLD space, bone by bone. A source bone's turn away from its own reference pose, D(t) = Qs(t)·Qs_ref⁻¹, is laid
// on our bone: Qt(t) = D(t)·A·Qt_rest. A is what our rest pose lacks to BE the source's reference pose (they stand in a T,
// he stands in Thor's A with his knees soft): for a limb, the shortest arc that lays our bone along theirs, carried down the
// chain so a twist is inherited, not invented; for the FEET a turn about the vertical only — both men stand flat in their
// rest pose, and an ankle→toe line pitches with the boot's proportions, not with the pose; for the trunk, nothing: his
// posture stays his own and only their movement is added. Locals fall out of the parent's world. Bones with no source
// (the spare spine joints, the metacarpals) ride their parent.
// The hip's travel comes from the clip's `world` (the skeleton prim's matrix per key), scaled by our hip height over theirs.
const fs = require('fs'), path = require('path');
const THREE = require('../../../vendor/three.min.js');
const ROOT = path.join(__dirname, '..', '..', '..'), RIG = path.join(ROOT, 'assets', 'rigs', 'base'), OUT = path.join(ROOT, 'tools', 'chared', 'motions');
const V3 = THREE.Vector3, Q4 = THREE.Quaternion, M4 = THREE.Matrix4;

const finger = (side, s) => { const o = {}, put = (nm, from, arr) => arr.forEach((src, k) => { o[nm + side + (from + k)] = src; });
  put('index', 1, s.index); put('middle', 1, s.mid); put('ring', 1, s.ring); put('pinky', 0, s.pinky); put('thumb', 0, s.thumb); return o; };   // our index/middle/ring 0 is the metacarpal
const PROFILES = {
  // Character Creator (CC_Base_*) as Sketchfab's USDZ conversion leaves it: joints anonymised (n36…), every bone under a
  // *_scaleCompensation joint of its own, the HIP left outside the skeleton as an animated Xform (→ `world`), so the pelvis
  // (n35/n36) and the waist (n116) are two loose roots under it; thighs, calves, upper arms and forearms carry no bind.
  cc_sketchfab: {
    hip: 'n36',                                        // the joint whose BIND height is their hip height
    map: Object.assign({ pelvis: '@world', spine1: 'n117', spine2: 'n120', spine3: 'n123', neck: 'n128', head: 'n134',
      clavL: 'n150', armL: 'n154', foreL: 'n156', handL: 'n171', clavR: 'n212', armR: 'n216', foreR: 'n224', handR: 'n235',
      thighL: 'n41', shinL: 'n43', footL: 'n45', toeL: 'n48', thighR: 'n79', shinR: 'n90', footR: 'n92', toeR: 'n95' },
      finger('L', { mid: ['n174', 'n176', 'n178'], index: ['n180', 'n182', 'n184'], ring: ['n186', 'n188', 'n190'], pinky: ['n192', 'n194', 'n196'], thumb: ['n198', 'n201', 'n203'] }),
      finger('R', { mid: ['n254', 'n256', 'n258'], ring: ['n260', 'n262', 'n264'], thumb: ['n266', 'n269', 'n271'], index: ['n273', 'n275', 'n277'], pinky: ['n279', 'n281', 'n283'] })),
  },
};
// how each of OUR bones is brought to the source's reference pose: [mode, the child that gives the bone its direction]
const ALIGN = {}; for (const s of ['L', 'R']) {
  Object.assign(ALIGN, { ['arm' + s]: ['dir', 'fore' + s], ['fore' + s]: ['dir', 'hand' + s], ['hand' + s]: ['dir', 'middle' + s + '1'],
    ['thigh' + s]: ['dir', 'shin' + s], ['shin' + s]: ['dir', 'foot' + s], ['foot' + s]: ['yaw', 'toe' + s], ['toe' + s]: ['as', 'foot' + s] });
  for (const f of ['index', 'middle', 'ring']) { ALIGN[f + s + '1'] = ['dir', f + s + '2']; ALIGN[f + s + '2'] = ['dir', f + s + '3']; ALIGN[f + s + '3'] = ['up']; }
  for (const f of ['pinky', 'thumb']) { ALIGN[f + s + '0'] = ['dir', f + s + '1']; ALIGN[f + s + '1'] = ['dir', f + s + '2']; ALIGN[f + s + '2'] = ['up']; }
}

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const sw = k => { const i = args.indexOf('--' + k); if (i < 0) return false; args.splice(i, 1); return true; }, noloop = sw('noloop'), air = sw('air');
const clipNo = +flag('clip', 0), prof = PROFILES[flag('profile', 'cc_sketchfab')], credit = flag('credit', ''), FPS = +flag('fps', 60);
const [srcFile, id, title] = args; if (!srcFile || !id) { console.log('usage: motion.js <anim.json> <id> "<Name>" [--clip n] [--profile p] [--credit "…"] [--noloop] [--air]'); process.exit(1); }

// ---- ours: the bind pose from the inverse bind matrices, as the editor and the game read it
const g = JSON.parse(fs.readFileSync(path.join(RIG, 'scene.gltf'))), bin = fs.readFileSync(path.join(RIG, g.buffers[0].uri));
const sk = g.skins[0], acc = g.accessors[sk.inverseBindMatrices], bv = g.bufferViews[acc.bufferView];
const ibm = new Float32Array(bin.buffer.slice(bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0), bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0) + 64 * acc.count));
const nodePar = {}; g.nodes.forEach((n, i) => (n.children || []).forEach(c => { nodePar[c] = i; }));
const T = sk.joints.map((j, k) => ({ name: g.nodes[j].name, node: j, W: new M4().fromArray(ibm, k * 16).invert() }));
const tIx = {}; T.forEach((b, k) => { tIx[b.name] = k; });
T.forEach(b => { const p = nodePar[b.node]; b.parent = p != null && sk.joints.includes(p) ? sk.joints.indexOf(p) : -1; });
const order = []; (function walk(p) { T.forEach((b, k) => { if (b.parent === p) { order.push(k); walk(k); } }); })(-1);
const rotOf = m => new Q4().setFromRotationMatrix(new M4().extractRotation(m)), posOf = m => new V3().setFromMatrixPosition(m);
for (const k of order) { const b = T[k]; b.Qw = rotOf(b.W); b.Pw = posOf(b.W);
  const L = b.parent < 0 ? b.W.clone() : T[b.parent].W.clone().invert().multiply(b.W); b.p = new V3(); b.q = new Q4(); b.s = new V3(); L.decompose(b.p, b.q, b.s); }

// ---- theirs
const S = JSON.parse(fs.readFileSync(srcFile)), clip = S.clips[clipNo]; if (!clip) { console.log('no clip', clipNo, 'of', S.clips.length); process.exit(1); }
const leaf = S.joints.map(p => p.split('/').pop()), sIx = nm => { const i = leaf.indexOf(nm); if (i < 0) throw new Error('no source joint ' + nm); return i; };
const N = leaf.length, fkS = loc => { const W = []; for (let i = 0; i < N; i++) W[i] = S.parents[i] < 0 ? loc[i].clone() : W[S.parents[i]].clone().multiply(loc[i]); return W; };
const refW = fkS(S.rest.map(a => new M4().fromArray(a))), refQ = refW.map(rotOf), refP = refW.map(posOf);   // their reference pose = the REST locals (every joint has them; the binds are missing on half the limbs, and agree within ~3°)
const hipY = new M4().fromArray(S.bind[sIx(prof.hip)]).elements[13], K = T[tIx.pelvis].Pw.y / hipY;
const hipRef = posOf(new M4().fromArray(S.bind[sIx(prof.hip)]));

// the keys → uniform frames. A loop closes on a copy of its first key (and exporters pad more behind it): find where, stop there.
const nk = clip.times.length, keyDist = (a, b) => { let s = 0; for (let i = 0; i < N; i++) { const o = i * 4, A = clip.r[a], B = clip.r[b]; s += 2 * Math.acos(Math.min(1, Math.abs(A[o] * B[o] + A[o + 1] * B[o + 1] + A[o + 2] * B[o + 2] + A[o + 3] * B[o + 3]))); } return s; };
let end = nk - 1, step = 0; for (let f = 1; f < nk; f++) step += keyDist(f - 1, f); step /= nk - 1;
const closes = !noloop && keyDist(end, 0) < step * 0.1; if (closes) while (end > 1 && keyDist(end - 1, 0) < step * 0.1) end--;
const t0 = clip.times[0], dur = clip.times[end] - t0, frames = closes ? Math.round(dur * FPS) : Math.round(dur * FPS) + 1;
const world = clip.world ? clip.world.map(a => { const m = new M4().fromArray(a), p = new V3(), q = new Q4(), s = new V3(); m.decompose(p, q, s); return { p: p.divideScalar(s.x), q }; }) : null;
function sample(t) {                                 // their locals and the skeleton's own placement at time t
  let k = 0; while (k < end - 1 && clip.times[k + 1] <= t) k++; const a = Math.min(1, Math.max(0, (t - clip.times[k]) / (clip.times[k + 1] - clip.times[k])));
  const loc = [], p = new V3(), q = new Q4(), q2 = new Q4(), s = new V3();
  for (let i = 0; i < N; i++) { p.fromArray(clip.t[k], i * 3).lerp(new V3().fromArray(clip.t[k + 1], i * 3), a); q.fromArray(clip.r[k], i * 4); q2.fromArray(clip.r[k + 1], i * 4); q.slerp(q2, a);
    s.fromArray(clip.s[k], i * 3).lerp(new V3().fromArray(clip.s[k + 1], i * 3), a); loc.push(new M4().compose(p, q, s)); }
  const w = world ? { p: world[k].p.clone().lerp(world[k + 1].p, a), q: world[k].q.clone().slerp(world[k + 1].q, a) } : { p: hipRef.clone(), q: new Q4() };
  return { W: fkS(loc), w };
}

// ---- A: our rest pose → their reference pose, per mapped bone
const arc = (a, b) => new Q4().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
const A = {}, mappedUp = k => { let p = T[k].parent; while (p >= 0 && !(T[p].name in prof.map)) p = T[p].parent; return p; };
for (const k of order) { const nm = T[k].name, src = prof.map[nm]; if (!src) continue; const al = ALIGN[nm] || ['none'], up = mappedUp(k), Aup = up >= 0 && A[T[up].name] ? A[T[up].name] : new Q4();
  if (al[0] === 'none') A[nm] = new Q4();
  else if (al[0] === 'up') A[nm] = Aup.clone();
  else if (al[0] === 'as') A[nm] = A[al[1]].clone();
  else { const dt = T[tIx[al[1]]].Pw.clone().sub(T[k].Pw), ds = refP[sIx(prof.map[al[1]])].clone().sub(refP[sIx(src)]);
    if (al[0] === 'yaw') { dt.y = 0; ds.y = 0; A[nm] = arc(dt, ds); } else A[nm] = arc(dt.clone().applyQuaternion(Aup), ds).multiply(Aup); } }

// ---- the frames
const names = order.map(k => T[k].name).filter(nm => prof.map[nm] || true), tracks = {}; names.forEach(nm => { tracks[nm] = []; });
const pos = [], soles = []; let last = {};
const SOLE = []; for (const s of ['L', 'R']) { const f = T[tIx['foot' + s]], t = T[tIx['toe' + s]], fwd = t.Pw.clone().sub(f.Pw); fwd.y = 0; fwd.normalize();   // heel, ball and toe tip, on the ground in the rest pose
  SOLE.push({ bone: 'foot' + s, at: new V3(f.Pw.x, 0, f.Pw.z).addScaledVector(fwd, -0.07) }, { bone: 'toe' + s, at: new V3(t.Pw.x, 0, t.Pw.z) }, { bone: 'toe' + s, at: new V3(t.Pw.x, 0, t.Pw.z).addScaledVector(fwd, 0.1) }); }
SOLE.forEach(o => { o.local = o.at.clone().applyMatrix4(T[tIx[o.bone]].W.clone().invert()); });
for (let f = 0; f < frames; f++) {
  const { W, w } = sample(t0 + f / FPS), Qw = [], Pw = [];
  for (const k of order) { const b = T[k], src = prof.map[b.name], par = b.parent;
    if (src) { const D = src === '@world' ? w.q.clone() : w.q.clone().multiply(rotOf(W[sIx(src)])).multiply(refQ[sIx(src)].clone().invert()); Qw[k] = D.multiply(A[b.name]).multiply(b.Qw); }
    else Qw[k] = (par < 0 ? new Q4() : Qw[par].clone()).multiply(b.q);
    const ql = par < 0 ? Qw[k].clone() : Qw[par].clone().invert().multiply(Qw[k]); ql.normalize();
    const prev = last[b.name]; if (prev && prev.dot(ql) < 0) ql.set(-ql.x, -ql.y, -ql.z, -ql.w); last[b.name] = ql;
    tracks[b.name].push(ql);
    if (b.name === 'pelvis') Pw[k] = b.Pw.clone().add(w.p.clone().sub(hipRef).multiplyScalar(K)); else Pw[k] = Pw[par].clone().add(b.p.clone().applyQuaternion(Qw[par])); }
  pos.push(Pw[tIx.pelvis]);
  soles.push(SOLE.map(o => o.local.clone().applyQuaternion(Qw[tIx[o.bone]]).add(Pw[tIx[o.bone]]).y));
}

// ---- his feet on HIS ground. The hip rides at their height scaled by the hips, but his legs are not theirs scaled (longer
// shins, a boot's ankle 18 cm up, the rest pose's soft knee taken out) so the soles end up a few cm under the floor. A clip
// that keeps a foot down the whole way (a walk, a guard, a blow) is lifted frame by frame until its lowest sole point is ON
// the ground, the lift smoothed (σ 2 frames, round the loop) so the change of foot is not a kink. --air leaves a clip alone
// (a jump, a fall: there the lowest sole point is rightly off the ground).
const low0 = soles.map(a => Math.min(...a));
if (!air) { const n = frames, sig = 2, lift = low0.map((_, f) => { let a = 0, w = 0; for (let d = -6; d <= 6; d++) { let j = f + d; if (closes) j = ((j % n) + n) % n; else j = Math.min(n - 1, Math.max(0, j)); const g = Math.exp(-d * d / (2 * sig * sig)); a += g * -low0[j]; w += g; } return a / w; });
  pos.forEach((p, f) => { p.y += lift[f]; }); soles.forEach((a, f) => a.forEach((_, k) => { a[k] += lift[f]; })); }
const low = soles.map(a => Math.min(...a)), lowL = soles.map(a => Math.min(a[0], a[1], a[2])), lowR = soles.map(a => Math.min(a[3], a[4], a[5]));
const r4 = x => +x.toFixed(4), still = nm => tracks[nm].every(q => q.angleTo(T[tIx[nm]].q) < 1e-3);
const moving = names.filter(nm => !still(nm));
const out = { id, name: title || id, source: path.basename(srcFile) + ' · ' + clip.name.split('/').pop(), credit, fps: FPS, frames, duration: r4(frames / FPS), loop: closes,
  bones: moving, q: moving.map(nm => [].concat(...tracks[nm].map(q => [r4(q.x), r4(q.y), r4(q.z), r4(q.w)]))), root: 'pelvis', pos: [].concat(...pos.map(p => [r4(p.x), r4(p.y), r4(p.z)])) };
fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify(out));
const ixFile = path.join(OUT, 'index.json'), list = fs.existsSync(ixFile) ? JSON.parse(fs.readFileSync(ixFile)) : [];
const entry = { id, name: out.name, frames, fps: FPS, loop: closes, credit }, at = list.findIndex(e => e.id === id); if (at < 0) list.push(entry); else list[at] = entry;
fs.writeFileSync(ixFile, JSON.stringify(list, null, 1));
const cm = x => (x * 100).toFixed(1);
console.log(`${out.name}: ${frames} frames @ ${FPS} (${out.duration}s) ${closes ? 'LOOP' : 'once'} · ${moving.length}/${names.length} bones move · his hip ${(T[tIx.pelvis].Pw.y).toFixed(3)} over theirs ${hipY.toFixed(1)} → travel ×${K.toFixed(4)}`);
console.log(`  pelvis y ${cm(Math.min(...pos.map(p => p.y)))}…${cm(Math.max(...pos.map(p => p.y)))} cm (rest ${cm(T[tIx.pelvis].Pw.y)}) · x ${cm(Math.min(...pos.map(p => p.x)))}…${cm(Math.max(...pos.map(p => p.x)))} · z ${cm(Math.min(...pos.map(p => p.z)))}…${cm(Math.max(...pos.map(p => p.z)))}`);
console.log(`  lowest sole point over the clip: before the lift ${cm(Math.min(...low0))}…${cm(Math.max(...low0))}, after ${cm(Math.min(...low))}…${cm(Math.max(...low))} cm (0 = on the ground) · L ${cm(Math.min(...lowL))}…${cm(Math.max(...lowL))} · R ${cm(Math.min(...lowR))}…${cm(Math.max(...lowR))}`);
console.log(`  → ${path.relative(ROOT, path.join(OUT, id + '.json'))} (${(fs.statSync(path.join(OUT, id + '.json')).size / 1024).toFixed(0)} KB)`);
