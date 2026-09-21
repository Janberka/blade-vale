// THE WARDROBE: every ware the base rig owns, fitted to an adopted body — the second half of an adoption.
//
//   node tools/realmesh/adopt/wardrobe.js tools/realmesh/adopt/profiles/<id>.json [--baked] [--ship]
//        reads  tools/chared/build/<id>.body   (adopt.js)            and assets/rigs/base (the wares, as the game ships them)
//        writes tools/chared/rigs/<id>         (the whole rig, where the char editor's sizes.json finds it; tools/ never ships)   --ship: assets/rigs/<id>, for the game
//
// A ware is never re-modelled for a new body. It is CARRIED from the base's bind pose into this body's bind pose by the
// bones it already hangs on: every bone has a map  base space → this body's space  in its ANATOMICAL frame (the same
// frames adopt.js made the two skeletons congruent with), and a vertex goes where its own skin weights send it,
//       p' = Σ w(b) · map_b(p)
//   a LIMB (upper arm, forearm, thigh, shin) and the TRUNK are cylinders: a vertex keeps its place ALONG the bone (as a
//     fraction of its length) and its bearing ROUND it, and radially it keeps its OFFSET FROM THE SKIN —
//       r' = skin_this(t, θ) + (r − skin_base(t, θ)) · min(1, skin_this / skin_base)
//     with both skins read by rays from the bone's axis and smoothed, so a strap still stands proud of the leather under it
//     and a bolt is still a bolt, while the whole piece closes onto a slimmer arm and its thickness shrinks with the limb
//     (kept in centimetres, a steel arm made for a 50 cm bicep stood off a 35 cm one like a stovepipe). Never under the skin.
//   a hand, a finger, a foot, a collar bone: the box of that body part in the bone's frame goes onto the box of this one's.
//   RIGID things ride one bone and keep their shape: the sword (about the fist, scaled with the hand), the shield (about
//     its place on the forearm, scaled with the man), the helm and the hair (about the EYES, scaled with the skull).
// The base's trousers are his LEGS — he has no others — so for them the "skin" of the base is the trousers' own smoothed
// outside, and on a body with legs of its own they come out as cloth laid over those.
// The shoulder plates go in RAW (tools/chared/items/pauldron.json, carried the same way) for the char editor to seat, border,
// floor and tile on THIS deltoid; `await __exportArmor()` there, then --baked puts the finished plates in — the base's own loop.
const fs = require('fs'), path = require('path');
const { THREE, V, smooth, frameQ, mirrorP, triSoup, cast, ROOT, SIDES, FINGERS, fingerBones, frames, refRig } = require('./lib'), G = require('../base/gltfio');
const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), BAKED = process.argv.includes('--baked'), SHIP = process.argv.includes('--ship');
const BODY = path.join(ROOT, 'tools/chared/build', prof.id + '.body'), OUT = SHIP ? path.join(ROOT, 'assets/rigs', prof.id) : path.join(ROOT, 'tools/chared/rigs', prof.id), BASE = path.join(ROOT, 'assets/rigs/base'), ITEMS = path.join(ROOT, 'tools/chared/items');
const log = (...a) => console.log(...a), ref = refRig(), { BONES, PARENT, REF } = ref, bi = n => BONES.indexOf(n);
const A = G.read(BODY), adopt = JSON.parse(fs.readFileSync(path.join(BODY, 'adopt.json'), 'utf8')), PG = adopt.joints, PT = ref.P, baseRig = JSON.parse(fs.readFileSync(path.join(BASE, 'rig.json'), 'utf8')), rig = JSON.parse(fs.readFileSync(path.join(BODY, 'rig.json'), 'utf8'));
const basePieces = JSON.parse(fs.readFileSync(path.join(BASE, 'pieces.json'), 'utf8')).body, myParts = JSON.parse(fs.readFileSync(path.join(BODY, 'parts.json'), 'utf8'));
const meshT = n => REF.meshes.find(m => m.name === n), bodyT = meshT('base_body'), legsT = meshT('legs'), bodyG = A.meshes.find(m => m.name === 'base_body');

// ---------------------------------------------------------------- frames and lengths, both rigs
const FT = frames(PT, ref.tips), FG = frames(PG, adopt.tips), UP = frameQ([0, 1, 0], [1, 0, 0]);
for (const R of [[FT, PT], [FG, PG]]) { const [F, P] = R; for (const n of ['pelvis', 'spine1', 'spine2', 'spine3', 'spine4', 'chest', 'neck', 'head']) F[n] = UP; for (const S of SIDES) F['clav' + S] = frameQ(V.sub(P['arm' + S], P['clav' + S]), [0, 1, 0]); }
const CHILD = { pelvis: 'spine1', spine1: 'spine2', spine2: 'spine3', spine3: 'spine4', spine4: 'chest', chest: 'neck', neck: 'head' };
for (const S of SIDES) { Object.assign(CHILD, { ['clav' + S]: 'arm' + S, ['arm' + S]: 'fore' + S, ['fore' + S]: 'hand' + S, ['hand' + S]: FINGERS.middle + S + '1', ['thigh' + S]: 'shin' + S, ['shin' + S]: 'foot' + S, ['foot' + S]: 'toe' + S, ['thumb' + S + '0']: 'thumb' + S + '1', ['thumb' + S + '1']: 'thumb' + S + '2' });
  for (const phys in FINGERS) { const b = fingerBones(phys, S); if (b.base) CHILD[b.base] = b.mcp; CHILD[b.mcp] = b.pip; CHILD[b.pip] = b.dip; } }
// (a LEFT limb's frame is its right-hand twin seen in the mirror — lib.js `frames` — so its first axis runs from the joint BACK UP the
//  limb, not down it. Congruence does not care, both rigs being taken the same way; walking along a bone does.)
const ALONG = n => /L\d?$/.test(n) && !/^clav/.test(n) ? -1 : 1;
const lenOf = (P, tips, n) => CHILD[n] ? V.dist(P[n], P[CHILD[n]]) : tips[n] ? V.dist(P[n], tips[n]) : null;
const toLocal = (F, P, n, p) => { const v = new THREE.Vector3(...V.sub(p, P[n])).applyQuaternion(F[n].clone().invert()); return [v.x, v.y, v.z]; }, toWorld = (F, P, n, q) => { const v = new THREE.Vector3(...q).applyQuaternion(F[n]); return V.add(P[n], [v.x, v.y, v.z]); };

// ---------------------------------------------------------------- the two bodies: who owns which vertex
const domOf = (m, names) => { const nv = m.pos.length / 3, d = new Array(nv); for (let v = 0; v < nv; v++) { let b = 0; for (let k = 1; k < 4; k++) if (m.w[v * 4 + k] > m.w[v * 4 + b]) b = k; d[v] = names[m.joints[m.ji[v * 4 + b]]]; } return d; };
const domT = domOf(bodyT, REF.names), domG = domOf(bodyG, A.names), domLegs = domOf(legsT, REF.names);
const clsT = basePieces.vclass.map(c => basePieces.classes[c]), clsG = myParts.vclass.map(c => myParts.classes[c]);
const trisWhere = (m, ok) => { const idx = []; for (let t = 0; t < m.idx.length; t += 3) if (ok(m.idx[t]) && ok(m.idx[t + 1]) && ok(m.idx[t + 2])) idx.push(m.idx[t], m.idx[t + 1], m.idx[t + 2]); return triSoup(m.pos, idx); };

// ---------------------------------------------------------------- skin fields: radius of the skin round a bone's axis, by (t along, θ round)
const NS = 32;
function field(axisAt, dirAt, soup, outer, T0 = -0.1, T1 = 1.1, NT = 20) { const R = [];
  for (let i = 0; i < NT; i++) { const t = T0 + (i + 0.5) / NT * (T1 - T0), o = axisAt(t), row = []; for (let j = 0; j < NS; j++) { const th = -Math.PI + (j + 0.5) / NS * 2 * Math.PI, h = cast(soup, o, dirAt(t, th), 0.6); row.push(h.length ? (outer ? h[h.length - 1] : h[0]) : null); } R.push(row); }
  // holes: round the ring first (a missed ray between two hits), then along the bone (past the end of the part)
  for (const row of R) { if (row.every(x => x == null)) continue; for (let j = 0; j < NS; j++) if (row[j] == null) { let a = 1, b = 1; while (row[(j - a + NS) % NS] == null) a++; while (row[(j + b) % NS] == null) b++; row[j] = (row[(j - a + NS) % NS] * b + row[(j + b) % NS] * a) / (a + b); } }
  const full = R.map((row, i) => row[0] != null ? i : -1).filter(i => i >= 0); if (!full.length) return null;
  for (let i = 0; i < NT; i++) if (R[i][0] == null) { const near = full.reduce((a, b) => Math.abs(b - i) < Math.abs(a - i) ? b : a); R[i] = R[near].slice(); }
  const blur = R.map((row, i) => row.map((_, j) => { let s = 0, c = 0; for (let di = -1; di <= 1; di++) for (let dj = -2; dj <= 2; dj++) { const ii = Math.min(NT - 1, Math.max(0, i + di)), w = (di ? 1 : 2) * (3 - Math.abs(dj)); s += R[ii][(j + dj + NS) % NS] * w; c += w; } return s / c; }));
  const at = (F, t, th) => { const x = Math.min(NT - 1.001, Math.max(0, (t - T0) / (T1 - T0) * NT - 0.5)), i0 = Math.floor(x), fi = x - i0, y = (((th + Math.PI) / (2 * Math.PI) * NS - 0.5) % NS + NS) % NS, j0 = Math.floor(y), fj = y - j0, j1 = (j0 + 1) % NS, i1 = Math.min(NT - 1, i0 + 1);
    return F[i0][j0] * (1 - fi) * (1 - fj) + F[i1][j0] * fi * (1 - fj) + F[i0][j1] * (1 - fi) * fj + F[i1][j1] * fi * fj; };
  return { smooth: (t, th) => at(blur, t, th), raw: (t, th) => at(R, t, th) }; }
const limbField = (F, P, tips, n, soup, outer) => { const L = lenOf(P, tips, n) * ALONG(n); return field(t => toWorld(F, P, n, [t * L, 0, 0]), (t, th) => { const v = new THREE.Vector3(0, Math.cos(th), Math.sin(th)).applyQuaternion(F[n]); return [v.x, v.y, v.z]; }, soup, outer); };
// the trunk is ONE cylinder, pelvis → neck, about the line of its own joints
// the trunk is ONE cylinder about the line of its own joints: u 0 → 1 runs pelvis joint → neck, and u −1 → 0 runs the CROTCH → pelvis
// joint (one rig puts its pelvis joint level with the hips, another a hand above them: below the joint it is the body that says how far down the trunk goes)
const TRUNK = ['pelvis', 'spine1', 'spine2', 'spine3', 'spine4', 'chest', 'neck'];
const crotchOf = (m, ok) => { let lo = 9; for (let v = 0; v < m.pos.length / 3; v++) if (ok(v) && Math.abs(m.pos[v * 3]) < 0.035) lo = Math.min(lo, m.pos[v * 3 + 1]); return lo; };
const trunkAxis = (P, crotch) => { const y0 = P.pelvis[1], y1 = P.neck[1]; return { y0, y1, crotch, uOf: y => y >= y0 ? (y - y0) / (y1 - y0) : (y - y0) / (y0 - crotch), at: u => { const y = u >= 0 ? y0 + u * (y1 - y0) : y0 + u * (y0 - crotch); let i = 1; while (i < TRUNK.length - 1 && P[TRUNK[i]][1] < y) i++; const a = P[TRUNK[i - 1]], b = P[TRUNK[i]], f = Math.min(1, Math.max(0, (y - a[1]) / (b[1] - a[1] || 1e-9))); return [0, y, a[2] + (b[2] - a[2]) * f]; } }; };
const axT = trunkAxis(PT, crotchOf(legsT, v => domLegs[v] === 'pelvis')), axG = trunkAxis(PG, crotchOf(bodyG, v => clsG[v] === 'hips' || clsG[v] === 'torso')), trunkField = (ax, soup) => field(u => ax.at(u), (u, th) => [Math.cos(th), 0, Math.sin(th)], soup, false, -1, 1.05, 30);
log('reading the skins…');
const FIELD = { T: {}, G: {} };
FIELD.T.trunk = trunkField(axT, trisWhere(bodyT, v => clsT[v] === 'torso')); FIELD.G.trunk = trunkField(axG, trisWhere(bodyG, v => clsG[v] === 'torso' || clsG[v] === 'hips'));
log('crotch  base', (axT.crotch * 100).toFixed(1), 'cm (', ((axT.y0 - axT.crotch) * 100).toFixed(1), 'under his pelvis joint) · his', (axG.crotch * 100).toFixed(1), 'cm (', ((axG.y0 - axG.crotch) * 100).toFixed(1), 'under)');
for (const S of SIDES) { for (const n of ['arm', 'fore']) { const ok = c => c === 'arm' + S || c === 'fore' + S || c === 'hand' + S; FIELD.T[n + S] = limbField(FT, PT, ref.tips, n + S, trisWhere(bodyT, v => ok(clsT[v])), false); FIELD.G[n + S] = limbField(FG, PG, adopt.tips, n + S, trisWhere(bodyG, v => ok(clsG[v])), false); }
  for (const n of ['thigh', 'shin']) { const ok = c => c === 'thigh' + S || c === 'shin' + S || c === 'foot' + S || c === 'torso' || c === 'hips'; FIELD.T[n + S] = limbField(FT, PT, ref.tips, n + S, trisWhere(legsT, v => !domLegs[v].endsWith(S === 'L' ? 'R' : 'L')), true); FIELD.G[n + S] = limbField(FG, PG, adopt.tips, n + S, trisWhere(bodyG, v => ok(clsG[v])), false); } }

if (process.env.FIELD_DEBUG) for (const n of process.env.FIELD_DEBUG.split(',')) for (const t of [0.15, 0.5, 0.85]) { const row = k => Array.from({ length: 16 }, (_, j) => (FIELD[k][n].smooth(t, -Math.PI + (j + 0.5) / 16 * 2 * Math.PI) * 100).toFixed(0).padStart(3)).join(''); log(n.padEnd(7), 't', t, ' base', row('T'), ' | his', row('G')); }
// ---------------------------------------------------------------- boxes: a body part's extent in its bone's frame
function boxOf(F, P, n, pts) { const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (const p of pts) { const q = toLocal(F, P, n, p); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); } } return pts.length >= 4 ? { lo, hi } : null; }
const ptsOf = (m, dom, n) => { const out = []; for (let v = 0; v < dom.length; v++) if (dom[v] === n) out.push([m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]]); return out; };
const BOX = { T: {}, G: {} };
// the feet: the base has none of his own (his boots are his feet), and this man's are measured bare — sole, toes and heel
const gFoot = {}; for (const S of SIDES) gFoot[S] = ptsOf(bodyG, domG, 'foot' + S).concat(ptsOf(bodyG, domG, 'toe' + S));
for (const n of BONES) { if (FIELD.T[n] || TRUNK.includes(n)) continue; const foot = n.match(/^(foot|toe)([LR])$/);
  BOX.T[n] = boxOf(FT, PT, n, foot ? ptsOf(legsT, domLegs, 'foot' + foot[2]).concat(ptsOf(legsT, domLegs, 'toe' + foot[2])) : ptsOf(bodyT, domT, n)); BOX.G[n] = boxOf(FG, PG, n, foot ? gFoot[foot[2]] : ptsOf(bodyG, domG, n)); }

// ---------------------------------------------------------------- the maps
const CLEAR = 0.004;
function mapBone(n, p, o) {
  if (TRUNK.includes(n) && n !== 'neck') { const u = axT.uOf(p[1]), c = axT.at(u), dx = p[0] - c[0], dz = p[2] - c[2], r = Math.hypot(dx, dz), th = Math.atan2(dz, dx), cg = axG.at(u);
    const sT = FIELD.T.trunk.smooth(u, th), sG = FIELD.G.trunk.smooth(u, th); let r2 = sG + (r - sT) * Math.min(1, sG / sT) + (o.margin || 0); r2 = Math.max(r2, FIELD.G.trunk.raw(u, th) + CLEAR); if (r < 0.02) r2 = r; return [cg[0] + Math.cos(th) * r2, cg[1], cg[2] + Math.sin(th) * r2]; }
  const q = toLocal(FT, PT, n, p);
  if (FIELD.T[n] && FIELD.G[n]) { const LT = lenOf(PT, ref.tips, n) * ALONG(n), LG = lenOf(PG, adopt.tips, n) * ALONG(n), t = q[0] / LT, r = Math.hypot(q[1], q[2]), th = Math.atan2(q[2], q[1]), own = o.ownSkin && /^(thigh|shin)/.test(n);
    const sT = FIELD.T[n].smooth(t, th), sG = FIELD.G[n].smooth(t, th); let r2 = sG + (r - sT) * Math.min(1, sG / sT) + (o.margin || 0) + (own ? 0.006 : 0); r2 = Math.max(r2, FIELD.G[n].raw(t, th) + CLEAR);   /* the offset off the skin shrinks WITH the limb */ return toWorld(FG, PG, n, [t * LG, Math.cos(th) * r2, Math.sin(th) * r2]); }
  const a = BOX.T[n], b = BOX.G[n];
  if (a && b) { const out = [0, 0, 0]; for (let k = 0; k < 3; k++) { const s = (b.hi[k] - b.lo[k]) / (a.hi[k] - a.lo[k] || 1e-9); out[k] = b.lo[k] + (q[k] - a.lo[k]) * s; } return toWorld(FG, PG, n, out); }
  const k = (lenOf(PG, adopt.tips, n) || 1) / (lenOf(PT, ref.tips, n) || 1); return toWorld(FG, PG, n, V.mul(q, k)); }
function carry(m, o = {}) { const nv = m.pos.length / 3, pos = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) { const p = [m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]], acc = [0, 0, 0]; let s = 0;
    for (let k = 0; k < 4; k++) { const w = m.w[v * 4 + k]; if (!(w > 0.001)) continue; const n = o.names ? o.names[m.ji[v * 4 + k]] : REF.names[m.joints[m.ji[v * 4 + k]]], q = mapBone(n, p, o); acc[0] += q[0] * w; acc[1] += q[1] * w; acc[2] += q[2] * w; s += w; }
    pos[v * 3] = acc[0] / s; pos[v * 3 + 1] = acc[1] / s; pos[v * 3 + 2] = acc[2] / s; }
  return pos; }
// normals from the carried surface, welded by where the vertices WERE (uv seams stay smooth)
function normals(pos, idx, weldPos) { const nv = pos.length / 3, key = new Map(), wid = new Int32Array(nv); for (let v = 0; v < nv; v++) { const k = Math.round(weldPos[v * 3] * 2e4) + ',' + Math.round(weldPos[v * 3 + 1] * 2e4) + ',' + Math.round(weldPos[v * 3 + 2] * 2e4); if (!key.has(k)) key.set(k, v); wid[v] = key.get(k); }
  const N = new Float32Array(nv * 3); for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2], e1 = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]], e2 = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]], n = V.cross(e1, e2); for (const v of [a, b, c]) { const w = wid[v]; N[w * 3] += n[0]; N[w * 3 + 1] += n[1]; N[w * 3 + 2] += n[2]; } }
  for (let v = 0; v < nv; v++) { const w = wid[v], n = V.norm([N[w * 3], N[w * 3 + 1], N[w * 3 + 2]]); N[v * 3] = n[0]; N[v * 3 + 1] = n[1]; N[v * 3 + 2] = n[2]; } return N; }
const rigidM = (m, M, R) => { const nv = m.pos.length / 3, pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3); for (let v = 0; v < nv; v++) { const p = new THREE.Vector3(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]).applyMatrix4(M), n = new THREE.Vector3(m.nrm[v * 3], m.nrm[v * 3 + 1], m.nrm[v * 3 + 2]).applyQuaternion(R); pos.set([p.x, p.y, p.z], v * 3); nrm.set([n.x, n.y, n.z], v * 3); } return { pos, nrm }; };
const jiOurs = m => { const out = new Uint16Array(m.ji.length); for (let i = 0; i < m.ji.length; i++) out[i] = bi(REF.names[m.joints[m.ji[i]]]); return out; };

// ---------------------------------------------------------------- the head: about the eyes, scaled with the skull
const EYE_T = [0, 1.972, 0.128], EYE_G = V.mean(adopt.eyes); EYE_G[0] = 0;
const skull = (m, dom, eyeY) => { let top = -9; for (let v = 0; v < dom.length; v++) if (dom[v] === 'head') top = Math.max(top, m.pos[v * 3 + 1]); const h = top - eyeY; let x = 0, z0 = 9, z1 = -9;   // how wide and how deep: in the band ABOVE the ears (an ear is 2–3 cm a side, and one sculpt has them flat where another has them out)
  for (let v = 0; v < dom.length; v++) { const y = m.pos[v * 3 + 1]; if (dom[v] !== 'head' || y < eyeY + 0.38 * h || y > eyeY + 0.7 * h) continue; x = Math.max(x, Math.abs(m.pos[v * 3])); z0 = Math.min(z0, m.pos[v * 3 + 2]); z1 = Math.max(z1, m.pos[v * 3 + 2]); } return { w: x * 2, h, d: z1 - z0, top, zc: (z0 + z1) / 2 }; };
const skT = skull(bodyT, domT, EYE_T[1]), skG = skull(bodyG, domG, EYE_G[1]), HS = [skG.w / skT.w, skG.h / skT.h, skG.d / skT.d], headMap = p => [(p[0] - EYE_T[0]) * HS[0], EYE_G[1] + (p[1] - EYE_T[1]) * HS[1], skG.zc + (p[2] - skT.zc) * HS[2]];   // (across: about the middle; up: about the eye line, so the crown lands on his crown; deep: about the skull's own middle, so brow and nape both land)
log('skull  base', [skT.w, skT.h, skT.d].map(x => (x * 100).toFixed(1)).join(' × '), '· his', [skG.w, skG.h, skG.d].map(x => (x * 100).toFixed(1)).join(' × '), 'cm (wide × above the eyes × deep) → ×', HS.map(x => x.toFixed(3)).join(', '));

// ---------------------------------------------------------------- dress him
const out = { meshes: [], materials: [], images: [] }, MAT = {}, SHARED = path.relative(OUT, BASE).split(path.sep).join('/') + '/', shared = f => SHARED + f;   // what the base already ships — the hair sheet, the kit's palette, the leather tile, the helm's maps — is REFERENCED from there, not copied: one download, one truth
const addImage = (uri) => { let i = out.images.indexOf(uri); if (i < 0) { out.images.push(uri); i = out.images.length - 1; } return i; };
const mat = (name, uri, o = {}) => { if (MAT[name] == null) { out.materials.push(Object.assign({ name, pbrMetallicRoughness: { baseColorTexture: { index: addImage(uri) }, metallicFactor: 0, roughnessFactor: 0.9 } }, o)); MAT[name] = out.materials.length - 1; } return MAT[name]; };
mat('base', 'atlas.jpg'); mat('own', 'atlas.jpg', { doubleSided: true });
for (const m of A.meshes) out.meshes.push({ name: m.name, pos: m.pos, nrm: m.nrm, uv: m.uv, ji: m.ji, w: m.w, idx: m.idx, material: m.name === 'base_body' ? MAT.base : MAT.own });
const wear = Object.assign({}, rig.wear), bW = baseRig.wear || {};
const halfV = uv => { const o = new Float32Array(uv.length); for (let i = 0; i < uv.length; i += 2) { o[i] = uv[i]; o[i + 1] = (uv[i + 1] - 0.5) * 2; } return o; };   // (the wares' paint is the lower half of the base's atlas: that half is all this rig carries)
for (const name of ['band_L', 'band_R', 'gauntlet_L', 'gauntlet_R', 'legs']) { const m = meshT(name); if (!m) continue; const own = name === 'legs', pos = carry(m, { ownSkin: own, margin: own ? 0 : 0 });
  out.meshes.push({ name, pos, nrm: normals(pos, m.idx, m.pos), uv: halfV(m.uv), ji: jiOurs(m), w: m.w, idx: m.idx, material: mat('wear', 'wear.jpg', { doubleSided: true }) });
  wear[name] = Object.assign({}, bW[name]); if (own) { delete wear[name].always; Object.assign(wear[name], { slot: 'legs', covers: ['hips', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR'], hides: Object.keys(rig.wear || {}) }); }   // on a man with legs of his own the trousers are a ware like any other: they take his own legwear off and hide the legs under them
  log(name.padEnd(11), m.idx.length / 3, 'tris carried'); }
// the bands are the base's bare wrists; this man has wrists of his own, so on him they are a pair of wares too
for (const S of SIDES) if (wear['band_' + S]) { delete wear['band_' + S].always; wear['band_' + S].slot = 'band' + S; if (wear['gauntlet_' + S]) wear['gauntlet_' + S].hides = ['band_' + S, 'pauldron_' + S]; }
let plateK = 1;
// shoulder plates: raw for the editor to finish on him, or the ones it finished
{ const bakedFile = path.join(ITEMS, 'pauldron_baked.' + prof.id + '.json'), raw = JSON.parse(fs.readFileSync(path.join(ITEMS, 'pauldron.json'), 'utf8')), baked = BAKED && fs.existsSync(bakedFile) ? JSON.parse(fs.readFileSync(bakedFile, 'utf8')) : null;
  for (const S of SIDES) { const name = 'pauldron_' + S;
    if (baked && baked[name]) { let b = baked[name];
      // ONE plate, worn on both shoulders: the editor seats each side on its own skin, and on a sculpt that is not vertex-for-vertex symmetric the two come out a little different (one hull had 18 corners, the other 28). The right one is the one that is kept, and the left is its mirror.
      if (S === 'L' && baked.pauldron_R) { const r = baked.pauldron_R, sw = i => { const n = BONES[i]; return /R$/.test(n) ? bi(n.slice(0, -1) + 'L') : /L$/.test(n) ? bi(n.slice(0, -1) + 'R') : i; }, idx = []; for (let t = 0; t < r.idx.length; t += 3) idx.push(r.idx[t], r.idx[t + 2], r.idx[t + 1]);
        b = { pos: r.pos.map((x, i) => i % 3 === 0 ? -x : x), nrm: r.nrm.map((x, i) => i % 3 === 0 ? -x : x), uv: r.uv, ji: r.ji.map(sw), w: r.w, idx }; }
      out.meshes.push({ name, pos: Float32Array.from(b.pos), nrm: Float32Array.from(b.nrm), uv: Float32Array.from(b.uv), ji: Uint16Array.from(b.ji), w: Float32Array.from(b.w), idx: Uint32Array.from(b.idx), material: mat('leather', shared('leather_tile.png'), { doubleSided: true }) }); }
    else { const r = raw[name], m = { pos: Float32Array.from(r.pos), nrm: Float32Array.from(r.nrm), w: Float32Array.from(r.w), ji: Uint16Array.from(r.ji), idx: Uint32Array.from(r.idx) }, nv = m.pos.length / 3, c = [0, 0, 0]; for (let v = 0; v < nv; v++) { c[0] += m.pos[v * 3] / nv; c[1] += m.pos[v * 3 + 1] / nv; c[2] += m.pos[v * 3 + 2] / nv; }
      // a plate is RIGID: it goes to the shoulder whole — its middle where the upper arm's map puts it, turned with the arm, sized with the deltoid under it — and the editor then seats every point of it on this skin.
      // (Carried point by point like cloth, its inner corner — hung partly on the spine — went with the trunk while the rest went with the arm, and the plate was pulled into shards.)
      const n = 'arm' + S, kD = (() => { let a = 0, b = 0; for (let j = 0; j < NS; j++) { const th = -Math.PI + (j + 0.5) / NS * 2 * Math.PI; a += FIELD.G[n].smooth(0.2, th); b += FIELD.T[n].smooth(0.2, th); } return a / b; })(), Rq = FG[n].clone().multiply(FT[n].clone().invert()), cg = mapBone(n, c, {});
      const M = new THREE.Matrix4().compose(new THREE.Vector3(...cg), Rq, new THREE.Vector3(kD, kD, kD)).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2])), rr = rigidM(m, M, Rq);
      out.meshes.push({ name, pos: rr.pos, nrm: rr.nrm, uv: Float32Array.from(r.uv), ji: m.ji, w: m.w, idx: m.idx, material: mat('wear', 'wear.jpg', { doubleSided: true }) }); plateK = kD; }
    wear[name] = Object.assign({}, bW[name]); log(name.padEnd(11), baked && baked[name] ? 'as the editor finished it' : 'RAW — open the editor, look, then await __exportArmor() and run this again with --baked'); } }
// the hair: about the eyes with the skull
{ const m = meshT('hair_long'); if (m) { const nv = m.pos.length / 3, pos = new Float32Array(nv * 3); for (let v = 0; v < nv; v++) pos.set(headMap([m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]]), v * 3);
    out.meshes.push({ name: 'hair_long', pos, nrm: m.nrm, uv: m.uv, ji: jiOurs(m), w: m.w, idx: m.idx, material: mat('hair', shared('hair.png'), { alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true }) }); } }
// THE FIST, read the same way off both rigs: the hand where its skin was bound, the fingers as the rest pose closes them (the
// file's nodes — grip.js wrote the base's there, and an adopted body rests in the same locals). Each finger makes a loop —
// knuckle, two joints, fingertip — whose middle is a point on the handle's line: little finger → index is the way the blade
// leaves the fist, the mean of the four is the fist's middle. In the HAND's own frame, so it holds in every pose.
function fist(R, W, tipsOf, S) { const ix = n => R.names.indexOf(n), M4 = THREE.Matrix4, bw = n => new M4().fromArray(W[ix(n)]), fk = new Map([['hand' + S, bw('hand' + S)]]);
  const world = n => { if (fk.has(n)) return fk.get(n); const p = R.names[R.parent[ix(n)]], t = new THREE.Vector3().setFromMatrixPosition(bw(p).invert().multiply(bw(n))), q = new THREE.Quaternion(), rl = new M4().fromArray(R.restLocal[ix(n)]); rl.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    const m = world(p).clone().multiply(new M4().compose(t, q, new THREE.Vector3(1, 1, 1))); fk.set(n, m); return m; };
  const centres = []; for (const phys of ['index', 'middle', 'ring', 'little']) { const b = fingerBones(phys, S), pts = [b.mcp, b.pip, b.dip].map(n => new THREE.Vector3().setFromMatrixPosition(world(n))); pts.push(new THREE.Vector3(...tipsOf[b.dip]).applyMatrix4(bw(b.dip).invert()).applyMatrix4(world(b.dip))); centres.push(pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(0.25)); }
  const inv = bw('hand' + S).invert(), mid = centres.reduce((a, p) => a.add(p.clone()), new THREE.Vector3()).multiplyScalar(0.25).applyMatrix4(inv), a = centres[0].clone().applyMatrix4(inv).sub(centres[3].clone().applyMatrix4(inv)); return { mid, axis: a.clone().normalize(), span: a.length() }; }
const grip = JSON.parse(JSON.stringify(baseRig.grip || {})), kMan = rig.height / baseRig.height, WT = G.bindWorlds(REF), WG = G.bindWorlds(A);
{ const sw = meshT(baseRig.meshes.sword), gs = grip.sword; if (sw && gs && gs.at) { const fT = fist(REF, WT, ref.tips, 'R'), fG = fist(A, WG, adopt.tips, 'R'), kF = fG.span / fT.span;
    // what grip.js (and the eye, after it) settled on the base, said relative to the base's own fist — and said again relative to this one
    const atT = new THREE.Vector3(...gs.at), axT = new THREE.Vector3(...gs.axis).normalize(), flT = new THREE.Vector3(...gs.flat).normalize(), lean = new THREE.Quaternion().setFromUnitVectors(fT.axis, axT);
    // THE BLADE LEAVES EVERY FIST THE SAME WAY. Where the hilt sits is his own (the middle of HIS finger loops); the way the blade points out of the hand —
    // axis and flat, in the hand's frame — is the base's, to the degree. A clip is baked so that the BLADE is where the performer's was (motion.js --blade),
    // and that is only true on another body if its blade lies in its hand's frame as the base's does. (Laid along his own loops' line it left 7.8° off the
    // base's: every cut would have landed 7.8° wide on him. The price is the hilt crossing his loops 6 mm off-centre at each end — nothing the eye finds.)
    const axG = axT.clone(), atG = fG.mid.clone().add(atT.clone().sub(fT.mid).multiplyScalar(kF)), flG = flT.clone(), reachG = gs.reach * kF, off = fG.axis.clone().applyQuaternion(lean).angleTo(axT) * 180 / Math.PI;
    const basis = (ax, fl) => new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(ax, fl).normalize(), ax, fl), hT = new THREE.Matrix4().fromArray(WT[REF.names.indexOf('handR')]), hG = new THREE.Matrix4().fromArray(WG[A.names.indexOf('handR')]);
    // the blade: rigid, the guard's place on the handle line → the same place on his, scaled with the MAN (a plain sword is 53 % of a man's height — swordsize.js), not with his fingers
    const gT = hT.clone().multiply(new THREE.Matrix4().makeTranslation(...atT.clone().addScaledVector(axT, gs.reach).toArray())).multiply(basis(axT, flT)), gG = hG.clone().multiply(new THREE.Matrix4().makeTranslation(...atG.clone().addScaledVector(axG, reachG).toArray())).multiply(basis(axG, flG));
    const M = gG.clone().multiply(new THREE.Matrix4().makeScale(kMan, kMan, kMan)).multiply(gT.clone().invert()), Rq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(gG).multiply(new THREE.Matrix4().extractRotation(gT).invert())), r = rigidM(sw, M, Rq);
    out.meshes.push({ name: sw.name, pos: r.pos, nrm: r.nrm, uv: sw.uv, ji: jiOurs(sw), w: sw.w, idx: sw.idx, material: mat('kit', shared('6_characters_baseColor.jpg')) });
    // the seat, for THIS hand: the game undoes `seat` to hang the same blade at the hip (modelPropGeo: seat⁻¹, then the hand joint to the origin) — so seat⁻¹
    // takes this rig's sword to where the base's UNSEATED sword stands about its hand joint, scaled with the man, about this hand joint.
    const seatT = new THREE.Matrix4().fromArray(gs.seat), un = new THREE.Matrix4().makeTranslation(...PG.handR).multiply(new THREE.Matrix4().makeScale(kMan, kMan, kMan)).multiply(new THREE.Matrix4().makeTranslation(-PT.handR[0], -PT.handR[1], -PT.handR[2])).multiply(seatT.clone().invert()).multiply(M.clone().invert());
    Object.assign(gs, { seat: un.clone().invert().elements.map(x => +x.toFixed(6)), at: atG.toArray().map(x => +x.toFixed(5)), axis: axG.toArray().map(x => +x.toFixed(5)), flat: flG.toArray().map(x => +x.toFixed(5)), reach: +reachG.toFixed(5) }); if (gs.size) gs.size = +(gs.size * kMan * (baseRig.hipY / rig.hipY)).toFixed(3); if (gs.own) delete gs.own;
    gs.note = 'wardrobe.js: the base\'s grip said again about THIS fist (its loops ×' + kF.toFixed(3) + ' the base\'s), the blade ×' + kMan.toFixed(3) + ' with the man. ' + (gs.note || '');
    log('sword       in his fist (fist ×' + kF.toFixed(3) + ', blade ×' + kMan.toFixed(3) + '; the blade leaves it as the base\'s does — his own loops\' line lies ' + off.toFixed(1) + '° off that)'); }
  const sh = meshT(baseRig.meshes.shield); if (sh) { const c = [0, 0, 0], nv = sh.pos.length / 3; for (let v = 0; v < nv; v++) { c[0] += sh.pos[v * 3] / nv; c[1] += sh.pos[v * 3 + 1] / nv; c[2] += sh.pos[v * 3 + 2] / nv; }
    // the shield's middle keeps its place along the forearm and its distance off the SKIN; the board keeps its shape, scaled with the man
    const Rq = FG.foreL.clone().multiply(FT.foreL.clone().invert()), cg = mapBone('foreL', c, {}), M = new THREE.Matrix4().compose(new THREE.Vector3(...cg), Rq, new THREE.Vector3(kMan, kMan, kMan)).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2])), r = rigidM(sh, M, Rq);
    out.meshes.push({ name: sh.name, pos: r.pos, nrm: r.nrm, uv: sh.uv, ji: jiOurs(sh), w: sh.w, idx: sh.idx, material: mat('kit', shared('6_characters_baseColor.jpg')) }); log('shield      about its place on the forearm, ×' + kMan.toFixed(3)); } }
const kHand = kMan;

// ---------------------------------------------------------------- write
const dq = m => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); new THREE.Matrix4().fromArray(m).decompose(p, q, s); return { p, q }; };
const W = G.bindWorlds(A), local = BONES.map((n, i) => A.restLocal[A.names.indexOf(n)]), world = BONES.map(n => W[A.names.indexOf(n)]);
out.skeleton = { names: BONES, parent: PARENT, world, local }; fs.mkdirSync(OUT, { recursive: true }); G.write(OUT, out);
for (const f of ['atlas.jpg', 'pieces.json', 'parts.json', 'adopt.json']) fs.copyFileSync(path.join(BODY, f), path.join(OUT, f));
// the wares' paint: the lower half of the base's atlas (python + PIL, as the rest of the pipeline)
if (out.images.includes('wear.jpg')) require('child_process').execFileSync('python3', ['-c', 'import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1]); w, h = im.size; im.crop((0, h // 2, w, h)).save(sys.argv[2], quality=90)', path.join(BASE, 'atlas.jpg'), path.join(OUT, 'wear.jpg')]);
{ const rawA = path.join(ITEMS, 'atlas_raw.jpg'), rawW = path.join(ITEMS, 'wear_raw.jpg'); if (fs.existsSync(rawA) && !fs.existsSync(rawW)) require('child_process').execFileSync('python3', ['-c', 'import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1]); w, h = im.size; im.crop((0, h // 2, w, h)).save(sys.argv[2], quality=90)', rawA, rawW]); }   // (the char editor shows paint AS PAINTED: the shipped atlas has its wear lifted for the game's light — headbake.py WEAR_LIFT)
// the helm: the base's fitted Corinthian, about the eyes with the skull
{ const hj = JSON.parse(fs.readFileSync(path.join(BASE, 'helm_corinthian.json'), 'utf8')), hb = fs.readFileSync(path.join(BASE, 'helm_corinthian.bin')), nv = hj.verts, f = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.byteLength), 0, nv * 6), lo = [9, 9, 9], hi = [-9, -9, -9];
  for (let v = 0; v < nv; v++) { const p = headMap([f[v * 3], f[v * 3 + 1], f[v * 3 + 2]]); f.set(p, v * 3); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const n = V.norm([f[nv * 3 + v * 3] / HS[0], f[nv * 3 + v * 3 + 1] / HS[1], f[nv * 3 + v * 3 + 2] / HS[2]]); f.set(n, nv * 3 + v * 3); }
  const bin = Buffer.from(hb); Buffer.from(f.buffer).copy(bin, 0, 0, nv * 24); fs.writeFileSync(path.join(OUT, 'helm_corinthian.bin'), bin); hj.bounds = { min: lo, max: hi }; hj.fitted = 'wardrobe.js: the base\'s fit carried about the eyes, ×' + HS.map(x => x.toFixed(3)).join(', ');
  for (const k in hj.textures || {}) hj.textures[k] = shared(hj.textures[k]); fs.writeFileSync(path.join(OUT, 'helm_corinthian.json'), JSON.stringify(hj, null, 1)); log('helm        about the eyes'); }
// rig.json: the measures the look system reads, carried the same way
const hm = (y, z) => headMap([0, y, z]), bs = baseRig.skull, bf = baseRig.face;
Object.assign(rig, { wear, grip, meshes: Object.assign({}, baseRig.meshes), skull: { yc: +hm(bs.yc, 0)[1].toFixed(4), zc: +hm(0, bs.zc)[2].toFixed(4), top: +hm(bs.top, 0)[1].toFixed(4), chin: +hm(bs.chin, 0)[1].toFixed(4), coverY: +hm(bs.coverY, 0)[1].toFixed(4) },
  face: { earY: +hm(bf.earY, 0)[1].toFixed(4), earZ: +hm(0, bf.earZ)[2].toFixed(4), chinX: +(bf.chinX * HS[0]).toFixed(4), lipY: +hm(bf.lipY, 0)[1].toFixed(4), lipZ: +hm(0, bf.lipZ)[2].toFixed(4) },
  hairline: Object.fromEntries(Object.entries(baseRig.hairline).map(([k, rows]) => [k, rows.map(([a, y]) => [a, +hm(y, 0)[1].toFixed(4)])])), plumeY: +(baseRig.plumeY * HS[1]).toFixed(3), roundX: +(baseRig.roundX * (PG.handL[0] / PT.handL[0])).toFixed(3),
  helmHand: Object.fromEntries(Object.entries(baseRig.helmHand).map(([k, v]) => [k, /^r/.test(k) ? v : +(v * kHand).toFixed(4)])) });
fs.writeFileSync(path.join(OUT, 'rig.json'), JSON.stringify(rig, null, 1));
log('→', path.relative(ROOT, OUT), '·', out.meshes.map(m => m.name.replace(/^FantasyWarrior_|_6_characters_0$/g, '') + ' ' + m.idx.length / 3).join(', '));
