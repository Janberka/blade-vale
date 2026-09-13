// Real-mesh rig: joint spec -> bones + per-vertex skin weights + team-tint flags. Browser (window.RealSkin) and Node.
(function (root) {
  const NCAPE = 5;   // must match the cape chain in buildHumanoid (NSEG)
  const BONES = [
    ['root', null, 'root', 'waist', 0.06], ['upperBody', 'root', 'waist', 'neck', 0.06], ['head', 'upperBody', 'neck', 'top', 0.04],
    ['hipL', 'root', 'hipL', 'kneeL', 0.05], ['kneeL', 'hipL', 'kneeL', 'ankleL', 0.04],
    ['hipR', 'root', 'hipR', 'kneeR', 0.05], ['kneeR', 'hipR', 'kneeR', 'ankleR', 0.04],
    ['shoulderL', 'upperBody', 'shoulderL', 'elbowL', 0.045], ['elbowL', 'shoulderL', 'elbowL', 'wristL', 0.035], ['handL', 'elbowL', 'wristL', 'tipL', 0.03],
    ['shoulderR', 'upperBody', 'shoulderR', 'elbowR', 0.045], ['elbowR', 'shoulderR', 'elbowR', 'wristR', 0.035], ['handR', 'elbowR', 'wristR', 'tipR', 0.03],
  ];
  const CAPE0 = BONES.length;                       // cape bones follow: indices CAPE0 .. CAPE0+NCAPE-1
  const CHILD = { root: 'upperBody', upperBody: 'head', hipL: 'kneeL', hipR: 'kneeR', shoulderL: 'elbowL', elbowL: 'handL', shoulderR: 'elbowR', elbowR: 'handR' };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const smooth = s => s <= 0 ? 0 : s >= 1 ? 1 : s * s * (3 - 2 * s);
  function bones(spec) {
    const J = spec.joints; return BONES.map(([name, parent, h, t, R], i) => { const head = J[h], tail = J[t]; const d = sub(tail, head), L = Math.hypot(...d); return { name, parent, i, head, tail, dir: d.map(v => v / L), L, R, foot: name.startsWith('knee') }; });
  }
  const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[3] && p[1] >= b[1] && p[1] <= b[4] && p[2] >= b[2] && p[2] <= b[5];
  // positions: flat array in the spec's normalised frame (height 1, facing +Z). Returns 4 bone slots per vertex + a tint flag.
  // The split mirrors the plastic rig's parts by REGION (side + height), not by nearest bone: below the hips a vertex is a leg
  // (which one by x), thigh above the knee and shin below it; between hips and neck it is an arm if it hangs outside the
  // torso's half-width, else torso (root below the waist, upperBody above); above the neck it is the head. Blends are
  // smooth bands around each joint height, so the skin bends instead of tearing.
  function weights(positions, spec) {
    const B = bones(spec), n = positions.length / 3, idx = new Uint16Array(n * 4), w = new Float32Array(n * 4), tint = new Float32Array(n), byName = Object.fromEntries(B.map(b => [b.name, b]));
    const J = spec.joints, capeZ = spec.capeZ == null ? -1 : spec.capeZ, capeTop = spec.capeTop || 0.82, segH = capeTop / NCAPE, tintBoxes = spec.tintBoxes || [];
    const midX = (J.hipL[0] + J.hipR[0]) / 2, torsoHalf = spec.torsoHalf || 0.12, hipY = (J.hipL[1] + J.hipR[1]) / 2, waistY = J.waist[1], neckY = J.neck[1];
    const kneeY = s => J['knee' + s][1], elbowY = s => J['elbow' + s][1], wristY = s => J['wrist' + s][1], shoulderY = s => J['shoulder' + s][1];
    const BL = 0.03;                                                     // half-height of a blend band around a joint
    const two = (v, a, b, wa) => { if (b && wa < 0.5) { const t = a; a = b; b = t; wa = 1 - wa; } idx[v * 4] = byName[a].i; w[v * 4] = wa; if (b && wa < 1) { idx[v * 4 + 1] = byName[b].i; w[v * 4 + 1] = 1 - wa; } };
    const band = (y, at) => smooth((y - (at - BL)) / (2 * BL));          // 0 below the joint band, 1 above it
    for (let v = 0; v < n; v++) {
      const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]], x = p[0], y = p[1];
      if (p[2] < capeZ && y < capeTop) {                                // the cape rides the hinged chain
        const s = (capeTop - y) / segH; let i0 = Math.floor(s), f = s - i0; if (i0 >= NCAPE - 1) { i0 = NCAPE - 1; f = 0; }
        const a = Math.max(0, Math.min(NCAPE - 1, i0)), b = Math.min(NCAPE - 1, a + 1);
        idx[v * 4] = CAPE0 + a; w[v * 4] = 1 - f; idx[v * 4 + 1] = CAPE0 + b; w[v * 4 + 1] = f;
        if (spec.tintCape !== false) tint[v] = 1; continue;
      }
      if (tintBoxes.some(b => inBox(p, b))) tint[v] = 1;
      if (y > neckY - BL) { two(v, 'head', 'upperBody', band(y, neckY)); continue; }
      const sd = x > midX ? 'L' : 'R', off = Math.abs(x - midX), shY = shoulderY(sd);
      const armEdge = y > shY - 0.06 ? torsoHalf * 0.75 : torsoHalf;       // the pauldron shelf belongs to the shoulder
      if (off > armEdge && y < shY + 0.08 && y > wristY(sd) - 0.1) {       // arms (hands hang below the hip line, so arms are tested first)
        const e = elbowY(sd), wr = wristY(sd);
        if (y > e + BL) two(v, 'shoulder' + sd, null, 1);
        else if (y > e - BL) two(v, 'shoulder' + sd, 'elbow' + sd, band(y, e));
        else if (y > wr + BL) two(v, 'elbow' + sd, null, 1);
        else if (y > wr - BL) two(v, 'elbow' + sd, 'hand' + sd, band(y, wr));
        else two(v, 'hand' + sd, null, 1);
        continue;
      }
      if (y < hipY + BL) {                                               // legs: side by x, thigh/shin by the knee height
        const k = kneeY(sd); if (y > hipY - BL) two(v, 'hip' + sd, 'root', 1 - band(y, hipY)); else two(v, 'hip' + sd, 'knee' + sd, band(y, k));
        continue;
      }
      two(v, 'upperBody', 'root', band(y, waistY));                       // torso: upperBody above the waist, root below
    }
    return { idx, w, tint, bones: B, nBones: CAPE0 + NCAPE, CAPE0, NCAPE };
  }
  const triIn = (positions, indices, i, boxes) => { const P = v => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]; return boxes.some(b => inBox(P(indices[i]), b) && inBox(P(indices[i + 1]), b) && inBox(P(indices[i + 2]), b)); };
  // drop triangles that lie wholly inside a cut box [x0,y0,z0,x1,y1,z1] (the knight's own sword)
  function cut(positions, indices, boxes) {
    if (!boxes || !boxes.length) return indices; const keep = [];
    for (let i = 0; i < indices.length; i += 3) if (!triIn(positions, indices, i, boxes)) keep.push(indices[i], indices[i + 1], indices[i + 2]);
    return indices instanceof Uint16Array ? new Uint16Array(keep) : new Uint32Array(keep);
  }
  // lift the triangles inside the boxes out as their own little mesh (re-indexed), positions still in the normalised frame
  function extract(positions, uvs, indices, boxes) {
    const map = new Map(), pos = [], uv = [], idx = [];
    for (let i = 0; i < indices.length; i += 3) if (triIn(positions, indices, i, boxes)) for (let k = 0; k < 3; k++) {
      const v = indices[i + k]; let j = map.get(v); if (j == null) { j = pos.length / 3; map.set(v, j); pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); uv.push(uvs[v * 2], uvs[v * 2 + 1]); } idx.push(j); }
    return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint16Array(idx) };
  }
  // normalise raw model positions: yaw about Y, then height 1 with the feet at y=0 and x/z centred on the bbox
  function normalise(positions, yaw) {
    const n = positions.length / 3, out = new Float32Array(n * 3), c = Math.cos(yaw), s = Math.sin(yaw);
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let v = 0; v < n; v++) { const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]; const rx = x * c + z * s, rz = -x * s + z * c; out[v * 3] = rx; out[v * 3 + 1] = y; out[v * 3 + 2] = rz; for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], out[v * 3 + k]); mx[k] = Math.max(mx[k], out[v * 3 + k]); } }
    const H = mx[1] - mn[1], cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2;
    for (let v = 0; v < n; v++) { out[v * 3] = (out[v * 3] - cx) / H; out[v * 3 + 1] = (out[v * 3 + 1] - mn[1]) / H; out[v * 3 + 2] = (out[v * 3 + 2] - cz) / H; }
    return out;
  }
  // ---- fit to the rig: warp the whole figure so its joints land on the RIG's joints (the rig keeps its proportions,
  // reach and hit heights; the scan keeps its surface). Each vertex rides its bone segment: position along the bone is
  // rescaled to the rig bone's length, the offset around it is rotated onto the rig bone's axis and fattened by `radial`.
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const rotTo = (from, to) => {                     // Rodrigues: rotation taking unit vector `from` onto unit vector `to`
    const v = cross(from, to), c = dot(from, to), s = Math.hypot(...v); if (s < 1e-6) return c > 0 ? (p => p) : (p => [-p[0], -p[1], -p[2]]);
    const k = v.map(x => x / s), K = 1 - c;
    return p => { const kd = dot(k, p), kc = cross(k, p); return [p[0] * c + kc[0] * s + k[0] * kd * K, p[1] * c + kc[1] * s + k[1] * kd * K, p[2] * c + kc[2] * s + k[2] * kd * K]; };
  };
  const RADIAL = { root: 1.45, upperBody: 1.45, head: 1.1, hipL: 1.3, hipR: 1.3, kneeL: 1.25, kneeR: 1.25, shoulderL: 1.35, shoulderR: 1.35, elbowL: 1.3, elbowR: 1.3, handL: 1.2, handR: 1.2 };
  function fitToRig(N, spec, rig) {
    const sk = weights(N, spec), Bs = sk.bones, Br = bones({ joints: rig.joints }), n = N.length / 3, out = new Float32Array(n * 3);
    const T = Bs.map((b, i) => { const r = Br[i], rot = rotTo(b.dir, r.dir), rad = (rig.radial && rig.radial[b.name]) || RADIAL[b.name] || 1;
      return p => { const d = sub(p, b.head), t = dot(d, b.dir), q = rot([d[0] - b.dir[0] * t, d[1] - b.dir[1] * t, d[2] - b.dir[2] * t]); const tt = t * r.L / b.L; return [r.head[0] + r.dir[0] * tt + q[0] * rad, r.head[1] + r.dir[1] * tt + q[1] * rad, r.head[2] + r.dir[2] * tt + q[2] * rad]; }; });
    for (let v = 0; v < n; v++) {
      const p = [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]]; let acc = [0, 0, 0], ws = 0;
      for (let k = 0; k < 2; k++) { let b = sk.idx[v * 4 + k], w = sk.w[v * 4 + k]; if (!w) continue; const isCape = b >= CAPE0; if (isCape) b = 0;   // the cape rides the root's warp, less fattened
        let q = T[b](p); if (isCape) { const cr = (rig.capeRadial || 1.1) / (RADIAL.root); const c0 = T[0]([Bs[0].head[0], p[1], Bs[0].head[2]]); q = [c0[0] + (q[0] - c0[0]) * cr, q[1], c0[2] + (q[2] - c0[2]) * cr]; }
        acc[0] += q[0] * w; acc[1] += q[1] * w; acc[2] += q[2] * w; ws += w; }
      if (!ws) { acc = p; ws = 1; } out[v * 3] = acc[0] / ws; out[v * 3 + 1] = acc[1] / ws; out[v * 3 + 2] = acc[2] / ws;
    }
    // the cape is re-weighted on the RIG's chain: capeTop / segH in rig space
    const capeTop = rig.capeTop, segH = capeTop / NCAPE;
    for (let v = 0; v < n; v++) if (sk.idx[v * 4] >= CAPE0) { const y = out[v * 3 + 1]; const s = (capeTop - y) / segH; let i0 = Math.floor(s), f = s - i0; if (i0 < 0) { i0 = 0; f = 0; } if (i0 >= NCAPE - 1) { i0 = NCAPE - 1; f = 0; }
      sk.idx[v * 4] = CAPE0 + i0; sk.w[v * 4] = 1 - f; sk.idx[v * 4 + 1] = CAPE0 + Math.min(NCAPE - 1, i0 + 1); sk.w[v * 4 + 1] = f; }
    return { pos: out, idx: sk.idx, w: sk.w, tint: sk.tint, nBones: sk.nBones, CAPE0 };
  }
  const api = { BONES, NCAPE, CAPE0, bones, weights, cut, extract, normalise, fitToRig };
  if (typeof module !== 'undefined') module.exports = api; else root.RealSkin = api;
})(typeof window !== 'undefined' ? window : globalThis);
