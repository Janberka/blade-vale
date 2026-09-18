// dress the new base in the OLD warrior's kit: warp the warrior's armour / cloak / shield / sword onto the base skeleton,
// segment by segment (a vertex's place along its bone and around it is kept; the radius follows the new body's girth),
// vertex order untouched so pieces.json still names every triangle. Writes the meshes into view/models/base/scene.gltf.
const fs = require('fs'); const G = require('./gltfio'), M = require('./mesh'); const { V3 } = M;
const OUT = process.argv[2] || 'view/models/base'; const MARGIN = +(process.env.MARGIN || 0.02), SCALE = +(process.env.SCALE || 1.123);   // (margin: plate sits this far off the skin; scale: props grow with the man — Thor's hips 1.092 / the warrior's 0.972)
const SRC = G.read('view/models/warrior'); const SW = G.bindWorlds(SRC); const sN = SRC.names; const sPos = nm => G.translation(SW[sN.indexOf(nm)]);
const T = G.read(OUT); const tBones = JSON.parse(fs.readFileSync(OUT + '/bones.json')); const tN = tBones.map(b => b.path); const tPos = nm => tBones[tN.indexOf(nm)].pos;
const tParts = JSON.parse(fs.readFileSync(OUT + '/parts.json')); const base = T.meshes.find(m => m.name === 'base_body');
const fingerTips = (names, pos) => { const c = [0, 0, 0]; for (const n of names) { const p = pos(n); c[0] += p[0] / names.length; c[1] += p[1] / names.length; c[2] += p[2] / names.length; } return c; };
// ---- segments: [name, srcA, srcB, tgtA, tgtB, src bones, tgt parts, tgt bone for the weights (by src bone)] ----
const SEG = [];
const seg = (name, sA, sB, tA, tB, srcBones, tgtParts, boneMap) => SEG.push({ name, sA, sB, tA, tB, srcBones, tgtParts, boneMap });
const headTopS = [0, 1.90, -0.02], headTopT = [0, 2.08, 0.03];
seg('torso', sPos('n7'), sPos('n12'), tPos('pelvis'), [0, 1.87, 0.0], ['n7', 'n8', 'n9', 'n10', 'n11', 'n75', 'n76', 'n77', 'n78', 'n14', 'n38', 'n62', 'n63', 'n64'], ['torso', 'thighL', 'thighR', { part: 'head', yMax: 1.88 }],
  { n7: 'pelvis', n8: 'spine1', n9: 'spine2', n10: 'spine3', n11: 'chest', n75: 'pelvis', n76: 'pelvis', n77: 'pelvis', n78: 'pelvis', n14: 'clavL', n38: 'clavR', n62: 'spine3', n63: 'spine3', n64: 'spine3' });
seg('head', sPos('n12'), headTopS, tPos('neck'), headTopT, ['n12', 'n13'], ['head'], { n12: 'head', n13: 'head' });
for (const [s, sh, el, ha, fb, th, hip, kn, an, toe] of [['L', 'n15', 'n16', 'n17', ['n22', 'n26', 'n30', 'n34'], 'n18', 'n65', 'n66', 'n67', 'n68'], ['R', 'n39', 'n40', 'n41', ['n46', 'n50', 'n54', 'n58'], 'n42', 'n70', 'n71', 'n72', 'n73']]) {
  const tf = s === 'L' ? ['n18', 'n22', 'n27', 'n32'] : ['n137', 'n141', 'n146', 'n151'];   // the base's finger-base bones by their old names... they were renamed: look them up by the new names below
  const tFingers = ['pinky', 'ring', 'middle', 'index'].map(f => f + s + '0'), tThumb = 'thumb' + s + '0';
  seg('arm' + s, sPos(sh), sPos(el), tPos('arm' + s), tPos('fore' + s), [sh], ['arm' + s], { [sh]: 'arm' + s });
  seg('fore' + s, sPos(el), sPos(ha), tPos('fore' + s), tPos('hand' + s), [el], ['fore' + s], { [el]: 'fore' + s });
  const srcFingers = [fb[0], fb[1], fb[2], fb[3]].map(n => sN.indexOf(n)).flatMap(i => { const kids = []; let j = i; while (j >= 0) { kids.push(sN[j]); j = SRC.g.nodes[j].children ? SRC.g.nodes[j].children[0] : -1; } return kids; });
  seg('hand' + s, sPos(ha), fingerTips(fb, sPos), tPos('hand' + s), fingerTips(tFingers, tPos), [ha, th].concat(srcFingers, [sN[sN.indexOf(th) + 1], sN[sN.indexOf(th) + 2]]), ['hand' + s], Object.fromEntries([ha, th].concat(srcFingers, [sN[sN.indexOf(th) + 1], sN[sN.indexOf(th) + 2]]).map(n => [n, 'hand' + s])));
  seg('thigh' + s, sPos(hip), sPos(kn), tPos('thigh' + s), tPos('shin' + s), [hip], ['thigh' + s], { [hip]: 'thigh' + s });
  seg('shin' + s, sPos(kn), sPos(an), tPos('shin' + s), tPos('foot' + s), [kn], ['shin' + s], { [kn]: 'shin' + s });
  seg('foot' + s, sPos(an), sPos(toe), tPos('foot' + s), tPos('toe' + s), [an, toe], ['foot' + s], { [an]: 'foot' + s, [toe]: 'foot' + s }); }
const segOfSrcBone = new Map(); for (const S of SEG) for (const b of S.srcBones) if (!segOfSrcBone.has(b)) segOfSrcBone.set(b, S);
const frame = (A, Bp) => { const d = V3.norm(V3.sub(Bp, A)); const ref = Math.abs(d[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]; const u = V3.norm(V3.cross(ref, d)), v = V3.cross(d, u); return { A, d, u, v, L: V3.len(V3.sub(Bp, A)) }; };
const local = (F, p) => { const q = V3.sub(p, F.A); const t = V3.dot(q, F.d) / F.L, a = V3.dot(q, F.u), b = V3.dot(q, F.v); return { t, a, b, r: Math.hypot(a, b), th: Math.atan2(b, a) }; };
// ---- girth bins: the base's radius (85th pct) and the kit's inner radius (20th pct) per (t band, sector) of every segment ----
const NB = 26, NS = 32, TMIN = -0.6, TMAX = 1.4;
const binOf = (t, th) => [Math.max(0, Math.min(NB - 1, Math.floor((t - TMIN) / (TMAX - TMIN) * NB))), ((Math.floor((th + Math.PI) / (2 * Math.PI) * NS) % NS) + NS) % NS];
const pct = (arr, q) => { if (!arr.length) return null; const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const armor = SRC.meshes.find(m => m.short === 'armor' || /armor/.test(m.name));
const ALL_TRIS = (() => { const T = []; for (let t = 0; t < base.idx.length; t += 3) for (const v of [base.idx[t], base.idx[t+1], base.idx[t+2]]) T.push(base.pos[v*3], base.pos[v*3+1], base.pos[v*3+2]); return new Float32Array(T); })();
for (const S of SEG) { S.fs = frame(S.sA, S.sB); S.ft = frame(S.tA, S.tB); const tb = Array.from({ length: NB }, () => Array.from({ length: NS }, () => [])), sb = Array.from({ length: NB }, () => Array.from({ length: NS }, () => []));
  const partIds = S.tgtParts.map(p => tParts.classes.indexOf(typeof p === 'string' ? p : p.part)), yMins = S.tgtParts.map(p => typeof p === 'string' || p.yMin == null ? -9 : p.yMin), yMaxs = S.tgtParts.map(p => typeof p === 'string' || p.yMax == null ? 9 : p.yMax); for (let v = 0; v < base.pos.length / 3; v++) { const pi = partIds.indexOf(tParts.vclass[v]); if (pi < 0 || base.pos[v*3+1] < yMins[pi] || base.pos[v*3+1] > yMaxs[pi]) continue; const l = local(S.ft, [base.pos[v*3], base.pos[v*3+1], base.pos[v*3+2]]); if (l.t < TMIN || l.t > TMAX) continue; const [i, j] = binOf(l.t, l.th); tb[i][j].push(l.r); }
  { const inPart = new Uint8Array(base.pos.length / 3); for (let v = 0; v < inPart.length; v++) { const pi = partIds.indexOf(tParts.vclass[v]); inPart[v] = pi >= 0 && base.pos[v*3+1] >= yMins[pi] && base.pos[v*3+1] <= yMaxs[pi] ? 1 : 0; }
    S.tris = ALL_TRIS; }
  const srcIdx = S.srcBones.map(n => armor.joints.indexOf(sN.indexOf(n)));
  for (let v = 0; v < armor.pos.length / 3; v++) { let best = -1, bw = 0; for (let c = 0; c < 4; c++) if (armor.w[v*4+c] > bw) { bw = armor.w[v*4+c]; best = armor.ji[v*4+c]; } if (!srcIdx.includes(best)) continue; const l = local(S.fs, [armor.pos[v*3], armor.pos[v*3+1], armor.pos[v*3+2]]); if (l.t < TMIN || l.t > TMAX) continue; const [i, j] = binOf(l.t, l.th); sb[i][j].push(l.r); }
  const K = Array.from({ length: NB }, () => new Array(NS).fill(null)), KI = Array.from({ length: NB }, () => new Array(NS).fill(null)); let sum = 0, n = 0;
  for (let i = 0; i < NB; i++) for (let j = 0; j < NS; j++) { const rt = pct(tb[i][j], 1.0), rs = pct(sb[i][j], 0.2); if (rt != null) { K[i][j] = rt; sum += rt; n++; } if (rs != null) KI[i][j] = rs; }   // K: the body's outermost radius in the bin; KI: the kit's inner layer there
  S.kMean = n ? sum / n : 0; if (!n) console.log('  (no overlap for', S.name, ')');
  for (let j = 0; j < NS; j++) { let last = null; for (let i = 0; i < NB; i++) { if (K[i][j] != null) last = K[i][j]; else if (last != null) K[i][j] = last; } last = null; for (let i = NB - 1; i >= 0; i--) { if (K[i][j] != null) last = K[i][j]; else if (last != null) K[i][j] = last; } }   // fill along t
  for (let i = 0; i < NB; i++) for (let j = 0; j < NS; j++) if (K[i][j] == null) K[i][j] = S.kMean;
  for (let j = 0; j < NS; j++) { let last = null; for (let i = 0; i < NB; i++) { if (KI[i][j] != null) last = KI[i][j]; else if (last != null) KI[i][j] = last; } last = null; for (let i = NB - 1; i >= 0; i--) { if (KI[i][j] != null) last = KI[i][j]; else if (last != null) KI[i][j] = last; } } for (let i = 0; i < NB; i++) for (let j = 0; j < NS; j++) if (KI[i][j] == null) KI[i][j] = 0; S.KI = KI;
  const K1 = K.map((row, i) => row.map((k, j) => { let mx = -1e9; for (let dj = -1; dj <= 1; dj++) { const jj = (j + dj + NS) % NS; mx = Math.max(mx, K[i][jj]); } return mx; }));   // dilate round the ring only (a band's neighbours above and below would turn the waist into the chest)
  const K2 = K1.map((row, i) => row.map((k, j) => { let s = 0, c = 0; for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const ii = i + di, jj = (j + dj + NS) % NS; if (ii < 0 || ii >= NB) continue; const w = (di === 0 && dj === 0) ? 2 : 1; s += K1[ii][jj] * w; c += w; } return s / c; }));   // then a light 3×3 blur, wrapping round
  S.K = K2; console.log(S.name.padEnd(7), 'body r mean', S.kMean.toFixed(3), 'bands', K2.map(r => (r.reduce((a, b) => a + b, 0) / NS).toFixed(2)).join(' ')); }
const kAt = (S, t, th) => { const x = Math.max(0, Math.min(NB - 1.001, (t - TMIN) / (TMAX - TMIN) * NB - 0.5)), i0 = Math.floor(x), fi = x - i0; const y = ((th + Math.PI) / (2 * Math.PI) * NS - 0.5 + NS) % NS, j0 = Math.floor(y), fj = y - j0, j1 = (j0 + 1) % NS; const i1 = Math.min(NB - 1, i0 + 1);
  return S.K[i0][j0] * (1 - fi) * (1 - fj) + S.K[i1][j0] * fi * (1 - fj) + S.K[i0][j1] * (1 - fi) * fj + S.K[i1][j1] * fi * fj; };
const kiAt = (S, t, th) => { const [i, j] = binOf(t, th); return S.KI[i][j]; };
// the body's outer surface along a radial ray (from the segment's axis, through the vertex): the FARTHEST crossing, or -1
function castR(T, ox, oy, oz, dx, dy, dz) { const hits = [];
  for (let i = 0; i < T.length; i += 9) { const ax = T[i], ay = T[i+1], az = T[i+2], e1x = T[i+3] - ax, e1y = T[i+4] - ay, e1z = T[i+5] - az, e2x = T[i+6] - ax, e2y = T[i+7] - ay, e2z = T[i+8] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det, tx = ox - ax, ty = oy - ay, tz = oz - az, u = (tx * px + ty * py + tz * pz) * inv; if (u < -1e-6 || u > 1 + 1e-6) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv; hits.push(t); }
  // the crossings along the whole line, deduped (shared edges): their count says whether the origin lies in the flesh; the first EXIT ahead is the surface
  hits.sort((a, b) => a - b); const H = []; for (const t of hits) if (!H.length || t - H[H.length - 1] > 1e-5) H.push(t);
  let inside = H.filter(t => t < 0).length % 2 === 1; for (const t of H) { if (t < 0) continue; if (inside) return t; inside = !inside; }
  return -1; }
const hitR1 = (S, t, th) => { const o = V3.add(S.ft.A, V3.scale(S.ft.d, t * S.ft.L)); const dir = V3.norm(V3.add(V3.scale(S.ft.u, Math.cos(th)), V3.scale(S.ft.v, Math.sin(th)))); return castR(S.tris, o[0], o[1], o[2], dir[0], dir[1], dir[2]); };
// the body's outermost surface in the neighbourhood a kit triangle spans (3.5 cm along the bone, ±7° round it): the flesh between two kit vertices must not bulge through the flat span between them
const hitR = (S, l) => { if (!S.tris || !S.tris.length || l.r < 1e-4) return -1; const dt = 0.035 / S.ft.L, da = 0.12; let best = -1; for (const [t, th] of [[l.t, l.th], [l.t + dt, l.th], [l.t - dt, l.th], [l.t, l.th + da], [l.t, l.th - da]]) { const h = hitR1(S, t, th); if (h > 0 && h < l.r + 0.25) best = Math.max(best, h); } return best; };   // (a hit more than 25 cm past the vertex is another part of the body — a hand's ray reaching the leg)
// THE PUSH FIELD: per bin, how far the kit's INNER layer must move to clear the flesh (its own casts); every layer above moves with it, so mail, straps and plate keep their spacing (pushed one by one to the skin they z-fought as one patchwork)
function pushField(S, m, verts) { const D = Array.from({ length: NB }, () => new Array(NS).fill(null)); const bins = new Map();
  for (const v of verts) { const l = local(S.fs, [m.pos[v*3], m.pos[v*3+1], m.pos[v*3+2]]); const [i, j] = binOf(l.t, l.th); const k = i * NS + j; (bins.get(k) || bins.set(k, []).get(k)).push({ l, v }); }
  for (const [k, list] of bins) { const rs = list.map(x => x.l.r).sort((a, b) => a - b), r20 = rs[Math.floor(rs.length * 0.2)]; let need = 0; for (const x of list) { if (x.l.r > r20 + 0.012) continue; const R = hitR(S, x.l); if (R > 0) need = Math.max(need, R + (S.margin != null ? S.margin : MARGIN) - x.l.r); } D[Math.floor(k / NS)][k % NS] = need; }
  for (let j = 0; j < NS; j++) { let last = null; for (let i = 0; i < NB; i++) { if (D[i][j] != null) last = D[i][j]; else if (last != null) D[i][j] = last; } last = null; for (let i = NB - 1; i >= 0; i--) { if (D[i][j] != null) last = D[i][j]; else if (last != null) D[i][j] = last; } }
  for (let i = 0; i < NB; i++) for (let j = 0; j < NS; j++) if (D[i][j] == null) D[i][j] = 0;
  return D.map((row, i) => row.map((d, j) => { let s = 0, c = 0; for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const ii = i + di, jj = (j + dj + NS) % NS; if (ii < 0 || ii >= NB) continue; const w = (di === 0 && dj === 0) ? 2 : 1; s += D[ii][jj] * w; c += w; } return s / c; })); }
const fieldAt = (D, t, th) => { const x = Math.max(0, Math.min(NB - 1.001, (t - TMIN) / (TMAX - TMIN) * NB - 0.5)), i0 = Math.floor(x), fi = x - i0; const y = ((th + Math.PI) / (2 * Math.PI) * NS - 0.5 + NS) % NS, j0 = Math.floor(y), fj = y - j0, j1 = (j0 + 1) % NS; const i1 = Math.min(NB - 1, i0 + 1);
  return D[i0][j0] * (1 - fi) * (1 - fj) + D[i1][j0] * fi * (1 - fj) + D[i0][j1] * (1 - fi) * fj + D[i1][j1] * fi * fj; };
// PUSH-OUT ONLY: a kit vertex keeps its own radius unless the body reaches past it there — then it sits just outside the body, keeping up to 3 cm of its
// relief over the kit's inner layer (a rivet stays a rivet; a pauldron that already clears the deltoid stays where it was; a collar shrinks to the neck)
// a vertex moves by the bin's push (the layers keep their spacing), capped at what its own ray needs plus 4 cm (a pauldron that already clears the deltoid does not sail off with the sleeve's push) and never left inside the flesh
const warp = (S, p, o = {}) => { const l = local(S.fs, p); if (S.rigid) return S.rigid(p); if (o.lift && l.t > 0.72) { const f = Math.min(1, (l.t - 0.72) / 0.28), sf = f * f * (3 - 2 * f), back = Math.max(0, Math.min(1, 0.5 - 0.5 * Math.sin(l.th) + 0.15)); l.t += o.lift * sf * back / S.ft.L; } /* (lift: model units, the cuirass' back and sides rise over the traps) */ const mg = o.margin != null ? o.margin : MARGIN; const R = hitR(S, l); const own = R > 0 ? Math.max(0, R + mg - l.r) : 0; let push = o.field ? Math.min(fieldAt(o.field, l.t, l.th), own + 0.04) : own; if (R > 0 && l.r + push < R + mg * 0.5) push = R + mg * 0.5 - l.r; const rNew = l.r + push; const k = l.r > 1e-4 ? rNew / l.r : 1; return V3.add(V3.add(S.ft.A, V3.scale(S.ft.d, l.t * S.ft.L)), V3.add(V3.scale(S.ft.u, l.a * k), V3.scale(S.ft.v, l.b * k))); };
// THE HEAD is rigid: the helmet is carried over whole — eyes on the eyes, scaled by the ratio of the two heads' widths at eye level
{ const S = SEG.find(x => x.name === 'head'); const sb = SRC.meshes.find(m => /body/.test(m.name)); const spj = JSON.parse(fs.readFileSync('view/models/warrior/pieces.json')).body; const sock = spj.classes.indexOf('socket'), hd = spj.classes.indexOf('head');
  const mean = (pos, sel) => { const c = [0, 0, 0]; let n = 0; for (let v = 0; v < pos.length / 3; v++) if (sel(v)) { c[0] += pos[v*3]; c[1] += pos[v*3+1]; c[2] += pos[v*3+2]; n++; } return c.map(x => x / n); };
  const sEye = mean(sb.pos, v => spj.vclass[v] === sock), eyeCls = tParts.classes.indexOf('eye'), tEye = mean(base.pos, v => tParts.vclass[v] === eyeCls);
  const width = (pos, sel, y) => { const xs = []; for (let v = 0; v < pos.length / 3; v++) if (sel(v) && Math.abs(pos[v*3+1] - y) < 0.05) xs.push(Math.abs(pos[v*3])); return 2 * pct(xs, 0.9); };
  const hcls = tParts.classes.indexOf('head'); const ws = width(sb.pos, v => spj.vclass[v] === hd || spj.vclass[v] === sock, sEye[1]), wt = width(base.pos, v => tParts.vclass[v] === hcls, tEye[1]); const k = wt / ws * 1.03;
  console.log('head: src eye', sEye.map(x => x.toFixed(3)), 'tgt eye', tEye.map(x => x.toFixed(3)), 'widths', ws.toFixed(3), wt.toFixed(3), 'k', k.toFixed(3));
  S.rigid = p => V3.add(tEye, V3.scale(V3.sub(p, sEye), k)); S.headK = k; }
// ---- warp a skinned mesh: every vertex blends the warps of the segments its bones belong to; weights move to the base's bones ----
function retargetSkinned(m, o = {}) { const nv = m.pos.length / 3, pos = new Float32Array(nv * 3), ji = new Uint16Array(nv * 4), w = new Float32Array(nv * 4);
  const bySeg = new Map(); for (let v = 0; v < nv; v++) { let best = -1, bw = 0; for (let c = 0; c < 4; c++) if (m.w[v*4+c] > bw) { bw = m.w[v*4+c]; best = m.ji[v*4+c]; } const S = segOfSrcBone.get(sN[m.joints[best]]); if (S) (bySeg.get(S) || bySeg.set(S, []).get(S)).push(v); }
  const fields = new Map(); for (const [S, vs] of bySeg) { S.margin = o.margin; fields.set(S, S.rigid ? null : pushField(S, m, vs)); S.margin = undefined; }
  for (let v = 0; v < nv; v++) { const p = [m.pos[v*3], m.pos[v*3+1], m.pos[v*3+2]]; let acc = [0, 0, 0], tot = 0; const wm = new Map();
    for (let c = 0; c < 4; c++) { const wt = m.w[v*4+c]; if (wt <= 0) continue; const sb = sN[m.joints[m.ji[v*4+c]]]; const S = segOfSrcBone.get(sb); if (!S) { console.log('unmapped bone', sb); continue; }
      const q = warp(S, p, { margin: o.margin, field: fields.get(S), lift: o.liftOf ? o.liftOf(v, S) : 0 }); acc = V3.add(acc, V3.scale(q, wt)); tot += wt; const tb = tN.indexOf(S.boneMap[sb] || S.boneMap[S.srcBones[0]]); wm.set(tb, (wm.get(tb) || 0) + wt); }
    if (tot > 0) acc = V3.scale(acc, 1 / tot); pos.set(acc, v * 3); const [j4, w4] = M.packW([...wm.entries()]); ji.set(j4, v * 4); w.set(w4, v * 4); }
  return { pos, ji, w }; }
// ---- rigid props: the sword in the hand, the shield on the forearm — carried over between anatomical frames, scaled with the man ----
const handFrame = (origin, fingerBases, thumb, pos) => { const o = pos(origin); const f = V3.norm(V3.sub(fingerTips(fingerBases, pos), o)); const th = V3.norm(V3.sub(pos(thumb), o)); const n = V3.norm(V3.cross(f, th)); const s = V3.cross(n, f); return { o, f, n, s }; };
const boneFrame = (a, b, pos) => { const o = pos(a); const f = V3.norm(V3.sub(pos(b), o)); const ref = Math.abs(f[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]; const s = V3.norm(V3.cross(ref, f)); const n = V3.cross(f, s); return { o, f, n, s }; };
function carry(m, Fs, Ft, tBone) { const nv = m.pos.length / 3, pos = new Float32Array(nv * 3), ji = new Uint16Array(nv * 4), w = new Float32Array(nv * 4); const tb = tN.indexOf(tBone);
  for (let v = 0; v < nv; v++) { const q = V3.sub([m.pos[v*3], m.pos[v*3+1], m.pos[v*3+2]], Fs.o); const a = V3.dot(q, Fs.f) * SCALE, b = V3.dot(q, Fs.n) * SCALE, c = V3.dot(q, Fs.s) * SCALE; pos.set(V3.add(Ft.o, V3.add(V3.scale(Ft.f, a), V3.add(V3.scale(Ft.n, b), V3.scale(Ft.s, c)))), v * 3); ji.set([tb, 0, 0, 0], v * 4); w.set([1, 0, 0, 0], v * 4); }
  return { pos, ji, w }; }
for (const S of SEG) { let hits = 0, n = 0, sumR = 0; for (let v = 0; v < armor.pos.length / 3; v += 7) { const l = local(S.fs, [armor.pos[v*3], armor.pos[v*3+1], armor.pos[v*3+2]]); if (l.t < -0.2 || l.t > 1.2) continue; n++; const R = hitR(S, l); if (R > 0) { hits++; sumR += R; } } console.log('  cast', S.name, 'tris', S.tris ? S.tris.length / 9 : 0, 'verts', n, 'hits', hits, 'meanR', hits ? (sumR / hits).toFixed(3) : '-'); }
const out = [];
for (const m of SRC.meshes) { const short = m.name.replace('FantasyWarrior_', '').replace('_6_characters_0', ''); if (short === 'body') continue; let r;
  const same = o => ({ o, f: [1, 0, 0], n: [0, 1, 0], s: [0, 0, 1] });
  if (short === 'sword') r = carry(m, same(sPos('n41')), same(tPos('handR')), 'handR');
  else if (short === 'shield') r = carry(m, same(sPos('n16')), same(tPos('foreL')), 'foreL');
    else if (short === 'cloak') r = retargetSkinned(m, { margin: 0.05 });   // (a cape hangs off the back, not on it)
  else if (short === 'armor') { const pj = JSON.parse(fs.readFileSync('view/models/warrior/pieces.json')).armor, cu = pj.classes.indexOf('cuirass'); r = retargetSkinned(m, { liftOf: (v, S) => S.name === 'torso' && pj.vclass[v] !== pj.classes.indexOf('pauldron') ? 0.09 : 0 }); }   // (the collar: 9 cm higher at the back over the traps — every piece there rises together, or the layers tear apart; the pauldrons ride the arms)
  else r = retargetSkinned(m);
  // normals: rotate the old ones by the same warp (cheap: recompute from the warped geometry instead)
  out.push({ name: m.name, pos: r.pos, uv: m.uv, ji: r.ji, w: r.w, idx: m.idx, material: 1 }); console.log('retargeted', short, m.pos.length / 3, 'verts'); }
// normals from the warped geometry, welded by position
for (const m of out) { const mm = M.empty(); mm.pos = Array.from(m.pos); mm.uv = Array.from(m.uv); mm.ji = Array.from(m.ji); mm.w = Array.from(m.w); mm.idx = Array.from(m.idx); mm.part = new Array(m.pos.length / 3).fill('x'); const f = M.finish(mm); if (f.pos.length !== mm.pos.length) throw new Error('finish dropped verts (unused vertices in ' + m.name + ')'); m.nrm = Float32Array.from(f.nrm); }
// ---- write: the base body + the kit into one glTF, two materials ----
const g = T.g; const skel = { names: tN, parent: tBones.map(b => b.parent), world: tBones.map((b, i) => { const n = T.g.nodes[i]; return null; }) };
// (rebuild the skeleton from the existing file's ibm inverses + node matrices)
const ibm = T.meshes[0].ibm; skel.world = tN.map((_, i) => G.invert(Array.from(ibm.subarray(i * 16, i * 16 + 16)))); skel.local = skel.world.map((w, i) => skel.parent[i] < 0 ? w : G.mul(G.invert(skel.world[skel.parent[i]]), w));
const extras = T.meshes.filter(m => m.name === 'hair_long').map(m => ({ name: m.name, pos: m.pos, nrm: m.nrm, uv: m.uv, ji: m.ji, w: m.w, idx: m.idx, material: 2 }));   // (the hair and beard cards: through as they are, on the hair material)
const meshes = [{ name: 'base_body', pos: base.pos, nrm: base.nrm, uv: base.uv, ji: base.ji, w: base.w, idx: base.idx, material: 0 }].concat(out, extras);
fs.copyFileSync('view/models/warrior/6_characters_baseColor.jpg', OUT + '/6_characters_baseColor.jpg');
G.write(OUT, { meshes, skeleton: skel, materials: [{ name: 'base', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 } }, { name: 'kit', pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicFactor: 0, roughnessFactor: 0.9 } }, { name: 'hair', pbrMetallicRoughness: { baseColorTexture: { index: 2 }, metallicFactor: 0, roughnessFactor: 0.9 }, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true }], images: ['atlas.jpg', '6_characters_baseColor.jpg', 'hair.png'] });   // (no normal map: the game's surface pass draws the skin's detail; the viewer's normals were the Thor maps)
fs.copyFileSync('view/models/warrior/pieces.json', OUT + '/pieces.json');
console.log('wrote', OUT, 'with', meshes.length, 'meshes');
// ---- the Corinthian helm: the same rigid head carry (eyes on the eyes, the heads' width ratio), written next to the base ----
{ const S = SEG.find(x => x.name === 'head'); const hb = 'view/models/warrior/helm_corinthian'; const h = JSON.parse(fs.readFileSync(hb + '.json')); const buf = fs.readFileSync(hb + '.bin'); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const nv = h.verts, nt = h.tris; let o = 0; const pos = new Float32Array(ab, o, nv * 3); o += nv * 12; const rest = new Uint8Array(ab, o);
  const out = new Float32Array(nv * 3); const mn = [9, 9, 9], mx = [-9, -9, -9]; for (let v = 0; v < nv; v++) { const q = S.rigid([pos[v*3], pos[v*3+1], pos[v*3+2]]); out.set(q, v * 3); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); } }
  fs.writeFileSync(OUT + '/helm_corinthian.bin', Buffer.concat([Buffer.from(out.buffer), Buffer.from(rest)])); h.bounds = { min: mn, max: mx }; h.refit = 'carried onto the base head with the sallet: eyes on the eyes, scale ' + S.headK.toFixed(3); fs.writeFileSync(OUT + '/helm_corinthian.json', JSON.stringify(h, null, 1));
  for (const f of ['color', 'normal', 'rough', 'occl']) fs.copyFileSync(hb + '_' + f + '.jpg', OUT + '/helm_corinthian_' + f + '.jpg'); console.log('helm_corinthian carried over'); }
