// DRESS THE BASE and write the game's rig: his body and hair, the wear he brought from the Thor sculpt (the leather wrist
// bands, the trousers and boots, a steel arm either side) and the two shoulder plates — on one `wear` material (two-sided:
// the wraps are single sheets) plus a `leather` one for the baked plates. The old warrior kit is gone; its pauldrons were
// cut out of it once (`node dress.js extract <a retargeted dir>`) and are ours now, in tools/chared/items/pauldron.json.
// The kit's SWORD and SHIELD (wares that stay) come from the game's own file (GAME/assets/rigs/base): each rides one bone, so a
// vertex is carried by newBind(bone) · oldBind(bone)⁻¹ — the hand's bind changed with HANDSTANCE=0 and the sword must follow it.
//   node tools/realmesh/base/dress.js <built base dir> [out = assets/rigs/base] [--baked]
// --baked: the plates the CHAR EDITOR finished and exported (tools/chared/items/pauldron_baked.json + leather_tile.png) —
// what the game gets. Without it the plates go in raw, on the `wear` material, and the editor fits and finishes them live
// (that is the loop: dress raw → open the editor → __exportArmor() → dress --baked).
// The helm (helm_corinthian.*) is not touched: it already sits in the rig, carried there by basebuild.js.
const fs = require('fs'), path = require('path'), G = require('./gltfio');
const ITEMS = path.join(__dirname, '../../chared/items');   // the char editor's pieces: the plates it cut, the plates it baked, the leather tile
if (process.argv[2] === 'extract') {   // once: cut the pauldron triangles out of a retargeted file that still carries the kit
  const T = G.read(process.argv[3]), pj = JSON.parse(fs.readFileSync(process.argv[3] + '/pieces.json')).armor, cls = pj.classes.indexOf('pauldron');
  const armor = T.meshes.find(m => /FantasyWarrior_armor/.test(m.name)), out = {};
  for (const side of ['L', 'R']) { const keep = [], map = new Map(), P = [], N = [], UV = [], JI = [], W = [];
    const vid = v => { if (!map.has(v)) { map.set(v, P.length / 3); P.push(...armor.pos.subarray(v*3, v*3+3)); N.push(...armor.nrm.subarray(v*3, v*3+3)); UV.push(...armor.uv.subarray(v*2, v*2+2)); JI.push(...armor.ji.subarray(v*4, v*4+4)); W.push(...armor.w.subarray(v*4, v*4+4)); } return map.get(v); };
    for (let t = 0; t < armor.idx.length; t += 3) { const a = armor.idx[t], b = armor.idx[t+1], c = armor.idx[t+2];
      if (pj.vclass[a] !== cls || pj.vclass[b] !== cls || pj.vclass[c] !== cls) continue;
      const x = (armor.pos[a*3] + armor.pos[b*3] + armor.pos[c*3]) / 3; if ((x > 0) !== (side === 'L')) continue;   // his left is +x
      keep.push(vid(a), vid(b), vid(c)); }
    out['pauldron_' + side] = { pos: P, nrm: N, uv: UV, ji: JI, w: W, idx: keep }; console.log('pauldron_' + side, P.length / 3, 'verts', keep.length / 3, 'tris'); }
  fs.mkdirSync(ITEMS, { recursive: true }); fs.writeFileSync(ITEMS + '/pauldron.json', JSON.stringify(out));
  process.exit(0); }

const IN = process.argv[2], OUT = process.argv.slice(3).find(a => !a.startsWith('--')) || path.join(__dirname, '../../../assets/rigs/base'), BAKED = process.argv.includes('--baked'); const T = G.read(IN);
const GAME = process.env.GAME || path.join(__dirname, '../../../assets/rigs/base');   // where the sword and the shield come from: the rig as it stands. Re-bound, not copied — if the base is ever rebuilt with a different hand bind the props follow it; with the same bind the transform is the identity and they come through untouched.
const ibm = T.meshes[0].ibm, names = T.names.slice(0, ibm.length / 16), skel = { names, parent: names.map((_, i) => T.parent[i] < names.length ? T.parent[i] : -1) };   // (the file hangs the joints off a "root" node past the joints)
skel.world = names.map((_, i) => G.invert(Array.from(ibm.subarray(i * 16, i * 16 + 16)))); skel.local = skel.world.map((w, i) => skel.parent[i] < 0 ? w : G.mul(G.invert(skel.world[skel.parent[i]]), w));
fs.mkdirSync(OUT, { recursive: true });
const OURS = /^(base_body|hair_long|band_[LR]|legs|gauntlet_[LR])$/;
const meshes = T.meshes.filter(m => OURS.test(m.name)).map(m => ({ name: m.name, pos: m.pos, nrm: m.nrm, uv: m.uv, ji: m.ji, w: m.w, idx: m.idx, material: m.name === 'base_body' ? 0 : m.name === 'hair_long' ? 1 : 2 }));
const pd = JSON.parse(fs.readFileSync(ITEMS + (BAKED ? '/pauldron_baked.json' : '/pauldron.json')));
for (const nm of Object.keys(pd)) meshes.push({ name: nm, pos: Float32Array.from(pd[nm].pos), nrm: Float32Array.from(pd[nm].nrm), uv: Float32Array.from(pd[nm].uv), ji: Uint16Array.from(pd[nm].ji), w: Float32Array.from(pd[nm].w), idx: Uint32Array.from(pd[nm].idx), material: BAKED ? 4 : 2 });
// the sword and the shield, re-bound from the game file's bind onto this one's
{ const O = G.read(GAME), oi = O.meshes[0].ibm, ni = ibm, oldW = i => G.invert(Array.from(oi.subarray(i * 16, i * 16 + 16))), newW = i => G.invert(Array.from(ni.subarray(i * 16, i * 16 + 16)));
  for (const key of ['sword', 'shield']) { const m = O.meshes.find(x => new RegExp('FantasyWarrior_' + key).test(x.name)); if (!m) { console.warn('no', key, 'in', GAME); continue; }
    const j = m.ji[0], nmI = O.names.indexOf(O.names[j]), nj = names.indexOf(O.names[j]); if (nj < 0) throw new Error('bone ' + O.names[j] + ' missing');
    const X = G.mul(newW(nj), G.invert(oldW(j))), pos = new Float32Array(m.pos.length), nrm = new Float32Array(m.nrm.length), R3 = [X[0], X[1], X[2], X[4], X[5], X[6], X[8], X[9], X[10]];
    for (let v = 0; v < m.pos.length / 3; v++) { const q = G.xform(X, m.pos[v*3], m.pos[v*3+1], m.pos[v*3+2]); pos.set(q, v * 3);
      const n = [m.nrm[v*3], m.nrm[v*3+1], m.nrm[v*3+2]], r = [R3[0]*n[0]+R3[3]*n[1]+R3[6]*n[2], R3[1]*n[0]+R3[4]*n[1]+R3[7]*n[2], R3[2]*n[0]+R3[5]*n[1]+R3[8]*n[2]], L = Math.hypot(...r) || 1; nrm.set([r[0]/L, r[1]/L, r[2]/L], v * 3); }
    const ji = Uint16Array.from(m.ji, x => names.indexOf(O.names[x])); meshes.push({ name: m.name, pos, nrm, uv: m.uv, ji, w: m.w, idx: m.idx, material: 3 }); console.log('carried', key, 'on', O.names[j]); }
  fs.copyFileSync(GAME + '/6_characters_baseColor.jpg', OUT + '/6_characters_baseColor.jpg'); global.KITPJ = JSON.parse(fs.readFileSync(GAME + '/pieces.json')); }
G.write(OUT, { meshes, skeleton: skel, materials: [
  { name: 'base', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'hair', pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicFactor: 0, roughnessFactor: 0.9 }, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true },
  { name: 'wear', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.85 }, doubleSided: true },
  { name: 'kit', pbrMetallicRoughness: { baseColorTexture: { index: 2 }, metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'leather', pbrMetallicRoughness: { baseColorTexture: { index: 3 }, metallicFactor: 0.25, roughnessFactor: 0.62 }, doubleSided: true }], images: ['atlas.jpg', 'hair.png', '6_characters_baseColor.jpg', 'leather_tile.png'] });
if (BAKED) fs.copyFileSync(ITEMS + '/leather_tile.png', OUT + '/leather_tile.png'); else if (!fs.existsSync(OUT + '/leather_tile.png')) fs.writeFileSync(OUT + '/leather_tile.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));   // (a 1 px stand-in until the editor bakes one)
for (const f of ['atlas.jpg', 'atlas.json', 'atlas_raw.jpg', 'atlas_normal.jpg', 'hair.png', 'hair_mask.png', 'parts.json', 'rig.json']) if (fs.existsSync(IN + '/' + f) && IN !== OUT) fs.copyFileSync(IN + '/' + f, OUT + '/' + f);
const parts = JSON.parse(fs.readFileSync(OUT + '/parts.json')), pj = { body: { classes: parts.classes, vclass: parts.vclass } }; for (const k of ['sword', 'shield']) if (global.KITPJ && global.KITPJ[k]) pj[k] = global.KITPJ[k];
fs.writeFileSync(OUT + '/pieces.json', JSON.stringify(pj));   // (headbake.py then writes the real body entry: face classes, mats, tri)
console.log('wrote', OUT, meshes.map(m => m.name).join(' '));
