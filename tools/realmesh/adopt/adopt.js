// ADOPT A MODEL: somebody else's rigged character -> a Blade Vale fighter on OUR skeleton.
//
//   node tools/realmesh/adopt/adopt.js tools/realmesh/adopt/profiles/<id>.json [out dir = tools/chared/build/<id>]
//
// THE STANDARD is the base rig (assets/rigs/base, the man built from the Thor sculpt): its 60 bone names, its hierarchy and
// — the point of this file — ITS BONE FRAMES. Everything the game owns is written in those frames: the clips in
// assets/motions are LOCAL quaternions on the base's bones, the fist is a set of finger locals, the hilt's seat is a point and
// two axes in the hand's frame, the helm hangs by an offset in the hand's, a ware is skinned to bones by name. So a new body
// is not retargeted TO; it is made CONGRUENT: bone for bone, the limb lies in its bone's frame exactly as the base's limb
// lies in the base's bone frame. Then one clip, one fist, one grip and one wardrobe serve every body.
//
//   bind(b)  = A(b) · bindBase(b)       A(b) = the turn that carries the base's limb, as it lies in the base's bind pose,
//                                              onto this model's limb as it lies in ITS bind pose — from an ANATOMICAL
//                                              frame taken the same way off both (the line joint → next joint, and the
//                                              hinge: the elbow's axis from the arm's own bend, the knee's from where the
//                                              foot points, a finger's from its own curl, the palm's from the knuckle line)
//   rest(b)  = the base's rest locals   written in the file's NODES (rig.json `rest: "nodes"`): posed like that, this man
//                                              stands in the base's stance, limb for limb — the zero every pose is laid on
//   trunk, neck, head, collar bones: A = 1. Where a rig puts its spine joints is a convention, not anatomy; both stand upright.
//   feet: about the vertical only. Both stand flat; lining up ankle → toe would pitch a foot by the difference in ankle height.
//
// What is taken from the source: the MESH, the WEIGHTS and where the joints ARE (a pair that disagrees with its mirror is
// settled by the skin: the joint nearer its own weight seam wins). Its bone frames, its names, its clips are not used.
// What it does not have is made: fingers (hands.js), the spine's extra joints (the trunk's weights are re-laid by height).
const fs = require('fs'), path = require('path');
const { THREE, V, smooth, mirrorP, weldGraph, ROOT, SIDES, FINGERS, fingerBones, frames, refRig } = require('./lib'), G = require('../base/gltfio'), { rigHand } = require('./hands');
const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), OUT = process.argv[3] || path.join(ROOT, 'tools/chared/build', prof.id + '.body');
const log = (...a) => console.log(...a), cm = p => p.map(x => (x * 100).toFixed(1)).join(', ');

// ---------------------------------------------------------------- the standard: the base rig
const ref = refRig(), { BONES, PARENT } = ref, bi = n => BONES.indexOf(n);

// ---------------------------------------------------------------- the source
const SRC = G.read(path.join(ROOT, prof.source)), SW = G.bindWorlds(SRC), sIdx = n => { const i = SRC.names.indexOf(n); if (i < 0) throw new Error('profile: the source has no joint ' + n); return i; };
const J = prof.joints, srcBody = SRC.meshes.find(m => m.name.startsWith(prof.meshes.body[0]));
let top = -1e9; for (const m of SRC.meshes) for (let v = 1; v < m.pos.length; v += 3) top = Math.max(top, m.pos[v]); const SCALE = prof.scale || (top > 10 ? 0.01 : 1);
// THE MIDDLE IS THE MESH'S, not the skeleton's: a rig can sit a centimetre off its own skin (this one does), and a man built
// about his joints' middle then wears every mirrored ware a centimetre to one side. Slices of the trunk and head, the median of their mid-spans.
const CX = (() => { const m = srcBody, mids = []; for (let k = 10; k < 19; k++) { const y0 = top * k / 20, y1 = top * (k + 1) / 20; let lo = 1e9, hi = -1e9; for (let v = 0; v < m.pos.length / 3; v++) { const y = m.pos[v * 3 + 1], x = m.pos[v * 3]; if (y < y0 || y >= y1 || Math.abs(x) * SCALE > 0.2) continue; lo = Math.min(lo, x); hi = Math.max(hi, x); } if (hi > lo) mids.push((lo + hi) / 2); } mids.sort((a, b) => a - b); return (mids[mids.length >> 1] || 0) * SCALE; })();
const toOurs = (x, y, z) => [x * SCALE - CX, y * SCALE, z * SCALE], sp = n => { const w = SW[sIdx(n)]; return toOurs(w[12], w[13], w[14]); };
log('source', prof.source, '· scale ×' + SCALE, '· centre x', (CX * 100).toFixed(2), 'cm');

// where every source joint's weights go: a mapped joint to its bone, the trunk's to the trunk (re-laid by height below), anything else to its nearest mapped ancestor
const direct = {}; for (const [ours, theirs] of Object.entries(J)) if (typeof theirs === 'string') direct[theirs] = ours;
const TRUNK = new Set([J.pelvis, ...J.spine]), foldOf = i => { for (let k = i; k >= 0; k = SRC.parent[k]) { const n = SRC.names[k]; if (TRUNK.has(n)) return 'TRUNK'; if (direct[n]) return direct[n]; } return 'TRUNK'; };

// ---------------------------------------------------------------- where OUR joints are
const P = {};
for (const [ours, theirs] of Object.entries(J)) if (typeof theirs === 'string') P[ours] = sp(theirs);
// a mirrored pair that disagrees is settled by the SKIN: the seam between a joint's weights and its parent's is where the limb really bends
const seamOf = (theirs) => { const i = sIdx(theirs), pj = SRC.parent[i], c = [0, 0, 0]; let n = 0; const m = srcBody;
  for (let v = 0; v < m.pos.length / 3; v++) { let a = 0, b = 0; for (let k = 0; k < 4; k++) { const j = m.joints[m.ji[v * 4 + k]]; if (j === i) a += m.w[v * 4 + k]; if (j === pj) b += m.w[v * 4 + k]; } if (a > 0.3 && b > 0.3) { const p = toOurs(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; n++; } }
  return n ? V.mul(c, 1 / n) : null; };
for (const k of Object.keys(J).filter(k => /L$/.test(k) && J[k.slice(0, -1) + 'R'])) { const kr = k.slice(0, -1) + 'R', l = P[k], r = mirrorP(P[kr]), d = V.dist(l, r);
  if (d < 0.04) { const a = V.lerp(l, r, 0.5); P[k] = a; P[kr] = mirrorP(a); continue; }   // (a rig sitting a centimetre off its skin's middle puts every pair 2 cm apart: that is an offset, and the mean takes it out)
  const sl = seamOf(J[k]), sr = seamOf(J[kr]), el = sl ? V.dist(l, sl) : 9, er = sr ? V.dist(mirrorP(P[kr]), mirrorP(sr)) : 9, keepL = el <= er;
  log('  ! ' + k + ' / ' + kr + ' disagree by ' + (d * 100).toFixed(1) + ' cm — the ' + (keepL ? 'LEFT' : 'RIGHT') + ' one lies by its own weight seam (' + (Math.min(el, er) * 100).toFixed(1) + ' cm against ' + (Math.max(el, er) * 100).toFixed(1) + '), the other is its mirror');
  if (keepL) P[kr] = mirrorP(l); else P[k] = r; }
for (const k of ['pelvis', 'neck', 'head']) P[k][0] = 0;
// the trunk: the source's own line pelvis → … → neck, our joints along it where the base has them along its own
{ const line = [P.pelvis, ...J.spine.map(sp), P.neck].map(p => [0, p[1], p[2]]), S = [0]; for (let i = 1; i < line.length; i++) S.push(S[i - 1] + V.dist(line[i - 1], line[i]));
  const chain = ['pelvis', 'spine1', 'spine2', 'spine3', 'spine4', 'chest', 'neck'], R = [0]; for (let i = 1; i < chain.length; i++) R.push(R[i - 1] + V.dist(ref.P[chain[i - 1]], ref.P[chain[i]]));
  const at = s => { let i = 1; while (i < S.length - 1 && S[i] < s) i++; return V.lerp(line[i - 1], line[i], (s - S[i - 1]) / (S[i] - S[i - 1])); };
  for (let i = 1; i < chain.length - 1; i++) P[chain[i]] = at(R[i] / R[R.length - 1] * S[S.length - 1]); }

// ---------------------------------------------------------------- the body mesh (+ whatever rides in it: the eyes), in our space
const meshOf = prefix => SRC.meshes.find(m => m.name.startsWith(prefix)) || (() => { throw new Error('profile: no mesh ' + prefix); })();
function take(prefixes) { const out = { pos: [], nrm: [], uv: [], sj: [], sw: [], idx: [], from: [] };
  for (const pre of prefixes) { const m = meshOf(pre), off = out.pos.length / 3, nv = m.pos.length / 3;
    for (let v = 0; v < nv; v++) { out.pos.push(...toOurs(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2])); out.nrm.push(m.nrm[v * 3], m.nrm[v * 3 + 1], m.nrm[v * 3 + 2]); out.uv.push(m.uv[v * 2], m.uv[v * 2 + 1]); out.from.push(pre);
      for (let k = 0; k < 4; k++) { out.sj.push(m.joints[m.ji[v * 4 + k]]); out.sw.push(m.w[v * 4 + k]); } }
    for (const i of m.idx) out.idx.push(i + off); }
  return out; }
const body = take(prof.meshes.body), nvB = body.pos.length / 3;

// ---------------------------------------------------------------- fingers, from the mesh
const hands = {}, debug = { fingers: {}, webs: {} };
{ const Gr = weldGraph(body.pos, body.idx, 1e-5);
  // THE HAND IS WHAT LIES BEYOND THE WRIST, not what the source happened to paint on its hand joint: a sloppy rig runs the
  // forearm's weights down into the ball of the thumb, and a hand cut out by weight then starts half-way up the thumb.
  for (const S of SIDES) { const hw = new Map(), wr = P['hand' + S], fd = V.norm(V.sub(wr, P['fore' + S]));
    for (let v = 0; v < nvB; v++) { let h = 0; for (let k = 0; k < 4; k++) if (/^(fore|hand)/.test(foldOf(body.sj[v * 4 + k])) && foldOf(body.sj[v * 4 + k]).endsWith(S)) h += body.sw[v * 4 + k]; const id = Gr.wid[v]; hw.set(id, Math.max(hw.get(id) || 0, h)); }
    const set = new Set([...hw].filter(([id, h]) => h >= 0.5 && V.dot(V.sub(Gr.P(id), wr), fd) > -0.004).map(([id]) => id)); log('hand' + S + ':', set.size, 'vertices');
    const H = hands[S] = rigHand(Gr, set, P['hand' + S], log); H.Gr = Gr;
    for (const phys in FINGERS) { const f = H.F[phys], b = fingerBones(phys, S); P[b.mcp] = f.mcp; P[b.pip] = f.pip; P[b.dip] = f.dip; }
    P['thumb' + S + '0'] = H.F.thumb.cmc; P['thumb' + S + '1'] = H.F.thumb.mcp; P['thumb' + S + '2'] = H.F.thumb.ip;
    debug.fingers[S] = Object.fromEntries(Object.entries(H.F).map(([k, f]) => [k, { tip: f.tipSkin, axis: f.axis.pts, joints: k === 'thumb' ? [f.ip, f.mcp, f.cmc] : [f.dip, f.pip, f.mcp] }])); debug.webs[S] = H.webs; } }
const tips = {}; for (const S of SIDES) { for (const phys in FINGERS) tips[fingerBones(phys, S).dip] = hands[S].F[phys].tipSkin; tips['thumb' + S + '2'] = hands[S].F.thumb.tipSkin; }

// ---------------------------------------------------------------- the anatomical frames, the same way off both rigs (lib.js `frames`)
const FR = frames(ref.P, ref.tips), FN = frames(P, tips);
// the metacarpals of the three fingers that have one, and nothing else, are PLACED by the base's hand: where they sit in its palm, scaled to this one
for (const S of SIDES) { const mid = FINGERS.middle + S + '1', k = V.dist(P[mid], P['hand' + S]) / V.dist(ref.P[mid], ref.P['hand' + S]);
  for (const phys of ['middle', 'ring', 'little']) { const n = FINGERS[phys] + S + '0', loc = new THREE.Vector3(...V.sub(ref.P[n], ref.P['hand' + S])).applyQuaternion(FR['hand' + S].clone().invert()).multiplyScalar(k).applyQuaternion(FN['hand' + S]); P[n] = V.add(P['hand' + S], [loc.x, loc.y, loc.z]); } }
const Q = {}, Aq = {};
for (const n of BONES) { if (!P[n]) throw new Error('no place for the bone ' + n); const A = FN[n] && FR[n] ? FN[n].clone().multiply(FR[n].clone().invert()) : new THREE.Quaternion(); Aq[n] = A; Q[n] = A.clone().multiply(ref.Q[n]); }
{ const deg = q => 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI; log('turned onto the base\'s frames (°):', ['armR', 'foreR', 'handR', 'thighR', 'shinR', 'footR', FINGERS.index + 'R0', 'thumbR0'].map(n => n + ' ' + deg(Aq[n]).toFixed(0)).join(' · ')); }

// ---------------------------------------------------------------- weights
const TR = ['pelvis', 'spine1', 'spine2', 'spine3', 'spine4', 'chest'], trY = TR.map(n => P[n][1]).concat([P.neck[1]]);
function trunkW(y) { const out = []; for (let j = 0; j < TR.length; j++) { const lo = j === 0 ? -1e9 : trY[j], hi = j === TR.length - 1 ? 1e9 : trY[j + 1], h0 = j === 0 ? 1 : 0.45 * Math.min(trY[j] - trY[j - 1], trY[j + 1] - trY[j]), h1 = j === TR.length - 1 ? 1 : 0.45 * Math.min(trY[j + 1] - trY[j], trY[j + 2] - trY[j + 1]);
    const w = (j === 0 ? 1 : smooth(y, lo - h0, lo + h0)) - (j === TR.length - 1 ? 0 : smooth(y, hi - h1, hi + h1)); if (w > 1e-4) out.push([TR[j], w]); } return out; }
const PHYSBONE = S => { const m = { hand: 'hand' + S, 'thumb.0': 'thumb' + S + '0', 'thumb.1': 'thumb' + S + '1', 'thumb.2': 'thumb' + S + '2' }; for (const phys in FINGERS) { const b = fingerBones(phys, S); m[phys + '.1'] = b.mcp; m[phys + '.2'] = b.pip; m[phys + '.3'] = b.dip; } return m; };
// A SIDE THAT WAS PAINTED BADLY takes the other side's weights (profile `mirrorWeights: { from: 'R', bones: [...] }`): the
// surface is near enough symmetric even when the topology is not, so each vertex of the bad limb takes the weights of the
// vertex nearest its mirror image, L and R swapped. (The gladiator's shield arm: forearm weights in streaks down into the
// hand — posed, it tore into sails. His sword arm is clean.) Fingers are not mirrored: each hand's are found in its own mesh.
function folded(mesh) { const nv = mesh.pos.length / 3, F = new Array(nv); for (let v = 0; v < nv; v++) { const m = new Map(); for (let k = 0; k < 4; k++) { const x = mesh.sw[v * 4 + k]; if (x > 0) { const to = foldOf(mesh.sj[v * 4 + k]); m.set(to, (m.get(to) || 0) + x); } } F[v] = m; } return F; }
function mirrorFolded(mesh, F, o) { const from = o.from, to = from === 'R' ? 'L' : 'R', stems = new Set(o.bones), isOn = (n, S) => n.endsWith(S) && stems.has(n.slice(0, -1)), swap = n => /[LR]$/.test(n) ? n.slice(0, -1) + (n.endsWith('L') ? 'R' : 'L') : n;
  const CELL = 0.02, grid = new Map(), key = (x, y, z) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL) + ',' + Math.floor(z / CELL), nv = mesh.pos.length / 3, sgn = from === 'R' ? -1 : 1;
  for (let v = 0; v < nv; v++) if (mesh.pos[v * 3] * sgn > 0.01) { const k = key(mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2]); (grid.get(k) || grid.set(k, []).get(k)).push(v); }
  let n = 0, far = 0; for (let v = 0; v < nv; v++) { let on = 0; for (const [b, x] of F[v]) if (isOn(b, to)) on += x; if (on < 0.01) continue;
    const x = -mesh.pos[v * 3], y = mesh.pos[v * 3 + 1], z = mesh.pos[v * 3 + 2], cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL); let best = -1, bd = 0.03;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) for (const u of grid.get((cx + a) + ',' + (cy + b) + ',' + (cz + c)) || []) { const d = Math.hypot(mesh.pos[u * 3] - x, mesh.pos[u * 3 + 1] - y, mesh.pos[u * 3 + 2] - z); if (d >= bd) continue;
      if (-mesh.nrm[u * 3] * mesh.nrm[v * 3] + mesh.nrm[u * 3 + 1] * mesh.nrm[v * 3 + 1] + mesh.nrm[u * 3 + 2] * mesh.nrm[v * 3 + 2] < 0.4) continue;   // the skin must FACE the same way in the mirror: an arm hangs a finger's width off the flank, and the nearest point to a flank vertex is as often on the inside of the arm — a torso vertex with arm weights is a sail the moment the arm lifts
      bd = d; best = u; }
    if (best < 0) { far++; continue; } const m = new Map(); for (const [b, w] of F[best]) m.set(swap(b), w); F[v] = m; n++; }
  log('  weights mirrored from the ' + (from === 'R' ? 'RIGHT' : 'LEFT') + ': ' + n + ' vertices' + (far ? ' (' + far + ' had no mirror within 3 cm and keep their own)' : '')); }
function weigh(mesh, withFingers) { const nv = mesh.pos.length / 3, ji = new Uint16Array(nv * 4), w = new Float32Array(nv * 4), dom = new Array(nv), F = folded(mesh); if (prof.mirrorWeights) mirrorFolded(mesh, F, prof.mirrorWeights);
  for (let v = 0; v < nv; v++) { const acc = new Map(), add = (n, x) => { if (x > 0) acc.set(n, (acc.get(n) || 0) + x); }; let trunk = 0; const hand = { L: 0, R: 0 };
    for (const [to, x] of F[v]) { if (to === 'TRUNK') trunk += x; else if (withFingers && /^hand[LR]$/.test(to)) hand[to[4]] += x; else add(to, x); }
    if (trunk > 0) for (const [n, x] of trunkW(mesh.pos[v * 3 + 1])) add(n, trunk * x);
    for (const S of SIDES) { const H = hands[S], inHand = withFingers && H.weights.has(H.Gr.wid[v]);
      if (inHand && acc.get('fore' + S)) { const wr = P['hand' + S], fd = V.norm(V.sub(wr, P['fore' + S])), along = V.dot(V.sub([mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2]], wr), fd), give = acc.get('fore' + S) * smooth(along, 0.012, 0.04); acc.set('fore' + S, acc.get('fore' + S) - give); hand[S] += give; }   // (past the wrist the forearm lets go: the ball of the thumb is the hand's)
      if (!(hand[S] > 0)) continue; const fw = withFingers && H.weights.get(H.Gr.wid[v]), names = PHYSBONE(S); if (!fw) { add('hand' + S, hand[S]); continue; } for (const [key, x] of fw) add(names[key], hand[S] * x); }
    const L = [...acc].filter(e => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4); let s = 0; for (const e of L) s += e[1]; L.forEach(([n, x], k) => { ji[v * 4 + k] = bi(n); w[v * 4 + k] = x / s; }); dom[v] = L[0][0]; }
  return { ji, w, dom }; }
const bw = weigh(body, true);

// ---------------------------------------------------------------- the body's parts (what a ware covers is said in these)
const partOf = n => /^(neck|head)$/.test(n) ? 'head' : /^(arm|fore|thigh|shin)[LR]$/.test(n) ? n : /^(foot|toe)[LR]$/.test(n) ? 'foot' + n.slice(-1) : /[LR]\d?$/.test(n) && !/^clav/.test(n) ? 'hand' + n.match(/([LR])\d?$/)[1] : 'torso';
const CLASSES = ['head', 'hair', 'beard', 'brow', 'socket', 'eye', 'torso', 'armL', 'armR', 'foreL', 'foreR', 'handL', 'handR', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR', 'hips'];   // (`hips`: the pelvis' own skin, below the waist — what a pair of trousers covers besides the legs; a body that came with legs needs it, the base — whose trousers ARE his legs — never did)
const eyeFrom = new Set((prof.meshes.eyes || []).map(String)), vclass = new Array(nvB); for (let v = 0; v < nvB; v++) vclass[v] = CLASSES.indexOf(eyeFrom.has(body.from[v]) ? 'eye' : partOf(bw.dom[v]));
for (let v = 0; v < nvB; v++) if (CLASSES[vclass[v]] === 'torso' && bw.dom[v] === 'pelvis' && body.pos[v * 3 + 1] < P.pelvis[1] + 0.02) vclass[v] = CLASSES.indexOf('hips');
// a hand is one piece: whatever its wrist band rides (the forearm, mostly), the vertices the source hung on the hand joint are `hand`
for (const S of SIDES) for (let v = 0; v < nvB; v++) if (hands[S].weights.has(hands[S].Gr.wid[v]) && /^(fore|hand)/.test(CLASSES[vclass[v]])) vclass[v] = CLASSES.indexOf('hand' + S);

// ---------------------------------------------------------------- fewer triangles, spent where they show
async function simplify(mesh, groups, budget) {   // groups: per triangle a key; budget: key -> triangles. Borders between groups are locked, so the pieces still meet.
  const fresh = async () => { for (const k of Object.keys(require.cache)) if (/meshoptimizer/.test(k)) delete require.cache[k]; const { MeshoptSimplifier } = require(path.join(ROOT, '../node_modules/meshoptimizer')); await MeshoptSimplifier.ready; return MeshoptSimplifier; };   // (0.18's wasm heap does not survive a big call: the next one on the same buffer comes back untouched, error 0 — a new instance per call)
  const pos = Float32Array.from(mesh.pos), by = new Map(); for (let t = 0; t < mesh.idx.length; t += 3) { const k = groups(t / 3); (by.get(k) || by.set(k, []).get(k)).push(mesh.idx[t], mesh.idx[t + 1], mesh.idx[t + 2]); }
  const out = []; for (const [k, arr] of by) { const want = budget[k] != null ? budget[k] : budget['*']; if (want == null || want * 3 >= arr.length) { out.push(...arr); continue; }
    const [res, err] = (await fresh()).simplify(Uint32Array.from(arr), pos, 3, Math.max(3, want) * 3, 0.02, ['LockBorder']); log('  ' + String(k).padEnd(8), arr.length / 3, '→', res.length / 3, 'tris (err ' + err.toFixed(4) + ')'); out.push(...res); }
  return out; }
function compact(mesh, idx, per) { const map = new Map(), o = { idx: [] }; for (const k in per) o[k] = []; for (const i of idx) { if (!map.has(i)) { map.set(i, map.size); for (const k in per) for (let c = 0; c < per[k]; c++) o[k].push(mesh[k][i * per[k] + c]); } o.idx.push(map.get(i)); } o.keep = [...map.keys()]; return o; }

(async () => {
  const T = prof.tris || {}, out = { meshes: [], materials: [], images: [] };
  // the body
  log('body', body.idx.length / 3, 'tris');
  const triClass = t => { const c = [0, 1, 2].map(k => CLASSES[vclass[body.idx[t * 3 + k]]]); const pick = c[0] === c[1] || c[0] === c[2] ? c[0] : c[1] === c[2] ? c[1] : c[0]; return /^hand/.test(pick) ? pick : pick === 'head' || pick === 'eye' ? pick : 'rest'; };
  const bidx = T.body ? await simplify(body, triClass, { handL: T.hand || 1100, handR: T.hand || 1100, head: T.head || 2600, eye: T.eye || 240, rest: T.body }) : body.idx;
  const B = compact({ pos: body.pos, nrm: body.nrm, uv: body.uv, ji: Array.from(bw.ji), w: Array.from(bw.w), vclass }, bidx, { pos: 3, nrm: 3, uv: 2, ji: 4, w: 4, vclass: 1 });
  out.meshes.push({ name: 'base_body', pos: Float32Array.from(B.pos), nrm: Float32Array.from(B.nrm), uv: Float32Array.from(B.uv), ji: Uint16Array.from(B.ji), w: Float32Array.from(B.w), idx: Uint32Array.from(B.idx), material: 0 });
  // what he came dressed in: his own wear, on the same bones
  const wearSpec = {};
  for (const [name, o] of Object.entries(prof.meshes.wear || {})) { const m = take([o.from]), ww = weigh(m, false); log(name, m.idx.length / 3, 'tris');
    const idx = o.tris ? await simplify(m, () => '*', { '*': o.tris }) : m.idx, C = compact({ pos: m.pos, nrm: m.nrm, uv: m.uv, ji: Array.from(ww.ji), w: Array.from(ww.w) }, idx, { pos: 3, nrm: 3, uv: 2, ji: 4, w: 4 });
    out.meshes.push({ name, pos: Float32Array.from(C.pos), nrm: Float32Array.from(C.nrm), uv: Float32Array.from(C.uv), ji: Uint16Array.from(C.ji), w: Float32Array.from(C.w), idx: Uint32Array.from(C.idx), material: 1 });
    wearSpec[name] = Object.fromEntries(Object.entries(o).filter(([k]) => !['from', 'tris'].includes(k))); }
  // the skeleton: bound where HE stands (the inverse bind matrices), left in the BASE's stance (the nodes)
  const world = BONES.map(n => G.compose(P[n], [Q[n].x, Q[n].y, Q[n].z, Q[n].w])), local = BONES.map((n, i) => { const p = PARENT[i]; let t = P[n]; if (p >= 0) { const v = new THREE.Vector3(...V.sub(P[n], P[BONES[p]])).applyQuaternion(Q[BONES[p]].clone().invert()); t = [v.x, v.y, v.z]; } const q = ref.restQ[n]; return G.compose(t, [q.x, q.y, q.z, q.w]); });
  fs.mkdirSync(OUT, { recursive: true });
  const srcMat = srcBody.material, texOf = m => SRC.g.images[SRC.g.textures[m.pbrMetallicRoughness.baseColorTexture.index].source].uri; fs.copyFileSync(path.join(ROOT, prof.source, texOf(srcMat)), path.join(OUT, 'atlas.jpg'));
  out.images = ['atlas.jpg']; out.materials = [{ name: 'base', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 } }, { name: 'own', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 } }];
  out.skeleton = { names: BONES, parent: PARENT, world, local }; G.write(OUT, out);
  // pieces.json (the body's classes — the head's hair / beard / brow / socket are cut later, by the look bake), parts.json for the tools
  const tri = []; for (let t = 0; t < B.idx.length; t += 3) { const c = [0, 1, 2].map(k => B.vclass[B.idx[t + k]]); tri.push(c[0] === c[1] || c[0] === c[2] ? c[0] : c[1] === c[2] ? c[1] : c[0]); }
  fs.writeFileSync(path.join(OUT, 'pieces.json'), JSON.stringify({ body: { classes: CLASSES, tri, mats: ['skin', 'eye'], vmat: B.vclass.map(c => CLASSES[c] === 'eye' ? 1 : 0), vclass: B.vclass, sculpted: true } }));
  fs.writeFileSync(path.join(OUT, 'parts.json'), JSON.stringify({ classes: CLASSES, vclass: B.vclass }));
  // rig.json: the base's own, with this man's measures. `rest: "nodes"` — the zero pose is the one in the file's nodes (the base's stance), not the bind pose.
  const baseRig = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/rigs/base/rig.json'), 'utf8')); let lo = 1e9, hi = -1e9; for (let v = 1; v < B.pos.length; v += 3) { lo = Math.min(lo, B.pos[v]); hi = Math.max(hi, B.pos[v]); }
  const rig = Object.assign({}, baseRig, { source: prof.credit + ' — adopted onto the base skeleton by tools/realmesh/adopt (profile ' + prof.id + ')', credit: prof.credit, adopted: prof.id, rest: 'nodes', height: +(hi - lo).toFixed(3), hipY: +((P.thighL[1] + P.thighR[1]) / 2 - lo).toFixed(4), wear: wearSpec, meshes: { body: 'base_body' } });
  delete rig.grip; delete rig.skull; delete rig.hairline; delete rig.face;      // the wardrobe and the look bake write these for HIM
  fs.writeFileSync(path.join(OUT, 'rig.json'), JSON.stringify(rig, null, 1));
  const eyes = (prof.meshes.eyes || []).map(pre => { const m = meshOf(pre), c = [0, 0, 0], n = m.pos.length / 3; for (let v = 0; v < n; v++) { const q = toOurs(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]); c[0] += q[0] / n; c[1] += q[1] / n; c[2] += q[2] / n; } return c; });
  fs.writeFileSync(path.join(OUT, 'adopt.json'), JSON.stringify({ profile: prof.id, scale: SCALE, centre: CX, joints: P, tips, eyes, debug, turn: Object.fromEntries(BONES.map(n => [n, [Aq[n].x, Aq[n].y, Aq[n].z, Aq[n].w]])) }));
  log('→', path.relative(ROOT, OUT), '·', out.meshes.map(m => m.name + ' ' + m.idx.length / 3).join(', '), '· height', rig.height, 'hipY', rig.hipY);
})().catch(e => { console.error(e); process.exit(1); });
