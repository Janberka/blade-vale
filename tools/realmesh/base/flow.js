#!/usr/bin/env node
// tools/realmesh/base/flow.js — WHERE IS THE BLADE when a blow ends, and which blow starts nearest to it?
//
// The game's blows are clips SCRUBBED on the sim's clock (game.js motionBlow). A chain that picks its next clip by count
// ("first, second, third") jumps the blade from wherever the last cut left it to wherever the next wind-up wants it — the
// user: "if I attack when my sword is near my left foot after a swing (right top to left bottom) and tap again, the system
// should pick the correct attack animation instead of random". This measures what "correct" is: for every frame of every
// blow's follow-through, the pose distance to every frame of every other blow's wind-up — the hand, the blade's tip, how
// far the chest and hips are turned, where the feet are. The best follow-up and the frame to take it up at are printed per
// frame; assets/motions/flow.json is WRITTEN BY HAND from this (it is a judgement: the numbers say which clips meet, the
// char editor's COMBO panel says whether it looks like fencing).
//
//   node tools/realmesh/base/flow.js            the table, frame by frame
//   node tools/realmesh/base/flow.js --check    is flow.json still what the clips say? (exit 1 when a range's clip is no longer the nearest)
//
// Body frame: −x is HIS right, +x his left, +z ahead, metres on the model (the game scales it ×1.39).
const path = require('path'), fs = require('fs'), ROOT = path.join(__dirname, '..', '..', '..');
const THREE = require(path.join(ROOT, 'vendor/three.min.js')), IO = require('./gltfio.js');
const R = IO.read(path.join(ROOT, 'assets/rigs/base')), W = IO.bindWorlds(R), ix = n => R.names.indexOf(n);
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/rigs/base/rig.json'))).grip.sword, FLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/motions/flow.json')));
const M4 = THREE.Matrix4, V3 = THREE.Vector3, Q4 = THREE.Quaternion;
const wm = n => new M4().fromArray(W[ix(n)]), posOf = m => new V3().setFromMatrixPosition(m), rotOf = m => new Q4().setFromRotationMatrix(new M4().extractRotation(m));
const parentOf = n => R.names[R.parent[ix(n)]], restQ = n => rotOf(wm(parentOf(n)).invert().multiply(wm(n))), restP = n => posOf(wm(parentOf(n)).invert().multiply(wm(n)));
const chain = n => { const c = []; let b = n; while (b && b !== 'pelvis') { c.unshift(b); b = parentOf(b); } return c; };
const tipL = new V3().fromArray(G.at).addScaledVector(new V3().fromArray(G.axis), 1.0), gripL = new V3().fromArray(G.at);
const C = {};
for (const [k, id] of Object.entries(FLOW.clips)) { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/motions', id + '.json'))); C[k] = c; c.feat = [];
  const q = (nm, f) => { const kk = c.bones.indexOf(nm); return kk < 0 ? restQ(nm) : new Q4().fromArray(c.q[kk], f * 4); };
  const world = (bone, f) => { let p = new V3(c.pos[f * 3], c.pos[f * 3 + 1], c.pos[f * 3 + 2]), Q = q('pelvis', f); for (const b of chain(bone)) { p.add(restP(b).applyQuaternion(Q)); Q = Q.clone().multiply(q(b, f)); } return { p, Q }; };
  const yawOf = (bone, f) => { const fw = new V3(0, 0, 1).applyQuaternion(world(bone, f).Q.clone().multiply(rotOf(wm(bone)).invert())); return Math.atan2(fw.x, fw.z); };
  for (let f = 0; f < c.frames; f++) { const h = world('handR', f);
    c.feat.push({ tip: h.p.clone().add(tipL.clone().applyQuaternion(h.Q)), gr: h.p.clone().add(gripL.clone().applyQuaternion(h.Q)), hips: yawOf('pelvis', f), chest: yawOf('spine3', f), footL: world('footL', f).p, footR: world('footR', f).p }); } }
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
// the pose distance: hand (m) + half the tip (m) + the chest's and hips' turn (rad, lightly) + the feet (m, lightly)
const cost = (a, b) => a.gr.distanceTo(b.gr) + 0.5 * a.tip.distanceTo(b.tip) + 0.35 * Math.abs(wrap(a.chest - b.chest)) + 0.25 * Math.abs(wrap(a.hips - b.hips)) + 0.3 * (a.footL.distanceTo(b.footL) + a.footR.distanceTo(b.footR));
const feat = (k, f) => C[k].feat[Math.max(0, Math.min(C[k].frames - 1, Math.round(f)))], guard = feat('down', 0), BLOWS = ['stab', 'up', 'down', 'spin'];
const best = (from, Y) => { let bf = 0, bc = 1e9; for (let f = 0; f <= Math.floor(C[Y].marks.top); f++) { const c = cost(from, feat(Y, f)); if (c < bc) { bc = c; bf = f; } } return [bf, bc]; };
const where = p => (p.x < -0.45 ? 'right' : p.x > 0.45 ? 'left' : 'centre') + ' ' + (p.y > 2.1 ? 'high' : p.y < 0.8 ? 'low' : 'mid') + (p.z < -0.5 ? ' behind' : p.z > 1.2 ? ' ahead' : '');
const check = process.argv.includes('--check'); let bad = 0;
if (!check) { console.log('cost = hand m + ½ tip m + 0.35 chest rad + 0.25 hips rad + 0.3 feet m     (−x = his right, +z = ahead)\n');
  console.log('FROM HIS GUARD to each wind-up\'s top − 0.12 s (what a TAP has to cross in its 0.06 s): ' + BLOWS.map(Y => Y + ' ' + cost(guard, feat(Y, C[Y].marks.top - 0.12 * C[Y].fps)).toFixed(2)).join(' · ') + '\n'); }
for (const X of Object.keys(FLOW.after)) { const land = C[X].marks.land, fps = C[X].fps, ranges = FLOW.after[X];
  if (!check) console.log('AFTER ' + X.toUpperCase() + '  (' + FLOW.clips[X] + ', lands f' + land + ')   flow.json: ' + ranges.map(r => '≤ +' + r[0] + 'f → ' + r[1] + ' @f' + r[2]).join(', ') + ', then his guard');
  for (let past = Math.round(FLOW.past * fps); land + past < C[X].frames; past += (check ? 1 : 2)) { const from = feat(X, land + past), all = BLOWS.map(Y => [Y, ...best(from, Y)]).sort((a, b) => a[2] - b[2]), g = cost(from, guard);
    const rg = ranges.find(r => past <= r[0]), pick = rg ? all.find(a => a[0] === rg[1]) : null;
    if (check) { if (rg && pick[2] > all[0][2] * 1.35 + 0.15) { bad++; console.log(`${X} +${past}f: flow.json says ${rg[1]} (${pick[2].toFixed(2)}) but ${all[0][0]} is nearer (${all[0][2].toFixed(2)})`); } continue; }
    console.log(`  +${String(past).padStart(2)}f ${(past / fps).toFixed(2)}s  blade ${where(from.tip).padEnd(18)} | ` + all.map(a => `${a[0]} f${String(a[1]).padStart(2)} ${a[2].toFixed(2)}`).join(' | ') + ` | guard ${g.toFixed(2)}` + (rg ? `   ← ${rg[1]} @f${rg[2]}` : '   ← guard')); }
  if (!check) console.log(''); }
if (check) { console.log(bad ? bad + ' frame(s) where flow.json is not the nearest blow' : 'flow.json agrees with the clips'); process.exit(bad ? 1 : 0); }
