// minimal glTF read/write for the base-model pipeline (node), column-major mat4 helpers included
const fs = require('fs'), path = require('path');
const CT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }, NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function read(dir) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, 'scene.gltf'), 'utf8')); const buf = fs.readFileSync(path.join(dir, g.buffers[0].uri)); const bin = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const acc = i => { const a = g.accessors[i], bv = g.bufferViews[a.bufferView], T = CT[a.componentType], n = NC[a.type]; return new T(bin, (bv.byteOffset || 0) + (a.byteOffset || 0), a.count * n); };
  const meshes = g.nodes.filter(n => n.mesh != null).map(n => { const p = g.meshes[n.mesh].primitives[0], sk = g.skins[n.skin]; const m = { name: n.name, short: n.name.replace(/^SK_\d+_\d+_mo_MI_\d+_/, '').replace(/_0$/, ''), pos: acc(p.attributes.POSITION), nrm: p.attributes.NORMAL != null ? acc(p.attributes.NORMAL) : null, uv: p.attributes.TEXCOORD_0 != null ? acc(p.attributes.TEXCOORD_0) : null, ji: acc(p.attributes.JOINTS_0), w: acc(p.attributes.WEIGHTS_0), idx: acc(p.indices), joints: sk.joints, ibm: acc(sk.inverseBindMatrices), material: g.materials ? g.materials[p.material || 0] : null }; return m; });
  const names = g.nodes.map(n => n.name), parent = new Array(g.nodes.length).fill(-1); g.nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
  const order = []; const dfs = i => { order.push(i); (g.nodes[i].children || []).forEach(dfs); }; g.nodes.forEach((n, i) => { if (parent[i] < 0) dfs(i); });
  const restLocal = g.nodes.map(n => n.matrix ? Array.from(n.matrix) : identity());
  return { g, meshes, names, parent, order, restLocal, dir };
}
const identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k]; o[c*4+r] = s; } return o; };
const xform = (m, x, y, z, w = 1) => [m[0]*x+m[4]*y+m[8]*z+m[12]*w, m[1]*x+m[5]*y+m[9]*z+m[13]*w, m[2]*x+m[6]*y+m[10]*z+m[14]*w];
function invert(me) { // three.js Matrix4.invert, column-major
  const n11 = me[0], n21 = me[1], n31 = me[2], n41 = me[3], n12 = me[4], n22 = me[5], n32 = me[6], n42 = me[7], n13 = me[8], n23 = me[9], n33 = me[10], n43 = me[11], n14 = me[12], n24 = me[13], n34 = me[14], n44 = me[15];
  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44, t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44, t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44, t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14; if (Math.abs(det) < 1e-12) return null; const d = 1 / det; const o = new Array(16);
  o[0] = t11 * d; o[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d; o[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d; o[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d;
  o[4] = t12 * d; o[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d; o[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d; o[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d;
  o[8] = t13 * d; o[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d; o[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d; o[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d;
  o[12] = t14 * d; o[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d; o[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d; o[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d;
  return o; }
const translation = m => [m[12], m[13], m[14]];
function compose(t, q, s = [1, 1, 1]) { const x = q[0], y = q[1], z = q[2], w = q[3], x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1]; }
// the skeleton's bind world matrices from a mesh's ibms (invalid / missing ones rebuilt from the file's rest offset under the parent's bind)
function bindWorlds(R) { const W = new Array(R.g.nodes.length).fill(null); const m0 = R.meshes[0];
  m0.joints.forEach((j, k) => { const m = Array.from(m0.ibm.subarray(k * 16, k * 16 + 16)); const inv = invert(m); if (inv && inv.every(Number.isFinite)) W[j] = inv; });
  for (const i of R.order) { if (W[i]) continue; const p = R.parent[i]; W[i] = p >= 0 && W[p] ? mul(W[p], R.restLocal[i]) : R.restLocal[i].slice(); R.g.nodes[i].__rebuilt = true; }
  return W; }
// write a glTF: meshes = [{name, pos, nrm, uv, ji, w, idx, material}], skeleton = {names, parent, world (bind, per node), local (per node)}, materials/images
function write(dir, out) {
  fs.mkdirSync(dir, { recursive: true }); const chunks = []; let len = 0; const bufferViews = [], accessors = [];
  const push = (arr, target) => { const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); while (len % 4) { chunks.push(Buffer.alloc(1)); len++; } const off = len; chunks.push(b); len += b.length; const v = { buffer: 0, byteOffset: off, byteLength: b.length }; if (target) v.target = target; bufferViews.push(v); return bufferViews.length - 1; };
  const accF = (arr, comps, type, target, minmax) => { const bv = push(arr, target), a = { bufferView: bv, componentType: 5126, count: arr.length / comps, type }; if (minmax) { a.min = []; a.max = []; for (let c = 0; c < comps; c++) { let mn = 1e9, mx = -1e9; for (let i = c; i < arr.length; i += comps) { mn = Math.min(mn, arr[i]); mx = Math.max(mx, arr[i]); } a.min.push(mn); a.max.push(mx); } } accessors.push(a); return accessors.length - 1; };
  const accI = (arr, comps, type, target) => { const bv = push(arr, target); accessors.push({ bufferView: bv, componentType: arr instanceof Uint16Array ? 5123 : arr instanceof Uint8Array ? 5121 : 5125, count: arr.length / comps, type }); return accessors.length - 1; };
  const S = out.skeleton, nodes = S.names.map((nm, i) => { const n = { name: nm, matrix: S.local[i] }; const kids = []; S.parent.forEach((p, c) => { if (p === i) kids.push(c); }); if (kids.length) n.children = kids; return n; });
  const roots = S.parent.map((p, i) => p < 0 ? i : -1).filter(i => i >= 0);
  const ibm = new Float32Array(S.names.length * 16); S.world.forEach((w, i) => { ibm.set(invert(w), i * 16); }); const ibmAcc = accF(ibm, 16, 'MAT4');
  const skins = [{ joints: S.names.map((_, i) => i), inverseBindMatrices: ibmAcc, skeleton: roots[0] }], gMeshes = [], meshNodes = [];
  for (const m of out.meshes) { const attrs = { POSITION: accF(m.pos, 3, 'VEC3', 34962, true), JOINTS_0: accI(m.ji instanceof Uint16Array ? m.ji : Uint16Array.from(m.ji), 4, 'VEC4', 34962), WEIGHTS_0: accF(m.w instanceof Float32Array ? m.w : Float32Array.from(m.w), 4, 'VEC4', 34962) };
    if (m.nrm) attrs.NORMAL = accF(m.nrm, 3, 'VEC3', 34962); if (m.uv) attrs.TEXCOORD_0 = accF(m.uv, 2, 'VEC2', 34962); if (m.color) attrs.COLOR_0 = accI(m.color, 3, 'VEC3', 34962);
    const idx = m.idx instanceof Uint32Array ? m.idx : Uint32Array.from(m.idx); gMeshes.push({ name: m.name, primitives: [{ attributes: attrs, indices: accI(idx, 1, 'SCALAR', 34963), material: m.material || 0 }] });
    nodes.push({ name: m.name, mesh: gMeshes.length - 1, skin: 0 }); meshNodes.push(nodes.length - 1); }
  nodes.push({ name: 'root', children: roots.concat(meshNodes) });
  const gltf = { asset: { version: '2.0', generator: 'bv-base' }, scene: 0, scenes: [{ nodes: [nodes.length - 1] }], nodes, meshes: gMeshes, skins, materials: out.materials, textures: out.images.map((_, i) => ({ source: i, sampler: 0 })), samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], images: out.images.map(u => ({ uri: u })), buffers: [{ uri: 'scene.bin', byteLength: len }], bufferViews, accessors };
  fs.writeFileSync(path.join(dir, 'scene.bin'), Buffer.concat(chunks)); fs.writeFileSync(path.join(dir, 'scene.gltf'), JSON.stringify(gltf));
  const dump = S.names.map((nm, i) => ({ i, path: nm, parent: S.parent[i], pos: translation(S.world[i]) })); fs.writeFileSync(path.join(dir, 'bones.json'), JSON.stringify(dump, null, 1));
}
module.exports = { read, write, identity, mul, xform, invert, translation, compose, bindWorlds };
