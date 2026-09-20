// glTF / GLB → the skeleton and EVERY clip in it as JSON, for motion.js — the glTF twin of usdanim.swift.
//   node tools/realmesh/base/gltfanim.js <scene.gltf | model.glb> [out.json]      (no out.json: just list the clips)
// A .usdz binds ONE animation, so Sketchfab's usdz of an "11 motions" model carries only the first; its glTF download
// (Download 3D Model → glTF) has them all, by name. Same output as usdanim.swift — { joints, parents, rest, bind,
// clips: [{ name, times, t, r, s }] }, matrices column-major, quaternions x y z w — with two differences that make a glTF
// EASIER than the usdz: the hip IS a joint here (its travel is in its own translation track, no `world`), and the nodes
// keep their names (CC_Base_L_Thigh_04…: the stem is the bone, the number is Sketchfab's node index).
// "Joints" are the skin's joints PLUS every ancestor up to the scene root: exporters hang the skeleton under static nodes
// that turn it upright and scale cm → m (Sketchfab_model, *.fbx, RootNode), and carrying them through the FK puts both the
// rest pose and every frame in one upright world, whatever the file's own axes.
const fs = require('fs'), path = require('path');
const THREE = require('../../../vendor/three.min.js');
const [src, out] = process.argv.slice(2); if (!src) { console.log('usage: gltfanim.js <scene.gltf | model.glb> [out.json]'); process.exit(1); }
const FPS = 60;

// ---- the file
let g, bins = [];
if (/\.glb$/i.test(src)) { const b = fs.readFileSync(src); let o = 12; while (o < b.length) { const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4), chunk = b.slice(o + 8, o + 8 + len); if (type === 0x4E4F534A) g = JSON.parse(chunk.toString('utf8')); else bins.push(chunk); o += 8 + len; } }
else { g = JSON.parse(fs.readFileSync(src, 'utf8')); bins = g.buffers.map(bf => fs.readFileSync(path.join(path.dirname(src), decodeURIComponent(bf.uri)))); }
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }, SZ = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
function acc(i) { const a = g.accessors[i], bv = g.bufferViews[a.bufferView], buf = bins[bv.buffer], n = NC[a.type], sz = SZ[a.componentType], stride = bv.byteStride || n * sz, base = (bv.byteOffset || 0) + (a.byteOffset || 0), o = new Float32Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) { const p = base + k * stride + c * sz; let v;
    switch (a.componentType) { case 5126: v = buf.readFloatLE(p); break; case 5120: v = buf.readInt8(p); if (a.normalized) v = Math.max(v / 127, -1); break; case 5121: v = buf.readUInt8(p); if (a.normalized) v /= 255; break;
      case 5122: v = buf.readInt16LE(p); if (a.normalized) v = Math.max(v / 32767, -1); break; case 5123: v = buf.readUInt16LE(p); if (a.normalized) v /= 65535; break; default: v = buf.readUInt32LE(p); }
    o[k * n + c] = v; } return o; }

// ---- the skeleton: the biggest skin, and every ancestor of its joints
const skin = (g.skins || []).slice().sort((a, b) => b.joints.length - a.joints.length)[0]; if (!skin) { console.log('no skin in', src); process.exit(1); }
const par = new Array(g.nodes.length).fill(-1); g.nodes.forEach((n, i) => (n.children || []).forEach(c => { par[c] = i; }));
const keep = new Set(); for (const j of skin.joints) { let i = j; while (i >= 0 && !keep.has(i)) { keep.add(i); i = par[i]; } }
const order = []; (function walk(i) { if (keep.has(i)) order.push(i); (g.nodes[i].children || []).forEach(walk); }); g.nodes.forEach((n, i) => { if (par[i] < 0) (function walk(k) { if (keep.has(k)) order.push(k); (g.nodes[k].children || []).forEach(walk); })(i); });
const at = new Map(order.map((n, k) => [n, k])), seen = {}, names = order.map(i => { let nm = g.nodes[i].name || ('node' + i); if (seen[nm] != null) nm += '#' + (++seen[nm]); else seen[nm] = 0; return nm; });
const trs = n => { if (n.matrix) { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); new THREE.Matrix4().fromArray(n.matrix).decompose(p, q, s); return { t: p.toArray(), r: q.toArray(), s: s.toArray() }; }
  return { t: n.translation || [0, 0, 0], r: n.rotation || [0, 0, 0, 1], s: n.scale || [1, 1, 1] }; };
const restTRS = order.map(i => trs(g.nodes[i])), m16 = o => new THREE.Matrix4().compose(new THREE.Vector3().fromArray(o.t), new THREE.Quaternion().fromArray(o.r), new THREE.Vector3().fromArray(o.s)).elements.slice();
const ibm = skin.inverseBindMatrices != null ? acc(skin.inverseBindMatrices) : null, bind = order.map(() => new THREE.Matrix4().elements.slice());
if (ibm) skin.joints.forEach((j, k) => { bind[at.get(j)] = new THREE.Matrix4().fromArray(ibm, k * 16).invert().elements.slice(); });

// ---- the clips, every channel sampled at 60 a second (LINEAR slerps a rotation, STEP holds, CUBICSPLINE is read at its knots)
function sampler(anim, ch) { const s = anim.samplers[ch.sampler], tin = acc(s.input), v = acc(s.output), n = ch.target.path === 'rotation' ? 4 : 3, cub = s.interpolation === 'CUBICSPLINE', step = s.interpolation === 'STEP';
  const val = k => { const o = cub ? (k * 3 + 1) * n : k * n; return Array.from(v.subarray(o, o + n)); }, qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  return { t0: tin[0], t1: tin[tin.length - 1], at(t) { if (t <= tin[0]) return val(0); if (t >= tin[tin.length - 1]) return val(tin.length - 1); let k = 0; while (tin[k + 1] < t) k++; const a = step ? 0 : (t - tin[k]) / (tin[k + 1] - tin[k]), A = val(k), B = val(k + 1);
    if (n === 4) return qa.fromArray(A).slerp(qb.fromArray(B), a).toArray(); return A.map((x, c) => x + (B[c] - x) * a); } }; }
const clips = (g.animations || []).map((anim, ai) => { const chans = anim.channels.filter(c => at.has(c.target.node) && /^(translation|rotation|scale)$/.test(c.target.path)).map(c => ({ k: at.get(c.target.node), path: c.target.path, s: sampler(anim, c) }));
  if (!chans.length) return null; const t0 = Math.min(...chans.map(c => c.s.t0)), t1 = Math.max(...chans.map(c => c.s.t1)), nf = Math.max(2, Math.round((t1 - t0) * FPS) + 1), times = [], T = [], R = [], S = [];
  for (let f = 0; f < nf; f++) { const t = Math.min(t1, t0 + f / FPS); times.push(+(t - t0).toFixed(5)); const tt = restTRS.map(o => o.t.slice()), rr = restTRS.map(o => o.r.slice()), ss = restTRS.map(o => o.s.slice());
    for (const c of chans) { const v = c.s.at(t); (c.path === 'translation' ? tt : c.path === 'rotation' ? rr : ss)[c.k] = v; }
    T.push([].concat(...tt)); R.push([].concat(...rr)); S.push([].concat(...ss)); }
  return { name: anim.name || ('clip' + ai), times, t: T, r: R, s: S, moving: new Set(chans.map(c => c.k)).size }; }).filter(Boolean);

console.log(`${path.basename(src)}: ${skin.joints.length} joints (+${order.length - skin.joints.length} nodes above them), ${clips.length} clip${clips.length === 1 ? '' : 's'}`);
clips.forEach((c, i) => console.log(`  --clip ${i}  ${c.name.padEnd(28)} ${(c.times[c.times.length - 1]).toFixed(2)} s  ${c.times.length} frames  ${c.moving} nodes move`));
if (out) { const paths = order.map((i, k) => { const chain = []; let n = i; while (n >= 0 && at.has(n)) { chain.unshift(names[at.get(n)]); n = par[n]; } return chain.join('/'); });
  fs.writeFileSync(out, JSON.stringify({ source: path.basename(src), joints: paths, parents: order.map(i => par[i] >= 0 && at.has(par[i]) ? at.get(par[i]) : -1), rest: restTRS.map(m16), bind, clips: clips.map(c => ({ name: c.name, times: c.times, t: c.t, r: c.r, s: c.s })) }));
  console.log(`→ ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`); }
