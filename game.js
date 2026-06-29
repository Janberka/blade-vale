/* Blade Vale — a low poly hack & slash with AI sword-fighting enemies.
   Built on Three.js. Everything (characters, world, FX) is procedural geometry. */

(() => {
'use strict';

const THREE_OK = typeof THREE !== 'undefined';
if (!THREE_OK) { alert('Failed to load Three.js'); return; }

// ---------- Quality tiers (cheap Android first-class) ----------
// low: no dynamic shadows, no torch lights, 1x pixels, no AA
// medium: 1024 shadows, 4 torch lights, 1.5x pixels
// high: 2048 shadows, all torch lights, up to 2x pixels
let qualityTier = (() => {
  try {
    const saved = localStorage.getItem('bv-quality');
    if (saved === 'low' || saved === 'medium' || saved === 'high') return saved;
  } catch (e) { /* storage unavailable */ }
  const mobile = /Android|Mobi|iPhone|iPad/i.test(navigator.userAgent);
  const lowMem = navigator.deviceMemory && navigator.deviceMemory <= 4;
  return (mobile || lowMem) ? 'low' : 'high';
})();
const TIERS = {
  low:    { pixelRatio: 1,   shadows: false, shadowSize: 0,    torchLights: 0,  aa: false },
  medium: { pixelRatio: 1.5, shadows: true,  shadowSize: 1024, torchLights: 4,  aa: true },
  high:   { pixelRatio: Math.min(window.devicePixelRatio, 2), shadows: true, shadowSize: 2048, torchLights: 10, aa: true },
};

// ---------- Renderer / Scene / Camera ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: TIERS[qualityTier].aa, powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(TIERS[qualityTier].pixelRatio);
renderer.shadowMap.enabled = TIERS[qualityTier].shadows;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft costs ~2x on tile GPUs for little gain here

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc6e8);
scene.fog = new THREE.Fog(0x9fc6e8, 45, 95);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);

// ---------- Lighting ----------
const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x4a5a3a, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d6, 1.15);
sun.position.set(30, 50, 20);
sun.castShadow = TIERS[qualityTier].shadows;
sun.shadow.mapSize.set(TIERS[qualityTier].shadowSize || 1024, TIERS[qualityTier].shadowSize || 1024);
const sc = sun.shadow.camera;
sc.near = 1; sc.far = 140; sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60;
scene.add(sun);
scene.add(new THREE.AmbientLight(0x404a5a, 0.4));

// ---------- Helpers ----------
// The battleground GROWS as the war escalates: each wave widens the field.
const ARENA_BASE = 38, ARENA_MAX = 280;
let ARENA = ARENA_BASE; // current half-size of the playable square
// Battles open with a wide no-man's-land: the two hosts start FRONT_GAP apart and
// ADVANCE at a march (MARCH_PACE of full speed) until contact — so the lines take
// tens of seconds to close instead of clashing instantly. Tunable.
const FRONT_GAP = 200;     // z-distance from your line to the enemy line at the start (~33s march for swordsmen)
const MARCH_PACE = 0.42;   // melee advance at this fraction of full speed while > ~26u from contact
const ZONE_LEASH = 7;      // a zone-holder engages foes within this margin of its rectangle, then returns
// per-group pace: RUSH sprints to the objective at full speed; MARCH (default, and every enemy)
// advances at MARCH_PACE until ~26u from contact, then breaks into the closing charge.
function paceFactor(f, dist) { return f.pace === 'rush' ? 1 : (dist > 26 ? MARCH_PACE : 1); }
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
// stepFighter-local scratch (never passed across function calls; separation()
// owns tmpV/sepV, so these must stay distinct — see the aliasing postmortems)
const sfA = new THREE.Vector3();
const sfB = new THREE.Vector3();
const _crouchBox = new THREE.Box3(); // measures the crouched body to keep feet on the ground
let elapsed = 0;   // gameplay time (slows during hit-stop)
let rtNow = 0;     // wall-clock seconds, drives camera shake even during hit-stop

// Game feel: trauma-based camera shake + hit-stop freeze frames.
let trauma = 0;    // 0..1, decays each frame; shake amplitude = trauma^2
let hitstop = 0;   // seconds of slow-motion remaining
function addShake(amount) { trauma = Math.min(1, trauma + amount); }
function addHitstop(t) { hitstop = Math.max(hitstop, t); }

// Debug / verification hooks (also lets us freeze a frame to inspect poses).
const BV = { freeze: false };
window.BV = BV;

// ---------- Combat feel tuning (single surface for all the juice) ----------
const FEEL = {
  // impact: shake/hit-stop scale with hit weight (damage+combo); kicks punch the camera
  hitShake: 0.22, hitStop: 0.05, killShake: 0.35, killStop: 0.09,
  fovPunchHit: 1.6, fovPunchKill: 4.5, kickHit: 0.16, kickKill: 0.5,
  camKickDecay: 11, fovDecay: 7, trailLife: 0.14,
  // weighty offense (RMB heavy): wide cleave, big radial knockback, group stagger
  heavyDmg: 48, heavyDur: 0.78, heavyRange: 4.6, heavyArc: -0.15, heavyKnock: 14, heavyStamina: 24,
  heavyPoiseDmg: 60, lightPoiseDmg: 20, poiseBase: 20, poiseFromHp: 0.3, // maxPoise = base + hp*fromHp
  staggerDur: 1.5, poiseRegen: 22,
  // finisher / execution on a staggered or near-dead foe
  finisherHpFrac: 0.2, finisherStop: 0.24,
};
const AUDIO = { master: 0.55, swingVol: 0.32, hitVol: 0.7, clangVol: 0.6, killVol: 0.95,
                footVol: 0.18, bowVol: 0.5, maxDist: 30, maxVoices: 14 };

// Directional camera kick + FOV punch — decay in updateCamera (real dt, so a kill
// still snaps even while hit-stop crawls gameplay). Reset to base when settled.
const CAM_BASE_FOV = 55;
const camKick = new THREE.Vector3();
const _killDir = new THREE.Vector3();
let fovPunch = 0;
function addKick(dir, amount) { camKick.addScaledVector(dir, amount); }
function addFovPunch(amount) { fovPunch = Math.min(fovPunch + amount, 12); }

// ---------- SFX: fully synthesized WebAudio (no asset files) ----------
// One context + a shared noise buffer; every helper is a short procedural one-shot.
// No-ops until init() runs on a user gesture (browsers require one) and no-ops
// headlessly (ctx stays null) — so BV.advance draws no extra RNG and stays deterministic.
const SFX = {
  ctx: null, master: null, noise: null, muted: false, _voices: 0, _voiceFrame: -1,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = AUDIO.master; master.connect(ctx.destination);
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // 1s white noise, reused
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.ctx = ctx; this.master = master; this.noise = buf;
    } catch (e) { /* audio unavailable — stay silent, never throw into the game loop */ }
  },
  // per-frame voice cap so a 40-fighter clash can't storm the mixer
  _budget() {
    if (frameNo !== this._voiceFrame) { this._voiceFrame = frameNo; this._voices = 0; }
    if (this._voices >= AUDIO.maxVoices) return false;
    this._voices++; return true;
  },
  // gate + distance-attenuate toward the player (no worldPos → full volume, e.g. the player)
  _ready(vol, worldPos) {
    if (!this.ctx || this.muted) return 0;
    let g = vol;
    if (worldPos) g *= clamp(1 - Math.hypot(worldPos.x - player.pos.x, worldPos.z - player.pos.z) / AUDIO.maxDist, 0, 1);
    if (g < 0.01 || !this._budget()) return 0;
    return g;
  },
  _env(node, g, attack, dur) {
    const t = this.ctx.currentTime, gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(g, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(gain); gain.connect(this.master);
  },
  _tone(type, f0, f1, attack, dur, g, detune = 0) {
    const t = this.ctx.currentTime, o = this.ctx.createOscillator();
    o.type = type; o.detune.value = detune; o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    this._env(o, g, attack, dur); o.start(t); o.stop(t + dur + 0.02);
  },
  _noise(type, f0, f1, Q, attack, dur, g) {
    const t = this.ctx.currentTime, s = this.ctx.createBufferSource(), bq = this.ctx.createBiquadFilter();
    s.buffer = this.noise; bq.type = type; bq.Q.value = Q; bq.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    s.connect(bq); this._env(bq, g, attack, dur); s.start(t); s.stop(t + dur + 0.02);
  },
  swing(p) { const g = this._ready(AUDIO.swingVol, p); if (g) this._noise('bandpass', 1800, 500, 0.9, 0.008, 0.18, g); },
  clang(p, heavy) {
    const g = this._ready(AUDIO.clangVol * (heavy ? 1.3 : 1), p); if (!g) return;
    const b = heavy ? 520 : 700;
    this._tone('square', b, b * 0.96, 0.002, 0.22, g * 0.5);
    this._tone('triangle', b * 1.5, b * 1.4, 0.002, 0.18, g * 0.4, 8);
    this._tone('square', b * 2.01, b * 1.9, 0.002, 0.14, g * 0.25, -6);
    this._noise('bandpass', 4200, 2600, 3, 0.001, 0.09, g * 0.5);
  },
  hit(p, armored) {
    const g = this._ready(AUDIO.hitVol, p); if (!g) return;
    if (armored) { this._tone('triangle', 320, 150, 0.002, 0.12, g * 0.6); this._noise('bandpass', 2600, 900, 2, 0.001, 0.1, g * 0.5); }
    else { this._tone('sine', 180, 70, 0.003, 0.16, g * 0.9); this._noise('lowpass', 900, 300, 0.8, 0.001, 0.09, g * 0.5); }
  },
  kill(p) {
    const g = this._ready(AUDIO.killVol, p); if (!g) return;
    this._tone('sine', 150, 45, 0.004, 0.3, g);
    this._noise('lowpass', 1400, 200, 0.7, 0.001, 0.22, g * 0.7);
  },
  foot(p) { const g = this._ready(AUDIO.footVol, p); if (g) this._noise('lowpass', 380, 120, 0.6, 0.001, 0.08, g); },
  bow(p) { const g = this._ready(AUDIO.bowVol, p); if (!g) return; this._noise('bandpass', 2400, 700, 1.2, 0.001, 0.12, g * 0.6); this._tone('triangle', 600, 180, 0.002, 0.1, g * 0.4); },
};

// Geometry cache: identical shapes share one GPU buffer instead of allocating
// per character/effect. Cached resources are flagged so disposeGroup skips them.
const geoCache = new Map();
function cachedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); g.userData.cached = true; geoCache.set(key, g); }
  return g;
}

// Phong instead of Standard: PBR fragments are what melt cheap Android GPUs,
// and flat-shaded low-poly looks near-identical under Phong.
// Shared (cached) materials are reused across everyone and are tint-proof;
// per-character tintable materials pass shared:false.
const matCache = new Map();
function mat(color, opts = {}) {
  const make = () => new THREE.MeshPhongMaterial({
    color, flatShading: opts.smooth ? false : true,
    shininess: opts.metal ? 28 : 5,
    specular: opts.metal ? 0x555555 : 0x0a0a0a,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveI ?? 1,
  });
  if (opts.shared === false) return make();
  const key = color + '|' + (opts.smooth ? 1 : 0) + (opts.metal ? 'm' : '') +
              '|' + (opts.emissive ?? 0) + '|' + (opts.emissiveI ?? 1);
  let m = matCache.get(key);
  if (!m) {
    m = make();
    m.userData.cached = true;
    m.userData.noTint = true; // shared materials must never take a hit-flash tint
    matCache.set(key, m);
  }
  return m;
}
function boxMesh(w, h, d, m) {
  const me = new THREE.Mesh(cachedGeo('box:' + w + ',' + h + ',' + d, () => new THREE.BoxGeometry(w, h, d)), m);
  me.castShadow = true; me.receiveShadow = true;
  return me;
}
// Rounded capsule as a SINGLE lathed mesh (1 draw call instead of 3).
// Centered at origin, axis along Y.
function softCapsule(radius, length, m) {
  const geo = cachedGeo('capsule:' + radius + ',' + length, () => {
    const pts = [];
    const half = length / 2, STEPS = 4;
    for (let i = 0; i <= STEPS; i++) { // bottom hemisphere profile
      const a = -Math.PI / 2 + (i / STEPS) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.cos(a) * radius, -half + Math.sin(a) * radius));
    }
    for (let i = 0; i <= STEPS; i++) { // top hemisphere profile
      const a = (i / STEPS) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.cos(a) * radius, half + Math.sin(a) * radius));
    }
    return new THREE.LatheGeometry(pts, 10);
  });
  const me = new THREE.Mesh(geo, m);
  me.castShadow = true;
  return me;
}
function sphereMesh(r, m, wseg = 12, hseg = 9) {
  const me = new THREE.Mesh(cachedGeo('sph:' + r + ',' + wseg + ',' + hseg,
    () => new THREE.SphereGeometry(r, wseg, hseg)), m);
  me.castShadow = true; me.receiveShadow = true;
  return me;
}

// ---------- World ----------
let arenaPad = null;
let ground = null; // hoisted: biomes recolor it per region when entering battle
let backdropRange = null, backdropSnow = null; // distant mountain/hill silhouette ringing the field, recolored per biome
function buildWorld() {
  // Low-poly ground: built ONCE at the MAXIMUM size — only the playable
  // bound (pad, treeline, torches, confine walls) moves as the arena grows.
  const seg = 64;
  const geo = new THREE.PlaneGeometry(ARENA_MAX * 2 + 24, ARENA_MAX * 2 + 24, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const edge = Math.max(Math.abs(x), Math.abs(z));
    // gentle rolling relief across the playable field — fighters stand at y≈0, so this stays
    // shallow enough that feet never visibly float, but the ground no longer reads as a pancake.
    let h = (Math.sin(x * 0.06) * Math.cos(z * 0.05) + Math.sin(x * 0.13 + 2.1) * Math.cos(z * 0.11 + 0.7) * 0.5) * 0.55
          + (Math.random() - 0.5) * 0.3;
    if (edge > ARENA_MAX) h += (edge - ARENA_MAX) * 1.4 + Math.sin(x * 0.05) * Math.cos(z * 0.05) * (edge - ARENA_MAX) * 0.3; // foothills climb to the mountain ring
    pos.setY(i, h);
  }
  geo.computeVertexNormals();
  ground = new THREE.Mesh(geo, mat(0x6f9e54, { shared: false }));
  ground.receiveShadow = true;
  scene.add(ground);

  // A dirt arena pad in the middle — scaled up as the battleground widens.
  arenaPad = new THREE.Mesh(new THREE.CircleGeometry(ARENA_BASE - 2, 48), mat(0x8a6a45, { shared: false }));
  arenaPad.rotateX(-Math.PI / 2); arenaPad.position.y = 0.05; arenaPad.receiveShadow = true;
  scene.add(arenaPad);

  // Scatter trees + rocks as INSTANCED meshes whose matrices are re-laid out
  // around the CURRENT arena edge every time the battleground grows.
  const trees = [], rocks = [];
  for (let i = 0; i < 70; i++) {
    const a = Math.random() * Math.PI * 2;
    if (Math.random() < 0.6) {
      trees.push({ a, off: rand(-6, 16), s: rand(0.8, 1.4), rot: Math.random() * Math.PI, trunkH: rand(2, 3.4), green: Math.random() < 0.5 });
    } else {
      rocks.push({ a, off: rand(-6, 16), inner: false, fx: 0, fz: 0, rad: rand(0.6, 1.8), ys: rand(0.6, 1), rx: Math.random(), ry: Math.random(), rz: Math.random() });
    }
  }
  for (let i = 0; i < 6; i++) {
    rocks.push({ a: 0, off: 0, inner: true, fx: rand(-1, 1), fz: rand(-1, 1), rad: rand(0.6, 1.8), ys: rand(0.6, 1), rx: Math.random(), ry: Math.random(), rz: Math.random() });
  }
  // Rock piles — clusters of boulders that read as cairns / scree heaps. Some ring the field,
  // some sit inside it as cover; each pile shares an anchor so it travels with the arena as it grows.
  for (let p = 0; p < 16; p++) {
    const inner = Math.random() < 0.5;
    const a = Math.random() * Math.PI * 2, off = rand(-4, 18);
    const fx = rand(-1, 1), fz = rand(-1, 1);
    const members = 3 + (Math.random() * 4 | 0);
    for (let k = 0; k < members; k++) {
      const big = k === 0;
      rocks.push({ a, off, inner, fx, fz,
        lx: rand(-2.4, 2.4), lz: rand(-2.4, 2.4),
        rad: big ? rand(1.6, 2.6) : rand(0.6, 1.6), ys: rand(0.55, 1.05),
        rx: Math.random(), ry: Math.random(), rz: Math.random() });
    }
  }
  buildInstancedDeco(trees, rocks);
  buildBackdropRange();

  // Ring of torches for atmosphere — repositioned outward as the field grows.
  for (let i = 0; i < 10; i++) {
    scene.add(makeTorch((i / 10) * Math.PI * 2));
  }
}

// One InstancedMesh per part kind: trunks, canopy cones (per-instance color), rocks.
// Descriptors are kept so refreshDecoMatrices() can re-lay everything out
// around the current arena edge whenever the battleground grows.
const decoState = { trees: null, rocks: null, trunks: null, cones: null, rockMesh: null };
function buildInstancedDeco(trees, rocks) {
  decoState.trees = trees;
  decoState.rocks = rocks;
  decoState.trunks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 1, 0.6), mat(0x6b4a2e), trees.length);
  decoState.cones = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1.8, 6), mat(0x3f7a3a), trees.length * 3);
  decoState.rockMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), mat(0x8d8f95), rocks.length);
  const darkGreen = new THREE.Color(0x3f7a3a), lightGreen = new THREE.Color(0x4f8a3f);
  trees.forEach((t, i) => {
    for (let k = 0; k < 3; k++) decoState.cones.setColorAt(i * 3 + k, t.green ? darkGreen : lightGreen);
  });
  if (decoState.cones.instanceColor) decoState.cones.instanceColor.needsUpdate = true;
  for (const im of [decoState.trunks, decoState.cones, decoState.rockMesh]) {
    im.castShadow = true; im.receiveShadow = true;
    scene.add(im);
  }
  refreshDecoMatrices();
}
function refreshDecoMatrices() {
  const { trees, rocks, trunks, cones, rockMesh } = decoState;
  if (!trees) return;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const v = new THREE.Vector3(), sc = new THREE.Vector3();
  trees.forEach((t, i) => {
    const x = Math.cos(t.a) * (ARENA + t.off), z = Math.sin(t.a) * (ARENA + t.off);
    q.setFromEuler(e.set(0, t.rot, 0));
    m4.compose(v.set(x, t.trunkH * t.s / 2, z), q, sc.set(t.s, t.trunkH * t.s, t.s));
    trunks.setMatrixAt(i, m4);
    for (let k = 0; k < 3; k++) {
      const cs = (2.6 - k * 0.6) * t.s;
      m4.compose(v.set(x, (t.trunkH + k * 1.1) * t.s, z), q, sc.set(cs, t.s, cs));
      cones.setMatrixAt(i * 3 + k, m4);
    }
  });
  rocks.forEach((r, i) => {
    const x = (r.inner ? r.fx * (ARENA - 8) : Math.cos(r.a) * (ARENA + r.off)) + (r.lx || 0);
    const z = (r.inner ? r.fz * (ARENA - 8) : Math.sin(r.a) * (ARENA + r.off)) + (r.lz || 0);
    q.setFromEuler(e.set(r.rx, r.ry, r.rz));
    m4.compose(v.set(x, r.rad * 0.5, z), q, sc.set(r.rad, r.rad * r.ys, r.rad));
    rockMesh.setMatrixAt(i, m4);
  });
  trunks.instanceMatrix.needsUpdate = true;
  cones.instanceMatrix.needsUpdate = true;
  rockMesh.instanceMatrix.needsUpdate = true;
}
// ---------- Backdrop range: a low-poly mountain/hill silhouette ringing the battlefield ----------
// Two concentric rings of jittered, overlapping pyramidal peaks well beyond the largest play field,
// plus snow caps that toggle on for cold/high biomes. Recolored by applyBiome() to suit each land.
function buildBackdropRange() {
  if (backdropRange) return;
  const peaks = [];
  const R0 = ARENA_MAX + 24;
  const rings = [{ r: R0, n: 48, hl: 30, hh: 72, wl: 22, wh: 46 }, { r: R0 + 64, n: 36, hl: 48, hh: 116, wl: 30, wh: 64 }];
  for (const ring of rings) for (let i = 0; i < ring.n; i++) {
    const a = (i / ring.n) * Math.PI * 2 + rand(-0.05, 0.05);
    const rr = ring.r + rand(-20, 20);
    peaks.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, h: rand(ring.hl, ring.hh), w: rand(ring.wl, ring.wh), rot: rand(0, Math.PI), tilt: rand(-0.08, 0.08) });
  }
  const peakMat = mat(0x83868c, { shared: false });   // recolored per biome
  const snowMat = mat(0xeef3f7, { shared: false });
  const geo = () => new THREE.ConeGeometry(1, 1, 5);   // 5-sided = chunky low-poly peak
  backdropRange = new THREE.InstancedMesh(cachedGeo('bdpeak', geo), peakMat, peaks.length);
  backdropSnow = new THREE.InstancedMesh(cachedGeo('bdpeak', geo), snowMat, peaks.length);
  backdropRange.userData.mat = peakMat; backdropSnow.userData.mat = snowMat;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
  peaks.forEach((p, i) => {
    q.setFromEuler(e.set(p.tilt, p.rot, 0));
    m4.compose(v.set(p.x, p.h / 2 - 2, p.z), q, s.set(p.w, p.h, p.w)); backdropRange.setMatrixAt(i, m4);
    const sh = p.h * 0.34, sw = p.w * 0.34;            // snow cap rides the top third
    m4.compose(v.set(p.x, p.h - sh / 2 - 2, p.z), q, s.set(sw, sh, sw)); backdropSnow.setMatrixAt(i, m4);
  });
  backdropRange.castShadow = backdropRange.receiveShadow = false; // far outside the shadow cascade
  backdropSnow.castShadow = backdropSnow.receiveShadow = false;
  backdropRange.visible = backdropSnow.visible = false;           // off until a battle turns the dressing on
  scene.add(backdropRange); scene.add(backdropSnow);
}
// the silhouette's stone tone + whether its peaks are snowbound, chosen to suit the biome
function backdropTone(b) {
  switch (b) {
    case B.MOUNTAIN: return { rock: 0x83868c, snow: true };
    case B.TUNDRA:   return { rock: 0x9aa6b0, snow: true };
    case B.TAIGA:    return { rock: 0x46604f, snow: true };
    case B.FOREST:   return { rock: 0x355f33, snow: false };
    case B.GRASS:    return { rock: 0x4f7a3c, snow: false };
    case B.SAVANNA:  return { rock: 0x8a8147, snow: false };
    case B.DESERT:   return { rock: 0xbf9a5c, snow: false };
    case B.BEACH:    return { rock: 0xa9a276, snow: false };
    default:         return { rock: 0x83868c, snow: true };
  }
}
function makeTorch(angle) {
  const g = new THREE.Group();
  const pole = boxMesh(0.25, 3, 0.25, mat(0x4a3520));
  pole.position.y = 1.5; g.add(pole);
  const flame = new THREE.Mesh(cachedGeo('flame', () => new THREE.IcosahedronGeometry(0.45, 0)),
    mat(0xff7b2e, { emissive: 0xff5a1e, emissiveI: 2.2 }));
  flame.position.y = 3.2; g.add(flame);
  // point lights are a per-pixel tax on mobile — only some torches get one
  if (torches.length < TIERS[qualityTier].torchLights) {
    const light = new THREE.PointLight(0xff7b3e, 1.4, 16, 2);
    light.position.y = 3.2; g.add(light);
    g.userData.light = light;
  }
  g.userData.flame = flame;
  g.userData.angle = angle; // ring position recomputed when the arena grows
  g.position.set(Math.cos(angle) * (ARENA - 1), 0, Math.sin(angle) * (ARENA - 1));
  torches.push(g);
  return g;
}

// ---------- The battleground widens as the war escalates ----------
function applyArenaSize(size) {
  ARENA = size;
  // dirt pad scales out from its base radius
  if (arenaPad) arenaPad.scale.setScalar((size - 2) / (ARENA_BASE - 2));
  // torch ring slides outward
  for (const t of torches) {
    const a = t.userData.angle;
    t.position.set(Math.cos(a) * (size - 1), 0, Math.sin(a) * (size - 1));
  }
  // treeline and rocks re-ring the new edge
  refreshDecoMatrices();
  // fog and shadow coverage keep pace with the field
  scene.fog.near = Math.max(45, size * 1.2);
  scene.fog.far = Math.max(95, size * 2.5);
  camera.far = Math.max(300, size * 4);
  camera.updateProjectionMatrix();
  const ext = size + 14;
  const sc2 = sun.shadow.camera;
  sc2.left = -ext; sc2.right = ext; sc2.top = ext; sc2.bottom = -ext;
  sc2.updateProjectionMatrix();
}
const torches = [];

// ---------- Humanoid builder ----------
// Anatomical low-poly rig:
//   root
//   ├─ hipL/hipR (pivot) ─ thigh ─ kneeL/kneeR (pivot) ─ shin + foot
//   ├─ pelvis
//   └─ upperBody (pivot at waist: lean/twist)
//       ├─ torso, shoulder pads, neck, head
//       └─ shoulderL/R (pivot) ─ upper arm ─ elbowL/R (pivot) ─ forearm ─ hand (+ sword R)
function buildHumanoid(palette, scale = 1, weapon = 'sword') {
  const g = new THREE.Group();
  const casters = []; // the few big parts that are worth a shadow-pass draw
  // per-character copies: these take hit-flash tints, so they can't be shared
  const skin = mat(palette.skin, { smooth: true, shared: false });
  const cloth = mat(palette.cloth, { smooth: true, shared: false });
  const accent = mat(palette.accent, { smooth: true, shared: false });

  // --- Legs (attached to root so torso lean doesn't drag them) ---
  const hipY = 1.34;
  function makeLeg(side) {
    const hip = new THREE.Group(); hip.position.set(0.27 * side, hipY, 0);
    const thigh = softCapsule(0.21, 0.42, accent); thigh.position.y = -0.3; hip.add(thigh);
    const knee = new THREE.Group(); knee.position.y = -0.64; hip.add(knee);
    const shin = softCapsule(0.165, 0.4, accent); shin.position.y = -0.28; knee.add(shin);
    casters.push(thigh, shin);
    const foot = sphereMesh(0.21, cloth);
    foot.position.set(0, -0.6, 0.13); foot.scale.set(1, 0.5, 1.55); knee.add(foot);
    g.add(hip);
    return { hip, knee };
  }
  // facing +Z, the anatomical RIGHT side is -X (forward × up); sides were mirrored before
  const legL = makeLeg(1), legR = makeLeg(-1);

  // --- Pelvis ---
  const pelvis = sphereMesh(0.4, accent, 14, 10);
  pelvis.position.y = 1.42; pelvis.scale.set(1.12, 0.72, 0.85); g.add(pelvis);

  // --- Upper body (pivots at the waist for lean / twist) ---
  const upperBody = new THREE.Group(); upperBody.position.y = 1.55; g.add(upperBody);

  const torso = softCapsule(0.46, 0.55, cloth);
  torso.position.y = 0.45; torso.scale.set(1.05, 1, 0.76);
  upperBody.add(torso);

  // Neck + round head
  const neck = softCapsule(0.13, 0.12, skin); neck.position.y = 1.12; upperBody.add(neck);
  const head = sphereMesh(0.42, skin, 16, 12);
  head.position.y = 1.42; upperBody.add(head);
  const eyeM = mat(0x141414, { smooth: true, rough: 0.35 });
  for (const ex of [-0.16, 0.16]) {
    const e = sphereMesh(0.075, eyeM, 8, 6);
    e.position.set(ex, 1.47, 0.36); e.scale.z = 0.55; upperBody.add(e);
  }

  // --- Arms: shoulder pivot → upper arm → elbow pivot → forearm → hand ---
  function makeArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.58 * side, 0.95, 0);
    // deltoid pad rides the shoulder joint
    const pad = sphereMesh(0.225, cloth, 10, 8);
    pad.position.set(0.04 * side, -0.02, 0); shoulder.add(pad);
    const upper = softCapsule(0.155, 0.32, skin);
    upper.position.y = -0.32; shoulder.add(upper);
    const elbow = new THREE.Group(); elbow.position.y = -0.58; shoulder.add(elbow);
    const fore = softCapsule(0.13, 0.3, skin);
    fore.position.y = -0.25; elbow.add(fore);
    const hand = new THREE.Group(); hand.position.y = -0.5; elbow.add(hand);
    const fist = sphereMesh(0.155, skin, 10, 8); hand.add(fist);
    upperBody.add(shoulder);
    return { shoulder, elbow, hand };
  }
  const armL = makeArm(1);
  const armR = makeArm(-1); // sword arm on the true anatomical right

  // --- Held weapon ---
  // sword in the right fist (grip at the hand origin); blade perpendicular to the forearm
  function makeSword(longer) {
    const bladeLen = 1.35 * (longer ? 1.45 : 1);
    const g = new THREE.Group();
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, longer ? 0.46 : 0.34, 8), mat(0x241812, { smooth: true }));
    g.add(grip);
    const pommel = sphereMesh(0.07, mat(0x6a5630, { metal: 0.5, rough: 0.4, smooth: true }), 8, 6);
    pommel.position.y = longer ? -0.27 : -0.21; g.add(pommel);
    const guard = boxMesh(longer ? 0.52 : 0.42, 0.07, 0.14, mat(0x3a2a18, { metal: 0.4 }));
    guard.position.y = 0.2; g.add(guard);
    const blade = boxMesh(longer ? 0.1 : 0.085, bladeLen, 0.2, mat(palette.blade ?? 0xd9e2ec, { metal: 0.6, rough: 0.3 }));
    blade.position.y = 0.2 + bladeLen / 2 + 0.02; g.add(blade);
    casters.push(blade);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.22, 4), blade.material);
    tip.position.y = 0.2 + bladeLen + 0.13; tip.rotation.y = Math.PI / 4; tip.castShadow = true; g.add(tip);
    g.rotation.x = SWORD_BASE_X;
    armR.hand.add(g);
    return g;
  }
  function makeBow() {
    const b = new THREE.Group();
    const arcLen = Math.PI * 0.78;
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.045, 6, 12, arcLen), mat(0x6b4a2e, { smooth: true }));
    arc.castShadow = true;
    arc.rotation.z = Math.PI / 2 - arcLen / 2;
    b.add(arc);
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2 * 0.85 * Math.sin(arcLen / 2), 4), mat(0xddddcc, { smooth: true }));
    string.position.x = 0.85 * Math.cos(arcLen / 2);
    b.add(string);
    b.rotation.x = Math.PI / 2;
    b.userData.fixedGrip = true; // the wrist channel must not spin the bow
    armL.hand.add(b);
    return b;
  }

  let held, bow = null;
  if (weapon === 'bow') {
    // archers (and the player) carry a bow AND a sheathed sidearm sword
    bow = makeBow();           // left hand, shown by default
    held = makeSword(false);   // right hand, hidden until drawn for melee
    held.visible = false;
  } else if (weapon === 'rock') {
    held = new THREE.Group();
    held.add(sphereMesh(0.26, mat(0x8d8f95, { rough: 1 }), 6, 5));
    held.userData.fixedGrip = true;
    armR.hand.add(held);
  } else {
    held = makeSword(weapon === 'longsword');
  }
  const sword = held;

  // shadow budget: only big silhouette parts cast, characters never receive —
  // PCF blur erases sub-0.2-unit features, so the ground shadow looks identical
  // while the shadow pass shrinks ~4x and character fragments skip PCF sampling
  g.traverse(c => { if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; } });
  casters.push(torso, head, pelvis);
  for (const c of casters) c.castShadow = true;

  g.scale.setScalar(scale);
  return {
    group: g,
    parts: {
      torso, head, upperBody, sword, bow,
      shoulderL: armL.shoulder, elbowL: armL.elbow,
      shoulderR: armR.shoulder, elbowR: armR.elbow,
      hipL: legL.hip, kneeL: legL.knee,
      hipR: legR.hip, kneeR: legR.knee,
    },
  };
}
const SWORD_BASE_X = 1.4;

// ---------- Pose system ----------
// Named guard positions. Characters SNAP between these with short eased blends —
// windup telegraphs, strikes whip through, recovery settles back to guard.
// Channels: shoulder R/L (x,z), elbows (x), waist lean (x) & twist (y), wrist pitch.
const POSES = {
  relax:      { shRx:  0.08, shRz:  0.18, elR: -0.25, shLx:  0.08, shLz: -0.18, elL: -0.25, leanX: 0,     twistY: 0,     wristX: -0.5 },
  guard:      { shRx: -0.55, shRz: -0.05, elR: -1.35, shLx: -0.45, shLz:  0.30, elL: -0.70, leanX: 0.06,  twistY: -0.30, wristX: 1.15 },
  windupR:    { shRx: -1.90, shRz:  0.95, elR: -1.60, shLx: -0.45, shLz:  0.40, elL: -0.60, leanX: -0.12, twistY:  0.65, wristX: -0.20 },
  strikeR:    { shRx: -0.55, shRz: -1.05, elR: -0.30, shLx:  0.15, shLz:  0.45, elL: -0.35, leanX: 0.30,  twistY: -0.65, wristX: 0.90 },
  windupL:    { shRx: -1.60, shRz: -1.00, elR: -2.00, shLx: -0.30, shLz:  0.35, elL: -0.50, leanX: -0.12, twistY: -0.55, wristX: -0.10 },
  strikeL:    { shRx: -0.60, shRz:  1.00, elR: -0.35, shLx: -0.35, shLz:  0.40, elL: -0.60, leanX: 0.28,  twistY:  0.60, wristX: 0.90 },
  windupOver: { shRx: -2.75, shRz:  0.20, elR: -1.30, shLx: -1.30, shLz:  0.45, elL: -1.10, leanX: -0.22, twistY:  0.10, wristX: 0.30 },
  strikeOver: { shRx: -0.35, shRz:  0.05, elR: -0.55, shLx: -0.25, shLz:  0.40, elL: -0.60, leanX: 0.50,  twistY: -0.05, wristX: 1.60 },
  // heavy: a big two-hand overhead — deep wind-up coil, then a full-body downward cleave
  windupHeavy:{ shRx: -3.05, shRz:  0.05, elR: -0.95, shLx: -2.20, shLz:  0.30, elL: -0.95, leanX: -0.40, twistY:  0.05, wristX: 0.10 },
  strikeHeavy:{ shRx:  0.05, shRz:  0.00, elR: -0.30, shLx:  0.00, shLz:  0.30, elL: -0.35, leanX: 0.70,  twistY:  0.00, wristX: 1.95 },
  hurt:       { shRx: -0.30, shRz:  0.55, elR: -1.00, shLx: -0.50, shLz:  0.60, elL: -1.20, leanX: -0.28, twistY:  0.15, wristX: 0 },
  block:      { shRx: -1.15, shRz: -0.45, elR: -1.30, shLx: -1.15, shLz:  0.50, elL: -1.45, leanX: -0.08, twistY: -0.20, wristX: 0.55 },
  // archery: bow arm (left) extended at the target, string hand drawn to the cheek
  aimBow:     { shRx: -1.35, shRz:  0.30, elR: -2.20, shLx: -1.50, shLz:  0.10, elL: -0.12, leanX: 0,     twistY:  0.70, wristX: 0 },
  looseBow:   { shRx: -1.25, shRz:  0.60, elR: -0.50, shLx: -1.50, shLz:  0.10, elL: -0.12, leanX: 0.04,  twistY:  0.60, wristX: 0 },
};

// Attack moves: which guards to snap between. Combos cycle through them.
const MOVES = {
  slashR: { windup: 'windupR',     strike: 'strikeR',     overhead: false },
  slashL: { windup: 'windupL',     strike: 'strikeL',     overhead: false },
  chop:   { windup: 'windupOver',  strike: 'strikeOver',  overhead: true },
  heavy:  { windup: 'windupHeavy', strike: 'strikeHeavy', overhead: true },
};
const PLAYER_COMBO = ['slashR', 'slashL', 'chop'];

const easeOut = t => 1 - Math.pow(1 - t, 3);

function makeAnimator(parts) {
  const cur = { ...POSES.relax };
  return { parts, cur, start: { ...cur }, target: POSES.relax, t: 1, dur: 1, name: 'relax' };
}
function setPose(anim, name, dur = 0.15) {
  if (anim.name === name) return;
  anim.name = name;
  anim.start = { ...anim.cur };
  anim.target = POSES[name];
  anim.t = 0; anim.dur = Math.max(dur, 0.001);
}
function updateAnimator(anim, dt) {
  anim.t = Math.min(anim.t + dt, anim.dur);
  const k = easeOut(anim.t / anim.dur);
  const c = anim.cur, p = anim.parts;
  for (const key in anim.target) c[key] = lerp(anim.start[key] ?? 0, anim.target[key], k);
  // z-channels and twist are authored for a +X sword arm; the rig mirrors to -X,
  // so outward/twist directions negate here
  p.shoulderR.rotation.set(c.shRx, 0, -c.shRz);
  p.elbowR.rotation.x = c.elR;
  p.shoulderL.rotation.set(c.shLx, 0, -c.shLz);
  p.elbowL.rotation.x = c.elL;
  p.upperBody.rotation.set(c.leanX, -c.twistY, 0);
  if (!p.sword.userData.fixedGrip) p.sword.rotation.x = SWORD_BASE_X + c.wristX;
}

// Procedural legs: walk cycle with knee flex during the swing-through.
function walkLegs(parts, phase, amp = 0.55, crouch = 0) {
  const a = Math.sin(phase) * amp;
  parts.hipL.rotation.x = a - 0.6 * crouch;             // crouch folds into the
  parts.hipR.rotation.x = -a - 0.6 * crouch;            // target, not stacked on
  parts.kneeL.rotation.x = Math.max(0, -Math.cos(phase)) * amp * 1.3 + 1.55 * crouch;
  parts.kneeR.rotation.x = Math.max(0,  Math.cos(phase)) * amp * 1.3 + 1.55 * crouch;
}
// Settle legs into a stance: fencing stagger when fighting, neutral otherwise.
function restLegs(parts, dt, fighting, crouch = 0) {
  // weapon-side (right) foot leads, matching the guard's shoulder twist
  const t = fighting
    ? { hipL: 0.28, hipR: -0.22, kneeL: 0.38, kneeR: 0.30 }
    : { hipL: 0, hipR: 0, kneeL: 0.05, kneeR: 0.05 };
  const hipOff = -0.6 * crouch, kneeOff = 1.55 * crouch; // stable crouch-inclusive target
  const s = clamp(dt * 8, 0, 1);
  parts.hipL.rotation.x = lerp(parts.hipL.rotation.x, t.hipL + hipOff, s);
  parts.hipR.rotation.x = lerp(parts.hipR.rotation.x, t.hipR + hipOff, s);
  parts.kneeL.rotation.x = lerp(parts.kneeL.rotation.x, t.kneeL + kneeOff, s);
  parts.kneeR.rotation.x = lerp(parts.kneeR.rotation.x, t.kneeR + kneeOff, s);
}

// ---------- Floating health bar (billboard) ----------
const barMats = new Map(); // shared per color, never tinted/disposed
function barMat(color) {
  let m = barMats.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    m.userData.cached = true; m.userData.noTint = true;
    barMats.set(color, m);
  }
  return m;
}
function makeHealthBar(color = 0xff4d4d) {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(cachedGeo('bar-bg', () => new THREE.PlaneGeometry(1.6, 0.22)), barMat(0x111111));
  const fill = new THREE.Mesh(cachedGeo('bar-fill', () => new THREE.PlaneGeometry(1.5, 0.14)), barMat(color));
  fill.position.z = 0.01;
  g.add(bg); g.add(fill);
  g.userData.fill = fill;
  g.visible = false; // only shown once the fighter has taken damage
  return g;
}

// ---------- Hit spark FX (pooled — zero allocation per hit after warmup) ----------
const sparks = [];
const sparkPool = [];
const sparkMats = new Map(); // shared MeshBasicMaterial per color
function spawnSparks(pos, color = 0xffdf6b, count = 8) {
  let m = sparkMats.get(color);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); sparkMats.set(color, m); }
  for (let i = 0; i < count; i++) {
    let s = sparkPool.pop();
    if (!s) {
      s = new THREE.Mesh(cachedGeo('spark', () => new THREE.TetrahedronGeometry(0.12)), m);
      s.userData.vel = new THREE.Vector3();
    }
    s.material = m;
    s.position.copy(pos);
    s.scale.setScalar(1);
    s.visible = true;
    s.userData.vel.set(rand(-1, 1), rand(0.4, 1.6), rand(-1, 1)).normalize().multiplyScalar(rand(4, 9));
    s.userData.life = 0.45;
    scene.add(s);
    sparks.push(s);
  }
}
function updateSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.userData.life -= dt;
    s.userData.vel.y -= 22 * dt;
    s.position.addScaledVector(s.userData.vel, dt);
    s.rotation.x += dt * 8; s.rotation.y += dt * 6;
    const k = clamp(s.userData.life / 0.45, 0, 1);
    s.scale.setScalar(k);
    if (s.userData.life <= 0) {
      scene.remove(s);
      s.visible = false;
      sparkPool.push(s);
      sparks.splice(i, 1);
    }
  }
}

// ---------- Slash arc FX (sells the cut) ----------
const arcs = [];
function spawnSlashArc(pos, facing, mv, scale = 1, color = 0xfff2c8) {
  const group = new THREE.Group();
  group.position.copy(pos);
  group.rotation.y = facing;
  const len = 1.9;
  const geoKey = 'arc:' + scale + ':' + (mv.overhead ? 1 : 0);
  const m = new THREE.Mesh(
    cachedGeo(geoKey, () => new THREE.RingGeometry(0.85 * scale, 2.3 * scale, 14, 1,
      (mv.overhead ? 0.7 : -Math.PI / 2) - len / 2, len)),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  if (mv.overhead) { m.rotation.y = -Math.PI / 2; group.position.y += 1.1; }
  else { m.rotation.x = -Math.PI / 2; group.position.y += 1.35; }
  group.add(m);
  group.userData = { life: 0.16, mat: m.material };
  scene.add(group);
  arcs.push(group);
}
function updateArcs(dt) {
  for (let i = arcs.length - 1; i >= 0; i--) {
    const a = arcs[i];
    a.userData.life -= dt;
    const k = clamp(a.userData.life / 0.16, 0, 1);
    a.userData.mat.opacity = 0.85 * k;
    a.scale.setScalar(1 + (1 - k) * 0.3);
    if (a.userData.life <= 0) {
      scene.remove(a);
      disposeGroup(a); // cache-aware: shared ring geometry survives
      arcs.splice(i, 1);
    }
  }
}

// ---------- Blade trail FX (pooled ribbon that follows the real sword tip) ----------
// A short triangle strip between the blade's root and tip, sampled over the strike
// window. Pooled (mesh+geometry+material reused) so a fast combo allocates nothing.
const trails = [];
const trailPool = [];
const TRAIL_SEGS = 10; // ribbon quads → (SEGS+1) root/tip sample pairs
const _trailTip = new THREE.Vector3(), _trailRoot = new THREE.Vector3();
function spawnTrail(fighter, tipY, color = 0xfff2c8) {
  let tr = trailPool.pop();
  if (!tr) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((TRAIL_SEGS + 1) * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < TRAIL_SEGS; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending }); // glows as a light streak, not a flat decal
    const mesh = new THREE.Mesh(geo, m); mesh.frustumCulled = false;
    tr = { mesh, mat: m, geo, pts: [] };
  }
  tr.mat.color.setHex(color); tr.fighter = fighter; tr.tipY = tipY;
  tr.life = FEEL.trailLife; tr.pts.length = 0; tr.mesh.visible = true;
  scene.add(tr.mesh); trails.push(tr);
}
function updateTrails(dt) {
  for (let i = trails.length - 1; i >= 0; i--) {
    const tr = trails[i];
    tr.life -= dt;
    const sw = tr.fighter && tr.fighter.parts && tr.fighter.parts.sword;
    if (tr.life > 0 && sw && sw.visible) {
      sw.updateWorldMatrix(true, false); // sample fresh, not last frame's matrix
      _trailRoot.set(0, 0.25, 0); sw.localToWorld(_trailRoot);
      _trailTip.set(0, tr.tipY, 0); sw.localToWorld(_trailTip);
      tr.pts.push(_trailRoot.x, _trailRoot.y, _trailRoot.z, _trailTip.x, _trailTip.y, _trailTip.z);
      while (tr.pts.length > (TRAIL_SEGS + 1) * 6) tr.pts.splice(0, 6); // keep the newest samples
    }
    const have = tr.pts.length / 6;
    const pos = tr.geo.attributes.position.array;
    for (let s = 0; s <= TRAIL_SEGS; s++) {
      let idx = have - 1 - (TRAIL_SEGS - s); // newest sample aligns to the end of the strip
      idx = clamp(idx, 0, Math.max(0, have - 1));
      const o = idx * 6, b = s * 6;
      for (let j = 0; j < 6; j++) pos[b + j] = tr.pts[o + j] || 0;
    }
    tr.geo.attributes.position.needsUpdate = true;
    tr.mat.opacity = (have >= 2 ? 0.75 : 0) * clamp(tr.life / FEEL.trailLife, 0, 1);
    if (tr.life <= 0) {
      scene.remove(tr.mesh); tr.mesh.visible = false; tr.fighter = null;
      trailPool.push(tr); trails.splice(i, 1);
    }
  }
}

// ---------- Projectiles (arrows + thrown rocks) ----------
const projectiles = [];
function spawnProjectile(shooter, target, R) {
  // release from shoulder height, aim at the target's UPPER BODY (chest/head)
  const from = shooter.pos.clone(); from.y = 1.8 * shooter.def.scale;
  const tScale = target.def ? target.def.scale : 1;
  const to = target.pos.clone(); to.y = 2.1 * tScale;
  const flight = Math.max(0.05, from.distanceTo(to) / R.projSpeed);
  // lead a moving target — long shots need real prediction to stay threatening
  if (target.vel) { to.x += target.vel.x * flight * 0.75; to.z += target.vel.z * flight * 0.75; }
  const vel = to.sub(from).normalize().multiplyScalar(R.projSpeed);
  let gravity = 2; // arrows sag slightly
  let mesh;
  if (R.kind === 'rock') {
    gravity = 18;
    mesh = new THREE.Mesh(cachedGeo('proj-rock', () => new THREE.IcosahedronGeometry(0.24, 0)), mat(0x8d8f95));
  } else {
    mesh = new THREE.Group();
    const shaft = new THREE.Mesh(cachedGeo('proj-shaft', () => new THREE.CylinderGeometry(0.03, 0.03, 0.85, 5)), mat(0x7a5a36, { smooth: true }));
    shaft.rotation.x = Math.PI / 2; mesh.add(shaft); // align along local +Z for lookAt
    const head = new THREE.Mesh(cachedGeo('proj-head', () => new THREE.ConeGeometry(0.06, 0.16, 4)), mat(0xb9c2cc, { metal: 0.5 }));
    head.rotation.x = Math.PI / 2; head.position.z = 0.5; mesh.add(head);
  }
  // ballistic elevation: loft the shot so gravity drop lands it on the mark,
  // not in the dirt short of it — essential for long-range arrows
  vel.y += gravity * flight * 0.5;
  mesh.castShadow = true;
  mesh.position.copy(from);
  scene.add(mesh);
  projectiles.push({ mesh, vel, gravity, team: shooter.team, dmg: shooter.def.dmg, kind: R.kind, life: 3, ownerChar: shooter.char || null, ownerTrait: shooter.heroTrait || null });
}
function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.vel.y -= p.gravity * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    if (p.kind === 'rock') { p.mesh.rotation.x += dt * 9; p.mesh.rotation.z += dt * 7; }
    else { tmpV.copy(p.mesh.position).add(p.vel); p.mesh.lookAt(tmpV); }
    p.life -= dt;
    let dead = p.life <= 0 || p.mesh.position.y <= 0.05 ||
               Math.abs(p.mesh.position.x) > ARENA + 2 || Math.abs(p.mesh.position.z) > ARENA + 2;
    if (!dead) {
      // hit the first opposing combatant in the path
      const foes = p.team === 'ally' ? enemies : opposingPlayerSide;
      for (const v of foes) {
        if (!v.alive) continue;
        const s = v.def ? v.def.scale : 1;
        // a crouching player is short enough that upper-body shots pass overhead
        const top = (v === player && player.crouching) ? 1.4 : 2.6 * s;
        const dx = v.pos.x - p.mesh.position.x, dz = v.pos.z - p.mesh.position.z;
        if (dx * dx + dz * dz < 0.7 * 0.7 * s * s && p.mesh.position.y < top) {
          damageCombatant(v, p.dmg, { pos: p.mesh.position.clone(), char: p.ownerChar, heroTrait: p.ownerTrait });
          spawnSparks(p.mesh.position.clone(), p.kind === 'rock' ? 0xb0a890 : 0xffe08a, 4);
          dead = true;
          break;
        }
      }
    }
    if (dead) {
      scene.remove(p.mesh);
      disposeGroup(p.mesh); // cache-aware: shared geos/materials survive
      projectiles.splice(i, 1);
    }
  }
}

// Damage number popups (pooled sprites — canvas + texture reused, capped count).
const popups = [];
const popupPool = [];
const MAX_POPUPS = 8;
function obtainPopup() {
  let p = popupPool.pop();
  if (p) return p;
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  spr.scale.set(1.5, 0.75, 1);
  return { c, ctx, tex, spr };
}
function spawnPopup(pos, text, color = '#ffdf6b') {
  if (popups.length >= MAX_POPUPS) { // recycle the oldest rather than grow
    const old = popups.shift();
    scene.remove(old.spr); popupPool.push(old);
  }
  const p = obtainPopup();
  const { ctx } = p;
  ctx.clearRect(0, 0, 128, 64);
  ctx.font = 'bold 48px Trebuchet MS, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 6; ctx.strokeStyle = '#000'; ctx.strokeText(text, 64, 32);
  ctx.fillStyle = color; ctx.fillText(text, 64, 32);
  p.tex.needsUpdate = true;
  p.spr.position.copy(pos); p.spr.position.y += 1;
  p.spr.material.opacity = 1;
  p.life = 0.9;
  scene.add(p.spr);
  popups.push(p);
}
function updatePopups(dt) {
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    p.life -= dt;
    p.spr.position.y += 2.2 * dt;
    p.spr.material.opacity = clamp(p.life / 0.9, 0, 1);
    if (p.life <= 0) {
      scene.remove(p.spr);
      popupPool.push(p);
      popups.splice(i, 1);
    }
  }
}

// ---------- Player ----------
const player = {
  obj: null, parts: null, anim: null,
  pos: new THREE.Vector3(0, 0, 0),
  vel: new THREE.Vector3(),
  facing: 0,           // yaw radians
  hp: 100, maxHp: 100,
  stamina: 100, maxStam: 100,
  speed: 9,
  // attack
  attacking: false, attackT: 0, attackDur: 0.46, attackPhase: 0, move: 'slashR',
  atkScale: 1, aimTarget: null, hitDone: false, combo: 0, comboTimer: 0, queued: false, cooldown: 0,
  heavy: false, // RMB committed heavy swing (wide cleave + knockback)
  // dodge
  rolling: false, rollT: 0, rollDur: 0.45, rollDir: new THREE.Vector3(), iFrames: false,
  // block
  blocking: false,
  // crouch: duck under projectiles + sneak
  crouching: false, crouchT: 0,
  // weapon: 'sword' (melee) or 'bow' (ranged) — toggled with F
  weapon: 'sword', shooting: false, shootT: 0, shootDur: 0.5, shotReleased: false,
  hurtFlash: 0,
  walkPhase: 0, lastStepIdx: 0,
  alive: true,
};
const PLAYER_BOW_DMG = 30;
const PLAYER_BOW_RANGED = { kind: 'arrow', projSpeed: 60 };

function setPlayerWeaponVisual() {
  const p = player.parts;
  if (p.sword) p.sword.visible = player.weapon === 'sword';
  if (p.bow) p.bow.visible = player.weapon === 'bow';
}
function initPlayer() {
  // built with the dual rig (sword in right hand, bow in left) so the player can swap
  const h = buildHumanoid({ skin: 0xe0a878, cloth: 0x2f5fae, accent: 0x223a66, blade: 0xeaf2ff }, 1, 'bow');
  player.obj = h.group; player.parts = h.parts;
  player.anim = makeAnimator(h.parts);
  updateAnimator(player.anim, 0.05); // apply the relax pose for the menu
  scene.add(player.obj);
  player.pos.set(0, 0, 0);
  player.maxHp = 100 + (player.char ? player.char.hpBonus : 0); // earned vigor raises your ceiling
  player.hp = player.maxHp; player.stamina = player.maxStam;
  player.facing = 0; player.alive = true;
  player.attacking = false; player.rolling = false; player.combo = 0;
  player.comboTimer = 0; player.queued = false; player.cooldown = 0;
  player.hurtFlash = 0; player.iFrames = false; player.atkScale = 1;
  player.walkPhase = 0; player.lastStepIdx = 0; player.heavy = false;
  player.aimTarget = null;
  player.crouching = false; player.crouchT = 0;
  player.weapon = 'sword'; player.shooting = false; player.shotReleased = false;
  setPlayerWeaponVisual();
  hideCombo();
}

// ---------- Enemies ----------
const enemies = [];
// Stats are tuned to PLAYER PARITY: the hero moves ~8.8 u/s effective and swings
// every ~0.4s for 26+; everyone on the field now fights in that same weight class.
// (NPC effective speed ≈ def.speed * 6 / 7.13 given the velocity damping.)
const ENEMY_TYPES = {
  grunt:  { hp: 70,  speed: 9.5, dmg: 16, range: 2.3, atkWind: 0.34, atkRec: 0.38, cd: 0.55, scale: 1.0, score: 150,
            moves: ['slashR', 'chop'],
            palette: { skin: 0x8a9a5b, cloth: 0x6b2222, accent: 0x401414, blade: 0xb9c2cc } },
  brute:  { hp: 160, speed: 7.5, dmg: 30, range: 2.8, atkWind: 0.5,  atkRec: 0.55, cd: 0.9, scale: 1.4, score: 350,
            moves: ['chop'],
            palette: { skin: 0x7a6a4b, cloth: 0x3a2a4a, accent: 0x241433, blade: 0x9aa4ae } },
  rogue:  { hp: 55,  speed: 11,  dmg: 14, range: 2.1, atkWind: 0.26, atkRec: 0.30, cd: 0.4, scale: 0.9, score: 200,
            moves: ['slashR', 'slashL'],
            palette: { skin: 0xc09a6b, cloth: 0x244a3a, accent: 0x143326, blade: 0xd9e2ec } },
  longsword: { hp: 95, speed: 8.5, dmg: 24, range: 3.2, atkWind: 0.42, atkRec: 0.5, cd: 0.8, scale: 1.1, score: 250,
            moves: ['slashR', 'slashL'], weapon: 'longsword',
            palette: { skin: 0x9a8a6b, cloth: 0x3a3f4a, accent: 0x23272e, blade: 0xc8d4e0 } },
  archer: { hp: 45,  speed: 9.5, dmg: 12, range: 2.0, atkWind: 0.5,  atkRec: 0.3, cd: 1.4, scale: 0.95, score: 200,
            moves: ['slashR'], weapon: 'bow',
            ranged: { kind: 'arrow', range: 70, minRange: 12, projSpeed: 52 },
            palette: { skin: 0xc09a6b, cloth: 0x5a4a23, accent: 0x32230f, blade: 0xb9c2cc } },
  thrower: { hp: 95, speed: 7.5, dmg: 18, range: 2.4, atkWind: 0.55, atkRec: 0.4, cd: 1.9, scale: 1.25, score: 220,
            moves: ['chop'], weapon: 'rock',
            ranged: { kind: 'rock', range: 12, minRange: 4, projSpeed: 14 },
            palette: { skin: 0x97876b, cloth: 0x59442e, accent: 0x33271a, blade: 0x8d8f95 } },
};

// ---------- Enemy heroes: named champions who lead the host ----------
// Each has a story, a signature trait that bends the rules, and a bounty.
//   guardbreaker — their blows pierce a raised guard
//   juggernaut   — never staggers, barely shoved
//   duelist      — blinding attack tempo
//   swift        — runs faster than you
//   deadeye      — lethal, fast, long-flying projectiles
const HEROES = [
  { name: 'Varg the Red-Handed', base: 'grunt', trait: 'guardbreaker',
    story: 'He burned the mill at Eastmere with the millers still inside. Shields mean nothing to him.',
    mult: { hp: 5, dmg: 1.6, speed: 1.05, cd: 0.8 }, scale: 1.35,
    palette: { skin: 0x9a5a4a, cloth: 0x7a1414, accent: 0x2a0a0a, blade: 0xd0c8c0 } },
  { name: 'The Pale Knight', base: 'longsword', trait: 'juggernaut',
    story: 'No one has seen his face. The few who tried describe only the cold. He does not stagger. He does not stop.',
    mult: { hp: 6, dmg: 1.5, speed: 0.95, cd: 0.85 }, scale: 1.3,
    palette: { skin: 0xd8d8e0, cloth: 0xc9cfdb, accent: 0x8a93a6, blade: 0xeaf2ff } },
  { name: 'Old Maren', base: 'grunt', trait: 'duelist',
    story: 'She taught half the marauder host to hold a sword. The other half learned by surviving her.',
    mult: { hp: 4, dmg: 1.5, speed: 1.1, cd: 0.45, atkWind: 0.7 }, scale: 1.2,
    palette: { skin: 0xc8b8a0, cloth: 0x4a5040, accent: 0x23281e, blade: 0xeaf2ff } },
  { name: 'Brakka Two-Stones', base: 'thrower', trait: 'deadeye',
    story: 'She felled a knight at sixty paces. The second stone was for his horse.',
    mult: { hp: 4, dmg: 1.5, speed: 1.05, cd: 0.6, projSpeed: 1.5, range: 1.3 }, scale: 1.4,
    palette: { skin: 0xb08a5a, cloth: 0x8a6a2a, accent: 0x4a3a14, blade: 0x8d8f95 } },
  { name: 'Finch the Collector', base: 'rogue', trait: 'swift',
    story: 'Small, quick, and owed money by every cutthroat in the host. He always collects.',
    mult: { hp: 4, dmg: 1.5, speed: 1.25, cd: 0.5 }, scale: 1.05,
    palette: { skin: 0xd0a880, cloth: 0x2a1a3a, accent: 0x14081f, blade: 0xd9e2ec } },
  { name: 'Ulfric Ironjaw', base: 'brute', trait: 'guardbreaker',
    story: 'He bit through a shield rim at the sack of Harrow. Your guard is just slower food.',
    mult: { hp: 4.5, dmg: 1.5, speed: 1.1, cd: 0.75 }, scale: 1.25,
    palette: { skin: 0x8a8a86, cloth: 0x5a3a28, accent: 0x2e1d14, blade: 0xb9c2cc } },
];
let heroDeck = [], heroIdx = 0;
function shuffleHeroDeck() {
  heroDeck = HEROES.slice();
  for (let i = heroDeck.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [heroDeck[i], heroDeck[j]] = [heroDeck[j], heroDeck[i]];
  }
  heroIdx = 0;
}
function nextHero() { return heroDeck[heroIdx++ % heroDeck.length]; }

function makeNameSprite(text) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 38px Trebuchet MS, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 7; ctx.strokeStyle = '#000'; ctx.strokeText(text, 256, 32);
  ctx.fillStyle = '#ffd34d'; ctx.fillText(text, 256, 32);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
  spr.scale.set(4.8, 0.6, 1);
  return spr;
}

function spawnEnemy(type, x, z, hero, char = null) {
  let def = ENEMY_TYPES[type];
  if (hero) {
    const m = hero.mult;
    def = { ...def, palette: hero.palette, scale: def.scale * hero.scale,
      hp: Math.round(def.hp * m.hp), dmg: Math.round(def.dmg * m.dmg),
      speed: def.speed * (m.speed || 1), cd: def.cd * (m.cd || 1),
      atkWind: def.atkWind * (m.atkWind || 1), score: def.score * 5 + 500 };
    if (def.ranged) def.ranged = { ...def.ranged,
      projSpeed: def.ranged.projSpeed * (m.projSpeed || 1), range: def.ranged.range * (m.range || 1) };
  }
  if (char) def = materializeDef(def, char); // a battle-hardened enemy hits harder too
  const h = buildHumanoid(def.palette, def.scale, def.weapon || 'sword');
  scene.add(h.group);
  const bar = makeHealthBar();
  bar.position.y = 3.6 * def.scale;
  h.group.add(bar);
  const e = {
    team: 'enemy',
    obj: h.group, parts: h.parts, anim: makeAnimator(h.parts), bar, def, type, char: char || null,
    pos: new THREE.Vector3(x, 0, z),
    vel: new THREE.Vector3(),
    facing: 0,
    hp: def.hp, maxHp: def.hp,
    state: 'chase',        // chase | windup | recover | hurt | dead
    role: 'flank',         // engage (fight head-on) | flank (circle behind)
    slotAngle: 0,          // world-space bearing of the flank slot around the player
    target: null, slotOn: null, waiting: false,
    strafeDir: Math.random() < 0.5 ? -1 : 1, // stable orbit direction while waiting
    timer: 0, cd: rand(0, def.cd), hitDone: false, move: def.moves[0],
    walkPhase: Math.random() * 6,
    flash: 0, alive: true, deadT: 0,
    poise: 0, maxPoise: 0, staggered: false, // set below once heroTrait is known
  };
  if (hero) {
    e.isHero = true;
    e.heroName = hero.name;
    e.heroTrait = hero.trait;
    // horned helm marks a champion on the field
    const hornM = mat(0x1a1612, { metal: 0.4 });
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(cachedGeo('horn', () => new THREE.ConeGeometry(0.12, 0.6, 5)), hornM);
      horn.position.set(0.3 * side, 0.32, 0);
      horn.rotation.z = -side * 0.85;
      h.parts.head.add(horn);
    }
    const label = makeNameSprite(hero.name);
    label.position.y = 3.6 * def.scale + 0.7;
    h.group.add(label);
  }
  // juggernauts never stagger; everyone else's stagger threshold scales with their bulk
  e.maxPoise = (e.heroTrait === 'juggernaut') ? Infinity : Math.round(FEEL.poiseBase + def.hp * FEEL.poiseFromHp);
  e.poise = e.maxPoise;
  setPose(e.anim, 'guard', 0.3);
  h.group.position.copy(e.pos);
  enemies.push(e);
  return e;
}

// ---------- Allies (your warband) ----------
const allies = [];
const ALLY_DEF = { hp: 100, speed: 10, dmg: 22, range: 2.4, atkWind: 0.32, atkRec: 0.36, cd: 0.5, scale: 1.0,
                   moves: ['slashR', 'slashL', 'chop'], weapon: 'sword', cls: 'sword' };
const ALLY_LONGSWORD = { hp: 110, speed: 9, dmg: 26, range: 3.1, atkWind: 0.4, atkRec: 0.45, cd: 0.7, scale: 1.05,
                   moves: ['slashR', 'slashL'], weapon: 'longsword', cls: 'long' };
const ALLY_ARCHER = { hp: 70, speed: 10, dmg: 14, range: 2.0, atkWind: 0.5, atkRec: 0.3, cd: 1.3, scale: 0.95,
                   moves: ['slashR'], weapon: 'bow', ranged: { kind: 'arrow', range: 70, minRange: 12, projSpeed: 52 }, cls: 'archer' };
const ALLY_THROWER = { hp: 100, speed: 7.5, dmg: 18, range: 2.4, atkWind: 0.55, atkRec: 0.4, cd: 1.8, scale: 1.15,
                   moves: ['chop'], weapon: 'rock', ranged: { kind: 'rock', range: 12, minRange: 4, projSpeed: 14 }, cls: 'thrower' };

// XP economy: each wave you earn XP from kills (minus losses), and spend it at
// the muster to recruit. A bigger army costs more XP; a costly victory earns
// less, so it grows slower. Wealth is conserved: xp + (cost of fielded roster).
const WARBAND_KEYS = ['sword', 'long', 'archer', 'thrower'];
const UNIT_COST = { sword: 8, long: 14, archer: 11, thrower: 12 };
const KILL_XP = 8;    // per enemy slain that wave — tuned for fast army growth
const HERO_XP = 40;   // per champion slain
const LOSS_XP = 12;   // lost per fallen warband member
const BAND_XP = 5;    // victory bounty per soldier in the host you broke
const BAND_XP_FLOOR = 35; // even a 3-bandit pack is worth hunting down
const STARTING_WEALTH = 90; // a strong opening warband + spare to spend
const warbandComp = { sword: 2, long: 0, archer: 1, thrower: 1 };
let xp = 0;
let waveKills = 0, waveHeroKills = 0, waveLosses = 0; // this-wave tally for XP
function warbandTotal() { return WARBAND_KEYS.reduce((s, k) => s + warbandComp[k], 0); }
function warbandCost(comp = warbandComp) { return WARBAND_KEYS.reduce((s, k) => s + comp[k] * UNIT_COST[k], 0); }
function resetEconomy() {
  warbandComp.sword = 2; warbandComp.long = 0; warbandComp.archer = 1; warbandComp.thrower = 1;
  xp = STARTING_WEALTH - warbandCost();
  waveKills = waveHeroKills = waveLosses = 0;
}
function warbandLoadout() {
  const defs = [];
  for (let i = 0; i < warbandComp.sword; i++) defs.push(ALLY_DEF);
  for (let i = 0; i < warbandComp.long; i++) defs.push(ALLY_LONGSWORD);
  for (let i = 0; i < warbandComp.archer; i++) defs.push(ALLY_ARCHER);
  for (let i = 0; i < warbandComp.thrower; i++) defs.push(ALLY_THROWER);
  return defs;
}
// blue/teal faction so they read as "your side" against the red marauders
const ALLY_PALETTES = [
  { skin: 0xe0b088, cloth: 0x356fb0, accent: 0x223a66, blade: 0xeaf2ff },
  { skin: 0xd2a070, cloth: 0x2f8f93, accent: 0x1c5a5e, blade: 0xeaf2ff },
  { skin: 0xe8b894, cloth: 0x4a64b5, accent: 0x2a3a73, blade: 0xeaf2ff },
  { skin: 0xc89a6a, cloth: 0x2f9f74, accent: 0x1c6048, blade: 0xeaf2ff },
];

// ---------- Careers: every fighter is a named individual who grows by fighting ----------
// A Character is the PERSISTENT identity behind a body on the field. Bodies (allies[]/
// enemies[]) are transient; their `.char` carries the name, skills, renown and kill record
// across battles. Skills accumulate from ACTUAL combat — landing hits, scoring kills,
// blocking blows — and convert, with diminishing returns, into stronger blows and a
// hardier guard. The player is a Character like any other. (Step 1: client-only, mirrored
// to localStorage; the Node server + always-on living world arrive in later steps.)
const CAREERS_KEY = 'bv-careers';
const SKILL_SCALE = 60, SKILL_CAP = 100;
function effSkill(raw) { return SKILL_CAP * (1 - Math.exp(-Math.max(0, raw) / SKILL_SCALE)); }
const RANKS = [['Recruit', 0], ['Veteran', 40], ['Sergeant', 120], ['Captain', 300], ['Commander', 700]];
function rankFor(renown) { let r = RANKS[0][0]; for (const e of RANKS) if (renown >= e[1]) r = e[0]; return r; }
// ----- champions: a soldier who earns their standing becomes a champion who can lead a squad -----
const CHAMPION_RANK_IDX = 2;                 // Sergeant — the first rank that may take command
function rankIdx(rank) { for (let i = 0; i < RANKS.length; i++) if (RANKS[i][0] === rank) return i; return 0; }
function isChampion(c) { return !!c && rankIdx(c.rank) >= CHAMPION_RANK_IDX; }
// the retinue a champion may command, by rank — Sergeant 6 · Captain 12 · Commander the whole host
function commandCap(c) { const i = rankIdx(c && c.rank); return i >= 4 ? 999 : i >= 3 ? 12 : i >= 2 ? 6 : 0; }
function capLabel(cap) { return cap >= 999 ? 'the host' : cap; }
// the buff a led squad shares — scales with the leader's command skill and renown. Modest by design.
function leadAura(c) {
  if (!isChampion(c)) return null;
  const L = effSkill(c.skills.lead), r = Math.min(1, c.renown / 700);
  return { dmgMul: 1 + (0.06 + 0.0010 * L) * (0.5 + 0.5 * r),   // ~+6%..+16% damage at the cap
           hpMul:  1 + (0.05 + 0.0008 * L) * (0.5 + 0.5 * r),   // ~+5%..+13% grit
           cohesion: 0.25 + 0.005 * L };                        // rout-resist (reserved for the morale layer)
}
// resolve a leader's persistent character by id — your hero or any warband soldier
function leaderCharById(id) {
  if (id == null) return null;
  if (playerChar && playerChar.id === id) return playerChar;
  for (const c of warbandRoster) if (c.id === id) return c;
  return null;
}
const ALLY_DEF_BY_CLASS = { sword: ALLY_DEF, long: ALLY_LONGSWORD, archer: ALLY_ARCHER, thrower: ALLY_THROWER };
function classKeyOf(arch) { return (arch === 'long' || arch === 'archer' || arch === 'thrower') ? arch : 'sword'; }

const GIVEN_NAMES = ['Aldric','Bram','Cedwyn','Doran','Eadric','Falk','Garrec','Hale','Ivo','Joren','Kell','Lorne','Maddoc','Nael','Osric','Perrin','Quenn','Roderic','Sefton','Tomas','Ulf','Varin','Wend','Yorin','Ansel','Brand','Corin','Dunmar','Edra','Freya','Gerda','Halla','Ingrid','Jorah','Kara','Linnet','Mira','Nessa','Orla','Petra','Romilda','Sigrun','Thora','Ysolde'];
const BYNAMES = ['the Bold','the Quiet','Ironhand','the Younger','Oakheart','the Swift','Stonefist','the Grim','Redmane','the Tall','Hawkeye','the Patient','Coldbrook','the Stout','Wolfsbane','the Lucky','Greycloak','the Fierce','Longstride','the Sly','Brightblade','the Steady','Hardwin','the Wary','Blackbriar','Frostbeard','Stormcrow'];
function pick(a) { return a[(Math.random() * a.length) | 0]; }
function shuffleInPlace(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function roman(n) { const t = [[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]; let s = ''; for (const e of t) while (n >= e[0]) { s += e[1]; n -= e[0]; } return s; }
function genName(set) {
  for (let i = 0; i < 40; i++) {
    let nm = pick(GIVEN_NAMES);
    if (Math.random() < 0.55) nm += ' ' + pick(BYNAMES);
    if (!set || !set.has(nm)) { if (set) set.add(nm); return nm; }
  }
  let n = 2, nm;
  do { nm = pick(GIVEN_NAMES) + ' ' + roman(n++); } while (set && set.has(nm));
  if (set) set.add(nm);
  return nm;
}

let charIdSeq = 0;
function makeChar(archetype, opts = {}) {
  return {
    id: ++charIdSeq,
    name: opts.name || genName(opts.nameSet),
    archetype, team: opts.team || 'ally',
    isHero: !!opts.hero, trait: opts.hero ? opts.hero.trait : null, isPlayer: !!opts.isPlayer,
    skills: { strike: 0, guard: 0, lead: 0, aim: 0 },
    xp: 0, renown: opts.renown || 0, popularity: 0,
    kills: 0, battles: 0, battlesLed: 0, battlesWon: 0, deaths: 0,
    rank: 'Recruit', notability: opts.notability || 1,
    destiny: null, fate: 0,                       // server-computed fated arc (chronicle-only; hydrated from /profile)
    dmgBonus: 0, guardEff: 1, hpBonus: 0,
    localKills: 0, localStrike: 0, localGuard: 0, fielded: false, fallen: false,
  };
}
function recomputeChar(c) {
  const s = effSkill(c.skills.strike), g = effSkill(c.skills.guard);
  c.dmgBonus = Math.round(s * 0.30);          // 0 → +30 dmg at the skill cap
  c.guardEff = 1 + g * 0.004;                 // 1 → 1.4: a cheaper, harder guard
  c.hpBonus = Math.round((s + g) * 0.5);      // 0 → +100 maxHp at the cap
  c.rank = rankFor(c.renown);
  return c;
}
// A grown fighter hits harder and weathers more — a per-instance def clone carries it onto
// the field. Bonuses are recomputed only at battle-end/muster, never in the hot loop, so a
// strike just reads f.def.dmg as before. No bonus → returns the shared base def, unchanged.
function materializeDef(baseDef, char) {
  if (!char || (!char.dmgBonus && !char.hpBonus)) return baseDef;
  const d = Object.assign({}, baseDef);
  d.dmg = baseDef.dmg + char.dmgBonus;
  d.hp = baseDef.hp + char.hpBonus;
  return d;
}

// The player's warband: a persistent muster of named soldiers — the identities behind the
// anonymous warbandComp counts. Reconciled to the counts at battle start; survivors carry
// their growing careers from one battle to the next; the fallen are gone for good.
let playerChar = null;
let warbandRoster = [];
const warbandNameSet = new Set();
function ensureWarbandRoster() {
  for (const k of WARBAND_KEYS) {
    const living = warbandRoster.filter(c => !c.fallen && classKeyOf(c.archetype) === k);
    while (living.length < warbandComp[k]) {
      const c = makeChar(k, { team: 'ally', nameSet: warbandNameSet });
      warbandRoster.push(c); living.push(c);
    }
    while (living.length > warbandComp[k]) {         // sold/culled units: the greenest leave first
      living.sort((a, b) => a.renown - b.renown);
      const cut = living.shift();
      warbandNameSet.delete(cut.name);
      const idx = warbandRoster.indexOf(cut); if (idx >= 0) warbandRoster.splice(idx, 1);
    }
  }
}

// world bands: a named warlord leads every host on the map (Step 2: client-side identities;
// the server makes them durable in a later step). Renown grows with the wars they win.
const worldNameSet = new Set();
const ENEMY_ARCHS = ['grunt', 'rogue', 'longsword', 'brute', 'archer', 'thrower'];
function makeBandLeader(size, level, host) {
  const c = makeChar(ENEMY_ARCHS[(Math.random() * ENEMY_ARCHS.length) | 0], {
    team: 'enemy', nameSet: worldNameSet, notability: 2,
    renown: Math.round(rand(4, 16 + level * 12 + (host ? size * 0.5 : 0))) });
  c.skills.strike = rand(0, 14 + level * 8);
  c.skills.guard = rand(0, 8 + level * 5);
  c.skills.lead = rand(0, 4 + level * 3);
  recomputeChar(c);
  return c;
}

// per-battle career bookkeeping
let battleKillFeed = [];
let enemyNameSet = new Set();
function beginBattleCareers() {
  battleKillFeed = []; enemyNameSet = new Set();
  for (const c of warbandRoster) { c.localKills = c.localStrike = c.localGuard = 0; c.fielded = false; c.fallen = false; }
  if (playerChar) { playerChar.localKills = playerChar.localStrike = playerChar.localGuard = 0; }
}
let battlePromotions = [];                   // names that crossed into champion rank this battle (muster banner)
function foldChar(c, won) {
  const wasChampion = isChampion(c);
  c.skills.strike += c.localStrike + 0.10;   // +0.10 just for surviving the press
  c.skills.guard += c.localGuard + 0.10;
  c.kills += c.localKills;
  c.battles++;
  c.renown += 2 + 0.5 * c.localKills + (won ? 1 : 0);
  if (won) c.battlesWon++;
  c.localKills = c.localStrike = c.localGuard = 0; c.fielded = false;
  recomputeChar(c);
  if (!wasChampion && isChampion(c)) battlePromotions.push(c.name); // a new champion is born
}
// fold the battle's deeds into every survivor, drop the fallen, re-derive the warband counts
function applyBattleGrowth(won) {
  battlePromotions = [];
  // leaders earn command XP for the squad they led — folded BEFORE survivors so the new lead/renown counts
  for (const g of planGroups) {
    if (g.leaderId == null) continue;
    const lc = leaderCharById(g.leaderId);
    if (!lc || lc.fallen) continue;
    const led = allies.filter(a => a.alive && a.group === g.id).length;
    lc.battlesLed++;
    lc.skills.lead += 0.4 + 0.05 * led;       // leading a bigger retinue trains command faster
    if (won) lc.renown += 3 + 0.5 * led;      // a victory under your banner pays extra renown
  }
  const survivors = [], seen = new Set();
  for (const a of allies) if (a.alive && a.char && a.char !== playerChar && !a.char.borrowed) { foldChar(a.char, won); survivors.push(a.char); seen.add(a.char); }
  for (const item of playerReserve) if (item && item.char && !item.char.borrowed && !seen.has(item.char)) { survivors.push(item.char); seen.add(item.char); } // never fielded → no growth, but they live (borrowed allies go home)
  if (playerChar) foldChar(playerChar, won);
  warbandRoster = survivors;
  warbandNameSet.clear(); for (const c of warbandRoster) warbandNameSet.add(c.name);
  for (const k of WARBAND_KEYS) warbandComp[k] = 0;
  for (const c of warbandRoster) warbandComp[classKeyOf(c.archetype)]++;
  saveCareers();
}

// persistence (Step 1: a localStorage mirror; the server becomes authoritative later)
function serChar(c) {
  return { id: c.id, name: c.name, archetype: c.archetype, team: c.team, isHero: c.isHero, trait: c.trait, isPlayer: c.isPlayer,
    skills: c.skills, xp: c.xp, renown: c.renown, popularity: c.popularity,
    kills: c.kills, battles: c.battles, battlesLed: c.battlesLed, battlesWon: c.battlesWon, deaths: c.deaths, notability: c.notability };
}
function deserChar(o) {
  const c = makeChar(o.archetype, { name: o.name, team: o.team, notability: o.notability, isPlayer: o.isPlayer });
  c.id = o.id; c.isHero = o.isHero; c.trait = o.trait;
  c.skills = Object.assign({ strike: 0, guard: 0, lead: 0, aim: 0 }, o.skills);
  c.xp = o.xp || 0; c.renown = o.renown || 0; c.popularity = o.popularity || 0;
  c.kills = o.kills || 0; c.battles = o.battles || 0; c.battlesLed = o.battlesLed || 0; c.battlesWon = o.battlesWon || 0; c.deaths = o.deaths || 0;
  c.destiny = o.destiny || null; c.fate = o.fate || 0;
  recomputeChar(c); return c;
}
function saveCareers() {
  const payload = { v: 1, seq: charIdSeq, mapLevel,
    player: playerChar ? serChar(playerChar) : null,
    warband: warbandRoster.filter(c => !c.fallen).map(serChar) };
  try { localStorage.setItem(CAREERS_KEY, JSON.stringify(payload)); } catch (e) { /* private mode / quota */ }
  // push to the backend (authoritative when reachable); offline → the localStorage mirror above
  // stands in and client-net queues an outbox that flushes on reconnect
  if (typeof window !== 'undefined' && window.net) {
    window.net.saveCareers(payload);
    if (battleKillFeed && battleKillFeed.length) {
      window.net.saveDeeds(battleKillFeed.map(k => ({ kind: 'kill', actor: k.killer, target: k.victim,
        summary: k.killer + ' slew ' + k.victim + (k.hero ? ' (a champion)' : '') })));
    }
  }
}
function loadCareers() {
  let data = null;
  // prefer the server profile (pre-fetched by client-net before the game starts); fall back to
  // the localStorage mirror when the backend is unreachable
  const srv = (typeof window !== 'undefined' && window.net && window.net.profile);
  if (srv && (srv.player || (srv.warband && srv.warband.length))) {
    data = { player: srv.player, warband: srv.warband || [] };
  } else {
    try { const raw = localStorage.getItem(CAREERS_KEY); if (raw) data = JSON.parse(raw); } catch (e) { data = null; }
  }
  warbandRoster.length = 0; warbandNameSet.clear();
  if (data && data.player) playerChar = deserChar(data.player);
  else playerChar = makeChar('sword', { team: 'ally', nameSet: warbandNameSet, notability: 3, isPlayer: true });
  if (data && data.warband) for (const o of data.warband) { const c = deserChar(o); warbandRoster.push(c); warbandNameSet.add(c.name); }
  let maxId = (data && data.seq) || 0;
  if (playerChar) maxId = Math.max(maxId, playerChar.id);
  for (const c of warbandRoster) maxId = Math.max(maxId, c.id);
  charIdSeq = maxId;
  player.char = playerChar;
}

function spawnAlly(x, z, palette, def = ALLY_DEF, char = null) {
  if (!char) char = makeChar(defKey(def), { team: 'ally' }); // legacy callers still get a name
  def = materializeDef(def, char);                            // a grown soldier fields harder stats
  if (coopMult > 1.001) { def = Object.assign({}, def); def.dmg = Math.round(def.dmg * coopMult); def.hp = Math.round(def.hp * coopMult); } // fighting shoulder-to-shoulder with allies: harder hits, more grit
  const h = buildHumanoid(palette, def.scale, def.weapon || 'sword');
  scene.add(h.group);
  const bar = makeHealthBar(0x6bff8a); // green bar marks a friendly
  bar.position.y = 3.6 * def.scale;
  h.group.add(bar);
  const label = makeNameSprite(char.name);    // a name floats over every soldier you lead
  label.scale.set(3.4, 0.42, 1); label.position.y = 3.6 * def.scale + 0.5;
  h.group.add(label);
  const a = {
    team: 'ally',
    obj: h.group, parts: h.parts, anim: makeAnimator(h.parts), bar, def, char,
    pos: new THREE.Vector3(x, 0, z),
    vel: new THREE.Vector3(),
    facing: 0,
    hp: def.hp, maxHp: def.hp,
    state: 'chase',
    target: null, slotOn: null, waiting: false,
    strafeDir: Math.random() < 0.5 ? -1 : 1,
    timer: 0, cd: rand(0, def.cd), hitDone: false, move: def.moves[0],
    walkPhase: Math.random() * 6,
    flash: 0, alive: true, deadT: 0,
    order: 'free', holdPos: null, zone: null, homeSlot: null, pace: 'march', // order: free|hold|zone|attackmove · pace: march|rush
    selRing: null, group: null, grpRing: null,
  };
  setPose(a.anim, 'guard', 0.3);
  h.group.position.copy(a.pos);
  allies.push(a);
  return a;
}
function clearAllies() {
  for (const a of allies) { scene.remove(a.obj); disposeGroup(a.obj); }
  allies.length = 0;
}
// form the warband up in a line abreast, a few paces ahead of the player,
// all facing the direction the enemy host will charge from
function rallyAllies(frontYaw = 0) {
  clearAllies();
  const defs = warbandLoadout(); // the player's chosen composition
  const fdx = Math.sin(frontYaw), fdz = Math.cos(frontYaw); // toward the host
  const rdx = Math.cos(frontYaw), rdz = -Math.sin(frontYaw); // along the line
  // big armies form ranks: rows of up to 24, melee rows ahead, ranged rows behind
  const ROW = 24;
  const melee = defs.filter(d => !d.ranged), ranged = defs.filter(d => d.ranged);
  let idx = 0;
  const place = (def, col, rowWidth, row, baseAhead) => {
    const lateral = (col - (rowWidth - 1) / 2) * 2.6;
    const ahead = baseAhead - row * 2.3;
    const x = clamp(player.pos.x + fdx * ahead + rdx * lateral, -ARENA + 1, ARENA - 1);
    const z = clamp(player.pos.z + fdz * ahead + rdz * lateral, -ARENA + 1, ARENA - 1);
    const a = spawnAlly(x, z, ALLY_PALETTES[idx++ % ALLY_PALETTES.length], def);
    a.facing = frontYaw;
  };
  melee.forEach((def, i) => {
    const row = Math.floor(i / ROW), width = Math.min(ROW, melee.length - row * ROW);
    place(def, i % ROW, width, row, 3);
  });
  ranged.forEach((def, i) => {
    const row = Math.floor(i / ROW), width = Math.min(ROW, ranged.length - row * ROW);
    place(def, i % ROW, width, row, -1.5 - Math.ceil(melee.length / ROW) * 0.5);
  });
}

// ---------- Input ----------
const keys = {};
let cameraAngle = Math.PI; // mouse-look yaw; the camera orbits the character
let cameraDist = 7.5, cameraHeight = 4;
let pointerLocked = false;
// touch-driven analog movement (mobile); feeds inputDir() alongside WASD
const TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0 || /[?&]touch=1/.test(location.search);
let touchMove = { f: 0, s: 0, active: false };

// third-person mouse look: pointer lock on the canvas, mouse steers the camera
canvas.addEventListener('click', () => {
  SFX.init(); // browsers gate WebAudio behind a user gesture — this is the reliable one
  // don't re-grab the cursor while the mid-battle command deck is open (it would vanish mid-order)
  if (gameRunning && !commandPanelOpen && !pointerLocked && canvas.requestPointerLock) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  // losing the cursor mid-battle (Esc / alt-tab) surfaces the command deck instead of stranding the player
  if (!pointerLocked && mode === 'battle' && gameRunning && !commandPanelOpen) openCommandDeck();
});
addEventListener('mousemove', (e) => {
  if (!pointerLocked || !gameRunning) return;
  cameraAngle -= e.movementX * 0.0035;
  cameraHeight = clamp(cameraHeight + e.movementY * 0.02, 2.2, 10);
});

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  SFX.init(); // unlock audio on first keypress too (covers keyboard-first players)
  if (mode === 'plan' || commandPanelOpen) { handlePlanKey(e); return; } // commanding: keys order troops, not the fighter
  if (mode === 'battle' && gameRunning && handleBattleOrderKey(e)) return; // real-time squad orders WHILE you fight (no deck, no slow)
  if (e.code === 'Space') { e.preventDefault(); requestDodge(); }
  if (e.code === 'KeyF') toggleWeapon();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
canvas.addEventListener('mousedown', (e) => {
  if (mode === 'plan' || commandPanelOpen) return;
  if (e.button === 0) requestAttack();        // left: light combo / finisher
  else if (e.button === 2) requestHeavyAttack(); // right: committed heavy cleave
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Touch controls (mobile) ----------
// Left thumb = a floating analog stick (drives inputDir, so it works in map roam AND battle).
// Right side of the canvas = drag-to-look (replaces pointer-lock, which mobile lacks).
// On-screen buttons map to the same requestAttack/requestDodge/etc. the keyboard fires.
if (TOUCH) {
  document.body.classList.add('touch');
  const touchRoot = document.getElementById('touch');
  const tj = document.getElementById('tj'), tjKnob = document.getElementById('tj-knob');
  const TJ_R = 60; // stick radius in px
  let moveId = null, lookId = null;
  let tjAnchor = { x: 0, y: 0 }, lookLast = { x: 0, y: 0 };

  function controllable() {
    const inMap = mode === 'map' && !encounter;
    const inBattle = mode === 'battle' && gameRunning && !commandPanelOpen && !encounter;
    return { inMap, inBattle, any: inMap || inBattle };
  }
  function classify(t) {
    const c = controllable();
    if (!c.any) return null;
    if (c.inBattle && t.clientX > innerWidth * 0.5) return 'look'; // right half steers the camera
    return 'move'; // left thumb (and all of map mode) moves the avatar
  }
  function setStick(x, y) {
    let dx = x - tjAnchor.x, dy = y - tjAnchor.y;
    const len = Math.hypot(dx, dy) || 1;
    const cl = Math.min(len, TJ_R);
    tjKnob.style.transform = `translate(${(dx / len) * cl}px, ${(dy / len) * cl}px)`;
    const mag = cl / TJ_R, m = mag < 0.16 ? 0 : mag; // small deadzone
    touchMove.s = (dx / len) * m;   // right = strafe right (D)
    touchMove.f = -(dy / len) * m;  // up    = forward (W)
    touchMove.active = m > 0;
  }
  function showStick(x, y) {
    tjAnchor = { x, y };
    tj.style.left = (x - 66) + 'px'; tj.style.top = (y - 66) + 'px'; tj.style.bottom = 'auto';
    touchRoot.classList.add('dragging');
  }
  function hideStick() {
    tj.style.left = ''; tj.style.top = ''; tj.style.bottom = '';
    tjKnob.style.transform = ''; touchRoot.classList.remove('dragging');
    touchMove.f = touchMove.s = 0; touchMove.active = false;
  }

  canvas.addEventListener('touchstart', (e) => {
    let used = false;
    for (const t of e.changedTouches) {
      const role = classify(t);
      if (role === 'move' && moveId === null) { moveId = t.identifier; showStick(t.clientX, t.clientY); setStick(t.clientX, t.clientY); used = true; }
      else if (role === 'look' && lookId === null) { lookId = t.identifier; lookLast = { x: t.clientX, y: t.clientY }; used = true; }
    }
    if (used) { e.preventDefault(); SFX.init(); }
  }, { passive: false });
  addEventListener('touchmove', (e) => {
    if (moveId === null && lookId === null) return; // not steering -> let menus scroll
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) setStick(t.clientX, t.clientY);
      else if (t.identifier === lookId) {
        cameraAngle -= (t.clientX - lookLast.x) * 0.005;
        cameraHeight = clamp(cameraHeight + (t.clientY - lookLast.y) * 0.03, 2.2, 10);
        lookLast = { x: t.clientX, y: t.clientY };
      }
    }
    e.preventDefault();
  }, { passive: false });
  function endTouch(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) { moveId = null; hideStick(); }
      else if (t.identifier === lookId) lookId = null;
    }
  }
  addEventListener('touchend', endTouch);
  addEventListener('touchcancel', endTouch);

  // a button fires on press (low latency); block is a hold; click keeps it usable on desktop too
  function bindBtn(id, onDown, onUp) {
    const el = document.getElementById(id); if (!el) return;
    el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('on'); SFX.init(); onDown && onDown(); }, { passive: false });
    const up = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } el.classList.remove('on'); onUp && onUp(); };
    el.addEventListener('touchend', up); el.addEventListener('touchcancel', up);
  }
  bindBtn('tb-attack', requestAttack);
  bindBtn('tb-heavy', requestHeavyAttack);
  bindBtn('tb-dodge', requestDodge);
  bindBtn('tb-block', () => { keys['ShiftLeft'] = true; }, () => { keys['ShiftLeft'] = false; });
  bindBtn('tb-weapon', toggleWeapon);
  bindBtn('tb-cmd', () => { if (mode === 'battle' && !commandPanelOpen) openCommandDeck(); });
  bindBtn('tb-rally', () => { if (mode === 'map' && !encounter) raiseCall(); });
  bindBtn('tb-beacon', () => { if (mode === 'map' && !encounter) openBeaconPanel(); });
  bindBtn('tb-warband', () => toggleCharsheet());

  // show the right control set for the current mode; called each frame from the loop
  window.updateTouchHud = function () {
    if (!touchRoot) return;
    const c = controllable();
    touchRoot.classList.toggle('hidden', !c.any);
    touchRoot.classList.toggle('mapmode', c.inMap);
    touchRoot.classList.toggle('battlemode', c.inBattle);
    if (!c.any && moveId !== null) { moveId = null; hideStick(); } // dropped into a menu mid-drag
  };
}

function toggleWeapon() {
  if (!gameRunning || !player.alive || player.attacking || player.shooting || player.rolling) return;
  player.weapon = player.weapon === 'sword' ? 'bow' : 'sword';
  setPlayerWeaponVisual();
}
function requestAttack() {
  if (!gameRunning || !player.alive || player.rolling || player.heavy) return;
  if (player.weapon === 'bow') { startBowShot(); return; }
  if (player.attacking) { player.queued = true; return; }
  if (player.cooldown > 0) return;
  const fin = finisherTarget();        // a reeling / near-dead foe in front → execute instead of a normal swing
  if (fin) { doFinisher(fin); return; }
  startAttack();
}
function requestHeavyAttack() {
  if (!gameRunning || !player.alive || player.rolling || player.attacking || player.heavy) return;
  if (player.weapon !== 'sword' || player.cooldown > 0) return;
  if (player.stamina < FEEL.heavyStamina) return; // a heavy is a real commitment
  startHeavyAttack();
}
function startHeavyAttack() {
  player.heavy = true; player.attacking = true; player.attackT = 0; player.attackPhase = 0;
  player.hitDone = false; player.queued = false;
  player.stamina = Math.max(0, player.stamina - FEEL.heavyStamina);
  player.atkScale = 1; // heavy uses its own duration — keep the telegraph readable, no fatigue stretch
  player.move = 'heavy';
  player.aimTarget = null; // heavy steers toward the nearest cluster centre, but mainly faces the aim
  player.combo = 0; player.comboTimer = 0; hideCombo();
}
// finisher: a staggered or near-dead foe is open to a one-shot execution
function isFinisherEligible(e) {
  return e && e.alive && (e.staggered || e.hp / e.maxHp < FEEL.finisherHpFrac);
}
function finisherTarget() {
  if (player.weapon !== 'sword') return null;
  const fdir = new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing));
  let best = null, bd = Infinity;
  for (const e of enemies) {
    if (!isFinisherEligible(e)) continue;
    tmpV.subVectors(e.pos, player.pos); tmpV.y = 0;
    const d = tmpV.length();
    if (d > PLAYER_ATK_RANGE + 0.7 + (e.def.scale - 1)) continue;
    if (d > 0.001) tmpV.normalize();
    if (fdir.dot(tmpV) < 0.2) continue; // roughly in front
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function doFinisher(e) {
  if (!e.alive) return;
  player.facing = Math.atan2(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
  setPose(player.anim, 'strikeHeavy', 0.05);
  spawnTrail(player, 1.7, 0xff7a4a);
  spawnSlashArc(player.pos, player.facing, MOVES.heavy, 1.4, 0xff7a4a);
  spawnPopup(e.obj.position.clone().setY(2.4), 'EXECUTE', '#ff5a3c');
  spawnSparks(e.obj.position.clone().setY(1.6), 0xff5a3c, 22); // gore burst
  addHitstop(FEEL.finisherStop); // a heavy, satisfying freeze beyond the normal kill
  player.cooldown = 0.16;
  killEnemy(e, true, player); // score + counts + the kill's own crunch/shake/zoom
  player.combo = (player.comboTimer > 0 ? player.combo + 1 : 1); player.comboTimer = 1.4; showCombo(player.combo);
}
// a pulsing chevron hovers over the nearest executable foe in front of you
let finisherMarker = null;
function updateFinisherMarker() {
  if (!finisherMarker) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 96px Trebuchet MS, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 9; ctx.strokeStyle = '#000'; ctx.strokeText('▼', 64, 70);
    ctx.fillStyle = '#ff5a3c'; ctx.fillText('▼', 64, 70);
    finisherMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
    finisherMarker.scale.set(1.3, 1.3, 1); finisherMarker.renderOrder = 999;
    scene.add(finisherMarker); finisherMarker.visible = false;
  }
  const e = (player.alive && player.weapon === 'sword') ? finisherTarget() : null;
  if (e) {
    finisherMarker.visible = true;
    finisherMarker.position.set(e.obj.position.x, 3.0 * (e.def.scale || 1) + 0.9 + Math.sin(rtNow * 6) * 0.15, e.obj.position.z);
  } else finisherMarker.visible = false;
}
// nearest enemy in the forward aim cone (else a point straight ahead) for the bow
function playerBowTarget() {
  const ax = Math.sin(player.facing), az = Math.cos(player.facing);
  let best = null, bd = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.2) continue;
    if ((dx * ax + dz * az) / d < 0.5) continue; // outside ~60° cone ahead
    if (d < bd) { bd = d; best = e; }
  }
  return best || { pos: new THREE.Vector3(player.pos.x + ax * 50, 0, player.pos.z + az * 50) };
}
function startBowShot() {
  if (player.shooting || player.cooldown > 0 || player.stamina < 6) return;
  player.stamina -= 6;
  player.shooting = true; player.shootT = 0; player.shotReleased = false;
  setPose(player.anim, 'aimBow', 0.12);
}
function startAttack() {
  player.attacking = true; player.attackT = 0; player.attackPhase = 0;
  player.hitDone = false; player.queued = false;
  // swings cost stamina; tired arms swing slower — and when exhausted,
  // sometimes with a ragged hesitation before the cut
  const stam = player.stamina;
  player.stamina = Math.max(0, stam - 9);
  const fatigue = clamp(1 - stam / 40, 0, 1);
  player.atkScale = 1 + fatigue * 0.55 + (stam < 10 ? Math.random() * 0.3 : 0);
  // aim assist: acquire the closest enemy (nearby ones in front win ties),
  // the swing steers onto them during the windup
  player.aimTarget = null;
  let bestScore = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = e.pos.distanceTo(player.pos);
    if (d > 7.5) continue;
    const yaw = Math.atan2(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
    const score = d + Math.abs(angleDelta(player.facing, yaw)) * 0.8;
    if (score < bestScore) { bestScore = score; player.aimTarget = e; }
  }
  player.combo = (player.comboTimer > 0 ? player.combo + 1 : 1);
  player.comboTimer = 1.4;
  player.move = PLAYER_COMBO[(player.combo - 1) % PLAYER_COMBO.length];
  showCombo(player.combo);
}
function requestDodge() {
  if (!gameRunning || !player.alive || player.rolling) return;
  if (player.stamina < 30) return;
  player.stamina -= 30;
  player.rolling = true; player.rollT = 0; player.iFrames = true;
  player.attacking = false;
  setPose(player.anim, 'guard', 0.12); // dodge-cancel: don't hold a windup through the roll
  // roll in the current movement direction, else straight ahead
  const dir = inputDir();
  if (dir.lengthSq() > 0.01) player.rollDir.copy(dir);
  else player.rollDir.set(Math.sin(player.facing), 0, Math.cos(player.facing));
}

// WASD on the look axis: W is ALWAYS straight toward where you're looking,
// S directly away, A/D perpendicular side-steps. Built from explicit
// forward/right basis vectors so no camera angle can skew it.
function inputDir() {
  let f = 0, s = 0;
  if (keys['KeyW']) f += 1;
  if (keys['KeyS']) f -= 1;
  if (keys['KeyD']) s += 1;
  if (keys['KeyA']) s -= 1;
  if (touchMove.active) { f += touchMove.f; s += touchMove.s; } // mobile stick
  const v = new THREE.Vector3();
  if (!f && !s) return v;
  const yaw = cameraAngle + Math.PI; // look direction
  // forward = (sin yaw, 0, cos yaw); right = forward x up = (-cos yaw, 0, sin yaw)
  v.set(Math.sin(yaw) * f - Math.cos(yaw) * s, 0, Math.cos(yaw) * f + Math.sin(yaw) * s);
  return v.normalize();
}

// ---------- Combat resolution ----------
const PLAYER_ATK_RANGE = 3.0;
const PLAYER_ATK_ARC = 0.35; // cos threshold of frontal arc

function playerHitCheck() {
  const baseDmg = 26;
  const dmg = baseDmg + player.combo * 4 + (player.char ? player.char.dmgBonus : 0); // combos + earned skill
  const fdir = new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing));
  for (const e of enemies) {
    if (!e.alive) continue;
    tmpV.subVectors(e.pos, player.pos); tmpV.y = 0;
    const dist = tmpV.length();
    if (dist > PLAYER_ATK_RANGE + (e.def.scale - 1)) continue;
    tmpV.normalize();
    if (fdir.dot(tmpV) < PLAYER_ATK_ARC) continue;
    damageEnemy(e, dmg, fdir, true, player); // player blow: full juice
  }
}

// heavy: a wide, slow cleave that hits the whole front cluster, shoves them outward
// radially, and drains a big chunk of poise (one good heavy staggers a knot of grunts).
function heavyHitCheck() {
  const dmg = FEEL.heavyDmg + player.combo * 4 + (player.char ? player.char.dmgBonus : 0);
  const fdir = new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing));
  let hits = 0;
  for (const e of enemies) {
    if (!e.alive) continue;
    tmpV.subVectors(e.pos, player.pos); tmpV.y = 0;
    const dist = tmpV.length();
    if (dist > FEEL.heavyRange + (e.def.scale - 1)) continue;
    const radial = tmpV.clone();
    if (radial.lengthSq() > 1e-6) radial.normalize(); else radial.copy(fdir);
    if (fdir.dot(radial) < FEEL.heavyArc) continue; // wide ~200° frontal arc
    damageEnemy(e, dmg, radial, true, player, true); // heavy=true → big radial knock + poise break
    hits++;
  }
  if (hits) { // one big camera burst for the whole cleave (per-enemy juice is suppressed when heavy)
    addShake(FEEL.killShake); addHitstop(0.07);
    addKick(fdir, FEEL.kickKill); addFovPunch(FEEL.fovPunchHit * 1.6);
    spawnSparks(player.pos.clone().setY(0.25), 0xc9b79a, 16); // dust ring kicked up at the feet
  }
}

// byPlayer gates the screen juice (shake/hit-stop/damage numbers) so the dozens of
// ally-vs-enemy clashes in a battle don't constantly rattle the camera.
function damageEnemy(e, dmg, fromDir, byPlayer, attacker, heavy) {
  if (!e.alive) return;
  e.hp -= dmg;
  e.flash = 0.12;
  if (attacker && attacker.char) attacker.char.localStrike += 0.05; // a landed blow sharpens the arm
  // interrupting an attack must not skip the cooldown — otherwise a struck
  // enemy counterattacks 0.18s later, faster than its own attack cycle
  if (e.heroTrait === 'juggernaut') {
    e.vel.addScaledVector(fromDir, heavy ? 2.2 : 1.2); // barely moves, never staggers (infinite poise)
  } else {
    e.cd = Math.max(e.cd, (e.state === 'windup' || e.state === 'recover') ? e.def.cd * 0.6 : 0.4);
    e.vel.addScaledVector(fromDir, heavy ? FEEL.heavyKnock : 6); // heavy sends them flying
    // poise: damage chips it; once broken, the foe reels in a long, finisher-open stagger
    e.poise -= heavy ? FEEL.heavyPoiseDmg : FEEL.lightPoiseDmg;
    if (e.poise <= 0) {
      e.poise = e.maxPoise;
      e.staggered = true; e.state = 'hurt'; e.timer = FEEL.staggerDur;
      setPose(e.anim, 'hurt', 0.05);
    } else if (!e.staggered) { // ordinary flinch — never cut an active stagger short
      e.state = 'hurt'; e.timer = 0.18;
      setPose(e.anim, 'hurt', 0.06);
    }
  }
  const hp = e.obj.position.clone(); hp.y = 2;
  const armored = e.heroTrait === 'juggernaut' || e.isHero;
  SFX.hit(hp, armored); // distance-gated: the player's blow is loud, distant clashes faint
  spawnSparks(hp, 0xffe08a, byPlayer ? 11 : 5);
  if (byPlayer) {
    spawnSparks(hp, 0xc9b79a, 4); // dust kick on contact
    spawnPopup(hp, String(dmg), heavy ? '#ffd27a' : '#ffe08a');
    if (!heavy) { // light hits punch the camera per-blow; the heavy fires one burst in heavyHitCheck
      const w = clamp(dmg / 42, 0.5, 1.6); // bigger combo hits land heavier
      addShake(FEEL.hitShake * w); addHitstop(FEEL.hitStop * w);
      addKick(fromDir, FEEL.kickHit * w); addFovPunch(FEEL.fovPunchHit * w);
    }
  }
  if (e.hp <= 0) killEnemy(e, byPlayer, attacker);
}

function killEnemy(e, byPlayer, killer) {
  e.alive = false; e.state = 'dead'; e.deadT = 0;
  if (killer && killer.char) { killer.char.localKills++; killer.char.localStrike += 0.40;
    if (e.char) battleKillFeed.push({ killer: killer.char.name, victim: e.char.name, hero: !!e.isHero }); }
  e.bar.visible = false;
  addScore(e.def.score + (byPlayer ? player.combo * 10 : 0));
  enemiesRemaining--;
  spawnSparks(e.obj.position.clone().setY(2), 0xff6b6b, 14);
  if (byPlayer) { // your kills hit hardest: a punchy crunch + camera snap
    addShake(FEEL.killShake); addHitstop(FEEL.killStop); addFovPunch(FEEL.fovPunchKill);
    _killDir.set(e.obj.position.x - player.pos.x, 0, e.obj.position.z - player.pos.z);
    if (_killDir.lengthSq() > 1e-6) addKick(_killDir.normalize(), FEEL.kickKill);
    SFX.kill(e.obj.position);
  }
  waveKills++; // every felled foe is worth XP at the muster
  if (e.isHero) {
    // a champion falls: the field feels it, and the bounty is rich
    waveHeroKills++;
    showWaveBanner(e.heroName + ' has fallen', 'Word spreads of your deed — a rich bounty in XP.');
    addShake(0.5); addHitstop(0.12); addFovPunch(FEEL.fovPunchKill * 1.5);
  }
  updateEnemyCount();
}

function damageAlly(a, dmg, fromDir, attacker) {
  if (!a.alive) return;
  a.hp -= dmg;
  a.flash = 0.12;
  if (attacker && attacker.char) attacker.char.localStrike += 0.05;
  a.cd = Math.max(a.cd, (a.state === 'windup' || a.state === 'recover') ? a.def.cd * 0.6 : 0.4);
  a.state = 'hurt'; a.timer = 0.18;
  setPose(a.anim, 'hurt', 0.06);
  a.vel.addScaledVector(fromDir, 6);
  spawnSparks(a.obj.position.clone().setY(2), 0xffd0d0, 6);
  if (a.hp <= 0) killAlly(a, attacker);
  else if (a.char) a.char.localGuard += 0.05; // weathered a blow and lived → a harder guard
}
function killAlly(a, killer) {
  a.alive = false; a.state = 'dead'; a.deadT = 0;
  if (a.char) a.char.fallen = true;
  if (killer && killer.char) { killer.char.localKills++; killer.char.localStrike += 0.40;
    if (a.char) battleKillFeed.push({ killer: killer.char.name, victim: a.char.name, hero: false }); }
  a.bar.visible = false;
  // a fallen champion robs their squad of its aura — the loss is felt the next frame (applyLeadershipAuras)
  if (a.char && planGroups.some(g => g.leaderId === a.char.id)) showWaveBanner(a.char.name + ' has fallen!', 'Their squad wavers — the leader is lost.');
  selected.delete(a); a.group = null; // drop the fallen from any selection/squad
  spawnSparks(a.obj.position.clone().setY(2), 0x9adcff, 14);
  if (!(a.char && a.char.borrowed)) waveLosses++; // a fallen comrade docks your XP (a borrowed ally's blood is on their own ledger)
  if (commandPanelOpen) renderDeck(); // keep the live squad counts honest while you command
}

// Route a hit to the right handler based on which side the victim is on.
function damageCombatant(victim, dmg, attacker) {
  if (victim === player) {
    if (attacker && attacker.char) attacker.char.localStrike += 0.05; // drawing the player's blood trains the arm too
    damagePlayer(dmg, attacker.pos, attacker.heroTrait === 'guardbreaker');
    return;
  }
  const dir = new THREE.Vector3().subVectors(victim.pos, attacker.pos).setY(0);
  if (dir.lengthSq() > 1e-6) dir.normalize(); else dir.set(0, 0, 1);
  if (victim.team === 'ally') damageAlly(victim, dmg, dir, attacker);
  else damageEnemy(victim, dmg, dir, false, attacker);
}

function nearestEnemy(maxDist) {
  let best = null, bd = maxDist;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = e.pos.distanceTo(player.pos);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function damagePlayer(dmg, fromPos, pierceGuard) {
  if (!player.alive || player.iFrames) return;
  if (pierceGuard && player.blocking) {
    // a guardbreaker's blow goes straight through a raised guard
    spawnPopup(player.obj.position.clone().setY(2.2), 'GUARD PIERCED', '#ff9b4d');
  }
  // directional block: a raised guard negates frontal hits at a stamina cost
  if (player.blocking && !pierceGuard) {
    tmpV.subVectors(fromPos, player.pos).setY(0).normalize();
    const fdir = new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing));
    if (fdir.dot(tmpV) > 0.2) {
      const clangPos = player.obj.position.clone().addScaledVector(tmpV, 1.1).setY(1.6);
      const blockCost = Math.ceil(12 / (player.char ? player.char.guardEff : 1)); // a trained guard tires slower
      if (player.stamina >= blockCost) {
        player.stamina -= blockCost;
        if (player.char) player.char.localGuard += 0.08; // a clean block hones the guard
        spawnSparks(clangPos, 0xcfe8ff, 10);
        spawnPopup(player.obj.position.clone().setY(2.2), 'BLOCKED', '#9adcff');
        player.vel.addScaledVector(tmpV.negate(), 3); // shove, no damage
        addShake(0.28); addHitstop(0.04); SFX.clang(clangPos); // steel-on-steel clang
        updateHUD();
        return;
      }
      // stamina exhausted: guard break — partial damage and a heavy stagger
      player.stamina = 0;
      dmg = Math.ceil(dmg * 0.6);
      spawnSparks(clangPos, 0xffaa66, 12);
      spawnPopup(player.obj.position.clone().setY(2.2), 'GUARD BREAK', '#ffb066');
      player.vel.addScaledVector(tmpV.negate(), 5);
      addShake(0.55); SFX.clang(clangPos, true); // heavy clang as the guard caves
    }
  }
  player.hp -= dmg;
  player.hurtFlash = 0.25;
  flashDamage(0.45 + dmg / 25); // heavier hits flood more red
  addShake(0.5); addHitstop(0.07);
  // don't let the flinch replace an in-progress swing
  if (!player.attacking) setPose(player.anim, 'hurt', 0.06);
  spawnPopup(player.obj.position.clone().setY(2), String(dmg), '#ff7b7b');
  // small knockback
  tmpV.subVectors(player.pos, fromPos).setY(0).normalize();
  player.vel.addScaledVector(tmpV, 5);
  // reset combo on hit
  player.combo = 0; player.comboTimer = 0; hideCombo();
  if (player.hp <= 0) { player.hp = 0; doGameOver(); }
  updateHUD();
}

// ---------- Pack director ----------
// Wolf-pack tactics: the 2 enemies best-placed to fight engage the player head-on;
// everyone else becomes a flanker that circles to a slot in the player's rear arc
// and only commits to a strike once it's actually behind them (where blocks can't reach).
const MAX_ATTACKERS_PER_VICTIM = 2; // nobody joins a fight that already has two attackers
const playerFwd = new THREE.Vector3(0, 0, 1); // refreshed each frame in resolveTargets

function assignPackRoles(pack) {
  // slot-holders press the player; waiting overflow becomes the circling flankers
  const flankers = [];
  for (const e of pack) {
    e.role = e.waiting ? 'flank' : 'engage';
    if (e.waiting) flankers.push(e);
  }
  // fan flankers across the rear arc, assigning slots by current bearing to minimise crossing
  const rear = player.facing + Math.PI;
  flankers.sort((a, b) =>
    angleDelta(rear, Math.atan2(a.pos.x - player.pos.x, a.pos.z - player.pos.z)) -
    angleDelta(rear, Math.atan2(b.pos.x - player.pos.x, b.pos.z - player.pos.z)));
  const n = flankers.length;
  for (let i = 0; i < n; i++) {
    // fan within ±63° of directly-behind — inside the dot<-0.25 "behind" gate (±75°)
    const off = n === 1 ? 0 : lerp(-1, 1, i / (n - 1)) * 1.1;
    flankers[i].slotAngle = rear + off;
  }
}

// ---------- Battle director: give every fighter a target each frame ----------
function nearestOf(pos, list, current, stick) {
  let best = null, bd = Infinity;
  for (const o of list) {
    if (!o.alive) continue;
    const d = pos.distanceTo(o.pos) - (o === current ? (stick || 0) : 0);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// stickiness: keep a fighter committed to its current duel/slot unless a foe is clearly closer
function distAdj(f, o) {
  let d = f.pos.distanceTo(o.pos);
  // stealth: a crouching player looks ~12 units farther, so enemies are slow to
  // pick him and prefer the (visible) warband — lets you flank into the backline
  if (o === player && player.crouching) d += 12;
  if (f.target === o) d -= 0.8;
  if (f.slotOn === o) d -= 1.2;
  return d;
}

// Greedy nearest-with-capacity assignment: each victim accepts at most `cap`
// committed attackers; extras first spread to another foe with a free slot,
// and only if every duel is full do they mark `waiting` and hold back.
function assignSide(fighters, opponents, cap) {
  if (!opponents.length) {
    for (const f of fighters) { f.target = null; f.slotOn = null; f.waiting = false; }
    return;
  }
  const counts = new Map();
  // closer fighters claim slots first — keys precomputed once, not inside the comparator
  for (const f of fighters) {
    let bd = Infinity;
    for (const o of opponents) { const d = distAdj(f, o); if (d < bd) bd = d; }
    f._claimKey = bd;
  }
  const order = fighters.slice().sort((a, b) => a._claimKey - b._claimKey);
  for (const f of order) {
    if (f.def.ranged) {
      // ranged units shoot from afar — they don't crowd a victim, so they ignore
      // the melee duel cap: always lock the nearest foe, never "wait", never take a slot
      let best = null, bd = Infinity;
      for (const o of opponents) { const d = distAdj(f, o); if (d < bd) { bd = d; best = o; } }
      f.target = best; f.slotOn = null; f.waiting = false;
      continue;
    }
    let bestFree = null, bdFree = Infinity, bestAny = null, bdAny = Infinity;
    for (const o of opponents) {
      const d = distAdj(f, o);
      if (d < bdAny) { bdAny = d; bestAny = o; }
      if ((counts.get(o) || 0) < cap && d < bdFree) { bdFree = d; bestFree = o; }
    }
    if (bestFree) {
      f.target = bestFree; f.slotOn = bestFree; f.waiting = false;
      counts.set(bestFree, (counts.get(bestFree) || 0) + 1);
    } else {
      f.target = bestAny; f.slotOn = null; f.waiting = true;
    }
  }
}

function resolveTargets() {
  playerFwd.set(Math.sin(player.facing), 0, Math.cos(player.facing));
  const liveEnemies = [], liveAllies = [];
  for (const e of enemies) if (e.alive && e.state !== 'dead') liveEnemies.push(e);
  for (const a of allies) if (a.alive && a.state !== 'dead') liveAllies.push(a);

  // both sides obey the duel cap: at most 2 attackers commit to any one victim
  assignSide(liveAllies, liveEnemies, MAX_ATTACKERS_PER_VICTIM);
  const oppOfEnemies = player.alive ? [player, ...liveAllies] : liveAllies;
  assignSide(liveEnemies, oppOfEnemies, MAX_ATTACKERS_PER_VICTIM);

  // wolf-pack flanking applies to those squared up against the player
  assignPackRoles(liveEnemies.filter(e => e.target === player));
}

// ---------- Generic melee fighter (shared by allies + enemies) ----------
const opposingPlayerSide = []; // player + living allies — what an enemy strike can hit
function refreshOpposingPlayerSide() {
  opposingPlayerSide.length = 0;
  if (player.alive) opposingPlayerSide.push(player);
  for (const a of allies) if (a.alive) opposingPlayerSide.push(a);
}
// archers sheathe the bow and draw a sidearm sword in melee, and back again at range
function setRangedMode(f, ranged) {
  const melee = !ranged;
  if (f.meleeMode === melee) return;
  f.meleeMode = melee;
  const p = f.parts;
  if (p.bow) { // only true archers have a bow to swap; throwers keep the rock in hand
    p.bow.visible = ranged;
    if (p.sword) p.sword.visible = melee;
  }
}
function fighterStrike(f) {
  const R = f.def.ranged;
  if (R && !f.meleeMode) {
    // loose the arrow / hurl the rock at the assigned target
    setPose(f.anim, R.kind === 'arrow' ? 'looseBow' : 'strikeOver', 0.08);
    if (f.target && f.target.alive) { spawnProjectile(f, f.target, R); SFX.bow(f.pos); }
    return;
  }
  const mv = MOVES[f.move];
  setPose(f.anim, mv.strike, 0.08);
  spawnSlashArc(f.pos, f.facing, mv, f.def.scale, f.team === 'ally' ? 0xcfe8ff : 0xffb09a);
  SFX.swing(f.pos); // distance-gated whoosh from the surrounding melee
  const fdir = new THREE.Vector3(Math.sin(f.facing), 0, Math.cos(f.facing));
  const reach = f.def.range + f.def.scale * 0.6;
  // cleave: hit every opposing combatant in the frontal arc
  const foes = f.team === 'ally' ? enemies : opposingPlayerSide;
  for (const t of foes) {
    if (!t.alive) continue;
    const to = new THREE.Vector3().subVectors(t.pos, f.pos).setY(0);
    const d = to.length();
    if (d > reach + ((t.def ? t.def.scale : 1) - 1)) continue;
    if (d > 0.001) to.normalize();
    if (fdir.dot(to) < 0.2) continue;
    damageCombatant(t, f.aura ? Math.round(f.def.dmg * f.aura.dmgMul) : f.def.dmg, f);
  }
  if (f.team === 'enemy') { // enemy swings near the player rumble the camera even on a miss
    const pd = f.pos.distanceTo(player.pos);
    if (pd < 8) addShake(0.12 * (1 - pd / 8) * f.def.scale);
  }
}

function stepFighter(f, dt) {
  if (f.flash > 0) { f.flash -= dt; setTint(f.parts, f.flash > 0 ? (f.team === 'ally' ? 0x99aacc : 0x887766) : null); }

  const tgt = f.target;
  const hasTgt = tgt && tgt.alive;
  let dist = Infinity, desiredFacing = f.facing;
  if (hasTgt) {
    const to = tmpV.subVectors(tgt.pos, f.pos); to.y = 0;
    dist = to.length();
    if (dist > 0.001) to.normalize();
    desiredFacing = Math.atan2(to.x, to.z);
  }
  f.cd -= dt;
  f.moving = false;
  // poise recovers while not reeling — so accumulated chip-stagger needs sustained pressure
  if (!f.staggered && f.poise < f.maxPoise) f.poise = Math.min(f.maxPoise, f.poise + FEEL.poiseRegen * dt);
  const atkRange = f.def.range + f.def.scale * 0.4;
  const isPlayerPack = f.team === 'enemy' && tgt === player;

  if (f.state === 'hurt') {
    f.timer -= dt;
    if (f.timer <= 0) { f.state = 'chase'; f.staggered = false; }
  } else if (f.state === 'windup') {
    if (hasTgt) f.facing = angleLerp(f.facing, desiredFacing, dt * 3);
    f.timer -= dt;
    if (f.timer <= 0) { fighterStrike(f); f.state = 'recover'; f.timer = f.def.atkRec; }
  } else if (f.state === 'recover') {
    f.timer -= dt;
    if (f.timer < f.def.atkRec * 0.5) setPose(f.anim, 'guard', 0.3);
    if (f.timer <= 0) { f.state = 'chase'; f.cd = f.def.cd; }
  } else { // chase
    setPose(f.anim, 'guard', 0.25);
    const cmd = f.team === 'ally' ? f.order : 'free';
    if (cmd === 'hold' && f.holdPos) {
      // COMMANDED HOLD: march to the assigned ground, then fight only what enters range
      const hd = f.pos.distanceTo(f.holdPos);
      if (hd > 2.0) {
        const mv = sfA.subVectors(f.holdPos, f.pos).setY(0);
        if (mv.lengthSq() > 0) mv.normalize();
        mv.addScaledVector(separation(f), 0.7); if (mv.lengthSq() > 1e-4) mv.normalize();
        f.vel.addScaledVector(mv, f.def.speed * paceFactor(f, hd) * dt * 6); // march/rush to the position
        f.facing = angleLerp(f.facing, Math.atan2(mv.x, mv.z), dt * 8);
        f.walkPhase += dt * f.def.speed * 1.6; f.moving = true;
      } else {
        const foe = nearestOpponentOf(f), R = f.def.ranged;
        if (foe) {
          const fd = f.pos.distanceTo(foe.pos), reach = R ? R.range : atkRange;
          f.facing = angleLerp(f.facing, Math.atan2(foe.pos.x - f.pos.x, foe.pos.z - f.pos.z), dt * 6);
          if (fd <= reach && f.cd <= 0) {
            f.target = foe;
            if (R) { setRangedMode(f, true); f.state = 'windup'; f.timer = f.def.atkWind; f.hitDone = false; setPose(f.anim, R.kind === 'arrow' ? 'aimBow' : 'windupOver', Math.min(f.def.atkWind * 0.6, 0.22)); }
            else { f.state = 'windup'; f.timer = f.def.atkWind; f.hitDone = false; f.move = f.def.moves[(Math.random() * f.def.moves.length) | 0]; setPose(f.anim, MOVES[f.move].windup, Math.min(f.def.atkWind * 0.45, 0.16)); }
          } else { if (R) setRangedMode(f, true); restLegs(f.parts, dt, true); }
        } else restLegs(f.parts, dt, true);
      }
    } else if (cmd === 'zone' && f.zone) {
      // COMMANDED HOLD-ZONE: garrison a rectangle. Archers/throwers loose at anything within
      // weapon range without leaving the zone; melee engage only what enters it, then fall back in.
      const z = f.zone, R = f.def.ranged;
      const foe = R ? nearestOpponentOf(f) : nearestFoeInRect(f, z, ZONE_LEASH);
      const reach = R ? R.range : atkRange;
      const fd = foe ? f.pos.distanceTo(foe.pos) : Infinity;
      if (foe && fd <= reach) {
        // in range — face the foe and strike (ranged units shoot from where they stand)
        f.facing = angleLerp(f.facing, Math.atan2(foe.pos.x - f.pos.x, foe.pos.z - f.pos.z), dt * 6);
        if (f.cd <= 0) {
          f.target = foe;
          if (R) { setRangedMode(f, true); f.state = 'windup'; f.timer = f.def.atkWind; f.hitDone = false; setPose(f.anim, R.kind === 'arrow' ? 'aimBow' : 'windupOver', Math.min(f.def.atkWind * 0.6, 0.22)); }
          else { f.state = 'windup'; f.timer = f.def.atkWind; f.hitDone = false; f.move = f.def.moves[(Math.random() * f.def.moves.length) | 0]; setPose(f.anim, MOVES[f.move].windup, Math.min(f.def.atkWind * 0.45, 0.16)); }
        } else { if (R) setRangedMode(f, true); restLegs(f.parts, dt, true); }
      } else if (!R && foe && fd > reach * 0.9) { // melee only: step onto the intruder (ZONE_LEASH keeps it from chasing off the field)
        const mv = sfA.subVectors(foe.pos, f.pos).setY(0);
        if (mv.lengthSq() > 0) mv.normalize();
        mv.addScaledVector(separation(f), 0.7); if (mv.lengthSq() > 1e-4) mv.normalize();
        f.vel.addScaledVector(mv, f.def.speed * paceFactor(f, fd) * dt * 6);
        f.walkPhase += dt * f.def.speed * 1.6; f.moving = true;
      } else {
        // nothing to engage in range — march/rush back to the assigned slot and stand the watch
        if (R) setRangedMode(f, true);
        const home = f.homeSlot || sfB.set((z.minX + z.maxX) / 2, 0, (z.minZ + z.maxZ) / 2);
        const hd = f.pos.distanceTo(home);
        if (hd > 1.6) {
          const mv = sfA.subVectors(home, f.pos).setY(0);
          if (mv.lengthSq() > 0) mv.normalize();
          mv.addScaledVector(separation(f), 0.7); if (mv.lengthSq() > 1e-4) mv.normalize();
          f.vel.addScaledVector(mv, f.def.speed * paceFactor(f, hd) * dt * 6);
          f.facing = angleLerp(f.facing, Math.atan2(mv.x, mv.z), dt * 8);
          f.walkPhase += dt * f.def.speed * 1.6; f.moving = true;
        } else { f.facing = angleLerp(f.facing, BATTLE_FRONT, dt * 4); restLegs(f.parts, dt, true); }
      }
    } else if (!hasTgt) {
      // no foe in sight: free allies regroup on the player; attack-movers press the front; enemies idle
      if (f.team === 'ally' && cmd === 'attackmove') {
        const mv = sfA.set(Math.sin(BATTLE_FRONT), 0, Math.cos(BATTLE_FRONT)).addScaledVector(separation(f), 1.0);
        if (mv.lengthSq() > 1e-4) mv.normalize();
        f.vel.addScaledVector(mv, f.def.speed * paceFactor(f, Infinity) * dt * 6); // attack-move: march, or rush full-speed
        f.facing = angleLerp(f.facing, BATTLE_FRONT, dt * 6);
        f.walkPhase += dt * f.def.speed * 1.6; f.moving = true;
      } else if (f.team === 'ally' && player.alive) {
        const pd = f.pos.distanceTo(player.pos);
        if (pd > 4.5) {
          const mv = new THREE.Vector3().subVectors(player.pos, f.pos).setY(0).normalize();
          f.vel.addScaledVector(mv, f.def.speed * 0.7 * dt * 6);
          f.walkPhase += dt * f.def.speed * 1.4; f.moving = true;
        }
      }
      if (!f.moving) restLegs(f.parts, dt, true);
    } else {
      f.facing = angleLerp(f.facing, desiredFacing, dt * 6);
      // attack discipline: a waiting fighter NEVER starts an attack — its victim
      // already has two committed attackers; it holds position until a slot frees
      let aggressive = !f.waiting, behind = false;
      if (isPlayerPack && aggressive) {
        const fromP = tmpV2.subVectors(f.pos, player.pos).setY(0);
        const distP = fromP.length();
        if (distP > 0.001) fromP.normalize();
        behind = playerFwd.dot(fromP) < -0.25;
        aggressive = f.role === 'engage' || behind;
      }
      const R = f.def.ranged;
      if (R) {
        // skirmisher: advance only until the shot is there, kite anyone who closes in
        const threatD = nearestOpponentDist(f);
        const meleeRange = f.def.range + f.def.scale * 0.4;
        if (threatD <= meleeRange + 0.8) {
          // cornered: draw the sidearm and fight in melee instead of fleeing
          setRangedMode(f, false);
          const foe = nearestOpponentOf(f);
          if (foe) f.facing = angleLerp(f.facing, Math.atan2(foe.pos.x - f.pos.x, foe.pos.z - f.pos.z), dt * 8);
          const fdist = foe ? f.pos.distanceTo(foe.pos) : Infinity;
          if (fdist <= meleeRange && f.cd <= 0) {
            f.state = 'windup'; f.timer = f.def.atkWind; f.hitDone = false; f.move = 'slashR';
            setPose(f.anim, MOVES.slashR.windup, Math.min(f.def.atkWind * 0.45, 0.16));
          } else if (foe && fdist > meleeRange * 0.85) {
            const mv = sfA.subVectors(foe.pos, f.pos).setY(0);
            if (mv.lengthSq() > 0) mv.normalize();
            mv.addScaledVector(separation(f), 1.2).normalize();
            f.vel.addScaledVector(mv, f.def.speed * dt * 6);
            f.walkPhase += dt * f.def.speed * 1.6; f.moving = true;
          }
        } else if (threatD < R.minRange) {
          // a melee threat is closing but not yet on us — kite back to shooting range
          setRangedMode(f, true);
          const away = sfA.subVectors(f.pos, nearestOpponentOf(f).pos).setY(0);
          if (away.lengthSq() > 0) away.normalize();
          away.addScaledVector(separation(f), 0.8).normalize();
          f.vel.addScaledVector(away, f.def.speed * 0.9 * dt * 6);
          f.walkPhase += dt * f.def.speed * 1.4; f.moving = true;
        } else if (setRangedMode(f, true), dist > R.range) {
          // close to firing range — no further
          const mv = sfA.subVectors(tgt.pos, f.pos).setY(0);
          if (mv.lengthSq() > 0) mv.normalize();
          mv.addScaledVector(separation(f), 1.0).normalize();
          f.vel.addScaledVector(mv, f.def.speed * dt * 6);
          f.walkPhase += dt * f.def.speed * 1.6; f.moving = true;
        } else if (f.cd <= 0) {
          // in range and off cooldown: draw and loose (ranged units never "wait")
          f.state = 'windup'; f.timer = f.def.atkWind; f.hitDone = false;
          setPose(f.anim, R.kind === 'arrow' ? 'aimBow' : 'windupOver', Math.min(f.def.atkWind * 0.6, 0.22));
        } else {
          // in range, between shots (or duel cap full): drift laterally
          const fromT = tmpV2.subVectors(f.pos, tgt.pos).setY(0);
          if (fromT.lengthSq() > 1e-6) fromT.normalize();
          const curAng = Math.atan2(fromT.x, fromT.z);
          const mv = sfA.set(Math.cos(curAng), 0, -Math.sin(curAng)).multiplyScalar(f.strafeDir * 0.4)
            .addScaledVector(separation(f), 1.0);
          if (mv.lengthSq() > 1e-4) {
            mv.normalize();
            f.vel.addScaledVector(mv, f.def.speed * 0.5 * dt * 6);
            f.walkPhase += dt * f.def.speed * 0.8; f.moving = true;
          }
        }
      } else if (aggressive && dist <= atkRange && f.cd <= 0) {
        f.state = 'windup'; f.timer = f.def.atkWind; f.hitDone = false;
        f.move = f.def.moves[Math.floor(Math.random() * f.def.moves.length)];
        setPose(f.anim, MOVES[f.move].windup, Math.min(f.def.atkWind * 0.45, 0.16));
      } else if (aggressive) {
        if (dist > atkRange * 0.85) { // close in — march across the field (or rush), full-speed charge near contact
          const mv = sfA.subVectors(tgt.pos, f.pos).setY(0);
          if (mv.lengthSq() > 0) mv.normalize();
          mv.addScaledVector(separation(f), 1.2).normalize();
          f.vel.addScaledVector(mv, f.def.speed * paceFactor(f, dist) * dt * 6);
          f.walkPhase += dt * f.def.speed * 1.6; f.moving = true;
        }
      } else if (isPlayerPack) {
        // flank: orbit toward the assigned rear slot around the player
        const radius = 3.6 * f.def.scale;
        const fromP = tmpV2.subVectors(f.pos, player.pos).setY(0);
        const distP = fromP.length();
        if (distP > 0.001) fromP.normalize();
        const curAng = Math.atan2(fromP.x, fromP.z);
        const angErr = angleDelta(curAng, f.slotAngle);
        const radial = sfB.copy(fromP).multiplyScalar(-clamp(distP - radius, -1.2, 1.2));
        const mv = sfA.set(Math.cos(curAng), 0, -Math.sin(curAng))
          .multiplyScalar((Math.sign(angErr) || 1) * clamp(Math.abs(angErr) * 1.6, 0, 1))
          .add(radial).addScaledVector(separation(f), 1.0);
        if (mv.lengthSq() > 1e-4) mv.normalize();
        f.vel.addScaledVector(mv, f.def.speed * 0.92 * dt * 6);
        f.walkPhase += dt * f.def.speed * 1.4; f.moving = true;
      } else {
        // waiting on a full duel: hold a slow standoff orbit around it until a slot frees
        const radius = 3.4 * f.def.scale;
        const fromT = tmpV2.subVectors(f.pos, tgt.pos).setY(0);
        const distT = fromT.length();
        if (distT > 0.001) fromT.normalize();
        const curAng = Math.atan2(fromT.x, fromT.z);
        const radial = sfB.copy(fromT).multiplyScalar(-clamp(distT - radius, -1.2, 1.2));
        const mv = sfA.set(Math.cos(curAng), 0, -Math.sin(curAng))
          .multiplyScalar(f.strafeDir * 0.45)
          .add(radial).addScaledVector(separation(f), 1.0);
        if (mv.lengthSq() > 1e-4) mv.normalize();
        f.vel.addScaledVector(mv, f.def.speed * 0.75 * dt * 6);
        f.walkPhase += dt * f.def.speed * 1.1; f.moving = true;
      }
    }
  }

  // physics
  f.vel.multiplyScalar(Math.pow(0.0008, dt));
  f.pos.addScaledVector(f.vel, dt);
  confine(f.pos);
  f.obj.position.copy(f.pos);
  f.obj.rotation.y = f.facing;

  // crowd LOD: distant fighters animate every 3rd frame, far ones hold their
  // pose entirely — AI and movement still run every frame for all of them
  if (f.lodOff === undefined) f.lodOff = (Math.random() * 3) | 0;
  const camD2 = f.pos.distanceToSquared(camera.position);
  const animate = camD2 < 1600 ? true                             // <40u: every frame
    : camD2 < 4900 ? ((frameNo + f.lodOff) % 3 === 0)             // <70u: third-frame
    : false;                                                      // beyond: static
  if (animate) {
    if (f.moving) {
      walkLegs(f.parts, f.walkPhase);
      f.obj.position.y = Math.abs(Math.cos(f.walkPhase)) * 0.05 * f.def.scale;
    } else {
      restLegs(f.parts, dt, true);
    }
    updateAnimator(f.anim, dt);
  }
  // health bar: hidden until first blood (heroes always show theirs)
  const hpFrac = clamp(f.hp / f.maxHp, 0, 1);
  f.bar.visible = (hpFrac < 1 || f.isHero) && camD2 < 4900;
  if (f.bar.visible) {
    f.bar.lookAt(camera.position);
    f.bar.userData.fill.scale.x = hpFrac;
    f.bar.userData.fill.position.x = -(1 - hpFrac) * 0.75;
  }
}

function deathStep(f, dt) {
  f.deadT += dt;
  f.obj.rotation.z = lerp(f.obj.rotation.z, Math.PI / 2, clamp(f.deadT * 4, 0, 1));
  f.obj.position.y = -clamp((f.deadT - 0.6) * 1.5, 0, 3);
  return f.deadT > 2.2;
}

function updateEnemies(dt) {
  refreshOpposingPlayerSide();
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e.alive) {
      if (deathStep(e, dt)) { scene.remove(e.obj); disposeGroup(e.obj); enemies.splice(i, 1); }
      continue;
    }
    stepFighter(e, dt);
  }
}
// resolve each squad's living leader and stamp its aura onto the squad. Runs per frame so a leader's
// death drops the buff the same instant; HP grit is steeled once, the first frame a soldier is led.
function applyLeadershipAuras() {
  for (const a of allies) if (a.alive) a.aura = null;
  for (const g of planGroups) {
    g.leaderAlive = false;
    if (g.leaderId == null) continue;
    let leaderChar = null;
    if (playerChar && g.leaderId === playerChar.id) { if (player.alive) leaderChar = playerChar; }
    else { const body = allies.find(a => a.alive && a.char && a.char.id === g.leaderId); if (body) leaderChar = body.char; }
    if (!leaderChar) continue;                 // leader fell / not on the field → squad fights unbuffed
    g.leaderAlive = true;
    const aura = leadAura(leaderChar);
    if (!aura) continue;
    for (const a of allies) {
      if (!a.alive || a.group !== g.id) continue;
      a.aura = aura;
      if (!a.auraHpApplied) { a.maxHp = Math.round(a.maxHp * aura.hpMul); a.hp = Math.round(a.hp * aura.hpMul); a.auraHpApplied = true; }
    }
  }
}
function updateAllies(dt) {
  applyLeadershipAuras();
  for (let i = allies.length - 1; i >= 0; i--) {
    const a = allies[i];
    if (!a.alive) {
      if (deathStep(a, dt)) { scene.remove(a.obj); disposeGroup(a.obj); allies.splice(i, 1); }
      continue;
    }
    stepFighter(a, dt);
  }
}

// nearest living opponent (any, not just the assigned target) — what a skirmisher kites from
function nearestOpponentOf(f) {
  const foes = f.team === 'ally' ? enemies : opposingPlayerSide;
  let best = null, bd = Infinity;
  for (const o of foes) {
    if (!o.alive) continue;
    const d = f.pos.distanceTo(o.pos);
    if (d < bd) { bd = d; best = o; }
  }
  return best || f.target;
}
function nearestOpponentDist(f) {
  const o = nearestOpponentOf(f);
  return o ? f.pos.distanceTo(o.pos) : Infinity;
}
// nearest foe sitting inside a zone-holder's rectangle (expanded by margin m) — what it defends against
function nearestFoeInRect(f, z, m) {
  const foes = f.team === 'ally' ? enemies : opposingPlayerSide;
  let best = null, bd = Infinity;
  for (const o of foes) {
    if (!o.alive) continue;
    if (o.pos.x < z.minX - m || o.pos.x > z.maxX + m || o.pos.z < z.minZ - m || o.pos.z > z.maxZ + m) continue;
    const d = f.pos.distanceTo(o.pos);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// everyone avoids stacking — keeps the melee from collapsing into a single pile.
// A uniform spatial grid (rebuilt once per frame) makes this O(n) instead of
// O(n²), which is what lets armies grow into the hundreds.
// separation() returns a SHARED scratch vector: consume it immediately.
const sepV = new THREE.Vector3();
const sepGrid = new Map();
const SEP_CELL = 2.2;
function rebuildSepGrid() {
  sepGrid.clear();
  const put = (o) => {
    if (!o.alive) return;
    const k = Math.floor(o.pos.x / SEP_CELL) * 4096 + Math.floor(o.pos.z / SEP_CELL);
    let arr = sepGrid.get(k);
    if (!arr) { arr = []; sepGrid.set(k, arr); }
    arr.push(o);
  };
  for (const e of enemies) put(e);
  for (const a of allies) put(a);
  if (player.alive) put(player);
}
function separation(self) {
  sepV.set(0, 0, 0);
  const cx = Math.floor(self.pos.x / SEP_CELL), cz = Math.floor(self.pos.z / SEP_CELL);
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const arr = sepGrid.get(gx * 4096 + gz);
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (o === self || !o.alive) continue;
        const d2 = self.pos.distanceToSquared(o.pos);
        if (d2 < 4.84 && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          sepV.add(tmpV.subVectors(self.pos, o.pos).setY(0).normalize().multiplyScalar((2.2 - d) / 2.2));
        }
      }
    }
  }
  return sepV;
}

// ---------- Player update ----------
function updatePlayer(dt) {
  if (!player.alive) return;
  const p = player.parts;

  // stamina regen (slower while holding a block)
  player.blocking = false;
  player.stamina = clamp(player.stamina + dt * ((keys['ShiftLeft'] || keys['ShiftRight']) ? 9 : 22), 0, player.maxStam);
  if (player.hurtFlash > 0) player.hurtFlash -= dt;
  if (player.cooldown > 0) player.cooldown -= dt;
  if (player.comboTimer > 0) { player.comboTimer -= dt; if (player.comboTimer <= 0) { player.combo = 0; hideCombo(); } }

  let walking = false;
  player.crouching = false; // only the normal-movement branch may re-enable it

  if (player.rolling) {
    player.rollT += dt;
    const k = player.rollT / player.rollDur;
    player.iFrames = k < 0.7;
    const rollSpeed = player.speed * 1.9 * (1 - k * 0.4);
    player.vel.copy(player.rollDir).multiplyScalar(rollSpeed);
    player.facing = Math.atan2(player.rollDir.x, player.rollDir.z);
    // forward roll spin + tucked legs
    player.obj.rotation.x = Math.sin(k * Math.PI) * -1.2;
    const s = clamp(dt * 14, 0, 1);
    p.hipL.rotation.x = lerp(p.hipL.rotation.x, -1.3, s);
    p.hipR.rotation.x = lerp(p.hipR.rotation.x, -1.3, s);
    p.kneeL.rotation.x = lerp(p.kneeL.rotation.x, 2.1, s);
    p.kneeR.rotation.x = lerp(p.kneeR.rotation.x, 2.1, s);
    if (k >= 1) { player.rolling = false; player.iFrames = false; player.obj.rotation.x = 0; }
  } else {
    player.obj.rotation.x = 0;
    const dir = inputDir();
    const aimYaw = cameraAngle + Math.PI; // where the mouse points
    const locked = pointerLocked || BV.fakeLock; // fakeLock: automated-test hook
    if (player.shooting) {
      // bow: draw, then loose an arrow toward the aim (rooted while drawing)
      player.shootT += dt;
      const k = player.shootT / player.shootDur;
      if (locked) player.facing = angleLerp(player.facing, aimYaw, dt * 12);
      if (!player.shotReleased && k >= 0.55) {
        setPose(player.anim, 'looseBow', 0.06);
        spawnProjectile({ pos: player.pos, def: { scale: 1, dmg: PLAYER_BOW_DMG + (player.char ? player.char.dmgBonus : 0) }, team: 'ally', char: player.char },
          playerBowTarget(), PLAYER_BOW_RANGED);
        addShake(0.06); SFX.bow();
        player.shotReleased = true;
      }
      if (k >= 1) { player.shooting = false; player.cooldown = 0.12; }
      restLegs(p, dt, true);
    } else if (player.heavy) {
      // committed heavy: long wind-up telegraph → a wide cleave that fans the crowd out
      player.attackT += dt;
      const k = player.attackT / FEEL.heavyDur;
      if (player.attackPhase === 0) { setPose(player.anim, 'windupHeavy', 0.12); player.attackPhase = 1; }
      if (player.attackPhase === 1 && k >= 0.5) {
        setPose(player.anim, 'strikeHeavy', 0.07);
        spawnSlashArc(player.pos, player.facing, MOVES.heavy, 1.7, 0xffd27a); // big golden arc
        spawnTrail(player, 1.7, 0xffd27a);
        addShake(0.16); SFX.swing();
        player.attackPhase = 2;
      }
      if (player.attackPhase === 2 && k >= 0.82) { setPose(player.anim, 'guard', 0.30); player.attackPhase = 3; }
      // a big committed lunge as the blade comes down
      if (k > 0.5 && k < 0.66) player.vel.addScaledVector(new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing)), player.speed * 3 * dt * 6);
      // wide cleave fires once, just after the telegraph
      if (!player.hitDone && k > 0.54 && k < 0.74) { heavyHitCheck(); player.hitDone = true; }
      if (k >= 1) { player.heavy = false; player.attacking = false; player.cooldown = 0.2; }
      // steer during the wind-up only: face the mouse aim, else the nearest cluster
      if (k < 0.5) {
        if (locked) player.facing = angleLerp(player.facing, aimYaw, dt * 8);
        else { const th = nearestEnemy(9); if (th) player.facing = angleLerp(player.facing, Math.atan2(th.pos.x - player.pos.x, th.pos.z - player.pos.z), dt * 6); }
      }
      restLegs(p, dt, true);
    } else if (player.attacking && (keys['ShiftLeft'] || keys['ShiftRight'])) {
      // block-cancel: bail out of the swing into a raised guard immediately
      player.attacking = false; player.queued = false; player.cooldown = 0.05;
      player.blocking = true; // protects against a strike landing this same frame
      setPose(player.anim, 'block', 0.08);
      restLegs(p, dt, true);
    } else if (player.attacking) {
      player.attackT += dt;
      // fatigue stretches the whole swing (atkScale >= 1)
      const k = player.attackT / (player.attackDur * player.atkScale);
      const mv = MOVES[player.move];
      // sharp guard transitions: windup snap → hold → strike whip → settle
      if (player.attackPhase === 0) { setPose(player.anim, mv.windup, 0.10 * player.atkScale); player.attackPhase = 1; }
      if (player.attackPhase === 1 && k >= 0.38) {
        setPose(player.anim, mv.strike, 0.085);
        spawnSlashArc(player.pos, player.facing, mv, 1, 0xfff2c8);
        spawnTrail(player, 1.7, 0xfff2c8); // bright ribbon whips off the blade
        addShake(0.09); SFX.swing(); // swing whoosh
        player.attackPhase = 2;
      }
      if (player.attackPhase === 2 && k >= 0.74) {
        if (player.queued) {
          startAttack(); // chain straight from the follow-through into the next windup
        } else {
          // settle back to guard gently — a sharp snap here reads as a phantom block
          setPose(player.anim, 'guard', 0.30); player.attackPhase = 3;
        }
      }
      // lunge with the strike
      if (k > 0.3 && k < 0.5) player.vel.addScaledVector(new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing)), player.speed * 2 * dt * 6);
      // hit window rides the strike snap
      if (!player.hitDone && k > 0.42 && k < 0.66) { playerHitCheck(); player.hitDone = true; }
      if (k >= 1) {
        player.attacking = false; player.cooldown = 0.04;
        if (player.queued) startAttack();
      }
      // track the acquired target; otherwise swing where the mouse points
      const tgt = player.aimTarget;
      if (tgt && tgt.alive && k < 0.6) {
        player.facing = angleLerp(player.facing,
          Math.atan2(tgt.pos.x - player.pos.x, tgt.pos.z - player.pos.z), dt * 12);
      } else if (locked) {
        player.facing = angleLerp(player.facing, aimYaw, dt * 10);
      } else if (dir.lengthSq() > 0) {
        player.facing = angleLerp(player.facing, Math.atan2(dir.x, dir.z), dt * 4);
      }
      restLegs(p, dt, true);
    } else if (keys['ShiftLeft'] || keys['ShiftRight']) {
      // hold-to-block: sword up, face the mouse aim (or the nearest threat), creep
      player.blocking = true;
      setPose(player.anim, 'block', 0.08);
      if (locked) {
        player.facing = angleLerp(player.facing, aimYaw, dt * 10);
      } else {
        const threat = nearestEnemy(9);
        if (threat) {
          player.facing = angleLerp(player.facing,
            Math.atan2(threat.pos.x - player.pos.x, threat.pos.z - player.pos.z), dt * 6);
        }
      }
      if (dir.lengthSq() > 0) {
        player.vel.addScaledVector(dir, player.speed * 0.35 * dt * 9);
        player.walkPhase += dt * 5;
        walkLegs(p, player.walkPhase, 0.3);
      } else {
        restLegs(p, dt, true);
      }
    } else {
      // hold C to crouch: duck under upper-body shots + sneak (slower, lower profile)
      player.crouching = !!keys['KeyC'];
      // hold the hurt flinch briefly, otherwise combat guard
      if (player.hurtFlash <= 0.05) setPose(player.anim, 'guard', 0.22);
      // mouse-locked: the mouse steers the character — facing always tracks the
      // aim, so W is forward, S backpedals, and A/D are true side-steps
      if (locked) player.facing = angleLerp(player.facing, aimYaw, dt * 14);
      const spd = player.crouching ? player.speed * 0.45 : player.speed;
      if (dir.lengthSq() > 0) {
        player.vel.addScaledVector(dir, spd * dt * 9);
        if (!locked) player.facing = angleLerp(player.facing, Math.atan2(dir.x, dir.z), dt * 12);
        // backpedaling plays the walk cycle in reverse
        const fwdDot = dir.x * Math.sin(player.facing) + dir.z * Math.cos(player.facing);
        player.walkPhase += dt * (player.crouching ? 6 : 10) * (fwdDot < -0.1 ? -1 : 1);
        walkLegs(p, player.walkPhase, player.crouching ? 0.3 : 0.65, player.crouchT);
        walking = true;
      } else {
        restLegs(p, dt, true, player.crouchT);
      }
    }
  }

  // physics integrate
  player.vel.multiplyScalar(Math.pow(0.0001, dt));
  player.pos.addScaledVector(player.vel, dt);
  confine(player.pos);
  player.obj.position.copy(player.pos);
  if (walking) {
    player.obj.position.y = Math.abs(Math.cos(player.walkPhase)) * 0.06;
    // a footfall every half walk-cycle (one per foot)
    const stepIdx = Math.round(player.walkPhase / Math.PI);
    if (stepIdx !== player.lastStepIdx) { player.lastStepIdx = stepIdx; SFX.foot(); }
  }
  player.obj.rotation.y = player.facing;
  player.crouchT = lerp(player.crouchT, player.crouching ? 1 : 0, clamp(dt * 12, 0, 1));

  updateAnimator(player.anim, dt);
  // idle breathing on top of the pose
  if (!player.attacking && !player.rolling) {
    p.upperBody.rotation.x += Math.sin(elapsed * 2.4) * 0.018;
  }

  // crouch: knees break in walkLegs/restLegs (stable target); here we sink the
  // hips and lean the spine — both set absolutely each frame, so safe to add to
  if (player.crouchT > 0.001) {
    const ct = player.crouchT;
    player.obj.position.y -= 0.7 * ct;       // hips sink toward the folded legs
    // lean ramps gently at first, then HARD once the knees hit their limit —
    // a deep crouch tips the torso forward over the knees instead of sinking more
    const deep = Math.max(0, (ct - 0.4) / 0.6);
    p.upperBody.rotation.x += 0.22 * ct + 0.4 * deep;
    // hard floor: never let the fold clip the body through the ground
    const minY = _crouchBox.setFromObject(player.obj).min.y;
    if (minY < 0) player.obj.position.y -= minY; // lift so the lowest point rests at ground
  }

  // hurt tint
  setTint(player.parts, player.hurtFlash > 0 ? 0x992222 : null);

  updateFinisherMarker();
  updateHUD();
}

// ---------- Utility ----------
function confine(pos) {
  pos.x = clamp(pos.x, -ARENA + 1, ARENA - 1);
  pos.z = clamp(pos.z, -ARENA + 1, ARENA - 1);
  pos.y = 0;
}
function angleDelta(a, b) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function angleLerp(a, b, t) {
  return a + angleDelta(a, b) * clamp(t, 0, 1);
}
function setTint(parts, color) {
  // base emissive is stored on the MATERIAL (shared across meshes), not the mesh —
  // per-mesh storage poisons the restore value for every mesh after the first
  for (const k in parts) {
    const o = parts[k];
    if (!o) continue; // some slots (e.g. bow on a swordsman) are null
    o.traverse((c) => {
      if (c.isMesh && c.material && c.material.emissive && !c.material.userData.noTint) {
        const ud = c.material.userData;
        if (ud._baseEmissive === undefined) ud._baseEmissive = c.material.emissive.getHex();
        c.material.emissive.setHex(color === null ? ud._baseEmissive : color);
      }
    });
  }
}
function disposeGroup(g) {
  g.traverse((c) => {
    if (c.isSprite) { // hero name labels carry their own canvas texture
      if (c.material && !c.material.userData.cached) {
        if (c.material.map) c.material.map.dispose();
        c.material.dispose();
      }
      return;
    }
    if (!c.isMesh) return;
    // cached geometries/materials are shared across many objects — never dispose them
    if (c.geometry && !c.geometry.userData.cached) c.geometry.dispose();
    if (c.material && !c.material.userData.cached) {
      if (c.material.map) c.material.map.dispose();
      c.material.dispose();
    }
  });
}

// ---------- Camera ----------
const camBase = new THREE.Vector3(0, 12, 16); // smoothed follow position, pre-shake
function updateCamera(dt) {
  if (!pointerLocked) { // keyboard orbit fallback when the mouse isn't captured
    if (keys['KeyQ']) cameraAngle -= dt * 2;
    if (keys['KeyE']) cameraAngle += dt * 2;
  }
  // over-the-shoulder: shift the frame so the character sits left of center,
  // leaving room on the right where the sword swings
  const ox = Math.cos(cameraAngle) * 0.7, oz = -Math.sin(cameraAngle) * 0.7;
  const tx = player.pos.x + ox + Math.sin(cameraAngle) * cameraDist;
  const tz = player.pos.z + oz + Math.cos(cameraAngle) * cameraDist;
  camBase.x = lerp(camBase.x, tx, clamp(dt * 6, 0, 1));
  camBase.z = lerp(camBase.z, tz, clamp(dt * 6, 0, 1));
  camBase.y = lerp(camBase.y, cameraHeight, clamp(dt * 6, 0, 1));
  camera.position.copy(camBase);
  camera.lookAt(player.pos.x + ox, 1.7, player.pos.z + oz);
  if (trauma > 0) {
    trauma = Math.max(0, trauma - dt * 2.0);
    const sh = trauma * trauma;
    const t = rtNow * 30;
    camera.position.x += Math.sin(t) * sh * 0.5;
    camera.position.y += Math.cos(t * 1.31) * sh * 0.4;
    camera.position.z += Math.sin(t * 1.73) * sh * 0.35;
    camera.rotation.z += Math.sin(t * 1.13) * sh * 0.035;
  }
  // directional kick: a transient world-space shove that decays fast (recoil on impact)
  if (camKick.lengthSq() > 1e-6) {
    camera.position.add(camKick);
    camKick.multiplyScalar(clamp(1 - dt * FEEL.camKickDecay, 0, 1));
    if (camKick.lengthSq() < 1e-5) camKick.set(0, 0, 0);
  }
  // FOV punch: a quick zoom-in that snaps the weight of a heavy blow / kill
  if (fovPunch > 0.001) {
    fovPunch *= clamp(1 - dt * FEEL.fovDecay, 0, 1);
    if (fovPunch < 0.02) fovPunch = 0;
    camera.fov = CAM_BASE_FOV - fovPunch;
    camera.updateProjectionMatrix();
  } else if (camera.fov !== CAM_BASE_FOV) {
    camera.fov = CAM_BASE_FOV; camera.updateProjectionMatrix();
  }
}
// strategic overview: a high, steeply-tilted camera looking down on the warband token
function updateMapCamera(dt) {
  const k = clamp(dt * 4, 0, 1);
  const gy = mapElevY(player.pos.x, player.pos.z); // ride the relief so the cam clears hills and peaks
  // the vista zooms the eye-in-the-sky out as the world is explored — smoothed by the same lerp
  camBase.x = lerp(camBase.x, player.pos.x, k);
  camBase.y = lerp(camBase.y, gy + vlerp(VISTA.camLift), k);
  camBase.z = lerp(camBase.z, player.pos.z + vlerp(VISTA.camBack), k); // south offset = tilt, not pure top-down
  camera.position.copy(camBase);
  camera.lookAt(player.pos.x, gy, player.pos.z);
}

// ---------- Game state ----------
let wave = 0;             // battle counter
let enemiesRemaining = 0; // enemy bodies left to kill this battle (field + reserve)
let score = 0;
let gameRunning = false;  // true while a battle is actively simulating with the player alive
let betweenWaves = false, betweenTimer = 0; // (legacy, unused by the batch system)
let mode = 'menu';        // menu | map | battle | muster | gameover

// ---------- Overworld map + batched battles ----------
const MAP_HALF = 90;      // overworld half-size — much larger than a battle arena
const FIELD_CAP = 50;     // combatants PER SIDE on the field at once (≤100 bodies total)
const parties = [];       // roaming enemy bands on the map
let mapLevel = 0;         // rises each time you clear the map — bands get bigger
let universeSeed = 1;     // identifies THIS game universe — rerolled on refresh; mixes into worldSeed so terrain/capitals/diplomacy all differ run-to-run
let mapSpawnT = 0;        // timer for trickling fresh bands onto the map
let playerReserve = [], enemyReserve = []; // defs waiting to march into the battle
let battleParty = null;   // the map band currently being fought
let lastBattle = null;    // { size, raider } of the band you just beat — for the XP bounty
let encounter = null;     // { kind:'band'|'capital', band?, cap? } awaiting the player's choice
let siegeCapital = null;  // the hold being stormed in the current battle (for conquest on win)
let advanceRegion = false; // set when you take every hold — the next map is a fresh land
let coopMult = 1;          // coordination buff applied to your whole side this battle (allies answered)
let battleAllyBanners = 0, battleReinforced = 0; // how many allied banners / soldiers fight beside you this battle
let activeCall = null;     // an active Call to Arms / Crusade (Phase 4): { target, x, z, crusade, radius, ... }
const CALL_MUSTER_RADIUS = 130; // a standing Call pulls allied bands from this far (a crusade is map-wide)

// ---------- Coherent value noise: the world is generated, not scattered ----------
// Two smooth fields (elevation + moisture) plus latitude (temperature) drive a
// natural biome layout with soft transitions, seas, and coastlines.
const SEA_LEVEL = 0.38;
function _nHash(ix, iz, seed) { const h = Math.sin(ix * 127.1 + iz * 311.7 + seed * 53.7) * 43758.5453; return h - Math.floor(h); }
function _vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = _nHash(ix, iz, seed), b = _nHash(ix + 1, iz, seed), c = _nHash(ix, iz + 1, seed), d = _nHash(ix + 1, iz + 1, seed);
  return a * (1 - ux) * (1 - uz) + b * ux * (1 - uz) + c * (1 - ux) * uz + d * ux * uz;
}
function _fbm(x, z, seed) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < 4; o++) { v += amp * _vnoise(x * f, z * f, seed + o * 31); norm += amp; f *= 2; amp *= 0.5; }
  return v / norm;
}
const worldSeed = () => ((mapLevel * 1000 + 7) ^ (universeSeed * 2654435761)) >>> 0;
const TERR_SCALE = 1 / 42;
function elevationAt(x, z) {
  const base = _fbm((x + 1000) * TERR_SCALE, (z - 1000) * TERR_SCALE, worldSeed() + 1);
  // Broad seas, gulfs, and inland lakes are carved by a slow "continent" field instead of a
  // radial rim, so dry land continues forever in every direction (the old heartland was an
  // island walled off by ocean at the map edge). Peaks still rise from the base noise.
  const cont = _fbm((x - 4000) * TERR_SCALE * 0.20, (z + 4000) * TERR_SCALE * 0.20, worldSeed() + 5);
  return clamp(0.30 + base * 0.55 + (cont - 0.55) * 0.80, 0, 1);
}
function moistureAt(x, z) { return _fbm((x - 2200) * TERR_SCALE * 1.15, (z + 1700) * TERR_SCALE * 1.15, worldSeed() + 19); }
function tempAt(x, z) {
  // Heartland climate stays latitude-led (0 = frozen north, 1 = hot south) so the five powers
  // keep their themed homelands — desert south, tribal north. Out past the heartland it dissolves
  // into broad noise "provinces" so the frontier holds fresh climates instead of one endless band.
  // Altitude cools the highlands so peaks stay snowbound everywhere.
  const latBand = clamp((z + MAP_HALF) / (2 * MAP_HALF), 0, 1);
  const prov = _fbm((x + 9000) * 0.0016, (z - 9000) * 0.0016, worldSeed() + 71);
  const frontier = clamp((Math.hypot(x, z) - MAP_HALF) / (MAP_HALF * 3), 0, 1); // 0 heartland → 1 deep frontier
  const lat = latBand * (1 - frontier) + prov * frontier;
  return clamp(lat * 0.95 + 0.03 + _fbm(x * 0.025, z * 0.025, worldSeed() + 41) * 0.1 - elevationAt(x, z) * 0.18, 0, 1);
}
const isWater = (x, z) => elevationAt(x, z) < SEA_LEVEL;

// ---------- Biomes: classified from the fields, with battle backdrops ----------
const B = {
  OCEAN:    { name: 'Ocean',     water: true, ground: 0x16415f },
  SHALLOW:  { name: 'Coast',     water: true, ground: 0x2b7aa6 },
  BEACH:    { name: 'Coast',     ground: 0xddd2a0, pad: 0xc8bd86, fog: 0xd6e6ea, sky: 0xe3eef2, tree: 0x7a9a55, treeChance: 0.02, rockChance: 0.06 },
  GRASS:    { name: 'Grassland', ground: 0x6f9e54, pad: 0x8a6a45, fog: 0x9fc6e8, sky: 0x9fc6e8, tree: 0x4f8a3f, treeChance: 0.10, rockChance: 0.04 },
  SAVANNA:  { name: 'Savanna',   ground: 0x9a9c58, pad: 0x9a8a4f, fog: 0xcfd2a0, sky: 0xdcdca8, tree: 0x8a9a4a, treeChance: 0.06, rockChance: 0.10 },
  FOREST:   { name: 'Forest',    ground: 0x3f6b34, pad: 0x5a6038, fog: 0x86a98e, sky: 0x93b89e, tree: 0x2f6a30, treeChance: 0.50, rockChance: 0.05 },
  TAIGA:    { name: 'Taiga',     ground: 0x47675a, pad: 0x4f5f50, fog: 0xacc2c2, sky: 0xbcd0cc, tree: 0x356a52, treeChance: 0.42, rockChance: 0.10 },
  DESERT:   { name: 'Desert',    ground: 0xc9a266, pad: 0xb8924f, fog: 0xe6d09c, sky: 0xeedaa6, tree: 0x9a8a4a, treeChance: 0.02, rockChance: 0.28 },
  TUNDRA:   { name: 'Tundra',    ground: 0xdde7f0, pad: 0xc6d2dc, fog: 0xcfe0ee, sky: 0xdcebf6, tree: 0x6f8a7a, treeChance: 0.07, rockChance: 0.14 },
  MOUNTAIN: { name: 'Mountains', ground: 0x8c8c86, pad: 0x77756f, fog: 0xc8ccd2, sky: 0xd2d6dc, tree: 0x5a6a55, treeChance: 0.05, rockChance: 0.34 },
};
function biomeAt(x, z) {
  const e = elevationAt(x, z);
  if (e < SEA_LEVEL) return e < SEA_LEVEL - 0.10 ? B.OCEAN : B.SHALLOW;
  if (e < SEA_LEVEL + 0.035) return B.BEACH;          // a sandy coastal strip
  if (e > 0.80) return B.MOUNTAIN;                    // snow-capped peaks at any latitude
  // CLIMATE BANDS, north (cold) → south (hot); moisture varies the band within itself
  const t = tempAt(x, z), m = moistureAt(x, z);
  if (t < 0.20) return B.TUNDRA;                          // frozen north
  if (t < 0.38) return m > 0.45 ? B.TAIGA : B.TUNDRA;     // cold: boreal forest / open tundra
  if (t < 0.58) return m > 0.45 ? B.FOREST : B.GRASS;     // temperate: forest / grassland
  if (t < 0.78) return m > 0.50 ? B.FOREST : B.SAVANNA;   // warm: woodland / savanna
  return m < 0.40 ? B.DESERT : B.SAVANNA;                 // hot south: desert / dry savanna
}

// ---------- Nations: five powers around an inner sea, on the eve of a great upheaval ----------
// A fading old empire, its ancient eastern rival, a young power surging out of the southern
// deserts, the war-tribes of the cold north, and a sea-merchant league. `home` is the compass
// angle its heartland sits at (radians; +z is the hot south, -z the frozen north — see tempAt),
// so the desert power always rises in the south and the tribes hold the northern woods.
const NATIONS = [
  { name: 'Aurelia',  color: 0x7d3fb0, home: 2.62 }, // the old empire — imperial purple, warm western heartland
  { name: 'Khorvane', color: 0xb0202a, home: 0.15 }, // the ancient eastern rival — deep crimson, far east
  { name: 'Sahir',    color: 0x1f9d57, home: 1.57 }, // the rising power — green banners, the southern wastes
  { name: 'Wendmark', color: 0x6b7280, home: 4.71 }, // the northern war-tribes — iron grey, the cold forests
  { name: 'Maridor',  color: 0x1d8f8f, home: 3.67 }, // the sea-merchant league — teal, a temperate coast
];
const PLAYER_REALM = { name: 'Your Banner', color: 0x2f6fd0 }; // captured holds fly your colors
// ---------- Diplomacy: standing pacts with AI nations (other players in a shared world are allies too) ----------
const playerPacts = new Set(); // NATION defs the player is sworn-allied with — persists across regions (NATIONS is constant)
function isAllyFaction(f) { return f === PLAYER_REALM || (f && playerPacts.has(f)); }
function pactAcceptChance() { const r = playerChar ? playerChar.renown : 0; return clamp(0.30 + r / 240, 0.30, 0.92); }

// ---------- Diplomacy engine (client) ----------
// Relations come from the server (authoritative) when online; in SOLO play the SAME shared kernel
// (window.WorldSim) evolves them locally, so the offline world is alive too. Factions are objects here
// ({name,color}); the matrix is keyed by faction NAME via WorldSim.pairKey. Degrades to the original
// all-vs-all war if world-sim.js ever fails to load.
let worldRelations = new Map();   // pairKey -> { a, b, opinion, stance, truceUntil }
let soloWeary = new Map();        // faction name -> war-weariness (solo bookkeeping)
let localDipTick = 0, localDipAccum = 0, soloRelSeeded = false;
const DIP_STEP_SECONDS = 3;       // a diplomacy step / server refresh every few seconds of map time
const _wsOK = () => (typeof WorldSim !== 'undefined' && WorldSim.pairKey);
function factionName(f) { return typeof f === 'string' ? f : (f && f.name) || ''; }
function relGet(a, b) { return _wsOK() ? worldRelations.get(WorldSim.pairKey(factionName(a), factionName(b))) : null; }
function stanceLocal(a, b) {
  const an = factionName(a), bn = factionName(b);
  if (!an || !bn || an === bn) return 'alliance';            // same banner never fights itself
  const pr = PLAYER_REALM.name;
  if (an === pr || bn === pr) {                              // the player's standing
    if (isAllyFaction(an === pr ? b : a)) return 'alliance';
    const r = relGet(an, bn); return r ? r.stance : 'neutral'; // no quarrel by default
  }
  const r = relGet(an, bn);
  return r ? r.stance : 'hostile';                            // unknown AI pair = rivals (preserves solo war)
}
function areFactionEnemies(a, b) {
  const s = stanceLocal(a, b);
  return (typeof WorldSim !== 'undefined' && WorldSim.areEnemies) ? WorldSim.areEnemies(s) : (s === 'war' || s === 'hostile');
}
function setRelations(list) {
  if (!_wsOK()) return;
  worldRelations = new Map();
  for (const r of (list || [])) worldRelations.set(WorldSim.pairKey(r.a, r.b), { a: r.a, b: r.b, opinion: r.opinion, stance: r.stance, truceUntil: r.truceUntil || 0 });
}
// solo seeding mirrors the server: neighbours on the pentagon open sore, the rest neutral, player neutral
function seedLocalRelations() {
  if (!_wsOK()) return;
  const all = NATIONS.map(n => n.name).concat([PLAYER_REALM.name]);
  const out = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    const ni = NATIONS.findIndex(n => n.name === a), nj = NATIONS.findIndex(n => n.name === b);
    // nation↔nation opening standing comes from the themed matrix; the player opens neutral with all
    const opinion = (ni >= 0 && nj >= 0) ? WorldSim.initialOpinion(a, b) : 0;
    const c = WorldSim.canonPair(a, b);
    out.push({ a: c.a, b: c.b, opinion, stance: WorldSim.stanceFromOpinion(opinion, null) });
  }
  setRelations(out); soloRelSeeded = true;
}
// one solo diplomacy step: power from local holds + hosts, then the shared kernel drifts every pair
function updateSoloDiplomacy() {
  if (!_wsOK() || !WorldSim.updateDiplomacy) return;
  if (!soloRelSeeded) seedLocalRelations();
  localDipTick++;
  const all = NATIONS.map(n => n.name).concat([PLAYER_REALM.name]);
  const power = {}; for (const nm of all) power[nm] = 0;
  for (const cap of nations) { const nm = factionName(cap.owner); if (power[nm] != null) power[nm] += 25; }
  for (const band of parties) { if (!band.alive) continue; const nm = factionName(band.faction); if (power[nm] != null) power[nm] += WorldSim.bandPower({ size: band.size, quality: band.quality || 1.05, leader: band.leader }); }
  const factions = all.map(nm => ({ name: nm, power: power[nm], alive: 1, warWeariness: soloWeary.get(nm) || 0 }));
  const rows = Array.from(worldRelations.values());
  const rnd = WorldSim.mulberry32((worldSeed() ^ localDipTick ^ 0x5151) >>> 0);
  const out = WorldSim.updateDiplomacy(factions, rows, { tick: localDipTick }, rnd);
  for (const u of out.relationUpdates) worldRelations.set(WorldSim.pairKey(u.a, u.b), { a: u.a, b: u.b, opinion: u.opinion, stance: u.stance, truceUntil: u.truceUntil || 0 });
  for (const ps of out.postureUpdates) soloWeary.set(ps.faction, ps.warWeariness);
  if (out.events.length) showWaveBanner('The Vale Shifts', out.events[0].summary);
}
// drive relations forward on the map: pull fresh server truth online, run the kernel in solo
function tickMapDiplomacy(dt, serverDriven) {
  localDipAccum += dt; if (localDipAccum < DIP_STEP_SECONDS) return; localDipAccum = 0;
  if (serverDriven) { const w = (typeof window !== 'undefined' && window.net && window.net.world); if (w && w.relations) setRelations(w.relations); }
  else updateSoloDiplomacy();
}
function refreshAlliedLabels(fac) { for (const b of parties) if (b.alive && b.faction === fac) { b._shownSize = -1; setBandLabel(b); } }
let nations = [];           // this region's capitals: [{ def, owner, x, z, garrison, group, ... }]
const _tcA = new THREE.Color(), _tcB = new THREE.Color();
// a capital is a real prize — its garrison outnumbers a field host
function garrisonSize() { return Math.round(rand(18, 28) + mapLevel * 8); }
function nearestLand(x, z) { // spiral out from a point until we find dry ground (unbounded — the world is infinite)
  if (!isWater(x, z)) return [x, z];
  for (let r = 4; r < MAP_HALF * 2; r += 4) for (let a = 0; a < 12; a++) {
    const ax = x + Math.cos(a / 12 * Math.PI * 2) * r;
    const az = z + Math.sin(a / 12 * Math.PI * 2) * r;
    if (!isWater(ax, az)) return [ax, az];
  }
  return [x, z];
}
function placeCapitals() {
  nations = [];
  // each power sits at its themed compass bearing; a small seeded wobble keeps runs distinct
  // (and the terrain noise itself shifts per universe) without scrambling the cardinal layout
  const jitter = ((worldSeed() % 1000) / 1000 - 0.5) * 0.18; // ±~5°
  for (let i = 0; i < NATIONS.length; i++) {
    const home = (typeof NATIONS[i].home === 'number') ? NATIONS[i].home : (i / NATIONS.length) * Math.PI * 2;
    const ang = home + jitter;
    const [cx, cz] = nearestLand(Math.cos(ang) * MAP_HALF * 0.5, Math.sin(ang) * MAP_HALF * 0.5);
    nations.push({ def: NATIONS[i], owner: NATIONS[i], x: cx, z: cz, garrison: garrisonSize(), parleyCd: 0, conquerCd: 0, group: null });
  }
}
function nationAt(x, z) { // Voronoi: land belongs to its nearest capital
  let best = null, bd = Infinity;
  for (const n of nations) { const dx = n.x - x, dz = n.z - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = n; } }
  return best;
}
function spawnPointFor(nation, awayFromPlayer) { // a land tile inside this nation's territory
  for (let t = 0; t < 80; t++) {
    const ang = rand(0, Math.PI * 2), r = rand(4, MAP_HALF * 0.55);
    const x = clamp(nation.x + Math.cos(ang) * r, -MAP_HALF + 3, MAP_HALF - 3);
    const z = clamp(nation.z + Math.sin(ang) * r, -MAP_HALF + 3, MAP_HALF - 3);
    if (isWater(x, z) || nationAt(x, z) !== nation) continue;
    if (awayFromPlayer && Math.hypot(x - player.pos.x, z - player.pos.z) < 30) continue;
    return [x, z];
  }
  return [nation.x, nation.z];
}

// ---------- Strategic worldmap terrain (top-down view only) ----------
let mapTerrain = null, mapTerrainLevel = -1;
// blended terrain color: water depth gradient, or biome tinted toward its owner nation
function terrainColorAt(x, z, out) {
  const e = elevationAt(x, z);
  if (e < SEA_LEVEL) { out.setHex(0x123a5e).lerp(_tcB.setHex(0x2f86b4), clamp(e / SEA_LEVEL, 0, 1)); return out; }
  out.setHex(biomeAt(x, z).ground);
  out.multiplyScalar(clamp(0.80 + (e - SEA_LEVEL) * 0.4, 0.7, 1.0));   // gentle relief shading (never over-bright)
  if (e > 0.78) out.lerp(_tcB.setHex(0xeef3f7), clamp((e - 0.78) / 0.16, 0, 0.85)); // snowline whitens the peaks
  // (political colour is no longer baked here — the living territory overlay paints it dynamically)
  return out;
}
// Display elevation for the strategic map: turn the (gameplay-only) elevation field into
// real vertical relief so mountains tower and valleys sink. Water dips into a seabed basin
// beneath its tint; land eases upward, with peaks getting an extra exponential lift.
const MAP_RELIEF = 26;
function mapElevY(x, z) {
  const e = elevationAt(x, z);
  if (e < SEA_LEVEL) return -0.6 - (SEA_LEVEL - e) * 2.0;              // seabed basin under the water tint
  const land = (e - SEA_LEVEL) / (1 - SEA_LEVEL);                     // 0..~0.76 across the dry range
  let h = Math.pow(land, 1.5) * MAP_RELIEF;                           // rolling hills lift gently, not pancake-flat
  if (e > 0.70) h += (e - 0.70) * MAP_RELIEF * 2.2;                   // peaks tower above the foothills
  return h;
}
// ---------- Infinite world: streaming terrain chunks + a settlement hierarchy ----------
// The strategic map is no longer one bounded sheet. Terrain, scatter, and settlements stream in as
// square chunks around the player and dispose once left behind, so the world extends forever and is
// generated the moment you discover it. Everything a chunk builds is a pure function of
// (chunkX, chunkZ, worldSeed), so a place looks identical each time you return within a region.
const CHUNK = 60;          // world units per chunk side
const CHUNK_SEG = 16;      // relief subdivisions per chunk (matches the old sheet's vertex density)
let VIEW = 2;              // chunks streamed out from the player's chunk; GROWS with the vista (see below)

// ---------- The vista: the more of the world you ride, the farther your scouts see ----------
// Riding the map accrues survey reach. As it climbs the camera lifts and pulls back, the haze is
// pushed to the horizon, and more terrain streams in — so a seasoned commander surveys the land
// while a newcomer rides hemmed-in and blind. A saturating curve means it never quite stops
// ("far and farther") but the early gains are the most felt. Persists across regions and sessions.
const VISTA = {
  k: 750,            // half-reach distance: vista = 0.5 once this many world-units have been ridden
  fogNear: [108, 205],   // [base → widest]  haze onset
  fogFar:  [225, 470],   // [base → widest]  full white-out (kept inside the streamed terrain)
  camLift: [46, 88],     // [base → widest]  camera height above the relief — the dominant "see far" lever
  camBack: [20, 40],     // [base → widest]  southward pullback (keeps the tilt as it zooms out)
  view:    [2, 3],       // [base → widest]  chunk-stream radius (whole steps; capped at 3 to stay phone-friendly)
};
let mapMiles = 0;         // total world-units ridden across the overworld (persisted, never reset)
try { mapMiles = +localStorage.getItem('bv-map-miles') || 0; } catch (e) { /* private mode */ }
let mapVista = mapMiles / (mapMiles + VISTA.k); // 0..1 derived survey reach
let _mileSaveT = 0;       // throttles persistence of the running total
const vlerp = (pair) => pair[0] + (pair[1] - pair[0]) * mapVista;
const mapChunks = new Map();   // "cx,cz" -> { group, holds:[settlement holds] }
const settlements = [];        // every currently-loaded village/town/city (duck-typed like a capital)
const heldOwners = new Map();  // siteKey -> owner faction name: remembers conquests near you this region
let _lastPlayerChunk = '';

function _mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _chunkHash(cx, cz) { return (Math.imul(cx | 0, 73856093) ^ Math.imul(cz | 0, 19349663) ^ Math.imul(worldSeed(), 83492791)) >>> 0; }

// the campaign gets deadlier the farther you roam: home stays gentle, the frontier is brutal
const FRONTIER_STEP = 240;
function frontierLevel(x, z) { return mapLevel + Math.floor(Math.hypot(x, z) / FRONTIER_STEP); }

// ---------- Frontier politics: free cities + petty realms beyond the five powers' heartland ----------
const FREE = { name: 'Free City', color: 0x9aa0a6, free: true };  // unaligned, neutral grey
const PETTY = [
  { name: 'Greymark',   color: 0x8a6d3b }, { name: 'Ravenfell', color: 0x466079 },
  { name: 'Thornhold',  color: 0x6f8f3a }, { name: 'Duskvar',   color: 0x7c4a72 },
  { name: 'Stormwatch', color: 0x3b7d96 }, { name: 'Ashreach',  color: 0xa6543a },
  { name: 'Hollowmere', color: 0x4c7d62 }, { name: 'Karran',    color: 0xb08a2a },
];
const HEARTLAND_R = MAP_HALF * 1.6;  // within this of origin the five named powers rule; beyond it, the frontier
function factionByName(nm) {
  if (nm === PLAYER_REALM.name) return PLAYER_REALM;
  if (nm === FREE.name) return FREE;
  return NATIONS.find(n => n.name === nm) || PETTY.find(p => p.name === nm) || null;
}
function nearCapital(x, z, d) { for (const n of nations) if (Math.hypot(n.x - x, n.z - z) < d) return true; return false; }

// deterministic settlement sites within a chunk (most chunks hold 0–1; a few hold 2)
function settlementSites(cx, cz) {
  const rng = _mulberry32(_chunkHash(cx, cz) ^ 0x51A7);
  const n = rng() < 0.42 ? 0 : (rng() < 0.80 ? 1 : 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = (cx + 0.20 + rng() * 0.60) * CHUNK;   // kept off the chunk edges so neighbours don't collide
    const z = (cz + 0.20 + rng() * 0.60) * CHUNK;
    const tr = rng();
    const tier = tr < 0.70 ? 'village' : tr < 0.92 ? 'town' : 'city';
    out.push({ x, z, tier, idx: i, cx, cz });
  }
  return out;
}
function siteKey(s) { return s.cx + ',' + s.cz + ',' + s.idx; }
const _NAME_A = ['Ash', 'Brook', 'Crag', 'Dun', 'Elder', 'Fen', 'Grim', 'Holt', 'Kel', 'Mar', 'Oak', 'Pell', 'Raven', 'Stone', 'Thorn', 'Vale', 'Wic', 'Yarl', 'Bram', 'Glen'];
const _NAME_B = ['bury', 'combe', 'dale', 'ford', 'garth', 'hollow', 'mere', 'reach', 'stead', 'ton', 'wick', 'wold', 'holm', 'crest', 'gate', 'moor', 'fell', 'bridge'];
function settlementName(s) {
  const r = _mulberry32(_chunkHash(s.cx, s.cz) ^ (Math.imul(s.idx + 1, 2654435761) >>> 0));
  return _NAME_A[(r() * _NAME_A.length) | 0] + _NAME_B[(r() * _NAME_B.length) | 0];
}
function settlementOwner(s) {
  if (Math.hypot(s.x, s.z) < HEARTLAND_R) { const n = nationAt(s.x, s.z); return n ? n.owner : FREE; } // heartland → its nation
  const r = _mulberry32(_chunkHash(s.cx, s.cz) ^ (Math.imul(s.idx + 7, 40503) >>> 0));
  return r() < 0.55 ? FREE : PETTY[(r() * PETTY.length) | 0];   // frontier → free cities + petty realms
}
const TIER_GARRISON = { village: [4, 9], town: [10, 18], city: [20, 34] };
function settlementGarrison(s) {
  const g = TIER_GARRISON[s.tier], scale = s.tier === 'city' ? 6 : s.tier === 'town' ? 3 : 1.4;
  return Math.round(rand(g[0], g[1]) + frontierLevel(s.x, s.z) * scale);   // distant holds bristle with men
}
function makeSettlementHold(s) {
  const key = siteKey(s);
  const restored = heldOwners.get(key);
  const owner = (restored && factionByName(restored)) || settlementOwner(s);
  const hold = { def: { name: settlementName(s) }, owner, x: s.x, z: s.z, tier: s.tier,
    garrison: settlementGarrison(s), parleyCd: 0, conquerCd: 0, group: null, site: s, key };
  hold.group = makeSettlement(hold);
  return hold;
}

// ---------- Per-chunk decoration: trees + rocks, deterministic from the chunk seed ----------
function buildScatter(group, cx, cz) {
  const rng = _mulberry32(_chunkHash(cx, cz) ^ 0x5EED);
  const x0 = cx * CHUNK, z0 = cz * CHUNK, trees = [], rocks = [];
  for (let gx = 3; gx < CHUNK; gx += 6.5) for (let gz = 3; gz < CHUNK; gz += 6.5) {
    const jx = x0 + gx + (rng() * 4 - 2), jz = z0 + gz + (rng() * 4 - 2);
    if (isWater(jx, jz)) continue;
    const b = biomeAt(jx, jz), roll = rng();
    if (roll < b.treeChance) trees.push([jx, jz, b.tree]);
    else if (roll < b.treeChance + b.rockChance) rocks.push([jx, jz]);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  if (trees.length) {
    const trunks = new THREE.InstancedMesh(cachedGeo('mapTrunk', () => new THREE.BoxGeometry(0.5, 1, 0.5)), mat(0x6b4a2e), trees.length);
    const cones = new THREE.InstancedMesh(cachedGeo('mapCone', () => new THREE.ConeGeometry(1.5, 3.2, 6)), mat(0xffffff), trees.length);
    trees.forEach(([x, z, c], i) => {
      const sc = 0.8 + rng() * 0.7, th = (2 + rng()) * sc, gy = mapElevY(x, z);
      q.setFromEuler(e.set(0, rng() * Math.PI, 0));
      m4.compose(v.set(x, gy + th / 2, z), q, s.set(sc, th, sc)); trunks.setMatrixAt(i, m4);
      m4.compose(v.set(x, gy + th + 1.2 * sc, z), q, s.set(sc, sc, sc)); cones.setMatrixAt(i, m4);
      col.setHex(c); cones.setColorAt(i, col);
    });
    trunks.castShadow = cones.castShadow = true;
    if (cones.instanceColor) cones.instanceColor.needsUpdate = true;
    group.add(trunks); group.add(cones);
  }
  if (rocks.length) {
    const rm = new THREE.InstancedMesh(cachedGeo('mapRock', () => new THREE.IcosahedronGeometry(1, 0)), mat(0x8d8f95), rocks.length);
    rocks.forEach(([x, z], i) => {
      const r = 0.6 + rng() * 1.0;
      q.setFromEuler(e.set(rng(), rng(), rng()));
      m4.compose(v.set(x, mapElevY(x, z) + r * 0.5, z), q, s.set(r, r * (0.6 + rng() * 0.4), r)); rm.setMatrixAt(i, m4);
    });
    rm.castShadow = rm.receiveShadow = true;
    group.add(rm);
  }
}

// ---------- Chunk streaming ----------
function buildChunk(cx, cz) {
  const key = cx + ',' + cz;
  if (mapChunks.has(key)) return;
  const group = new THREE.Group();
  const col = new THREE.Color();
  // relief sheet — world coords baked into the vertices so the chunk group itself stays at the origin
  const tgeo = new THREE.PlaneGeometry(CHUNK, CHUNK, CHUNK_SEG, CHUNK_SEG);
  tgeo.rotateX(-Math.PI / 2);
  const ox = (cx + 0.5) * CHUNK, oz = (cz + 0.5) * CHUNK;
  const pos = tgeo.attributes.position, cArr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + ox, z = pos.getZ(i) + oz;
    pos.setX(i, x); pos.setZ(i, z); pos.setY(i, mapElevY(x, z));
    terrainColorAt(x, z, col);
    cArr[i * 3] = col.r; cArr[i * 3 + 1] = col.g; cArr[i * 3 + 2] = col.b;
  }
  tgeo.computeVertexNormals();
  tgeo.setAttribute('color', new THREE.BufferAttribute(cArr, 3));
  const sheet = new THREE.Mesh(tgeo, new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 3 }));
  sheet.receiveShadow = true; group.add(sheet);
  buildScatter(group, cx, cz);
  const terr = buildChunkTerritory(group, cx, cz); // living-territory overlay for this chunk
  // settlements discovered in this chunk
  const holds = [];
  for (const s of settlementSites(cx, cz)) {
    if (isWater(s.x, s.z) || nearCapital(s.x, s.z, 18)) continue;
    const hold = makeSettlementHold(s);
    group.add(hold.group);
    holds.push(hold); settlements.push(hold);
  }
  mapTerrain.add(group);
  mapChunks.set(key, { group, holds, terr });
  initTerritoryCells(cx, cz);                       // seed this chunk's cells (gen-0 = the political map)
  paintChunkTerritory(mapChunks.get(key));          // show it immediately, before the first generation
}
function disposeChunk(key) {
  const c = mapChunks.get(key); if (!c) return;
  mapTerrain.remove(c.group); disposeGroup(c.group); // disposeGroup frees the overlay material + its texture too
  for (const h of c.holds) { const i = settlements.indexOf(h); if (i >= 0) settlements.splice(i, 1); }
  const ci = key.indexOf(','), kx = +key.slice(0, ci), kz = +key.slice(ci + 1); // drop this chunk's cells (bound the Map)
  const gx0 = kx * GENV, gz0 = kz * GENV;
  for (let i = 0; i < GENV; i++) for (let j = 0; j < GENV; j++) terrCells.delete(_cellKey(gx0 + i, gz0 + j));
  mapChunks.delete(key);
}
function clearChunks() { for (const key of Array.from(mapChunks.keys())) disposeChunk(key); }
function updateChunks(force) {
  if (!mapTerrain) return;
  const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK), pk = pcx + ',' + pcz;
  if (!force && pk === _lastPlayerChunk) return;   // only re-stream when the player crosses a chunk line
  _lastPlayerChunk = pk;
  for (let dx = -VIEW; dx <= VIEW; dx++) for (let dz = -VIEW; dz <= VIEW; dz++) buildChunk(pcx + dx, pcz + dz);
  for (const key of Array.from(mapChunks.keys())) {
    const c = key.indexOf(','), kx = +key.slice(0, c), kz = +key.slice(c + 1);
    if (Math.abs(kx - pcx) > VIEW + 1 || Math.abs(kz - pcz) > VIEW + 1) disposeChunk(key);
  }
}

// ---------- Living territory: a cellular automaton draped over the streamed map ----------
// The political map is no longer a frozen Voronoi wash. Each chunk carries a grid of territory
// cells; every generation control spreads from strong cells into their neighbours — seeded by the
// holds and hosts that already exist — so fronts ripple, conquests recolour outward, and borders
// breathe (Game-of-Life over the war map). Purely a client-side visualisation: server-authoritative
// capital ownership still wins; the cells are merely seeded by it.
const TERR_CELL = 3;                         // world units per territory cell
const GENV = (CHUNK / TERR_CELL) | 0;        // cells per chunk side (20)
const TERR_GEN_T = 0.5;                       // seconds per generation (the "step" cadence)
const TERR_OPACITY = 0.72;                    // overlay strength over the terrain
const TERR_HYST = 0.04;                       // a challenger must beat the incumbent's influence by this to flip a cell
const TERR_GROW = 0.4;                        // how fast a cell's strength chases its target each gen (the visible "fade")
// Each hold/host projects a faction influence that falls off linearly with distance. A cell flies the
// banner of the strongest influence over it — a weighted Voronoi that REBUILDS every generation, so as
// hosts roam and capitals are conquered the fronts genuinely move (capitals are wide stationary anchors;
// hosts are narrow moving sources that drag bulges into enemy land).
const CAP_W = 1.0, CAP_R = 66;               // capital: strong, reaches across its realm
const SET_W = 0.6, SET_R = 30;               // town/city: a local anchor
const BAND_W = 0.8, BAND_R = 16;             // a roaming host: a moving bulge of its colours that dents nearby fronts
const PLR_W = 0.85, PLR_R = 16;              // the player's own banner carves a little realm wherever it rides
const CONTEST_R = 6;                         // a living clash knocks the ground grey within this
const terrCells = new Map();                  // "gx,gz" -> { gx, gz, o:faction|null, s:0..1, f:flash, w:water, bf/bi/sf/si/ct:per-gen scratch }
let terrGen = 0, terrGenT = 0;
function _cellKey(gx, gz) { return gx + ',' + gz; }
// gen-0 owner: the heartland Voronoi, or the nearest loaded frontier hold, or wilderness
function _ownerAtInit(x, z) {
  if (Math.hypot(x, z) < HEARTLAND_R) { const n = nationAt(x, z); return n ? n.owner : null; }
  let best = null, bd = (CHUNK * 0.9) * (CHUNK * 0.9);
  for (const h of settlements) { const dx = h.x - x, dz = h.z - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = h; } }
  return best ? best.owner : null;
}
function _ensureCell(gx, gz) {
  const k = _cellKey(gx, gz);
  let c = terrCells.get(k);
  if (c) return c;
  const x = (gx + 0.5) * TERR_CELL, z = (gz + 0.5) * TERR_CELL;
  const water = isWater(x, z);
  const owner = water ? null : _ownerAtInit(x, z);
  c = { gx, gz, o: owner, s: owner ? 0.6 : 0, f: 0, w: water, bf: null, bi: 0, sf: null, si: 0, ct: 0 };
  terrCells.set(k, c);
  return c;
}
function initTerritoryCells(cx, cz) {
  const gx0 = cx * GENV, gz0 = cz * GENV;
  for (let i = 0; i < GENV; i++) for (let j = 0; j < GENV; j++) _ensureCell(gx0 + i, gz0 + j);
}
// one generation: rebuild the faction influence field from the live holds/hosts, then let each cell
// flow toward whoever now dominates it. Because the hosts move and capitals change hands, the field
// (and therefore every border) shifts generation to generation.
function stepTerritory() {
  terrGen++;
  for (const c of terrCells.values()) { c.bf = null; c.bi = 0; c.sf = null; c.si = 0; c.ct = 0; } // reset the field
  // stamp a source's influence onto the loaded cells in its reach, tracking the top-2 distinct factions per cell
  const stamp = (sx, sz, fac, W, R) => {
    if (!fac) return;
    const invR = 1 / R;
    const gx0 = Math.floor((sx - R) / TERR_CELL), gx1 = Math.floor((sx + R) / TERR_CELL);
    const gz0 = Math.floor((sz - R) / TERR_CELL), gz1 = Math.floor((sz + R) / TERR_CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
      const c = terrCells.get(_cellKey(gx, gz)); if (!c || c.w) continue;
      const d = Math.hypot((gx + 0.5) * TERR_CELL - sx, (gz + 0.5) * TERR_CELL - sz);
      if (d >= R) continue;
      const inf = W * (1 - d * invR); if (inf <= 0) continue;
      if (c.bf === fac) { if (inf > c.bi) c.bi = inf; }
      else if (inf > c.bi) { c.sf = c.bf; c.si = c.bi; c.bf = fac; c.bi = inf; }
      else if (c.sf === fac) { if (inf > c.si) c.si = inf; }
      else if (inf > c.si) { c.sf = fac; c.si = inf; }
    }
  };
  for (const n of nations) stamp(n.x, n.z, n.owner, CAP_W, CAP_R);
  for (const h of settlements) stamp(h.x, h.z, h.owner, SET_W, SET_R);
  for (const b of parties) if (b.alive) stamp(b.pos.x, b.pos.z, b.faction, BAND_W, BAND_R);
  stamp(player.pos.x, player.pos.z, PLAYER_REALM, PLR_W, PLR_R);
  for (const bt of mapBattles) if (!bt.done) {        // a living clash knocks the ground grey around it
    const gx0 = Math.floor((bt.cx - CONTEST_R) / TERR_CELL), gx1 = Math.floor((bt.cx + CONTEST_R) / TERR_CELL);
    const gz0 = Math.floor((bt.cz - CONTEST_R) / TERR_CELL), gz1 = Math.floor((bt.cz + CONTEST_R) / TERR_CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
      const c = terrCells.get(_cellKey(gx, gz)); if (!c) continue;
      const d = Math.hypot((gx + 0.5) * TERR_CELL - bt.cx, (gz + 0.5) * TERR_CELL - bt.cz);
      if (d < CONTEST_R) c.ct = Math.max(c.ct, 1 - d / CONTEST_R);
    }
  }
  for (const c of terrCells.values()) {               // resolve each cell + ease its strength toward the new truth
    if (c.w) { c.o = null; c.s = 0; c.f = 0; continue; }
    let owner = c.o;
    const incInf = (c.bf === c.o) ? c.bi : (c.sf === c.o ? c.si : 0);
    if (c.bf && c.bf !== c.o && c.bi > incInf + TERR_HYST) owner = c.bf; // a stronger banner takes the cell
    if (!c.bf || c.bi <= 0.02) owner = null;            // no hold reaches here → open wilderness
    const ownInf = (c.bf === owner) ? c.bi : (c.sf === owner ? c.si : 0);
    const rivalInf = (c.bf === owner) ? c.si : c.bi;    // dominance over the next-strongest faction
    const target = owner ? clamp(0.4 + (ownInf - rivalInf) * 1.3, 0.4, 1) : 0; // deep land is bold, contested seams faint
    let s = c.s + (target - c.s) * TERR_GROW;
    if (c.ct > 0) s = Math.min(s, (1 - c.ct) * 0.45);   // a raging clash bleeds the ground toward grey
    if (s < 0.08) { owner = null; s = 0; }              // pressed below nothing → falls to wilderness/grey
    c.f = (owner && owner !== c.o) ? 1 : c.f * 0.55;    // brighten a fresh flip, then fade
    c.o = owner; c.s = clamp(s, 0, 1);
  }
  for (const rec of mapChunks.values()) if (rec.terr) paintChunkTerritory(rec);
}
// build a chunk's overlay: a crisp NearestFilter cell texture draped on the relief, just above it
function buildChunkTerritory(group, cx, cz) {
  const data = new Uint8Array(GENV * GENV * 4);
  const tex = new THREE.DataTexture(data, GENV, GENV, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace; // texels hold exact sRGB nation colours regardless of colour management
  tex.generateMipmaps = false; tex.needsUpdate = true;
  const geo = new THREE.PlaneGeometry(CHUNK, CHUNK, GENV, GENV);
  geo.rotateX(-Math.PI / 2);
  const ox = (cx + 0.5) * CHUNK, oz = (cz + 0.5) * CHUNK, pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + ox, z = pos.getZ(i) + oz;
    pos.setX(i, x); pos.setZ(i, z); pos.setY(i, mapElevY(x, z) + 0.35); // ride just above the terrain sheet
  }
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: TERR_OPACITY, depthWrite: false }));
  mesh.renderOrder = 2;
  group.add(mesh);
  return { tex, data, cx, cz, mesh };
}
function paintChunkTerritory(rec) {
  const t = rec.terr; if (!t) return;
  const gx0 = t.cx * GENV, gz0 = t.cz * GENV, data = t.data;
  for (let j = 0; j < GENV; j++) for (let i = 0; i < GENV; i++) {
    const c = terrCells.get(_cellKey(gx0 + i, gz0 + j));
    const o = ((GENV - 1 - j) * GENV + i) * 4;           // flip the texel row: after the plane's rotateX, V runs opposite world +Z
    if (c && !c.w && c.ct > 0.12) {                       // a raging clash → a pale contested scar over the land
      data[o] = 205; data[o + 1] = 205; data[o + 2] = 205; data[o + 3] = (clamp(0.25 + c.ct * 0.55, 0, 1) * 255) | 0; continue;
    }
    if (!c || c.w || !c.o) {                              // water / wilderness → let the terrain show through
      const a = (c && !c.w && c.f > 0.05) ? (c.f * 70) | 0 : 0; // a brief grey ghost where land just fell
      data[o] = 150; data[o + 1] = 150; data[o + 2] = 150; data[o + 3] = a; continue;
    }
    let r = (c.o.color >> 16) & 255, g = (c.o.color >> 8) & 255, b = c.o.color & 255;
    if (c.f > 0.02) { const tw = c.f * 0.5; r += (255 - r) * tw; g += (255 - g) * tw; b += (255 - b) * tw; } // flash a flip bright
    const rr = terrCells.get(_cellKey(gx0 + i + 1, gz0 + j)), uu = terrCells.get(_cellKey(gx0 + i, gz0 + j + 1));
    const k = ((rr && rr.o !== c.o) || (uu && uu.o !== c.o)) ? 0.4 : 1; // darken the moving border
    data[o] = (r * k) | 0; data[o + 1] = (g * k) | 0; data[o + 2] = (b * k) | 0;
    data[o + 3] = (clamp(0.4 + c.s * 0.6, 0, 1) * 255) | 0;
  }
  t.tex.needsUpdate = true;
}

// ---------- Strategic map: persistent capitals + streamed chunks ----------
function buildMapTerrain() {
  if (mapTerrain && mapTerrainLevel !== mapLevel) {  // a fresh region — tear the whole world down
    scene.remove(mapTerrain); disposeGroup(mapTerrain); mapTerrain = null;
    mapChunks.clear(); settlements.length = 0; heldOwners.clear(); _lastPlayerChunk = '';
    terrCells.clear(); terrGen = 0; terrGenT = 0; // a fresh region starts its territory anew
  }
  if (!mapTerrain) {
    mapTerrain = new THREE.Group(); scene.add(mapTerrain);
    for (const n of nations) { n.group = makeCapital(n); recolorCapital(n); mapTerrain.add(n.group); } // capitals always loaded
    mapTerrainLevel = mapLevel;
  }
  mapTerrain.visible = true;
  updateChunks(true);
}
// A walled keep: outer curtain wall with crenellated towers, a gatehouse, a central
// keep, and the owner's banners. Banner/roof materials are per-capital and mutable,
// so a conquered hold can re-fly the conqueror's colors.
function makeCapital(cap) {
  const g = new THREE.Group();
  const stone = mat(0x9a8f80), stoneDk = mat(0x807769), wood = mat(0x33240f);
  const ownerMats = [];
  const ownerMat = () => { const m = mat(cap.owner.color, { shared: false }); ownerMats.push(m); return m; };
  const half = 3.6, wallH = 1.9, base = 0.3;
  const yard = boxMesh(7.8, base, 7.8, stoneDk); yard.position.y = base / 2; g.add(yard); // courtyard slab
  const wall = (w, h, d, x, z) => { const m = boxMesh(w, h, d, stone); m.position.set(x, base + h / 2, z); g.add(m); };
  wall(7.6, wallH, 0.5, 0, -half);                 // north curtain
  wall(0.5, wallH, 7.6, -half, 0);                 // west curtain
  wall(0.5, wallH, 7.6,  half, 0);                 // east curtain
  wall(2.3, wallH, 0.5, -2.65, half);              // south curtain (split for the gate)
  wall(2.3, wallH, 0.5,  2.65, half);
  // parapet caps so the walls read crenellated without a merlon per metre
  const cap2 = (w, d, x, z) => { const m = boxMesh(w, 0.4, d, stoneDk); m.position.set(x, base + wallH + 0.15, z); g.add(m); };
  cap2(7.6, 0.55, 0, -half); cap2(0.55, 7.6, -half, 0); cap2(0.55, 7.6, half, 0);
  cap2(2.3, 0.55, -2.65, half); cap2(2.3, 0.55, 2.65, half);
  // gatehouse: two towers flanking the gap + a lintel
  const gh = wallH + 0.7;
  for (const sx of [-1.45, 1.45]) { const m = boxMesh(0.9, gh, 0.9, stoneDk); m.position.set(sx, base + gh / 2, half); g.add(m); }
  const lintel = boxMesh(3.2, 0.5, 0.9, stone); lintel.position.set(0, base + wallH + 0.25, half); g.add(lintel);
  // four corner towers with pointed, owner-colored roofs
  const towerH = 3.2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const tw = boxMesh(1.25, towerH, 1.25, stone); tw.position.set(sx * half, base + towerH / 2, sz * half); g.add(tw);
    const roof = new THREE.Mesh(cachedGeo('caproof', () => new THREE.ConeGeometry(1.0, 1.4, 4)), ownerMat());
    roof.castShadow = true; roof.rotation.y = Math.PI / 4; roof.position.set(sx * half, base + towerH + 0.7, sz * half); g.add(roof);
  }
  // central keep with battlements
  const keepH = 4.6;
  const keep = boxMesh(2.9, keepH, 2.9, stone); keep.position.y = base + keepH / 2; g.add(keep);
  for (let i = -1; i <= 1; i++) for (const [ax, az] of [[i * 1.0, -1.45], [i * 1.0, 1.45], [-1.45, i * 1.0], [1.45, i * 1.0]]) {
    const m = boxMesh(0.55, 0.55, 0.55, stoneDk); m.position.set(ax, base + keepH + 0.2, az); g.add(m);
  }
  // the great banner over the keep
  const pole = boxMesh(0.14, 2.4, 0.14, wood); pole.position.set(0, base + keepH + 1.4, 0); g.add(pole);
  const flag = boxMesh(1.7, 1.05, 0.08, ownerMat()); flag.position.set(0.9, base + keepH + 1.95, 0); g.add(flag);
  const label = makeNameSprite(cap.def.name);
  label.scale.set(6.6, 0.82, 1); label.position.y = base + keepH + 3.4; g.add(label);
  g.userData.ownerMats = ownerMats;
  g.userData.label = label;
  g.position.set(cap.x, mapElevY(cap.x, cap.z), cap.z);   // the keep sits on its hill
  return g;
}
// repaint a hold's banners/roofs to its current owner (after a conquest)
function recolorCapital(cap) {
  if (!cap.group) return;
  for (const m of cap.group.userData.ownerMats) m.color.setHex(cap.owner.color);
}

// A settlement scaled to its tier: a village is a cluster of thatched huts; a town adds a meeting
// hall and a wooden palisade; a city is a walled, banner-crowned burg. Banner/roof materials are
// per-hold and mutable, so a conquered settlement re-flies the conqueror's colors (recolorCapital).
function makeSettlement(hold) {
  const g = new THREE.Group();
  const tier = hold.tier;
  const wood = mat(0x6b4a2e), thatch = mat(0x9a7b43), stone = mat(0x9a8f80), daub = mat(0xb9a888);
  const ownerMats = [];
  const ownerMat = () => { const m = mat(hold.owner.color, { shared: false }); ownerMats.push(m); return m; };
  const r = _mulberry32(_chunkHash(hold.site.cx, hold.site.cz) ^ (Math.imul(hold.site.idx + 3, 0x9E3779B1) >>> 0));
  const base = 0.2;
  const spec = {
    village: { huts: 5,  spread: 3.0, wall: null,    hall: false, banners: 1, top: 3.4, lbl: 3.6 },
    town:    { huts: 9,  spread: 5.0, wall: 'wood',  hall: true,  banners: 1, top: 4.4, lbl: 4.6 },
    city:    { huts: 16, spread: 8.0, wall: 'stone', hall: true,  banners: 3, top: 6.0, lbl: 5.8 },
  }[tier];
  const hut = (hx, hz, w, h, body) => {
    const wall = boxMesh(w, h, w, body); wall.position.set(hx, base + h / 2, hz); wall.castShadow = false; g.add(wall);
    const roof = new THREE.Mesh(cachedGeo('hutRoof', () => new THREE.ConeGeometry(0.95, 0.8, 4)), thatch);
    roof.rotation.y = Math.PI / 4; roof.scale.set(w * 1.6, h * 0.85, w * 1.6);
    roof.position.set(hx, base + h + h * 0.36, hz); g.add(roof);
  };
  // a ring of dwellings
  for (let i = 0; i < spec.huts; i++) {
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spec.spread;
    const w = 0.85 + r() * 0.5, h = 0.85 + r() * 0.6 + (tier === 'city' ? r() * 0.9 : 0);
    hut(Math.cos(a) * rad, Math.sin(a) * rad, w, h, tier === 'city' && r() < 0.4 ? stone : daub);
  }
  // a meeting hall at the heart of a town or city
  if (spec.hall) {
    const hw = tier === 'city' ? 2.6 : 2.0, hh = tier === 'city' ? 2.6 : 1.8;
    const hall = boxMesh(hw, hh, hw * 1.3, tier === 'city' ? stone : wood); hall.position.set(0, base + hh / 2, 0); g.add(hall);
    const roof = new THREE.Mesh(cachedGeo('hallRoof', () => new THREE.ConeGeometry(0.95, 0.9, 4)), ownerMat());
    roof.rotation.y = Math.PI / 4; roof.scale.set(hw * 1.5, hh * 0.7, hw * 1.95);
    roof.position.set(0, base + hh + hh * 0.34, 0); roof.castShadow = true; g.add(roof);
  }
  // a defensive ring — wooden palisade (town) or a stone curtain with a southern gate gap (city)
  if (spec.wall) {
    const wmat = spec.wall === 'stone' ? stone : wood, wallH = spec.wall === 'stone' ? 1.7 : 1.1;
    const R = spec.spread + 1.7, side = R * 0.82;
    for (let k = 0; k < 8; k++) {
      if (tier === 'city' && k === 2) continue;  // leave a gateway
      const a = k / 8 * Math.PI * 2 + Math.PI / 8;
      const seg = boxMesh(side, wallH, spec.wall === 'stone' ? 0.5 : 0.3, wmat);
      seg.position.set(Math.cos(a) * R, base + wallH / 2, Math.sin(a) * R);
      seg.rotation.y = -a - Math.PI / 2; g.add(seg);
    }
  }
  // owner banners
  const banner = (bx, bz, bh) => {
    const pole = boxMesh(0.12, bh, 0.12, wood); pole.position.set(bx, base + bh / 2, bz); g.add(pole);
    const flag = boxMesh(1.0, 0.62, 0.06, ownerMat()); flag.position.set(bx + 0.55, base + bh - 0.42, bz); g.add(flag);
  };
  banner(0, spec.spread * 0.2, spec.top - 0.6);
  if (spec.banners >= 3) { banner(spec.spread * 0.7, -spec.spread * 0.4, 3.0); banner(-spec.spread * 0.7, -spec.spread * 0.3, 3.0); }
  // floating name label, sized to the tier
  const label = makeNameSprite(hold.def.name);
  label.scale.set(spec.lbl, spec.lbl / 8, 1); label.position.y = base + spec.top; g.add(label);
  g.userData.ownerMats = ownerMats;
  g.userData.label = label;
  g.position.set(hold.x, mapElevY(hold.x, hold.z), hold.z);
  return g;
}

// show/hide the battle set-dressing (arena pad, torch ring, edge treeline) vs the strategic map terrain
function setBattleDressing(on) {
  if (ground) ground.visible = on;     // battle: bumpy biome ground; map: flat biome plane is the surface
  if (arenaPad) arenaPad.visible = on;
  for (const t of torches) t.visible = on;
  const d = decoState;
  if (d.trunks) d.trunks.visible = on;
  if (d.cones) d.cones.visible = on;
  if (d.rockMesh) d.rockMesh.visible = on;
  if (backdropRange) backdropRange.visible = on;             // distant range belongs to the battlefield, not the strategic map
  if (backdropSnow) backdropSnow.visible = on && !!backdropSnow.userData.snow;
  if (mapTerrain) mapTerrain.visible = !on;
  for (const p of parties) if (p.group) p.group.visible = !on; // roaming map banners don't belong on the battlefield
  for (const bt of mapBattles) if (bt.marker) bt.marker.visible = !on; // nor do the living-clash markers
}
// repaint the battlefield to look like the biome the clash happens in
function applyBiome(b) {
  if (ground) ground.material.color.setHex(b.ground);
  if (arenaPad) arenaPad.material.color.setHex(b.pad);
  scene.fog.color.setHex(b.fog);
  scene.background.setHex(b.sky);
  const cones = decoState.cones;
  if (cones && cones.instanceColor) {
    const c = new THREE.Color(b.tree);
    for (let i = 0; i < cones.count; i++) cones.setColorAt(i, c);
    cones.instanceColor.needsUpdate = true;
  }
  if (backdropRange) {
    const t = backdropTone(b);
    backdropRange.userData.mat.color.setHex(t.rock);
    backdropSnow.userData.snow = t.snow;        // remembered so setBattleDressing can respect it
    backdropSnow.visible = t.snow;
  }
}

// ---------- The player's own party banner (shown on the strategic map) ----------
function makePlayerToken(size) {
  const g = new THREE.Group();
  const h = 4.4;
  const pole = boxMesh(0.2, h, 0.2, mat(0x2a1d10)); pole.position.y = h / 2; g.add(pole);
  const flag = boxMesh(1.8, 1.1, 0.08, mat(0x2f5fae)); flag.position.set(1.0, h - 0.62, 0); g.add(flag);
  const trim = boxMesh(1.8, 0.16, 0.1, mat(0xffd34d)); trim.position.set(1.0, h - 1.18, 0); g.add(trim);
  const label = makeNameSprite('★ ' + size);
  label.scale.set(2.8, 0.62, 1); label.position.y = h + 0.7; g.add(label);
  g.userData.label = label;
  return g;
}

function clearBattlefield() {
  for (const e of enemies) { scene.remove(e.obj); disposeGroup(e.obj); }
  enemies.length = 0;
  clearAllies();
  for (const s of sparks) { scene.remove(s); s.visible = false; sparkPool.push(s); }
  sparks.length = 0;
  for (const p of popups) { scene.remove(p.spr); popupPool.push(p); }
  popups.length = 0;
  for (const a of arcs) { scene.remove(a); disposeGroup(a); }
  arcs.length = 0;
  for (const p of projectiles) { scene.remove(p.mesh); disposeGroup(p.mesh); }
  projectiles.length = 0;
  for (const g of planGroups) { if (g.zoneMesh) g.zoneMesh.visible = false; if (g.holdMarker) g.holdMarker.visible = false; } // re-shown when the plan rebinds
}
function clearParties() {
  clearMapBattles(); // dispose any living-clash markers before their bands go
  for (const p of parties) { scene.remove(p.group); disposeGroup(p.group); }
  parties.length = 0;
}

// --- map party tokens: a faction-colored banner + a floating troop count ---
function makePartyToken(size, faction) {
  const small = size <= 5; // scrappy little packs get a smaller banner + a skull
  const g = new THREE.Group();
  const h = small ? 2.6 : 3.6;
  const pole = boxMesh(0.18, h, 0.18, mat(0x3a2a18));
  pole.position.y = h / 2; g.add(pole);
  const flag = boxMesh(small ? 1.0 : 1.5, small ? 0.6 : 0.95, 0.08, mat(faction ? faction.color : 0x8a1a1a));
  flag.position.set(small ? 0.55 : 0.86, h - 0.55, 0); g.add(flag);
  const label = makeNameSprite((small ? '☠ ' : '⚔ ') + size);
  label.scale.set(small ? 2.0 : 2.6, small ? 0.45 : 0.55, 1); label.position.y = h + 0.6; g.add(label);
  g.userData.label = label;
  return g;
}
// after a clash trims a band, repaint its floating troop count
function setBandLabel(band) {
  const g = band.group, old = g.userData.label;
  if (old) {
    g.remove(old);
    if (old.material) { if (old.material.map) old.material.map.dispose(); old.material.dispose(); }
  }
  const small = band.size <= 5;
  const lead = band.leader ? band.leader.name + '  ' : '';
  const mark = isAllyFaction(band.faction) ? '✦ ' : (small ? '☠ ' : '⚔ ');
  const label = makeNameSprite(lead + mark + band.size);
  label.scale.set(small ? 3.2 : 4.6, small ? 0.5 : 0.6, 1);
  label.position.y = (small ? 2.6 : 3.6) + 0.6;
  g.add(label); g.userData.label = label;
}
// escalating threat: warbands grow with the region cleared, total battles fought, AND how deep into
// the frontier you've pushed — hosts mustered far from home are bigger and meaner
function warbandSize() { return Math.round(rand(10, 26) + (mapLevel + wave * 0.6) * 7 + Math.floor(Math.hypot(player.pos.x, player.pos.z) / FRONTIER_STEP) * 6); }
// a band musters from its nation's homeland (on land, inside its borders)
// a land tile in a ring around the player — the war musters wherever you've roamed to, not back home
function spawnPointNearPlayer(minR, maxR) {
  for (let t = 0; t < 60; t++) {
    const ang = rand(0, Math.PI * 2), r = rand(minR, maxR);
    const x = player.pos.x + Math.cos(ang) * r, z = player.pos.z + Math.sin(ang) * r;
    if (!isWater(x, z)) return [x, z];
  }
  return nearestLand(player.pos.x + rand(-maxR, maxR), player.pos.z + rand(-maxR, maxR));
}
function spawnBand(size, speed, awayFromPlayer, nation) {
  nation = nation || nations[(Math.random() * nations.length) | 0];
  const def = nation.def;
  const [x, z] = spawnPointNearPlayer(awayFromPlayer ? 55 : 16, 150);
  const g = makePartyToken(size, def);
  g.position.set(x, mapElevY(x, z), z);
  scene.add(g);
  const band = { group: g, pos: g.position.clone(), size, alive: true, speed, faction: def,
    raider: size <= 5, clashCd: 0, parleyCd: 0,
    wanderT: rand(0, 3), wanderDir: rand(0, Math.PI * 2), level: mapLevel,
    leader: makeBandLeader(size, mapLevel, size > 5),     // a named warlord leads every host
    quality: 1 + 0.04 * mapLevel + (size > 5 ? 0.1 : 0) }; // troop quality rises with the region
  parties.push(band);
  setBandLabel(band); // banner now shows the warlord's name + their strength
}
// how many bands the region should hold — the map should always feel crowded
function targetPopulation() { return 24 + mapLevel * 3; }
function spawnMapParties() {
  // every nation fields hosts and packs from its own territory; spread evenly
  const total = targetPopulation();
  for (let i = 0; i < total; i++) {
    const nation = nations[i % nations.length];
    const host = Math.random() < 0.4;
    spawnBand(host ? warbandSize() : 2 + ((Math.random() * 4) | 0), host ? 4.5 : 6.0, false, nation);
  }
}
// trickle fresh hosts onto the map so it never empties — the war never ends
function reinforceMap() {
  const nation = nations[(Math.random() * nations.length) | 0];
  const host = Math.random() < 0.4;
  spawnBand(host ? warbandSize() : 2 + ((Math.random() * 4) | 0), host ? 4.5 : 6.0, true, nation);
}

function enterMap() {
  mode = 'map'; gameRunning = false;
  encounter = null; siegeCapital = null;
  if (typeof clearCall === 'function' && activeCall) clearCall(); // no stale call/beacon carries into a (new) region
  const encEl = document.getElementById('encounter'); if (encEl) encEl.classList.add('hidden');
  const pb = document.getElementById('cmd-deck'); if (pb) pb.classList.add('hidden'); commandPanelOpen = false; timeScale = 1;
  clearBattlefield();
  applyArenaSize(MAP_HALF);
  player.pos.set(0, 0, 0); player.vel.set(0, 0, 0);
  player.alive = true; player.hp = player.maxHp; player.stamina = player.maxStam;
  player.attacking = player.shooting = player.rolling = player.blocking = false; player.crouchT = 0;
  player.obj.scale.y = 1; player.obj.rotation.set(0, 0, 0);
  cameraAngle = 0; // top-down map: W = up the screen (toward -Z), D = right
  mapSpawnT = 6;
  if (advanceRegion || !parties.some(p => p.alive)) { advanceRegion = false; clearParties(); mapLevel++; placeCapitals(); if (isServerMap()) syncPartiesFromServer(); else spawnMapParties(); }
  applyServerWorldOnce(); // mirror the server's living world (capital owners) + show what changed while away
  // strategic worldmap dressing: biome terrain in, battle set-dressing out, neutral sky
  buildMapTerrain();
  setBattleDressing(false);
  if (ground) ground.material.color.setHex(0x6f9e54);
  scene.fog.color.setHex(0x9fc6e8); scene.background.setHex(0x9fc6e8);
  const [plx, plz] = nearestLand(0, 0); player.pos.set(plx, 0, plz); // never start at sea
  updateChunks(true); // re-centre the streamed world on the actual spawn tile
  // the player rides the map as a banner party, like the rival hosts — not the walking hero
  if (player.mapToken) { scene.remove(player.mapToken); disposeGroup(player.mapToken); }
  player.mapToken = makePlayerToken(warbandTotal());
  player.mapToken.position.copy(player.pos);
  player.mapToken.position.y = mapElevY(player.pos.x, player.pos.z);
  scene.add(player.mapToken);
  player.obj.visible = false;
  musterOverlay.classList.add('hidden');
  gameoverOverlay.classList.add('hidden');
  hud.classList.remove('hidden');
  if (document.exitPointerLock) document.exitPointerLock(); // map roams with WASD; no aim needed
  pointerLocked = false;
  updateHUD();
}

// nearest living band of a DIFFERENT faction within `radius` — drives the inter-host war
function nearestRival(band, radius) {
  let best = null, bestD = radius * radius;
  for (const o of parties) {
    if (!o.alive || o === band || !areFactionEnemies(o.faction, band.faction)) continue; // only at-war hosts are rivals
    const dx = o.pos.x - band.pos.x, dz = o.pos.z - band.pos.z, d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; best = o; }
  }
  return best;
}
// two rival bands meet off-map: the bigger host wins, bloodied; the smaller is wiped out
function killBand(band) {
  band.alive = false;
  if (band.inBattle) { // detach from any living clash before disposal (finish/teardown null this first)
    const bt = band.inBattle; band.inBattle = null;
    bt.sideA.bands = bt.sideA.bands.filter(b => b !== band);
    bt.sideB.bands = bt.sideB.bands.filter(b => b !== band);
  }
  scene.remove(band.group); disposeGroup(band.group);
}
// rival hosts trade blows: each round both sides take casualties, the smaller
// folds first. They stay locked and exchange every ~0.5s so you SEE the battle.
function resolveBandClash(a, b) {
  a.clashCd = b.clashCd = 0.5;
  // character-weighted resolution: the better-led, higher-quality host usually prevails,
  // even outnumbered. (Step 2: resolved client-side via the shared sim; the server seeds
  // and owns this in a later step. Falls back to simple attrition if the module is absent.)
  if (typeof WorldSim === 'undefined' || !WorldSim.resolveClash) {
    a.size -= Math.max(1, Math.round(b.size * 0.25));
    b.size -= Math.max(1, Math.round(a.size * 0.25));
    if (a.size <= 0) killBand(a); else setBandLabel(a);
    if (b.size <= 0) killBand(b); else setBandLabel(b);
    spawnPopup(tmpV2.copy(a.pos).lerp(b.pos, 0.5).setY(2.4), '⚔', '#ffe089');
    return;
  }
  const r = WorldSim.resolveClash(a, b, Math.random);
  r.winner.size -= r.winnerLoss;
  r.loser.size -= r.loserLoss;
  if (r.winner.leader) { // a victorious warlord's name grows with the war
    r.winner.leader.renown += 3 + 0.12 * (r.loser.size + r.loserLoss);
    r.winner.leader.battlesWon = (r.winner.leader.battlesWon || 0) + 1;
    r.winner.leader.skills.strike += 0.4; r.winner.leader.skills.lead += 0.5;
    recomputeChar(r.winner.leader);
  }
  spawnPopup(tmpV2.copy(a.pos).lerp(b.pos, 0.5).setY(2.4), '⚔', '#ffe089');
  if (r.leaderFell && r.loser.leader) { // the broken side's commander is cut down — and remembered
    spawnPopup(r.loser.pos.clone().setY(3.2), r.loser.leader.name + ' falls!', '#ff9b6b');
    if (r.loser.size > 0) r.loser.leader = makeBandLeader(r.loser.size, r.loser.level, r.loser.size > 5); // a successor raises the banner
  }
  if (a.size <= 0) { if (a.leader) spawnPopup(a.pos.clone().setY(3.2), a.leader.name + "'s host is broken", '#ff9b6b'); killBand(a); } else setBandLabel(a);
  if (b.size <= 0) { if (b.leader) spawnPopup(b.pos.clone().setY(3.2), b.leader.name + "'s host is broken", '#ff9b6b'); killBand(b); } else setBandLabel(b);
}

// nearest hold NOT already flying this nation's colors — a host's march objective (capital or settlement)
function nearestEnemyCapital(faction, x, z, radius) {
  let best = null, bd = radius * radius;
  for (const cap of nations) {
    if (!areFactionEnemies(faction, cap.owner)) continue; // march only on a hold you're at war/hostile with
    const dx = cap.x - x, dz = cap.z - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = cap; }
  }
  for (const cap of settlements) {                        // hosts raid villages and towns, not just capitals
    if (!areFactionEnemies(faction, cap.owner)) continue;
    const dx = cap.x - x, dz = cap.z - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = cap; }
  }
  return best;
}
// a host storms a rival hold: the garrison bleeds it, but the banner changes hands
function conquerByBand(cap, band) {
  cap.owner = band.faction; recolorCapital(cap);
  if (cap.key) heldOwners.set(cap.key, factionName(cap.owner)); // a settlement's new banner outlasts streaming
  band.size = Math.max(2, band.size - Math.round(cap.garrison * 0.45));
  if (band.leader) { band.leader.renown += 12 + 0.3 * cap.garrison; band.leader.skills.lead += 1; recomputeChar(band.leader); } // taking a hold makes a name
  setBandLabel(band);
  cap.garrison = Math.round(band.size * 0.7 + garrisonSize() * 0.3);
  cap.conquerCd = 9;
  spawnPopup(tmpV2.set(cap.x, 3, cap.z), '⚑', '#ffe089');
}

// move across the (unbounded) map but never onto the sea — slide along coastlines axis-by-axis
function landStep(x, z, dx, dz) {
  let nx = x + dx, nz = z + dz;
  if (isWater(nx, z)) nx = x;
  if (isWater(x, nz)) nz = z;
  return [nx, nz];
}

// ---------- Living battles: rival hosts lock into a VISIBLE clash that plays out over time ----------
// Two rival bands that meet no longer resolve in a single instant — they lock together at a
// contested point and FIGHT for a calculated stretch (a 1v1 of swordsmen ~3s, scaling ~size^0.4
// up to a ~70s siege), their numbers bleeding down before your eyes. Fresh hosts can march in to
// reinforce either side mid-fight and turn the tide, and you can ride in to join. This is what
// "show them on the map as in battle mode" means.
const mapBattles = [];
let _mapBattleId = 0;
const BATTLE_DUR_COEF = 2.4, BATTLE_DUR_EXP = 0.40, BATTLE_DUR_MIN = 2.5, BATTLE_DUR_MAX = 70;
// total battle length grows sub-linearly with the host sizes (frontage limits how many fight at
// once), and a lopsided fight breaks sooner (a rout, not a grind).
function clashDuration(sizeA, sizeB) {
  const total = Math.max(2, sizeA + sizeB);
  const pa = Math.max(1, sizeA), pb = Math.max(1, sizeB);
  const mismatch = clamp(0.5 + 0.5 * Math.min(pa, pb) / Math.max(pa, pb), 0.5, 1);
  return clamp(BATTLE_DUR_COEF * Math.pow(total, BATTLE_DUR_EXP) * mismatch, BATTLE_DUR_MIN, BATTLE_DUR_MAX);
}
function sideSize(side) { let s = 0; for (const b of side.bands) if (b.alive) s += b.size; return s; }
// combined fighting power of a side (shared resolver), led by its most renowned warlord
function sidePower(side) {
  let size = 0, qw = 0, best = null;
  for (const b of side.bands) if (b.alive) {
    size += b.size; qw += (b.quality || 1) * b.size;
    if (b.leader && (!best || !best.leader || (b.leader.renown || 0) > (best.leader.renown || 0))) best = b;
  }
  if (size <= 0) return 0;
  return (typeof WorldSim !== 'undefined' && WorldSim.bandPower)
    ? WorldSim.bandPower({ size, quality: qw / size, leader: best && best.leader })
    : size;
}
// (re)compute the eventual outcome from the CURRENT forces — at the start, and whenever
// reinforcements arrive, so a relief host genuinely changes who wins and how fast.
function recomputeBattle(bt) {
  const oldFrac = bt.duration > 0 ? clamp(bt.t / bt.duration, 0, 0.95) : 0; // a reinforcement must NOT rewind the clock
  const a = bt.sideA, b = bt.sideB;
  a.start = sideSize(a); b.start = sideSize(b);
  for (const x of a.bands) x._w = a.start > 0 ? x.size / a.start : 0;
  for (const x of b.bands) x._w = b.start > 0 ? x.size / b.start : 0;
  const Pa = sidePower(a), Pb = sidePower(b);
  if (bt.aWins == null) { const winA = Math.pow(Pa, 1.8) / ((Math.pow(Pa, 1.8) + Math.pow(Pb, 1.8)) || 1); bt.aWins = Math.random() < winA; }
  else bt.aWins = Pa >= Pb; // a reinforcement that tips the power balance flips the result
  const Pw = bt.aWins ? Pa : Pb, Pl = bt.aWins ? Pb : Pa, ratio = Pw / Math.max(0.001, Pl);
  const loserLossFrac = clamp(0.55 + 0.30 / ratio, 0.55, 0.95), winnerLossFrac = clamp(0.28 / ratio, 0.05, 0.30);
  const win = bt.aWins ? a : b, los = bt.aWins ? b : a;
  win.end = Math.max(1, Math.round(win.start * (1 - winnerLossFrac)));
  los.end = Math.max(0, Math.round(los.start * (1 - loserLossFrac)));
  bt.duration = clashDuration(a.start, b.start);
  bt.t = oldFrac * bt.duration; // resume from the progress already made (0 at creation)
}
function makeBattleMarker(bt) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(cachedGeo('cbDisc', () => { const c = new THREE.CircleGeometry(5.0, 26); c.rotateX(-Math.PI / 2); return c; }),
    mat(0xff5a2a, { shared: false, emissive: 0xff5a2a, emissiveI: 0.5 }));
  disc.material.transparent = true; disc.material.opacity = 0.3; disc.position.y = 0.2; g.add(disc); g.userData.disc = disc;
  const barY = 5.4;
  const barA = boxMesh(1, 0.5, 0.5, mat(bt.sideA.faction.color, { shared: false })); barA.position.set(0, barY, 0); g.add(barA);
  const barB = boxMesh(1, 0.5, 0.5, mat(bt.sideB.faction.color, { shared: false })); barB.position.set(0, barY, 0); g.add(barB);
  g.userData.barA = barA; g.userData.barB = barB;
  const glyph = makeNameSprite('⚔'); glyph.scale.set(2.6, 2.6, 1); glyph.position.y = barY + 1.2; g.add(glyph);
  scene.add(g);
  return g;
}
function startMapBattle(a, b) {
  const cx = (a.pos.x + b.pos.x) / 2, cz = (a.pos.z + b.pos.z) / 2;
  let axx = b.pos.x - a.pos.x, axz = b.pos.z - a.pos.z; const al = Math.hypot(axx, axz) || 1; axx /= al; axz /= al;
  const bt = {
    id: ++_mapBattleId, cx, cz, axX: axx, axZ: axz, t: 0, duration: 1, done: false, aWins: null,
    sideA: { faction: a.faction, bands: [a], start: a.size, end: a.size, live: a.size },
    sideB: { faction: b.faction, bands: [b], start: b.size, end: b.size, live: b.size },
  };
  a.inBattle = bt; b.inBattle = bt; a.clashCd = b.clashCd = 1e9; // locked: the movement loop leaves them be
  bt.marker = makeBattleMarker(bt);
  recomputeBattle(bt);
  mapBattles.push(bt);
  if (a.leader && b.leader) spawnPopup(tmpV2.set(cx, 3.0, cz), '⚔ ' + a.faction.name + ' ✦ ' + b.faction.name, '#ffe089');
  return bt;
}
function joinMapBattle(bt, band, sideKey) {
  const side = bt[sideKey];
  side.bands.push(band); band.inBattle = bt; band.clashCd = 1e9;
  if (band.leader) spawnPopup(band.pos.clone().setY(3.4), band.leader.name + ' joins the fray!', '#ffe089');
  recomputeBattle(bt);
}
function joinSide(bt, band) { // a free band collides with an ongoing battle: it joins its own faction's side
  if (band.faction === bt.sideA.faction) joinMapBattle(bt, band, 'sideA');
  else if (band.faction === bt.sideB.faction) joinMapBattle(bt, band, 'sideB');
  // a third faction passes by — it'll find its own fight
}
function applySideLive(side, frac) {
  const live = lerp(side.start, side.end, frac);
  side.live = live;
  for (const b of side.bands) {
    if (!b.alive) continue;
    const ns = Math.max(1, Math.round(live * (b._w || 0)));
    if (ns !== b.size) { b.size = ns; if (ns !== b._shownSize) { b._shownSize = ns; setBandLabel(b); } }
  }
}
function layoutBattle(bt) { // cluster each side either flank of the contested point; jitter = the shake of melee
  const place = (side, sign) => side.bands.forEach((b, k) => {
    if (!b.alive) return;
    const lane = (k - (side.bands.length - 1) / 2) * 2.2;
    const ox = bt.axX * sign * 2.2 + (-bt.axZ) * lane + rand(-0.35, 0.35);
    const oz = bt.axZ * sign * 2.2 + (bt.axX) * lane + rand(-0.35, 0.35);
    b.pos.set(bt.cx + ox, 0, bt.cz + oz);
    b.group.position.copy(b.pos);
    b.group.position.y = mapElevY(b.pos.x, b.pos.z);
    b.group.rotation.y = Math.atan2(-sign * bt.axX, -sign * bt.axZ);
  });
  place(bt.sideA, -1); place(bt.sideB, 1);
}
function updateBattleMarker(bt) {
  const m = bt.marker; if (!m) return;
  m.position.set(bt.cx, mapElevY(bt.cx, bt.cz) + 0.15, bt.cz);
  const la = Math.max(0, bt.sideA.live), lb = Math.max(0, bt.sideB.live), tot = Math.max(1, la + lb), W = 6, fa = la / tot;
  const barA = m.userData.barA, barB = m.userData.barB;
  barA.scale.x = Math.max(0.02, W * fa); barA.position.x = -W / 2 + (W * fa) / 2;
  barB.scale.x = Math.max(0.02, W * (1 - fa)); barB.position.x = -W / 2 + W * fa + (W * (1 - fa)) / 2;
  m.userData.disc.material.opacity = 0.26 + 0.12 * Math.sin(rtNow * 8);
}
function recordClashOutcome(bt) { // the winning warlord's name grows with the war (mirrors the old instant resolve)
  const win = bt.aWins ? bt.sideA : bt.sideB, los = bt.aWins ? bt.sideB : bt.sideA;
  let lead = null;
  for (const b of win.bands) if (b.alive && b.leader && (!lead || (b.leader.renown || 0) > (lead.leader.renown || 0))) lead = b;
  if (lead && lead.leader) {
    lead.leader.renown += 3 + 0.10 * los.start;
    lead.leader.battlesWon = (lead.leader.battlesWon || 0) + 1;
    lead.leader.skills.strike += 0.4; lead.leader.skills.lead += 0.5;
    recomputeChar(lead.leader);
  }
}
function finishMapBattle(bt) {
  if (bt.done) return; bt.done = true;
  recordClashOutcome(bt);
  const win = bt.aWins ? bt.sideA : bt.sideB, los = bt.aWins ? bt.sideB : bt.sideA;
  spawnPopup(tmpV2.set(bt.cx, 3.2, bt.cz), '⚔', '#ffe089');
  for (const b of los.bands) if (b.alive) { if (b.leader) spawnPopup(b.pos.clone().setY(3.2), b.leader.name + "'s host is broken", '#ff9b6b'); b.inBattle = null; killBand(b); }
  for (const b of win.bands) if (b.alive) { b.inBattle = null; b.clashCd = 1.5; b._shownSize = -1; setBandLabel(b); }
  if (bt.marker) { scene.remove(bt.marker); disposeGroup(bt.marker); }
  const i = mapBattles.indexOf(bt); if (i >= 0) mapBattles.splice(i, 1);
}
function teardownEmptyBattle(bt) { // a side was wiped out elsewhere — release the survivors
  bt.done = true;
  for (const b of bt.sideA.bands.concat(bt.sideB.bands)) if (b.alive) { b.inBattle = null; b.clashCd = 1; b._shownSize = -1; setBandLabel(b); }
  if (bt.marker) { scene.remove(bt.marker); disposeGroup(bt.marker); }
  const i = mapBattles.indexOf(bt); if (i >= 0) mapBattles.splice(i, 1);
}
function clearMapBattles() {
  for (const bt of mapBattles) { bt.done = true; if (bt.marker) { scene.remove(bt.marker); disposeGroup(bt.marker); } }
  mapBattles.length = 0;
}
function updateMapBattles(dt) {
  for (let i = mapBattles.length - 1; i >= 0; i--) {
    const bt = mapBattles[i];
    bt.sideA.bands = bt.sideA.bands.filter(b => b.alive);
    bt.sideB.bands = bt.sideB.bands.filter(b => b.alive);
    if (!bt.sideA.bands.length || !bt.sideB.bands.length) { teardownEmptyBattle(bt); continue; }
    bt.t += dt;
    const frac = clamp(bt.t / bt.duration, 0, 1);
    applySideLive(bt.sideA, frac); applySideLive(bt.sideB, frac);
    layoutBattle(bt); updateBattleMarker(bt);
    if (frac >= 1) finishMapBattle(bt);
  }
}

// ---------- Call to Arms / Crusade: rally every ally to a muster point or an enemy castle ----------
const CALL_TIMEOUT = 75;              // a standing call fades after this long if not led into battle
const CRUSADE_RADIUS = MAP_HALF * 3;  // a crusade summons allies map-wide; a field rally is CALL_MUSTER_RADIUS
let callMarker = null;
const rallyBannerEl = document.getElementById('rally-banner');
function makeCallBeacon(color) {
  const g = new THREE.Group();
  const pole = boxMesh(0.3, 8.4, 0.3, mat(0x2a1d10)); pole.position.y = 4.2; g.add(pole);
  for (let i = 0; i < 3; i++) { const f = boxMesh(2.4, 1.0, 0.12, mat(color, { shared: false, emissive: color, emissiveI: 0.45 })); f.position.set(1.35, 7.4 - i * 1.25, 0); g.add(f); }
  const ring = new THREE.Mesh(cachedGeo('callRing', () => { const c = new THREE.RingGeometry(5.6, 6.6, 40); c.rotateX(-Math.PI / 2); return c; }),
    mat(color, { shared: false, emissive: color, emissiveI: 0.5 }));
  ring.material.transparent = true; ring.material.opacity = 0.5; ring.position.y = 0.26; g.add(ring); g.userData.ring = ring;
  scene.add(g); return g;
}
function clearCall() { if (callMarker) { scene.remove(callMarker); disposeGroup(callMarker); } callMarker = null; activeCall = null; if (rallyBannerEl) rallyBannerEl.style.display = 'none'; }
function raiseCall() {
  if (mode !== 'map' || encounter) return;
  if (activeCall) { showWaveBanner('Call Withdrawn', 'You lower the war banner.'); clearCall(); return; } // press G again to cancel
  const haveAllies = playerPacts.size > 0 || (typeof window !== 'undefined' && window.net && window.net.sharedWorld);
  if (!haveAllies) { showWaveBanner('No Allies to Call', 'Forge a pact first — ride into a band, Propose Pact, then sound the call.'); return; }
  // a CRUSADE if you stand near an enemy hold; otherwise a field RALLY on your own banner
  let cap = null, bd = 34 * 34;
  for (const c of nations) { if (c.owner === PLAYER_REALM || isAllyFaction(c.owner)) continue; const dx = c.x - player.pos.x, dz = c.z - player.pos.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; cap = c; } }
  if (cap) {
    activeCall = { kind: 'crusade', x: cap.x, z: cap.z, cap, radius: CRUSADE_RADIUS, t: 0, done: false };
    callMarker = makeCallBeacon(0xff6a3a); callMarker.position.set(cap.x, mapElevY(cap.x, cap.z), cap.z);
    showWaveBanner('⚔ CRUSADE!', 'You call every ally to the walls of ' + cap.def.name + ' — rally, then storm it as one host!');
  } else {
    activeCall = { kind: 'rally', x: player.pos.x, z: player.pos.z, radius: CALL_MUSTER_RADIUS, t: 0, done: false };
    callMarker = makeCallBeacon(0xffd34d); callMarker.position.set(player.pos.x, mapElevY(player.pos.x, player.pos.z), player.pos.z);
    showWaveBanner('Call to Arms', 'Allied banners within reach march to your side. Lead them into the fight!');
  }
  if (typeof window !== 'undefined' && window.net && window.net.broadcastCall) // multiplayer: tell other players (Phase 5 surfaces it)
    window.net.broadcastCall({ kind: activeCall.kind, x: activeCall.x, z: activeCall.z, hold: cap ? cap.def.name : null });
  updateRallyBanner();
}
function updateRallyBanner() {
  if (!rallyBannerEl) return;
  if (!activeCall || mode !== 'map') { rallyBannerEl.style.display = 'none'; return; }
  const answering = gatherAlliedReinforcements(activeCall.x, activeCall.z, activeCall.radius).length;
  const left = Math.max(0, Math.ceil(CALL_TIMEOUT - activeCall.t));
  rallyBannerEl.style.display = 'block';
  rallyBannerEl.textContent = (activeCall.kind === 'crusade'
    ? '⚔ CRUSADE on ' + (activeCall.cap ? activeCall.cap.def.name : 'the hold')
    : '⚑ Rally to your banner') + ' — ' + answering + ' banner' + (answering !== 1 ? 's' : '') + ' marching · ' + left + 's (G to cancel)';
}
function updateActiveCall(dt) {
  activeCall.t += dt;
  if (activeCall.kind === 'rally') { activeCall.x = player.pos.x; activeCall.z = player.pos.z; if (callMarker) callMarker.position.set(player.pos.x, mapElevY(player.pos.x, player.pos.z), player.pos.z); }
  if (callMarker && callMarker.userData.ring) callMarker.userData.ring.material.opacity = 0.32 + 0.2 * Math.sin(rtNow * 5);
  if (activeCall.kind === 'crusade' && activeCall.cap && (activeCall.cap.owner === PLAYER_REALM || isAllyFaction(activeCall.cap.owner))) {
    showWaveBanner('Crusade Won', activeCall.cap.def.name + ' has fallen to your alliance!'); clearCall(); return;
  }
  if (activeCall.t > CALL_TIMEOUT) { showWaveBanner('The Host Disperses', 'Your call fades unanswered.'); clearCall(); return; }
  updateRallyBanner();
}
addEventListener('keydown', (e) => { if (e.code === 'KeyG' && mode === 'map' && !encounter) { e.preventDefault(); raiseCall(); } });

// Fold the distance just ridden into the running survey reach, then push fog / stream-radius to match.
// (The camera lift+pullback is read from mapVista in updateMapCamera so the zoom-out stays smoothed.)
function applyVista(moved, dt) {
  if (moved > 0) {
    mapMiles += moved;
    mapVista = mapMiles / (mapMiles + VISTA.k);
    _mileSaveT += dt;
    if (_mileSaveT > 5) { _mileSaveT = 0; try { localStorage.setItem('bv-map-miles', String(Math.round(mapMiles))); } catch (e) {} }
  }
  scene.fog.near = vlerp(VISTA.fogNear);
  scene.fog.far = vlerp(VISTA.fogFar);
  const wantView = Math.round(vlerp(VISTA.view));
  if (wantView !== VIEW) {
    const grew = wantView > VIEW;
    VIEW = wantView;
    updateChunks(true); // re-stream at the new radius right away
    if (grew) showCmdToast('The land opens before you — your scouts range farther.');
  }
}

function updateMap(dt) {
  if (encounter) return; // a parley/siege prompt is open — the whole map holds until you choose
  const serverDriven = isServerMap(); // when online, the server owns the macro war (clashes/conquests)
  tickMapDiplomacy(dt, serverDriven); // evolve faction relations: server truth online, shared kernel in solo
  // the party glides across the map as a banner; faster than enemy bands so you can flee
  const dir = inputDir();
  if (dir.lengthSq() > 0) {
    player.vel.addScaledVector(dir, player.speed * 1.5 * dt * 9);
    player.facing = angleLerp(player.facing, Math.atan2(dir.x, dir.z), dt * 12);
  }
  player.vel.multiplyScalar(Math.pow(0.0001, dt));
  const opx = player.pos.x, opz = player.pos.z;
  const [npx, npz] = landStep(opx, opz, player.vel.x * dt, player.vel.z * dt);
  player.pos.x = npx; player.pos.z = npz; player.pos.y = 0;
  if (npx === opx) player.vel.x = 0; // bumped the coast — kill that component
  if (npz === opz) player.vel.z = 0;
  if (player.mapToken) {
    player.mapToken.position.copy(player.pos);
    player.mapToken.position.y = mapElevY(player.pos.x, player.pos.z);
    player.mapToken.rotation.y = player.facing;
  }
  // tally the ground actually covered → grow the vista (haze, zoom, stream-radius all follow)
  applyVista(Math.hypot(npx - opx, npz - opz), dt);
  updateChunks(); // stream fresh terrain + settlements in as the player crosses chunk lines
  terrGenT += dt; // advance the living territory in discrete generations so it reads as "stepping"
  for (let g = 0; terrGenT >= TERR_GEN_T && g < 4; g++) { terrGenT -= TERR_GEN_T; stepTerritory(); }

  let aliveParties = 0;
  for (const band of parties) {
    if (!band.alive) continue;
    aliveParties++;
    if (band.clashCd > 0) band.clashCd -= dt;
    if (band.parleyCd > 0) band.parleyCd -= dt;
    const to = tmpV.subVectors(player.pos, band.pos); to.y = 0;
    const d = to.length();
    if (band.inBattle) {
      // locked in a living clash — its banner is driven by the battle system. Hold here, but let
      // the player ride in to join the fray (a bigger token, so a slightly wider reach).
      if (d < 4.2 && band.parleyCd <= 0 && -(player.vel.x * to.x + player.vel.z * to.z) > 0.3) { openEncounter(band); return; }
      continue;
    }
    // The hosts wage their OWN war and pay the unaligned player no mind — they
    // hunt rival nations, not you. You choose your fights by riding into a band.
    let mvx, mvz;
    // a standing Call to Arms overrides an allied band's own war: it marches to the muster point
    const answeringCall = activeCall && !activeCall.done && isAllyFaction(band.faction) &&
      Math.hypot(band.pos.x - activeCall.x, band.pos.z - activeCall.z) <= activeCall.radius;
    const rival = answeringCall ? null : nearestRival(band, 70);
    const objective = (answeringCall || rival) ? null : nearestEnemyCapital(band.faction, band.pos.x, band.pos.z, 85);
    if (answeringCall) {                                       // rally to your banner / the crusade's walls
      const rx = activeCall.x - band.pos.x, rz = activeCall.z - band.pos.z, rd = Math.hypot(rx, rz) || 1;
      if (rd < 10) { mvx = 0; mvz = 0; } else { mvx = rx / rd; mvz = rz / rd; }
    } else if (rival) {
      const rx = rival.pos.x - band.pos.x, rz = rival.pos.z - band.pos.z, rd = Math.hypot(rx, rz) || 1;
      const sign = rival.size > band.size * 2.4 ? -1 : 1; // charge a fair fight; edge off a far larger host
      mvx = sign * rx / rd; mvz = sign * rz / rd;
    } else if (objective) {                                    // no rival near → march on an enemy hold
      const rx = objective.x - band.pos.x, rz = objective.z - band.pos.z, rd = Math.hypot(rx, rz) || 1;
      mvx = rx / rd; mvz = rz / rd;
    } else {                                                   // nothing to take → wander home ground
      band.wanderT -= dt;
      if (band.wanderT <= 0) { band.wanderDir += rand(-1.2, 1.2); band.wanderT = rand(1.5, 4); }
      mvx = Math.sin(band.wanderDir); mvz = Math.cos(band.wanderDir);
    }
    const sp = band.speed || 5;
    const [bnx, bnz] = landStep(band.pos.x, band.pos.z, mvx * sp * dt, mvz * sp * dt);
    if (bnx === band.pos.x && bnz === band.pos.z) { band.wanderDir = rand(0, Math.PI * 2); band.wanderT = rand(0.6, 1.5); } // shore-blocked → turn
    band.pos.x = bnx; band.pos.z = bnz;
    band.group.position.copy(band.pos);
    band.group.position.y = mapElevY(band.pos.x, band.pos.z);
    // ride into a band (moving toward it) to meet it — then choose: attack, or just hail
    if (d < 3.4 && band.parleyCd <= 0 && -(player.vel.x * to.x + player.vel.z * to.z) > 1) { openEncounter(band); return; }
  }

  const holds = settlements.length ? nations.concat(settlements) : nations; // every hold near you this frame
  // ride up to any hold — capital, city, town or village — to lay siege (or leave); also age its timers
  for (const cap of holds) {
    if (cap.parleyCd > 0) cap.parleyCd -= dt;
    if (cap.conquerCd > 0) cap.conquerCd -= dt;
    const dx = player.pos.x - cap.x, dz = player.pos.z - cap.z;
    const reach = cap.tier === 'city' ? 5.0 : cap.tier === 'town' ? 4.2 : cap.tier === 'village' ? 3.4 : 4.6;
    if (dx * dx + dz * dz < reach * reach && cap.parleyCd <= 0 && -(player.vel.x * dx + player.vel.z * dz) > 1) { openSiege(cap); return; }
  }

  // rival hosts that collide LOCK INTO a living battle (or reinforce one already raging)
  for (let i = 0; !serverDriven && i < parties.length; i++) {
    const p = parties[i];
    if (!p.alive || p.clashCd > 0) continue; // locked bands carry a huge clashCd — they never initiate
    for (let j = i + 1; j < parties.length; j++) {
      const q = parties[j];
      if (!q.alive || !areFactionEnemies(q.faction, p.faction)) continue; // allies & truces don't clash
      const dx = p.pos.x - q.pos.x, dz = p.pos.z - q.pos.z;
      if (dx * dx + dz * dz >= 3.6 * 3.6) continue;
      if (q.inBattle) joinSide(q.inBattle, p); // p (free) reinforces q's ongoing clash
      else startMapBattle(p, q);               // two free hosts meet — a new visible battle begins
      break;
    }
  }
  updateMapBattles(dt); // advance every living clash: bleed the lines, then resolve
  // a host that reaches a rival hold strong enough storms it — the banner changes hands
  for (const band of parties) {
    if (serverDriven) break;
    if (!band.alive || band.inBattle) continue;
    for (const cap of holds) {
      if (cap.conquerCd > 0 || !areFactionEnemies(band.faction, cap.owner)) continue; // only storm enemy holds
      const dx = band.pos.x - cap.x, dz = band.pos.z - cap.z;
      if (dx * dx + dz * dz < 3.6 * 3.6 && band.size >= cap.garrison * 0.5) { conquerByBand(cap, band); break; }
    }
  }
  // sweep out the fallen so the map and counts stay clean
  for (let i = parties.length - 1; i >= 0; i--) if (!parties[i].alive) parties.splice(i, 1);

  // keep the region topped up to its target so there's always a fight nearby —
  // wars and your hunts thin the bands, fresh hosts march in to replace them
  aliveParties = parties.length;
  mapSpawnT -= dt;
  if (!serverDriven && mapSpawnT <= 0) {
    mapSpawnT = 2.2;
    let add = Math.min(3, targetPopulation() - aliveParties);
    while (add-- > 0) { reinforceMap(); aliveParties++; }
  }
  if (activeCall) updateActiveCall(dt); // advance a standing Call to Arms / Crusade
  if (aliveParties === 0 && !serverDriven) enterMap(); // somehow emptied → next, bigger region
  sendPresenceMaybe(dt); // multiplayer: heartbeat your banner + refresh rivals
  enemyCountEl.textContent = 'Band ' + warbandTotal() + ' · Foes nearby: ' + aliveParties;
}

// --- build an enemy band roster (a flat list of defs), scaled to its size ---
function buildEnemyRoster(size, level) {
  const roster = [];
  const add = (type, n) => { for (let i = 0; i < n; i++) roster.push({ type }); };
  add('archer', Math.round(size * 0.15));
  add('thrower', Math.round(size * 0.1));
  add('brute', Math.round(size * 0.12));
  add('longsword', Math.round(size * 0.12));
  add('rogue', Math.round(size * 0.12));
  while (roster.length < size) roster.push({ type: 'grunt' });
  roster.length = size;
  const nHeroes = size >= 40 ? 2 : size >= 16 ? 1 : 0;
  for (let i = 0; i < nHeroes; i++) { const h = nextHero(); roster.push({ type: h.base, hero: h }); }
  return roster;
}
function defKey(def) {
  return def.cls || (def === ALLY_LONGSWORD ? 'long' : def === ALLY_ARCHER ? 'archer' : def === ALLY_THROWER ? 'thrower' : 'sword');
}

// ---------- Allied reinforcements: pacted bands & answered banners fight on YOUR side ----------
// A "borrowed" soldier fields like one of yours but never folds into your persistent warband (it
// belongs to its own nation/ally) — applyBattleGrowth drops them, and their deaths don't dock your XP.
const ALLY_RECRUIT_MIX = ['sword', 'sword', 'long', 'archer', 'sword', 'long', 'thrower'];
function makeBorrowedChar(classKey, factionName, level) {
  const c = makeChar(classKey, { team: 'ally', notability: 1 });
  c.borrowed = true; c.allyFaction = factionName || 'Allies';
  c.skills.strike = rand(0, 6 + level * 4); c.skills.guard = rand(0, 4 + level * 3);
  recomputeChar(c);
  return c;
}
function buildAllyReinforcement(size, level, factionName) {
  const out = [];
  for (let i = 0; i < size; i++) {
    const k = ALLY_RECRUIT_MIX[i % ALLY_RECRUIT_MIX.length];
    out.push({ def: ALLY_DEF_BY_CLASS[k], char: makeBorrowedChar(k, factionName, level) });
  }
  return out;
}
const ALLY_JOIN_RADIUS = 36; // pacted bands this close to a fight rush in spontaneously
function gatherAlliedReinforcements(x, z, radius) {
  const helpers = [];
  for (const b of parties) {
    if (!b.alive || b.inBattle || !isAllyFaction(b.faction)) continue;
    if (Math.hypot(b.pos.x - x, b.pos.z - z) <= radius) helpers.push(b);
  }
  return helpers;
}
// assemble every ally that answers: pre-committed hosts (a clash you rode into), bands a Call summoned,
// and any pacted band right beside the fight. Committed bands leave the map (consumed into your host).
function assembleAllies(bx, bz, preCommitted) {
  const contributors = []; let banners = 0;
  const take = (b) => { if (b && b.size > 0) { contributors.push({ size: b.size, level: b.level || mapLevel, faction: b.faction }); banners++; } };
  if (preCommitted) for (const b of preCommitted) take(b);
  const radius = (activeCall && !activeCall.done) ? (activeCall.radius || CALL_MUSTER_RADIUS) : ALLY_JOIN_RADIUS; // a Call widens the reach
  for (const b of gatherAlliedReinforcements(bx, bz, radius)) {
    if (preCommitted && preCommitted.indexOf(b) >= 0) continue;
    take(b); b.inBattle = null; killBand(b); // marches off the map to fight beside you
  }
  return { contributors, banners };
}

const BATTLE_FRONT = 0; // enemies mass toward +Z; the player faces them
function enterBattle(band) {
  battleParty = band;
  wave++;
  waveKills = waveHeroKills = waveLosses = 0;
  clearBattlefield();
  // the clash takes on the look of the map region it's fought in
  applyBiome(biomeAt(band.pos.x, band.pos.z));
  setBattleDressing(true);
  if (player.mapToken) player.mapToken.visible = false;
  player.obj.visible = true;
  cameraAngle = Math.PI; // battle camera sits behind the player, facing the host
  if (!playerChar) loadCareers();                // debug entry points may skip startGame
  ensureWarbandRoster();                          // name & carry forward every soldier you field
  beginBattleCareers();
  playerReserve = warbandRoster.map(c => ({ def: ALLY_DEF_BY_CLASS[classKeyOf(c.archetype)], char: c })); // named, growable
  // allies answer the call: nearby pacted bands (and any host you rode in to aid) join YOUR side
  const muster = assembleAllies(band.pos.x, band.pos.z, band.alliedBands);
  battleAllyBanners = muster.banners; battleReinforced = 0;
  coopMult = clamp(1 + 0.05 * muster.banners, 1, 1.5); // working together: harder hits, more grit (up to +50%)
  for (const c of muster.contributors) { for (const it of buildAllyReinforcement(c.size, c.level, c.faction && c.faction.name)) playerReserve.push(it); battleReinforced += c.size; }
  if (activeCall) clearCall(); // the muster is led into battle — the call is answered and lowered
  enemyReserve = buildEnemyRoster(band.size, band.level);
  enemiesRemaining = enemyReserve.length;
  // big hosts overflow the field cap: shuffle both reserves so the OPENING line is a
  // representative mix of the whole army, not LIFO-biased to the last class mustered
  shuffleInPlace(playerReserve); shuffleInPlace(enemyReserve);
  // size the arena to the forces actually on the field
  const onField = Math.min(FIELD_CAP, playerReserve.length) + Math.min(FIELD_CAP, enemyReserve.length);
  applyArenaSize(clamp(FRONT_GAP + 22 + onField * 0.3, ARENA_BASE, ARENA_MAX)); // big enough to hold the gap + both lines
  cameraDist = 7.5; cameraHeight = 4;
  player.pos.set(0, 0, 0); player.vel.set(0, 0, 0); player.obj.position.set(0, 0, 0);
  player.obj.rotation.set(0, 0, 0); player.obj.scale.y = 1;
  player.alive = true; player.hp = player.maxHp; player.stamina = player.maxStam;
  player.facing = BATTLE_FRONT;
  fieldBatch(); // muster both front lines so you can plan against the real threat
  updateEnemyCount();
  if (battleAllyBanners > 0) showWaveBanner(battleAllyBanners + ' Banner' + (battleAllyBanners > 1 ? 's' : '') + ' Answer!',
    '+' + battleReinforced + ' allied troops at your side · coordination +' + Math.round((coopMult - 1) * 100) + '% might. Strike as one!');
  coopMaybeHostBattle(band); // shared world: beacon this fight so allies can ride in to join it live
  enterPlanPhase(band); // deploy & command your warband, then Begin Battle
}

// ---------- Command Deck: build, position & command squads (plan AND mid-battle) ----------
const selected = new Set();        // allies currently selected
let planGroups = [];               // squads: [{ id, name, color, order, anchor, lastPreset }]
let planGroupCounter = 0, activeGroupId = null;
const GROUP_COLORS = [0xffd34d, 0x4dd2ff, 0xff7bd0, 0x9aff6b, 0xffa24d, 0xc08bff, 0xff6b6b, 0x6bd0ff, 0xd0ff6b];
const CLASS_KEYS = ['sword', 'long', 'archer', 'thrower'];
const CLASS_NAME = { sword: 'Swords', long: 'Longswords', archer: 'Archers', thrower: 'Throwers' };
const ORDERS = [['attack', 'Charge'], ['hold', 'Hold'], ['regroup', 'Regroup'], ['free', 'Free']];
const ORDER_LABEL = { attack: 'Charging', hold: 'Holding', zone: 'Holding zone', regroup: 'Regrouping', free: 'At will' };
const PACES = [['march', '🐢 March'], ['rush', '⚡ Rush']];
let cmdDeck = null, selBox = null, zoneBox = null;
let commandPanelOpen = false, timeScale = 1;
const _planPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _planRay = new THREE.Raycaster();
const _planNDC = new THREE.Vector2();
let planDrag = null;
const planActive = () => mode === 'plan' || commandPanelOpen; // tactical input/camera live in both

function setAllySelected(a, on) {
  if (on && !a.selRing) {
    const ring = new THREE.Mesh(
      cachedGeo('selring', () => { const g = new THREE.RingGeometry(0.95, 1.25, 20); g.rotateX(-Math.PI / 2); return g; }),
      mat(0x7dff9a, { emissive: 0x2a8a40, emissiveI: 0.7 }));
    ring.position.y = 0.09; a.obj.add(ring); a.selRing = ring;
  }
  if (a.selRing) a.selRing.visible = on;
}
function clearSelection() { for (const a of selected) setAllySelected(a, false); selected.clear(); }
function setSelection(list, add) {
  if (!add) { for (const a of selected) setAllySelected(a, false); selected.clear(); }
  for (const a of list) if (a.alive) { selected.add(a); setAllySelected(a, true); }
}
function selectType(key) { setSelection(allies.filter(a => a.alive && (key === 'all' || defKey(a.def) === key))); }
function updateGroupRing(a) {
  const g = a.group != null ? planGroups.find(x => x.id === a.group) : null;
  if (g) {
    if (!a.grpRing) {
      a.grpRing = new THREE.Mesh(
        cachedGeo('grpring', () => { const ge = new THREE.RingGeometry(1.35, 1.62, 22); ge.rotateX(-Math.PI / 2); return ge; }),
        mat(0xffffff, { shared: false }));
      a.grpRing.position.y = 0.07; a.obj.add(a.grpRing);
    }
    a.grpRing.material.color.setHex(g.color);
    a.grpRing.material.emissive.setHex(g.color); a.grpRing.material.emissiveIntensity = 0.4;
    a.grpRing.visible = true;
  } else if (a.grpRing) a.grpRing.visible = false;
}
// ----- group CRUD -----
function newGroup() {
  const g = { id: ++planGroupCounter, name: 'Group ' + planGroupCounter, color: GROUP_COLORS[(planGroupCounter - 1) % GROUP_COLORS.length], order: 'free', pace: 'march', anchor: null, zone: null, zoneMesh: null, holdMarker: null, recipe: { sword: 0, long: 0, archer: 0, thrower: 0 }, lastPreset: null, leaderId: null };
  planGroups.push(g); activeGroupId = g.id;
  renderDeck();
  return g;
}
function selectGroup(g) {
  activeGroupId = g.id;
  setSelection(allies.filter(a => a.alive && a.group === g.id));
  renderDeck();
}
function deleteGroup(g) {
  for (const a of allies) if (a.group === g.id) { a.group = null; updateGroupRing(a); }
  disposeZoneOverlay(g); disposeHoldMarker(g);
  planGroups = planGroups.filter(x => x.id !== g.id);
  if (activeGroupId === g.id) activeGroupId = planGroups.length ? planGroups[planGroups.length - 1].id : null;
  renderDeck();
}
function resetGroups() {
  for (const g of planGroups) { disposeZoneOverlay(g); disposeHoldMarker(g); }
  for (const a of allies) { a.group = null; a.zone = null; a.homeSlot = null; if (a.grpRing) a.grpRing.visible = false; }
  planGroups = []; planGroupCounter = 0; activeGroupId = null;
}
// ----- zone (hold-area) ground overlays: a translucent coloured rectangle so the plan is legible -----
function buildZoneOverlay(colorHex) {
  const grp = new THREE.Group();
  const fillGeo = cachedGeo('zonefill', () => { const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); return g; });
  const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
  fill.position.y = 0.04;
  const sqGeo = cachedGeo('zonesq', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0, -0.5], 3));
    return g;
  });
  const border = new THREE.Line(sqGeo, new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.9 }));
  border.position.y = 0.06;
  grp.add(fill); grp.add(border);
  grp.userData = { fill, border };
  scene.add(grp);
  return grp;
}
function updateZoneOverlay(g) {
  if (!g.zone) { if (g.zoneMesh) g.zoneMesh.visible = false; return; }
  if (!g.zoneMesh) g.zoneMesh = buildZoneOverlay(g.color);
  else { g.zoneMesh.userData.fill.material.color.setHex(g.color); g.zoneMesh.userData.border.material.color.setHex(g.color); }
  const r = g.zone, w = Math.max(2, r.maxX - r.minX), d = Math.max(2, r.maxZ - r.minZ);
  g.zoneMesh.visible = true;
  g.zoneMesh.position.set((r.minX + r.maxX) / 2, 0, (r.minZ + r.maxZ) / 2);
  g.zoneMesh.userData.fill.scale.set(w, 1, d);
  g.zoneMesh.userData.border.scale.set(w, 1, d);
}
function disposeZoneOverlay(g) {
  if (!g.zoneMesh) return;
  scene.remove(g.zoneMesh);
  g.zoneMesh.userData.fill.material.dispose();
  g.zoneMesh.userData.border.material.dispose();
  g.zoneMesh = null;
}
// ----- hold-point marker: a coloured rally flag on the ground so a "move here & hold" order is legible -----
function buildHoldMarker(colorHex) {
  const grp = new THREE.Group();
  const ringGeo = cachedGeo('holdring', () => { const g = new THREE.RingGeometry(1.5, 2.0, 24); g.rotateX(-Math.PI / 2); return g; });
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
  ring.position.y = 0.05;
  const postGeo = cachedGeo('holdpost', () => new THREE.CylinderGeometry(0.12, 0.12, 3.2, 6));
  const post = new THREE.Mesh(postGeo, new THREE.MeshBasicMaterial({ color: colorHex }));
  post.position.y = 1.6;
  const flagGeo = cachedGeo('holdflag', () => new THREE.PlaneGeometry(1.4, 0.8));
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide }));
  flag.position.set(0.7, 2.7, 0);
  grp.add(ring); grp.add(post); grp.add(flag);
  grp.userData = { ring, post, flag };
  scene.add(grp);
  return grp;
}
function updateHoldMarker(g) {
  const show = g.order === 'hold' && g.anchor;
  if (!show) { if (g.holdMarker) g.holdMarker.visible = false; return; }
  if (!g.holdMarker) g.holdMarker = buildHoldMarker(g.color);
  else for (const m of [g.holdMarker.userData.ring, g.holdMarker.userData.post, g.holdMarker.userData.flag]) m.material.color.setHex(g.color);
  g.holdMarker.visible = true;
  g.holdMarker.position.set(g.anchor.x, 0, g.anchor.z);
}
function disposeHoldMarker(g) {
  if (!g.holdMarker) return;
  scene.remove(g.holdMarker);
  for (const k of ['ring', 'post', 'flag']) g.holdMarker.userData[k].material.dispose();
  g.holdMarker = null;
}
// ----- remembered squads: persist composition + orders, re-bind to a fresh muster each battle -----
function refreshGroupRecipe(g) {
  const r = { sword: 0, long: 0, archer: 0, thrower: 0 };
  for (const a of allies) if (a.alive && a.group === g.id) { const k = defKey(a.def); if (r[k] != null) r[k]++; }
  g.recipe = r;
}
// at the start of every plan the warband is freshly mustered (new ally objects). Pour the pool
// back into the squads the player set up last time — by class recipe — and replay their orders.
function rebindGroupsToPool() {
  for (const a of allies) { a.group = null; a.zone = null; a.homeSlot = null; a.holdPos = null; a.order = 'free'; if (a.grpRing) a.grpRing.visible = false; }
  for (const g of planGroups) {
    for (const key of CLASS_KEYS) {
      let need = (g.recipe && g.recipe[key]) || 0;
      for (const a of allies) { if (need <= 0) break; if (a.alive && a.group == null && defKey(a.def) === key) { a.group = g.id; a.pace = g.pace || 'march'; updateGroupRing(a); need--; } }
    }
  }
  for (const g of planGroups) {
    const members = allies.filter(a => a.alive && a.group === g.id);
    // re-seat the squad's leader on the fresh muster: keep them if they still stand in the ranks,
    // else promote the most renowned champion present (the player leads from anywhere, so keep that)
    const playerLeads = playerChar && g.leaderId === playerChar.id;
    if (!playerLeads && (g.leaderId == null || !members.some(a => a.char && a.char.id === g.leaderId))) {
      const champs = members.filter(a => a.char && isChampion(a.char)).sort((a, b) => b.char.renown - a.char.renown);
      g.leaderId = champs.length ? champs[0].char.id : null;
    }
    if (!members.length) { disposeZoneOverlay(g); disposeHoldMarker(g); continue; }
    for (const a of members) a.pace = g.pace || 'march';
    if (g.order === 'zone' && g.zone) { assignZone(members, g.zone, true); updateZoneOverlay(g); }
    else if (g.order === 'hold' && g.anchor) { arrayGroupAt(members, g.anchor, true); updateHoldMarker(g); }
    else if (g.order === 'attack') applyPresetToMembers(members, 'attack', g);
    else if (g.order === 'regroup') applyPresetToMembers(members, 'regroup', g);
  }
  if (!planGroups.some(g => g.id === activeGroupId)) activeGroupId = planGroups.length ? planGroups[0].id : null;
}
// ----- roster pool + composition (field bodies only; over-allocation impossible) -----
function countPool(key) { let n = 0; for (const a of allies) if (a.alive && a.group == null && defKey(a.def) === key) n++; return n; }
function groupSize(g) { let n = 0; for (const a of allies) if (a.alive && a.group === g.id) n++; return n; }
// a led squad can hold only as many as its champion commands; a leaderless squad is unbounded
function groupCap(g) { const lc = leaderCharById(g.leaderId); return lc ? commandCap(lc) : Infinity; }
function assignToGroup(g, key, delta) {
  if (delta > 0) {
    const room = groupCap(g) - groupSize(g);              // a champion only commands so many
    let added = 0;
    for (const a of allies) { if (added >= delta || added >= room) break; if (a.alive && a.group == null && defKey(a.def) === key) { a.group = g.id; a.pace = g.pace || 'march'; if (g.order && g.order !== 'free' && g.order !== 'zone') applyPresetToMembers([a], g.order, null); updateGroupRing(a); added++; } }
  } else {
    const members = allies.filter(a => a.alive && a.group === g.id && defKey(a.def) === key);
    for (let i = members.length - 1, rem = 0; i >= 0 && rem < -delta; i--, rem++) { members[i].group = null; members[i].zone = null; members[i].homeSlot = null; updateGroupRing(members[i]); }
  }
  if (g.order === 'zone' && g.zone) assignZone(allies.filter(a => a.alive && a.group === g.id), g.zone, mode === 'plan'); // re-spread the garrison
  refreshGroupRecipe(g);
  renderDeck();
}
function addSelectionToGroup() { // legacy convenience: drop the current selection into the active group
  if (!selected.size) return;
  const g = planGroups.find(x => x.id === activeGroupId) || newGroup();
  let room = groupCap(g) - groupSize(g);               // respect the leader's command cap
  for (const a of selected) { if (room <= 0) break; a.group = g.id; a.pace = g.pace || 'march'; if (g.order && g.order !== 'free' && g.order !== 'zone') applyPresetToMembers([a], g.order, null); updateGroupRing(a); room--; }
  if (g.order === 'zone' && g.zone) assignZone(allies.filter(a => a.alive && a.group === g.id), g.zone, mode === 'plan');
  refreshGroupRecipe(g);
  renderDeck();
}
function splitIntoGroups(n, recipe) {
  for (let i = 0; i < n; i++) { const g = newGroup(); for (const key of CLASS_KEYS) if (recipe[key] > 0) assignToGroup(g, key, recipe[key]); }
  renderDeck();
}
// ----- formation + order anchors -----
function arrayGroupAt(members, P, teleport) {
  const sel = members.filter(a => a.alive);
  if (!sel.length) return;
  sel.sort((a, b) => (a.def.ranged ? 1 : 0) - (b.def.ranged ? 1 : 0)); // melee front, ranged rear
  const perRow = Math.max(1, Math.round(Math.sqrt(sel.length) * 1.3));
  const rows = Math.ceil(sel.length / perRow);
  sel.forEach((a, i) => {
    const row = Math.floor(i / perRow), col = i % perRow;
    const x = clamp(P.x + (col - (perRow - 1) / 2) * 2.3, -ARENA + 1, ARENA - 1);
    const z = clamp(P.z + ((rows - 1) / 2 - row) * 2.3, -ARENA + 1, ARENA - 1);
    a.order = 'hold'; a.holdPos = new THREE.Vector3(x, 0, z); a.zone = null; a.homeSlot = null;
    if (teleport) { a.pos.set(x, 0, z); a.obj.position.copy(a.pos); a.facing = BATTLE_FRONT; a.obj.rotation.y = a.facing; }
  });
}
// distribute a group across a drawn rectangle (a garrison), each soldier given a home slot inside it
function assignZone(members, rect, teleport) {
  const live = members.filter(a => a.alive);
  if (!live.length) return;
  live.sort((a, b) => (a.def.ranged ? 1 : 0) - (b.def.ranged ? 1 : 0)); // melee toward the leading edge, ranged behind
  const w = Math.max(2, rect.maxX - rect.minX), d = Math.max(2, rect.maxZ - rect.minZ);
  const cols = Math.max(1, Math.round(Math.sqrt(live.length * (w / d))));
  const rows = Math.max(1, Math.ceil(live.length / cols));
  live.forEach((a, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const fx = cols > 1 ? c / (cols - 1) : 0.5;
    const fz = rows > 1 ? r / (rows - 1) : 0.5;
    const x = clamp(rect.minX + (0.12 + fx * 0.76) * w, -ARENA + 1, ARENA - 1);
    const z = clamp(rect.minZ + (0.12 + fz * 0.76) * d, -ARENA + 1, ARENA - 1);
    a.order = 'zone'; a.zone = rect; a.holdPos = null; a.homeSlot = new THREE.Vector3(x, 0, z);
    if (teleport) { a.pos.set(x, 0, z); a.obj.position.copy(a.pos); a.facing = BATTLE_FRONT; a.obj.rotation.y = a.facing; }
  });
}
function enemyCentroid() {
  let n = 0, x = 0, z = 0;
  for (const e of enemies) if (e.alive) { n++; x += e.pos.x; z += e.pos.z; }
  return n ? new THREE.Vector3(x / n, 0, z / n) : new THREE.Vector3(0, 0, ARENA * 0.6);
}
function recallAnchor() { // a rally a few paces behind the player
  const fx = Math.sin(BATTLE_FRONT), fz = Math.cos(BATTLE_FRONT);
  return new THREE.Vector3(clamp(player.pos.x - fx * 4, -ARENA + 2, ARENA - 2), 0, clamp(player.pos.z - fz * 4, -ARENA + 2, ARENA - 2));
}
// presets compile down to the engine's free|hold|attackmove AI (+ an anchor for hold)
function applyPresetToMembers(members, preset, g) {
  const live = members.filter(a => a.alive);
  if (!live.length) return;
  if (preset === 'attack') { for (const a of live) { a.order = 'attackmove'; a.holdPos = null; a.zone = null; a.homeSlot = null; } }
  else if (preset === 'free') { for (const a of live) { a.order = 'free'; a.holdPos = null; a.zone = null; a.homeSlot = null; } }
  else if (preset === 'hold') { for (const a of live) { a.order = 'hold'; a.holdPos = a.pos.clone(); a.zone = null; a.homeSlot = null; } }
  else { // 'regroup' — fall back and re-form on the player
    const P = recallAnchor();
    if (g) g.anchor = P.clone();
    arrayGroupAt(live, P, mode === 'plan'); // teleport into formation in the plan; march there mid-battle
  }
}
function orderGroup(g, preset) {
  const members = allies.filter(a => a.alive && a.group === g.id);
  if (!members.length) return;
  g.order = preset; g.lastPreset = preset;
  g.zone = null; disposeZoneOverlay(g); // these presets aren't zone-holds — drop any drawn rectangle
  applyPresetToMembers(members, preset, g);
  if (preset === 'hold') { // the "Hold" button holds the current ground — mark where
    let x = 0, z = 0; for (const a of members) { x += a.pos.x; z += a.pos.z; }
    g.anchor = new THREE.Vector3(x / members.length, 0, z / members.length); updateHoldMarker(g);
  } else { g.anchor = null; disposeHoldMarker(g); }
  renderDeck();
}
// ----- pace (march / rush) -----
function setGroupPace(g, pace) {
  g.pace = pace;
  for (const a of allies) if (a.alive && a.group === g.id) a.pace = pace;
  renderDeck();
}
// ----- leadership: a champion takes command of a squad (and can only command so many) -----
function setGroupLeader(g, charId) {
  g.leaderId = charId != null ? +charId : null;
  const lc = leaderCharById(g.leaderId);
  // a champion can only command so many — in the plan, shed the greenest over the new cap
  if (lc && mode === 'plan') {
    const cap = commandCap(lc);
    const members = allies.filter(a => a.alive && a.group === g.id);
    if (members.length > cap) {
      members.sort((a, b) => (a.char ? a.char.renown : 0) - (b.char ? b.char.renown : 0)); // greenest leave first
      for (let i = 0; i < members.length - cap; i++) { const a = members[i]; a.group = null; a.zone = null; a.homeSlot = null; updateGroupRing(a); }
      refreshGroupRecipe(g);
    }
  }
  renderDeck();
}
function commandPace(pace) {
  const g = planGroups.find(x => x.id === activeGroupId);
  if (g && selected.size && [...selected].every(a => a.group === g.id)) { setGroupPace(g, pace); return; }
  let any = false; for (const a of selected) if (a.alive) { a.pace = pace; any = true; }
  if (any) renderDeck();
}
// ----- hold-zone (draw a rectangle to garrison an area) -----
function setGroupZone(g, rect) {
  g.order = 'zone'; g.lastPreset = 'zone'; g.zone = rect;
  assignZone(allies.filter(a => a.alive && a.group === g.id), rect, mode === 'plan');
  updateZoneOverlay(g);
  renderDeck();
}
function commandZone(rect) {
  const g = planGroups.find(x => x.id === activeGroupId);
  const members = selected.size ? [...selected].filter(a => a.alive)
    : (g ? allies.filter(a => a.alive && a.group === g.id) : []);
  if (!members.length) return;
  if (g && members.every(a => a.group === g.id)) { setGroupZone(g, rect); return; } // bind to the group (gets the overlay)
  assignZone(members, rect, mode === 'plan'); renderDeck();                          // ad-hoc selection: no group overlay
}
function commandSelection(preset) { // keyboard/ad-hoc: route to the active group, else the raw selection
  const g = planGroups.find(x => x.id === activeGroupId);
  if (g && selected.size && [...selected].every(a => a.group === g.id)) { orderGroup(g, preset); return; }
  const members = [...selected].filter(a => a.alive);
  if (members.length) { applyPresetToMembers(members, preset, null); renderDeck(); }
}
const applyOrder = commandSelection; // back-compat alias
function deploySelected(P) {
  const g = planGroups.find(x => x.id === activeGroupId);
  const sel = selected.size ? [...selected].filter(a => a.alive)
    : (g ? allies.filter(a => a.alive && a.group === g.id) : []);
  if (!sel.length) return;
  arrayGroupAt(sel, P, mode === 'plan');
  if (g && sel.every(a => a.group === g.id)) { g.order = 'hold'; g.anchor = P.clone(); g.zone = null; disposeZoneOverlay(g); updateHoldMarker(g); }
  renderDeck();
}
// ----- screen<->world picking -----
function groundPointAt(cx, cy) {
  _planNDC.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  _planRay.setFromCamera(_planNDC, camera);
  const p = new THREE.Vector3();
  return _planRay.ray.intersectPlane(_planPlane, p) ? p : null;
}
function allyScreen(a) { tmpV.copy(a.pos); tmpV.y += 1; tmpV.project(camera); return tmpV; }
function alliesInBox(x0, y0, x1, y1) {
  const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }, hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
  const out = [];
  for (const a of allies) {
    if (!a.alive) continue;
    const s = allyScreen(a); if (s.z > 1) continue;
    const sx = (s.x * 0.5 + 0.5) * innerWidth, sy = (-s.y * 0.5 + 0.5) * innerHeight;
    if (sx >= lo.x && sx <= hi.x && sy >= lo.y && sy <= hi.y) out.push(a);
  }
  return out;
}
function allyAtPoint(cx, cy) {
  let best = null, bd = 36 * 36;
  for (const a of allies) {
    if (!a.alive) continue;
    const s = allyScreen(a); if (s.z > 1) continue;
    const sx = (s.x * 0.5 + 0.5) * innerWidth, sy = (-s.y * 0.5 + 0.5) * innerHeight;
    const dd = (sx - cx) ** 2 + (sy - cy) ** 2; if (dd < bd) { bd = dd; best = a; }
  }
  return best;
}
// ----- rendering -----
function renderRoster() {
  for (const key of CLASS_KEYS) {
    const el = document.getElementById('pool-' + key); if (!el) continue;
    const n = countPool(key); el.textContent = n;
    const row = el.closest('.rost-row'); if (row) row.classList.toggle('empty', n <= 0);
  }
}
function makeStepBtn(txt, disabled, fn) {
  const b = document.createElement('button'); b.textContent = txt; b.disabled = !!disabled;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
function renderDeck() {
  const wrap = document.getElementById('cd-cards');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!planGroups.length) wrap.innerHTML = '<div class="cd-empty">No groups yet — <b>Split into N</b> for instant squads, or <b>+ New Group</b>.</div>';
  for (const g of planGroups) {
    const members = allies.filter(a => a.alive && a.group === g.id);
    const hex = '#' + g.color.toString(16).padStart(6, '0');
    const card = document.createElement('div');
    card.className = 'group-card' + (g.id === activeGroupId ? ' active' : '');
    card.style.setProperty('--gc', hex);
    const cap = groupCap(g);
    const led = cap !== Infinity;
    const overCap = led && members.length > cap;
    const countTxt = led ? (members.length + '/' + capLabel(cap)) : String(members.length);
    const head = document.createElement('div'); head.className = 'gc-head';
    head.innerHTML = `<span class="gc-dot" style="background:${hex}"></span><span class="gc-name">${g.name}</span><span class="gc-count${overCap ? ' over' : ''}">${countTxt}</span><span class="gc-status">${ORDER_LABEL[g.order] || ''}</span>`;
    head.addEventListener('click', () => selectGroup(g));
    const del = document.createElement('span'); del.className = 'gc-del'; del.textContent = '×'; del.title = 'disband';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(g); });
    head.appendChild(del); card.appendChild(head);
    // leader row: which champion commands this squad (the player can lead any squad personally)
    const champsHere = members.filter(a => a.char && isChampion(a.char));
    const playerEligible = playerChar && (isChampion(playerChar) || g.leaderId === playerChar.id);
    const lead = document.createElement('div'); lead.className = 'gc-lead';
    if (champsHere.length || playerEligible) {
      const star = document.createElement('span'); star.className = 'gc-lead-star'; star.textContent = '★'; lead.appendChild(star);
      const sel = document.createElement('select'); sel.className = 'gc-lead-sel';
      sel.innerHTML = '<option value="">— no leader —</option>' +
        (playerEligible ? `<option value="${playerChar.id}">${playerChar.name} (you) · cap ${capLabel(commandCap(playerChar))}</option>` : '') +
        champsHere.map(a => `<option value="${a.char.id}">${a.char.name} · ${a.char.rank} (cap ${capLabel(commandCap(a.char))})</option>`).join('');
      sel.value = g.leaderId != null ? String(g.leaderId) : '';
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', (e) => { e.stopPropagation(); setGroupLeader(g, e.target.value ? +e.target.value : null); });
      lead.appendChild(sel);
    } else {
      lead.innerHTML = '<span class="gc-lead-none">No champion yet — a Sergeant can lead</span>';
    }
    card.appendChild(lead);
    const rows = document.createElement('div'); rows.className = 'gc-rows';
    for (const key of CLASS_KEYS) {
      const cnt = members.filter(a => defKey(a.def) === key).length;
      const row = document.createElement('div'); row.className = 'stp';
      const name = document.createElement('span'); name.className = 'stp-name'; name.textContent = CLASS_NAME[key];
      const val = document.createElement('b'); val.textContent = cnt;
      row.appendChild(name);
      row.appendChild(makeStepBtn('−', cnt <= 0, () => assignToGroup(g, key, -1)));
      row.appendChild(val);
      row.appendChild(makeStepBtn('+', countPool(key) <= 0 || members.length >= cap, () => assignToGroup(g, key, 1)));
      rows.appendChild(row);
    }
    card.appendChild(rows);
    const ord = document.createElement('div'); ord.className = 'gc-orders';
    for (const [k, label] of ORDERS) {
      const b = document.createElement('button'); b.textContent = label; if (g.order === k) b.className = 'on';
      b.addEventListener('click', (e) => { e.stopPropagation(); selectGroup(g); orderGroup(g, k); });
      ord.appendChild(b);
    }
    card.appendChild(ord);
    const pace = document.createElement('div'); pace.className = 'gc-pace';
    for (const [pk, plabel] of PACES) {
      const b = document.createElement('button'); b.textContent = plabel; if ((g.pace || 'march') === pk) b.className = 'on';
      b.addEventListener('click', (e) => { e.stopPropagation(); selectGroup(g); setGroupPace(g, pk); });
      pace.appendChild(b);
    }
    card.appendChild(pace);
    wrap.appendChild(card);
  }
  renderRoster();
}
let splitN = 4, splitRecipe = { sword: 0, long: 2, archer: 2, thrower: 0 };
function renderSplit() {
  const pop = document.getElementById('split-pop'); if (!pop) return;
  const recipeStr = CLASS_KEYS.filter(k => splitRecipe[k] > 0).map(k => splitRecipe[k] + ' ' + CLASS_NAME[k]).join(' + ') || '(pick classes)';
  let shortMsg = '';
  for (const k of CLASS_KEYS) { const need = splitN * (splitRecipe[k] || 0); if (need > countPool(k)) shortMsg += ` · short ${need - countPool(k)} ${CLASS_NAME[k]}`; }
  pop.innerHTML =
    `<div class="sp-row"><span>Groups</span><button data-sp="n-">−</button><b>${splitN}</b><button data-sp="n+">+</button></div>` +
    CLASS_KEYS.map(k => `<div class="sp-row"><span>${CLASS_NAME[k]}</span><button data-sp="${k}-">−</button><b>${splitRecipe[k]}</b><button data-sp="${k}+">+</button></div>`).join('') +
    `<div class="sp-prev">= ${splitN} × (${recipeStr})${shortMsg ? `<span class="sp-short">${shortMsg}</span>` : ''}</div>` +
    `<button class="btn" id="sp-create">Create squads</button>`;
  pop.querySelectorAll('[data-sp]').forEach(b => b.addEventListener('click', () => {
    const cmd = b.dataset.sp;
    if (cmd === 'n-') splitN = Math.max(1, splitN - 1);
    else if (cmd === 'n+') splitN = Math.min(9, splitN + 1);
    else { const k = cmd.slice(0, -1); splitRecipe[k] = Math.max(0, (splitRecipe[k] || 0) + (cmd.slice(-1) === '+' ? 1 : -1)); }
    renderSplit();
  }));
  document.getElementById('sp-create').addEventListener('click', () => {
    splitIntoGroups(splitN, splitRecipe);
    document.getElementById('split-pop').classList.add('hidden');
  });
}
function renderAll() { renderDeck(); }
// ----- phase transitions -----
function enterPlanPhase(band) {
  mode = 'plan'; gameRunning = false; commandPanelOpen = false; timeScale = 1;
  player.facing = BATTLE_FRONT;
  clearSelection(); rebindGroupsToPool(); // keep last battle's squads — re-fill them from the fresh muster
  if (document.exitPointerLock) document.exitPointerLock(); pointerLocked = false;
  if (!cmdDeck) { cmdDeck = document.getElementById('cmd-deck'); selBox = document.getElementById('sel-box'); zoneBox = document.getElementById('zone-box'); }
  hud.classList.add('hidden');
  cmdDeck.classList.remove('hidden', 'battle', 'open');
  document.getElementById('cd-begin').textContent = 'Begin Battle ⚔';
  const title = cmdDeck.querySelector('.cd-title'); if (title) title.textContent = 'Battle Plan';
  renderAll();
}
function beginBattle() {
  if (mode !== 'plan') return;
  clearSelection();
  cmdDeck.classList.add('battle'); cmdDeck.classList.remove('open');
  hud.classList.remove('hidden');
  mode = 'battle'; gameRunning = true; commandPanelOpen = false; timeScale = 1;
  player.pos.set(0, 0, 0); player.vel.set(0, 0, 0); player.obj.position.set(0, 0, 0);
  player.alive = true; player.hp = player.maxHp; player.stamina = player.maxStam;
  showWaveBanner('Clash!', 'Hold the line! · command live: 1–9/G pick · H hold · T charge · R regroup · B free · Z/X pace');
  if (canvas.requestPointerLock) canvas.requestPointerLock();
}
function openCommandDeck() { // mid-battle: cursor freed (pointer-lock lost) -> tactical command
  if (mode !== 'battle' || commandPanelOpen) return;
  commandPanelOpen = true; timeScale = 0.18; // tactical slow while you give orders
  cmdDeck.classList.add('open');
  document.getElementById('cd-begin').textContent = 'Resume ⚔';
  const title = cmdDeck.querySelector('.cd-title'); if (title) title.textContent = 'Command';
  renderAll();
}
function resumeBattle() {
  commandPanelOpen = false; timeScale = 1;
  cmdDeck.classList.remove('open');
  clearSelection();
  if (canvas.requestPointerLock) canvas.requestPointerLock();
}
// a high, tilted overview of the field — your side near, the enemy host beyond
function updatePlanCamera(dt) {
  // a steep top-down tilt that FOLLOWS the player and looks forward up the field, so
  // your line sits front-and-centre and the enemy marches into view as the lines close
  const k = clamp(dt * 5, 0, 1);
  // centre on the warband's mass so the camera rides the advance into the clash,
  // not on the player (who may hang back to command)
  let cx = player.pos.x, cz = player.pos.z, n = 0, sx = 0, sz = 0;
  for (const a of allies) if (a.alive) { sx += a.pos.x; sz += a.pos.z; n++; }
  if (n) { cx = sx / n; cz = sz / n; }
  camBase.x = lerp(camBase.x, cx, k);
  camBase.y = lerp(camBase.y, 62, k);
  camBase.z = lerp(camBase.z, cz - 48, k);
  camera.position.copy(camBase);
  camera.lookAt(cx, 0, cz + 14);
}
// tactical input — live in plan AND when the mid-battle command deck is open.
// LEFT mouse is the one tool: with a squad selected, a CLICK marches it to the spot and a
// DRAGGED box makes it hold that zone. With nothing selected, the same gestures SELECT
// (click a soldier -> his squad, drag a box -> box-select). No right-click needed.
addEventListener('mousedown', (e) => {
  if (!planActive() || e.button !== 0 || (e.target && e.target.closest && e.target.closest('#cmd-deck'))) return;
  planDrag = { sx: e.clientX, sy: e.clientY, moved: false, add: e.shiftKey, command: selected.size > 0 };
});
addEventListener('mousemove', (e) => {
  if (!planActive() || !planDrag) return;
  const x0 = planDrag.sx, y0 = planDrag.sy, x1 = e.clientX, y1 = e.clientY;
  const box = planDrag.command ? zoneBox : selBox; // gold zone-box when commanding, green select-box otherwise
  if (Math.abs(x1 - x0) + Math.abs(y1 - y0) > 5) { planDrag.moved = true; if (box) box.style.display = 'block'; }
  if (box) {
    box.style.left = Math.min(x0, x1) + 'px'; box.style.top = Math.min(y0, y1) + 'px';
    box.style.width = Math.abs(x1 - x0) + 'px'; box.style.height = Math.abs(y1 - y0) + 'px';
  }
});
addEventListener('mouseup', (e) => {
  if (!planActive() || !planDrag) return;
  if (selBox) selBox.style.display = 'none';
  if (zoneBox) zoneBox.style.display = 'none';
  const d = planDrag; planDrag = null;
  if (d.moved) {
    if (d.command) { // ordered the selected squad to hold a zone (a tiny scrub is really a move order)
      const p0 = groundPointAt(d.sx, d.sy), p1 = groundPointAt(e.clientX, e.clientY);
      if (p0 && p1) {
        const rect = { minX: Math.min(p0.x, p1.x), maxX: Math.max(p0.x, p1.x), minZ: Math.min(p0.z, p1.z), maxZ: Math.max(p0.z, p1.z) };
        if (rect.maxX - rect.minX < 4 && rect.maxZ - rect.minZ < 4) deploySelected(p1);
        else commandZone(rect);
      }
    } else setSelection(alliesInBox(d.sx, d.sy, e.clientX, e.clientY), d.add); // box-select
    return;
  }
  // a plain click
  const a = allyAtPoint(e.clientX, e.clientY);
  if (a) { // clicked a soldier -> select his whole squad (or just him if ungrouped)
    const g = a.group != null ? planGroups.find(x => x.id === a.group) : null;
    if (g) selectGroup(g); else setSelection([a], d.add);
  } else if (d.command) { // clicked open ground with a squad selected -> march there & hold
    const p = groundPointAt(e.clientX, e.clientY); if (p) deploySelected(p);
  } else if (!d.add) setSelection([]);
});
addEventListener('contextmenu', (e) => { if (planActive()) e.preventDefault(); });
function handlePlanKey(e) {
  if (e.code === 'Enter') { mode === 'plan' ? beginBattle() : resumeBattle(); return; }
  if (e.code === 'Escape') { if (commandPanelOpen) resumeBattle(); return; }
  if (e.code === 'KeyH') return commandSelection('hold');     // Hold position
  if (e.code === 'KeyA' || e.code === 'KeyT') return commandSelection('attack');   // Charge (T mirrors the in-fight key)
  if (e.code === 'KeyF' || e.code === 'KeyB') return commandSelection('free');     // Free / at will (B mirrors the in-fight key)
  if (e.code === 'KeyR') return commandSelection('regroup');  // Regroup on the player
  if (e.code === 'KeyZ') return commandPace('march');         // March (slow, hold the line)
  if (e.code === 'KeyX') return commandPace('rush');          // Rush (charge at full speed)
  if (e.code === 'KeyG') return selectType('all');
  if (e.code === 'KeyN' && mode === 'plan') return void newGroup();
  const m = e.code.match(/^Digit([1-9])$/);
  if (m) { const g = planGroups[(+m[1]) - 1]; if (g) selectGroup(g); }
}
// ---- real-time field command: order squads WITHOUT leaving the fight (no deck, no time-slow) ----
// A is strafe and F/V are taken mid-fight, so charge=T and free=B are remapped; the rest keep their
// deck mnemonics. Pressing an order with nothing picked first selects the whole army, so a single tap
// ("T") sends everyone. setAllySelected already rings the troops; selIdle fades the rings afterward.
let selIdle = 0; // seconds until the field-selection rings auto-clear
function ensureSelection() { if (!selected.size) selectType('all'); }
function fieldSelLabel() {
  const live = allies.filter(a => a.alive).length;
  if (live && selected.size >= live) return 'All';
  const g = planGroups.find(x => x.id === activeGroupId);
  if (g && selected.size && [...selected].every(a => a.group === g.id)) return g.name;
  return selected.size + ' picked';
}
function handleBattleOrderKey(e) {
  const c = e.code;
  if (c === 'KeyG') { selectType('all'); selIdle = 2.5; showCmdToast('All — selected'); return true; }
  const m = c.match(/^Digit([1-9])$/);
  if (m) { const g = planGroups[(+m[1]) - 1]; if (g) { selectGroup(g); selIdle = 2.5; showCmdToast(g.name + ' — selected'); } return true; }
  const ORDERS = { KeyH: ['hold', 'Hold'], KeyT: ['attack', 'Charge'], KeyB: ['free', 'At will'], KeyR: ['regroup', 'Regroup'] };
  if (ORDERS[c]) { ensureSelection(); commandSelection(ORDERS[c][0]); selIdle = 2.5; showCmdToast(fieldSelLabel() + ' — ' + ORDERS[c][1]); return true; }
  if (c === 'KeyZ') { ensureSelection(); commandPace('march'); selIdle = 2.5; showCmdToast(fieldSelLabel() + ' — March'); return true; }
  if (c === 'KeyX') { ensureSelection(); commandPace('rush'); selIdle = 2.5; showCmdToast(fieldSelLabel() + ' — Rush'); return true; }
  return false;
}
function wireCmdDeck() {
  const deck = document.getElementById('cmd-deck'); if (!deck) return;
  document.getElementById('cd-begin').addEventListener('click', () => { mode === 'plan' ? beginBattle() : resumeBattle(); });
  document.getElementById('grp-new').addEventListener('click', () => newGroup());
  document.getElementById('grp-split').addEventListener('click', () => {
    const p = document.getElementById('split-pop'); p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) renderSplit();
  });
  const tab = document.getElementById('cd-tab');
  if (tab) tab.addEventListener('click', () => { if (mode === 'battle' && !commandPanelOpen) { if (document.exitPointerLock) document.exitPointerLock(); openCommandDeck(); } });
  renderDeck();
}
wireCmdDeck();

// continuously tops up each side from its reserve to keep ~FIELD_CAP on the field
// (no reset between "waves" — fresh fighters just march in as others fall)
function fieldBatch() {
  const fdx = Math.sin(BATTLE_FRONT), fdz = Math.cos(BATTLE_FRONT);
  const rdx = Math.cos(BATTLE_FRONT), rdz = -Math.sin(BATTLE_FRONT);
  let allyAlive = 0; for (const a of allies) if (a.alive) allyAlive++;
  while (allyAlive < FIELD_CAP && playerReserve.length) {
    const it = playerReserve.pop();
    const def = it.def || it, char = it.char || null; // tolerate a bare def from legacy callers
    const lat = rand(-32, 32), depth = rand(-6, 4); // a broad line at your end of the field
    const a = spawnAlly(clamp(player.pos.x + rdx * lat + fdx * depth, -ARENA + 1, ARENA - 1),
                        clamp(player.pos.z + rdz * lat + fdz * depth, -ARENA + 1, ARENA - 1),
                        ALLY_PALETTES[(Math.random() * ALLY_PALETTES.length) | 0], def, char);
    a.facing = BATTLE_FRONT; allyAlive++;
  }
  let enemyAlive = 0; for (const e of enemies) if (e.alive) enemyAlive++;
  while (enemyAlive < FIELD_CAP && enemyReserve.length) {
    const r = enemyReserve.pop();
    const lat = rand(-34, 34), depth = FRONT_GAP - rand(0, 16); // the enemy host, a full no-man's-land away
    const echar = makeChar(r.type, { team: 'enemy', hero: r.hero, name: r.hero ? r.hero.name : undefined,
      nameSet: enemyNameSet, renown: r.hero ? 200 : 0, notability: r.hero ? 3 : 1 });
    const e = spawnEnemy(r.type, clamp(fdx * depth + rdx * lat, -ARENA + 1, ARENA - 1),
                         clamp(fdz * depth + rdz * lat, -ARENA + 1, ARENA - 1), r.hero, echar);
    e.facing = BATTLE_FRONT + Math.PI; enemyAlive++;
  }
}
function checkBattleEnd() {
  if (mode !== 'battle') return;
  if (enemiesRemaining <= 0) winBattle();
}
function winBattle() {
  mode = 'muster'; gameRunning = false;
  if (coopRole === 'host') coopHostEnd(true); // tell any joined ally the shared battle is won
  commandPanelOpen = false; timeScale = 1; // drop tactical-slow/command state on the muster screen
  if (cmdDeck) cmdDeck.classList.remove('open');
  // survivors carry their growing careers forward; the fielded fallen are gone for good.
  // (folds skill/renown into every survivor, drops the dead, re-derives warbandComp, saves)
  applyBattleGrowth(true);
  // a soldier who crossed into champion rank this battle can now lead a squad of their own
  if (battlePromotions.length) showWaveBanner(battlePromotions[0] + ' is now a Champion!',
    (battlePromotions.length > 1 ? battlePromotions.length + ' soldiers rose to lead' : 'They can lead a squad — assign them in the Command Deck'));
  if (battleParty) {
    lastBattle = { size: battleParty.size, raider: battleParty.raider }; // bounty is scaled to the host you broke
    if (battleParty.serverId && typeof window !== 'undefined' && window.net) window.net.reportArmyDefeat(battleParty.serverId); // you broke this server host in person
    const bi = parties.indexOf(battleParty);
    if (bi >= 0) parties.splice(bi, 1);
    battleParty.alive = false;
    if (battleParty.group) { scene.remove(battleParty.group); disposeGroup(battleParty.group); } // siege bands have no map token
    battleParty = null;
  }
  if (siegeCapital) { // the garrison broke — the hold is yours
    const cap = siegeCapital; siegeCapital = null;
    cap.owner = PLAYER_REALM; recolorCapital(cap);
    const ni = nations.indexOf(cap); // a settlement isn't in `nations` (ni < 0) — it lives in the streamed world
    if (ni >= 0 && typeof window !== 'undefined' && window.net) window.net.reportCapital(ni, PLAYER_REALM.name, 'You took ' + cap.def.name); // your conquest persists in the living world
    if (cap.key) heldOwners.set(cap.key, PLAYER_REALM.name); // remember the flip so streaming back doesn't undo it
    cap.garrison = Math.round(garrisonSize() * 0.5); cap.parleyCd = 3;
    lastBattle.captured = cap.def.name;
    if (ni >= 0 && nations.every(n => n.owner === PLAYER_REALM)) lastBattle.conqueredAll = true;
  }
  showMuster();
}

function startWave(n) {
  wave = n;
  waveKills = waveHeroKills = waveLosses = 0; // fresh tally for this wave's XP
  if (pendingTier) { applyQuality(pendingTier); pendingTier = null; } // hitch hides behind the banner
  // the field widens with every wave — bigger armies need a bigger battleground
  applyArenaSize(Math.min(ARENA_BASE + (n - 1) * 5, ARENA_MAX));
  // the marauder host masses at the point of the map FARTHEST from where you
  // stand right now, and advances as a battle line. brace your side toward it.
  const frontYaw = Math.hypot(player.pos.x, player.pos.z) > 2
    ? Math.atan2(-player.pos.x, -player.pos.z)   // opposite side of the arena
    : rand(0, Math.PI * 2);                      // center of the map: any front
  const fdx = Math.sin(frontYaw), fdz = Math.cos(frontYaw); // toward the host area
  const rdx = Math.cos(frontYaw), rdz = -Math.sin(frontYaw); // along the line (lateral)
  // face the player and the warband at the actual muster point of the host
  const cx = fdx * (ARENA - 5), cz = fdz * (ARENA - 5);
  const faceYaw = Math.atan2(cx - player.pos.x, cz - player.pos.z);
  player.facing = faceYaw;
  rallyAllies(faceYaw);

  // MATCHED NUMBERS: the host always fields exactly as many soldiers as your
  // side (warband + you). Waves get harder through a meaner MIX, not headcount.
  const total = warbandTotal() + 1;
  const comp = { archer: 0, thrower: 0, brute: 0, longsword: 0, rogue: 0, grunt: 0 };
  comp.archer = Math.max(1, Math.round(total * Math.min(0.08 + n * 0.02, 0.2)));
  comp.thrower = n >= 2 ? Math.round(total * 0.1) : 0;
  comp.brute = n >= 2 ? Math.round(total * Math.min(0.04 + n * 0.025, 0.22)) : 0;
  comp.longsword = n >= 3 ? Math.round(total * 0.15) : 0;
  comp.rogue = n >= 3 ? Math.round(total * 0.12) : 0;
  let specialists = comp.archer + comp.thrower + comp.brute + comp.longsword + comp.rogue;
  const trimOrder = ['rogue', 'longsword', 'thrower', 'brute', 'archer'];
  while (specialists > total) { // small armies: trim specialists before grunts
    for (const k of trimOrder) {
      if (comp[k] > 0 && specialists > total) { comp[k]--; specialists--; }
    }
  }
  comp.grunt = total - specialists;
  // champions lead from wave 2 — EXTRA bodies on top of the matched count
  const heroCount = n >= 12 ? 3 : n >= 7 ? 2 : n >= 2 ? 1 : 0;
  const waveHeroes = [];
  for (let i = 0; i < heroCount; i++) waveHeroes.push(nextHero());
  let toSpawn = [];
  // ranged units first → they land in the REAR ranks of the formation (rank 0 is farthest)
  for (let i = 0; i < comp.archer; i++) toSpawn.push('archer');
  for (let i = 0; i < comp.thrower; i++) toSpawn.push('thrower');
  for (let i = 0; i < comp.grunt; i++) toSpawn.push('grunt');
  for (let i = 0; i < comp.longsword; i++) toSpawn.push('longsword');
  for (let i = 0; i < comp.brute; i++) toSpawn.push('brute');
  for (let i = 0; i < comp.rogue; i++) toSpawn.push('rogue');
  enemiesRemaining = toSpawn.length + waveHeroes.length;
  // arrange them as a loose block on the far side of the front: wide line, ranks
  // deep — width capped to the arena, depth spacing tightened for huge hosts
  const perRank = clamp(Math.ceil(Math.sqrt(toSpawn.length) * 1.7), 4, 26);
  const ranks = Math.ceil(toSpawn.length / perRank);
  const depthStep = Math.min(2.8, (ARENA * 1.4) / Math.max(1, ranks));
  const back = Math.atan2(-fdx, -fdz); // host faces back toward the field (the player)
  toSpawn.forEach((t, i) => {
    const rank = Math.floor(i / perRank);
    const col = i % perRank;
    const lateral = (col - (perRank - 1) / 2) * 2.5 + rand(-0.5, 0.5);
    const depth = (ARENA - 5) - rank * depthStep + rand(-0.5, 0.5);
    const x = clamp(fdx * depth + rdx * lateral, -ARENA + 1, ARENA - 1);
    const z = clamp(fdz * depth + rdz * lateral, -ARENA + 1, ARENA - 1);
    const en = spawnEnemy(t, x, z);
    en.facing = back; // already oriented toward the field as they advance
  });
  // heroes stride AHEAD of the host, leading the charge
  waveHeroes.forEach((hero, i) => {
    const lateral = (i - (waveHeroes.length - 1) / 2) * 5;
    const depth = ARENA - 9;
    const x = clamp(fdx * depth + rdx * lateral, -ARENA + 1, ARENA - 1);
    const z = clamp(fdz * depth + rdz * lateral, -ARENA + 1, ARENA - 1);
    const en = spawnEnemy(hero.base, x, z, hero);
    en.facing = back;
  });
  if (waveHeroes.length) {
    const lead = waveHeroes[0];
    showWaveBanner('Wave ' + n,
      (waveHeroes.length > 1 ? lead.name + ' and ' + (waveHeroes.length - 1) + ' more lead the host. ' : lead.name + ' leads the host. ') + '“' + lead.story + '”');
  } else {
    showWaveBanner('Wave ' + n);
  }
  updateEnemyCount();
}

function checkWaveClear() {
  if (gameRunning && !betweenWaves && enemiesRemaining <= 0) {
    betweenWaves = true; betweenTimer = 1.6; musterOpen = false;
    // bonus heal
    player.hp = clamp(player.hp + 25, 0, player.maxHp);
    showWaveBanner('Wave Cleared!  +25 HP');
  }
}

// ---------- Between-wave muster: success earns recruits ----------
let musterOpen = false;
const musterOverlay = document.getElementById('muster');
const musterInfo = document.getElementById('muster-info');
function showMuster() {
  musterOpen = true;
  // XP from the wave: a bounty for each foe (and champion) slain, docked for losses,
  // PLUS a victory bounty scaled to the whole host you broke — so even hunting a
  // small bandit pack pays off (floor), and crushing a warband pays handsomely.
  const captured = lastBattle && lastBattle.captured;
  const conqueredAll = lastBattle && lastBattle.conqueredAll;
  const kills = waveKills * KILL_XP + waveHeroKills * HERO_XP - waveLosses * LOSS_XP;
  // storming a stronghold pays a double bounty — a capital is the real prize
  const bounty = lastBattle ? Math.max(BAND_XP_FLOOR, Math.round(lastBattle.size * BAND_XP)) * (captured ? 2 : 1) : 0;
  const earned = Math.max(KILL_XP, kills) + bounty;
  xp += earned;
  lastBattle = null;
  const heroBit = waveHeroKills ? ` (${waveHeroKills} champion${waveHeroKills > 1 ? 's' : ''})` : '';
  const lossBit = waveLosses ? `, lost ${waveLosses}` : ' without a loss';
  const musterTitle = musterOverlay.querySelector('h1');
  if (captured) {
    musterTitle.textContent = conqueredAll ? 'The Realm Is Yours' : captured + ' Has Fallen';
    musterInfo.textContent = `${captured} flies your banner now.  +${earned} XP. ` +
      (conqueredAll ? 'Every hold in this land is yours — march on to new shores.' : 'Reinforce, then march on.');
    if (conqueredAll) advanceRegion = true;
  } else {
    musterTitle.textContent = 'Wave Cleared';
    musterInfo.textContent =
      `Battle won — slew ${waveKills}${heroBit}${lossBit}.  +${earned} XP (incl. +${bounty} bounty). Reinforce, then march on.`;
  }
  // the picker lives wherever it's needed; pull it in front of the march button
  musterOverlay.insertBefore(document.getElementById('warband-picker'), document.getElementById('next-wave-btn'));
  renderWarbandPicker();
  if (document.exitPointerLock) document.exitPointerLock(); // free the cursor for the UI
  pointerLocked = false;
  musterOverlay.classList.remove('hidden');
}
document.getElementById('next-wave-btn').addEventListener('click', () => {
  musterOpen = false;
  enterMap(); // back to the overworld with your reinforced (or reduced) party
});

// ---------- Encounters: meeting a band (parley) or a stronghold (siege) ----------
const encOverlay = document.getElementById('encounter');
const encTitle = encOverlay.querySelector('h1');
const encInfo = document.getElementById('enc-info');
const encAttackBtn = document.getElementById('enc-attack');
const encAllyBtn = document.getElementById('enc-ally');
const encHailBtn = document.getElementById('enc-hail');
const swatch = (color) => `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;` +
  `vertical-align:middle;margin-right:9px;background:#${color.toString(16).padStart(6, '0')};` +
  `border:1px solid rgba(255,255,255,.45)"></span>`;
function openEncounter(band) {
  if (band.inBattle) return openBattleEncounter(band); // a clash you can ride into
  const ally = isAllyFaction(band.faction);
  encounter = { kind: 'band', band, ally };
  player.vel.set(0, 0, 0);
  const kind = band.size <= 5 ? (ally ? 'patrol' : 'raiding pack') : 'war host';
  if (ally) {
    encTitle.textContent = 'Allied Banners';
    encInfo.innerHTML = `${swatch(band.faction.color)}A ${kind} of <b>${band.faction.name}</b> — ${band.size} strong — marches under your pact. They'll answer your <b>call to arms</b> (press G).`;
    encAttackBtn.style.display = 'none';
    encAllyBtn.style.display = ''; encAllyBtn.textContent = 'Break Pact';
    encHailBtn.textContent = 'Greet';
  } else {
    encTitle.textContent = 'Banners Meet';
    encInfo.innerHTML = `${swatch(band.faction.color)}A ${kind} of <b>${band.faction.name}</b> — ${band.size} strong. They have no quarrel with you. Your word?`;
    encAttackBtn.style.display = ''; encAttackBtn.textContent = 'Attack';
    encAllyBtn.style.display = ''; encAllyBtn.textContent = 'Propose Pact';
    encHailBtn.textContent = 'Say Hi';
  }
  encOverlay.classList.remove('hidden');
}
function openSiege(cap) {
  encounter = { kind: 'capital', cap };
  player.vel.set(0, 0, 0);
  const yours = cap.owner === PLAYER_REALM;
  const tier = cap.tier ? cap.tier[0].toUpperCase() + cap.tier.slice(1) : 'Stronghold';
  encTitle.textContent = yours ? 'Your ' + tier : 'A ' + tier;
  encInfo.innerHTML = yours
    ? `${swatch(cap.owner.color)}<b>${cap.def.name}</b> flies your banner. The garrison salutes you.`
    : `${swatch(cap.owner.color)}<b>${cap.def.name}</b>, a ${cap.owner.name} ${cap.tier || 'hold'} — garrison <b>${cap.garrison}</b>. ${cap.tier === 'village' ? 'Raid it?' : 'Storm the walls?'}`;
  encAttackBtn.textContent = 'Lay Siege'; encHailBtn.textContent = 'Leave';
  encAttackBtn.style.display = yours ? 'none' : '';
  encAllyBtn.style.display = 'none';
  encOverlay.classList.remove('hidden');
}
function closeEncounter() { encOverlay.classList.add('hidden'); encounter = null; }
// ride into a living clash on the map: throw in beside the host you rode up to
function openBattleEncounter(band) {
  const bt = band.inBattle; if (!bt) return;
  const mySide = bt.sideA.bands.includes(band) ? bt.sideA : bt.sideB;
  const foeSide = mySide === bt.sideA ? bt.sideB : bt.sideA;
  encounter = { kind: 'joinbattle', bt, mySide, foeSide, band };
  player.vel.set(0, 0, 0);
  const myAlly = isAllyFaction(mySide.faction), foeAlly = isAllyFaction(foeSide.faction);
  const tag = (s, isAlly) => (isAlly ? '✦ ' : '') + s.faction.name;
  const myN = sideSize(mySide), foeN = sideSize(foeSide);
  encTitle.textContent = myAlly ? 'Your Ally Is Beset!' : 'A Battle Rages';
  encInfo.innerHTML = `${swatch(mySide.faction.color)}<b>${tag(mySide, myAlly)}</b> (${myN}) is locked in battle with ` +
    `${swatch(foeSide.faction.color)}<b>${tag(foeSide, foeAlly)}</b> (${foeN}). ` +
    (myAlly ? 'Charge in and save them!' : 'Throw in beside ' + mySide.faction.name + '?');
  encAttackBtn.textContent = myAlly ? 'To Their Aid ⚔' : 'Join the Fray'; encAttackBtn.style.display = '';
  encAllyBtn.style.display = 'none';
  encHailBtn.textContent = 'Ride On';
  encOverlay.classList.remove('hidden');
}
// pull a living clash off the map (its bands merge into the pitched battle the player just joined)
function consumeMapBattle(bt) {
  bt.done = true;
  if (bt.marker) { scene.remove(bt.marker); disposeGroup(bt.marker); bt.marker = null; }
  for (const b of bt.sideA.bands.concat(bt.sideB.bands)) { b.inBattle = null; killBand(b); }
  const i = mapBattles.indexOf(bt); if (i >= 0) mapBattles.splice(i, 1);
}
// the player throws in with one side of a living clash — fight the opposing host as a pitched battle
function startJoinBattle(e) {
  const bt = e.bt, foe = e.foeSide, ally = e.mySide;
  const enemySize = Math.max(2, sideSize(foe)), enemyFaction = foe.faction, allyName = ally.faction.name;
  const cx = bt.cx, cz = bt.cz, allyBands = ally.bands.slice(); // captured for the allied muster (Phase 3 fields them)
  consumeMapBattle(bt);
  enterBattle({ size: enemySize, level: mapLevel, alive: true, raider: enemySize <= 5,
    pos: { x: cx, z: cz }, group: null, faction: enemyFaction, alliedBands: allyBands });
  showWaveBanner('Into the Fray', 'You charge in beside ' + allyName + ' against ' + enemyFaction.name + ' — ' + enemySize + ' strong!');
}
// lay siege: fight the garrison as a pitched battle, in the hold's biome
function startSiege(cap) {
  siegeCapital = cap;
  enterBattle({ size: cap.garrison, level: mapLevel, alive: true, raider: false, pos: { x: cap.x, z: cap.z }, group: null });
  showWaveBanner('Siege of ' + cap.def.name, 'Break the ' + cap.owner.name + ' garrison — ' + cap.garrison + ' strong behind the walls!');
}
encAttackBtn.addEventListener('click', () => {
  const e = encounter; closeEncounter(); if (!e) return;
  if (e.kind === 'band') { if (e.band && e.band.alive) enterBattle(e.band); }
  else if (e.kind === 'joinbattle') { if (e.bt && !e.bt.done) startJoinBattle(e); }
  else startSiege(e.cap);
});
encHailBtn.addEventListener('click', () => {
  const e = encounter; closeEncounter(); if (!e) return;
  if (e.kind === 'band') { if (e.band) { e.band.parleyCd = 6; if (!e.ally) showWaveBanner('Parley', 'You hail the ' + e.band.faction.name + ' ' + (e.band.size <= 5 ? 'pack' : 'host') + '. They give you the road and march on.'); } }
  else if (e.kind === 'joinbattle') { if (e.band) e.band.parleyCd = 4; } // ride on — let the clash play out
  else { e.cap.parleyCd = 3; } // leave the gates be
});
// diplomacy: forge or break a standing pact with an AI nation
encAllyBtn.addEventListener('click', () => {
  const e = encounter; closeEncounter(); if (!e || e.kind !== 'band' || !e.band) return;
  const fac = e.band.faction; e.band.parleyCd = 6;
  if (e.ally) {
    playerPacts.delete(fac); refreshAlliedLabels(fac);
    showWaveBanner('Pact Broken', 'You renounce your alliance with ' + fac.name + '.');
  } else if (Math.random() < pactAcceptChance()) {
    playerPacts.add(fac); refreshAlliedLabels(fac);
    showWaveBanner('Alliance Forged', fac.name + ' marches with you now — rally them with a call to arms (G).');
  } else {
    showWaveBanner('Pact Declined', fac.name + ' will not yet swear to your banner. Win more renown, then ask again.');
  }
});

// ---------- HUD ----------
const hud = document.getElementById('hud');
const hpFill = document.getElementById('hp-fill');
const stamFill = document.getElementById('stam-fill');
const scoreEl = document.getElementById('score');
const enemyCountEl = document.getElementById('enemy-count');
const waveBanner = document.getElementById('wave-banner');
const comboEl = document.getElementById('combo');
const damageFlash = document.getElementById('damage-flash');

// HUD style writes are gated on change — touching style every frame forces
// style recalc, which costs real ms on cheap phones
const hudPrev = { hp: -1, stam: -1, hot: null };
function updateHUD() {
  const hp = Math.round(clamp(player.hp / player.maxHp * 100, 0, 100));
  const stam = Math.round(clamp(player.stamina / player.maxStam * 100, 0, 100));
  const hot = player.stamina < 40;
  if (hp !== hudPrev.hp) { hudPrev.hp = hp; hpFill.style.width = hp + '%'; }
  if (stam !== hudPrev.stam) { hudPrev.stam = stam; stamFill.style.width = stam + '%'; }
  if (hot !== hudPrev.hot) {
    hudPrev.hot = hot;
    // fatigue warning: the bar turns hot once swings start slowing (below 40)
    stamFill.style.background = hot ? 'linear-gradient(90deg,#ffb04d,#ff6b4d)' : '';
  }
}
function addScore(n) { score += n; scoreEl.textContent = score.toLocaleString(); }
function updateEnemyCount() { enemyCountEl.textContent = 'Enemies: ' + Math.max(0, enemiesRemaining); }
let bannerTimer = 0;
const waveSub = document.getElementById('wave-sub');
function showWaveBanner(text, sub = '') {
  waveBanner.textContent = text; waveBanner.style.opacity = '1';
  waveSub.textContent = sub; waveSub.style.opacity = sub ? '1' : '0';
  bannerTimer = sub ? 4.5 : 2.2; // give the story time to be read
}
let cmdToastTimer = 0; // a quiet ticker confirming a live field order (distinct from the big wave banner)
const cmdToastEl = document.getElementById('cmd-toast');
function showCmdToast(text) {
  if (!cmdToastEl) return;
  cmdToastEl.textContent = '▸ ' + text;
  cmdToastEl.style.opacity = '1';
  cmdToastTimer = 1.2;
}
function showCombo(n) {
  if (n < 2) { comboEl.style.opacity = '0'; return; }
  comboEl.textContent = n + 'x COMBO';
  comboEl.style.opacity = '1';
  comboEl.style.transform = 'translateX(-50%) scale(1.25)';
  requestAnimationFrame(() => comboEl.style.transform = 'translateX(-50%) scale(1)');
}
function hideCombo() { comboEl.style.opacity = '0'; }
let dmgVignette = 0; // 0..1, written to #damage-flash only when it changes
let lastVig = '';
function flashDamage(strength = 0.8) { dmgVignette = Math.max(dmgVignette, clamp(strength, 0, 1)); }

// ---------- Game flow ----------
const startOverlay = document.getElementById('start');
const gameoverOverlay = document.getElementById('gameover');
const goSummary = document.getElementById('go-summary');

function startGame() {
  clearBattlefield();
  clearParties();
  if (player.obj) { scene.remove(player.obj); disposeGroup(player.obj); }
  loadCareers();   // hydrate the player's character + warband careers from the local mirror
  initPlayer();

  score = 0; addScore(0);
  wave = 0; betweenWaves = false; musterOpen = false; mapLevel = 0;
  playerPacts.clear(); // fresh campaign: no standing alliances
  if (typeof clearCall === 'function') clearCall(); // no lingering call into a new game
  shuffleHeroDeck(); // fresh campaign, fresh villains
  worldReflected = false; if (typeof window !== 'undefined' && window.net) window.net.loadWorld(); // refresh the living-world digest on login
  coopRole = null; initCoopMaybe(); // shared world: open the co-op channel so allies can join your battles
  startOverlay.classList.add('hidden');
  gameoverOverlay.classList.add('hidden');
  hud.classList.remove('hidden');
  renderWarbandPicker();
  enterMap(); // begin on the overworld, not straight into a fight
}

function doGameOver() {
  if (!player.alive) return;
  player.alive = false;
  if (coopRole === 'host') coopHostEnd(false); // the host fell — release any joined ally
  if (playerChar) playerChar.deaths++;
  applyBattleGrowth(false); // the fight is lost, but the survivors keep what they learned
  gameRunning = false;
  commandPanelOpen = false; timeScale = 1; // clear tactical-slow/command state behind the overlay
  if (cmdDeck) cmdDeck.classList.remove('open');
  if (document.exitPointerLock) document.exitPointerLock(); // free the cursor for the overlay
  // ragdoll-ish: tip over
  player.obj.rotation.z = Math.PI / 2.4;
  goSummary.textContent = `You fell in battle ${wave}, scoring ${score.toLocaleString()} points.`;
  setTimeout(() => { gameoverOverlay.classList.remove('hidden'); }, 900);
}

// start screen keeps your composed army; Fight Again starts a fresh economy
document.getElementById('start-btn').addEventListener('click', () => startGame());
document.getElementById('restart-btn').addEventListener('click', () => { resetEconomy(); startGame(); });

// ---------- Warband picker (XP-driven) ----------
function renderWarbandPicker() {
  for (const k of WARBAND_KEYS) document.getElementById('wp-' + k).textContent = warbandComp[k];
  document.getElementById('wp-total').textContent = warbandTotal();
  document.getElementById('wp-xp').textContent = 'XP ' + xp;
  // grey out a + you can't afford
  document.querySelectorAll('#warband-picker button').forEach(btn => {
    const d = parseInt(btn.dataset.d, 10);
    btn.disabled = d > 0 && xp < UNIT_COST[btn.dataset.t];
    btn.style.opacity = btn.disabled ? '0.35' : '';
  });
}
document.querySelectorAll('#warband-picker button').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.t, d = parseInt(btn.dataset.d, 10), cost = UNIT_COST[t];
    if (d > 0) {
      const n = Math.min(d, Math.floor(xp / cost)); // buy only what you can afford
      if (n <= 0) return;
      warbandComp[t] += n; xp -= n * cost;
    } else {
      const n = Math.min(-d, warbandComp[t]); // refund returns the XP
      if (n <= 0) return;
      warbandComp[t] -= n; xp += n * cost;
    }
    renderWarbandPicker();
  });
});
resetEconomy();
renderWarbandPicker();

// ---------- FPS governor: steps the quality tier down if the device can't keep up ----------
function applyQuality(tier) {
  qualityTier = tier;
  const t = TIERS[tier];
  renderer.setPixelRatio(t.pixelRatio);
  renderer.shadowMap.enabled = t.shadows;
  sun.castShadow = t.shadows;
  if (t.shadows && sun.shadow.map && sun.shadow.mapSize.x !== t.shadowSize) {
    sun.shadow.map.dispose(); sun.shadow.map = null;
    sun.shadow.mapSize.set(t.shadowSize, t.shadowSize);
  }
  let lit = 0;
  for (const torch of torches) {
    if (torch.userData.light) torch.userData.light.visible = lit++ < t.torchLights;
  }
  // materials must recompile when the shadow/light state flips (r128 bakes both
  // into the shader program); prewarm so the hitch happens HERE, not mid-swing
  scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
  renderer.compile(scene, camera);
  try { localStorage.setItem('bv-quality', tier); } catch (e) { /* fine */ }
}
// Tier downgrades that change lights/shadows force a full shader recompile —
// a multi-hundred-ms hitch on weak GPUs. So: drop pixel ratio IMMEDIATELY
// (free), and defer the recompiling part to the next wave banner.
let pendingTier = null;
let fpsAccum = 0, fpsFrames = 0, fpsWindow = 0;
function governFps(dt) {
  fpsAccum += dt; fpsFrames++; fpsWindow += dt;
  if (fpsWindow < 4) return; // judge in 4s windows
  const avg = fpsFrames / fpsAccum;
  fpsAccum = 0; fpsFrames = 0; fpsWindow = 0;
  if (avg < 42 && !pendingTier) {
    const next = qualityTier === 'high' ? 'medium' : qualityTier === 'medium' ? 'low' : null;
    if (next) {
      renderer.setPixelRatio(TIERS[next].pixelRatio); // instant relief, no recompile
      pendingTier = next;                              // the rest lands behind a banner
    }
  }
}

// ---------- Main loop ----------
let last = performance.now();
let frameNo = 0;
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  rtNow = now / 1000;
  frameNo++;
  if (TOUCH) updateTouchHud(); // show/hide the right touch control set for the current mode

  // menu idles at ~20fps: no reason to cook the phone before the fight starts
  if (!gameRunning && !startOverlay.classList.contains('hidden') && frameNo % 3) {
    requestAnimationFrame(loop);
    return;
  }

  if (!BV.freeze) {
    if (gameRunning) governFps(dt); // auto-degrade quality if the device struggles
    // hit-stop: gameplay crawls for a few frames on impact; camera/FX timing stay real-time
    let gdt = dt * timeScale; // tactical-slow while the mid-battle command deck is open
    if (hitstop > 0) { hitstop -= dt; gdt = dt * 0.08 * timeScale; }
    elapsed += gdt;

    // ambient torch flicker (not every torch carries a real light on lower tiers)
    for (const t of torches) {
      const f = 0.85 + Math.sin(now * 0.01 + t.position.x) * 0.15 + Math.random() * 0.1;
      if (t.userData.light) t.userData.light.intensity = 1.2 * f;
      t.userData.flame.scale.setScalar(0.85 + f * 0.25);
    }

    // huge battles re-pick targets every few frames instead of every frame —
    // target stickiness hides the staleness, and it keeps the director O(small)
    const fighterCount = enemies.length + allies.length;
    const resolveEvery = fighterCount > 240 ? 4 : fighterCount > 100 ? 2 : 1;
    if (mode === 'map') {
      updateMap(gdt);
    } else if (mode === 'plan') {
      // deployment phase — the battlefield is staged and still while you plan
    } else if (mode === 'battle' && gameRunning) {
      updatePlayer(gdt);
      rebuildSepGrid();
      if (frameNo % resolveEvery === 0) resolveTargets();
      updateAllies(gdt);
      updateEnemies(gdt);
      updateProjectiles(gdt);
      fieldBatch();      // top up each side from its reserve — continuous reinforcement
      checkBattleEnd();
      if (coopRole === 'host') coopHostTick(gdt); // broadcast the arena to any ally who joined
    } else if (mode === 'coopguest') {
      updateCoopGuest(gdt); // a guest watching/aiding an ally's battle, rendered from host snapshots
    } else if (mode !== 'menu' && player.obj) {
      // player has fallen (or muster screen up) — the battle plays on behind the overlay
      rebuildSepGrid();
      if (frameNo % resolveEvery === 0) resolveTargets();
      updateAllies(gdt);
      updateEnemies(gdt);
      updateProjectiles(gdt);
    }

    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) { waveBanner.style.opacity = '0'; waveSub.style.opacity = '0'; }
    }
    // real-time field command: fade the order toast, and let the selection rings clear on their own
    if (cmdToastTimer > 0) { cmdToastTimer -= dt; if (cmdToastTimer <= 0 && cmdToastEl) cmdToastEl.style.opacity = '0'; }
    if (selIdle > 0 && mode === 'battle' && !commandPanelOpen) { selIdle -= dt; if (selIdle <= 0) clearSelection(); }

    updateSparks(gdt);
    updateArcs(gdt);
    updateTrails(gdt);
    updatePopups(gdt);
    if (mode === 'map') updateMapCamera(dt);
    else if (mode === 'plan' || commandPanelOpen) updatePlanCamera(dt);
    else if (mode === 'coopguest') { /* camera is set inside updateCoopGuest */ }
    else if (player.obj) updateCamera(dt);

    // damage vignette: impact flash decays; low health pulses the edges red
    dmgVignette = Math.max(0, dmgVignette - dt * 2.2);
    let vig = dmgVignette;
    if (gameRunning && player.alive) {
      const r = player.hp / player.maxHp;
      if (r < 0.35) vig = Math.max(vig, (1 - r / 0.35) * (0.45 + 0.18 * Math.sin(rtNow * 5)));
    }
    const vigStr = vig < 0.005 ? '0' : vig.toFixed(2);
    if (vigStr !== lastVig) { lastVig = vigStr; damageFlash.style.opacity = vigStr; }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// ---------- Real-time co-op: two players, one live arena (host-authoritative over /coop) ----------
// The HOST runs the real battle sim and broadcasts compact snapshots; a GUEST hands over their
// warband (which fights on the host's side via the Phase-3 borrowed-ally path) and watches the
// shared arena live, sharing the spoils. All of this is GATED on a shared world + a live co-op
// socket, so offline single-player never touches a line of it. Live cross-device play is a v1
// (host-authoritative, snapshot-interpolated; no client prediction yet — see BATTLE_CONTROLS.md).
let coopRole = null;          // null | 'host' | 'guest'
let coopWired = false, coopSnapAcc = 0, coopInputAcc = 0;
const COOP_SNAP_DT = 1 / 15;  // host broadcasts ~15 snapshots/sec
const coopPuppets = new Map(); // guest-side remote bodies, keyed by team+id
const coopJoined = new Set();  // guest account/conn ids already fielded on the host (no double-join)
const coopName = () => (playerChar ? playerChar.name : 'A Wanderer');
const coopOnline = () => !!(typeof window !== 'undefined' && window.coop && window.coop.connected);
function coopAvailable() { return !!(typeof window !== 'undefined' && window.coop && window.coop.available()); }

function initCoopMaybe() { // connect once when playing a shared world; wire the message handlers
  if (!coopAvailable() || coopWired) return;
  window.coop.connect(coopName(), 'shared').then((ok) => { if (ok) wireCoop(); });
}
function wireCoop() {
  if (coopWired || !window.coop) return; coopWired = true;
  window.coop.on('msg', onCoopMsg);
  window.coop.on('peer-join', (m) => { if (coopRole === 'host') showWaveBanner('Ally Incoming', (m.name || 'An ally') + ' rides to join your battle!'); });
  window.coop.on('peer-leave', () => {});
  window.coop.on('beacons', renderBeaconPanel);
  window.coop.on('joined', onCoopJoined);
  window.coop.on('host-gone', () => { if (coopRole === 'guest') { showWaveBanner('Battle Over', 'Your ally\'s battle has ended.'); leaveCoopGuest(); } });
  window.coop.on('disconnect', () => { // socket dropped: never strand a guest in the co-op view
    if (coopRole === 'guest') { showWaveBanner('Disconnected', 'Lost contact with your ally\'s battle.'); leaveCoopGuest(); }
    else if (coopRole === 'host') { coopRole = null; coopJoined.clear(); }
  });
}

// ----- HOST: beacon the fight, broadcast the arena, field a guest's handed-over warband -----
function coopMaybeHostBattle(band) {
  if (!coopOnline() || !coopAvailable()) return;
  coopRole = 'host'; coopJoined.clear();
  window.coop.host({ host: coopName(), faction: PLAYER_REALM.name, x: Math.round(band.pos.x), z: Math.round(band.pos.z),
    hold: siegeCapital ? siegeCapital.def.name : null, enemy: band.size, enemyFaction: band.faction ? band.faction.name : '?', lvl: mapLevel });
}
function coopHostTick(dt) {
  if (coopRole !== 'host' || !coopOnline() || !window.coop.peers.length) return;
  coopSnapAcc += dt; if (coopSnapAcc < COOP_SNAP_DT) return; coopSnapAcc = 0;
  const al = [], en = [];
  for (const a of allies) if (a.alive) al.push([a.char ? a.char.id : 0, Math.round(a.pos.x * 10), Math.round(a.pos.z * 10), Math.round(a.facing * 100)]);
  for (const e of enemies) if (e.alive) en.push([e.char ? e.char.id : 0, Math.round(e.pos.x * 10), Math.round(e.pos.z * 10), Math.round(e.facing * 100)]);
  window.coop.send({ k: 'snap', pl: [Math.round(player.pos.x * 10), Math.round(player.pos.z * 10), Math.round(player.facing * 100), player.alive ? 1 : 0], al, en });
}
function fieldGuestRoster(fromId, roster, name) {
  if (coopJoined.has(fromId) || !Array.isArray(roster)) return;
  coopJoined.add(fromId);
  let n = 0;
  for (const o of roster.slice(0, 60)) {
    const k = classKeyOf(o.archetype || 'sword');
    const c = makeChar(k, { team: 'ally', name: o.name }); c.borrowed = true; c.allyFaction = name || 'Ally';
    if (o.skills) c.skills = Object.assign(c.skills, o.skills); recomputeChar(c);
    playerReserve.push({ def: ALLY_DEF_BY_CLASS[k], char: c }); n++;
  }
  battleAllyBanners += 1; battleReinforced += n; coopMult = clamp(coopMult + 0.05, 1, 1.6); // a human ally is a real boon
  if (mode === 'battle' || mode === 'plan') fieldBatch();
  showWaveBanner((name || 'An ally') + ' Joins!', '+' + n + ' of their warband fight at your side. Win this together!');
}
function coopHostEnd(won) {
  if (coopRole !== 'host') return;
  if (coopOnline()) { window.coop.send({ k: 'end', won: !!won }); window.coop.leave(); }
  coopRole = null; coopJoined.clear();
}

// ----- GUEST: discover joinable battles, hand over your warband, watch the shared arena live -----
let beaconPanel = null;
function ensureBeaconPanel() {
  if (beaconPanel) return beaconPanel;
  beaconPanel = document.createElement('div');
  beaconPanel.id = 'coop-panel';
  beaconPanel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);min-width:340px;max-width:80vw;' +
    'background:rgba(16,12,24,.95);border:1px solid #ffd34d;border-radius:14px;padding:20px 22px;z-index:60;color:#f3ead8;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.6);display:none;font-family:inherit';
  document.body.appendChild(beaconPanel);
  return beaconPanel;
}
function openBeaconPanel() {
  if (mode !== 'map') return;
  if (!coopAvailable()) { showWaveBanner('Co-op Needs a Shared World', 'Add ?mp to the URL (or set Shared World) to fight alongside other players.'); return; }
  if (!coopOnline()) { initCoopMaybe(); showWaveBanner('Reaching the Allies…', 'Connecting to the war-net — try again in a moment.'); return; }
  const p = ensureBeaconPanel();
  p.innerHTML = '<h2 style="margin:0 0 10px;color:#ffd34d;font-size:22px">Allied Battles</h2><div id="coop-list" style="font-size:14px;opacity:.8">Scanning the war-net…</div>' +
    '<div style="margin-top:14px;text-align:right"><button id="coop-close" style="background:#2a2233;color:#f3ead8;border:1px solid #6b5e7a;border-radius:8px;padding:7px 14px;cursor:pointer">Close</button></div>';
  p.style.display = 'block';
  document.getElementById('coop-close').onclick = () => { p.style.display = 'none'; };
  window.coop.list();
}
function renderBeaconPanel(m) {
  if (!beaconPanel || beaconPanel.style.display === 'none') return;
  const list = document.getElementById('coop-list'); if (!list) return;
  const rows = (m.list || []).filter(b => b.beacon);
  if (!rows.length) { list.innerHTML = 'No allies are in battle right now. Lead a fight yourself, or wait for a call to arms.'; return; }
  list.innerHTML = rows.map((b, i) => {
    const bc = b.beacon || {};
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid #3a3247">' +
      '<span><b>' + (bc.host || 'An ally') + '</b> vs <b>' + (bc.enemyFaction || 'foes') + '</b>' + (bc.hold ? ' · siege of ' + bc.hold : '') + ' · ' + (bc.enemy || '?') + ' strong</span>' +
      '<button data-room="' + b.room + '" class="coop-join" style="background:#3a6fd0;color:#fff;border:none;border-radius:8px;padding:7px 14px;cursor:pointer">Join ⚔</button></div>';
  }).join('');
  for (const btn of list.querySelectorAll('.coop-join')) btn.onclick = () => { joinCoopBattle(btn.getAttribute('data-room')); };
}
function joinCoopBattle(room) { if (beaconPanel) beaconPanel.style.display = 'none'; window.coop.join(room); }
function coopRosterPayload() {
  const out = [];
  if (playerChar) out.push({ name: playerChar.name, archetype: playerChar.archetype, skills: playerChar.skills });
  for (const c of warbandRoster) if (!c.fallen) out.push({ name: c.name, archetype: c.archetype, skills: c.skills });
  return out.slice(0, 60);
}
function onCoopJoined(m) {
  coopRole = 'guest';
  window.coop.send({ k: 'join-roster', name: coopName(), roster: coopRosterPayload() });
  enterCoopGuest(m.beacon || {});
}
function makePuppet(team) {
  const g = new THREE.Group();
  const col = team === 'e' ? 0xff6a5a : team === 'host' ? 0xffd34d : 0x6bd0ff;
  const body = boxMesh(0.8, 1.5, 0.5, mat(col, { shared: false })); body.position.y = 0.95; g.add(body);
  const head = boxMesh(0.55, 0.55, 0.55, mat(col, { shared: false })); head.position.y = 1.95; g.add(head);
  if (team === 'host') { const c = boxMesh(0.2, 1.6, 0.2, mat(0xffe089, { shared: false })); c.position.set(0.7, 2.3, 0); g.add(c); } // your ally's banner
  scene.add(g); return { obj: g, tx: 0, tz: 0, tf: 0 };
}
function clearCoopPuppets() { for (const [, p] of coopPuppets) { scene.remove(p.obj); disposeGroup(p.obj); } coopPuppets.clear(); }
function enterCoopGuest(beacon) {
  mode = 'coopguest'; gameRunning = false; commandPanelOpen = false; timeScale = 1;
  if (typeof clearCall === 'function' && activeCall) clearCall(); // drop any standing call/beacon before the co-op view
  clearBattlefield(); clearCoopPuppets();
  setBattleDressing(true);
  applyBiome(biomeAt(beacon.x || 0, beacon.z || 0));
  if (player.mapToken) player.mapToken.visible = false; player.obj.visible = false;
  const enc = document.getElementById('encounter'); if (enc) enc.classList.add('hidden'); encounter = null;
  if (document.exitPointerLock) document.exitPointerLock(); pointerLocked = false;
  hud.classList.remove('hidden');
  showWaveBanner('Side by Side', 'Your warband fights in ' + (beacon.host || 'your ally') + '\'s battle. Hold the line together!');
}
function coopApplySnap(s) {
  const seen = new Set();
  // key by STABLE identity (team + char id), NOT position — else a moving body re-keys every frame
  // and gets destroyed+rebuilt (defeating interpolation). id-0 fodder falls back to its array index.
  const put = (arr, team) => { if (!arr) return; for (let i = 0; i < arr.length; i++) { const b = arr[i]; const id = team + ':' + (b[0] || ('i' + i)); seen.add(id); let p = coopPuppets.get(id); if (!p) { p = makePuppet(team); p.obj.position.set(b[1] / 10, 0, b[2] / 10); coopPuppets.set(id, p); } p.tx = b[1] / 10; p.tz = b[2] / 10; p.tf = b[3] / 100; } };
  put(s.al, 'a'); put(s.en, 'e');
  if (s.pl) { const id = 'host'; seen.add(id); let p = coopPuppets.get(id); if (!p) { p = makePuppet('host'); coopPuppets.set(id, p); } p.tx = s.pl[0] / 10; p.tz = s.pl[1] / 10; p.tf = s.pl[2] / 100; }
  for (const [id, p] of coopPuppets) if (!seen.has(id)) { scene.remove(p.obj); disposeGroup(p.obj); coopPuppets.delete(id); }
}
function updateCoopGuest(dt) {
  let cx = 0, cz = 0, n = 0;
  const k = clamp(dt * 12, 0, 1);
  for (const [, p] of coopPuppets) {
    p.obj.position.x = lerp(p.obj.position.x, p.tx, k);
    p.obj.position.z = lerp(p.obj.position.z, p.tz, k);
    p.obj.rotation.y = p.tf;
    cx += p.obj.position.x; cz += p.obj.position.z; n++;
  }
  if (n) { cx /= n; cz /= n; }
  camera.position.set(cx, 60, cz - 46); camera.lookAt(cx, 0, cz + 8); // overhead view of the shared arena
  // send a light input heartbeat (host v1 doesn't drive a guest avatar yet — reserved for hero control)
  coopInputAcc += dt; if (coopInputAcc > 0.1 && coopOnline()) { coopInputAcc = 0; const d = inputDir(); window.coop.send({ k: 'input', mv: [+d.x.toFixed(2), +d.z.toFixed(2)] }); }
}
function coopGuestEnd(won) {
  // share the spoils: every survivor of your committed warband grows a little from the shared victory
  const grow = (c) => { if (!c) return; c.battles++; if (won) c.battlesWon++; c.renown += won ? 3 : 1; c.skills.strike += 0.1; c.skills.guard += 0.1; recomputeChar(c); };
  grow(playerChar); for (const c of warbandRoster) grow(c);
  saveCareers();
  showWaveBanner(won ? 'Victory, Together!' : 'A Hard Day', won ? 'Your ally\'s host carried the field — and your name rode with it.' : 'The line broke, but your warband lives to fight again.');
  leaveCoopGuest();
}
function leaveCoopGuest() {
  clearCoopPuppets();
  if (coopOnline()) window.coop.leave();
  coopRole = null;
  if (mode === 'coopguest') enterMap();
}
function onCoopMsg(m) {
  const d = m && m.data; if (!d) return;
  if (coopRole === 'host') {
    if (d.k === 'join-roster') fieldGuestRoster(m.from, d.roster, d.name);
    // d.k === 'input' reserved for future guest-avatar control
  } else if (coopRole === 'guest') {
    if (d.k === 'snap') coopApplySnap(d);
    else if (d.k === 'end') coopGuestEnd(d.won);
  }
}
// discovery: press J on the map to find and join an ally's battle
addEventListener('keydown', (e) => { if (e.code === 'KeyJ' && mode === 'map' && !encounter) { e.preventDefault(); openBeaconPanel(); } });
// debug/verification hooks
BV.coop = () => ({ role: coopRole, online: coopOnline(), available: coopAvailable(), peers: (window.coop && window.coop.peers) || [], puppets: coopPuppets.size, room: window.coop && window.coop.room });
BV.coopBuildSnapshot = () => { const al = [], en = []; for (const a of allies) if (a.alive) al.push([a.char ? a.char.id : 0, Math.round(a.pos.x * 10), Math.round(a.pos.z * 10), Math.round(a.facing * 100)]); for (const e of enemies) if (e.alive) en.push([e.char ? e.char.id : 0, Math.round(e.pos.x * 10), Math.round(e.pos.z * 10), Math.round(e.facing * 100)]); return { pl: [Math.round(player.pos.x * 10), Math.round(player.pos.z * 10), Math.round(player.facing * 100), 1], al, en }; };
BV.coopApplySnap = (s) => { enterCoopGuestForTest(); coopApplySnap(s); return { puppets: coopPuppets.size }; };
function enterCoopGuestForTest() { if (mode !== 'coopguest') { mode = 'coopguest'; } }

// ---------- Boot ----------
buildWorld();
// preview character on the menu
initPlayer();
camera.position.set(0, 12, 16);
camera.lookAt(0, 1.6, 0);
requestAnimationFrame(loop);

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// expose internals for live pose tuning / verification
BV.player = player; BV.enemies = enemies; BV.POSES = POSES; BV.setPose = setPose;
BV.updateAnimator = updateAnimator; BV.camera = camera; BV.scene = scene;
BV.packRoles = () => enemies.filter(e => e.alive).map(e => ({ type: e.type, role: e.role, state: e.state }));
BV.allies = allies;
BV.projectiles = projectiles;
BV.battleStats = () => ({
  alliesAlive: allies.filter(a => a.alive).length,
  enemiesAlive: enemies.filter(e => e.alive).length,
  projectilesInFlight: projectiles.length,
});
BV.perf = () => ({
  tier: qualityTier,
  drawCalls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
  geometries: renderer.info.memory.geometries,
  textures: renderer.info.memory.textures,
  programs: renderer.info.programs ? renderer.info.programs.length : -1,
});
BV.setQuality = applyQuality;
BV.renderer = renderer;
BV.debugKillAll = () => { for (const e of enemies) if (e.alive) killEnemy(e, false); };
BV.showMuster = showMuster;
BV.setXp = (n) => { xp = Math.max(0, n | 0); renderWarbandPicker(); };
BV.econ = () => ({ xp, army: warbandTotal(), cost: warbandCost(), waveKills, waveHeroKills, waveLosses });
BV.world = () => ({ mode, mapLevel, parties: parties.filter(p => p.alive).length,
  playerReserve: playerReserve.length, enemyReserve: enemyReserve.length, enemiesRemaining,
  alliesAlive: allies.filter(a => a.alive).length, enemiesAlive: enemies.filter(e => e.alive).length, arena: ARENA });
BV.enterBattleWith = (size) => { enterBattle({ size, level: mapLevel, alive: true, raider: size <= 5, pos: player.pos.clone(), group: makePartyToken(size) }); };
BV.biomeAt = (x, z) => biomeAt(x, z).name;
BV.factions = () => parties.filter(p => p.alive).map(p => ({ size: p.size, faction: p.faction.name }));
BV.diplomacy = () => ({
  relations: Array.from(worldRelations.values()).map(r => ({ a: r.a, b: r.b, opinion: Math.round(r.opinion), stance: r.stance, truceUntil: r.truceUntil || 0 })),
  myStance: (f) => stanceLocal(PLAYER_REALM.name, f),
  stanceBetween: (a, b) => stanceLocal(a, b),
  factionState: (typeof window !== 'undefined' && window.net && window.net.world && window.net.world.factionState) || null,
  serverDriven: isServerMap()
});
BV.parties = parties; // live band array — debug/verification (read positions, force a clash)
BV.nations = () => nations.map(n => ({ name: n.def.name, owner: n.owner.name, garrison: n.garrison, x: Math.round(n.x), z: Math.round(n.z) }));
// living-territory inspection: prove the world is evolving (gen rises, faction cell-counts shift)
BV.territory = () => {
  const owned = {}; let unclaimed = 0, water = 0;
  for (const c of terrCells.values()) {
    if (c.w) { water++; continue; }
    if (!c.o) { unclaimed++; continue; }
    owned[c.o.name] = (owned[c.o.name] || 0) + 1;
  }
  return { gen: terrGen, cells: terrCells.size, owned, unclaimed, water };
};
BV.territorySnapshot = BV.territory;
BV.terrAt = (x, z) => { const c = terrCells.get(_cellKey(Math.floor(x / TERR_CELL), Math.floor(z / TERR_CELL))); return c ? (c.w ? 'water' : (c.o ? c.o.name : 'unclaimed')) : 'unloaded'; };
BV.allyOrders = () => { const o = {}; for (const a of allies) if (a.alive) o[a.order] = (o[a.order] || 0) + 1; return o; };
BV.allyStats = () => { const g = {}; for (const a of allies) if (a.alive) { const k = defKey(a.def) + ':' + a.order; (g[k] = g[k] || { n: 0, x: 0, z: 0 }); g[k].n++; g[k].x += a.pos.x; g[k].z += a.pos.z; } const o = {}; for (const k in g) o[k] = { n: g[k].n, avgX: Math.round(g[k].x / g[k].n), avgZ: Math.round(g[k].z / g[k].n) }; return o; };
BV.plan = { selectType, deploySelected, beginBattle, selCount: () => selected.size,
  newGroup, assignToGroup, splitIntoGroups, orderGroup, openCommandDeck, resumeBattle, countPool,
  selectGroup: (i) => { const g = planGroups[i]; if (g) selectGroup(g); },
  orderG: (i, preset) => { const g = planGroups[i]; if (g) orderGroup(g, preset); },
  zoneG: (i, rect) => { const g = planGroups[i]; if (g) setGroupZone(g, rect); },     // {minX,maxX,minZ,maxZ}
  paceG: (i, pace) => { const g = planGroups[i]; if (g) setGroupPace(g, pace); },      // 'march' | 'rush'
  groups: () => planGroups.map(g => ({ name: g.name, order: g.order, pace: g.pace, zone: g.zone, n: allies.filter(a => a.alive && a.group === g.id).length,
    leaderId: g.leaderId, cap: g.leaderId != null ? commandCap(leaderCharById(g.leaderId)) : 0,
    comp: CLASS_KEYS.map(k => k + ':' + allies.filter(a => a.alive && a.group === g.id && defKey(a.def) === k).length).filter(s => !s.endsWith(':0')).join(' ') })),
  setLeader: (i, charId) => { const g = planGroups[i]; if (g) setGroupLeader(g, charId); return g ? g.leaderId : null; },
  commandPanelOpen: () => commandPanelOpen,
  battleKey: (code) => handleBattleOrderKey({ code }),                       // simulate a live order keypress
  battleOrder: (preset) => { ensureSelection(); commandSelection(preset); }, // 'hold'|'attack'|'free'|'regroup'
  battlePace: (pace) => { ensureSelection(); commandPace(pace); },           // 'march'|'rush'
  selLabel: () => fieldSelLabel() };
BV.siege = (i) => { const c = nations[i]; if (c) openSiege(c); };
BV.advance = (secs, dt = 0.016) => { // deterministic battle stepping for headless timing tests
  const n = Math.round(secs / dt);
  for (let i = 0; i < n && mode === 'battle' && gameRunning; i++) {
    frameNo++;
    updatePlayer(dt); rebuildSepGrid(); resolveTargets();
    updateAllies(dt); updateEnemies(dt); updateProjectiles(dt); fieldBatch(); checkBattleEnd();
  }
  return { mode, frameNo, kills: waveKills };
};
BV.advanceMap = (secs, dt = 0.05) => { // deterministic overworld stepping (off-map wars) for headless tests
  const n = Math.round(secs / dt);
  for (let i = 0; i < n && mode === 'map' && !encounter; i++) { frameNo++; updateMap(dt); }
  return { mode, parties: parties.filter(p => p.alive).length, battles: mapBattles.length };
};
// vista inspection / forcing — peek the survey reach, or set total miles to preview the far view
BV.vista = (miles) => {
  if (typeof miles === 'number') { mapMiles = miles; mapVista = mapMiles / (mapMiles + VISTA.k); applyVista(0, 0); }
  return { miles: Math.round(mapMiles), vista: +mapVista.toFixed(3), view: VIEW,
    fog: [Math.round(scene.fog.near), Math.round(scene.fog.far)], camLift: +vlerp(VISTA.camLift).toFixed(1) };
};
// living-battle inspection + a forced 1v? clash for timing calibration tests
BV.mapBattles = () => mapBattles.map(b => ({ a: b.sideA.faction.name, b: b.sideB.faction.name,
  na: Math.round(b.sideA.live), nb: Math.round(b.sideB.live), t: +b.t.toFixed(2), dur: +b.duration.toFixed(2), aWins: b.aWins }));
BV.startClash = (sizeA, sizeB) => {
  const cx = player.pos.x, cz = player.pos.z;
  const mk = (nation, sz, ox) => {
    const g = makePartyToken(sz, nation.def); g.position.set(cx + ox, 0, cz); scene.add(g);
    const band = { group: g, pos: g.position.clone(), size: sz, alive: true, speed: 5, faction: nation.def,
      raider: sz <= 5, clashCd: 0, parleyCd: 0, wanderT: 1, wanderDir: 0, level: mapLevel,
      leader: makeBandLeader(sz, mapLevel, sz > 5), quality: 1 };
    parties.push(band); setBandLabel(band); return band;
  };
  const a = mk(nations[0], sizeA, -1.2), b = mk(nations[1], sizeB, 1.2);
  return startMapBattle(a, b).duration;
};
BV.pacts = () => [...playerPacts].map(f => f.name);
BV.openEncounter = openEncounter; // debug: pop the parley/aid screen for a given band
BV.bandOfRelation = (ally) => parties.find(p => p.alive && !p.inBattle && isAllyFaction(p.faction) === ally) || null;
BV.allyWith = (i) => { const c = nations[i]; if (c) { playerPacts.add(c.def); refreshAlliedLabels(c.def); } return BV.pacts(); };
BV.alliedBandsNear = (radius = 1e9) => parties.filter(p => p.alive && isAllyFaction(p.faction) &&
  Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z) <= radius).length;
BV.raiseCall = raiseCall;
BV.tp = (x, z) => { player.pos.set(x, 0, z); player.vel.set(0, 0, 0); if (player.mapToken) player.mapToken.position.copy(player.pos); return [Math.round(x), Math.round(z)]; };
BV.activeCall = () => activeCall && { kind: activeCall.kind, t: +activeCall.t.toFixed(1), radius: activeCall.radius,
  answering: gatherAlliedReinforcements(activeCall.x, activeCall.z, activeCall.radius).length, hold: activeCall.cap && activeCall.cap.def.name };
BV.coopState = () => ({ banners: battleAllyBanners, reinforced: battleReinforced, coopMult: +coopMult.toFixed(3),
  reserveBorrowed: playerReserve.filter(it => it.char && it.char.borrowed).length, reserveTotal: playerReserve.length,
  alliesAlive: allies.filter(a => a.alive).length, borrowedAlive: allies.filter(a => a.alive && a.char && a.char.borrowed).length });
// test: drop a pacted band right next to the player so the next battle pulls it in as reinforcement
BV.spawnAllyBandHere = (size = 12) => { playerPacts.add(nations[0].def);
  const g = makePartyToken(size, nations[0].def); g.position.set(player.pos.x + 2, 0, player.pos.z + 2); scene.add(g);
  const band = { group: g, pos: g.position.clone(), size, alive: true, speed: 5, faction: nations[0].def, raider: size <= 5,
    clashCd: 0, parleyCd: 0, wanderT: 1, wanderDir: 0, level: mapLevel, leader: makeBandLeader(size, mapLevel, true), quality: 1 };
  parties.push(band); setBandLabel(band); return BV.alliedBandsNear(40); };
BV.dbg = () => { const a = allies.find(x => x.alive && !x.def.ranged); const e = enemies.find(x => x.alive);
  return { gameRunning, mode, freeze: BV.freeze, frameNo, alliesN: allies.length, enemiesN: enemies.length,
    ally: a ? { state: a.state, order: a.order, hasTgt: !!(a.target && a.target.alive), dist: a.target ? Math.round(a.pos.distanceTo(a.target.pos)) : -1, z: Math.round(a.pos.z), vel: +a.vel.length().toFixed(2) } : null,
    enemyZ: e ? Math.round(e.pos.z) : null }; };
BV.isWater = (x, z) => isWater(x, z);
BV.fieldBatch = fieldBatch;
BV.killFielded = () => { for (const e of enemies) if (e.alive) killEnemy(e, true); checkBattleEnd(); };
BV.dmg = { damagePlayer, damageEnemy, damageCombatant };
BV.spawnProjectile = spawnProjectile;
// Phase 1 — impact & sound verification
BV.audio = {
  mute: () => { SFX.muted = true; }, unmute: () => { SFX.muted = false; },
  init: () => SFX.init(),
  play: (name, worldPos) => { SFX.init(); if (SFX[name]) SFX[name](worldPos); },
  state: () => ({ ctx: !!SFX.ctx, running: SFX.ctx ? SFX.ctx.state : 'none', muted: SFX.muted, voices: SFX._voices, master: AUDIO.master }),
};
BV.feel = () => ({ trauma: +trauma.toFixed(3), hitstop: +hitstop.toFixed(3),
  camKick: +camKick.length().toFixed(3), fovPunch: +fovPunch.toFixed(3), fov: +camera.fov.toFixed(2),
  trails: trails.length });
// Phase 2 — weighty offense / poise / finishers
BV.heavyAttack = () => { requestHeavyAttack(); return { heavy: player.heavy, stamina: Math.round(player.stamina) }; };
BV.poise = (e) => e ? ({ poise: +Number(e.poise).toFixed(1), max: e.maxPoise, staggered: !!e.staggered, hpFrac: +(e.hp / e.maxHp).toFixed(2) }) : null;
BV.stagger = (e) => { if (!e || !e.alive) return false; e.staggered = true; e.state = 'hurt'; e.timer = FEEL.staggerDur; setPose(e.anim, 'hurt', 0.05); return true; };
BV.staggerCount = () => enemies.filter(e => e.alive && e.staggered).length;
BV.finisher = (e) => doFinisher(e || finisherTarget());
BV.finisherEligible = () => enemies.filter(isFinisherEligible).length;

// ---------- Charsheet: inspect any soldier's career (press V) ----------
// shared titles so client + server render the destiny engine's labels identically (WorldSim is global)
function wsAgeTitle(k) { return (typeof WorldSim !== 'undefined' && WorldSim.ageTitle) ? WorldSim.ageTitle(k) : (k || ''); }
function wsDestinyTitle(k) { return (typeof WorldSim !== 'undefined' && WorldSim.destinyTitle) ? WorldSim.destinyTitle(k) : (k || ''); }
const charsheetOverlay = document.getElementById('charsheet');
function csSkill(label, raw) {
  const pct = Math.round(effSkill(raw));
  return '<div class="cs-skill"><span>' + label + '</span><div class="cs-bar"><i style="width:' + pct + '%"></i></div><b>' + pct + '</b></div>';
}
function csCard(c, isYou, leadLabel) {
  const champ = isChampion(c);
  return '<div class="cs-card' + (isYou ? ' you' : '') + (champ ? ' champ' : '') + '">' +
    '<div class="cs-name">' + (champ ? '★ ' : '') + c.name + (isYou ? ' <em>(you)</em>' : '') + ' <span class="cs-rank">' + c.rank + '</span></div>' +
    '<div class="cs-meta">' + classKeyOf(c.archetype) + ' · Renown ' + Math.round(c.renown) + ' · ' + c.kills + ' kills · ' +
      c.battles + ' battles' + (c.battlesWon ? ' (' + c.battlesWon + ' won)' : '') + (c.battlesLed ? ' · ' + c.battlesLed + ' led' : '') + '</div>' +
    csSkill('Strike', c.skills.strike) + csSkill('Guard', c.skills.guard) +
    (champ ? csSkill('Lead', c.skills.lead) : '') +
    '<div class="cs-stat">+' + c.dmgBonus + ' dmg · +' + c.hpBonus + ' HP · guard ×' + c.guardEff.toFixed(2) +
      (champ ? ' · commands ' + capLabel(commandCap(c)) : '') + '</div>' +
    (leadLabel ? '<div class="cs-leads">⚑ Leading ' + leadLabel + '</div>' : '') +
    (c.destiny && c.destiny !== 'wanderer' ? '<div class="cs-destiny">✦ Destiny: ' + wsDestinyTitle(c.destiny) + '</div>' : '') +
  '</div>';
}
function renderCharsheet() {
  if (!charsheetOverlay) return;
  if (!playerChar) loadCareers();
  const body = document.getElementById('cs-body');
  const roster = warbandRoster.slice().sort((a, b) => b.renown - a.renown);
  // which squad (if any) each champion currently leads — shown on their card
  const leadOf = {};
  for (const g of planGroups) if (g.leaderId != null) leadOf[g.leaderId] = g.name;
  const champs = roster.filter(isChampion);
  const rankfile = roster.filter(c => !isChampion(c));
  let html = playerChar ? csCard(playerChar, true, leadOf[playerChar.id]) : '';
  if (champs.length) html += '<div class="cs-section">Champions</div>' + champs.map(c => csCard(c, false, leadOf[c.id])).join('');
  if (rankfile.length) html += (champs.length ? '<div class="cs-section">Warband</div>' : '') + rankfile.map(c => csCard(c, false, leadOf[c.id])).join('');
  if (!roster.length) html += '<div class="cs-empty">No warband mustered yet — recruit, then march.</div>';
  body.innerHTML = html;
}
function toggleCharsheet(force) {
  if (!charsheetOverlay) return;
  const willShow = force !== undefined ? force : charsheetOverlay.classList.contains('hidden');
  if (willShow) { renderCharsheet(); charsheetOverlay.classList.remove('hidden'); if (document.exitPointerLock) document.exitPointerLock(); }
  else charsheetOverlay.classList.add('hidden');
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV') { e.preventDefault(); toggleCharsheet(); }
  else if (e.code === 'Escape' && charsheetOverlay && !charsheetOverlay.classList.contains('hidden')) toggleCharsheet(false);
});
const csClose = document.getElementById('cs-close');
if (csClose) csClose.addEventListener('click', () => toggleCharsheet(false));
BV.careers = () => ({ player: playerChar && serChar(playerChar), warband: warbandRoster.map(serChar) });
BV.fieldNames = () => ({ allies: allies.filter(a => a.alive).map(a => a.char && a.char.name), enemies: enemies.filter(en => en.alive).map(en => en.char && en.char.name) });
BV.killFeed = () => battleKillFeed.slice();
BV.toggleCharsheet = toggleCharsheet;
// champions & squad leadership inspection
BV.champions = () => warbandRoster.concat(playerChar ? [playerChar] : []).filter(isChampion)
  .map(c => ({ id: c.id, name: c.name, rank: c.rank, you: c === playerChar, renown: Math.round(c.renown),
    lead: Math.round(effSkill(c.skills.lead)), battlesLed: c.battlesLed, cap: commandCap(c) }))
  .sort((a, b) => b.renown - a.renown);
BV.setLeader = (gi, charId) => { const g = planGroups[gi]; if (g) setGroupLeader(g, charId); return g ? g.leaderId : null; };
BV.commandCap = (charId) => { const c = leaderCharById(charId); return c ? commandCap(c) : 0; };
BV.groupAura = (gi) => { const g = planGroups[gi]; if (!g) return null;
  const lc = leaderCharById(g.leaderId);
  return { leaderId: g.leaderId, leaderAlive: !!g.leaderAlive, cap: lc ? commandCap(lc) : 0,
    n: allies.filter(a => a.alive && a.group === g.id).length, aura: lc ? leadAura(lc) : null }; };

// ---------- Living world: reflect the server's always-on world on login ----------
// The backend wars on while you're away; on login we mirror its capital ownership onto this
// region's holds and show a "while you were away" digest of what changed. (Step 4.)
let worldReflected = false;
const whileawayOverlay = document.getElementById('whileaway');
function nationByName(nm) { if (PLAYER_REALM && nm === PLAYER_REALM.name) return PLAYER_REALM; for (const n of NATIONS) if (n.name === nm) return n; return null; }
function destinyHeaderHtml(d) {
  if (!d || !d.age) return '';
  const fates = (d.fated || []).slice(0, 4)
    .map(f => '<span class="wa-fate">' + f.name + ' — ' + (f.destinyTitle || wsDestinyTitle(f.destiny)) + '</span>').join('');
  return '<div class="wa-age">' + (d.ageTitle || wsAgeTitle(d.age)) + '</div>' +
    (d.prophecy ? '<div class="wa-prophecy">' + d.prophecy + '</div>' : '') +
    (fates ? '<div class="wa-fates">' + fates + '</div>' : '');
}
function showWhileAway(w) {
  if (!whileawayOverlay || !w || !w.events || !w.events.length) return;
  const tag = (t) => t === 'capital_taken' ? 'cap' : t === 'leader_fell' ? 'fell' : t === 'warlord_rose' ? 'rose' : (t === 'destiny' || t === 'age') ? 'fate' : '';
  document.getElementById('wa-body').innerHTML = destinyHeaderHtml(w.destiny) +
    w.events.slice(0, 24).map(e => '<div class="wa-ev ' + tag(e.type) + '">' + e.summary + '</div>').join('');
  const sub = document.getElementById('wa-sub'); if (sub) sub.textContent = w.events.length + ' tidings reached you while you were away.';
  whileawayOverlay.classList.remove('hidden');
  if (document.exitPointerLock) document.exitPointerLock();
  try { localStorage.setItem('bv-lastseen-tick', String(w.simTick || 0)); } catch (e) {}
}
function applyServerWorldOnce() {
  if (worldReflected) return;
  const w = (typeof window !== 'undefined' && window.net && window.net.world);
  if (!w) return;
  worldReflected = true;
  if (w.capitals) for (const sc of w.capitals) {
    const cap = nations.find(c => c.def && c.def.name === sc.def_name);
    if (cap) { const own = nationByName(sc.owner_name); if (own && own !== cap.owner) { cap.owner = own; recolorCapital(cap); } }
  }
  if (w.relations) setRelations(w.relations); // mirror the server's authoritative faction relations
  showWhileAway(w);
  renderOtherPlayers();
}
if (whileawayOverlay) { const wc = document.getElementById('wa-close'); if (wc) wc.addEventListener('click', () => whileawayOverlay.classList.add('hidden')); }
BV.serverWorld = () => (typeof window !== 'undefined' && window.net && window.net.world);

// ---------- Server-driven map: the bands ARE the server's warlords; other players visible ----------
// When online, the map's hosts are seeded from the authoritative server armies (named warlords at
// their map positions), and rival players' banners are shown. Everything here is gated on isServerMap()
// so OFFLINE play is exactly the original client sim. (Refinement; full real-time pure-view deferred.)
function isServerMap() { return !!(typeof window !== 'undefined' && window.net && window.net.world && Array.isArray(window.net.world.armies) && window.net.world.armies.length); }
function serverArmyToBand(a) {
  const fac = nationByName(a.faction) || NATIONS[0];
  const g = makePartyToken(a.size, fac);
  const ax = clamp(a.x, -MAP_HALF + 1, MAP_HALF - 1), az = clamp(a.z, -MAP_HALF + 1, MAP_HALF - 1);
  g.position.set(ax, mapElevY(ax, az), az);
  scene.add(g);
  const leader = makeChar('longsword', { team: 'enemy', name: a.name, renown: a.renown || 0, notability: 2 });
  leader.skills.strike = (a.renown || 0) * 0.3; recomputeChar(leader); // display/feel only; server owns the truth
  const band = { group: g, pos: g.position.clone(), size: a.size, alive: true, speed: 4.5, faction: fac,
    raider: a.size <= 5, clashCd: 0, parleyCd: 0, wanderT: rand(0, 3), wanderDir: rand(0, Math.PI * 2),
    level: mapLevel, leader, quality: 1.05, serverId: a.id };
  parties.push(band); setBandLabel(band);
}
function syncPartiesFromServer() {
  clearParties();
  for (const a of window.net.world.armies) serverArmyToBand(a);
}
let otherPlayerTokens = [];
function clearOtherPlayers() { for (const t of otherPlayerTokens) { scene.remove(t); disposeGroup(t); } otherPlayerTokens.length = 0; }
function makeOtherPlayerToken(name, size) {
  const g = makePartyToken(size || 1, { color: 0x39d0ff }); // cyan banner = another living player
  if (g.userData.label) { g.remove(g.userData.label); if (g.userData.label.material) { if (g.userData.label.material.map) g.userData.label.material.map.dispose(); g.userData.label.material.dispose(); } }
  const label = makeNameSprite('☆ ' + name);
  label.scale.set(4.4, 0.56, 1); label.position.y = 4.3; g.add(label); g.userData.label = label;
  return g;
}
function renderOtherPlayers() {
  clearOtherPlayers();
  const ps = (window.net && window.net.world && window.net.world.players) || [];
  for (const p of ps) { const g = makeOtherPlayerToken(p.name, p.size); const px = clamp(p.x, -MAP_HALF + 1, MAP_HALF - 1), pz = clamp(p.z, -MAP_HALF + 1, MAP_HALF - 1); g.position.set(px, mapElevY(px, pz), pz); scene.add(g); otherPlayerTokens.push(g); }
}
let presenceT = 0;
function sendPresenceMaybe(dt) {
  if (!(window.net && window.net.online)) return;
  presenceT -= dt; if (presenceT > 0) return;
  presenceT = 1.5;
  window.net.sendPresence({ name: playerChar ? playerChar.name : 'A Wanderer', faction: PLAYER_REALM.name, x: player.pos.x, z: player.pos.z, size: warbandTotal(), renown: playerChar ? playerChar.renown : 0 });
  if (window.net.sharedWorld) window.net.loadWorld().then(() => { if (mode === 'map') renderOtherPlayers(); }); // refresh rivals in MP
}
BV.serverBands = () => parties.filter(p => p.alive && p.serverId).map(p => ({ name: p.leader && p.leader.name, faction: p.faction.name, size: p.size, serverId: p.serverId }));
BV.otherPlayers = () => otherPlayerTokens.length;

// ============================================================================
//  STARTING STATIONS — "what you are" calculates "what you have"
// ----------------------------------------------------------------------------
//  Every universe (a fresh worldSeed, rerolled on refresh) deals the player a
//  STATION. The station is the single input; everything else — host size, unit
//  mix, holdings, renown, sworn allies, the war you open in, and the very fight
//  you're dropped into — is DERIVED from it. A Prince fields ≥100 men; an Outlaw
//  a desperate dozen. Refresh, or hit "New Universe", to be dealt another.
// ============================================================================
// The DRIFTER is the humble default — a nobody with 3–4 swords and no holdings, dealt on a plain
// load. It carries weight:0 so the random reroll pool never lands here; you only begin a drifter
// by default, then grow from there. encounter:'none' → land in MAP mode, no forced opening fight.
const DRIFTER = { key: 'drifter', title: 'Drifter', weight: 0, menLo: 3, menHi: 4, holdings: 0, pacts: 0, renownLo: 0, renownHi: 10, regionLo: 0, regionHi: 0, enemyFactor: 0, encounter: 'none',
  mix: { sword: 0.50, long: 0.0, archer: 0.25, thrower: 0.25 }, blurb: 'Three or four swords and the open road — raise a warband from nothing.' };
const STATIONS = [
  DRIFTER,
  { key: 'outlaw',   title: 'Outlaw',            weight: 3, menLo: 6,   menHi: 13,  holdings: 0, pacts: 0, renownLo: 0,   renownHi: 25,  regionLo: 0, regionHi: 1, enemyFactor: 1.5,  encounter: 'ambush',
    mix: { sword: 0.70, long: 0.05, archer: 0.15, thrower: 0.10 }, blurb: 'Landless and hunted — a fistful of blades and nothing left to lose.' },
  { key: 'sellsword', title: 'Sellsword Captain', weight: 3, menLo: 18,  menHi: 30,  holdings: 0, pacts: 1, renownLo: 30,  renownHi: 90,  regionLo: 1, regionHi: 2, enemyFactor: 1.15, encounter: 'field',
    mix: { sword: 0.50, long: 0.12, archer: 0.22, thrower: 0.16 }, blurb: 'A free company under contract — paid to win other men’s wars.' },
  { key: 'knight',   title: 'Hedge Knight',      weight: 3, menLo: 24,  menHi: 42,  holdings: 0, pacts: 1, renownLo: 60,  renownHi: 140, regionLo: 1, regionHi: 2, enemyFactor: 1.0,  encounter: 'field',
    mix: { sword: 0.55, long: 0.18, archer: 0.15, thrower: 0.12 }, blurb: 'A sworn sword and a small retinue, riding for land and renown.' },
  { key: 'baron',    title: 'Marcher Baron',     weight: 2, menLo: 45,  menHi: 70,  holdings: 1, pacts: 1, renownLo: 140, renownHi: 300, regionLo: 2, regionHi: 3, enemyFactor: 0.95, encounter: 'defend',
    mix: { sword: 0.50, long: 0.20, archer: 0.18, thrower: 0.12 }, blurb: 'Lord of a border hold — one castle to keep and a rival across the river.' },
  { key: 'prince',   title: 'Prince',            weight: 2, menLo: 100, menHi: 150, holdings: 1, pacts: 2, renownLo: 300, renownHi: 520, regionLo: 3, regionHi: 4, enemyFactor: 0.9,  encounter: 'field',
    mix: { sword: 0.45, long: 0.22, archer: 0.20, thrower: 0.13 }, blurb: 'Heir to a realm — a host of a hundred at your back and a throne to claim.' },
  { key: 'king',     title: 'High King',         weight: 1, menLo: 160, menHi: 240, holdings: 2, pacts: 2, renownLo: 520, renownHi: 900, regionLo: 4, regionHi: 5, enemyFactor: 0.8,  encounter: 'siege',
    mix: { sword: 0.42, long: 0.24, archer: 0.20, thrower: 0.14 }, blurb: 'Crowned and warlike — two holds, sworn vassals, and a grand campaign.' },
];
const ENCOUNTER_VERB = {
  none:   () => `The open road — raise your band`,
  ambush: n => `Ambushed — ${n} raiders close in`,
  field:  n => `A host of ${n} bars your path`,
  defend: n => `${n} march on your hold — break the siege`,
  siege:  n => `Storm the capital — ${n} defenders man the walls`,
};
let currentStation = null;

function _rngInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
function _shuffleIdx(rng, n) { const a = []; for (let i = 0; i < n; i++) a.push(i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function _compFromMix(total, mix) {
  const comp = { sword: 0, long: 0, archer: 0, thrower: 0 }; let used = 0;
  for (const k of WARBAND_KEYS) { comp[k] = Math.max(0, Math.round(total * (mix[k] || 0))); used += comp[k]; }
  comp.sword += total - used; if (comp.sword < 0) { comp.thrower += comp.sword; comp.sword = 0; } // never below zero
  if (comp.thrower < 0) comp.thrower = 0;
  return comp;
}

// Deal a station + all its derived state from a universe seed. Pure: same seed → same deal.
// forceKey pins the station (e.g. the humble 'drifter' default); otherwise it's drawn from the
// weighted pool (drifter is weight:0 → never drawn randomly, only forced).
function rollStation(seed, forceKey) {
  const rng = WorldSim.mulberry32((seed * 2654435761) >>> 0);
  const totalW = STATIONS.reduce((s, d) => s + d.weight, 0);
  let r = rng() * totalW, def = STATIONS.find(d => d.weight > 0) || STATIONS[0];
  for (const d of STATIONS) { if (d.weight > 0 && (r -= d.weight) < 0) { def = d; break; } }
  if (forceKey) { const f = STATIONS.find(d => d.key === forceKey); if (f) def = f; }
  const men = _rngInt(rng, def.menLo, def.menHi);
  const region = _rngInt(rng, def.regionLo, def.regionHi);
  const renown = _rngInt(rng, def.renownLo, def.renownHi);
  const idx = _shuffleIdx(rng, NATIONS.length);   // role assignment among the realms
  const homeIdx = idx[0];
  const rivalIdx = idx[idx.length - 1];
  const pactIdx = idx.slice(1, 1 + def.pacts).filter(i => i !== rivalIdx);
  const holdingIdx = idx.filter(i => i !== rivalIdx).slice(0, def.holdings); // home + allies, never the rival
  const comp = _compFromMix(men, def.mix);
  const enemy = Math.max(4, Math.round(men * def.enemyFactor + region * 6));
  return { seed, def, key: def.key, title: def.title, blurb: def.blurb, encounter: def.encounter,
    men, comp, region, renown, homeIdx, rivalIdx, pactIdx, holdingIdx, holdings: def.holdings, enemy };
}

function stationDisplayName(s) {
  const home = NATIONS[s.homeIdx].name;
  if (s.holdings > 0) return `${s.title} of ${home}`;
  if (s.pactIdx.length) return `${s.title} in service of ${NATIONS[s.pactIdx[0]].name}`;
  return s.title;
}

// Relations seeded FROM the station: your realm + sworn allies friendly, your rival at war,
// the rest wary strangers; AI neighbours stay sore (the pentagon) and gang on your rival's friends.
function seedStationRelations(s) {
  if (!_wsOK()) return;
  const all = NATIONS.map(n => n.name).concat([PLAYER_REALM.name]);
  const pr = PLAYER_REALM.name, homeName = NATIONS[s.homeIdx].name, rivalName = NATIONS[s.rivalIdx].name;
  const pactNames = new Set(s.pactIdx.map(i => NATIONS[i].name));
  const out = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j]; let opinion = 0;
    if (a === pr || b === pr) {
      const other = a === pr ? b : a;
      if (other === homeName || pactNames.has(other)) opinion = 75;       // your dynasty + sworn allies
      else if (other === rivalName) opinion = -80;                        // the war you wake up in
      else opinion = -10;                                                 // wary strangers
    } else {
      opinion = WorldSim.initialOpinion(a, b);                              // themed opening standing between the AI powers
      if ((a === rivalName && pactNames.has(b)) || (b === rivalName && pactNames.has(a))) opinion = Math.min(opinion, -50); // your rival also leans on your sworn friends
    }
    const c = WorldSim.canonPair(a, b);
    out.push({ a: c.a, b: c.b, opinion, stance: WorldSim.stanceFromOpinion(opinion, null) });
  }
  setRelations(out); soloRelSeeded = true;
}

// Apply a station onto live game state: warband, war chest, renown, sworn pacts, relations.
function applyStation(s) {
  for (const k of WARBAND_KEYS) warbandComp[k] = s.comp[k];
  xp = 40 + s.region * 30;                                  // a little to spend at the picker
  if (!playerChar) loadCareers();
  if (playerChar) { playerChar.renown = s.renown; recomputeChar(playerChar); }
  warbandRoster.length = 0; warbandNameSet.clear();          // a new universe musters a fresh host
  ensureWarbandRoster();
  playerPacts.clear();
  for (const i of s.pactIdx) playerPacts.add(NATIONS[i]);
  seedStationRelations(s);
}

// Flip the player's holdings to their banner on this universe's map.
function claimHoldings(s) {
  for (const i of s.holdingIdx) { const cap = nations[i]; if (cap) { cap.owner = PLAYER_REALM; recolorCapital(cap); } }
}

// Boot a brand-new universe from a station and drop straight into its calculated fight.
function startStationGame(s) {
  currentStation = s;
  clearBattlefield();
  clearParties();
  if (player.obj) { scene.remove(player.obj); disposeGroup(player.obj); }
  loadCareers();
  initPlayer();
  score = 0; addScore(0);
  wave = 0; betweenWaves = false; musterOpen = false;
  mapLevel = s.region;                                       // region difficulty IS the station's tier
  if (typeof clearCall === 'function') clearCall();
  shuffleHeroDeck();
  worldReflected = false; if (typeof window !== 'undefined' && window.net) window.net.loadWorld();
  coopRole = null; initCoopMaybe();
  startOverlay.classList.add('hidden');
  gameoverOverlay.classList.add('hidden');
  hud.classList.remove('hidden');

  applyStation(s);
  renderWarbandPicker();
  placeCapitals();                                          // this universe's land + capitals
  claimHoldings(s);

  if (s.encounter === 'none') {
    // The humble default: begin on the overworld with your 3–4, no forced opening fight.
    // Roam, pick winnable battles, recruit — raise the band from here.
    enterMap();
    updateStationReadout(s);
    return;
  }

  const rivalNation = NATIONS[s.rivalIdx];
  const rivalCap = nations[s.rivalIdx] || nations[0];
  const pos = { x: rivalCap.x, z: rivalCap.z };             // the fight takes the biome of the rival's land
  enterBattle({ size: s.enemy, level: mapLevel, alive: true, raider: s.enemy <= 5,
    pos, group: makePartyToken(s.enemy, rivalNation), faction: rivalNation, alliedBands: null });
  updateStationReadout(s);
}

// Deal a universe. With no seed → a fresh random one. Refresh defaults to a NEW universe;
// only an explicitly PINNED seed (#u=<seed>, set via the seed box) reproduces on refresh.
// forceKey pins the station — the default plain load deals the humble 'drifter' (map mode, no
// opening fight); the "New Universe" reroll & seed box deal random dramatic stations.
function bootUniverse(seed, forceKey) {
  if (seed == null) seed = (Math.random() * 0xffffffff) >>> 0;
  universeSeed = seed >>> 0;
  startStationGame(rollStation(universeSeed, forceKey));
}

// ---------- Station readout + "New Universe" (reroll) panel ----------
let stationPanel = null;
function buildStationPanel() {
  if (stationPanel) return stationPanel;
  const p = document.createElement('div');
  p.id = 'station-panel';
  p.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:100000;width:260px;padding:12px 14px;' +
    'background:rgba(16,12,24,.88);border:1px solid #ffd34d;border-radius:12px;color:#f4ecdc;' +
    'font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.55);pointer-events:auto;backdrop-filter:blur(3px)';
  p.innerHTML =
    '<button id="sp-reroll" style="width:100%;margin-bottom:8px;padding:8px;border:0;border-radius:8px;cursor:pointer;' +
      'background:linear-gradient(180deg,#ffd86b,#e0a52c);color:#241a06;font-weight:800;letter-spacing:.4px">⟳ NEW UNIVERSE</button>' +
    '<div id="sp-title" style="font-size:16px;font-weight:800;color:#ffe089"></div>' +
    '<div id="sp-blurb" style="opacity:.8;font-style:italic;margin:3px 0 8px"></div>' +
    '<div id="sp-stats" style="font-weight:700;color:#9adcff"></div>' +
    '<div id="sp-stand" style="margin-top:4px;font-size:12px;opacity:.92"></div>' +
    '<div id="sp-fight" style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,211,77,.25);color:#ff9a8a;font-weight:700"></div>' +
    '<div style="margin-top:8px;display:flex;gap:6px;align-items:center">' +
      '<span style="opacity:.6;font-size:11px">seed</span>' +
      '<input id="sp-seed" inputmode="numeric" style="flex:1;min-width:0;padding:4px 6px;border:1px solid #574a2c;border-radius:6px;background:#0d0a14;color:#cdbd92;font:12px monospace">' +
      '<button id="sp-go" style="padding:4px 8px;border:0;border-radius:6px;cursor:pointer;background:#3a3050;color:#e8def8;font-weight:700">Go</button>' +
    '</div>';
  document.body.appendChild(p);
  if (TOUCH) { // on phones this panel would cover the left thumb — start collapsed to a chip, tap to expand
    p.classList.add('collapsed');
    const tog = document.createElement('button');
    tog.id = 'sp-toggle'; tog.textContent = '⟳'; tog.title = 'Universe / seed';
    tog.addEventListener('click', () => p.classList.toggle('collapsed'));
    p.insertBefore(tog, p.firstChild);
  }
  p.querySelector('#sp-reroll').addEventListener('click', () => { try { if (typeof location !== 'undefined') location.hash = ''; } catch (e) {} bootUniverse(); }); // unpin → next refresh is fresh too
  const go = () => { const v = parseInt(p.querySelector('#sp-seed').value, 10); if (isNaN(v)) return; try { if (typeof location !== 'undefined') location.hash = 'u=' + (v >>> 0); } catch (e) {} bootUniverse(v >>> 0); }; // pin: this exact universe reloads on refresh
  p.querySelector('#sp-go').addEventListener('click', go);
  p.querySelector('#sp-seed').addEventListener('keydown', (e) => { if (e.code === 'Enter') { e.preventDefault(); go(); } });
  stationPanel = p;
  return p;
}
function updateStationReadout(s) {
  const p = buildStationPanel();
  const nm = n => NATIONS[n].name;
  const holds = s.holdingIdx.map(nm);
  const allies = s.pactIdx.map(nm);
  p.querySelector('#sp-title').textContent = stationDisplayName(s);
  p.querySelector('#sp-blurb').textContent = s.blurb;
  p.querySelector('#sp-stats').textContent =
    `${s.men} men · ${holds.length} hold${holds.length === 1 ? '' : 's'} · renown ${s.renown} · region ${roman(s.region + 1)}`;
  p.querySelector('#sp-stand').innerHTML =
    (holds.length ? `<span style="color:#7fd0ff">Holds:</span> ${holds.join(', ')}<br>` : '') +
    (allies.length ? `<span style="color:#7dff9a">Sworn:</span> ${allies.join(', ')}<br>` : '') +
    `<span style="color:#ff8a7a">At war:</span> ${nm(s.rivalIdx)}`;
  p.querySelector('#sp-fight').textContent = (ENCOUNTER_VERB[s.encounter] || ENCOUNTER_VERB.field)(s.enemy);
  p.querySelector('#sp-seed').value = String(s.seed);
}

// debug / verification hooks
BV.rollStation = rollStation;
BV.bootUniverse = bootUniverse;
BV.station = () => currentStation && { seed: currentStation.seed, title: stationDisplayName(currentStation),
  men: currentStation.men, comp: currentStation.comp, region: currentStation.region, renown: currentStation.renown,
  holds: currentStation.holdingIdx.map(i => NATIONS[i].name), allies: currentStation.pactIdx.map(i => NATIONS[i].name),
  rival: NATIONS[currentStation.rivalIdx].name, enemy: currentStation.enemy, encounter: currentStation.encounter };
BV.universeSeed = () => universeSeed;

// Auto-deal a universe on load. The DEFAULT is the humble 'drifter' — begin on the overworld
// (MAP mode) with a 3–4 warband and no forced opening fight; raise the band from there.
// A PINNED #u=<seed> instead reproduces a full dramatic station (outlaw/prince/…), and the
// "New Universe" reroll deals a fresh random station — both via the station panel.
const _bootMatch = (typeof location !== 'undefined' && location.hash || '').match(/u=(\d+)/);
if (_bootMatch) bootUniverse(parseInt(_bootMatch[1], 10) >>> 0);
else bootUniverse(undefined, 'drifter');

})();
