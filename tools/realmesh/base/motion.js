// A MOTION for the base: a clip on somebody else's skeleton (usdanim.swift's JSON) retargeted onto assets/rigs/base, for the
// char editor's MOTION panel.
//   node tools/realmesh/base/motion.js <anim.json> <id> "<Name>" [--clip 0] [--profile cc_sketchfab] [--credit "…"] [--noloop] [--air] [--theirhands] [--handR x,y,z] [--handL x,y,z] [--hands x,y,z]
//   → tools/chared/motions/<id>.json, listed in tools/chared/motions/index.json
//
// HOW: in WORLD space, bone by bone. A source bone's turn away from its own reference pose, D(t) = Qs(t)·Qs_ref⁻¹, is laid
// on our bone: Qt(t) = D(t)·A·Qt_rest. A is what our rest pose lacks to BE the source's reference pose (they stand in a T,
// he stands in Thor's A with his knees soft): for a limb, the shortest arc that lays our bone along theirs, carried down the
// chain so a twist is inherited, not invented; for the FEET a turn about the vertical only — both men stand flat in their
// rest pose, and an ankle→toe line pitches with the boot's proportions, not with the pose; for the CLAVICLES the lift only
// (the turn in the frontal plane): a T carries its collar bones 8° UP and a walk drops them 11–25° from there, while his A
// already has them down at −7° — left unaligned, their drop went on top of his, his shoulders sank 4–9 cm and the traps were
// dragged into one slope from the skull to the shoulder ("the neck became too big"); how far FORWARD a collar bone points
// at rest is each rig's own convention (theirs 15° back, his 4° forward), so that stays his and only their movement is
// added; for the trunk, nothing: his posture stays his own and only their movement is added. Locals fall out of the parent's world. Bones with no source
// (the spare spine joints, the metacarpals) ride their parent.
// HIS HANDS: THUMBS TO THE FRONT. Their walk carries the arms elbows-out, knuckles forward — the roll comes down the whole
// arm (the hand riding the forearm untouched still swings its thumb line 90° through the cycle), and on him it read as "the
// hand made a twist". His hands are carried as his own model carries them: palm to the body, thumb to the front. Per frame
// the hand keeps the DIRECTION the clip gives it and is rolled about the forearm's axis until the line that lay along the
// body's left-right at rest lies along it again (as far as a roll can: when the forearm itself points sideways there is
// nothing to roll to, and the rule fades out). Half the roll goes into the forearm bone, half into the wrist — all of it at
// the wrist wrings the wrist like a rag. The fingers ride the hand. --theirhands keeps the clip's own roll (a cut, a parry:
// where the turn of the wrist IS the move).
// …AND THE TURN THE HAND ITSELF IS GIVEN. On top of that each hand takes a turn of its own — x bend about the knuckle line,
// y tilt about the palm's normal (the way a sword is pointed), z roll about wrist→knuckles, in the hand's own frame, the
// left hand the right's mirror. It is set by eye in the char editor (POSE → hand) and baked here: the sword hand's default
// is HAND_ZERO below, and --handR / --handL / --hands x,y,z (deg) override it.
// The hip's travel comes from the clip's `world` (the skeleton prim's matrix per key), scaled by our hip height over theirs.
const fs = require('fs'), path = require('path');
const THREE = require('../../../vendor/three.min.js');
const ROOT = path.join(__dirname, '..', '..', '..'), RIG = path.join(ROOT, 'assets', 'rigs', 'base'), OUT = path.join(ROOT, 'tools', 'chared', 'motions');
const V3 = THREE.Vector3, Q4 = THREE.Quaternion, M4 = THREE.Matrix4;

// OUR FINGERS ARE MIS-NAMED. Across the palm from the thumb the base's chains are called pinky, ring, index, middle (the
// skin says so: their vertices lie at z 15 / 10.6 / 6 / 1.7 cm with the thumb at 12–15; the one called ring is the longest,
// the one called middle the shortest). The rig keeps its names — the map goes by what a finger IS: PHYS[theirs] = ours.
// (The one called pinky has no metacarpal and starts at 0; the other three start at 1.) Checked against the geometry below.
const PHYS = { index: ['pinky', 0], mid: ['ring', 1], ring: ['index', 1], pinky: ['middle', 1], thumb: ['thumb', 0] }, KNUCKLE = 'ring';   // KNUCKLE: the chain that IS the middle finger — the hand is aimed down it
const finger = (side, s) => { const o = {}; for (const f in PHYS) s[f].forEach((src, k) => { o[PHYS[f][0] + side + (PHYS[f][1] + k)] = src; }); return o; };
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
  // The same Character Creator man from Sketchfab's glTF download — the one that has ALL the clips. Here the nodes keep their
  // names (the stem is the bone; Sketchfab adds its node index, CC_Base_L_Thigh_04) and the HIP is a joint with its own
  // translation track, so the travel is read off it (`travel`) and nothing comes from `world`.
  cc_gltf: { hip: 'CC_Base_Hip', travel: 'CC_Base_Hip',
    map: Object.assign({ pelvis: 'CC_Base_Hip', spine1: 'CC_Base_Waist', spine2: 'CC_Base_Spine01', spine3: 'CC_Base_Spine02', neck: 'CC_Base_NeckTwist01', head: 'CC_Base_Head' },
      ...['L', 'R'].map(s => Object.assign({ ['clav' + s]: `CC_Base_${s}_Clavicle`, ['arm' + s]: `CC_Base_${s}_Upperarm`, ['fore' + s]: `CC_Base_${s}_Forearm`, ['hand' + s]: `CC_Base_${s}_Hand`,
        ['thigh' + s]: `CC_Base_${s}_Thigh`, ['shin' + s]: `CC_Base_${s}_Calf`, ['foot' + s]: `CC_Base_${s}_Foot`, ['toe' + s]: `CC_Base_${s}_ToeBase` },
        finger(s, Object.fromEntries([['index', 'Index'], ['mid', 'Mid'], ['ring', 'Ring'], ['pinky', 'Pinky'], ['thumb', 'Thumb']].map(([k, n]) => [k, [1, 2, 3].map(i => `CC_Base_${s}_${n}${i}`)])))))) },
  // Mixamo (mixamorig:*), T-pose rest, hips carry the travel.
  mixamo: { hip: 'mixamorig:Hips', travel: 'mixamorig:Hips',
    map: Object.assign({ pelvis: 'mixamorig:Hips', spine1: 'mixamorig:Spine', spine2: 'mixamorig:Spine1', spine3: 'mixamorig:Spine2', neck: 'mixamorig:Neck', head: 'mixamorig:Head' },
      ...[['L', 'Left'], ['R', 'Right']].map(([s, S]) => Object.assign({ ['clav' + s]: `mixamorig:${S}Shoulder`, ['arm' + s]: `mixamorig:${S}Arm`, ['fore' + s]: `mixamorig:${S}ForeArm`, ['hand' + s]: `mixamorig:${S}Hand`,
        ['thigh' + s]: `mixamorig:${S}UpLeg`, ['shin' + s]: `mixamorig:${S}Leg`, ['foot' + s]: `mixamorig:${S}Foot`, ['toe' + s]: `mixamorig:${S}ToeBase` },
        finger(s, Object.fromEntries([['index', 'Index'], ['mid', 'Middle'], ['ring', 'Ring'], ['pinky', 'Pinky'], ['thumb', 'Thumb']].map(([k, n]) => [k, [1, 2, 3].map(i => `mixamorig:${S}Hand${n}${i}`)])))))) },
};
// how each of OUR bones is brought to the source's reference pose: [mode, the child that gives the bone its direction]
const ALIGN = {}; for (const s of ['L', 'R']) {
  Object.assign(ALIGN, { ['clav' + s]: ['lift', 'arm' + s], ['arm' + s]: ['dir', 'fore' + s], ['fore' + s]: ['dir', 'hand' + s], ['hand' + s]: ['dir', KNUCKLE + s + '1'],
    ['thigh' + s]: ['dir', 'shin' + s], ['shin' + s]: ['dir', 'foot' + s], ['foot' + s]: ['yaw', 'toe' + s], ['toe' + s]: ['as', 'foot' + s] });
  for (const f of ['index', 'middle', 'ring']) { ALIGN[f + s + '1'] = ['dir', f + s + '2']; ALIGN[f + s + '2'] = ['dir', f + s + '3']; ALIGN[f + s + '3'] = ['up']; }
  for (const f of ['pinky', 'thumb']) { ALIGN[f + s + '0'] = ['dir', f + s + '1']; ALIGN[f + s + '1'] = ['dir', f + s + '2']; ALIGN[f + s + '2'] = ['up']; }
}

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const sw = k => { const i = args.indexOf('--' + k); if (i < 0) return false; args.splice(i, 1); return true; }, noloop = sw('noloop'), air = sw('air'), theirHands = sw('theirhands');
// THE SWORD HAND'S ZERO — the user's own numbers (2026-09-20), set by eye in the char editor: the fist as it HOLDS A SWORD,
// bend −30° / tilt +51° / roll +40° on the hand's own lines. Every clip is baked with it, so a fighter carries his blade
// the same way in all of them and the editor's hand sliders start from it at 0. A clip where that hand is empty or does
// something else of its own (an open palm, a fist to the face) passes --handR 0,0,0.
const HAND_ZERO = { R: [-30, 51, 40], L: [0, 0, 0] };
const turn3 = v => String(v).split(',').map(x => (+x || 0) * Math.PI / 180).concat(0, 0, 0).slice(0, 3), both = flag('hands', null);
const HAND_TURN = { R: turn3(flag('handR', both != null ? both : HAND_ZERO.R.join(','))), L: turn3(flag('handL', both != null ? both : HAND_ZERO.L.join(','))) };
const clipNo = +flag('clip', 0), prof = PROFILES[flag('profile', 'cc_sketchfab')], credit = flag('credit', ''), FPS = +flag('fps', 60);
const [srcFile, id, title] = args; if (!srcFile || !id) { console.log('usage: motion.js <anim.json> <id> "<Name>" [--clip n] [--profile p] [--credit "…"] [--noloop] [--air] [--theirhands]'); process.exit(1); }

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
const leaf = S.joints.map(p => p.split('/').pop()), sFound = {}, sIx = nm => { if (sFound[nm] != null) return sFound[nm]; let i = leaf.indexOf(nm);
  if (i < 0) { const re = new RegExp('^' + nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(_\\d+)?$'); i = leaf.findIndex(l => re.test(l)); }   // (Sketchfab numbers its nodes: CC_Base_Hip_03)
  if (i < 0) throw new Error('no source joint ' + nm + ' — is this the right --profile? the file has: ' + leaf.slice(0, 12).join(', ') + '…'); return (sFound[nm] = i); };
const N = leaf.length, fkS = loc => { const W = []; for (let i = 0; i < N; i++) W[i] = S.parents[i] < 0 ? loc[i].clone() : W[S.parents[i]].clone().multiply(loc[i]); return W; };
const refW = fkS(S.rest.map(a => new M4().fromArray(a))), refQ = refW.map(rotOf), refP = refW.map(posOf);   // their reference pose = the REST locals (every joint has them; the binds are missing on half the limbs, and agree within ~3°)
// how far the hips are CARRIED goes by the legs, not by the height: a stride is as long as thigh + shin swing it, and his
// are only 1.025 of theirs where his hips stand 1.093 of theirs (a boot's ankle 18 cm up does the rest) — carried by the
// height, the hips outran the feet by 6% and every planted foot slid. Up and down stays with the height (then the soles).
const legOf = (P, th, sh, ft) => P(th).distanceTo(P(sh)) + P(sh).distanceTo(P(ft)), KXZ = legOf(n => T[tIx[n]].Pw, 'thighL', 'shinL', 'footL') / legOf(n => refP[sIx(prof.map[n])], 'thighL', 'shinL', 'footL');
const hipRef = prof.travel ? refP[sIx(prof.travel)].clone() : posOf(new M4().fromArray(S.bind[sIx(prof.hip)])), hipY = hipRef.y, K = T[tIx.pelvis].Pw.y / hipY;   // (a glTF's hip is a joint: its place in the reference pose; the usdz's is outside the skeleton: its bind)

// the keys → uniform frames. A loop closes on a copy of its first key (and exporters pad more behind it): find where, stop there.
const used = [...new Set(Object.values(prof.map).filter(v => v !== '@world').map(sIx))];   // closure is judged on the joints we TAKE: their hair, cloth and face bones never come back to the same place, and summed over 250 of them that hid a loop
const nk = clip.times.length, keyDist = (a, b) => { let s = 0; for (const i of used) { const o = i * 4, A = clip.r[a], B = clip.r[b]; s += 2 * Math.acos(Math.min(1, Math.abs(A[o] * B[o] + A[o + 1] * B[o + 1] + A[o + 2] * B[o + 2] + A[o + 3] * B[o + 3]))); } return s; };
let end = nk - 1, step = 0, reach = 0; for (let f = 1; f < nk; f++) { step += keyDist(f - 1, f); reach = Math.max(reach, keyDist(f, 0)); } step /= nk - 1;
const near = Math.max(step * 0.1, reach * 0.01);     // "the same pose again": a tenth of a frame's change — or, in a clip that HOLDS STILL for seconds (an advance in bursts: its mean frame barely moves), a hundredth of how far it ever gets from its first pose
const closes = !noloop && keyDist(end, 0) < near; if (closes) while (end > 1 && keyDist(end - 1, 0) < near) end--;
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
    if (al[0] === 'yaw') { dt.y = 0; ds.y = 0; A[nm] = arc(dt, ds); } else if (al[0] === 'lift') { dt.z = 0; ds.z = 0; A[nm] = arc(dt, ds); } else A[nm] = arc(dt.clone().applyQuaternion(Aup), ds).multiply(Aup); } }

// the finger names against the geometry: from the thumb's tip outwards the knuckles must come in PHYS's order
for (const sd of ['L', 'R']) { const tip = T[tIx['thumb' + sd + '2']].Pw, kn = f => T[tIx[PHYS[f][0] + sd + (PHYS[f][1] === 0 ? 0 : 1)]].Pw.distanceTo(tip), d = ['index', 'mid', 'ring', 'pinky'].map(kn);
  if (!(d[0] < d[1] && d[1] < d[2] && d[2] < d[3])) { console.log('the finger chains are not where PHYS says (' + sd + '): ' + d.map(x => (x * 100).toFixed(1)).join(' < ') + ' — was the rig rebuilt with its fingers renamed? fix PHYS'); process.exit(1); } }
const rigSpec = JSON.parse(fs.readFileSync(path.join(RIG, 'rig.json')));
const SIDE = new V3(1, 0, 0), WRIST_SHARE = 0.5, HANDS = ['L', 'R'].map(sd => { const h = tIx['hand' + sd], fo = tIx['fore' + sd], a = T[h].Pw.clone().sub(T[fo].Pw).normalize(), u = SIDE.clone().addScaledVector(a, -SIDE.dot(a)).normalize();
  const kids = []; (function down(p) { T.forEach((b, k) => { if (b.parent === p) { kids.push(k); down(k); } }); })(h);
  const t = T[tIx[PHYS.index[0] + sd + PHYS.index[1]]].Pw.clone().sub(T[tIx[PHYS.pinky[0] + sd + PHYS.pinky[1]]].Pw).normalize();   // the thumb's line: little knuckle → index knuckle, the way a blade leaves the fist
  const d = T[tIx[KNUCKLE + sd + '1']].Pw.clone().sub(T[h].Pw); d.addScaledVector(t, -d.dot(t)).normalize(); const inv = T[h].Qw.clone().invert(), m = sd === 'L' ? -1 : 1, v = HAND_TURN[sd];
  const own = new Q4().setFromAxisAngle(d.clone().applyQuaternion(inv), v[2] * m).multiply(new Q4().setFromAxisAngle(t.clone().cross(d).normalize().applyQuaternion(inv), v[1])).multiply(new Q4().setFromAxisAngle(t.clone().applyQuaternion(inv), v[0] * m));   // the editor's handOver, turn for turn
  return { sd, h, fo, kids, own, u: u.applyQuaternion(inv), t: t.applyQuaternion(inv), fwd: [], inw: [] }; });   // u: the body's left-right, square to the forearm, in the hand's own frame — at REST
const chestK = tIx.chest, smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let rollMax = 0;

// ---- the frames
const names = order.map(k => T[k].name).filter(nm => prof.map[nm] || true), tracks = {}; names.forEach(nm => { tracks[nm] = []; });
const pos = [], soles = []; let last = {};
const SOLE = []; for (const s of ['L', 'R']) { const f = T[tIx['foot' + s]], t = T[tIx['toe' + s]], fwd = t.Pw.clone().sub(f.Pw); fwd.y = 0; fwd.normalize();   // heel, ball and toe tip, on the ground in the rest pose
  SOLE.push({ bone: 'foot' + s, at: new V3(f.Pw.x, 0, f.Pw.z).addScaledVector(fwd, -0.07) }, { bone: 'toe' + s, at: new V3(t.Pw.x, 0, t.Pw.z) }, { bone: 'toe' + s, at: new V3(t.Pw.x, 0, t.Pw.z).addScaledVector(fwd, 0.1) }); }
SOLE.forEach(o => { o.local = o.at.clone().applyMatrix4(T[tIx[o.bone]].W.clone().invert()); });
for (let f = 0; f < frames; f++) {
  const { W, w } = sample(t0 + f / FPS), Qw = [], Pw = [];
  for (const k of order) { const b = T[k], src = prof.map[b.name], par = b.parent;
    const aim = nm => { const src = prof.map[nm], D = src === '@world' ? w.q.clone() : w.q.clone().multiply(rotOf(W[sIx(src)])).multiply(refQ[sIx(src)].clone().invert()); return D.multiply(A[nm]).multiply(T[tIx[nm]].Qw); };
    if (src) Qw[k] = aim(b.name);
    else Qw[k] = (par < 0 ? new Q4() : Qw[par].clone()).multiply(b.q);
    if (b.name === 'pelvis') { const d = (prof.travel ? posOf(W[sIx(prof.travel)]) : w.p.clone()).sub(hipRef); Pw[k] = b.Pw.clone().add(new V3(d.x * KXZ, d.y * K, d.z * KXZ)); } else Pw[k] = Pw[par].clone().add(b.p.clone().applyQuaternion(Qw[par])); }
  if (!theirHands) { const side = SIDE.clone().applyQuaternion(Qw[chestK].clone().multiply(T[chestK].Qw.clone().invert()));          // the body's left-right now
    for (const H of HANDS) { const a = Pw[H.h].clone().sub(Pw[H.fo]).normalize(), want = side.clone().addScaledVector(a, -side.dot(a)), have = H.u.clone().applyQuaternion(Qw[H.h]); have.addScaledVector(a, -have.dot(a));
      const fade = smooth(0.15, 0.45, Math.min(want.length(), have.length())); if (!fade) continue; want.normalize(); have.normalize();
      const roll = Math.atan2(a.dot(have.clone().cross(want)), have.dot(want)) * fade; rollMax = Math.max(rollMax, Math.abs(roll));
      const all = new Q4().setFromAxisAngle(a, roll), part = new Q4().setFromAxisAngle(a, roll * WRIST_SHARE);
      Qw[H.fo].premultiply(part); Qw[H.h].premultiply(all); for (const k of H.kids) Qw[k].premultiply(all);                               // a roll about the forearm's own axis moves no joint: Pw stands
      const was = Qw[H.h].clone(); Qw[H.h].multiply(H.own); const dW = Qw[H.h].clone().multiply(was.invert()); for (const k of H.kids) Qw[k].premultiply(dW);   // …and the turn of its own
      const yaw = new THREE.Euler().setFromQuaternion(Qw[tIx.pelvis].clone().multiply(T[tIx.pelvis].Qw.clone().invert()), 'YXZ').y, t = H.t.clone().applyQuaternion(Qw[H.h]).applyAxisAngle(new V3(0, 1, 0), -yaw);
      H.fwd.push(Math.atan2(t.z, t.y) * 180 / Math.PI); H.inw.push(Math.asin(Math.max(-1, Math.min(1, t.x * (H.sd === 'R' ? 1 : -1)))) * 180 / Math.PI); } }   /* out of the fore-and-aft plane, toward his middle */
  for (const k of order) { const b = T[k], par = b.parent, ql = par < 0 ? Qw[k].clone() : Qw[par].clone().invert().multiply(Qw[k]); ql.normalize();
    const prev = last[b.name]; if (prev && prev.dot(ql) < 0) ql.set(-ql.x, -ql.y, -ql.z, -ql.w); last[b.name] = ql; tracks[b.name].push(ql); }
  pos.push(Pw[tIx.pelvis]);
  soles.push(SOLE.map(o => o.local.clone().applyQuaternion(Qw[tIx[o.bone]]).add(Pw[tIx[o.bone]]).y));
}

// ---- a clip starts where he stands. The author laid these clips END TO END across his floor (the kick begins 2 m out, where
// the jump came down), which is his scene, not the motion. A start more than 25 cm off is that and is taken out; less is
// the pose's own lean over the feet and stays (so the clips already signed off do not move by a hair).
{ const o = pos[0].clone().sub(T[tIx.pelvis].Pw); o.y = 0; if (o.length() > 0.25) { pos.forEach(p => p.sub(o)); console.log(`  (began ${(o.length() * 100).toFixed(0)} cm from where he stands — brought back to it)`); } }

// ---- his feet on HIS ground. The hip rides at their height scaled by the hips, but his legs are not theirs scaled (longer
// shins, a boot's ankle 18 cm up, the rest pose's soft knee taken out) so the soles end up a few cm under the floor. A clip
// that keeps a foot down the whole way (a walk, a guard, a blow) is lifted frame by frame until its lowest sole point is ON
// the ground, the lift smoothed (σ 2 frames, round the loop) so the change of foot is not a kink. --air is for a clip that
// LEAVES the ground (a leap, a fall): there the lowest sole point is rightly in the air, so he is only ever lifted, never
// lowered — out of the floor on the run-up and the landing (his longer legs sank 10 cm into it), untouched in flight.
const low0 = soles.map(a => Math.min(...a));
{ const n = frames, sig = 2, need = low0.map(v => air ? Math.max(0, -v) : -v);   // --air (a leap, a fall): only ever UP — his soles are kept out of the floor on the run-up and the landing, and nothing drags him down out of the air
  const lift = need.map((_, f) => { let a = 0, w = 0; for (let d = -6; d <= 6; d++) { let j = f + d; if (closes) j = ((j % n) + n) % n; else j = Math.min(n - 1, Math.max(0, j)); const g = Math.exp(-d * d / (2 * sig * sig)); a += g * need[j]; w += g; } return a / w; });
  pos.forEach((p, f) => { p.y += lift[f]; }); soles.forEach((a, f) => a.forEach((_, k) => { a[k] += lift[f]; })); }
const low = soles.map(a => Math.min(...a)), lowL = soles.map(a => Math.min(a[0], a[1], a[2])), lowR = soles.map(a => Math.min(a[3], a[4], a[5]));
const r4 = x => +x.toFixed(4), still = nm => tracks[nm].every(q => q.angleTo(T[tIx[nm]].q) < 1e-3);
const moving = names.filter(nm => !still(nm));
// how far the clip CARRIES him: a walk that walks (WalkForward02 crosses the floor and snaps back; the angry walk trod on the
// spot). Over a loop it is the hip's place one whole period on, minus where it began; over a one-off, last frame minus first.
// The path keeps it — the editor can take it out again ("in place") and the game will want the speed to keep his feet from skating.
const hipAt = t => { const { W, w } = sample(t), d = (prof.travel ? posOf(W[sIx(prof.travel)]) : w.p.clone()).sub(hipRef); return new V3(d.x * KXZ, d.y * K, d.z * KXZ); };
const carried = closes ? hipAt(t0 + dur - 1e-6).sub(hipAt(t0)) : pos[pos.length - 1].clone().sub(pos[0]); carried.y = 0;
const travel = carried.length() > 0.05 ? [r4(carried.x), 0, r4(carried.z)] : [0, 0, 0], speed = r4(Math.hypot(travel[0], travel[2]) / (frames / FPS));
const out = { id, name: title || id, travel, speed, source: path.basename(srcFile) + ' · ' + clip.name.split('/').pop(), credit, fps: FPS, frames, duration: r4(frames / FPS), loop: closes,
  bones: moving, q: moving.map(nm => [].concat(...tracks[nm].map(q => [r4(q.x), r4(q.y), r4(q.z), r4(q.w)]))), root: 'pelvis', pos: [].concat(...pos.map(p => [r4(p.x), r4(p.y), r4(p.z)])) };
fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify(out));
const ixFile = path.join(OUT, 'index.json'), list = fs.existsSync(ixFile) ? JSON.parse(fs.readFileSync(ixFile)) : [];
const entry = { id, name: out.name, frames, fps: FPS, loop: closes, credit }, at = list.findIndex(e => e.id === id); if (at < 0) list.push(entry); else list[at] = entry;
fs.writeFileSync(ixFile, JSON.stringify(list, null, 1));
const cm = x => (x * 100).toFixed(1);
console.log(`${out.name}: ${frames} frames @ ${FPS} (${out.duration}s) ${closes ? 'LOOP' : 'once'} · ${moving.length}/${names.length} bones move · his hip ${(T[tIx.pelvis].Pw.y).toFixed(3)} over theirs ${hipY.toFixed(1)} → up/down ×${K.toFixed(4)}, along the floor ×${KXZ.toFixed(4)} (by the legs)`);
if (!theirHands) { const H = HANDS.find(h => 'hand' + h.sd === (rigSpec.swordHand || 'handR')), rg = a => Math.round(Math.min(...a)) + '…' + Math.round(Math.max(...a)) + '°';
  console.log(`  hands: thumbs to the front — rolled up to ${(rollMax * 180 / Math.PI).toFixed(0)}° about the forearm (${WRIST_SHARE * 100}% in the forearm bone), own turn R ${HAND_TURN.R.map(x => Math.round(x * 180 / Math.PI)).join(',')} L ${HAND_TURN.L.map(x => Math.round(x * 180 / Math.PI)).join(',')} · the blade's line: ${rg(H.fwd)} forward of upright, ${rg(H.inw)} toward his middle`); }
console.log(travel[0] || travel[2] ? `  TRAVELS ${(Math.hypot(travel[0], travel[2]) * 100).toFixed(0)} cm a ${closes ? 'loop' : 'clip'} (${(speed * 100).toFixed(0)} cm/s, heading ${(Math.atan2(travel[0], travel[2]) * 180 / Math.PI).toFixed(0)}° off straight ahead)` : '  treads on the spot');
console.log(`  pelvis y ${cm(Math.min(...pos.map(p => p.y)))}…${cm(Math.max(...pos.map(p => p.y)))} cm (rest ${cm(T[tIx.pelvis].Pw.y)}) · x ${cm(Math.min(...pos.map(p => p.x)))}…${cm(Math.max(...pos.map(p => p.x)))} · z ${cm(Math.min(...pos.map(p => p.z)))}…${cm(Math.max(...pos.map(p => p.z)))}`);
console.log(`  lowest sole point over the clip: before the lift ${cm(Math.min(...low0))}…${cm(Math.max(...low0))}, after ${cm(Math.min(...low))}…${cm(Math.max(...low))} cm (0 = on the ground) · L ${cm(Math.min(...lowL))}…${cm(Math.max(...lowL))} · R ${cm(Math.min(...lowR))}…${cm(Math.max(...lowR))}`);
console.log(`  → ${path.relative(ROOT, path.join(OUT, id + '.json'))} (${(fs.statSync(path.join(OUT, id + '.json')).size / 1024).toFixed(0)} KB)`);
