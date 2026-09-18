// mesh utilities for the base-body build: plain-array meshes { pos, uv, nrm, ji, w, idx, part } (ji/w = 4 per vertex, bone indices into the NEW skeleton)
const V3 = { sub: (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]], add: (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]], scale: (a, s) => [a[0]*s, a[1]*s, a[2]*s], dot: (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2], cross: (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]], len: a => Math.hypot(a[0], a[1], a[2]), norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }, lerp: (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t] };
function empty() { return { pos: [], uv: [], ji: [], w: [], idx: [], part: [] }; }
function nverts(m) { return m.pos.length / 3; }
function vpos(m, v) { return [m.pos[v*3], m.pos[v*3+1], m.pos[v*3+2]]; }
function addVert(m, p, uv, ji, w, part) { m.pos.push(p[0], p[1], p[2]); m.uv.push(uv[0], uv[1]); m.ji.push(ji[0], ji[1], ji[2], ji[3]); m.w.push(w[0], w[1], w[2], w[3]); m.part.push(part); return nverts(m) - 1; }
function weightsOf(m, v) { const o = []; for (let c = 0; c < 4; c++) if (m.w[v*4+c] > 0) o.push([m.ji[v*4+c], m.w[v*4+c]]); return o; }
// blend two sparse weight lists -> [ji4, w4]
function blendW(a, ta, b, tb) { const acc = new Map(); for (const [j, w] of a) acc.set(j, (acc.get(j) || 0) + w * ta); for (const [j, w] of b) acc.set(j, (acc.get(j) || 0) + w * tb); return packW([...acc.entries()]); }
function packW(list) { list = list.filter(([j, w]) => w > 1e-4).sort((x, y) => y[1] - x[1]).slice(0, 4); let s = 0; for (const [, w] of list) s += w; const ji = [0, 0, 0, 0], w4 = [0, 0, 0, 0]; list.forEach(([j, w], k) => { ji[k] = j; w4[k] = w / (s || 1); }); if (!list.length) w4[0] = 1; return [ji, w4]; }
// append mesh b into a (returns the vertex offset)
function append(a, b) { const off = nverts(a); for (const k of ['pos', 'uv', 'ji', 'w', 'part']) for (const x of b[k]) a[k].push(x); for (const i of b.idx) a.idx.push(i + off); return off; }
// position-welded ids and open boundary loops (ordered rings of ORIGINAL vertex ids, one representative per position)
function weldIds(m, eps = 1e-4) { const nv = nverts(m), key = new Map(), vid = new Int32Array(nv); for (let v = 0; v < nv; v++) { const k = Math.round(m.pos[v*3] / eps) + ',' + Math.round(m.pos[v*3+1] / eps) + ',' + Math.round(m.pos[v*3+2] / eps); if (!key.has(k)) key.set(k, v); vid[v] = key.get(k); } return vid; }
function openLoops(m) { const vid = weldIds(m), edges = new Map(), ek = (a, b) => a < b ? a + '_' + b : b + '_' + a;
  for (let t = 0; t < m.idx.length; t += 3) { const a = vid[m.idx[t]], b = vid[m.idx[t+1]], c = vid[m.idx[t+2]]; for (const [p, q] of [[a, b], [b, c], [c, a]]) { if (p === q) continue; const k = ek(p, q); edges.set(k, (edges.get(k) || 0) + 1); } }
  const adj = new Map(); for (const [k, n] of edges) { if (n !== 1) continue; const [a, b] = k.split('_').map(Number); (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); }
  return chainLoops(adj).map(L => ({ ids: L, centre: L.reduce((c, v) => V3.add(c, V3.scale(vpos(m, v), 1 / L.length)), [0, 0, 0]) })); }
function chainLoops(adj) { const seen = new Set(), loops = [];
  for (const [a] of adj) { if (seen.has(a)) continue; const walk = (start, prev0) => { const out = []; let prev = prev0, cur = start; while (cur != null && !seen.has(cur)) { out.push(cur); seen.add(cur); const nx = (adj.get(cur) || []).find(n => n !== prev && !seen.has(n)); prev = cur; cur = nx; } return out; };
    const fwd = walk(a, -1); const nb = (adj.get(a) || []).find(n => !seen.has(n)); const back = nb != null ? walk(nb, a) : []; loops.push(back.reverse().concat(fwd)); }
  return loops; }
// resample a closed loop by angle around an axis: N points at angles 2πk/N (positions interpolated along the polyline), with the loop's own weights/uv of the nearest vertex
function loopByAngle(m, loop, axisDir, N, up, exact) { const c = loop.centre, d = V3.norm(axisDir); let u = V3.norm(V3.cross(up || (Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1]), d)); const v = V3.norm(V3.cross(d, u));   // u × v frame in the loop plane, v = d × u (outward winding: see north-kit notes)
  const pts = loop.ids.map(id => { const p = V3.sub(vpos(m, id), c); const x = V3.dot(p, u), y = V3.dot(p, v); return { id, ang: Math.atan2(y, x), r: Math.hypot(x, y), t: V3.dot(p, d), p: vpos(m, id) }; });
  pts.sort((a, b) => a.ang - b.ang);
  if (exact) return { pts: pts.map(q => ({ p: q.p, r: q.r, t: q.t, ang: q.ang, id: q.id })), c, u, v, d };   // (the loop's own vertices, in angle order: a ring on them closes the seam exactly, however oblique the cut)
  const out = []; for (let k = 0; k < N; k++) { const a = -Math.PI + (k + 0.5) / N * 2 * Math.PI; let i1 = pts.findIndex(q => q.ang >= a); if (i1 < 0) i1 = 0; const i0 = (i1 - 1 + pts.length) % pts.length; const q0 = pts[i0], q1 = pts[i1]; let a0 = q0.ang, a1 = q1.ang; if (a1 < a0) { if (a < a0) a0 -= 2 * Math.PI; else a1 += 2 * Math.PI; } const f = a1 === a0 ? 0 : (a - a0) / (a1 - a0);
    out.push({ p: V3.lerp(q0.p, q1.p, f), r: q0.r + (q1.r - q0.r) * f, t: q0.t + (q1.t - q0.t) * f, ang: a, id: f < 0.5 ? q0.id : q1.id }); }
  return { pts: out, c, u, v, d }; }
// a tube from ring shape A (at loop A) to ring shape B, K rings between; returns the ids of every ring (ring 0 = new copies of A's samples with the patch uv)
function tube(m, A, B, K, o) { const rings = []; const N = A.pts.length; const wa = A.pts.map(q => weightsOf(m, q.id)), wb = B.pts.map(q => weightsOf(m, q.id));
  for (let k = 0; k <= K; k++) { const t = k / K, ring = []; const bulge = o.bulge ? o.bulge(t) : 1; for (let j = 0; j < N; j++) { const pa = A.pts[j].p, pb = B.pts[j].p; let p = V3.lerp(pa, pb, t); const ca = V3.lerp(A.c, B.c, t); const rad = V3.sub(p, ca); p = V3.add(ca, V3.scale(rad, bulge)); const [ji, w] = o.weights ? o.weights(t, j, wa[j], wb[j]) : blendW(wa[j], 1 - t, wb[j], t); ring.push(addVert(m, p, o.uv(j / N, t), ji, w, o.part)); } rings.push(ring); }
  for (let k = 0; k < K; k++) stitch(m, rings[k], rings[k + 1], o.flip); return rings; }
function stitch(m, a, b, flip) { const N = a.length; for (let i = 0; i < N; i++) { const j = (i + 1) % N; if (flip) m.idx.push(a[i], b[j], b[i], a[i], a[j], b[j]); else m.idx.push(a[i], b[i], b[j], a[i], b[j], a[j]); } }
function cap(m, ring, centre, uv, ji, w, part, flip) { const ci = addVert(m, centre, uv, ji, w, part); const N = ring.length; for (let i = 0; i < N; i++) { const j = (i + 1) % N; if (flip) m.idx.push(ci, ring[j], ring[i]); else m.idx.push(ci, ring[i], ring[j]); } return ci; }
// an analytic ring: centre c, frame (u, v), radius function r(θ) (or [rx, rz] ellipse)
function ringAt(m, c, u, v, rf, N, uvf, ji, w, part, t) { const ring = []; for (let j = 0; j < N; j++) { const a = -Math.PI + (j + 0.5) / N * 2 * Math.PI; const r = typeof rf === 'function' ? rf(a) : rf; const p = V3.add(c, V3.add(V3.scale(u, r * Math.cos(a)), V3.scale(v, r * Math.sin(a)))); ring.push(addVert(m, p, uvf(j / N, t), ji, w, part)); } return ring; }
// clip: keep the part where side*(x - X0) < 0; new boundary vertices interpolated; returns { mesh, loops } where loops are ordered lists of NEW vertex ids on the plane
function clipX(m, X0, keepBelow) { return clipPlane(m, [X0, 0, 0], keepBelow ? [1, 0, 0] : [-1, 0, 0]); }
// keep the side where dot(p - P0, N) < 0; new boundary vertices interpolated; returns { mesh, loops } (ordered NEW vertex ids on the plane)
function clipPlane(m, P0, N) { const out = empty(); const nv = nverts(m); const map = new Int32Array(nv).fill(-1); const d = v => (m.pos[v*3] - P0[0]) * N[0] + (m.pos[v*3+1] - P0[1]) * N[1] + (m.pos[v*3+2] - P0[2]) * N[2];
  const copy = v => { if (map[v] < 0) map[v] = addVert(out, vpos(m, v), [m.uv[v*2], m.uv[v*2+1]], m.ji.slice(v*4, v*4+4), m.w.slice(v*4, v*4+4), m.part[v]); return map[v]; };
  const cutCache = new Map(); const cut = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (cutCache.has(k)) return cutCache.get(k); const da = d(a), db = d(b), f = da / (da - db); const p = V3.lerp(vpos(m, a), vpos(m, b), f), uv = [m.uv[a*2] + (m.uv[b*2] - m.uv[a*2]) * f, m.uv[a*2+1] + (m.uv[b*2+1] - m.uv[a*2+1]) * f]; const [ji, w] = blendW(weightsOf(m, a), 1 - f, weightsOf(m, b), f); const id = addVert(out, p, uv, ji, w, m.part[a]); cutCache.set(k, id); return id; };
  const bEdges = [];
  for (let t = 0; t < m.idx.length; t += 3) { const tri = [m.idx[t], m.idx[t+1], m.idx[t+2]], ds = tri.map(d); const inside = ds.map(x => x < 0); const n = inside.filter(Boolean).length;
    if (n === 0) continue; if (n === 3) { out.idx.push(copy(tri[0]), copy(tri[1]), copy(tri[2])); continue; }
    // rotate so the odd vertex is first
    let r = 0; if (n === 1) r = inside.indexOf(true); else r = inside.indexOf(false); const T = [tri[r], tri[(r+1)%3], tri[(r+2)%3]];
    if (n === 1) { const a = copy(T[0]), p = cut(T[0], T[1]), q = cut(T[0], T[2]); out.idx.push(a, p, q); bEdges.push([p, q]); }
    else { const b = copy(T[1]), c = copy(T[2]), p = cut(T[0], T[1]), q = cut(T[0], T[2]); out.idx.push(p, b, c, p, c, q); bEdges.push([q, p]); } }
  // chain boundary edges into loops
  const adj = new Map(); for (const [a, b] of bEdges) { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); }
  const loops = chainLoops(adj).map(loop => ({ ids: loop, centre: loop.reduce((c, v) => V3.add(c, V3.scale(vpos(out, v), 1 / loop.length)), [0, 0, 0]) }));
  return { mesh: out, loops }; }
function mirrorX(m, boneMirror) { const out = empty(); const nv = nverts(m); for (let v = 0; v < nv; v++) { const ji = m.ji.slice(v*4, v*4+4).map(boneMirror); addVert(out, [-m.pos[v*3], m.pos[v*3+1], m.pos[v*3+2]], [m.uv[v*2], m.uv[v*2+1]], ji, m.w.slice(v*4, v*4+4), (m.part[v] || '').replace(/L$/, '§').replace(/R$/, 'L').replace(/§$/, 'R')); } for (let t = 0; t < m.idx.length; t += 3) out.idx.push(m.idx[t], m.idx[t+2], m.idx[t+1]); return out; }
// zip two coplanar loops (x = X0) with N interpolated samples each — the seam strip between the left torso and the mirrored arm
function zipper(m, A, B, N, flipWinding) { const c = V3.scale(V3.add(A.centre, B.centre), 0.5); const d = [1, 0, 0]; const sa = loopByAngle(m, A, d, N), sb = loopByAngle(m, B, d, N);
  const mk = (s, part) => s.pts.map(q => { const [ji, w] = packW(weightsOf(m, q.id)); return addVert(m, q.p, [m.uv[q.id*2], m.uv[q.id*2+1]], ji, w, m.part[q.id]); }); const ra = mk(sa), rb = mk(sb); stitch(m, ra, rb, flipWinding); }

// consistent winding: propagate orientation across shared edges from each component's seed, then turn any component inside out whose signed volume is negative
function fixOrientation(m) { const vid = weldIds(m), nt = m.idx.length / 3, ek = (a, b) => a < b ? a + '_' + b : b + '_' + a, edgeTris = new Map();
  const tv = t => [vid[m.idx[t*3]], vid[m.idx[t*3+1]], vid[m.idx[t*3+2]]];
  for (let t = 0; t < nt; t++) { const [a, b, c] = tv(t); for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = ek(p, q); (edgeTris.get(k) || edgeTris.set(k, []).get(k)).push(t); } }
  const has = (t, a, b) => { const v = tv(t); for (let i = 0; i < 3; i++) if (v[i] === a && v[(i+1)%3] === b) return true; return false; };
  const flip = t => { const x = m.idx[t*3+1]; m.idx[t*3+1] = m.idx[t*3+2]; m.idx[t*3+2] = x; };
  const seen = new Uint8Array(nt); let flipped = 0, comps = 0;
  for (let s = 0; s < nt; s++) { if (seen[s]) continue; comps++; const comp = [s]; seen[s] = 1; const st = [s];
    while (st.length) { const t = st.pop(); const v = tv(t); for (let i = 0; i < 3; i++) { const a = v[i], b = v[(i+1)%3]; for (const n of edgeTris.get(ek(a, b)) || []) { if (seen[n]) continue; seen[n] = 1; if (has(n, a, b)) { flip(n); flipped++; } comp.push(n); st.push(n); } } }
    let vol = 0; const c0 = [0, 0, 0]; for (const t of comp) for (let k = 0; k < 3; k++) { const p = vpos(m, m.idx[t*3+k]); c0[0] += p[0] / (comp.length * 3); c0[1] += p[1] / (comp.length * 3); c0[2] += p[2] / (comp.length * 3); }   // (about the piece's own centroid: about the origin an open piece could read either way)
    for (const t of comp) { const a = V3.sub(vpos(m, m.idx[t*3]), c0), b = V3.sub(vpos(m, m.idx[t*3+1]), c0), c = V3.sub(vpos(m, m.idx[t*3+2]), c0); vol += V3.dot(a, V3.cross(b, c)); }
    if (vol < 0) { for (const t of comp) flip(t); flipped += comp.length; } }
  return { flipped, comps }; }

// zip two rings of any vertex counts, walking both round by angle about (c, u, v): the exact vertices, no resampling (winding left to fixOrientation)
function bridgeByAngle(m, A, B, c, u, v) { const ang = id => { const p = V3.sub(vpos(m, id), c); return Math.atan2(V3.dot(p, v), V3.dot(p, u)); };
  const sa = A.slice().sort((x, y) => ang(x) - ang(y)), sb = B.slice().sort((x, y) => ang(x) - ang(y)); const na = sa.length, nb = sb.length;
  const aa = i => ang(sa[i % na]) + Math.floor(i / na) * 2 * Math.PI, ab = j => ang(sb[j % nb]) + Math.floor(j / nb) * 2 * Math.PI;
  let i = 0, j = 0; while (aa(0) - ab(j) > Math.PI) j++; while (ab(0) - aa(i) > Math.PI) i++;   // start both at about the same bearing
  const i1 = i + na, j1 = j + nb;
  while (i < i1 || j < j1) { const advA = i < i1 && (j >= j1 || aa(i + 1) <= ab(j + 1)); if (advA) { m.idx.push(sa[i % na], sa[(i + 1) % na], sb[j % nb]); i++; } else { m.idx.push(sa[i % na], sb[(j + 1) % nb], sb[j % nb]); j++; } } }
// close a big opening by SWEEPING its rim onto a ring: every rim vertex keeps its bearing θ about `axis` and is carried in K eased steps from its own
// (t, r) to the ring's (0, ringR(θ)), so the fill is the shell's own girth falling to the ring — the back of a hand sloping into its wrist. The rings
// keep each rim vertex's own uv (the fill is the shell's paint drawn inward), and a Laplacian pass over the grid takes the rim's jags out of it.
function sweepFill(m, loop, o) { const ids = loop.ids, N = ids.length, ax = V3.norm(o.axis), c0 = o.origin, K = o.rings || 6;
  const u = V3.norm(V3.cross(o.up || (Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1]), ax)), v = V3.cross(ax, u);
  const P = ids.map(id => { const d = V3.sub(vpos(m, id), c0), t = V3.dot(d, ax), rel = V3.sub(d, V3.scale(ax, t)); return { t, r: len2(rel), th: Math.atan2(V3.dot(rel, v), V3.dot(rel, u)) }; });
  const at = (th, t, r) => V3.add(V3.add(c0, V3.scale(ax, t)), V3.add(V3.scale(u, r * Math.cos(th)), V3.scale(v, r * Math.sin(th))));
  const grid = [ids]; let prev = ids;
  for (let k = 1; k <= K; k++) { const x = k / K, s = x * x * (3 - 2 * x);   /* (smoothstep: the fill leaves the rim and meets the ring flat, no crease at either end) */
    const ring = ids.map((id, j) => { const p = P[j], rr = p.r + (o.ringR(p.th) - p.r) * s, tt = p.t * (1 - s); const [ji, w] = o.weights ? o.weights(s, id) : packW(weightsOf(m, id));
      return addVert(m, at(p.th, tt, rr), o.uv ? o.uv(j / N, s) : [m.uv[id*2], m.uv[id*2+1]], ji, w, o.part); });
    stitch(m, prev, ring, o.flip); grid.push(ring); prev = ring; }
  for (let it = 0; it < (o.smooth || 4); it++) { const snap = grid.map(r => r.map(id => vpos(m, id)));
    for (let k = 1; k < K; k++) for (let j = 0; j < N; j++) { const nb = [snap[k-1][j], snap[k+1][j], snap[k][(j+1)%N], snap[k][(j-1+N)%N]];
      let a = [0, 0, 0]; for (const q of nb) a = V3.add(a, q); a = V3.scale(a, 1 / nb.length); const id = grid[k][j], p = V3.lerp(snap[k][j], a, 0.5); m.pos[id*3] = p[0]; m.pos[id*3+1] = p[1]; m.pos[id*3+2] = p[2]; } }
  return { grid, ring: prev, u, v, thetas: P.map(p => p.th) }; }
const len2 = a => Math.hypot(a[0], a[1], a[2]);
function pack(m) { return { pos: Float32Array.from(m.pos), uv: Float32Array.from(m.uv), ji: Uint16Array.from(m.ji), w: Float32Array.from(m.w), idx: Uint32Array.from(m.idx), part: m.part }; }
// compact + smooth normals (welded by position so uv-seam duplicates share a normal)
function finish(m) { const nv = nverts(m), used = new Int32Array(nv).fill(-1); let n = 0; for (const i of m.idx) if (used[i] < 0) used[i] = n++; const o = empty(); const inv = new Int32Array(n); for (let v = 0; v < nv; v++) if (used[v] >= 0) inv[used[v]] = v;
  for (let k = 0; k < n; k++) { const v = inv[k]; addVert(o, vpos(m, v), [m.uv[v*2], m.uv[v*2+1]], m.ji.slice(v*4, v*4+4), m.w.slice(v*4, v*4+4), m.part[v]); } for (const i of m.idx) o.idx.push(used[i]);
  const vid = weldIds(o), acc = new Float64Array(n * 3); for (let t = 0; t < o.idx.length; t += 3) { const a = vpos(o, o.idx[t]), b = vpos(o, o.idx[t+1]), c = vpos(o, o.idx[t+2]); const nn = V3.cross(V3.sub(b, a), V3.sub(c, a)); for (const i of [o.idx[t], o.idx[t+1], o.idx[t+2]]) { const w = vid[i]; acc[w*3] += nn[0]; acc[w*3+1] += nn[1]; acc[w*3+2] += nn[2]; } }
  o.nrm = []; for (let v = 0; v < n; v++) { const w = vid[v]; const nn = V3.norm([acc[w*3], acc[w*3+1], acc[w*3+2]]); o.nrm.push(nn[0], nn[1], nn[2]); } return o; }
module.exports = { sweepFill, fixOrientation, clipPlane, bridgeByAngle, V3, empty, nverts, vpos, addVert, weightsOf, blendW, packW, append, weldIds, openLoops, loopByAngle, tube, stitch, cap, ringAt, clipX, mirrorX, zipper, pack, finish };
