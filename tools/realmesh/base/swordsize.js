// HOW BIG A SWORD IS ON HIM. The steel was sized for the old plastic rig — toy proportions: a standard blade three quarters
// of a man's height, a flat as wide as a forearm — and on the base it reads as a plank ("all the swords are too big for our
// char"). Two numbers fix it, both measured against HIS height, and both kept in rig.json.grip.sword:
//   own   the rig's OWN iron sword (the mesh bound to his hand, and its copy at the hip): scaled IN THE FILE, about the
//         point where its guard meets the handle line — so the guard stays a finger clear of his index and the blade,
//         the grip and the pommel all draw in toward it. `own` is the running product of every such scale.
//   size  a LOADOUT sword (game.js afBuildSword, built in game units for the plastic rig): the scale game.js gives the
//         built sword on this figure's hand (wearModelRig) and planted beside him on the home page. Nothing is baked.
//
//   node tools/realmesh/base/swordsize.js                  the sizes as they stand (nothing written)
//   node tools/realmesh/base/swordsize.js --own 0.88       scale the rig's own sword by 0.88 (scene.bin, scene.gltf, rig.json)
//   node tools/realmesh/base/swordsize.js --size 0.71      rig.json.grip.sword.size = 0.71
// Then bump game.js?v=. The char editor and dress.js read the rig as it stands, so both follow with no further step.
const fs = require('fs'), path = require('path');
const THREE = require('../../../vendor/three.min.js'), IO = require('./gltfio.js');
const RIG = process.env.RIG || path.join(__dirname, '..', '..', '..', 'assets', 'rigs', 'base');
const V3 = THREE.Vector3, M4 = THREE.Matrix4;
const args = process.argv.slice(2), flag = k => { const i = args.indexOf('--' + k); return i < 0 ? null : +args[i + 1]; };
const OWN = flag('own'), SIZE = flag('size');
if ((OWN != null && !(OWN > 0.3 && OWN < 3)) || (SIZE != null && !(SIZE > 0.3 && SIZE < 3))) { console.error('a scale between 0.3 and 3, please'); process.exit(1); }

const R = IO.read(RIG), W = IO.bindWorlds(R), rig = JSON.parse(fs.readFileSync(path.join(RIG, 'rig.json'))), gs = (rig.grip || {}).sword;
if (!gs || !gs.at) { console.error('rig.json.grip.sword.at is missing — seat the sword first (grip.js --bake / --gear)'); process.exit(1); }
const sw = R.meshes.find(m => m.name === rig.meshes.sword), hw = new M4().fromArray(W[R.names.indexOf(gs.hand)]);
const axisH = new V3().fromArray(gs.axis).normalize(), G = new V3().fromArray(gs.at).addScaledVector(axisH, gs.reach || 0.09).applyMatrix4(hw);   // where the guard meets the handle line, bind space
const L = axisH.clone().transformDirection(hw);                                                                                                 // the way the blade leaves the fist
const along = () => { let lo = 1e9, hi = -1e9; for (let i = 0; i < sw.pos.length; i += 3) { const s = new V3(sw.pos[i], sw.pos[i + 1], sw.pos[i + 2]).sub(G).dot(L); lo = Math.min(lo, s); hi = Math.max(hi, s); } return { lo, hi }; };
const S = rig.hipY ? 1.52 / rig.hipY : 3.3 / (rig.height || 1.9), IRON = 2.15;   // game units per rig unit (wearModelRig) · afBuildSword's plain iron sword, pommel to tip, in game units
const report = tag => { const a = along(), all = a.hi - a.lo, k = gs.size || 1;
  console.log(`${tag}: his own sword ${(all * 100).toFixed(1)} cm = ${(100 * all / rig.height).toFixed(0)}% of his ${rig.height} · blade past the guard ${(a.hi * 100).toFixed(1)} cm · hilt behind it ${(-a.lo * 100).toFixed(1)} cm · own ×${gs.own || 1}`);
  console.log(`${' '.repeat(tag.length)}  a loadout iron sword ${(IRON * k / S * 100).toFixed(1)} cm = ${(100 * IRON * k / S / rig.height).toFixed(0)}% · size ×${k}`); };
report('now');

if (OWN != null) {
  const gl = JSON.parse(fs.readFileSync(path.join(RIG, 'scene.gltf'), 'utf8')), buf = fs.readFileSync(path.join(RIG, 'scene.bin'));
  const node = gl.nodes.find(n => n.name === sw.name), a = gl.accessors[gl.meshes[node.mesh].primitives[0].attributes.POSITION], bv = gl.bufferViews[a.bufferView], base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], c = G.toArray();
  for (let i = 0; i < a.count; i++) for (let k = 0; k < 3; k++) { const o = base + i * 12 + k * 4, v = c[k] + (buf.readFloatLE(o) - c[k]) * OWN; buf.writeFloatLE(v, o); sw.pos[i * 3 + k] = v; mn[k] = Math.min(mn[k], v); mx[k] = Math.max(mx[k], v); }
  a.min = mn; a.max = mx;                                                            // (a uniform scale: the normals stand)
  fs.writeFileSync(path.join(RIG, 'scene.bin'), buf); fs.writeFileSync(path.join(RIG, 'scene.gltf'), JSON.stringify(gl));
  gs.own = +((gs.own || 1) * OWN).toFixed(4);
}
if (SIZE != null) gs.size = SIZE;
if (OWN != null || SIZE != null) { fs.writeFileSync(path.join(RIG, 'rig.json'), JSON.stringify(rig, null, 1)); report('new'); console.log('written — now bump game.js?v='); }
