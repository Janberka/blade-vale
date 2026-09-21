// tools/realmesh/adopt — shared pieces: vectors on plain arrays, a welded vertex graph, geodesics over it, a ray caster.
const path = require('path');
const THREE = require('../../../vendor/three.min.js');
const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]), dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  perp: (c, d) => { const k = V.dot(c, d); return V.norm([c[0] - d[0] * k, c[1] - d[1] * k, c[2] - d[2] * k]); },   // c made square to the unit vector d
  mean: L => { const c = [0, 0, 0]; for (const p of L) { c[0] += p[0] / L.length; c[1] += p[1] / L.length; c[2] += p[2] / L.length; } return c; },
  angle: (a, b) => Math.acos(Math.max(-1, Math.min(1, V.dot(V.norm(a), V.norm(b))))) * 180 / Math.PI
};
const smooth = (x, a, b) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-9))); return u * u * (3 - 2 * u); };

// a rotation (THREE.Quaternion) from an orthonormal frame given as its first axis d and a hint c for the second
function frameQ(d, cHint) { d = V.norm(d); const c = V.perp(cHint, d), e = V.cross(d, c); return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...d), new THREE.Vector3(...c), new THREE.Vector3(...e))); }
const mirrorQ = q => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);          // the same turn seen in the x = 0 mirror (Mx · R · Mx)
const mirrorP = p => [-p[0], p[1], p[2]];

// position-welded ids + the edge graph over them (the seams of a uv-split mesh must not cut the surface)
function weldGraph(pos, idx, eps = 1e-4) {
  const nv = pos.length / 3, key = new Map(), wid = new Int32Array(nv);
  for (let v = 0; v < nv; v++) { const k = Math.round(pos[v * 3] / eps) + ',' + Math.round(pos[v * 3 + 1] / eps) + ',' + Math.round(pos[v * 3 + 2] / eps); if (!key.has(k)) key.set(k, v); wid[v] = key.get(k); }
  const adj = new Map(), link = (a, b) => { if (a === b) return; (adj.get(a) || adj.set(a, new Set()).get(a)).add(b); (adj.get(b) || adj.set(b, new Set()).get(b)).add(a); };
  for (let t = 0; t < idx.length; t += 3) { const a = wid[idx[t]], b = wid[idx[t + 1]], c = wid[idx[t + 2]]; link(a, b); link(b, c); link(c, a); }
  const P = v => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  return { wid, adj, P, nv };
}
// Dijkstra over the welded graph, inside `allow` (a Set of welded ids); returns Map id -> distance and the parents (for paths)
function geodesic(Gr, sources, allow) {
  const dist = new Map(), par = new Map(), heap = [];
  const push = (d, v) => { heap.push([d, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (const s of sources) { dist.set(s, 0); push(0, s); }
  while (heap.length) { const [d, v] = pop(); if (d > dist.get(v)) continue; const pv = Gr.P(v);
    for (const u of Gr.adj.get(v) || []) { if (allow && !allow.has(u)) continue; const nd = d + V.dist(pv, Gr.P(u)); if (nd < (dist.has(u) ? dist.get(u) : Infinity)) { dist.set(u, nd); par.set(u, v); push(nd, u); } } }
  return { dist, par };
}
const pathTo = (par, v) => { const out = [v]; while (par.has(v)) { v = par.get(v); out.push(v); } return out; };

// a polyline with arc length: point at s, and the projection of a point onto it (clamped to [0, L] unless `open`, where both ends run on straight)
function polyline(pts) {
  const S = [0]; for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + V.dist(pts[i - 1], pts[i])); const L = S[S.length - 1];
  const at = s => { if (s <= 0) return V.add(pts[0], V.mul(V.norm(V.sub(pts[0], pts[1])), -s)); if (s >= L) { const n = pts.length - 1; return V.add(pts[n], V.mul(V.norm(V.sub(pts[n], pts[n - 1])), s - L)); }
    let i = 1; while (S[i] < s) i++; return V.lerp(pts[i - 1], pts[i], (s - S[i - 1]) / (S[i] - S[i - 1] || 1e-9)); };
  const project = p => { let best = { d: Infinity, s: 0 }; const n = pts.length - 1;
    for (let i = 1; i <= n; i++) { const a = pts[i - 1], ab = V.sub(pts[i], a), l2 = V.dot(ab, ab) || 1e-12; let t = V.dot(V.sub(p, a), ab) / l2; if (i > 1 || t > 0) t = Math.max(0, t); if (i < n || t < 1) t = Math.min(1, t);   // the end segments run on past their ends
      const q = V.add(a, V.mul(ab, t)), d = V.dist(p, q); if (d < best.d) best = { d, s: S[i - 1] + t * Math.sqrt(l2) }; } return best; };
  return { pts, S, L, at, project };
}

// every triangle of a mesh as 9 floats, and a caster: all crossings of a ray, sorted by distance
function triSoup(pos, idx) { const T = new Float32Array(idx.length * 3); for (let i = 0; i < idx.length; i++) { const v = idx[i]; T[i * 3] = pos[v * 3]; T[i * 3 + 1] = pos[v * 3 + 1]; T[i * 3 + 2] = pos[v * 3 + 2]; } return T; }
function cast(T, o, d, far = 1e9) { const hits = [], [ox, oy, oz] = o, [dx, dy, dz] = d;
  for (let i = 0; i < T.length; i += 9) { const ax = T[i], ay = T[i + 1], az = T[i + 2], e1x = T[i + 3] - ax, e1y = T[i + 4] - ay, e1z = T[i + 5] - az, e2x = T[i + 6] - ax, e2y = T[i + 7] - ay, e2z = T[i + 8] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det, tx = ox - ax, ty = oy - ay, tz = oz - az, u = (tx * px + ty * py + tz * pz) * inv; if (u < -1e-6 || u > 1 + 1e-6) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv; if (t > 1e-7 && t < far) hits.push(t); }
  return hits.sort((a, b) => a - b); }

// ---- the base's finger chains are MIS-NAMED (tools/chared/README.md): from the thumb across the palm they are called pinky, ring,
// index, middle. The names stay — the clips use them. Everything here speaks of the PHYSICAL finger and looks the bone up.
const SIDES = ['L', 'R'], FINGERS = { index: 'pinky', middle: 'ring', ring: 'index', little: 'middle' };
const fingerBones = (phys, S) => { const c = FINGERS[phys]; return phys === 'index' ? { mcp: c + S + '0', pip: c + S + '1', dip: c + S + '2' } : { base: c + S + '0', mcp: c + S + '1', pip: c + S + '2', dip: c + S + '3' }; };
// THE STANDARD: the base rig (assets/rigs/base) — bone names, hierarchy, bind frames, rest locals, and its fingertips (the farthest skin vertex of each last finger bone)
function refRig() { const G = require('../base/gltfio'), REF = G.read(path.join(__dirname, '../../../assets/rigs/base')), nJ = REF.meshes[0].ibm.length / 16, BONES = REF.names.slice(0, nJ), PARENT = BONES.map((_, i) => REF.parent[i] < nJ ? REF.parent[i] : -1);
  const W = G.bindWorlds(REF), dq = m => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); new THREE.Matrix4().fromArray(m).decompose(p, q, s); return { p: [p.x, p.y, p.z], q }; };
  const ref = { REF, BONES, PARENT, P: {}, Q: {}, restQ: {}, tips: {} }; BONES.forEach((n, i) => { const w = dq(W[i]); ref.P[n] = w.p; ref.Q[n] = w.q; ref.restQ[n] = dq(REF.restLocal[i]).q; });
  const body = ref.body = REF.meshes.find(m => m.name === 'base_body'), last = {}, far = {}; for (const S of SIDES) { for (const phys in FINGERS) last[fingerBones(phys, S).dip] = 1; last['thumb' + S + '2'] = 1; }
  for (let v = 0; v < body.pos.length / 3; v++) { let b = 0; for (let k = 1; k < 4; k++) if (body.w[v * 4 + k] > body.w[v * 4 + b]) b = k; const n = BONES[body.joints[body.ji[v * 4 + b]]]; if (!last[n]) continue;
    const p = [body.pos[v * 3], body.pos[v * 3 + 1], body.pos[v * 3 + 2]], d = V.dist(p, ref.P[n]); if (!far[n] || d > far[n].d) far[n] = { d, p }; }
  for (const k in far) ref.tips[k] = far[k].p; return ref; }
// THE ANATOMICAL FRAMES of a rig's limbs, taken the same way off any rig: R = joint positions by OUR bone names, tipsOf = fingertips
// by last-finger-bone name. (The LEFT side is taken in the mirror, as a right side, and mirrored back: one set of sign conventions.)
function frames(R, tipsOf) { const F = {};
  for (const S of SIDES) { const mir = S === 'L', pb = n => { if (!R[n]) throw new Error('frames: no joint ' + n); return mir ? mirrorP(R[n]) : R[n]; }, p = n => pb(n + S), set = (n, q) => { F[n] = mir ? mirrorQ(q) : q; }, tip = n => mir ? mirrorP(tipsOf[n]) : tipsOf[n];
    const bone = (stem, k) => stem + S + k;
    // the arm: its own bend says where the elbow's hinge lies (a straight arm: across the body)
    const up = V.sub(p('fore'), p('arm')), lo = V.sub(p('hand'), p('fore')); let hinge = V.cross(up, lo); if (V.angle(up, lo) < 6) hinge = [-1, 0, 0]; hinge = V.norm(hinge);
    set('arm' + S, frameQ(up, hinge)); set('fore' + S, frameQ(lo, hinge));
    // the hand: wrist → the middle finger's knuckle, and the palm's normal off the knuckle line (index → little)
    const kMid = pb(bone(FINGERS.middle, 1)), kIdx = pb(bone(FINGERS.index, 0)), kLit = pb(bone(FINGERS.little, 1)), hd = V.sub(kMid, p('hand')), kn = V.sub(kLit, kIdx), palm = V.norm(V.cross(hd, kn)); const hq = frameQ(hd, palm); set('hand' + S, hq);
    for (const phys in FINGERS) { const b = fingerBones(phys, S), chain = [b.mcp, b.pip, b.dip].map(pb).concat([tip(b.dip)]);
      let curl = V.cross(V.sub(chain[1], chain[0]), V.sub(chain[3], chain[1])); if (V.angle(V.sub(chain[1], chain[0]), V.sub(chain[3], chain[1])) < 10) curl = V.cross(V.sub(chain[1], chain[0]), palm); curl = V.norm(curl);
      [b.mcp, b.pip, b.dip].forEach((n, i) => set(n, frameQ(V.sub(chain[i + 1], chain[i]), curl))); if (b.base) set(b.base, hq); }   // (a metacarpal is part of the palm: it rides the hand)
    { const n = ['thumb' + S + '0', 'thumb' + S + '1', 'thumb' + S + '2'], chain = n.map(pb).concat([tip(n[2])]); let curl = V.cross(V.sub(chain[1], chain[0]), V.sub(chain[3], chain[1])); if (V.angle(V.sub(chain[1], chain[0]), V.sub(chain[3], chain[1])) < 8) curl = V.cross(V.sub(chain[1], chain[0]), palm); curl = V.norm(curl);
      n.forEach((nm, i) => set(nm, frameQ(V.sub(chain[i + 1], chain[i]), curl))); }
    // the leg: the knee's hinge from where the foot points (a standing leg is too straight to say); the foot about the vertical only
    const fwd = V.norm([p('toe')[0] - p('foot')[0], 0, p('toe')[2] - p('foot')[2]]), th = V.sub(p('shin'), p('thigh')), sh = V.sub(p('foot'), p('shin')), knee = V.cross(fwd, V.norm(th));
    set('thigh' + S, frameQ(th, knee)); set('shin' + S, frameQ(sh, knee)); const fq = frameQ(fwd, [0, 1, 0]); set('foot' + S, fq); set('toe' + S, fq); }
  return F; }
module.exports = { SIDES, FINGERS, fingerBones, refRig, frames, THREE, V, smooth, frameQ, mirrorQ, mirrorP, weldGraph, geodesic, pathTo, polyline, triSoup, cast, ROOT: path.join(__dirname, '../../..') };
