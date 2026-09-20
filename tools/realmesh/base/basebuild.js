// build the naked base body from the Thor export: reduced skeleton, forearms + legs lofted on, the right arm mirrored to the left, head + eyes merged, one atlas
const fs = require('fs'); const G = require('./gltfio'), M = require('./mesh'); const { V3 } = M;
const path = require('path');
const WARRIOR = process.env.WARRIOR || path.join(__dirname, '../../../assets/rigs/warrior');   // the OLD palette warrior: the base's hands take his bind stance (HANDSTANCE=1) and the Corinthian helm is carried off him
const OUT = process.argv[2] || 'build/base'; const TUCK = +(process.env.TUCK || 0.14); const R = G.read('thor-gltf'); const N = R.names; const W = G.bindWorlds(R);
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
// THE FINGERS HANG OFF THE WRIST ROOT (n135 / n16), not off the bones kept as handR / handL — walked up blindly they found the FOREARM and the
// hand's four long fingers ended up as the forearm's children: the game drives handR, so the palm turned at the wrist and the fingers stayed behind
// with the sleeve ("the hand look still broken, its not coming straight"), and the turn onto the warrior stance never reached them either.
const HANDROOT = { n135: 'n136', n16: 'n17' };
const parentNew = KEEP.map(([nm]) => { let p = R.parent[N.indexOf(nm)]; const stop = q => newIndex.has(N[q]) || (HANDROOT[N[q]] && HANDROOT[N[q]] !== nm);
  while (p >= 0 && !stop(p)) p = R.parent[p]; if (p < 0) return -1; const h = HANDROOT[N[p]]; return newIndex.get(h && h !== nm ? h : N[p]); });
const worldNew = KEEP.map(([nm]) => W[N.indexOf(nm)]);
// THE HANDS take the warrior's stance (2026-09-18, "I can see my fingernails when I need to see the palm"): Thor's hang palm-back with the fingers
// drooping behind; the game's every hand pose is relative to the bind, so the base's hand is turned at the wrist onto the warrior's finger and
// palm directions (bones and vertices alike), and the hand bone takes the warrior's own axes (+x up the forearm, +y past the fingers, +z to the
// body — the carried helm and the gear holders are placed in that frame)
const WR = G.read(WARRIOR), WW = G.bindWorlds(WR), wPos = n => G.translation(WW[WR.names.indexOf(n)]), wRot = n => WW[WR.names.indexOf(n)];
const HANDFIX = {}; let HANDR_RING = null, BAND_R = null, BAND_L = null, LEG_MESH = null, GAUNT_L = null, GAUNT_R = null;
const STANCE = process.env.HANDSTANCE == null ? 1 : +process.env.HANDSTANCE;   /* 0 = leave the hand exactly as the file poses it, wrap and all; 1 = turn it onto the warrior's stance the game's grips were tuned against */
for (const [side, wHand, wTip, wThumb] of [['R', 'n41', 'n52', 'n44'], ['L', 'n17', 'n28', 'n20']]) {
  const hb = names.indexOf('hand' + side), wrist = G.translation(worldNew[hb]); const tip = G.translation(worldNew[names.indexOf('middle' + side + '3')]), th = G.translation(worldNew[names.indexOf('thumb' + side + '2')]);
  const frameOf = (o, t, u, sgn) => { const f = V3.norm(V3.sub(t, o)), q = V3.norm(V3.sub(u, o)); let n = V3.norm(V3.cross(q, f)); if (sgn < 0) n = V3.scale(n, -1); const w = V3.norm(V3.cross(n, f)); return [f, w, n]; };   // fingers, across the palm, the palm's normal
  const Fb = frameOf(wrist, tip, th, side === 'L' ? -1 : 1), Fw = frameOf(wPos(wHand), wPos(wTip), wPos(wThumb), side === 'L' ? -1 : 1);
  const R = [0, 0, 0, 0, 0, 0, 0, 0, 0]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let v = 0; for (let k = 0; k < 3; k++) v += Fw[k][i] * Fb[k][j]; R[i * 3 + j] = v; }   // R = Fw · Fbᵀ (rows i, cols j): base directions → warrior directions
  const rot = p => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
  const M = [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, 0, 0, 0, 1];   // column-major 4x4 of R
  const about = w => { const t = G.translation(w); const m = G.mul(M, [w[0], w[1], w[2], 0, w[4], w[5], w[6], 0, w[8], w[9], w[10], 0, 0, 0, 0, 1]); const t2 = V3.add(wrist, rot(V3.sub(t, wrist))); m[12] = t2[0]; m[13] = t2[1]; m[14] = t2[2]; return m; };
  const chain = KEEP.map(([, nm], i) => i).filter(i => { let j = i; while (j >= 0) { if (j === hb) return true; j = parentNew[j]; } return false; });
  if (STANCE) for (const i of chain) worldNew[i] = about(worldNew[i]);
  if (STANCE) { const w = wRot(wHand), t = G.translation(worldNew[hb]); worldNew[hb] = [w[0], w[1], w[2], 0, w[4], w[5], w[6], 0, w[8], w[9], w[10], 0, t[0], t[1], t[2], 1]; }   // the warrior's hand axes on the base's wrist
  HANDFIX[side] = { wrist, rot, R, chain: new Set(chain), fing: Fw[0], across: Fw[1], palm: Fw[2] };   /* (the warrior's own hand frame, which the base's hand is turned onto: up the fingers, across the palm, the palm's normal) */ console.log('hand', side, 'turned onto the warrior stance; fingers', Fb[0].map(x => x.toFixed(2)), '->', Fw[0].map(x => x.toFixed(2))); }
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
const SLOT = { Body: [0, 0, 0.5, 0.5], Head: [0.5, 0, 0.5, 0.5], Eyes_01: [0, 0.5, 0.125, 0.125], Equip_01: [0.5, 0.5, 0.5, 0.5], Equip_02: [0, 0.625, 0.25, 0.25], Equip_03: [0.25, 0.625, 0.25, 0.25] };
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
let topR = near([-0.562, 1.293, 0.001]).L, wristR = near([-0.616, 1.085, 0.064]).L, hips = near([0, 1.158, 0.081]).L;
{ const hole = near([-0.557, 1.095, 0.116], 0.05); if (hole && hole.L.ids.length < 40) { const L = hole.L; const c = L.centre.slice(); const [ji, w] = M.packW(M.weightsOf(body, L.ids[0])); let uvh = [0, 0]; for (const id of L.ids) { uvh[0] += body.uv[id*2] / L.ids.length; uvh[1] += body.uv[id*2+1] / L.ids.length; } c[0] -= 0.015;   // THE PALM'S HOLE: the file's right hand is open where the weapon's grip sat — the far wall showed through it; a fan closes it (fixOrientation winds it with the rest)
    M.cap(body, L.ids, c, uvh, ji, w, 'handR', false); console.log('palm hole capped', L.ids.length, 'verts'); /* (the fan's centre sunk 1.5 cm into the hand and on the loop's own uv: a tent with a streaked fan before) */ loops = M.openLoops(body); } }
console.log('loops', loops.map(L => L.ids.length + '@' + L.centre.map(v => v.toFixed(2)).join(',')).join('  '));
{ // THE HAND AND THE WRIST: the file's hand is an OPEN SHELL — its whole back, from the knuckles round the thumb to the wrist, lived under Thor's
  // gauntlet and was never modelled, and the shell ends in a thin ragged LIP that ran on up under his bracer.
  const wr = bonePos('handR');
  const nv0 = M.nverts(body), vid = M.weldIds(body), par = Int32Array.from({ length: nv0 }, (_, i) => i); const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < body.idx.length; t += 3) { const p = f(vid[body.idx[t]]), q = f(vid[body.idx[t+1]]), r = f(vid[body.idx[t+2]]); par[p] = q; par[f(q)] = f(r); }
  const comp = new Map(); for (let q = 0; q < nv0; q++) { const r = f(vid[q]); const e = comp.get(r) || { s: [0, 0, 0], n: 0 }; e.s[0] += body.pos[q*3]; e.s[1] += body.pos[q*3+1]; e.s[2] += body.pos[q*3+2]; e.n++; comp.set(r, e); }
  const handRoots = new Set([...comp.entries()].filter(([r, e]) => e.s[0] / e.n < -0.45 && e.s[1] / e.n < 1.25).map(([r]) => r)); const inHand = new Uint8Array(nv0); for (let q = 0; q < nv0; q++) if (handRoots.has(f(vid[q]))) inHand[q] = 1;
  let hand = M.empty(); const rest = M.empty(); const hmap = new Int32Array(nv0).fill(-1), rmap = new Int32Array(nv0).fill(-1);
  const take = (dst, map, q) => { if (map[q] < 0) map[q] = M.addVert(dst, M.vpos(body, q), [body.uv[q*2], body.uv[q*2+1]], body.ji.slice(q*4, q*4+4), body.w.slice(q*4, q*4+4), dst === hand ? 'handR' : body.part[q]); return map[q]; };   /* (the whole hand piece is HAND, whatever bone weights it — its wrist band rode the forearm bone, was classed forearm, and hid under a sleeve as a sawtooth) */
  for (let t = 0; t < body.idx.length; t += 3) { const h = inHand[body.idx[t]]; const dst = h ? hand : rest, map = h ? hmap : rmap; for (let k = 0; k < 3; k++) dst.idx.push(take(dst, map, body.idx[t + k])); }
  // THE HAND TURNS — whole, rigid, about the wrist: the file's hand hangs palm-back with the fingers drooping behind, 67° off the forearm, and every
  // plane and ring below is measured on the turned hand. (Turned afterwards, by place and blended up the tube, the joint's plane cut the drooping hand
  // through the knuckles and everything built on that cut was nonsense.)
  if (STANCE) { const HX = HANDFIX.R, n = M.nverts(hand); for (let q = 0; q < n; q++) { const p = M.vpos(hand, q); const r = V3.add(HX.wrist, HX.rot(V3.sub(p, HX.wrist))); hand.pos[q*3] = r[0]; hand.pos[q*3+1] = r[1]; hand.pos[q*3+2] = r[2]; } }
  // NOTHING IS CUT AND NOTHING IS SWEPT. The file's hand keeps its fingers, its thumb, its knuckles and the ragged lip that
  // ran up under Thor's bracer, open rim and all. The WRIST BAND below covers that rim — which is why the naked man wears it.
  // (Every closure tried here read as a mitten or a paddle: the lip clipped square took the thumb off with it, and the rim
  //  swept onto a 5 x 3.9 cm ring funnelled the whole back of the hand into the joint.)
  const hax = HANDFIX.R.fing, hacross = HANDFIX.R.across, hpalm = HANDFIX.R.palm;
  const RX = +(process.env.WRX || 0.050), RY = +(process.env.WRY || 0.039);   // the wrist: broader across the palm than through it
  const ringR = (uu, vv) => th => { const d = V3.add(V3.scale(uu, Math.cos(th)), V3.scale(vv, Math.sin(th))); return 1 / Math.hypot(V3.dot(d, hacross) / RX, V3.dot(d, hpalm) / RY); };
  { const ls = M.openLoops(hand);   // a lid over the rim, flat: the band covers nearly all of it, this closes the strip that still shows past the leather
    for (const L of ls) { const r = M.patchFill(hand, L, { part: 'handR', bulge: +(process.env.LIDBULGE || 0), iters: 200, flip: !!process.env.LIDFLIP });
      console.log('hand: the file\'s own, untouched;', L.ids.length, 'vert rim lidded with', r.tris, 'tris'); } }
  M.append(rest, hand); body = rest;

  loops = M.openLoops(body); topR = near([-0.562, 1.293, 0.001]).L; hips = near([0, 1.158, 0.081]).L;
  { const A = M.loopByAngle(body, topR, V3.sub(wr, topR.centre), 0, null, true), NR = A.pts.length;   // (A = the elbow cut's OWN vertices, so the tube is one piece with the arm — sampled, it was a piece of its own and could be wound inside out)
    const uu = V3.norm(V3.cross([0, 1, 0], hax)), vv = V3.cross(hax, uu), rr = ringR(uu, vv);
    const [jiW, wW] = M.blendW([[B('foreR'), 1]], 0.4, [[B('handR'), 1]], 0.6);
    const cB = V3.add(wr, V3.scale(hax, -0.03));   // the tube stops 3 cm short of the ring and the band between them is zipped: the two rings carry different vertex counts
    const ring = []; for (let j = 0; j < NR; j++) { const th = A.pts[j].ang, d = V3.add(V3.scale(uu, Math.cos(th)), V3.scale(vv, Math.sin(th))); ring.push(M.addVert(body, V3.add(cB, V3.scale(d, rr(th) * 1.04)), SKIN(j / NR, 1), jiW, wW, 'handR')); }
    const Bq = { pts: ring.map(id => ({ p: M.vpos(body, id), id })), c: cB };
    const tr = M.tube(body, A, Bq, 6, { part: 'foreR', uv: SKIN, bulge: t => (1 + 0.07 * Math.sin(Math.PI * Math.min(1, t / 0.7)) * (1 - t)) * (1 - TUCK * Math.sin(Math.PI * t)),   /* TUCK: the lofted forearm is invented, the BAND around it is Thor's own — left at full girth the skin z-fought through the leather as a row of shards, so it is drawn in between the two welded ends */ weights: (t) => { const g = t < 0.55 ? 0 : (t - 0.55) / 0.45; return M.blendW([[B('foreR'), 1]], 1 - g, [[B('foreR'), 0.4], [B('handR'), 0.6]], g); } });
    M.cap(body, tr[tr.length - 1], V3.add(cB, V3.scale(hax, 0.02)), SKIN(0.5, 1), jiW, wW, 'foreR', false);   /* the tube ends in a cap, not a bridge onto the hand: it stops inside the band, where nothing sees it */
    console.log('forearm lofted from the elbow cut to a stub under the band'); } }
  // take pieces of one of Thor's equipment meshes, converted onto the new skeleton, choosing them a CONNECTED PIECE at a
  // time by where it sits — so a strap or a flared knee cuff can be left behind without cutting into what it hangs off.
  const pickParts = (short, part, want) => { const all = convert(short, () => part), nv = M.nverts(all);
    const vid = M.weldIds(all), par = Int32Array.from({ length: nv }, (_, i) => i); const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let t = 0; t < all.idx.length; t += 3) { const p = f(vid[all.idx[t]]), q = f(vid[all.idx[t+1]]), r = f(vid[all.idx[t+2]]); par[p] = q; par[f(q)] = f(r); }
    const comp = new Map();
    for (let t = 0; t < all.idx.length; t += 3) { const r = f(vid[all.idx[t]]); const e = comp.get(r) || { tris: 0, bb: [9, -9, 9, -9, 9, -9] }; e.tris++;
      for (const i of [all.idx[t], all.idx[t+1], all.idx[t+2]]) { const p = M.vpos(all, i);
        e.bb[0] = Math.min(e.bb[0], p[0]); e.bb[1] = Math.max(e.bb[1], p[0]); e.bb[2] = Math.min(e.bb[2], p[1]); e.bb[3] = Math.max(e.bb[3], p[1]); e.bb[4] = Math.min(e.bb[4], p[2]); e.bb[5] = Math.max(e.bb[5], p[2]); } comp.set(r, e); }
    const keep = new Set(); let left = 0;
    for (const [r, e] of comp) { if (want(e.bb, e.tris)) keep.add(r); else left += e.tris; }
    const out = M.empty(), map = new Int32Array(nv).fill(-1);
    for (let t = 0; t < all.idx.length; t += 3) { if (!keep.has(f(vid[all.idx[t]]))) continue;
      for (const i of [all.idx[t], all.idx[t+1], all.idx[t+2]]) { if (map[i] < 0) map[i] = M.addVert(out, M.vpos(all, i), [all.uv[i*2], all.uv[i*2+1]], all.ji.slice(i*4, i*4+4), all.w.slice(i*4, i*4+4), part); out.idx.push(map[i]); } }
    console.log('  ', short, ':', keep.size, 'of', comp.size, 'pieces kept,', out.idx.length / 3, 'tris (', left, 'tris left behind )');
    return out; };
  const pickBox = (short, box, part) => pickParts(short, part, bb => bb[0] >= box[0] && bb[1] <= box[1] && bb[2] >= box[2] && bb[3] <= box[3] && bb[4] >= box[4] && bb[5] <= box[5]);
  { // ---- THE WRIST BAND: Thor's own leather wrap, worn by the naked man ----
    // His right hand has no skin from the wrist up the back of the metacarpals — it lived under his gauntlet — so the build
    // has to close that opening somehow, and every closure reads as a mitten or a flap at a close zoom. The wrap is in the
    // file, it covers exactly that, and its strap runs on over the back of the hand: so he wears it, and it IS his wrist.
    const BOX = [-0.70, -0.46, 1.03, 1.36, -0.13, 0.18];   // the wrist component of Equip_01 (its other component is the body's straps)
    const all = convert('Equip_01', () => 'bandR'); const band = M.empty(); const map = new Int32Array(M.nverts(all)).fill(-1);
    const inBox = v => { const p = M.vpos(all, v); return p[0] >= BOX[0] && p[0] <= BOX[1] && p[1] >= BOX[2] && p[1] <= BOX[3] && p[2] >= BOX[4] && p[2] <= BOX[5]; };
    for (let t = 0; t < all.idx.length; t += 3) { if (!(inBox(all.idx[t]) && inBox(all.idx[t+1]) && inBox(all.idx[t+2]))) continue;
      for (const i of [all.idx[t], all.idx[t+1], all.idx[t+2]]) { if (map[i] < 0) map[i] = M.addVert(band, M.vpos(all, i), [all.uv[i*2], all.uv[i*2+1]], all.ji.slice(i*4, i*4+4), all.w.slice(i*4, i*4+4), 'bandR'); band.idx.push(map[i]); } }
    // the hand was turned onto the warrior stance about the wrist; the band turns with it, eased along the hand's own axis
    // (by BONE WEIGHT the share jumped from vertex to vertex and tore the leather into shards)
    const HX = HANDFIX.R, RM = HX.R, trc = RM[0] + RM[4] + RM[8];
    const ang = Math.acos(Math.max(-1, Math.min(1, (trc - 1) / 2))), sa = Math.sin(ang);
    const axis = sa > 1e-6 ? V3.scale([RM[7] - RM[5], RM[2] - RM[6], RM[3] - RM[1]], 1 / (2 * sa)) : [0, 1, 0];
    const BT = process.env.BANDTURN == null ? STANCE : +process.env.BANDTURN;   // the wrap turns with the hand or not at all: apart, the cuff leaves the wrist and the hand reads as popped out
    const nb = M.nverts(band), T0 = -0.045, T1 = 0.010, share = t => { const x = Math.min(1, Math.max(0, (t - T0) / (T1 - T0))); return x * x * (3 - 2 * x); };
    for (let q = 0; q < nb; q++) { const d0 = V3.sub(M.vpos(band, q), HX.wrist); const h = share(V3.dot(d0, HX.fing)) * BT; if (h < 1e-3) continue;
      const th = ang * h, ct = Math.cos(th), st = Math.sin(th);
      const r = V3.add(V3.add(V3.scale(d0, ct), V3.scale(V3.cross(axis, d0), st)), V3.scale(axis, V3.dot(axis, d0) * (1 - ct)));
      const p = V3.add(HX.wrist, r); band.pos[q*3] = p[0]; band.pos[q*3+1] = p[1]; band.pos[q*3+2] = p[2]; }
    for (let q = 0; q < nb; q++) { const g = share(V3.dot(V3.sub(M.vpos(band, q), HX.wrist), HX.fing));   // it rides the hand past the joint and the forearm behind it
      const [ji, w] = M.blendW([[B('foreR'), 1]], 1 - g, [[B('handR'), 1]], g); for (let c = 0; c < 4; c++) { band.ji[q*4+c] = ji[c]; band.w[q*4+c] = w[c]; } }
    { const OFF = +(process.env.BANDOFF || 0.004), el = bonePos('foreR'), ax = V3.norm(V3.sub(HX.wrist, el));   // the leather stands this far off the arm: flush on it, the two surfaces z-fight as a row of shards
      for (let q = 0; q < nb; q++) { const d = V3.sub(M.vpos(band, q), HX.wrist); const rad = V3.sub(d, V3.scale(ax, V3.dot(d, ax))); const L = V3.len(rad); if (L < 1e-5) continue;
        const p = V3.add(M.vpos(band, q), V3.scale(rad, OFF / L)); band.pos[q*3] = p[0]; band.pos[q*3+1] = p[1]; band.pos[q*3+2] = p[2]; } }
    BAND_R = band; console.log('wrist band kept:', band.idx.length / 3, 'tris,', nb, 'verts'); }
// ---- HIS LEGS: the pants, the boots and the shin wraps ----
// The Body mesh has no legs at all — from the hips down he is his trousers — so the build used to loft tubes on the leg
// bones, and they read as LEGO next to the sculpt. These are his own, vertex for vertex, on the same bones.
{ const CUT = +(process.env.PANTCUT == null ? 0 : process.env.PANTCUT);   // 0 = the trousers keep their own length; the wrap below covers the hem
  // his trousers: the one big piece from the hips down. Its hem flares into points at the knee (and four little cuff
  // pieces flare further) — cut straight at CUT, just inside the top of the shin wrap, and the knee reads plain.
  let legs = pickParts('Equip_02', 'legwear', bb => bb[3] > 0.80);
  if (CUT > 0) { const c = M.clipPlane(legs, [0, CUT, 0], [0, -1, 0]); legs = c.mesh; console.log('   trouser legs cut straight at y', CUT.toFixed(2), '->', c.loops.length, 'hems'); }
  if (process.env.HEMCAP !== '0') for (const L of M.openLoops(legs)) { const c = L.centre; if (c[1] < 0.40 || c[1] > 0.95) continue;   // closed, or you look straight down the hollow leg
    const [ji, w] = M.packW(M.weightsOf(legs, L.ids[0]));
    let uu = 0, uv = 0; for (const id of L.ids) { uu += legs.uv[id*2] / L.ids.length; uv += legs.uv[id*2+1] / L.ids.length; }   /* the hem's MEAN uv: on the first vertex's, the fan stretched across the atlas and smeared a pink streak over the knee */
    M.cap(legs, L.ids, c, [uu, uv], ji, w, 'legwear', false);
    console.log('   hem closed at y', c[1].toFixed(2), 'over', L.ids.length, 'verts'); }
  M.append(legs, pickParts('Equip_02', 'legwear', bb => bb[3] <= 0.45));   // the boots and their straps
  { let wr2 = pickParts('Equip_03', 'legwear', bb => bb[3] <= 0.85);   // the shin wraps — their tops flare at the knee too
    const WT = +(process.env.WRAPTOP == null ? 0.62 : process.env.WRAPTOP);   // the wrap's top flares into a petal at the knee: cut it here, just inside the trouser's hem, and the knee reads plain
    if (WT > 0) { const c = M.clipPlane(wr2, [0, WT, 0], [0, 1, 0]); wr2 = c.mesh; console.log('   shin wraps cut at y', WT.toFixed(2), '->', c.loops.length, 'tops');
      for (const L of c.loops) { const [ji, w] = M.packW(M.weightsOf(wr2, L.ids[0])); M.cap(wr2, L.ids, L.centre, [wr2.uv[L.ids[0]*2], wr2.uv[L.ids[0]*2+1]], ji, w, 'legwear', true); } }
    M.append(legs, wr2); }
  LEG_MESH = legs;
  console.log('his legs kept:', legs.idx.length / 3, 'tris,', M.nverts(legs), 'verts'); }

// ---- THE GAUNTLET: the hand end of Thor's metal arm, wearable on either side ----
// His left arm is a prosthetic — an articulated steel hand and forearm. Cut off at the elbow it is a gauntlet, and since
// the base's hands keep the file's own stance it drops straight onto the left hand. Mirrored, it fits the right.
{ const TOP = +(process.env.GAUNTTOP == null ? 0 : process.env.GAUNTTOP);   // 0 = the WHOLE arm, as the file wears it
  // EVERY piece that lies on that arm, not just the big one: the prosthetic is plated, and the bolts, rivets and small
  // plates are components of their own. Taking only the shell left the gaps between its plates standing open.
  let g0 = pickParts('Equip_03', 'gauntletL', bb => bb[0] > 0.28 && bb[1] < 0.78 && bb[2] > 0.80 && bb[3] < 1.66);
  if (TOP > 0) { const c = M.clipPlane(g0, [0, TOP, 0], [0, 1, 0]); g0 = c.mesh;   // or cut short into a gauntlet
    for (const L of c.loops) { const [ji, w] = M.packW(M.weightsOf(g0, L.ids[0]));
      let uu = 0, uv = 0; for (const id of L.ids) { uu += g0.uv[id*2] / L.ids.length; uv += g0.uv[id*2+1] / L.ids.length; }
      M.cap(g0, L.ids, L.centre, [uu, uv], ji, w, 'gauntletL', true); }
    console.log('   arm cut short at y', TOP.toFixed(2), '->', c.loops.length, 'openings capped'); }
  { // THE STEEL GROWS, NOT THE ARM. In the file this arm REPLACES the limb — there is no flesh inside it — so worn over
    // one it is a shade too tight and the bicep comes through the plates. It is scaled about the shoulder joint until it
    // contains the arm, radially only: lengthening it would push the steel hand off the wrist bone.
    const K = +(process.env.GAUNTFAT || 1.10);   // enough to contain a flesh bicep; the arm itself is never touched
    if (K !== 1) { const sh = bonePos('armL'), ax = V3.norm(V3.sub(bonePos('foreL'), sh)), n2 = M.nverts(g0);
      for (let q = 0; q < n2; q++) { const d = V3.sub(M.vpos(g0, q), sh), al = V3.dot(d, ax);
        const rad = V3.sub(d, V3.scale(ax, al)); const p2 = V3.add(sh, V3.add(V3.scale(ax, al), V3.scale(rad, K)));
        g0.pos[q*3] = p2[0]; g0.pos[q*3+1] = p2[1]; g0.pos[q*3+2] = p2[2]; }
      console.log('   the steel arm widened x', K.toFixed(2), 'about the shoulder'); } }
  GAUNT_L = g0; GAUNT_R = M.mirrorX(g0, boneMirror);
  console.log('the steel arm kept:', g0.idx.length / 3, 'tris a side');
  // (no shoulder piece comes off this arm: its top is a strap round the bicep, not a cap — the kit's own pauldrons are the shoulder ware)
}// ---- the pelvis: the hip cut lofted down and closed ----
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
BAND_L = M.mirrorX(BAND_R, boneMirror);   // the left wrist gets the same wrap — its own mesh, so an arm in a gauntlet can go without one
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
if (!LEG_MESH) { leg('L'); leg('R'); }   // the lofted tubes only if his own legs are not in
// ---- the head and the eyeballs ----
M.append(body, convert('Head', (b, p) => (p[1] < 1.86 && Math.hypot(p[0], p[2] - 0.03) > 0.115) ? 'torso' : 'head'));   // (the traps up to the neck proper are torso — under the lifted collar, hidden with the cuirass)   // (the head mesh reaches down over the traps: those are torso — under a cuirass, hidden with it)
{ const eyes = convert('Eyes_01', () => 'eye'); const vid = M.weldIds(eyes), nv = M.nverts(eyes), par = Int32Array.from({ length: nv }, (_, i) => i); const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < eyes.idx.length; t += 3) { const a = f(vid[eyes.idx[t]]), b = f(vid[eyes.idx[t+1]]), c = f(vid[eyes.idx[t+2]]); par[a] = b; par[f(b)] = f(c); }
  const cy = new Map(); for (let v = 0; v < nv; v++) { const r = f(vid[v]); const e = cy.get(r) || { s: 0, n: 0 }; e.s += eyes.pos[v*3+1]; e.n++; cy.set(r, e); }
  const keep = M.empty(); const map = new Int32Array(nv).fill(-1); for (let t = 0; t < eyes.idx.length; t += 3) { const r = f(vid[eyes.idx[t]]), e = cy.get(r); if (e.s / e.n < 1.94) continue; for (const i of [eyes.idx[t], eyes.idx[t+1], eyes.idx[t+2]]) { if (map[i] < 0) map[i] = M.addVert(keep, M.vpos(eyes, i), [eyes.uv[i*2], eyes.uv[i*2+1]], eyes.ji.slice(i*4, i*4+4), eyes.w.slice(i*4, i*4+4), 'eye'); keep.idx.push(map[i]); } }
  console.log('eyes kept tris', keep.idx.length / 3, 'of', eyes.idx.length / 3); M.append(body, keep); }
console.log('orientation', JSON.stringify(M.fixOrientation(body)));
(async () => {
const TRIS = +(process.env.TRIS || 8000), HANDTRIS = +(process.env.HANDTRIS || 2800), BANDTRIS = +(process.env.BANDTRIS || 1200), LEGTRIS = +(process.env.LEGTRIS || 4200);
if (TRIS > 0) { const { MeshoptSimplifier } = require('/Users/vic/Documents/GitHub/node_modules/meshoptimizer'); await MeshoptSimplifier.ready;
  const pos = Float32Array.from(body.pos), ERR = +(process.env.ERR || 0.03);
  // THE HANDS AND THE BANDS EACH GET THEIR OWN BUDGET. Decimated with the body they lose every time — the simplifier spends
  // its triangles where the ABSOLUTE error is largest, the torso and the head — and the fingers, small to begin with, fuse
  // into a faceted paddle. (One shared pool for both is no good either: the band's 5 200 triangles swallowed it and the
  // hands came out WORSE than before, 1 550 against the 1 787 they had when nothing protected them at all.)
  const cls = v => { const p = body.part[v]; return p === 'handR' || p === 'handL' ? 0 : 2; };
  const sets = [[], [], []];
  for (let t = 0; t < body.idx.length; t += 3) { const a = body.idx[t], b = body.idx[t+1], c = body.idx[t+2];
    const k = cls(a) === cls(b) && cls(b) === cls(c) ? cls(a) : 2; sets[k].push(a, b, c); }
  const simp = (arr, target, err) => { const i = Uint32Array.from(arr); const [out] = MeshoptSimplifier.simplify(i, pos, 3, Math.min(i.length, Math.max(3, target) * 3), err == null ? ERR : err, ['LockBorder']); return out; };   /* the error is per set: 3% of the body's extent is 6 cm, which a finger does not have to spare */   // (LockBorder: the seams where a lofted tube meets a cut, and the mirror's zipper, are coincident duplicates — moved apart by a collapse they opened hairline cracks)
  const FERR = +(process.env.FERR || 0.002);
  const H = simp(sets[0], HANDTRIS, FERR), R2 = simp(sets[2], TRIS - H.length / 3);
  console.log('decimated: hands', sets[0].length / 3, '->', H.length / 3, '| the rest', sets[2].length / 3, '->', R2.length / 3);
  body.idx = Array.from(R2).concat(Array.from(H));
  for (const [nm, W2, budget] of [['band L', BAND_L, BANDTRIS], ['band R', BAND_R, BANDTRIS], ['the legs', LEG_MESH, LEGTRIS]]) { if (!W2) continue;
    const wp = Float32Array.from(W2.pos), wi = Uint32Array.from(W2.idx);
    const [wo] = MeshoptSimplifier.simplify(wi, wp, 3, Math.min(wi.length, budget * 3), FERR, ['LockBorder']);
    console.log('decimated:', nm, wi.length / 3, '->', wo.length / 3); W2.idx = Array.from(wo); }
  for (const [nm, G2, budget] of [['a steel arm', GAUNT_L, +(process.env.GAUNTTRIS || 3000)], ['a steel arm', GAUNT_R, +(process.env.GAUNTTRIS || 3000)]]) { if (!G2) continue;
    const gp = Float32Array.from(G2.pos), gi = Uint32Array.from(G2.idx);
    const [go] = MeshoptSimplifier.simplify(gi, gp, 3, Math.min(gi.length, budget * 3), FERR, ['LockBorder']);
    console.log('decimated:', nm, gi.length / 3, '->', go.length / 3); G2.idx = Array.from(go); } }
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
const wear = { band_L: BAND_L, band_R: BAND_R, legs: LEG_MESH, gauntlet_L: GAUNT_L, gauntlet_R: GAUNT_R };   // one mesh per worn piece, so any of them can be on or off
G.write(OUT, { meshes: [packM('base_body', fin, 0), packM('hair_long', cards.hair, 1), ...Object.entries(wear).map(([nm, w]) => packM(nm, M.finish(w), 2))], skeleton,   // (the beard cards are left out: sparse strands that read as wires under the chin — the painted beard classes do the beards)
  materials: [{ name: 'base', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 }, normalTexture: { index: 1 } }, { name: 'hair', pbrMetallicRoughness: { baseColorTexture: { index: 2 }, metallicFactor: 0, roughnessFactor: 0.9 }, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true }, { name: 'band', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.85 }, doubleSided: true }], images: ['atlas.jpg', 'atlas_normal.jpg', 'hair.png'] });   /* the wrap is ONE sheet of leather: seen from inside its faces are back faces, and the arm reads as holed — its own material, drawn from both sides */
fs.writeFileSync(OUT + '/parts.json', JSON.stringify({ classes: PARTS, vclass: fin.part.map(p => PARTS.indexOf(p)) }));
const HL = { 1: [[0, 1.772], [30, 1.768], [50, 1.745], [65, 1.728], [90, 1.722], [120, 1.712], [150, 1.678], [180, 1.652]], 2: [[0, 1.782], [40, 1.778], [90, 1.765], [180, 1.745]], 3: [[0, 1.768], [30, 1.764], [50, 1.742], [65, 1.726], [90, 1.720], [120, 1.710], [150, 1.676], [180, 1.650]], 4: [[0, 1.775], [90, 1.740], [180, 1.668]] };   // the warrior's hairlines (game.js LOOK_HAIRLINE), carried up to this skull: the same drop below its crown, scaled by the heads' size ratio
const TOP = 2.08, HK = 0.86, hairline = {}; for (const k in HL) hairline[k] = HL[k].map(([a, y]) => [a, +(TOP - (1.828 - y) * HK).toFixed(3)]);
fs.writeFileSync(OUT + '/rig.json', JSON.stringify({ source: 'Thor_UNWORTHY_THOR.usdz (the user, 2026-09-17): body, head, eyes kept; forearms, legs and the left arm rebuilt; the warrior kit carried over by tools/realmesh/base', height: 2.08, hipY: bonePos('thighL')[1],
  map: { upperBody: 'spine1', head: 'head', shoulderL: 'armL', elbowL: 'foreL', handL: 'handL', shoulderR: 'armR', elbowR: 'foreR', handR: 'handR', hipL: 'thighL', kneeL: 'shinL', hipR: 'thighR', kneeR: 'shinR' },
  meshes: { sword: 'FantasyWarrior_sword_6_characters_0', shield: 'FantasyWarrior_shield_6_characters_0', cloak: 'FantasyWarrior_cloak_6_characters_0', armor: 'FantasyWarrior_armor_6_characters_0', body: 'base_body' },
  swordHand: 'handR', shieldArm: 'foreL', bowHand: 'handL', cloakBones: [], reparent: {}, straighten: { arms: 0.55, legs: 1.0 }, plumeY: 0.30, fullBody: true, roundX: 0.66, helmHand: { x: 0.03, y: 0.24, z: -0.14, rx: 0, ry: 0, rz: 0 },
  skull: { yc: 1.94, zc: 0.03, top: TOP, chin: 1.76, coverY: 2.0 }, hairline, face: { earY: 1.905, earZ: 0.045, chinX: 0.045, lipY: 1.875, lipZ: 0.13 } }, null, 1));
console.log('wrote', OUT);
})();
