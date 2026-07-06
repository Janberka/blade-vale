// Blade Vale — shared settlement LAYOUT kernel (Phase 3 of the region service).
//
// A city/capital costs ~75-155ms to build on the client, and profiling shows that cost is PLACEMENT
// (the O(n²) house-collision loop, street-frontage queries, footprint fitting, retry loops), not the
// vertex emission (rebuilding the geometry from arrays is sub-millisecond). So the placement moves to
// the server: this module runs the SAME builders that used to live in game.js, but the four emitters
// (sgBox/sgRoof/sgPrism/sgCone8) RECORD primitives instead of pushing THREE vertices. The client (or
// server) calls settlementLayout() to get a compact primitive list, then the client emits meshes from
// it (game.js sgEmitLayout). One source of truth: the client's own non-SRV path uses this too.
//
// A primitive is a flat array: [op, owner, a,b,c,d,e,f,g, hex, mul]
//   op:    0 box | 1 roof | 2 prism | 3 cone8
//   owner: 0 structure mesh (vertex-coloured) | 1 owner mesh (solid owner material)
//   a..g:  geometry — box: cx,cy,cz,w,h,d,yaw | roof: cx,baseY,cz,w,h,d,yaw | prism/cone8: cx,baseY,cz,rad,h,-,-
//   hex,mul: structure colour SPEC (the client runs sgRgb(hex,mul) — its exact THREE path, so colours
//            stay byte-identical). Owner prims ignore hex/mul (the owner material colours them).
//
// Colours are recorded as [hex, mul] specs, NOT resolved rgb, so the kernel needs no THREE and the
// client reproduces today's colours exactly. Deterministic per (X, Z, tier, seed) + terrain.
// UMD: require('./terra.js') under Node, window.Terra in the browser (loaded before game.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./terra.js'));
  else root.Settle = factory(root.Terra);
})(typeof self !== 'undefined' ? self : this, function (Terra) {

const TAU = Math.PI * 2;
const clamp = Terra.clamp;
const angD = Terra.angD;
const OP_BOX = 0, OP_ROOF = 1, OP_PRISM = 2, OP_CONE8 = 3;

// the exact mulberry32 game.js seeds settlements with (byte-for-byte, so the RNG stream matches)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// biome-driven building palette — same table as game.js settlePalette (hexes only; the client tints)
function settlePalette(b) {
  const n = b.name;
  if (n === 'Desert')                       return { stone: 0xc9a878, stoneDk: 0xb09870, wood: 0x9a7a4a, thatch: 0xc2a96a, daub: 0xd8c89c };
  if (n === 'Forest' || n === 'Taiga')      return { stone: 0x8a8780, stoneDk: 0x6f6a60, wood: 0x563c26, thatch: 0x6f5a36, daub: 0x8f7d5c };
  if (n === 'Tundra' || n === 'Mountains')  return { stone: 0x9a9690, stoneDk: 0x7c786f, wood: 0x6a5a48, thatch: 0x80735f, daub: 0xa8a49c };
  if (n === 'Savanna' || n === 'Beach')     return { stone: 0xa89e88, stoneDk: 0x8a8068, wood: 0x7a5a36, thatch: 0xa89a5a, daub: 0xc2b080 };
  return { stone: 0x9a8f80, stoneDk: 0x7d7468, wood: 0x6b4a2e, thatch: 0x9a7b43, daub: 0xb9a888 };
}
// a colour SPEC, not resolved rgb: [hex, mul]. The client's sgRgb(hex,mul) resolves it identically.
function sgRgb(hex, mul) { return [hex, mul]; }

// ---- the four emitters, as primitive RECORDERS. buf.o = 0 (structure) | 1 (owner); buf.p = prim list.
function sgBox(buf, cx, cy, cz, w, h, d, yaw, spec) { buf.p.push([OP_BOX, buf.o, cx, cy, cz, w, h, d, yaw, spec ? spec[0] : 0, spec ? spec[1] : 0]); }
function sgRoof(buf, cx, baseY, cz, w, h, d, yaw, spec) { buf.p.push([OP_ROOF, buf.o, cx, baseY, cz, w, h, d, yaw, spec ? spec[0] : 0, spec ? spec[1] : 0]); }
function sgPrism(buf, cx, baseY, cz, rad, h, spec) { buf.p.push([OP_PRISM, buf.o, cx, baseY, cz, rad, h, 0, 0, spec ? spec[0] : 0, spec ? spec[1] : 0]); }
function sgCone8(buf, cx, baseY, cz, rad, h, spec) { buf.p.push([OP_CONE8, buf.o, cx, baseY, cz, rad, h, 0, 0, spec ? spec[0] : 0, spec ? spec[1] : 0]); }

// ============================================================================
// The builders below are ported VERBATIM from game.js (the sg* family). The only changes: the four
// emitters above record instead of meshing; sgProbe/isWater/biomeAt/cityGateBearings/cityFlankerCastles/
// settlementStreetPlan come from the kernel instance T0 (P._T0); sgFootprint/angD/clamp from Terra.
// ============================================================================

function sgHouse(P, lx, lz, opts) {
  const { seat, pal, S } = P, r = P.r, big = !!opts.big, mh = P.mh || 1, mw = P.mw || 1;
  const w = ((big ? 2.0 : 0.95) + r() * (big ? 0.8 : 0.6)) * mw, d = w * (0.85 + r() * 0.5), h = ((big ? 1.9 : 0.9) + r() * (big ? 0.6 : 0.5)) * mh;
  const yaw = opts.yaw != null ? opts.yaw : r() * TAU, hw = w / 2, hd = d / 2;
  const c0 = seat(lx - hw, lz - hd), c1 = seat(lx + hw, lz - hd), c2 = seat(lx - hw, lz + hd), c3 = seat(lx + hw, lz + hd);
  const lo = Math.min(c0, c1, c2, c3), hi = Math.max(c0, c1, c2, c3);
  if (hi - lo > 3.5 * mw) return false;
  if (P.builds) P.builds.push({ x: lx, z: lz, r: Math.max(hw, hd) + 0.15 * mw }); // its footprint blocks movement
  const floorY = hi + 0.05, plinthBot = lo - 0.25 * mw;
  sgBox(S, lx, (plinthBot + floorY) / 2, lz, w * 1.05, floorY - plinthBot, d * 1.05, yaw, sgRgb(pal.stoneDk, 0.9 + r() * 0.12));
  sgBox(S, lx, floorY + h / 2, lz, w, h, d, yaw, sgRgb(opts.wallHex || pal.daub, 0.88 + r() * 0.22));
  const roofH = ((big ? 1.0 : 0.66) + r() * 0.3) * mh, roofBuf = opts.roofBuf || S, roofRGB = opts.roofRGB || sgRgb(pal.thatch, 0.88 + r() * 0.2);
  sgRoof(roofBuf, lx, floorY + h, lz, w * 1.18, roofH, d * 1.18, yaw, roofRGB);
  return true;
}
function sgBanner(P, lx, lz) {
  const { seat, pal, ownerRGB, S, O } = P, y = seat(lx, lz), bm = P.street ? 2 : 1, bh = (2.8 + (P.spec.castle ? 1.2 : 0)) * bm;
  sgBox(S, lx, y + bh / 2, lz, 0.13 * bm, bh, 0.13 * bm, 0, sgRgb(pal.wood, 1));
  sgBox(O, lx + 0.48 * bm, y + bh - 0.5 * bm, lz, 0.9 * bm, 0.56 * bm, 0.07 * bm, 0, ownerRGB);
}
function sgFocalFeature(P) {
  const { T, pal, seat, S } = P, y = seat(0, 0), fm = P.street ? 2 : 1, street = (T.cls === 'HILLSIDE' || T.cls === 'RIDGE' || T.cls === 'COASTAL');
  if (street) { sgBox(S, 0, y + 0.9 * fm, 0, 0.16 * fm, 1.8 * fm, 0.16 * fm, 0, sgRgb(pal.wood, 1)); sgBox(S, 0, y + 1.5 * fm, 0, 0.9 * fm, 0.16 * fm, 0.16 * fm, 0, sgRgb(pal.wood, 1)); }
  else { sgPrism(S, 0, y - 0.1, 0, 0.45 * fm, 0.7 * fm, sgRgb(pal.stoneDk, 1)); sgBox(S, 0, y + 0.8 * fm, 0, 0.14 * fm, 0.5 * fm, 0.9 * fm, 0, sgRgb(pal.wood, 1)); }
}
function sgBuildVillage(P) {
  const { r, spec, T, isW, placed } = P;
  const sm = P.street ? 1.5 : 1, om = P.street ? 1.8 : 1, cm = P.street ? 2.2 : 1;
  const R = spec.R, n = spec.houses[0] + (r() * spec.houses[1] | 0);
  sgFocalFeature(P);
  const axis = (P.roadAxis != null) ? P.roadAxis
             : (T.cls === 'RIDGE') ? T.spineAz : T.downhill + Math.PI / 2;
  const ux = Math.cos(axis), uz = Math.sin(axis);
  let made = 0, tries = 0;
  while (made < n && tries < n * 10) {
    tries++; let lx, lz, yaw;
    if (r() < 0.78) {
      const t = (r() * 2 - 1) * R * 0.95 * sm, side = (tries & 1) ? 1 : -1, off = (1.9 + r() * 2.8) * om;
      lx = ux * t + -uz * side * off; lz = uz * t + ux * side * off;
      yaw = axis + (r() - 0.5) * 0.2;
    } else {
      const a = r() * TAU, maxR = Math.max(2.4, R * P.fp(a)) * sm, rd = 1.8 * sm + Math.sqrt(r()) * (maxR - 1.8 * sm);
      lx = Math.cos(a) * rd; lz = Math.sin(a) * rd; yaw = Math.atan2(-lz, -lx);
    }
    const dPerp = Math.abs(lx * uz - lz * ux), dAlong = Math.abs(lx * ux + lz * uz);
    if (dPerp < 1.6 * cm && dAlong < R * 1.25 * sm) continue;
    if (Math.hypot(lx, lz) < 1.6 * cm || isW(lx, lz)) continue;
    if (!placed.every(p => (p.lx - lx) ** 2 + (p.lz - lz) ** 2 > spec.gap * spec.gap)) continue;
    if (sgHouse(P, lx, lz, { yaw })) { placed.push({ lx, lz }); made++; }
  }
  sgBanner(P, -uz * 2.4 * cm + ux * 1.2, ux * 2.4 * cm + uz * 1.2);
}
function sgPlanCastles(P) {
  const { r, spec } = P;
  const n = (spec.castles[0] | 0) + (r() < (spec.castles[1] || 0) ? 1 : 0);
  if (n <= 0) return [];
  const cR = spec.castleR || spec.R * 0.42, big = !!spec.bigKeep;
  const out = [{ cx: 0, cz: 0, cR, big }];
  if (n === 1) return out;
  if (spec.castles[0] === 1) {
    for (let t = 0; t < 6; t++) {
      const a = r() * TAU, d = spec.R * 0.5, cx = Math.cos(a) * d, cz = Math.sin(a) * d;
      if (!P.isW(cx, cz)) { out.push({ cx, cz, cR: cR * 0.85, big: false }); break; }
    }
    return out;
  }
  const gb = P._T0.cityGateBearings(P.T, P.seed, P.X, P.Z);
  for (const c of P._T0.cityFlankerCastles(P.T, P.seed, spec, gb.big)) {
    if (!P.isW(c.cx, c.cz)) out.push({ cx: c.cx, cz: c.cz, cR: c.cR, big: false });
  }
  return out;
}
function sgStreetNear(P, lx, lz) {
  let bd = Infinity, bx = 0, bz = 0, bw = 0;
  for (const stt of P.streets) {
    const pts = stt.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
      let u = ((lx - a.x) * vx + (lz - a.z) * vz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = a.x + vx * u, pz = a.z + vz * u, d = (lx - px) ** 2 + (lz - pz) ** 2;
      if (d < bd) { bd = d; bx = px; bz = pz; bw = stt.w; }
    }
  }
  return { d: Math.sqrt(bd), x: bx, z: bz, w: bw };
}
function sgFillHouses(P) {
  const { r, spec, isW, placed, exclude } = P, mw = P.mw || 1;
  const R = spec.R, n = spec.houses[0] + (r() * spec.houses[1] | 0);
  const inner = Math.max(2.0 * mw, (spec.centerClear || 0) * R);
  const edgePull = P.street ? 1.5 : 0, frontage = 4.6 * mw;
  const blocked = (lx, lz) => exclude.some(e => (e.lx - lx) ** 2 + (e.lz - lz) ** 2 < e.r * e.r);
  let made = 0, tries = 0;
  while (made < n && tries < n * 10) {
    tries++;
    const a = r() * TAU, maxR = Math.max(inner + 1, R * P.fp(a) - edgePull), rd = inner + Math.sqrt(r()) * (maxR - inner), lx = Math.cos(a) * rd, lz = Math.sin(a) * rd;
    if (isW(lx, lz) || blocked(lx, lz)) continue;
    let yaw = Math.atan2(-lz, -lx);
    if (P.streets && P.streets.length) {
      const sn = sgStreetNear(P, lx, lz);
      if (sn.d < sn.w * 0.5 + 0.9 * mw) continue;
      if (sn.d > frontage && r() < 0.5) continue;
      if (sn.d < frontage) yaw = Math.atan2(sn.z - lz, sn.x - lx);
    }
    if (!placed.every(p => (p.lx - lx) ** 2 + (p.lz - lz) ** 2 > spec.gap * spec.gap)) continue;
    if (sgHouse(P, lx, lz, { yaw })) { placed.push({ lx, lz }); made++; }
  }
}
function sgPlanStreets(P) {
  if (!P.spec.castle) return [];
  return P._T0.settlementStreetPlan(P.X, P.Z, P.tier, P.seed)
    .map(st => ({ w: st.w, pts: st.pts.map(pt => ({ x: pt.x - P.X, z: pt.z - P.Z })) }));
}
function sgBuildHold(P) {
  const { spec } = P;
  for (const C of sgPlanCastles(P)) sgBuildCastleAt(P, C);
  P.streets = sgPlanStreets(P);
  sgFillHouses(P);
  if (spec.wall === 'stone') sgCityWall(P);
  else if (spec.wall === 'palisade') sgPalisade(P);
}
function sgWallEnvelope(P, margin, minR) {
  const { placed, fp } = P;
  let Rfit = minR;
  for (const p of placed) { const a = Math.atan2(p.lz, p.lx), f = fp(a); if (f > 0.01) Rfit = Math.max(Rfit, (Math.hypot(p.lx, p.lz) + margin) / f); }
  return Rfit;
}
function sgPalisade(P) {
  const { r, T, pal, seat, S, fp } = P, mh = P.mh || 1, mw = P.mw || 1;
  const Rfit = P.street ? Math.max(3.0, P.spec.R + 1.5 / 0.8) : sgWallEnvelope(P, 1.5, 3.0);
  const N = Math.max(14, Math.round(Rfit * 1.4 * 1.2 * (P.street ? 1.25 : 1))), wood = sgRgb(pal.wood, 1);
  const gateA = P._T0.cityGateBearings(T, P.seed, P.X, P.Z).big[0];
  let prev = null;                                                 // link consecutive posts into a solid run; reset across gaps
  for (let k = 0; k <= N; k++) {
    const a = (k % N) / N * TAU;
    if (Math.abs(((a - gateA + Math.PI) % TAU + TAU) % TAU - Math.PI) < 0.34) { prev = null; continue; }
    const R = Rfit * fp(a), lx = Math.cos(a) * R, lz = Math.sin(a) * R, y = seat(lx, lz);
    if (P.isW(lx, lz)) { prev = null; continue; }
    if (k < N) sgBox(S, lx, y + 0.85 * mh, lz, 0.34 * mw, (1.6 + r() * 0.2) * mh, 0.34 * mw, a, wood);
    if (prev && P.walls) P.walls.push({ ax: prev.lx, az: prev.lz, bx: lx, bz: lz, r: 0.34 * mw }); // the stockade line blocks movement
    prev = { lx, lz };
  }
  for (const sgn of [-0.4, 0.4]) {
    const a2 = gateA + sgn * 0.34, R2 = Rfit * fp(a2), lx = Math.cos(a2) * R2, lz = Math.sin(a2) * R2, y = seat(lx, lz);
    sgPrism(S, lx, y - 0.3, lz, 0.55 * mw, 3.1 * mh + 0.3, sgRgb(pal.wood, 0.85));
    sgCone8(S, lx, y - 0.3 + 3.1 * mh + 0.3, lz, 0.68 * mw, 0.7 * mh, sgRgb(pal.stoneDk, 1));
  }
}
function sgGatehouse(S, lx, lz, ang, seat, wallH, thick, pal, towerAt, mh, mw) {
  mh = mh || 1; mw = mw || 1;
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1), woodD = sgRgb(pal.wood, 0.72);
  const y = seat(lx, lz), doorH = wallH + 1.6 * mh, doorW = 2.8 * mw;
  sgBox(S, lx, y + wallH + 0.7 * mh, lz, doorW + 1.0 * mw, 0.95 * mh, thick * 1.8, ang, stoneDk);
  sgBox(S, lx, y + doorH / 2, lz, doorW, doorH, 0.5 * mw, ang, woodD);
  for (const sgn of [-1, 1]) {
    const t = towerAt(sgn), tx = t[0], tz = t[1], ty = seat(tx, tz), th2 = wallH + 3.8 * mh;
    sgPrism(S, tx, ty - 0.7, tz, 1.34 * mw, th2 + 0.7, stone);
    sgCone8(S, tx, ty - 0.7 + th2 + 0.7, tz, 1.6 * mw, 1.5 * mh, stoneDk);
  }
}
function sgCityWall(P) {
  const { spec, T, pal, seat, S, fp } = P, mh = P.mh || 1, mw = P.mw || 1, tw = P.street ? 1.5 : 1;
  const Rfit = P.street ? Math.max(spec.R * 0.5, spec.R + 2.6 / 0.8) : sgWallEnvelope(P, 2.6, spec.R * 0.5);
  const Rmax = Rfit * 1.4, RA = a => Rfit * fp(a);
  const wallH = ((spec.wallH || 1.7) + 0.4) * mh, thick = 0.7 * mw, N = Math.max(30, Math.round(Rmax * 1.3));
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1), woodD = sgRgb(pal.wood, 0.72);
  const gb = P._T0.cityGateBearings(T, P.seed, P.X, P.Z), gateAngs = gb.big, postAngs = gb.small;
  const nearGate = a => gateAngs.reduce((m, g) => Math.min(m, angD(a, g)), 9);
  const nearPost = a => postAngs.reduce((m, g) => Math.min(m, angD(a, g)), 9);
  const V = [];
  for (let k = 0; k < N; k++) {
    const a = k / N * TAU; let R = RA(a), lx = Math.cos(a) * R, lz = Math.sin(a) * R;
    while (P.isW(lx, lz) && R > RA(a) * 0.45) { R -= 1.2; lx = Math.cos(a) * R; lz = Math.sin(a) * R; }
    V.push({ a, lx, lz, y: seat(lx, lz), R });
  }
  for (let i = 0; i < N; i++) {
    const A = V[i], B = V[(i + 1) % N], am = A.a + (((B.a - A.a) + TAU) % TAU) / 2;
    const gapR = (A.R + B.R) / 2 || 1;
    if (nearGate(am) < 3.4 * mw / gapR || nearPost(am) < 1.35 * mw / gapR) continue;
    const mx = (A.lx + B.lx) / 2, mz = (A.lz + B.lz) / 2;
    if (P.isW(mx, mz)) continue;
    const ang = Math.atan2(-(B.lz - A.lz), B.lx - A.lx), len = Math.hypot(B.lx - A.lx, B.lz - A.lz) + thick;
    const lo = Math.min(A.y, B.y), hi = Math.max(A.y, B.y), top = hi + wallH, bot = lo - 0.9 * mh;
    sgBox(S, mx, (top + bot) / 2, mz, len, top - bot, thick, ang, stone);
    sgBox(S, mx, top + 0.16 * mw, mz, len, 0.3 * mw, thick * 1.15, ang, stoneDk);
    if (P.walls) P.walls.push({ ax: A.lx, az: A.lz, bx: B.lx, bz: B.lz, r: thick * 0.6 }); // the wall line blocks movement (gate arcs are skipped above)
  }
  const TN = Math.max(10, Math.round(Rmax * 0.45));
  for (let k = 0; k < TN; k++) {
    const a = k / TN * TAU, R0 = RA(a);
    if (nearGate(a) < 5.0 * mw / (R0 || 1)) continue;
    let R = R0, lx = Math.cos(a) * R, lz = Math.sin(a) * R;
    while (P.isW(lx, lz) && R > R0 * 0.45) { R -= 1.2; lx = Math.cos(a) * R; lz = Math.sin(a) * R; }
    if (P.isW(lx, lz)) continue;
    const y = seat(lx, lz), th = wallH + 1.0 * mh;
    sgPrism(S, lx, y - 0.7, lz, 0.8 * tw, th + 0.7, stone); sgCone8(S, lx, y - 0.7 + th + 0.7, lz, 0.94 * tw, 0.85 * mh, stoneDk);
  }
  for (const ga of gateAngs) {
    const d = 0.06, ax = Math.cos(ga - d) * RA(ga - d), az = Math.sin(ga - d) * RA(ga - d), bx = Math.cos(ga + d) * RA(ga + d), bz = Math.sin(ga + d) * RA(ga + d);
    const R = RA(ga), lx = Math.cos(ga) * R, lz = Math.sin(ga) * R, ang = Math.atan2(-(bz - az), bx - ax);
    const dt = 2.95 * mw / Math.max(4, R);
    sgGatehouse(S, lx, lz, ang, seat, wallH, thick, pal,
      sgn => { const a2 = ga + sgn * dt, R2 = RA(a2); return [Math.cos(a2) * R2, Math.sin(a2) * R2]; }, mh, mw);
  }
  for (const pa of postAngs) {
    const d = 0.03, ax = Math.cos(pa - d) * RA(pa - d), az = Math.sin(pa - d) * RA(pa - d), bx = Math.cos(pa + d) * RA(pa + d), bz = Math.sin(pa + d) * RA(pa + d);
    const R = RA(pa), lx = Math.cos(pa) * R, lz = Math.sin(pa) * R, y = seat(lx, lz), ang = Math.atan2(-(bz - az), bx - ax);
    sgBox(S, lx, y + wallH * 0.62, lz, 1.6 * mw, 0.55 * mh, thick * 1.5, ang, stoneDk);
    sgBox(S, lx, y + wallH * 0.28, lz, 1.15 * mw, wallH * 0.56, 0.4 * mw, ang, woodD);
    const pd = 1.15 * mw / Math.max(4, R);
    for (const sgn of [-1, 1]) {
      const a2 = pa + sgn * pd, R2 = RA(a2), tx = Math.cos(a2) * R2, tz = Math.sin(a2) * R2, ty = seat(tx, tz);
      sgPrism(S, tx, ty - 0.5, tz, 0.62 * tw, wallH + 1.5 * mh, stone);
      sgCone8(S, tx, ty - 0.5 + wallH + 1.5 * mh, tz, 0.74 * tw, 0.7 * mh, stoneDk);
    }
  }
}
function sgBuildCastleAt(P, C) {
  const { r, spec, T, pal, ownerRGB, O, placed, exclude } = P, mw = P.mw || 1;
  const keep = sgFindKeep(P, C.cx, C.cz, C.cR * 0.3);
  const DROP = 2.2 + (r() - 0.5) * 1.2;
  const NW = Math.max(10, Math.round(C.cR * 2));
  const verts = sgCurtainMarch(P, keep, DROP, NW, C.cR);
  const gates = sgPickGates(verts, P._T0.cityGateBearings(T, P.seed, P.X, P.Z).big[0]);
  sgBuildCurtain(P, verts, gates);
  P._cR = C.cR;
  sgBuildKeep(P, keep, C.big);
  const innerR = Math.min.apply(null, verts.map(v => v.rd)) * 0.72;
  const nb = spec.bailey[0] + (r() * spec.bailey[1] | 0);
  let made = 0, tries = 0;
  while (made < nb && tries < nb * 8) {
    tries++;
    const a = r() * TAU, rd = (0.2 + r() * 0.8) * innerR, lx = keep.lx + Math.cos(a) * rd, lz = keep.lz + Math.sin(a) * rd;
    if (Math.hypot(lx - keep.lx, lz - keep.lz) < 1.8 * mw) continue;
    if (!placed.every(p => (p.lx - lx) ** 2 + (p.lz - lz) ** 2 > spec.gap * spec.gap)) continue;
    const yaw = Math.atan2(keep.lz - lz, keep.lx - lx), hall = (made === 0);
    if (sgHouse(P, lx, lz, hall ? { big: true, roofBuf: O, roofRGB: ownerRGB, wallHex: pal.wood, yaw } : { yaw })) { placed.push({ lx, lz }); made++; }
  }
  for (const gi of gates) sgBanner(P, verts[gi].lx, verts[gi].lz);
  const wallR = Math.max.apply(null, verts.map(v => v.rd));
  exclude.push({ lx: keep.lx, lz: keep.lz, r: wallR + 1.4 * mw });
}
function sgFindKeep(P, cx, cz, searchR) {
  const { seat } = P; cx = cx || 0; cz = cz || 0; searchR = searchR || P.spec.R * 0.2;
  let best = { lx: cx, lz: cz, y: seat(cx, cz) };
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU, lx = cx + Math.cos(a) * searchR, lz = cz + Math.sin(a) * searchR, y = seat(lx, lz); if (y > best.y) best = { lx, lz, y }; }
  return best;
}
function sgCurtainMarch(P, keep, DROP, NW, cR) {
  const { seat, T, r } = P;
  const platY = keep.y - DROP, minR = cR * 0.78, maxR = cR * 1.12, jit = (r() - 0.5) * 0.25;
  const rad = new Array(NW), ang = new Array(NW);
  for (let k = 0; k < NW; k++) {
    const a = k / NW * TAU + jit; ang[k] = a; let rd = minR;
    while (rd < maxR) {
      const wx = keep.lx + Math.cos(a) * rd, wz = keep.lz + Math.sin(a) * rd;
      if (P.isW(wx, wz)) break;
      const y = seat(wx, wz); if (y < platY || y > keep.y + 1.4) break;
      rd += 0.6;
    }
    rad[k] = clamp(rd, minR, maxR);
  }
  let base = rad.reduce((s, v) => s + v, 0) / NW;
  if (T.relief < 0.8) base = (minR + maxR) / 2;
  for (let k = 0; k < NW; k++) rad[k] = clamp(base * 0.6 + rad[k] * 0.4, base * 0.88, base * 1.12);
  if (T.cls === 'RIDGE') for (let k = 0; k < NW; k++) rad[k] = clamp(rad[k] * (1 + 0.3 * Math.abs(Math.cos(ang[k] - T.spineAz))), base * 0.8, base * 1.5);
  const med = new Array(NW);
  for (let k = 0; k < NW; k++) { const a = rad[(k - 1 + NW) % NW], b = rad[k], c = rad[(k + 1) % NW]; med[k] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); }
  for (let k = 0; k < NW; k++) rad[k] = 0.25 * med[(k - 1 + NW) % NW] + 0.5 * med[k] + 0.25 * med[(k + 1) % NW];
  const verts = [];
  for (let k = 0; k < NW; k++) {
    let rd = rad[k], lx = keep.lx + Math.cos(ang[k]) * rd, lz = keep.lz + Math.sin(ang[k]) * rd;
    while (rd > minR * 0.55 && P.isW(lx, lz)) { rd -= 0.6; lx = keep.lx + Math.cos(ang[k]) * rd; lz = keep.lz + Math.sin(ang[k]) * rd; }
    verts.push({ a: ang[k], rd, lx, lz, y: seat(lx, lz) });
  }
  return verts;
}
function sgPickGates(verts, downhill) {
  const N = verts.length;
  let g1 = 0, bd = 1e9;
  for (let i = 0; i < N; i++) { const d = Math.abs(((verts[i].a - downhill + Math.PI) % TAU + TAU) % TAU - Math.PI); if (d < bd) { bd = d; g1 = i; } }
  let g2 = (g1 + (N >> 1)) % N, bestY = 1e9;
  for (let i = 0; i < N; i++) {
    const da = Math.abs(((verts[i].a - verts[g1].a + Math.PI) % TAU + TAU) % TAU - Math.PI);
    if (da < TAU * 0.27) continue;
    if (verts[i].y < bestY) { bestY = verts[i].y; g2 = i; }
  }
  return [g1, g2];
}
function sgBuildCurtain(P, verts, gates) {
  const { pal, S, r, spec } = P, N = verts.length, mh = P.mh || 1, mw = P.mw || 1, tw = P.street ? 1.5 : 1;
  const wallH = spec.wallH * mh, thick = 0.55 * mw;
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1), wood = sgRgb(pal.wood, 1);
  const isGate = i => gates.indexOf(i) >= 0, gateTower = new Set();
  for (const gi of gates) { gateTower.add(gi); gateTower.add((gi + 1) % N); }
  for (let i = 0; i < N; i++) {
    const A = verts[i], B = verts[(i + 1) % N];
    const mx = (A.lx + B.lx) / 2, mz = (A.lz + B.lz) / 2, ang = Math.atan2(-(B.lz - A.lz), B.lx - A.lx), len = Math.hypot(B.lx - A.lx, B.lz - A.lz) + thick * 1.8;
    const lo = Math.min(A.y, B.y), hi = Math.max(A.y, B.y), top = hi + wallH, bot = lo - 0.8 * mh;
    if (isGate(i)) {
      const doorH = wallH + 1.6 * mh, doorW = len * 0.8, doorRGB = sgRgb(pal.wood, 0.72);
      sgBox(S, mx, top + 0.25 * mh, mz, len + thick, 0.95 * mh, thick * 1.7, ang, stoneDk);
      sgBox(S, mx, lo + doorH / 2, mz, doorW, doorH, 0.45 * mw, ang, doorRGB);
      sgBox(S, mx, lo + doorH * 0.30, mz, doorW * 1.03, 0.18 * mw, 0.55 * mw, ang, stoneDk);
      sgBox(S, mx, lo + doorH * 0.70, mz, doorW * 1.03, 0.18 * mw, 0.55 * mw, ang, stoneDk);
      sgBox(S, mx, lo + doorH / 2, mz, 0.12 * mw, doorH * 0.9, 0.6 * mw, ang, stoneDk);
      for (const c of [A, B]) {
        sgPrism(S, c.lx, c.y - 0.5, c.lz, 0.62 * tw, wallH + 2.1 * mh, stone);
        sgCone8(S, c.lx, c.y - 0.5 + wallH + 2.1 * mh, c.lz, 0.74 * tw, 0.7 * mh, stoneDk);
      }
      continue;
    }
    sgBox(S, mx, (top + bot) / 2, mz, len, top - bot, thick, ang, stone);
    sgBox(S, mx, top + 0.16 * mw, mz, len, 0.32 * mw, thick * 1.15, ang, stoneDk);
    if (P.walls) P.walls.push({ ax: A.lx, az: A.lz, bx: B.lx, bz: B.lz, r: thick * 0.6 }); // curtain segment (gate segments skipped above)
  }
  for (let i = 0; i < N; i++) {
    const v = verts[i], gate = gateTower.has(i), th = wallH + ((gate ? 2.2 : 0.9) + r() * 0.4) * mh, rad = (gate ? 1.05 : 0.78) * tw;
    sgPrism(S, v.lx, v.y - 0.7, v.lz, rad, th + 0.7, stone);
    sgCone8(S, v.lx, v.y - 0.7 + th + 0.7, v.lz, rad * 1.18, (gate ? 1.2 : 0.9) * mh, stoneDk);
  }
}
function sgBuildKeep(P, keep, big) {
  const { pal, ownerRGB, S, O, seat } = P, mh = P.mh || 1;
  const kw0 = big ? 3.2 : 2.6;
  const km = P.street ? Math.min(P.mw, ((P._cR || 6) * 0.62) / (kw0 * 0.775)) : 1;
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1);
  const kw = kw0 * km, kh = (big ? 5.0 : 4.0) * mh, hw = kw * 0.75;
  if (P.builds) P.builds.push({ x: keep.lx, z: keep.lz, r: kw * 0.85 }); // the keep is a solid block
  const c = [seat(keep.lx - hw, keep.lz - hw), seat(keep.lx + hw, keep.lz - hw), seat(keep.lx - hw, keep.lz + hw), seat(keep.lx + hw, keep.lz + hw)];
  const lo = Math.min.apply(null, c), hiC = Math.max.apply(null, c), floorY = hiC + 0.05;
  sgBox(S, keep.lx, (lo - 0.3 + floorY) / 2, keep.lz, kw * 1.55, floorY - (lo - 0.3), kw * 1.55, 0, stoneDk);
  if (hiC - lo > 2.5) for (let k = 0; k < 5; k++) { const a = k / 5 * TAU, rr = kw * 0.85; sgBox(S, keep.lx + Math.cos(a) * rr, lo + 0.2, keep.lz + Math.sin(a) * rr, 1.1 * km, 0.9 * km, 1.1 * km, a, stoneDk); }
  sgBox(S, keep.lx, floorY + kh / 2, keep.lz, kw, kh, kw, 0, stone);
  const top = floorY + kh;
  for (let i = -1; i <= 1; i++) for (const az of [-kw * 0.5, kw * 0.5]) { sgBox(S, keep.lx + i * kw * 0.34, top + 0.25 * km, keep.lz + az, kw * 0.2, 0.5 * km, kw * 0.2, 0, stoneDk); sgBox(S, keep.lx + az, top + 0.25 * km, keep.lz + i * kw * 0.34, kw * 0.2, 0.5 * km, kw * 0.2, 0, stoneDk); }
  sgRoof(O, keep.lx, top + 0.05, keep.lz, kw * 0.85, (big ? 1.4 : 1.1) * km, kw * 0.85, 0, ownerRGB);
  const ph = top + (big ? 2.6 : 2.1) * km;
  sgBox(S, keep.lx, top + (ph - top) / 2, keep.lz, 0.15 * km, ph - top, 0.15 * km, 0, sgRgb(pal.wood, 1));
  sgBox(O, keep.lx + 0.5 * km, ph - 0.5 * km, keep.lz, 0.95 * km, 0.6 * km, 0.08 * km, 0, ownerRGB);
}

// ---- the public entry: run the whole layout, return the primitive list + seat height + debug counts.
// T0 = a Terra kernel instance (sgProbe/isWater/biomeAt/cityGateBearings/cityFlankerCastles/
// settlementStreetPlan). opts.street = the client's STREET knob object for the street rung (or null for
// the base miniature the server ships). opts.roadAxis = a village's shared road axis.
function settlementLayout(T0, X, Z, tier, seed, opts) {
  opts = opts || {};
  const SG_SPEC = Terra.SG_SPEC, STREET = opts.street || null, street = !!STREET;
  seed = seed >>> 0;
  const r = mulberry32(seed);
  const spec0 = SG_SPEC[tier] || SG_SPEC.village;
  const spec = street ? Object.assign({}, spec0, {
      houses: [Math.max(3, Math.round(spec0.houses[0] * STREET.countMul)), Math.max(1, Math.round(spec0.houses[1] * STREET.countMul))],
      bailey: spec0.bailey ? [Math.max(1, Math.round(spec0.bailey[0] * 0.5)), Math.max(1, Math.round(spec0.bailey[1] * 0.5))] : undefined,
      gap: spec0.gap * STREET.gapMul }) : spec0;
  const T = T0.sgProbe(X, Z, spec), refY = T.refY;
  const seat = (lx, lz) => T.Y(X + lx, Z + lz) - refY;
  const isW = (lx, lz) => T0.isWater(X + lx, Z + lz);
  const pal = settlePalette(T0.biomeAt(X, Z));
  const prims = [];
  const S = { o: 0, p: prims }, O = { o: 1, p: prims };
  const P = { r, tier, spec, X, Z, refY, T, pal, ownerRGB: sgRgb(0, 1), seat, isW, S, O, placed: [], exclude: [], seed, roadAxis: opts.roadAxis,
              street, mh: street ? STREET.mulH : 1, mw: street ? STREET.mulW : 1, _T0: T0,
              walls: [], builds: [] }; // collision export: wall SEGMENTS (gate gaps absent) + building footprints
  P.fp = Terra.sgFootprint(P);
  if (spec.castle) sgBuildHold(P); else sgBuildVillage(P);
  return { prims, refY, cls: T.cls, street, lbl: spec.lbl, top: spec.top,
           walls: P.walls, builds: P.builds,
           dbg: { buildings: P.placed.length, castles: P.exclude.length, R: spec.R, cls: T.cls } };
}

return { settlementLayout, settlePalette, OP_BOX, OP_ROOF, OP_PRISM, OP_CONE8 };
});
