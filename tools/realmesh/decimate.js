// decimate a Sketchfab/Tripo glTF (single material, N chunks) with meshoptimizer, write <dir>_lo/scene.gltf
const fs = require('fs'), path = require('path');
const { MeshoptSimplifier } = require('/Users/vic/Documents/GitHub/node_modules/meshoptimizer');
const [,, dir, targetTris = '12000', outSuffix = '_lo'] = process.argv;
(async () => {
  await MeshoptSimplifier.ready;
  const g = JSON.parse(fs.readFileSync(path.join(dir, 'scene.gltf')));
  const bin = fs.readFileSync(path.join(dir, g.buffers[0].uri)).buffer.slice(0);
  const CT = { 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }, NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const acc = i => { const a = g.accessors[i], bv = g.bufferViews[a.bufferView], T = CT[a.componentType], n = NC[a.type]; const off = (bv.byteOffset || 0) + (a.byteOffset || 0); if (bv.byteStride && bv.byteStride !== n * T.BYTES_PER_ELEMENT) throw new Error('interleaved'); return { arr: new T(bin, off, a.count * n), n, count: a.count }; };
  // world transform of the mesh nodes (Sketchfab wraps in rotation matrices)
  const M4 = require('./m4.js');
  const world = new Map();
  const walk = (i, m) => { const n = g.nodes[i]; let w = m; if (n.matrix) w = M4.mul(m, n.matrix); if (n.mesh != null) world.set(n.mesh, w); (n.children || []).forEach(c => walk(c, w)); };
  g.scenes[0].nodes.forEach(i => walk(i, M4.identity()));
  // merge chunks: dedupe by (pos,uv) key
  const key = new Map(), P = [], UV = [], IDX = [];
  for (const [mi, m] of g.meshes.entries()) for (const p of m.primitives) {
    const pos = acc(p.attributes.POSITION), uv = acc(p.attributes.TEXCOORD_0), idx = acc(p.indices), w = world.get(mi) || M4.identity();
    const remap = new Int32Array(pos.count);
    for (let v = 0; v < pos.count; v++) {
      const [x, y, z] = M4.xform(w, pos.arr[v * 3], pos.arr[v * 3 + 1], pos.arr[v * 3 + 2]);
      const u = uv.arr[v * 2], t = uv.arr[v * 2 + 1];
      const k = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)},${u.toFixed(4)},${t.toFixed(4)}`;
      let id = key.get(k); if (id == null) { id = P.length / 3; key.set(k, id); P.push(x, y, z); UV.push(u, t); }
      remap[v] = id;
    }
    for (let i = 0; i < idx.count; i++) IDX.push(remap[idx.arr[i]]);
  }
  const positions = new Float32Array(P), indices = new Uint32Array(IDX);
  console.log('merged verts', positions.length / 3, 'tris', indices.length / 3);
  const target = Math.min(indices.length, (+targetTris) * 3);
  const [simp, err] = MeshoptSimplifier.simplify(indices, positions, 3, target, +(process.env.ERR||0.05), (process.env.LOCK?['LockBorder']:[]));
  console.log('simplified tris', simp.length / 3, 'error', err.toFixed(4));
  // compact: keep used vertices, recompute normals (flat-ish smooth)
  const used = new Int32Array(positions.length / 3).fill(-1); let nv = 0; const oP = [], oUV = [];
  for (let i = 0; i < simp.length; i++) { const v = simp[i]; if (used[v] < 0) { used[v] = nv++; oP.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); oUV.push(UV[v * 2], UV[v * 2 + 1]); } simp[i] = used[v]; }
  const N = new Float32Array(oP.length);
  for (let i = 0; i < simp.length; i += 3) { const a = simp[i], b = simp[i + 1], c = simp[i + 2]; const ax = oP[a*3], ay = oP[a*3+1], az = oP[a*3+2]; const ux = oP[b*3]-ax, uy = oP[b*3+1]-ay, uz = oP[b*3+2]-az, vx = oP[c*3]-ax, vy = oP[c*3+1]-ay, vz = oP[c*3+2]-az; const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx; for (const v of [a,b,c]) { N[v*3]+=nx; N[v*3+1]+=ny; N[v*3+2]+=nz; } }
  for (let v = 0; v < nv; v++) { const l = Math.hypot(N[v*3], N[v*3+1], N[v*3+2]) || 1; N[v*3]/=l; N[v*3+1]/=l; N[v*3+2]/=l; }
  const oPos = new Float32Array(oP), oUv = new Float32Array(oUV);
  const idxT = nv < 65536 ? Uint16Array : Uint32Array, oIdx = new idxT(simp);
  const bufs = [oPos, N, oUv, oIdx]; let off = 0; const views = [], parts = [];
  for (const b of bufs) { const bytes = Buffer.from(b.buffer, b.byteOffset, b.byteLength); views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length }); parts.push(bytes); off += bytes.length; if (off % 4) { const pad = Buffer.alloc(4 - off % 4); parts.push(pad); off += pad.length; } }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], oPos[v*3+k]); mx[k] = Math.max(mx[k], oPos[v*3+k]); }
  const out = dir.replace(/\/$/, '') + outSuffix; fs.mkdirSync(path.join(out, 'textures'), { recursive: true });
  fs.writeFileSync(path.join(out, 'scene.bin'), Buffer.concat(parts));
  const gltf = { asset: { version: '2.0', generator: 'bv-decimate', extras: g.asset.extras }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'body' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'body', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.85 } }],
    textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], images: [{ uri: 'textures/baseColor.png' }],
    buffers: [{ uri: 'scene.bin', byteLength: off }], bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: nv, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: nv, type: 'VEC2' },
      { bufferView: 3, componentType: nv < 65536 ? 5123 : 5125, count: oIdx.length, type: 'SCALAR' }] };
  fs.writeFileSync(path.join(out, 'scene.gltf'), JSON.stringify(gltf));
  console.log('wrote', out, 'verts', nv, 'tris', oIdx.length / 3, 'bin KB', (off / 1024) | 0);
})();
