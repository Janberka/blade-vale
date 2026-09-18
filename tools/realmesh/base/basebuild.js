// build the naked base body from the Thor export: reduced skeleton, forearms + legs lofted on, the right arm mirrored to the left, head + eyes merged, one atlas
const fs = require('fs'); const G = require('./gltfio'), M = require('./mesh'); const { V3 } = M;
const OUT = process.argv[2] || 'view/models/base'; const R = G.read('thor-gltf'); const N = R.names; const W = G.bindWorlds(R);
// bones whose bind is the identity (the upper arms, the thighs, chain roots) take their rest position (the file's rest IS the bind, in Z-up)
const restW = []; for (const i of R.order) restW[i] = R.parent[i] >= 0 ? G.mul(restW[R.parent[i]], R.restLocal[i]) : R.restLocal[i];
const noBind = m => Math.hypot(m[12], m[13], m[14]) < 1e-6;   // (a bind at the origin: the file gave these bones no bind transform at all — only the root could sit there, and it does not)
for (let i = 0; i < N.length; i++) if (noBind(W[i])) { const t = G.translation(restW[i]); W[i] = G.compose([t[0], t[2], -t[1]], [0, 0, 0, 1]); }
// ---- the reduced skeleton ----
const KEEP = [['n7', 'pelvis'], ['n8', 'spine1'], ['n9', 'spine2'], ['n10', 'spine3'], ['n11', 'spine4'], ['n12', 'chest'], ['n325', 'neck'], ['n326', 'head'],
  ['n13', 'clavL'], ['n14', 'armL'], ['n15', 'foreL'], ['n17', 'handL'], ['n132', 'clavR'], ['n133', 'armR'], ['n134', 'foreR'], ['n136', 'handR'],
  ['n520', 'thighL'], ['n521', 'shinL'], ['n537', 'footL'], ['n538', 'toeL'], ['n569', 'thighR'], ['n570', 'shinR'], ['n586', 'footR'], ['n587', 'toeR']];
const FING = { L: [['n18', 'n19', 'n20'], ['n22', 'n23', 'n24', 'n25'], ['n27', 'n28', 'n29', 'n30'], ['n32', 'n33', 'n34', 'n35'], ['n37', 'n38', 'n39']], R: [['n137', 'n138', 'n139'], ['n141', 'n142', 'n143', 'n144'], ['n146', 'n147', 'n148', 'n149'], ['n151', 'n152', 'n153', 'n154'], ['n156', 'n157', 'n158']] };
const FNAME = ['pinky', 'ring', 'middle', 'index', 'thumb'];
for (const side of ['L', 'R']) FING[side].forEach((chain, f) => chain.forEach((nm, k) => KEEP.push([nm, FNAME[f] + side + k])));
const newIndex = new Map(KEEP.map(([nm], i) => [nm, i])), names = KEEP.map(k => k[1]);
const parentNew = KEEP.map(([nm]) => { let p = R.parent[N.indexOf(nm)]; while (p >= 0 && !newIndex.has(N[p])) p = R.parent[p]; return p >= 0 ? newIndex.get(N[p]) : -1; });
const worldNew = KEEP.map(([nm]) => W[N.indexOf(nm)]);
const localNew = worldNew.map((w, i) => parentNew[i] < 0 ? w : G.mul(G.invert(worldNew[parentNew[i]]), w));
const skeleton = { names, parent: parentNew, world: worldNew, local: localNew };
// every old bone -> a new one: the nearest kept ancestor, except that anything hanging off the wrist bones goes to the hand
const oldToNew = N.map((nm, i) => { let j = i; const chain = []; while (j >= 0) { chain.push(N[j]); if (newIndex.has(N[j])) break; j = R.parent[j]; }
  if (chain.includes('n16') && !newIndex.has(nm)) return newIndex.get('n17'); if (chain.includes('n135') && !newIndex.has(nm)) return newIndex.get('n136'); return j >= 0 ? newIndex.get(N[j]) : 0; });
const mirrorName = nm => nm.endsWith('L') ? nm.slice(0, -1) + 'R' : nm.endsWith('R') ? nm.slice(0, -1) + 'L' : /[LR]\d$/.test(nm) ? nm.replace(/([LR])(\d)$/, (s, a, b) => (a === 'L' ? 'R' : 'L') + b) : nm;
const boneMirror = i => names.indexOf(mirrorName(names[i]));
const B = nm => names.indexOf(nm), bonePos = nm => G.translation(worldNew[B(nm)]);
console.log('skeleton', names.length, 'bones');
// ---- meshes into plain arrays, uv into the atlas ----
const SLOT = { Body: [0, 0, 0.5, 0.5], Head: [0.5, 0, 0.5, 0.5], Eyes_01: [0, 0.5, 0.125, 0.125] };
function convert(short, partOf) { const src = R.meshes.find(x => x.short === short), m = M.empty(), nv = src.pos.length / 3, sl = SLOT[short];
  for (let v = 0; v < nv; v++) { const acc = new Map(); for (let c = 0; c < 4; c++) { const w = src.w[v*4+c]; if (w <= 0) continue; const nb = oldToNew[src.joints[src.ji[v*4+c]]]; acc.set(nb, (acc.get(nb) || 0) + w); } const [ji, w] = M.packW([...acc.entries()]);
    M.addVert(m, [src.pos[v*3], src.pos[v*3+1], src.pos[v*3+2]], [sl[0] + (((src.uv[v*2] % 1) + 1) % 1) * sl[2], sl[1] + (((src.uv[v*2+1] % 1) + 1) % 1) * sl[3]], ji, w, partOf ? partOf(ji[0], [src.pos[v*3], src.pos[v*3+1], src.pos[v*3+2]]) : short.toLowerCase()); }
  for (const i of src.idx) m.idx.push(i); return m; }
const bodyPart = (b, p) => { const nm = names[b]; if (/^(hand|pinky|ring|middle|index|thumb)/.test(nm)) return 'hand' + nm.slice(-1).replace(/\d/, '') || 'hand'; if (nm.startsWith('arm') || nm.startsWith('fore') || nm.startsWith('clav')) return 'arm' + nm.slice(-1); return 'torso'; };
const handPart = (b) => { const nm = names[b]; const side = /L\d?$/.test(nm) ? 'L' : 'R'; if (/^(hand|pinky|ring|middle|index|thumb)/.test(nm)) return 'hand' + side; if (/^fore/.test(nm)) return 'fore' + side; if (/^(arm|clav)/.test(nm)) return 'arm' + side; return 'torso'; };   // (parts: what the kit covers — the game hides a part under the piece over it)
let body = convert('Body', handPart);
const SKIN = (s, t) => [0.125 + 0.125 * (1 - Math.abs(2 * s - 1)), 0.5 + 0.125 * t];   // the plain skin patch (a triangle wave round the ring so the seam never crosses the patch's edge)
// ---- the right forearm: a loft from the upper arm's cut to the wrist ----
let loops = M.openLoops(body); const near = (c, r = 0.15) => loops.reduce((best, L) => { const d = V3.len(V3.sub(L.centre, c)); return d < r && (!best || d < best.d) ? { L, d } : best; }, null);
const topR = near([-0.562, 1.293, 0.001]).L, wristR = near([-0.616, 1.085, 0.064]).L, hips = near([0, 1.158, 0.081]).L;
console.log('loops', loops.map(L => L.ids.length + '@' + L.centre.map(v => v.toFixed(2)).join(',')).join('  '));
{ const d = V3.sub(wristR.centre, topR.centre); const A = M.loopByAngle(body, topR, d, 28), Bq = M.loopByAngle(body, wristR, d, 28);
  M.tube(body, A, Bq, 7, { part: 'foreR', uv: SKIN, bulge: t => 1 + 0.07 * Math.sin(Math.PI * Math.min(1, t / 0.7)) * (1 - t), weights: (t, j, wa, wb) => { const f = t < 0.7 ? 0 : (t - 0.7) / 0.3; return M.blendW([[B('foreR'), 1]], 1 - f, [[B('foreR'), 0.5], [B('handR'), 0.5]], f); } }); }
// ---- the pelvis: the hip cut lofted down and closed ----
{ const A = M.loopByAngle(body, hips, [0, -1, 0], 40); const c0 = hips.centre, cB = [c0[0], c0[1] - 0.13, c0[2] - 0.01];
  const Bq = { pts: A.pts.map(q => ({ p: V3.add(cB, V3.scale(V3.sub(q.p, c0), 0.72)), id: q.id })), c: cB };
  const rings = M.tube(body, A, Bq, 3, { part: 'torso', uv: SKIN, weights: (t) => M.blendW([[B('pelvis'), 1]], 1, [], 0) });
  M.cap(body, rings[rings.length - 1], [cB[0], cB[1] - 0.02, cB[2]], SKIN(0.5, 1), [B('pelvis'), 0, 0, 0], [1, 0, 0, 0], 'torso', true); }
// ---- the left arm: the right side mirrored past the shoulder, zipped to the torso at x = 0.33 ----
const X0 = 0.33; { const left = M.clipX(body, X0, true), mir = M.clipX(M.mirrorX(body, boneMirror), X0, false);
  console.log('cut loops left', left.loops.map(L => L.ids.length + '@' + L.centre.map(v => v.toFixed(2)).join(',')), 'mirrored', mir.loops.map(L => L.ids.length + '@' + L.centre.map(v => v.toFixed(2)).join(',')));
  const off = M.append(left.mesh, mir.mesh); body = left.mesh;
  for (const La of left.loops) { const Lb = mir.loops.map(L => ({ L, d: V3.len(V3.sub(L.centre, La.centre)) })).sort((a, b) => a.d - b.d)[0]; if (!Lb || Lb.d > 0.1) { console.log('no partner for loop', La.centre); continue; }
    M.zipper(body, La, { ids: Lb.L.ids.map(i => i + off), centre: Lb.L.centre }, 64, false); } }
// ---- legs: tubes on the bones, both sides ----
function leg(side) { const s = side === 'L' ? 1 : -1; const hip = bonePos('thigh' + side), knee = bonePos('shin' + side), ankle = bonePos('foot' + side), toe = bonePos('toe' + side); const Nr = 20;
  const ringsAlong = (p0, p1, prof, wf, part, K, tStart = 0) => { const d = V3.norm(V3.sub(p1, p0)); const u = V3.norm(V3.cross([0, 0, 1], d)), v = V3.norm(V3.cross(u, d)); const out = []; for (let k = 0; k <= K; k++) { const t = tStart + (1 - tStart) * k / K; const c = V3.lerp(p0, p1, t); const [rx, rz] = prof(t); const [ji, w] = wf(t); out.push(M.ringAt(body, c, u, v, a => { const cx = Math.cos(a) * rx, sz = Math.sin(a) * rz; return Math.hypot(cx, sz); }, Nr, SKIN, ji, w, part, t)); } return out; };
  // (ringAt takes a radius by angle in the u,v frame: u is sideways (x), v front-back — an ellipse rx × rz)
  const hipTop = V3.add(hip, [0, 0.03, 0]);
  const thigh = ringsAlong(hipTop, knee, t => { const r = 0.128 - 0.045 * t + 0.010 * Math.sin(Math.PI * t); return [r, r * 1.04]; }, t => t < 0.15 ? M.blendW([[B('pelvis'), 1]], 1 - t / 0.15, [[B('thigh' + side), 1]], t / 0.15) : [[B('thigh' + side), 0, 0, 0], [1, 0, 0, 0]], 'thigh' + side, 8);
  M.cap(body, thigh[0], V3.add(hipTop, [0, 0.02, 0]), SKIN(0.5, 0), [B('pelvis'), 0, 0, 0], [1, 0, 0, 0], 'thigh' + side, true);
  for (let k = 0; k < thigh.length - 1; k++) M.stitch(body, thigh[k], thigh[k + 1]);
  // the knee: three rings across the joint, thigh:shin 3:1 / 1:1 / 1:3
  const kd = V3.norm(V3.sub(ankle, knee)), td = V3.norm(V3.sub(knee, hip)); const bis = V3.norm(V3.add(kd, td)); const ku = V3.norm(V3.cross([0, 0, 1], bis)), kv = V3.norm(V3.cross(ku, bis));
  const kneeRings = [[-0.045, 0.75], [0, 0.5], [0.045, 0.25]].map(([o, wt]) => { const c = V3.add(knee, V3.scale(bis, o)); const [ji, w] = M.packW([[B('thigh' + side), wt], [B('shin' + side), 1 - wt]]); return M.ringAt(body, c, ku, kv, a => Math.hypot(Math.cos(a) * 0.084, Math.sin(a) * 0.088), Nr, SKIN, ji, w, 'shin' + side, 0.5); });
  let prev = thigh[thigh.length - 1]; for (const r of kneeRings) { M.stitch(body, prev, r); prev = r; }
  const shinEnd = V3.add(ankle, [0, -0.08, 0]);
  const shin = ringsAlong(V3.add(knee, V3.scale(kd, 0.06)), shinEnd, t => { const calf = 1 + 0.22 * Math.exp(-Math.pow((t - 0.28) / 0.22, 2)); const r = (0.082 - 0.030 * t) * calf; return [r * 0.95, r * 1.05]; }, t => t > 0.8 ? M.blendW([[B('shin' + side), 1]], 1 - (t - 0.8) / 0.2, [[B('foot' + side), 1]], (t - 0.8) / 0.2) : [[B('shin' + side), 0, 0, 0], [1, 0, 0, 0]], 'shin' + side, 8);
  M.stitch(body, prev, shin[0]); for (let k = 0; k < shin.length - 1; k++) M.stitch(body, shin[k], shin[k + 1]);
  M.cap(body, shin[shin.length - 1], V3.add(shinEnd, [0, -0.02, 0]), SKIN(0.5, 1), [B('foot' + side), 0, 0, 0], [1, 0, 0, 0], 'shin' + side, false);
  // the foot: ellipse rings from the heel to the toe, on the foot bone
  const fd = V3.norm([toe[0] - ankle[0], 0, toe[2] - ankle[2]]); const heel = V3.add([ankle[0], 0, ankle[2]], V3.scale(fd, -0.075)), tip = V3.add([toe[0], 0, toe[2]], V3.scale(fd, 0.06));
  const fu = V3.norm(V3.cross([0, 1, 0], fd)), fv = [0, 1, 0]; const prof = [[0, 0.045, 0.048, 0.072], [0.18, 0.052, 0.058, 0.070], [0.42, 0.056, 0.055, 0.062], [0.65, 0.058, 0.046, 0.050], [0.85, 0.060, 0.032, 0.036], [1, 0.052, 0.020, 0.024]];
  const footRings = prof.map(([t, rx, ry, cy]) => { const c = V3.lerp(heel, tip, t); c[1] = cy; return M.ringAt(body, c, fu, fv, a => Math.hypot(Math.cos(a) * rx, Math.sin(a) * ry), Nr, SKIN, [B('foot' + side), 0, 0, 0], [1, 0, 0, 0], 'foot' + side, t); });
  M.cap(body, footRings[0], V3.add([heel[0], 0.07, heel[2]], V3.scale(fd, -0.015)), SKIN(0.5, 0), [B('foot' + side), 0, 0, 0], [1, 0, 0, 0], 'foot' + side, true);
  for (let k = 0; k < footRings.length - 1; k++) M.stitch(body, footRings[k], footRings[k + 1]);
  M.cap(body, footRings[footRings.length - 1], V3.add([tip[0], 0.024, tip[2]], V3.scale(fd, 0.015)), SKIN(0.5, 1), [B('foot' + side), 0, 0, 0], [1, 0, 0, 0], 'foot' + side, false); }
leg('L'); leg('R');
// ---- the head and the eyeballs ----
M.append(body, convert('Head', (b, p) => (p[1] < 1.80 && Math.hypot(p[0], p[2] - 0.03) > 0.11) ? 'torso' : 'head'));   // (the head mesh reaches down over the traps: those are torso — under a cuirass, hidden with it)
{ const eyes = convert('Eyes_01', () => 'eye'); const vid = M.weldIds(eyes), nv = M.nverts(eyes), par = Int32Array.from({ length: nv }, (_, i) => i); const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < eyes.idx.length; t += 3) { const a = f(vid[eyes.idx[t]]), b = f(vid[eyes.idx[t+1]]), c = f(vid[eyes.idx[t+2]]); par[a] = b; par[f(b)] = f(c); }
  const cy = new Map(); for (let v = 0; v < nv; v++) { const r = f(vid[v]); const e = cy.get(r) || { s: 0, n: 0 }; e.s += eyes.pos[v*3+1]; e.n++; cy.set(r, e); }
  const keep = M.empty(); const map = new Int32Array(nv).fill(-1); for (let t = 0; t < eyes.idx.length; t += 3) { const r = f(vid[eyes.idx[t]]), e = cy.get(r); if (e.s / e.n < 1.94) continue; for (const i of [eyes.idx[t], eyes.idx[t+1], eyes.idx[t+2]]) { if (map[i] < 0) map[i] = M.addVert(keep, M.vpos(eyes, i), [eyes.uv[i*2], eyes.uv[i*2+1]], eyes.ji.slice(i*4, i*4+4), eyes.w.slice(i*4, i*4+4), 'eye'); keep.idx.push(map[i]); } }
  console.log('eyes kept tris', keep.idx.length / 3, 'of', eyes.idx.length / 3); M.append(body, keep); }
console.log('orientation', JSON.stringify(M.fixOrientation(body)));
(async () => {
const TRIS = +(process.env.TRIS || 8000);
if (TRIS > 0) { const { MeshoptSimplifier } = require('/Users/vic/Documents/GitHub/node_modules/meshoptimizer'); await MeshoptSimplifier.ready;
  const idx = Uint32Array.from(body.idx), pos = Float32Array.from(body.pos); const [simp, err] = MeshoptSimplifier.simplify(idx, pos, 3, Math.min(idx.length, TRIS * 3), +(process.env.ERR || 0.03), []);
  console.log('decimated', idx.length / 3, '->', simp.length / 3, 'tris, error', err.toFixed(4)); body.idx = Array.from(simp); }
const fin = M.finish(body); console.log('base body verts', M.nverts(fin), 'tris', fin.idx.length / 3);
const cards = (() => { const src = R.meshes.find(x => x.short === 'Hair_01'); const m = M.empty(), nv = src.pos.length / 3; const hb = B('head');
  for (let v = 0; v < nv; v++) M.addVert(m, [src.pos[v*3], src.pos[v*3+1], src.pos[v*3+2]], [src.uv[v*2], src.uv[v*2+1]], [hb, 0, 0, 0], [1, 0, 0, 0], 'hair');
  for (const i of src.idx) m.idx.push(i);
  // connected cards (by welded position), each with its centroid and area
  const vid = M.weldIds(m), par = Int32Array.from({ length: nv }, (_, i) => i); const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < m.idx.length; t += 3) { const a = f(vid[m.idx[t]]), b = f(vid[m.idx[t+1]]), c = f(vid[m.idx[t+2]]); par[a] = b; par[f(b)] = f(c); }
  const comp = new Map(); for (let t = 0; t < m.idx.length; t += 3) { const r = f(vid[m.idx[t]]); const e = comp.get(r) || { tris: [], area: 0, c: [0, 0, 0], n: 0 }; e.tris.push(t); const A = M.vpos(m, m.idx[t]), Bp = M.vpos(m, m.idx[t+1]), C = M.vpos(m, m.idx[t+2]); e.area += V3.len(V3.cross(V3.sub(Bp, A), V3.sub(C, A))) / 2; for (const P of [A, Bp, C]) { e.c = V3.add(e.c, P); e.n++; } comp.set(r, e); }
  const list = [...comp.values()].map(e => ({ ...e, c: V3.scale(e.c, 1 / e.n) })); const isBeard = e => e.c[1] < 1.93 && e.c[2] > 0.05 && Math.abs(e.c[0]) < 0.13;
  const pick = (sel, budget) => { const out = M.empty(); const map = new Int32Array(nv).fill(-1); let tris = 0; for (const e of list.filter(sel).sort((a, b) => b.area - a.area)) { if (tris + e.tris.length > budget) continue; for (const t of e.tris) { for (const i of [m.idx[t], m.idx[t+1], m.idx[t+2]]) { if (map[i] < 0) map[i] = M.addVert(out, M.vpos(m, i), [m.uv[i*2], m.uv[i*2+1]], [hb, 0, 0, 0], [1, 0, 0, 0], 'hair'); out.idx.push(map[i]); } tris++; } } return out; };
  const hair = M.finish(pick(e => !isBeard(e), 6000)), beard = M.finish(pick(isBeard, 1800)); console.log('hair cards', list.length, 'kept: hair', hair.idx.length / 3, 'tris, beard', beard.idx.length / 3, 'tris');
  return { hair, beard }; })();
const PARTS = [...new Set(fin.part)]; fs.mkdirSync(OUT, { recursive: true });
const packM = (nm, f, mat) => ({ name: nm, pos: Float32Array.from(f.pos), nrm: Float32Array.from(f.nrm), uv: Float32Array.from(f.uv), ji: Uint16Array.from(f.ji), w: Float32Array.from(f.w), idx: Uint32Array.from(f.idx), material: mat });
G.write(OUT, { meshes: [packM('base_body', fin, 0), packM('hair_long', cards.hair, 1)], skeleton,   // (the beard cards are left out: sparse strands that read as wires under the chin — the painted beard classes do the beards)
  materials: [{ name: 'base', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 }, normalTexture: { index: 1 } }, { name: 'hair', pbrMetallicRoughness: { baseColorTexture: { index: 2 }, metallicFactor: 0, roughnessFactor: 0.9 }, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true }], images: ['atlas.jpg', 'atlas_normal.jpg', 'hair.png'] });
fs.writeFileSync(OUT + '/parts.json', JSON.stringify({ classes: PARTS, vclass: fin.part.map(p => PARTS.indexOf(p)) }));
const HL = { 1: [[0, 1.772], [30, 1.768], [50, 1.745], [65, 1.728], [90, 1.722], [120, 1.712], [150, 1.678], [180, 1.652]], 2: [[0, 1.782], [40, 1.778], [90, 1.765], [180, 1.745]], 3: [[0, 1.768], [30, 1.764], [50, 1.742], [65, 1.726], [90, 1.720], [120, 1.710], [150, 1.676], [180, 1.650]], 4: [[0, 1.775], [90, 1.740], [180, 1.668]] };   // the warrior's hairlines (game.js LOOK_HAIRLINE), carried up to this skull: the same drop below its crown, scaled by the heads' size ratio
const TOP = 2.08, HK = 0.86, hairline = {}; for (const k in HL) hairline[k] = HL[k].map(([a, y]) => [a, +(TOP - (1.828 - y) * HK).toFixed(3)]);
fs.writeFileSync(OUT + '/rig.json', JSON.stringify({ source: 'Thor_UNWORTHY_THOR.usdz (the user, 2026-09-17): body, head, eyes kept; forearms, legs and the left arm rebuilt; the warrior kit carried over by tools/realmesh/base', height: 2.08, hipY: bonePos('thighL')[1],
  map: { upperBody: 'spine1', head: 'head', shoulderL: 'armL', elbowL: 'foreL', handL: 'handL', shoulderR: 'armR', elbowR: 'foreR', handR: 'handR', hipL: 'thighL', kneeL: 'shinL', hipR: 'thighR', kneeR: 'shinR' },
  meshes: { sword: 'FantasyWarrior_sword_6_characters_0', shield: 'FantasyWarrior_shield_6_characters_0', cloak: 'FantasyWarrior_cloak_6_characters_0', armor: 'FantasyWarrior_armor_6_characters_0', body: 'base_body' },
  swordHand: 'handR', shieldArm: 'foreL', bowHand: 'handL', cloakBones: [], reparent: {}, straighten: { arms: 0.55, legs: 1.0 }, plumeY: 0.30, fullBody: true, roundX: 0.66,
  skull: { yc: 1.94, zc: 0.03, top: TOP, chin: 1.76, coverY: 2.0 }, hairline, face: { earY: 1.905, earZ: 0.045, chinX: 0.045, lipY: 1.875, lipZ: 0.13 } }, null, 1));
console.log('wrote', OUT);
})();
