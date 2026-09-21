// FINGERS FOR A HAND THAT CAME WITHOUT THEM. Plenty of downloadable characters carry a rigid hand (one joint at the wrist, the
// fingers modelled relaxed) or a "mitten" chain that curls all four fingers together. Our rig closes a fist round a hilt with
// fifteen finger bones a hand, so the fingers are found in the MESH and rigged from it:
//   1. the hand = the vertices the source hangs on its hand joint(s); geodesic distance over the welded surface from the
//      wrist ring grows all the way out to five local maxima — the fingertips;
//   2. the thumb is the tip that stands apart; the other four are ordered along their arc, starting next to the thumb;
//   3. between two neighbouring tips the shortest path over the skin dips through the WEB — its lowest point (by distance
//      from the wrist) says where the free finger ends;
//   4. a finger's own vertices, binned by distance from its tip, give ring centroids = its medial axis; a relaxed finger is
//      curved, and the axis follows the curve;
//   5. joints by the hand's own anatomy: knuckle-to-tip = 1.27 × the free finger (the web sits ~45 % up the first
//      phalanx), the last joint 26 % from the tip, the middle one 54.5 %; the knuckle lies INSIDE the palm on the first
//      phalanx' line carried on. The thumb: 51 % / 111 % of its free length, its root by the wrist on the thumb's side;
//   6. weights by where a vertex projects on its finger's axis, blended across each joint.
const { V, smooth, geodesic, pathTo, polyline } = require('./lib');
const RATIO = { total: 1.27, dip: 0.26, pip: 0.545, thumbIp: 0.51, thumbMcp: 1.11, thumbMc: 0.87 };

function rigHand(Gr, handSet, wrist, log = () => {}) {
  const ring = [...handSet].filter(v => [...Gr.adj.get(v)].some(u => !handSet.has(u)));
  const gw = geodesic(Gr, ring, handSet).dist, far = Math.max(...gw.values());
  for (const v of [...handSet]) if (!gw.has(v)) handSet.delete(v);           // (a loose piece the wrist never reaches is not this hand)
  // fingertips: local maxima of the distance from the wrist (within two edges), the five that reach farthest
  const two = v => { const s = new Set(); for (const u of Gr.adj.get(v)) { if (!handSet.has(u)) continue; s.add(u); for (const w of Gr.adj.get(u)) if (handSet.has(w)) s.add(w); } s.delete(v); return s; };
  let peaks = [...handSet].filter(v => gw.get(v) > far * 0.25 && [...two(v)].every(u => gw.get(u) <= gw.get(v))).sort((a, b) => gw.get(b) - gw.get(a));
  const tips = []; for (const v of peaks) { if (tips.every(t => V.dist(Gr.P(t), Gr.P(v)) > 0.012)) tips.push(v); }
  if (process.env.HANDS_DEBUG) log('  peaks: ' + peaks.slice(0, 12).map(v => (gw.get(v) * 100).toFixed(1) + '@' + Gr.P(v).map(x => (x * 100).toFixed(1)).join('/')).join('  '));
  if (tips.length < 5) throw new Error('hands: only ' + tips.length + ' fingertips found — is this a hand with separate fingers?');
  const five = tips.slice(0, 5), apart = t => Math.min(...five.filter(u => u !== t).map(u => V.dist(Gr.P(u), Gr.P(t))));
  const thumbTip = five.slice().sort((a, b) => apart(b) - apart(a))[0], four = five.filter(t => t !== thumbTip);
  let ext = [four[0], four[1]]; for (const a of four) for (const b of four) if (V.dist(Gr.P(a), Gr.P(b)) > V.dist(Gr.P(ext[0]), Gr.P(ext[1]))) ext = [a, b];
  const first = V.dist(Gr.P(ext[0]), Gr.P(thumbTip)) < V.dist(Gr.P(ext[1]), Gr.P(thumbTip)) ? ext[0] : ext[1];
  four.sort((a, b) => V.dist(Gr.P(a), Gr.P(first)) - V.dist(Gr.P(b), Gr.P(first)));
  const NAMES = ['index', 'middle', 'ring', 'little'], F = {}; four.forEach((t, i) => { F[NAMES[i]] = { tip: t }; }); F.thumb = { tip: thumbTip };
  for (const k in F) { const g = geodesic(Gr, [F[k].tip], handSet); F[k].g = g.dist; F[k].par = g.par; }
  // the webs: the lowest point (nearest the wrist) of the skin path from one tip to the next
  const web = (a, b) => { const p = pathTo(F[a].par, F[b].tip); let best = p[0]; for (const v of p) if (gw.get(v) < gw.get(best)) best = v; return best; };
  const W = { im: web('index', 'middle'), mr: web('middle', 'ring'), rl: web('ring', 'little'), ti: web('thumb', 'index') };
  const lvl = (k, ...ws) => ws.reduce((s, w) => s + F[k].g.get(w), 0) / ws.length;
  F.index.web = lvl('index', W.im); F.middle.web = lvl('middle', W.im, W.mr); F.ring.web = lvl('ring', W.mr, W.rl); F.little.web = lvl('little', W.rl); F.thumb.web = lvl('thumb', W.ti);
  const size = V.dist(wrist, Gr.P(F.middle.tip)) / 0.19;                    // every length below is for a 19 cm hand, scaled to this one
  for (const k in F) { const f = F[k], own = [...handSet].filter(v => f.g.get(v) <= f.web - 0.003 * size && Object.keys(F).every(j => j === k || F[j].g.get(v) >= f.g.get(v)));
    const STEP = 0.0045 * size, bins = []; for (const v of own) { const b = Math.floor(f.g.get(v) / STEP); (bins[b] = bins[b] || []).push(Gr.P(v)); }
    let pts = [Gr.P(f.tip)]; for (let b = 1; b < bins.length; b++) if (bins[b] && bins[b].length >= 3) pts.push(V.mean(bins[b]));
    // the tip vertex sits on the nail side or the pad, wherever the mesh put it: start the axis a radius inside, on the line of the first rings
    if (pts.length >= 4) { const d = V.norm(V.sub(pts[1], pts[3])); pts[0] = V.add(pts[1], V.mul(d, V.dot(V.sub(pts[0], pts[1]), d))); }
    for (let it = 0; it < 2; it++) pts = pts.map((p, i) => i === 0 || i === pts.length - 1 ? p : V.lerp(p, V.lerp(pts[i - 1], pts[i + 1], 0.5), 0.5));
    const free = polyline(pts); f.free = free.L + 0.003 * size; f.own = own;
    const thumb = k === 'thumb', total = f.free * (thumb ? RATIO.thumbMcp : RATIO.total), s1 = f.free * (thumb ? RATIO.thumbIp : RATIO.dip * RATIO.total), s2 = thumb ? total : RATIO.pip * f.free * RATIO.total;
    // the first phalanx' own line, from the rings between its far joint and the web, carried on into the palm
    const prox = pts.filter((p, i) => free.S[i] >= Math.min(s2, free.L * 0.6)), c = V.mean(prox); let dir = V.norm(V.sub(prox[prox.length - 1], prox[0]));
    const endS = free.L, end = free.at(endS), root = V.add(end, V.mul(dir, total - endS)), beyond = V.add(root, V.mul(dir, 0.03 * size));
    f.axis = polyline(pts.concat([root, beyond])); f.total = total; f.dir = dir;
    if (thumb) { f.ip = f.axis.at(s1); f.mcp = f.axis.at(total); f.sJ = [s1, total]; }
    else { f.dip = f.axis.at(s1); f.pip = f.axis.at(s2); f.mcp = f.axis.at(total); f.sJ = [s1, s2, total]; }
    f.tipP = pts[0]; f.tipSkin = Gr.P(f.tip);
    log('  ' + k.padEnd(6) + ' free ' + (f.free * 100).toFixed(1) + ' cm, knuckle→tip ' + (total * 100).toFixed(1) + ' cm, ' + own.length + ' verts, ' + pts.length + ' rings'); }
  // the thumb's root: by the wrist on the thumb's side — from its knuckle back along a line toward the wrist, its metacarpal's length
  { const t = F.thumb, mc = t.free * RATIO.thumbMc, aim = V.lerp(wrist, t.mcp, 0.12), d = V.norm(V.sub(aim, t.mcp)); t.cmc = V.add(t.mcp, V.mul(d, Math.min(mc, V.dist(aim, t.mcp)))); t.sJ.push(t.total + V.dist(t.cmc, t.mcp));
    t.axis = polyline(t.axis.pts.slice(0, -2).concat([t.mcp, t.cmc, V.add(t.cmc, V.mul(d, 0.02 * size))])); }
  // WEIGHTS. A vertex belongs to the finger whose web it lies beyond (or nearest to, in the palm); along that finger's axis:
  // last phalanx | middle | first | hand, each joint a smooth blend. In the palm the first phalanx' hold fades with the
  // distance from its line, so the knuckle's skin follows the finger and the palm between two knuckles does not tear.
  const weights = new Map(), hJ = 0.0050 * size, hM = 0.012 * size;
  for (const v of handSet) { let best = null, bd = Infinity; for (const k in F) { const d = F[k].g.get(v) - F[k].web; if (d < bd) { bd = d; best = k; } }
    const f = F[best], p = Gr.P(v), pr = f.axis.project(p), s = pr.s, thumb = best === 'thumb', out = [];
    const lateral = bd > 0 ? 1 - smooth(pr.d, 0.011 * size, 0.024 * size) : 1;                       // in the palm: only near the finger's own line
    if (thumb) { const [sI, sM, sC] = f.sJ, a = 1 - smooth(s, sI - hJ, sI + hJ), b = smooth(s, sI - hJ, sI + hJ) - smooth(s, sM - hM, sM + hM), mc = smooth(s, sM - hM, sM + hM) * (1 - smooth(s, sC - 0.018 * size, sC + 0.004 * size)) * (1 - smooth(pr.d, 0.014 * size, 0.032 * size));
      out.push(['thumb.2', a * lateral], ['thumb.1', Math.max(0, b) * lateral], ['thumb.0', mc]); }
    else { const [sD, sP, sM] = f.sJ, a = 1 - smooth(s, sD - hJ, sD + hJ), b = smooth(s, sD - hJ, sD + hJ) - smooth(s, sP - hJ, sP + hJ), c = smooth(s, sP - hJ, sP + hJ) - smooth(s, sM - hM, sM + hM);
      out.push([best + '.3', a * lateral], [best + '.2', Math.max(0, b) * lateral], [best + '.1', Math.max(0, c) * lateral]); }
    let sum = 0; for (const o of out) sum += o[1]; out.push(['hand', Math.max(0, 1 - sum)]); weights.set(v, out.filter(o => o[1] > 1e-3)); }
  return { F, weights, size, webs: Object.fromEntries(Object.entries(W).map(([k, v]) => [k, Gr.P(v)])) };
}
module.exports = { rigHand, RATIO };
