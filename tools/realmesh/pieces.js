// Cut a scanned figure into rigid armour pieces, one per rig pivot, already mapped into that pivot's local frame.
// usage: node pieces.js <set.json> <out dir>
const fs = require('fs'), path = require('path'); const S = require('./models/skin.js');
const [,, setFile, outDir] = process.argv; const set = JSON.parse(fs.readFileSync(setFile));
const dir = path.join(__dirname, 'models', set.model); const g = JSON.parse(fs.readFileSync(path.join(dir, 'scene.gltf'))); const bin = fs.readFileSync(path.join(dir, 'scene.bin')).buffer.slice(0);
const CT = { 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }, NC = { SCALAR: 1, VEC2: 2, VEC3: 3 };
const acc = i => { const a = g.accessors[i], bv = g.bufferViews[a.bufferView]; return new (CT[a.componentType])(bin, (bv.byteOffset || 0) + (a.byteOffset || 0), a.count * NC[a.type]); };
const prim = g.meshes[0].primitives[0]; const N = S.normalise(acc(prim.attributes.POSITION), set.yaw), UV = acc(prim.attributes.TEXCOORD_0), IDX = acc(prim.indices);
const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[3] && p[1] >= b[1] && p[1] <= b[4] && p[2] >= b[2] && p[2] <= b[5];
const slots = {}; for (const s of set.slots) slots[s.name] = { s, tris: [] }; let dropped = 0, unassigned = 0, dark = 0, uvbad = 0;
const lumPath = path.join(dir, 'tri-lum.bin'); const LUM = set.dropDark != null && fs.existsSync(lumPath) ? new Float32Array(fs.readFileSync(lumPath).buffer.slice(0)) : null;
// smooth the per-triangle luminance over its vertex neighbours (welded by position) so the cloth/steel decision is regional, not speckled
if (LUM) { const key = v => `${N[v * 3].toFixed(4)},${N[v * 3 + 1].toFixed(4)},${N[v * 3 + 2].toFixed(4)}`; const vt = new Map();
  for (let i = 0; i < IDX.length; i += 3) for (let k = 0; k < 3; k++) { const kk = key(IDX[i + k]); if (!vt.has(kk)) vt.set(kk, []); vt.get(kk).push(i / 3); }
  let cur = LUM; for (let it = 0; it < (set.lumSmooth || 3); it++) { const nxt = new Float32Array(cur.length); for (let i = 0; i < IDX.length; i += 3) { let sum = 0, n = 0; for (let k = 0; k < 3; k++) for (const t of vt.get(key(IDX[i + k]))) { sum += cur[t]; n++; } nxt[i / 3] = sum / n; } cur = nxt; }
  for (let i = 0; i < LUM.length; i++) LUM[i] = cur[i]; }
const J = set.rig ? JSON.parse(fs.readFileSync(path.join(__dirname, 'models', 'rigs', set.rig + '.json'))).joints : {};
for (let i = 0; i < IDX.length; i += 3) {
  const c = [0, 1, 2].map(k => IDX[i + k]); const P = c.map(v => [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]]); const p = [0, 1, 2].map(a => (P[0][a] + P[1][a] + P[2][a]) / 3);   // centroid
  if ((set.drop || []).some(b => inBox(p, b))) { dropped++; continue; }
  const grow = b => [b[0] - 0.012, b[1] - 0.012, b[2] - 0.012, b[3] + 0.012, b[4] + 0.012, b[5] + 0.012];
  // a triangle belongs to a slot only if ALL its corners sit in the (slightly grown) box — long triangles that reach
  // into the cape or across a joint would stretch into black shards once the piece is rescaled
  const s = set.slots.find(s => inBox(p, s.box) && P.every(q => inBox(q, grow(s.box)))); if (!s) { unassigned++; continue; }
  const thr = s.dropDark != null ? s.dropDark : set.dropDark; if (LUM && thr != null && LUM[i / 3] < thr) { dark++; continue; }   // the dark cloth (mantle, hose, skirt) under the plates is not armour
  // a triangle that spans a long way across the texture atlas is a decimation artefact (a collapse across a UV seam): drop it
  const maxUV = set.maxUV || 0.06; let bad = false; for (let k = 0; k < 3; k++) { const a = c[k], b = c[(k + 1) % 3]; if (Math.hypot(UV[a * 2] - UV[b * 2], UV[a * 2 + 1] - UV[b * 2 + 1]) > maxUV) bad = true; } if (bad) { uvbad++; continue; }
  slots[s.name].tris.push(c);
}
const parts = [], out = { model: set.model, texture: set.texture, slots: {} }; let off = 0;
const push = (arr) => { const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); const o = off; parts.push(b); off += b.length; if (off % 4) { const pad = Buffer.alloc(4 - off % 4); parts.push(pad); off += pad.length; } return o; };
for (const [name, { s, tris: tris0 }] of Object.entries(slots)) {
  // drop the flakes: connected components (by shared vertex) smaller than minComp triangles are cloth scraps, not plates
  const minComp = s.minComp != null ? s.minComp : (set.minComp != null ? set.minComp : 40);
  // (welded by position: texture seams split the index buffer, the plates themselves are continuous)
  const wk = v => `${N[v * 3].toFixed(4)},${N[v * 3 + 1].toFixed(4)},${N[v * 3 + 2].toFixed(4)}`;
  const par = new Map(); const find = a => { while (par.get(a) !== a) { par.set(a, par.get(par.get(a))); a = par.get(a); } return a; };
  for (const c of tris0) for (const v of c) { const k = wk(v); if (!par.has(k)) par.set(k, k); }
  for (const c of tris0) { const r0 = find(wk(c[0])); for (const v of c) { const r = find(wk(v)); if (r !== r0) par.set(r, r0); } }
  const size = new Map(); for (const c of tris0) { const r = find(wk(c[0])); size.set(r, (size.get(r) || 0) + 1); }
  const tris = tris0.filter(c => size.get(find(wk(c[0]))) >= minComp);
  if (tris.length !== tris0.length) console.log('  ' + name + ': flakes dropped', tris0.length - tris.length);
  if (!tris.length) { console.log('EMPTY slot', name); continue; }
  const map = new Map(), pos = [], uv = [], idx = [];
  for (const c of tris) for (const v of c) { let j = map.get(v); if (j == null) { j = pos.length / 3; map.set(v, j); pos.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]); uv.push(UV[v * 2], UV[v * 2 + 1]); } idx.push(j); }
  // place the piece: its joint anchor (normalised frame) lands on the pivot-local point `to`; sizes are the figure's own
  // (height 3.3) times per-axis multipliers that fatten it onto the chunky rig
  const S0 = set.height || 3.3, anchor = Array.isArray(s.anchor) ? s.anchor : J[s.anchor], to = s.to || [0, 0, 0], mul = s.scale || [1, 1, 1];
  if (!anchor) throw new Error('slot ' + name + ': unknown anchor ' + s.anchor);
  const sc = mul.map(m => m * S0);
  const P = new Float32Array(pos.length); for (let v = 0; v < pos.length / 3; v++) for (let a = 0; a < 3; a++) P[v * 3 + a] = (pos[v * 3 + a] - anchor[a]) * sc[a] + to[a];
  const U = new Float32Array(uv), I = pos.length / 3 < 65536 ? new Uint16Array(idx) : new Uint32Array(idx);
  out.slots[name] = { pos: push(P), uv: push(U), idx: push(I), n: pos.length / 3, ni: idx.length, i32: I instanceof Uint32Array, tris: tris.length, scale: sc.map(v => +v.toFixed(3)) };
  console.log(name.padEnd(12), 'tris', String(tris.length).padStart(6), 'scale', sc.map(v => v.toFixed(2)).join(' '));
}
fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'pieces.json'), JSON.stringify(out)); fs.writeFileSync(path.join(outDir, 'pieces.bin'), Buffer.concat(parts));
console.log('dropped', dropped, 'dark', dark, 'uv-streaks', uvbad, 'unassigned', unassigned, 'bin KB', (off / 1024) | 0);
