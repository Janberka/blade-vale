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
// On foot (action rung) the world is a real landscape you survey, not a combat arena. A WIDER lens
// (vs the tight 55° combat "normal" lens) pushes the far world back — the tight lens made distant
// castles loom like a telephoto moon. Paired with a slightly closer camera in setFieldMode, it's a
// dolly-zoom: the hero stays framed the same while the horizon (and that castle) recedes.
const FIELD_FOV = 66;
const camKick = new THREE.Vector3();
const _killDir = new THREE.Vector3();
let fovPunch = 0;
let _camFov = CAM_BASE_FOV;   // smoothed base FOV so switching rungs eases in instead of popping
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
  // release from shoulder height, aim at the target's UPPER BODY (chest/head). On the overworld the
  // ground isn't flat, so reference both ends to the terrain underfoot (0 in the flat battle arena).
  const from = shooter.pos.clone(); from.y = (fieldSimOn() ? mapElevY(from.x, from.z) : 0) + 1.8 * shooter.def.scale;
  const tScale = target.def ? target.def.scale : 1;
  const to = target.pos.clone(); to.y = (fieldSimOn() ? mapElevY(to.x, to.z) : 0) + 2.1 * tScale;
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
    const groundY = fieldSimOn() ? mapElevY(p.mesh.position.x, p.mesh.position.z) : 0; // hilly overworld vs flat arena
    // the 3s life + ground check bound the shot; the arena xz wall only applies in the fixed-size battle arena
    // (in field mode the hero roams far past ARENA, so that wall would kill arrows prematurely)
    let dead = p.life <= 0 || p.mesh.position.y <= groundY + 0.05 ||
               (!fieldSimOn() && (Math.abs(p.mesh.position.x) > ARENA + 2 || Math.abs(p.mesh.position.z) > ARENA + 2));
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
// the player's army may split into detachments (each with its own troops + orders) that roam the
// map. The lead column (warbandComp) is the men riding WITH you; detachments are a separate, disjoint
// pool, so every Character lives in exactly one of warbandRoster or one detachment's roster.
function detSize(det) { return WARBAND_KEYS.reduce((s, k) => s + (det.comp[k] || 0), 0); }
function armyTotal() { return warbandTotal() + detachments.reduce((s, d) => s + detSize(d), 0); }
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

// third-person mouse look: pointer lock on the canvas, mouse steers the camera.
// requestPointerLock returns a promise in modern browsers and REJECTS (async, so a
// try/catch can't see it) when the call isn't tied to a live user gesture — swallow it.
function grabPointer() {
  if (!canvas.requestPointerLock) return;
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* needs a user gesture */ }
}
canvas.addEventListener('click', () => {
  SFX.init(); // browsers gate WebAudio behind a user gesture — this is the reliable one
  // pointer lock rides with gameRunning: a real battle OR action mode (both are 3rd-person mouse-aim).
  // Map/overworld leave gameRunning false, so their cursor stays free to click-march.
  if (gameRunning && !commandPanelOpen && !pointerLocked) grabPointer();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  // losing the cursor mid-battle (Esc / alt-tab) surfaces the command deck instead of stranding the player
  if (!pointerLocked && mode === 'battle' && gameRunning && !commandPanelOpen) openCommandDeck();
  // in action mode there's no deck — tell the player how to re-aim (click) or pull back out (P)
  else if (!pointerLocked && fieldSimOn() && !mapCmdMode) showCmdToast('Cursor freed — click to re-aim · P to pull back to the map');
});
addEventListener('mousemove', (e) => {
  if (!pointerLocked || !gameRunning) return;   // mouse-look in battle + action mode; map/overworld stay north-up
  cameraAngle -= e.movementX * 0.0035;
  cameraHeight = clamp(cameraHeight + e.movementY * 0.02, 2.2, 10);
});

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  SFX.init(); // unlock audio on first keypress too (covers keyboard-first players)
  if (mode === 'plan' || commandPanelOpen) { handlePlanKey(e); return; } // commanding: keys order troops, not the fighter
  if (mode === 'battle' && gameRunning && handleBattleOrderKey(e)) return; // real-time squad orders WHILE you fight (no deck, no slow)
  if (e.code === 'Space') { e.preventDefault(); requestDodge(); }
  // F draws the weapon in a fight — but on the strategic (top-down) map it's the Find-parties locator
  if (e.code === 'KeyF' && !(mode === 'map' && !mapFieldMode && !encounter)) toggleWeapon();
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
    const field = mode === 'map' && mapFieldMode && !mapCmdMode && !encounter; // on-foot character roam = battle-like
    const inMap = mode === 'map' && !encounter && !field;                       // strategic banner roam
    const inBattle = (mode === 'battle' && gameRunning && !commandPanelOpen && !encounter) || field;
    return { inMap, inBattle, field, any: inMap || inBattle };
  }
  function classify(t) {
    const c = controllable();
    if (!c.any) return null;
    if (c.inBattle && t.clientX > innerWidth * 0.5) return 'look'; // right half steers the camera (battle + field)
    return 'move'; // left thumb (and all of strategic map mode) moves the avatar
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
      else if (t.identifier === lookId && gameRunning) { // drag-look in battle + action mode; map/overworld stay north-up
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
  bindBtn('tb-ride', () => { if (mode === 'map' && !encounter && !mapCmdMode) setFieldMode(!mapFieldMode); });
  bindBtn('tb-rally', () => { if (mode === 'map' && !encounter) raiseCall(); });
  bindBtn('tb-beacon', () => { if (mode === 'map' && !encounter) openBeaconPanel(); });
  bindBtn('tb-warband', () => toggleCharsheet());
  bindBtn('tb-chars', () => { if (mode === 'map') toggleCharsPanel(); });
  bindBtn('tb-town', () => { if (mode === 'map' && !encounter) { const h = nearestOwnedHold(); if (h) enterTown(h); } });

  // show the right control set for the current mode; called each frame from the loop
  window.updateTouchHud = function () {
    if (!touchRoot) return;
    const c = controllable();
    touchRoot.classList.toggle('hidden', !c.any);
    touchRoot.classList.toggle('mapmode', c.inMap);
    touchRoot.classList.toggle('battlemode', c.inBattle);
    touchRoot.classList.toggle('fieldmode', !!c.field); // on-foot map roam: battle buttons + the View toggle stay reachable
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
        if (pd > (fieldSimOn() ? 4.5 * FIELD_SCALE : 4.5)) { // a tight escort at the small field scale
          const mv = new THREE.Vector3().subVectors(player.pos, f.pos).setY(0);
          if (mv.lengthSq() > 1e-6) mv.normalize(); else mv.set(1, 0, 0); // guard: never normalize a zero vector (stacked on the player)
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
  let fBaseY = 0;
  if (fieldSimOn()) { // overworld escort: confine to land + ride the terrain height, like the hero
    const fx = f.pos.x, fz = f.pos.z;
    const [nx, nz] = landStep(fx, fz, f.vel.x * dt * FIELD_SPEED_MUL, f.vel.z * dt * FIELD_SPEED_MUL); // match the hero's scaled pace
    f.pos.x = nx; f.pos.z = nz;
    fBaseY = mapElevY(nx, nz);
  } else {
    f.pos.addScaledVector(f.vel, dt);
    confine(f.pos);
  }
  f.obj.position.copy(f.pos);
  f.obj.position.y = fBaseY;
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
      f.obj.position.y = fBaseY + Math.abs(Math.cos(f.walkPhase)) * 0.05 * f.def.scale;
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
  // personal-space radius; at the small field scale the crowd packs proportionally tighter
  const R = fieldSimOn() ? 2.2 * FIELD_SCALE : 2.2, R2 = R * R;
  const cx = Math.floor(self.pos.x / SEP_CELL), cz = Math.floor(self.pos.z / SEP_CELL);
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const arr = sepGrid.get(gx * 4096 + gz);
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (o === self || !o.alive) continue;
        const d2 = self.pos.distanceToSquared(o.pos);
        if (d2 < R2 && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          sepV.add(tmpV.subVectors(self.pos, o.pos).setY(0).normalize().multiplyScalar((R - d) / R));
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
  let baseY = 0, fsc = 1;
  if (fieldSimOn()) {
    // overworld: confine to dry land (landStep) and ride the terrain height instead of the flat arena.
    // Displacement is scaled by FIELD_SPEED_MUL so the small hero reads as jogging through a big world.
    fsc = FIELD_SCALE;
    const ox = player.pos.x, oz = player.pos.z;
    const [nx, nz] = landStep(ox, oz, player.vel.x * dt * FIELD_SPEED_MUL, player.vel.z * dt * FIELD_SPEED_MUL);
    if (nx === ox) player.vel.x = 0;   // bumped the coast — kill that component
    if (nz === oz) player.vel.z = 0;
    player.pos.x = nx; player.pos.z = nz; player.pos.y = 0;
    baseY = mapElevY(nx, nz);
  } else {
    player.pos.addScaledVector(player.vel, dt);
    confine(player.pos);
  }
  player.obj.position.copy(player.pos);
  player.obj.position.y = baseY;
  if (walking) {
    player.obj.position.y = baseY + Math.abs(Math.cos(player.walkPhase)) * 0.06 * fsc;
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
    player.obj.position.y -= 0.7 * ct * fsc; // hips sink toward the folded legs (scaled with the body in field mode)
    // lean ramps gently at first, then HARD once the knees hit their limit —
    // a deep crouch tips the torso forward over the knees instead of sinking more
    const deep = Math.max(0, (ct - 0.4) / 0.6);
    p.upperBody.rotation.x += 0.22 * ct + 0.4 * deep;
    // hard floor: never let the fold clip the body through the ground (baseY = terrain height, 0 in the arena)
    const minY = _crouchBox.setFromObject(player.obj).min.y;
    if (minY < baseY) player.obj.position.y -= (minY - baseY); // lift so the lowest point rests on the ground underfoot
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
  if (!pointerLocked) { // keyboard orbit fallback when the mouse isn't captured (battle + action mode)
    if (keys['KeyQ']) cameraAngle -= dt * 2;
    if (keys['KeyE']) cameraAngle += dt * 2;
  }
  // over-the-shoulder: shift the frame so the character sits left of center, leaving room on the right
  // where the sword swings. In field mode the hero is tiny (FIELD_SCALE), so the shoulder offset, eye
  // height and look-at all shrink to match — which is exactly what makes the fixed-size walls tower.
  const fsc = fieldSimOn() ? FIELD_SCALE : 1;
  const ox = Math.cos(cameraAngle) * 0.7 * fsc, oz = -Math.sin(cameraAngle) * 0.7 * fsc;
  const tx = player.pos.x + ox + Math.sin(cameraAngle) * cameraDist;
  const tz = player.pos.z + oz + Math.cos(cameraAngle) * cameraDist;
  // on the overworld the floor isn't flat — lift the rig by the terrain under the hero, and never let
  // the eye sink into a hill it's sitting behind
  const baseY = fieldSimOn() ? mapElevY(player.pos.x, player.pos.z) : 0;
  let wantY = baseY + cameraHeight;
  if (fieldSimOn()) wantY = Math.max(wantY, mapElevY(camBase.x, camBase.z) + 1.4 * fsc);
  camBase.x = lerp(camBase.x, tx, clamp(dt * 6, 0, 1));
  camBase.z = lerp(camBase.z, tz, clamp(dt * 6, 0, 1));
  camBase.y = lerp(camBase.y, wantY, clamp(dt * 6, 0, 1));
  camera.position.copy(camBase);
  // field mode aims at the rig's true eye line (the humanoid stands ~3.4u at scale 1, so ~2.9*fsc);
  // battle keeps its tuned 1.7 chest-height framing
  camera.lookAt(player.pos.x + ox, baseY + (fieldSimOn() ? 2.9 : 1.7) * fsc, player.pos.z + oz);
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
  // FOV: wide-angle on foot (pushes the far world back), tight in the arena — eased between rungs so
  // the switch doesn't pop. The heavy-hit "punch" (a quick zoom-in on a kill) subtracts on top and
  // decays as before.
  if (fovPunch > 0.001) { fovPunch *= clamp(1 - dt * FEEL.fovDecay, 0, 1); if (fovPunch < 0.02) fovPunch = 0; }
  _camFov = lerp(_camFov, fieldSimOn() ? FIELD_FOV : CAM_BASE_FOV, clamp(dt * 5, 0, 1));
  const wantFov = _camFov - fovPunch;
  if (Math.abs(camera.fov - wantFov) > 0.001) { camera.fov = wantFov; camera.updateProjectionMatrix(); }
}
// strategic overview: a high, steeply-tilted camera looking down on the warband token
// or discovery mode: very high, looking down on the entire explored world
// A short-lived override that frames a spot on the strategic map (one of your other characters,
// say) instead of your own banner. Ticks down in updateMapCamera, then the camera drifts back to you.
let mapCamFocus = null;   // { x, z, t }
function focusMapOn(x, z, secs) { mapCamFocus = { x: x, z: z, t: secs || 5 }; }
function clearMapFocus() { mapCamFocus = null; }
// MAP and OVERWORLD are the SAME north-looking rig, centered on the character — the overworld just
// sits farther out along the SAME view ray (lift and pull-back scaled by one multiplier). Because the
// look target and the direction are identical at both rungs, switching is a pure dolly: the camera
// glides out/in along one line and never rotates. (Action mode is the separate 3rd-person camera.)
const OVERWORLD_ZOOM = 3;  // how much farther the overworld eye sits vs map mode
function updateMapCamera(dt) {
  const k = clamp(dt * 4, 0, 1);
  if (mapCamFocus) { mapCamFocus.t -= dt; if (mapCamFocus.t <= 0) mapCamFocus = null; }
  const fx = mapCamFocus ? mapCamFocus.x : player.pos.x;   // frame a focused spot, else your own banner
  const fz = mapCamFocus ? mapCamFocus.z : player.pos.z;
  const gy = mapElevY(fx, fz); // ride the relief so the cam clears hills and peaks
  const mul = discoveryMode ? OVERWORLD_ZOOM : 1;          // overworld = same ray, just farther out
  camBase.x = lerp(camBase.x, fx, k);
  camBase.y = lerp(camBase.y, gy + vlerp(VISTA.camLift) * mul, k);
  camBase.z = lerp(camBase.z, fz + vlerp(VISTA.camBack) * mul, k);
  camera.position.copy(camBase);
  camera.lookAt(fx, gy, fz);
}

// ---------- Field mode: zoom into the overworld and play as your character (battle controls) ----------
// Strategic view = the eye-in-the-sky banner. FIELD MODE = the camera drops to ground level and you run
// the actual hero (player.obj) across the real terrain with the FULL battle control stack — mouse-aim,
// click attack, right-click heavy, SHIFT block, SPACE dodge, F weapon swap, weapon drawn — and your
// warband COMPANY follows as individual soldiers. The world keeps simulating; ride into a band and the
// normal encounter -> battle flow takes over. Scroll wheel zooms in/out across the threshold; T toggles.
let mapFieldMode = false;            // false = strategic top-down banner; true = character-level free-roam
let fieldPref = false;               // remember the player's choice so it survives battles / new regions
const FIELD_COMPANY_CAP = 24;        // warband soldiers drawn escorting you (the rest of a big host is abstracted)
// The overworld is a strategic MINIATURE — a city wall is only ~1.8 world units tall — so a battle-scale
// hero (~1.8u) would tower over it. In field mode the whole "person layer" (hero, company, the materialised
// enemy hosts, the camera framing and the move speed) is shrunk by FIELD_SCALE, so the fixed-size world
// (walls, houses, hills) reads as genuinely large and you feel like one soldier walking through it.
const FIELD_SCALE = 0.42;            // person height relative to battle scale (~0.74u tall vs a 1.8u city wall)
const FIELD_SPEED_MUL = 0.6;         // displacement is scaled down so it reads as a jog across a big world
const FIELD_ARMY = { showR: 36, hideR: 44, capPerBand: 16, capTotal: 80 }; // nearby flags -> real soldier crowds
const fieldArmies = new Map();       // band -> { bodies:[...] } — materialised hosts near the hero
// true only while the overworld is driven as a character — makes updatePlayer / stepFighter / updateCamera
// ride terrain elevation (mapElevY) + land-confinement (landStep) instead of the flat battle arena
function fieldSimOn() { return mapFieldMode && mode === 'map'; }
// spawn the warband as individual ally fighters clustered behind the hero; order 'free' = follow the player
function spawnFieldCompany() {
  clearAllies();
  ensureWarbandRoster();
  const live = warbandRoster.filter(c => !c.fallen);
  const n = Math.min(live.length, FIELD_COMPANY_CAP);
  for (let i = 0; i < n; i++) {
    const c = live[i];
    const def = ALLY_DEF_BY_CLASS[classKeyOf(c.archetype)] || ALLY_DEF;
    const ang = player.facing + Math.PI + rand(-0.95, 0.95);                  // fan out behind the hero
    const r = (2.0 + (i % 5) * 1.0 + rand(0, 0.6)) * FIELD_SCALE;             // tight cluster, scaled to the small bodies
    const [lx, lz] = landStep(player.pos.x, player.pos.z, Math.sin(ang) * r, Math.cos(ang) * r);
    const a = spawnAlly(lx, lz, ALLY_PALETTES[i % ALLY_PALETTES.length], def, c);
    a.order = 'free'; a.facing = player.facing;        // 'free' + no enemy = regroup/follow on the player
    a.obj.scale.multiplyScalar(FIELD_SCALE);           // shrink to person-vs-city scale
    a.obj.position.y = mapElevY(lx, lz);
  }
}
// enter/leave field mode. Entering flips on the battle control stack (gameRunning) and grabs the cursor.
function setFieldMode(on, opts) {
  on = !!on;
  if (on === mapFieldMode) return;
  if (on && (mode !== 'map' || encounter || mapCmdMode)) return; // only from the free strategic overworld
  mapFieldMode = on;
  if (!(opts && opts.keepPref)) fieldPref = on;
  if (on) {
    coopMult = 1;                                    // no co-op buff while just roaming
    player.alive = true;
    player.attacking = player.shooting = player.heavy = player.rolling = player.blocking = false;
    player.attackPhase = 0; player.cooldown = 0; player.combo = 0;
    player.obj.scale.setScalar(FIELD_SCALE);          // a realistic soldier, not a colossus over the walls
    player.obj.rotation.set(0, player.facing, 0);
    setPlayerWeaponVisual();                          // weapon drawn, exactly like battle
    spawnFieldCompany();                              // your company falls in behind you
    if (player.mapToken) player.mapToken.visible = false; // hide the strategic banner...
    setDetVisible(false);                             // ...and any detachment columns
    if (typeof clearFindFlares === 'function') clearFindFlares(); // locator flares are a top-down aid
    player.obj.visible = true;
    gameRunning = true;                              // unlocks pointer-lock + mouse-aim + attack/dodge/weapon
    cameraAngle = player.facing + Math.PI;            // 3rd person: start behind the hero (rotation is welcome here)
    cameraDist = 8.5 * FIELD_SCALE; cameraHeight = 5.5 * FIELD_SCALE; // closer than before: the dolly-zoom half — the wide FIELD_FOV gives the headroom for tall buildings, so the camera can sit near the hero (which makes the FAR castle read as far). 5.5*FS clears the mouse-look floor of 2.2
    // ACTION MODE locks the mouse for aim-look. Entered via the L keydown (a real user gesture), so the
    // pointer-lock request is allowed — unlike the old scroll-wheel path browsers rejected.
    grabPointer();
    showCmdToast('Action — mouse aim · click attack · WASD move · P back to the map');
  } else {
    clearAllies();                                   // the on-foot escort folds back into the banner
    clearAllFieldArmies();                           // nearby hosts go back to being banner tokens
    player.obj.visible = false;
    player.obj.scale.setScalar(1);                   // restore battle scale for the next real fight
    if (player.mapToken) player.mapToken.visible = true;
    setDetVisible(true);
    gameRunning = false;
    cameraAngle = 0;                                  // stay north-up (it already is; keep it explicit)
    if (document.exitPointerLock) document.exitPointerLock();
    showCmdToast('Strategic view — press L to drop into action, P for the wide overview');
  }
  applyDetailTier();                                 // action rung = street level; strategic = the miniature
  if (TOUCH && window.updateTouchHud) window.updateTouchHud();
}

// ----- Nearby hosts become REAL soldiers, not flags. While in field mode, every band within range is
// drawn as a small crowd of fighters at FIELD_SCALE; a band locked in a clash visibly fights the host on
// the other side of its map-battle. The banner token (and the clash icon) hide while materialised and
// return when you walk away or leave field mode. These crowds are visual — riding in still opens the
// real encounter -> battle. -----
function factionFieldPalette(faction) {
  const c = (faction && faction.color != null) ? faction.color : 0x8a1a1a;
  return { skin: 0xd9a877, cloth: c, accent: c, blade: 0xcdd4dc };
}
function makeFieldExtra(faction, weapon) {
  const h = buildHumanoid(factionFieldPalette(faction), FIELD_SCALE, weapon);
  scene.add(h.group);
  return { group: h.group, parts: h.parts, anim: makeAnimator(h.parts), phase: rand(0, 6.28),
           ox: 0, oz: 0, swing: rand(0.3, 1.2), swinging: false };
}
function clearFieldArmy(band) {
  const fa = fieldArmies.get(band); if (!fa) return;
  for (const b of fa.bodies) { scene.remove(b.group); disposeGroup(b.group); }
  fieldArmies.delete(band);
  if (band.group) band.group.visible = true;          // banner returns (clash markers are re-shown centrally below)
}
function clearAllFieldArmies() {
  for (const band of [...fieldArmies.keys()]) clearFieldArmy(band);
  for (const bt of mapBattles) if (bt.marker) bt.marker.visible = true; // back to flags/markers in the strategic view
}
function materialiseBand(band, budget) {
  const n = Math.min(Math.round(band.size) || 1, FIELD_ARMY.capPerBand, budget);
  if (n <= 0) return 0;
  const bodies = [];
  for (let i = 0; i < n; i++) {
    const w = (i % 6 === 0) ? 'bow' : 'sword';                            // a few archers for silhouette variety
    const b = makeFieldExtra(band.faction, w);
    const a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
    const rr = (0.5 + Math.sqrt((i + 1) / n) * 2.4) * FIELD_SCALE;        // packed cluster, scaled to the bodies
    b.ox = Math.cos(a) * rr; b.oz = Math.sin(a) * rr;
    bodies.push(b);
  }
  fieldArmies.set(band, { bodies, lx: band.pos.x, lz: band.pos.z });
  if (band.group) band.group.visible = false;          // the flag gives way to the soldiers
  return n;
}
function updateFieldArmyBodies(band, fa, dt) {
  // a band locked in a clash fights a host on the OTHER side of its map-battle (sideA/sideB are SIDE
  // objects holding .bands — pick a living enemy band from the opposite side to orient/strike toward)
  let foe = null;
  if (band.inBattle) {
    const bt = band.inBattle, other = bt.sideA.bands.includes(band) ? bt.sideB : bt.sideA;
    foe = other.bands.find(x => x.alive) || other.bands[0] || null;
  }
  const mx = band.pos.x - fa.lx, mz = band.pos.z - fa.lz; fa.lx = band.pos.x; fa.lz = band.pos.z;
  const moving = !foe && (mx * mx + mz * mz) > 1e-5;
  const faceTo = foe ? Math.atan2(foe.pos.x - band.pos.x, foe.pos.z - band.pos.z)
              : moving ? Math.atan2(mx, mz)
              : Math.atan2(player.pos.x - band.pos.x, player.pos.z - band.pos.z); // idle: turn toward the traveller
  for (const b of fa.bodies) {
    const wx = band.pos.x + b.ox, wz = band.pos.z + b.oz;
    b.group.position.set(wx, mapElevY(wx, wz), wz);
    b.group.rotation.y = faceTo + (foe ? Math.sin(b.phase * 1.7) * 0.3 : 0);
    if (foe) {                                          // melee: shuffle + periodic swings into the enemy host
      b.phase += dt * 6; walkLegs(b.parts, b.phase, 0.25);
      b.swing -= dt;
      if (b.swing <= 0) { b.swinging = !b.swinging; b.swing = b.swinging ? 0.16 : rand(0.4, 1.1); setPose(b.anim, b.swinging ? MOVES.slashR.strike : 'guard', 0.08); }
    } else if (moving) {                                // marching column
      b.phase += dt * 7; walkLegs(b.parts, b.phase, 0.4); setPose(b.anim, 'guard', 0.3);
    } else {                                            // halted, watching you pass
      restLegs(b.parts, dt, true); setPose(b.anim, 'guard', 0.3);
    }
    updateAnimator(b.anim, dt);
  }
}
function updateFieldArmies(dt) {
  if (!fieldSimOn()) { if (fieldArmies.size) clearAllFieldArmies(); return; }
  for (const band of [...fieldArmies.keys()]) if (!band.alive || !parties.includes(band)) clearFieldArmy(band); // died / despawned
  let total = 0; for (const fa of fieldArmies.values()) total += fa.bodies.length;
  const px = player.pos.x, pz = player.pos.z;
  for (const band of parties) {
    if (!band.alive) continue;
    const d = Math.hypot(band.pos.x - px, band.pos.z - pz);
    const has = fieldArmies.get(band);
    if (!has && d <= FIELD_ARMY.showR && total < FIELD_ARMY.capTotal) total += materialiseBand(band, FIELD_ARMY.capTotal - total);
    else if (has && d >= FIELD_ARMY.hideR) { clearFieldArmy(band); continue; }
    const fa = fieldArmies.get(band);
    if (fa) updateFieldArmyBodies(band, fa, dt);
  }
  // clash icons: hide a battle's marker only while one of its hosts is drawn as a real crowd, else show it.
  // Centralised here so it self-heals — a band dying mid-clash (which nulls band.inBattle) can't strand a marker.
  for (const bt of mapBattles) {
    if (!bt.marker) continue;
    bt.marker.visible = !(bt.sideA.bands.some(b => fieldArmies.has(b)) || bt.sideB.bands.some(b => fieldArmies.has(b)));
  }
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
const detachments = [];   // the player's own roaming columns, split off the warband (see detSize/armyTotal)
let detachCounter = 0;    // running id for detachments
let mapLevel = 0;         // rises each time you clear the map — bands get bigger
let universeSeed = 1;     // identifies THIS game universe — rerolled on refresh; mixes into worldSeed so terrain/capitals/diplomacy all differ run-to-run
// Shared multiplayer: one fixed terrain seed so every player sees the SAME map + capitals, but each
// is dealt a distinct station (seed ^ token hash) and spawns near their home realm — distinct kingdoms.
const SHARED_WORLD_SEED = 0x51A3F00D;
let mpHomeIdx = null;     // in shared mode, the realm whose lands this player begins in (drives spawn)
let mpSpawnJitter = 0;    // per-player deterministic offset so same-realm players don't stack
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
// The math itself lives in sim/terra.js — the SHARED terrain kernel the server runs verbatim, so
// client and server generate byte-identical worlds from the same seed. game.js keeps thin same-name
// shims over a seed-bound instance that is rebuilt whenever worldSeed() changes (region advance,
// universe reroll). NEVER tune terrain here: tune it in terra.js and bump Terra.VERSION.
const worldSeed = () => ((mapLevel * 1000 + 7) ^ (universeSeed * 2654435761)) >>> 0;
const SEA_LEVEL = Terra.SEA_LEVEL;
const TERR_SCALE = Terra.TERR_SCALE;
let _terraInst = null, _terraInstSeed = -1;
function terra() {
  const s = worldSeed();
  if (!_terraInst || _terraInstSeed !== s) {
    _terraInst = Terra.make(s, {
      capitalsProvider: () => nations.map(n => ({ x: n.x, z: n.z, name: n.def.name })),
      roadFactorAt: (x, z) => roadFactorAt(x, z),   // drawn-road benefit feeds the kernel's travel costs
    });
    _terraInst.heightFn = (x, z) => mapElevY(x, z); // the ?edit sculpted-terrain hook rides through the probes
    _terraInstSeed = s;
  }
  return _terraInst;
}
const _vnoise = Terra.vnoise, _fbm = Terra.fbm;      // seed-explicit statics (callers pass worldSeed()+k)
function elevationAt(x, z) { return terra().elevationAt(x, z); }
function moistureAt(x, z) { return terra().moistureAt(x, z); }
function tempAt(x, z) { return terra().tempAt(x, z); }
const isWater = (x, z) => {
  if (SRV_ON) { const e = srvElevAt(x, z); if (e !== null) return e < SEA_LEVEL; }
  return terra().isWater(x, z);
};

// ---------- SRV mode: the world arrives as SERVER CHUNK PAYLOADS instead of local generation ----------
// ?srv=1 (sticky; ?srv=0 off) — Phase 1 of server-authoritative worldgen. The ChunkStore holds only
// the viewport ring (+1 prefetch ring); every gameplay query (height/water/biome/rough) prefers a
// stored payload and falls back to the local kernel outside it — provably identical math, so the
// fallback is seamless while roads/capitals/routing migrate in later phases. Nothing is cached to
// disk: evicted chunks are re-fetched from the server's persisted store on return.
const SRV_ON = !!(typeof window !== 'undefined' && window.net && window.net.srvWorld);
const srvChunks = new Map();      // "cx,cz" -> decoded payload {cells, cellIdx, elev, temp, moist, rough, holds}
const _srvInflight = new Set();   // chunk keys currently on the wire
let _srvSeed = -1;                // worldSeed the store was filled for (reroll/region change wipes it)
let _srvKernelWarned = false;
function _srvB64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function _srvDecode(p) {
  const cells = hexCellsInChunk(p.cx, p.cz);           // SAME static enumeration the server sampled in
  const cellIdx = new Map();
  for (let i = 0; i < cells.length; i++) cellIdx.set(hexKey(cells[i][0], cells[i][1]), i);
  const eu = _srvB64(p.elev);
  return { cx: p.cx, cz: p.cz, n: p.n, cells, cellIdx,
    elev: new Uint16Array(eu.buffer, 0, eu.length >> 1),
    temp: _srvB64(p.temp), moist: _srvB64(p.moist), rough: _srvB64(p.rough),
    holds: p.holds || [], roads: p.roads || [] };
}
// batch-fetch missing chunks; the stream rebuilds when they land (fog hides the wait)
function srvRequest(keys) {
  const need = keys.filter(k => !srvChunks.has(k) && !_srvInflight.has(k));
  if (!need.length || !window.net || !window.net.loadChunks) return;
  for (const k of need) _srvInflight.add(k);
  const ws = worldSeed();
  window.net.loadChunks(mapLevel, universeSeed, need.map(k => k.replace(',', ':'))).then(resp => {
    for (const k of need) _srvInflight.delete(k);
    if (!resp || resp.tseed !== ws || ws !== worldSeed()) return;   // a reroll/region change outran this batch
    if (resp.kernel !== Terra.VERSION && !_srvKernelWarned) {
      _srvKernelWarned = true;
      console.error('[srv] kernel version mismatch: server', resp.kernel, 'vs client', Terra.VERSION, '— sync sim/terra.js on both sides');
    }
    for (const p of resp.chunks || []) srvChunks.set(p.cx + ',' + p.cz, _srvDecode(p));
    updateChunks(true);
  }).catch(() => { for (const k of need) _srvInflight.delete(k); });   // retried on the next crossing
}
// ----- the DETAIL tier: server-persisted street-level rows (trees/rocks/groves) per chunk -----
// Generated once on the server (kernel chunkScatter/chunkGroves), saved in chunk_detail, served at
// /chunks/detail. The local kernel produces byte-identical rows, so arrival order never matters —
// the payload's job is persistence (the zoomed-in world is SAVED), not correctness.
const srvDetail = new Map();          // "cx,cz" -> { trees, rocks, groves }
const _srvDetailInflight = new Set();
function srvDetailRequest(keys) {
  const need = keys.filter(k => !srvDetail.has(k) && !_srvDetailInflight.has(k));
  if (!need.length || !window.net || !window.net.loadDetail) return;
  for (const k of need) _srvDetailInflight.add(k);
  const ws = worldSeed();
  window.net.loadDetail(mapLevel, universeSeed, need.map(k => k.replace(',', ':'))).then(resp => {
    for (const k of need) _srvDetailInflight.delete(k);
    if (!resp || resp.tseed !== ws || ws !== worldSeed()) return;
    for (const p of resp.chunks || []) srvDetail.set(p.cx + ',' + p.cz, p);
  }).catch(() => { for (const k of need) _srvDetailInflight.delete(k); });
}
// the payload cell under a world point (cells own the chunk containing their centre)
function _srvCellAt(x, z) {
  const qr = worldToHex(x, z);
  const e = srvChunks.get(Math.floor(hexCenterX(qr[0], qr[1]) / CHUNK) + ',' + Math.floor(hexCenterZ(qr[1]) / CHUNK));
  if (!e) return null;
  const i = e.cellIdx.get(qr[0] + ',' + qr[1]);
  return i === undefined ? null : { e, i, q: qr[0], r: qr[1] };
}
// payload vertex index of ring position m (0..11 around the fan): even = corner, odd = edge midpoint
function _srvRingVert(m) { return (m & 1) ? 7 + ((m - 1) >> 1) : 1 + (m >> 1); }
// the fan triangle under (x,z) + barycentric weights — interpolating over the SAME triangles the
// mesh draws, so gameplay heights match the rendered surface exactly
function _srvFan(x, z) {
  const c = _srvCellAt(x, z); if (!c) return null;
  const dx = x - hexCenterX(c.q, c.r), dz = z - hexCenterZ(c.r);
  let th = Math.atan2(dx, dz); if (th < 0) th += TAU;              // template corners sit at [R·sin, R·cos]
  const m = Math.min(11, Math.floor(th / (TAU / 12)));
  const p1 = Terra.TOP_OFFSETS[_srvRingVert(m)], p2 = Terra.TOP_OFFSETS[_srvRingVert((m + 1) % 12)];
  const det = p1[0] * p2[1] - p2[0] * p1[1];
  if (!det) return null;
  let w1 = (dx * p2[1] - p2[0] * dz) / det, w2 = (p1[0] * dz - dx * p1[1]) / det;
  w1 = clamp(w1, 0, 1); w2 = clamp(w2, 0, 1);
  const base = c.i * 13;
  return { e: c.e, i0: base, i1: base + _srvRingVert(m), i2: base + _srvRingVert((m + 1) % 12), w0: Math.max(0, 1 - w1 - w2), w1, w2 };
}
function srvElevAt(x, z) {
  const f = _srvFan(x, z); if (!f) return null;
  const E = f.e.elev;
  return (E[f.i0] * f.w0 + E[f.i1] * f.w1 + E[f.i2] * f.w2) / 65535;
}
function srvHeightAt(x, z) {   // per-vertex elevToY THEN interpolate — the mesh's exact facet plane
  const f = _srvFan(x, z); if (!f) return null;
  const E = f.e.elev, k = 1 / 65535;
  return Terra.elevToY(E[f.i0] * k) * f.w0 + Terra.elevToY(E[f.i1] * k) * f.w1 + Terra.elevToY(E[f.i2] * k) * f.w2;
}
function srvBiomeAt(x, z) {
  const c = _srvCellAt(x, z); if (!c) return null;
  const o = c.i * 13;                                              // classify at the cell centre
  return Terra.classifyBiome(c.e.elev[o] / 65535, c.e.temp[o] / 255, c.e.moist[o] / 255);
}
function srvRoughAt(x, z) {
  const c = _srvCellAt(x, z);
  return c ? c.e.rough[c.i] / 255 : null;
}

// ---------- Biomes: classified from the fields, with battle backdrops (table lives in the kernel) ----------
const B = Terra.B;
function biomeAt(x, z) {
  if (SRV_ON) { const b = srvBiomeAt(x, z); if (b) return b; }
  return terra().biomeAt(x, z);
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
// The ambient swarm skirmishes far more readily than the macro war: any two realms NOT bound by an
// alliance or a non-aggression pact raid each other's borders. This keeps the overworld alive with
// battles even when the diplomacy has drifted into a tense, all-neutral peace (a long-running world
// erodes its opening wars toward neutral) — while alliances and pacts still stay the blades. The
// authoritative server warlords keep using the strict at-war check (areFactionEnemies); this looser
// rule governs only the flavor swarm and where bands choose to march.
function areAmbientRivals(a, b) {
  const an = factionName(a), bn = factionName(b);
  if (!an || !bn || an === bn) return false;
  const s = stanceLocal(a, b);
  return s !== 'alliance' && s !== 'nonaggression'; // neutral / hostile / war → constant border raids
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
function nearestLand(x, z) { return terra().nearestLand(x, z); } // spiral out from a point until we find dry ground
function placeCapitals() {
  // the five seats are PURE terrain (kernel capitalSeats: themed bearing + seeded wobble + land
  // seating) so the server derives the SAME positions; game.js only attaches defs + live state
  nations = [];
  for (const seat of terra().capitalSeats()) {
    nations.push({ def: NATIONS[seat.idx], owner: NATIONS[seat.idx], x: seat.x, z: seat.z, garrison: garrisonSize(), parleyCd: 0, conquerCd: 0, group: null });
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
// CONTINUOUS biome colour — lives in the kernel (groundColorRGB); this shim wraps the plain
// [r,g,b] result back into the caller's THREE.Color.
const _gcArr = [0, 0, 0];
function groundColorBlended(x, z, out) { const c = terra().groundColorRGB(x, z, _gcArr); return out.setRGB(c[0], c[1], c[2]); }
// Display elevation for the strategic map (elevToY in the kernel): real vertical relief.
const MAP_RELIEF = Terra.MAP_RELIEF;   // overworld vertical exaggeration
// object-editor only: when set, mapElevY yields this sculpted height field instead of the world's,
// so the editor can seat a real settlement on a bespoke landform (e.g. a mountain) using the SAME
// generators the game uses. Inert in the live game — only editApply ever sets it (see OBJECT EDITOR).
let editTerrainFn = null;
function mapElevY(x, z) {
  if (editTerrainFn) return editTerrainFn(x, z);
  if (SRV_ON) { const y = srvHeightAt(x, z); if (y !== null) return y; }
  const t = terra();
  return t.elevToY(t.elevationAt(x, z));
}
// ---------- Infinite world: streaming terrain chunks + a settlement hierarchy ----------
// The strategic map is no longer one bounded sheet. Terrain, scatter, and settlements stream in as
// square chunks around the player and dispose once left behind, so the world extends forever and is
// generated the moment you discover it. Everything a chunk builds is a pure function of
// (chunkX, chunkZ, worldSeed), so a place looks identical each time you return within a region.
const CHUNK = 60;          // world units per chunk side (each holds ~240 hex tiles)
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

// ---------- Discovery overview: shows previously visited areas + other characters at extreme zoom ----------
let discoveryMode = false;              // true = showing discovery overview (extreme zoom-out)
const discoveredChunks = new Set();     // chunk keys ("cx,cz") of visited areas
try {
  const saved = localStorage.getItem('bv-discovered-chunks');
  if (saved) saved.split(',').forEach(k => discoveredChunks.add(k));
} catch (e) { /* private mode */ }

function markChunkDiscovered(cx, cz) {
  const key = `${cx},${cz}`;
  if (!discoveredChunks.has(key)) {
    discoveredChunks.add(key);
    try { localStorage.setItem('bv-discovered-chunks', Array.from(discoveredChunks).join(',')); } catch (e) {}
  }
}

// ---------- Hex lattice: the overworld is a honeycomb, not a pixel grid ----------
// Terrain and the political overlay both live on ONE global hex lattice (pointy-top, odd-r
// offset). A cell is addressed by integer (q, r); its world centre is a pure function of (q, r),
// independent of chunks, so cells tile seamlessly across chunk seams. Each cell belongs to exactly
// the chunk that contains its centre — a clean partition with no gaps and no double-paint.
const HEX_R = Terra.HEX_R;               // hexagon circumradius (centre→corner), world units
const HEX_W = Terra.HEX_W;               // column spacing (centre→centre across a row)  ~4.16
const HEX_H = Terra.HEX_H;               // row spacing (centre→centre between rows)     3.60
const HEX_FLOOR = Terra.HEX_FLOOR;       // hex prisms drop to this y so cliffs never show a gap
const hexKey = Terra.hexKey, hexCenterX = Terra.hexCenterX, hexCenterZ = Terra.hexCenterZ;
const worldToHex = Terra.worldToHex, hexCellsInChunk = Terra.hexCellsInChunk;
// ---------- Terrain tessellation LOD: the RENDERED honeycomb changes density with the zoom rung ----------
// Rung 0 charts the land in big 2x hexes (a quarter the tiles), rung 1 keeps the canonical lattice,
// rung 2 splits the ground into half-size hexes (4x the tiles) whose extra vertices sample the TRUE
// kernel field — real added relief up close. Only the RENDER lattice scales: the logical lattice
// (territory CA, server payloads, every gameplay query) is untouched, and each rendered tile inherits
// its politics from the logical cell under its centre.
const HEX_TIER_SCALE = [2, 1, 0.5];               // hex size multiplier per detail tier
function hexCellsInChunkScaled(cx, cz, s) {       // mirror of Terra.hexCellsInChunk at scale s
  if (s === 1) return hexCellsInChunk(cx, cz);
  const W = HEX_W * s, H = HEX_H * s, out = [];
  const rLo = Math.floor(cz * CHUNK / H) - 1, rHi = Math.ceil((cz + 1) * CHUNK / H) + 1;
  for (let r = rLo; r <= rHi; r++) {
    const zc = r * H; if (Math.floor(zc / CHUNK) !== cz) continue;
    const off = 0.5 * (r & 1);
    const qLo = Math.floor(cx * CHUNK / W - off) - 1, qHi = Math.ceil((cx + 1) * CHUNK / W - off) + 1;
    for (let q = qLo; q <= qHi; q++) {
      const xc = (q + off) * W; if (Math.floor(xc / CHUNK) !== cx) continue;
      out.push([q, r, xc, zc]);
    }
  }
  return out;
}
// the raw kernel height — bypasses the srv facet interpolation so rung 2's extra vertices carry
// genuine between-sample relief (same math that generated the payload; quantisation delta ~0.001u)
function _kernelElevY(x, z) { const t = terra(); return t.elevToY(t.elevationAt(x, z)); }

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
// the settlement layer is the shared kernel's now (sim/world-sim.js): the server generates,
// persists, and contests the SAME holds, so these are thin (worldSeed-binding) wrappers.
function _chunkHash(cx, cz) { return WorldSim.chunkHash(cx, cz, worldSeed()); }

// the campaign gets deadlier the farther you roam: home stays gentle, the frontier is brutal
const FRONTIER_STEP = WorldSim.FRONTIER_STEP;
function frontierLevel(x, z) { return WorldSim.frontierLevel(x, z, mapLevel); }

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

// Land seating (landScore/bestLandSpot/citySeatScore/cityLandCenter) lives in the kernel —
// cities, capitals and the player start are seated by the SAME code on client and server.
function landScore(x, z, footR) { return terra().landScore(x, z, footR); }
function bestLandSpot(x0, z0, footR, searchR) { return terra().bestLandSpot(x0, z0, footR, searchR); }
// ============ THE v4 PIPELINE: terrain → arteries → settlements ON the arteries ============
// The whole pipeline (block cities, founder's-ground reseating, wayside snapping) lives in the
// Terra kernel now, so the server seats settlements EXACTLY where the client draws them.
function settlementSites(cx, cz) { return terra().settlementSites(cx, cz); }
function siteKey(s) { return WorldSim.siteKey(s); }
function settlementName(s) { return WorldSim.settlementName(s, worldSeed()); }
// the kernel's heartland Voronoi runs over this region's capital positions; it returns the nearest
// capital's FOUNDING-nation name, which we map to that nation's CURRENT owner object (conquests show).
function settlementOwner(s) {
  const owner = WorldSim.settlementOwner(s, worldSeed(),
    nations.map(n => ({ name: n.def.name, x: n.x, z: n.z })),
    nm => { const n = nations.find(c => c.def.name === nm); return n ? n.owner.name : nm; });
  return factionByName(owner) || FREE;
}
function settlementGarrison(s) { return WorldSim.settlementGarrison(s, worldSeed(), mapLevel); }
function makeSettlementHold(s, srv) {
  const key = siteKey(s);
  const restored = heldOwners.get(key);
  const owner = (restored && factionByName(restored)) || (srv && factionByName(srv.owner)) || (srv ? FREE : settlementOwner(s));
  const hold = { def: { name: srv ? srv.name : settlementName(s) }, owner, x: s.x, z: s.z, tier: s.tier,
    garrison: srv ? srv.garrison : settlementGarrison(s), parleyCd: 0, conquerCd: 0, group: null, site: s, key };
  hold.group = makeSettlement(hold);
  return hold;
}

// ---------- Per-chunk decoration: trees + rocks, deterministic from the chunk seed ----------
// PLACEMENT lives in the Terra kernel now (chunkScatter/chunkGroves) so the server generates and
// persists the exact same detail (chunk_detail rows, served at /chunks/detail). This builder only
// turns rows into instanced meshes — road-bed clearing and the per-tier look (rung 0: nothing,
// rung 1: today's pictograms, rung 2: mature stands + boulders) are render-time choices.
const SCATTER_DENSITY = Terra.SCATTER_DENSITY;    // kernel-owned; kept as the client-side alias
function _scatterRows(cx, cz) {
  if (SRV_ON) { const d = srvDetail.get(cx + ',' + cz); if (d) return d; } // server-persisted street rows
  return terra().chunkScatter(cx, cz);            // byte-identical fallback — parity by construction
}
// Settlement grounds clear the scatter: fields, gate aprons and mustering grounds ring every hold,
// so a town that reads clear on the map IS clear when you drop into action (no phantom thickets at
// the gate). A render-time filter — the kernel/server rows stay placement-pure and never go stale.
// Radii cover the STREET-tier footprint (the larger), so map and action agree.
function _holdClearZones(cx, cz) {
  const zones = [], T = terra(), ccx = (cx + 0.5) * CHUNK, ccz = (cz + 0.5) * CHUNK;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const s of T.settlementSites(cx + dx, cz + dz)) {           // kernel-memoized — cheap
      const spec = SG_SPEC[s.tier] || SG_SPEC.village;
      const R = spec.wall ? Math.max(spec.R * 0.5, spec.R + (spec.wall === 'stone' ? 2.6 : 1.5) / 0.8) + 4
                          : spec.R * 1.6 + 3;                        // village: the street-tier croft spread
      zones.push([s.x, s.z, R * R]);
    }
  }
  for (const n of nations) {                                         // capitals: the widest clearing of all
    const R = SG_SPEC.capital.R + 2.6 / 0.8 + 5;
    if (Math.abs(n.x - ccx) < CHUNK * 2 + R && Math.abs(n.z - ccz) < CHUNK * 2 + R) zones.push([n.x, n.z, R * R]);
  }
  return zones;
}
// merge a few small non-indexed geometries into one (the street tree templates; no vendor utils needed)
function _mergedGeo(parts) {
  let n = 0; for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3); let o = 0;
  for (const p of parts) { pos.set(p.attributes.position.array, o); o += p.attributes.position.count * 3; p.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
// Street-level trees are MODELS, not map pictograms: a tapered six-sided bole under either a
// three-tier fir canopy (forest/taiga/tundra/mountain greens) or a two-lobe broadleaf crown.
const _CONIFER_COLS = new Set([0x2f6a30, 0x356a52, 0x6f8a7a, 0x5a6a55]); // the biome tree greens that read as needle trees
function _streetTrunkGeo() { return cachedGeo('streetTrunk', () => new THREE.CylinderGeometry(0.32, 0.5, 1, 6)); }
function _streetFirGeo() {
  return cachedGeo('streetFir', () => _mergedGeo([0, 1, 2].map(k => {
    const c = new THREE.ConeGeometry(2.5 - k * 0.62, 2.1, 7).toNonIndexed();
    c.translate(0, k * 1.25 + 1.05, 0);
    return c;
  })));
}
function _streetCrownGeo() {
  return cachedGeo('streetCrown', () => {
    const a = new THREE.IcosahedronGeometry(1.9, 1).toNonIndexed(); a.scale(1, 0.78, 1); a.translate(0, 1.5, 0);
    const b = new THREE.IcosahedronGeometry(1.15, 1).toNonIndexed(); b.scale(1, 0.7, 1); b.translate(0.95, 2.6, 0.35);
    return _mergedGeo([a, b]);
  });
}
// deterministic per-tree shade jitter so a stand reads as individuals, not clones
function _treeShade(x, z) { return 0.82 + ((Math.imul((Math.round(x * 10) ^ Math.round(z * 10)) | 0, 2654435761) >>> 24) / 255) * 0.36; }
function buildScatter(group, cx, cz) {
  const tier = detailTier();
  if (tier === 0) return [];                       // the overview is a chart, not a diorama
  const rows = _scatterRows(cx, cz), street = scatterStreetFor(cx, cz); // model trees near the bubble only
  const tMul = street ? STREET.treeScale : 1, rMul = street ? STREET.rockScale : 1;
  const zones = _holdClearZones(cx, cz);
  const keep = (t) => roadFactorAt(t[0], t[1]) <= 0.28 &&              // the roadbed stays clear...
    zones.every(zn => (t[0] - zn[0]) ** 2 + (t[1] - zn[1]) ** 2 > zn[2]); // ...and so do settlement grounds
  let trees = rows.trees.filter(keep);
  const rocks = rows.rocks.filter(keep);
  if (street) {                                    // every map tree becomes a 3-5 tree stand at street level
    const gs = (rows.groves || terra().chunkGroves(cx, cz, rows)).filter(keep);
    trees = trees.concat(gs);
  }
  const made = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  const emitTrees = (list, trunkGeo, canopyGeo, canopyAt) => {
    if (!list.length) return;
    const trunks = new THREE.InstancedMesh(trunkGeo, mat(0x6b4a2e), list.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, mat(0xffffff), list.length);
    list.forEach(([x, z, c, sc0, th0, rot], i) => {
      const sc = sc0 * tMul, th = th0 * tMul, gy = mapElevY(x, z);
      q.setFromEuler(e.set(0, rot, 0));
      m4.compose(v.set(x, gy + th / 2, z), q, s.set(sc, th, sc)); trunks.setMatrixAt(i, m4);
      m4.compose(v.set(x, gy + canopyAt(th, sc), z), q, s.set(sc, sc, sc)); canopies.setMatrixAt(i, m4);
      col.setHex(c); if (street) col.multiplyScalar(_treeShade(x, z));
      canopies.setColorAt(i, col);
    });
    trunks.castShadow = canopies.castShadow = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    group.add(trunks); group.add(canopies); made.push(trunks, canopies);
  };
  if (street) {                                    // real trees: firs on the cold/forest greens, broadleaf crowns elsewhere
    emitTrees(trees.filter(t => _CONIFER_COLS.has(t[2])), _streetTrunkGeo(), _streetFirGeo(), (th) => th);
    emitTrees(trees.filter(t => !_CONIFER_COLS.has(t[2])), _streetTrunkGeo(), _streetCrownGeo(), (th) => th * 0.85);
  } else {                                         // the strategic map keeps its pictogram
    emitTrees(trees, cachedGeo('mapTrunk', () => new THREE.BoxGeometry(0.5, 1, 0.5)),
      cachedGeo('mapCone', () => new THREE.ConeGeometry(1.5, 3.2, 6)), (th, sc) => th + 1.2 * sc);
  }
  if (rocks.length) {
    const rm = new THREE.InstancedMesh(cachedGeo('mapRock', () => new THREE.IcosahedronGeometry(1, 0)), mat(0x8d8f95), rocks.length);
    rocks.forEach(([x, z, r0, e1, e2, e3, sq], i) => {
      const r = r0 * rMul;
      q.setFromEuler(e.set(e1, e2, e3));
      m4.compose(v.set(x, mapElevY(x, z) + r * 0.5, z), q, s.set(r, r * sq, r)); rm.setMatrixAt(i, m4);
    });
    rm.castShadow = rm.receiveShadow = true;
    group.add(rm); made.push(rm);
  }
  return made;
}

// ---------- Detail tiers: the three zoom rungs render DIFFERENT levels of the same world ----------
// Google-Earth rule. Rung 0 (overview) is a CHART: settlement icons (border ring + seat marker +
// name), roads, no scatter. Rung 1 (strategic map) is today's miniature. Rung 2 (action) is STREET
// LEVEL: settlements rebuilt at human proportion (huge walls/keeps/houses on the SAME ring, gates
// and streets — roads still meet the walls exactly), tree stands, wider-painted roadbeds. One
// world, three renderings, all deterministic from the same seeds; the server persists the street
// rows per chunk (chunk_detail) so the zoomed-in world is saved, not improvised.
// Everything a ground-level eye can actually SEE in action mode — the one source of truth for the
// fog (applyVista's fieldSimOn() branch) and the clip plane (applyDetailTier). STREET derives its
// rebuild radius from this so the two can never drift apart again.
const ACTION_VIEW = { fogNear: 55, fogFar: 135, camFar: 170 };
const STREET = {
  // mulH alone (3.0 on a narrow ~1.2u-wide base footprint) drew tall, thin "shoebox" houses —
  // taller than wide is backwards for a cottage. mulW now tracks mulH so footprints read as
  // actual buildings, not fence posts. gapMul is its OWN (larger) number, not derived from mulW:
  // the placement gap is a walking-space budget, not a building-size budget, and the old code
  // conflated the two (gap: spec.gap*mulW) — spacing houses only as far apart as they were wide
  // is exactly what reads as "everything jammed together" once the buildings themselves grew.
  mulH: 3.0,        // building HEIGHT multiplier at street level — height is what sells hugeness
  mulW: 2.8,         // building FOOTPRINT/thickness multiplier — was 2.2, gave squat/narrow houses
  gapMul: 3.8,       // minimum house-to-house spacing multiplier — real breathing room, not a shoulder-width alley
  countMul: 0.34,   // fewer houses — each is ~2.8x wider, so the same districts stay full
  treeScale: 1.45,  // street trees are mature trees, not map pictograms
  rockScale: 1.5,   // boulders, not pebbles
  roadWMul: 2.1,    // painted roadbed width at street level (paint-only; routing/ETA untouched)
  // MUST cover the whole visible range (out to camFar), not just a bubble around the hero: a
  // settlement you can plainly see but that's still at old map-miniature scale reads as a small
  // toy sitting close by, not a huge structure standing far off — a real size/perspective mismatch,
  // not just an LOD seam. Every settlement in view is street scale; only what's clipped isn't.
  buildR: ACTION_VIEW.camFar - 10,   // holds within this of the hero rebuild at street scale...
  dropR: ACTION_VIEW.camFar + 20,    // ...and fold back to the miniature once truly out of view (hysteresis)
};
function detailTier() { return mode === 'map' ? (mapFieldMode ? 2 : discoveryMode ? 0 : 1) : 1; }
let _appliedTier = 1;              // the tier the loaded world currently RENDERS (vs detailTier() = wanted)

// ----- Rung 0 icons: a hold becomes its REAL wall ring + an owner-colored seat marker + its name -----
const _holdIcons = new Set();      // every live icon group, for wholesale teardown on region change
function buildHoldIcon(x, z, tier, name, ownerColor, ring) {
  const spec = SG_SPEC[tier] || SG_SPEC.village;
  const S = { pos: [], col: [] };
  const own = sgRgb(ownerColor, 1), ownDim = sgRgb(ownerColor, 0.55);
  const y0 = mapElevY(x, z);
  const seatY = (lx, lz) => mapElevY(x + lx, z + lz) - y0;
  if (spec.wall && ring && ring.length > 2) {      // the hold's ACTUAL wall polygon, readable from orbit
    const N = ring.length;                         // (server-persisted or kernel-identical — never a circle)
    for (let k = 0; k < N; k++) {
      const A = ring[k], B = ring[(k + 1) % N];
      const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
      if (isWater(x + mx, z + mz)) continue;
      const ang = Math.atan2(-(B[1] - A[1]), B[0] - A[0]), len = Math.hypot(B[0] - A[0], B[1] - A[1]) + 0.3;
      sgBox(S, mx, seatY(mx, mz) + 0.5, mz, len, 1.0, 0.7, ang, ownDim);
    }
  }
  const big = tier === 'city' || tier === 'capital';   // the seat: a bold pylon the rung-0 eye can read
  const ph = big ? 7 : tier === 'town' ? 4.5 : 2.2, pr = big ? 2.6 : tier === 'town' ? 1.8 : 1.1;
  sgPrism(S, 0, 0, 0, pr, ph, own);
  sgCone8(S, 0, ph, 0, pr * 1.25, pr, own);
  const g = new THREE.Group();
  g.add(sgMesh(S, settleVCMat()));
  if (tier !== 'village') {                        // villages stay "just an indicator" — a dot, no name
    const label = makeNameSprite(name);
    const ls = (spec.lbl || 4) * 1.5;
    label.scale.set(ls, ls / 8, 1); label.position.y = ph + 3; g.add(label);
  }
  g.position.set(x, y0, z);
  return g;
}
function _iconFor(entry) {                         // entry: a streamed hold OR a nation capital
  if (entry.iconGroup) return entry.iconGroup;
  const g = buildHoldIcon(entry.x, entry.z, entry.tier || 'capital', entry.def.name, entry.owner.color, holdWallRingFor(entry));
  entry.iconGroup = g; _holdIcons.add(g); mapTerrain.add(g);
  return g;
}
// the wall polygon an icon traces: the server payload's persisted ring when it shipped one,
// else the kernel's identical math (same probe + same site seed → the same ring) — so the
// rung-0 border matches the walls the closer rungs actually build, palisade kink for kink.
function holdWallRingFor(entry) {
  const spec = SG_SPEC[entry.tier || 'capital'];
  if (!spec || !spec.wall) return null;
  const srvRing = entry.site && entry.site.ring;
  if (srvRing && srvRing.length > 2) return srvRing;
  return terra().wallRingPts(entry.x, entry.z, entry.tier || 'capital', _streetSeedFor(entry));
}
function _dropIcon(entry) {
  if (!entry.iconGroup) return;
  mapTerrain.remove(entry.iconGroup); disposeGroup(entry.iconGroup);
  _holdIcons.delete(entry.iconGroup); entry.iconGroup = null;
}

// ----- Rung 2 streets: the same seed rebuilt at human proportion, swapped in near the hero -----
function _streetSeedFor(entry) {
  const s = entry.site;
  if (!s) return (Math.imul(Math.round(entry.x) | 0, 73856093) ^ Math.imul(Math.round(entry.z) | 0, 19349663) ^ (worldSeed() >>> 0)) >>> 0; // capital — makeCapital's formula
  return (_chunkHash(s.cx, s.cz) ^ (Math.imul(s.idx + 3, 0x9E3779B1) >>> 0)) >>> 0;    // makeSettlement's formula
}
function _buildStreet(entry) {
  const tier = entry.tier || 'capital';
  const opts = { detail: 'street' };
  if (tier === 'village' && entry.site) opts.roadAxis = villageRoadAxis(entry.site);
  const g = buildSettlementGroup(entry.x, entry.z, tier, entry.def.name, entry.owner.color, _streetSeedFor(entry), opts);
  entry.streetGroup = g; mapTerrain.add(g);
  if (entry.group) entry.group.visible = false;    // the miniature yields to the real place
}
function _dropStreet(entry) {
  if (!entry.streetGroup) return;
  mapTerrain.remove(entry.streetGroup); disposeGroup(entry.streetGroup);
  entry.streetGroup = null;
  if (entry.group) entry.group.visible = _appliedTier !== 0;
}
function _allHoldEntries() { return settlements.concat(nations); }
// budgeted: ONE street rebuild per frame, nearest first — walking into a city never hitches
function updateStreetHolds() {
  if (_appliedTier !== 2) return;
  const px = player.pos.x, pz = player.pos.z;
  let best = null, bd = Infinity;
  for (const entry of _allHoldEntries()) {
    const d = Math.hypot(entry.x - px, entry.z - pz);
    if (entry.streetGroup && d > STREET.dropR) _dropStreet(entry);
    else if (!entry.streetGroup && d <= STREET.buildR && d < bd) { bd = d; best = entry; }
  }
  if (best) _buildStreet(best);
}

// ---------- The DETAIL BUBBLE: full detail where you stand, the map's own look everywhere else ----------
// Each chunk renders as TERR_SUB x TERR_SUB independent terrain tiles (30u squares), so detail can
// follow the HERO, not the chunk grid: tiles inside DETAIL_R (~a football field across) carry the
// half-size honeycomb (zoom² more hexagons), everything beyond keeps the strategic map's canonical
// tiles. Walking re-tessellates only the few tiles crossing the bubble's rim — budgeted, nearest
// first — so low-end devices pay for one field of detail, never a whole ring of chunks.
const TERR_SUB = 2;                                 // terrain tiles per chunk side (2 → 4 tiles of 30u)
const DETAIL_R = 55;                                // action-rung detail bubble radius around the hero
const _terrRetessQ = [];                            // "cx,cz|ti" tile keys awaiting re-tessellation
let _bubX = 1e9, _bubZ = 1e9;                       // where the bubble was last reconciled
function _rectDist2(x0, z0, w, px, pz) {            // point → axis-aligned square distance²
  const dx = Math.max(x0 - px, 0, px - (x0 + w)), dz = Math.max(z0 - pz, 0, pz - (z0 + w));
  return dx * dx + dz * dz;
}
function tileTierFor(cx, cz, tx, tz) {
  if (_appliedTier !== 2) return _appliedTier;      // rungs 0/1 tessellate uniformly (chart / map)
  const ts = CHUNK / TERR_SUB;
  return _rectDist2(cx * CHUNK + tx * ts, cz * CHUNK + tz * ts, ts, player.pos.x, player.pos.z)
    <= DETAIL_R * DETAIL_R ? 2 : 1;
}
// street-model trees + groves only near the bubble; beyond it the map's pictograms stand in
function scatterStreetFor(cx, cz) {
  if (_appliedTier !== 2) return false;
  return _rectDist2(cx * CHUNK, cz * CHUNK, CHUNK, player.pos.x, player.pos.z) <= (DETAIL_R + 25) ** 2;
}
function rebuildTerrainTile(qkey) {
  const bar = qkey.indexOf('|'), key = qkey.slice(0, bar), ti = +qkey.slice(bar + 1);
  const rec = mapChunks.get(key); if (!rec || !rec.tiles || !rec.tiles[ti]) return;
  const ci = key.indexOf(','), cx = +key.slice(0, ci), cz = +key.slice(ci + 1);
  const tile = rec.tiles[ti], tier = tileTierFor(cx, cz, tile.tx, tile.tz);
  if (tile.tier === tier) return;
  rec.group.remove(tile.mesh); tile.mesh.geometry.dispose();
  const srvE = SRV_ON ? srvChunks.get(key) : null;  // evicted payload → the kernel path (identical math)
  rec.tiles[ti] = buildTerrainTile(rec.group, cx, cz, tile.tx, tile.tz, srvE, tier);
  paintTerrTile(rec.tiles[ti]);                     // re-drape the politics over the fresh vertices
}
function processTerrainQueue(budget) {
  let done = 0;
  while (_terrRetessQ.length && done < budget) { rebuildTerrainTile(_terrRetessQ.shift()); done++; }
}
// re-list every tile whose tessellation disagrees with the bubble, nearest first; also swap any
// chunk's scatter set (street stands ↔ pictograms) that the bubble has crossed. Called on rung
// change and every ~10u of hero movement — the bubble genuinely WALKS with you.
function refreshDetailBubble() {
  if (!mapTerrain) return;
  _bubX = player.pos.x; _bubZ = player.pos.z;
  _terrRetessQ.length = 0;
  const ts = CHUNK / TERR_SUB;
  for (const [key, rec] of mapChunks) {
    const ci = key.indexOf(','), kx = +key.slice(0, ci), kz = +key.slice(ci + 1);
    if (rec.tiles) for (let ti = 0; ti < rec.tiles.length; ti++) {
      const t = rec.tiles[ti];
      if (t.tier !== tileTierFor(kx, kz, t.tx, t.tz)) _terrRetessQ.push(key + '|' + ti);
    }
    const street = scatterStreetFor(kx, kz);        // scatter swaps whole-chunk (instances are cheap)
    if (rec.scTier !== _appliedTier || rec.scStreet !== street) {
      for (const m of rec.sc || []) { rec.group.remove(m); if (m.dispose) m.dispose(); }
      rec.sc = buildScatter(rec.group, kx, kz); rec.scTier = _appliedTier; rec.scStreet = street;
    }
  }
  _terrRetessQ.sort((a, b) => {
    const pa = a.indexOf('|'), pb = b.indexOf('|');
    const ka = a.slice(0, pa), kb = b.slice(0, pb);
    const ca = ka.indexOf(','), cb = kb.indexOf(',');
    const ta = +a.slice(pa + 1), tb = +b.slice(pb + 1);
    const da = _rectDist2(+ka.slice(0, ca) * CHUNK + (ta % TERR_SUB) * ts, +ka.slice(ca + 1) * CHUNK + ((ta / TERR_SUB) | 0) * ts, ts, _bubX, _bubZ);
    const db = _rectDist2(+kb.slice(0, cb) * CHUNK + (tb % TERR_SUB) * ts, +kb.slice(cb + 1) * CHUNK + ((tb / TERR_SUB) | 0) * ts, ts, _bubX, _bubZ);
    return da - db;
  });
}

// reconcile every loaded chunk + hold to the current rung's representation (idempotent; cheap when equal)
function applyDetailTier(force) {
  const tier = detailTier();
  if (!force && tier === _appliedTier) return;
  _appliedTier = tier;
  if (!mapTerrain) return;
  // reconcile scatter + queue the honeycomb re-tessellation nearest-first (2x hexes at rung 0,
  // 1x at 1, the detail bubble at 2); the ground underfoot rebuilds this frame, the rest streams in
  refreshDetailBubble();
  processTerrainQueue(tier === 2 ? 2 : 6);         // fine tiles are big builds; chart/map tiles are cheap
  for (const entry of _allHoldEntries()) {         // settlements: icon / miniature / street (lazy)
    if (tier === 0) { _iconFor(entry); if (entry.group) entry.group.visible = false; }
    else {
      _dropIcon(entry);
      if (tier !== 2) _dropStreet(entry);
      if (entry.group) entry.group.visible = !entry.streetGroup;
    }
  }
  // the border sheet + pins read at chart/map rungs, stand down at street level
  for (const rec of mapChunks.values()) if (rec.terrOverlay) rec.terrOverlay.mesh.visible = tier !== 2;
  applyPinTier(tier);
  // rung 0 pushes fog to 1500 (applyVista) — lift the clip plane with it or discovered land vanishes
  // early; rung 2 is the opposite: the clip plane comes IN to the action fog line, so the far world
  // costs nothing (frustum-culled) instead of being drawn into haze
  camera.far = tier === 0 ? 1600 : tier === 2 ? ACTION_VIEW.camFar : Math.max(300, ARENA * 4);
  camera.updateProjectionMatrix();
  if (_roadPaintedTier !== (tier === 2 ? 2 : 1)) ensureRoads(true);  // repaint the roadbeds at this rung's width
}

// ---------- Hex-prism relief: a real per-chunk mesh so each tile has surface detail ----------
// NOT instanced — an InstancedMesh can only fly ONE colour per tile, which read as flat blocks.
// Instead each chunk is a single merged BufferGeometry of hex prisms whose every vertex is coloured
// by sampling the terrain AT THAT VERTEX'S world position (`tileColorAt`). So a tile top shows a
// gradient and — because neighbouring tiles share corner/edge-midpoint XZ and the sampler is
// position-deterministic — biomes BLEND across tile + chunk seams instead of butting hard.
// The template is a custom pointy-top prism with a SUBDIVIDED top (centre + 6 corners + 6 edge
// midpoints → a 12-spoke fan) for finer surface detail; the edge midpoints sit ON each shared edge so
// transitions stay seamless along edges too. No bottom cap (never seen).
// Tops are NOT flat: every top vertex rides mapElevY at ITS OWN world XZ, so tiles contour to the
// terrain (no plateau staircase on slopes). Because mapElevY is a pure function of position and
// neighbours share corner/edge-mid XZ, every shared boundary point gets the same height → seamless
// slopes across tile + chunk seams. The bottom ring drops flat to HEX_FLOOR for the skirt walls.
function _hexTemplate() {
  return cachedGeo('hexTemplateSub', () => {
    const R = HEX_R, top = 0.5, bot = -0.5, pos = [], idx = [], cor = [];
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; cor.push([R * Math.sin(a), R * Math.cos(a)]); }
    pos.push(0, top, 0);                                                            // 0: centre
    for (let k = 0; k < 6; k++) pos.push(cor[k][0], top, cor[k][1]);                // 1..6: top corners
    for (let k = 0; k < 6; k++) { const a = cor[k], b = cor[(k + 1) % 6]; pos.push((a[0] + b[0]) / 2, top, (a[1] + b[1]) / 2); } // 7..12: edge midpoints
    for (let k = 0; k < 6; k++) pos.push(cor[k][0], bot, cor[k][1]);                // 13..18: bottom corners
    const ring = []; for (let k = 0; k < 6; k++) { ring.push(1 + k); ring.push(7 + k); } // CCW boundary: c0,e0,c1,e1,...
    for (let j = 0; j < 12; j++) idx.push(0, ring[j], ring[(j + 1) % 12]);          // top fan (normals up)
    for (let k = 0; k < 6; k++) { const ct = 1 + k, ct1 = 1 + (k + 1) % 6, cb = 13 + k, cb1 = 13 + (k + 1) % 6; idx.push(ct, cb, ct1, ct1, cb, cb1); } // sides (outward)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    return g;
  });
}
// realistic ground colour at a point: continuous biome blend + relief + snow/coast, then a
// position-deterministic value-noise jitter so even one biome reads as weathered, varied ground.
function tileColorAt(x, z, out) {
  groundColorBlended(x, z, out);
  const jit = 0.86 + _vnoise(x * 0.23, z * 0.23, worldSeed() + 99) * 0.22 + _vnoise(x * 0.6, z * 0.6, worldSeed() + 131) * 0.08;
  return out.multiplyScalar(jit);
}
// one terrain TILE (a TERR_SUBth of a chunk) at a given tessellation tier. Tiles are independent
// meshes, so the detail bubble refines/degrades 30u squares as the hero walks — never whole chunks.
function buildTerrainTile(group, cx, cz, tx, tz, srvE, tier) {
  if (tier == null) tier = 1;
  const s = HEX_TIER_SCALE[tier] || 1;
  // rung 1 renders the logical cells (srv payload verts ARE its lattice); rungs 0/2 render a
  // scaled honeycomb — each rendered tile still inherits politics from the logical cell under it
  const all = s === 1 ? hexCellsInChunk(cx, cz) : hexCellsInChunkScaled(cx, cz, s);
  const ts = CHUNK / TERR_SUB, clampT = (v) => Math.min(TERR_SUB - 1, Math.max(0, v | 0));
  const rCells = all.filter(c => clampT((c[2] - cx * CHUNK) / ts) === tx && clampT((c[3] - cz * CHUNK) / ts) === tz);
  const tmpl = _hexTemplate(), tPos = tmpl.attributes.position.array, tIdx = tmpl.index.array;
  const tvc = tmpl.attributes.position.count, tic = tIdx.length, N = rCells.length;
  const positions = new Float32Array(N * tvc * 3), colors = new Float32Array(N * tvc * 3);
  const base = new Float32Array(N * tvc * 3), indices = new Uint32Array(N * tic);
  const topIdx = []; for (let v = 0; v < tvc; v++) if (tPos[v * 3 + 1] > 0.49) topIdx.push(v); // top-face verts carry politics
  const items = new Array(N);
  const ws = worldSeed(), _c3 = [0, 0, 0];             // srv path: payload fields + client-side cosmetic jitter
  const srvOk = !!srvE && s === 1;                     // only the canonical lattice maps 1:1 onto payload samples
  for (let i = 0; i < N; i++) {
    const q = rCells[i][0], r = rCells[i][1], xc = rCells[i][2], zc = rCells[i][3];
    const vb = i * tvc;
    const pvBase = srvOk ? srvE.cellIdx.get(hexKey(q, r)) : undefined;  // payload cell index (tiles are subsets)
    for (let v = 0; v < tvc; v++) {
      const ty = tPos[v * 3 + 1], px = tPos[v * 3] * s + xc, pz = tPos[v * 3 + 2] * s + zc;
      let py;
      const o = (vb + v) * 3;
      if (pvBase !== undefined) {
        // template verts 0..12 ARE the payload's TOP_OFFSETS order; a bottom vert 13+k shares its
        // column (and so its field sample) with top corner 1+k
        const pv = pvBase * 13 + (v < 13 ? v : 1 + (v - 13));
        const e = srvE.elev[pv] / 65535;
        py = (ty > 0.49) ? Terra.elevToY(e) : HEX_FLOOR;
        Terra.groundColorFromFields(e, srvE.temp[pv] / 255, srvE.moist[pv] / 255, _c3);
        const jit = 0.86 + _vnoise(px * 0.23, pz * 0.23, ws + 99) * 0.22 + _vnoise(px * 0.6, pz * 0.6, ws + 131) * 0.08;
        _terrCol.setRGB(_c3[0] * jit, _c3[1] * jit, _c3[2] * jit);
      } else {
        // rung 2's half-size tiles sample the raw kernel — genuine relief BETWEEN the payload
        // samples; rung 0's big tiles ride mapElevY (payload facets where stored, kernel beyond)
        py = (ty > 0.49) ? (s < 1 ? _kernelElevY(px, pz) : mapElevY(px, pz)) : HEX_FLOOR;
        tileColorAt(px, pz, _terrCol);
      }
      positions[o] = px; positions[o + 1] = py; positions[o + 2] = pz;
      const shade = 0.7 + (ty + 0.5) * 0.3;             // top face bright, cliff base dim — a soft vertical gradient
      base[o] = colors[o] = _terrCol.r * shade;
      base[o + 1] = colors[o + 1] = _terrCol.g * shade;
      base[o + 2] = colors[o + 2] = _terrCol.b * shade;
    }
    for (let k = 0; k < tic; k++) indices[i * tic + k] = vb + tIdx[k];
    if (s === 1) items[i] = { cell: terrCells.get(hexKey(q, r)), vb };
    else { const pq = worldToHex(xc, zc); items[i] = { cell: terrCells.get(hexKey(pq[0], pq[1])), vb }; } // politics from the logical parent cell
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, terraMat());
  mesh.receiveShadow = true; mesh.castShadow = false;
  group.add(mesh);
  return { tx, tz, tier, colorAttr: geo.attributes.color, base, items, tvc, topIdx, mesh };
}
// a chunk's full tile set at the current rung (each tile gets its own distance-aware tier)
function buildChunkTerrain(group, cx, cz, srvE) {
  const tiles = [];
  for (let tz = 0; tz < TERR_SUB; tz++) for (let tx = 0; tx < TERR_SUB; tx++)
    tiles.push(buildTerrainTile(group, cx, cz, tx, tz, srvE, tileTierFor(cx, cz, tx, tz)));
  return tiles;
}

// ---------- Chunk streaming ----------
function buildChunk(cx, cz) {
  const key = cx + ',' + cz;
  if (mapChunks.has(key)) return;
  const srvE = SRV_ON ? srvChunks.get(key) : null;
  if (SRV_ON && !srvE) return;                       // payload not yet arrived — the fog holds this ground
  const group = new THREE.Group();
  const cells = hexCellsInChunk(cx, cz);            // the honeycomb tiles whose centres live in this chunk
  initTerritoryCells(cells);                         // seed this chunk's territory cells first (gen-0 = the political map)
  applySrvTerritory(key);                            // …then anchor them to the server's stored field if it already streamed
  const tiles = buildChunkTerrain(group, cx, cz, srvE);  // hex-prism relief, tiled for the detail bubble
  const sc = buildScatter(group, cx, cz);
  const terrOverlay = buildTerrOverlay(group, cx, cz);   // the border heat-map sheet over this chunk
  // settlements discovered in this chunk — srv mode renders the SERVER's holds (reseated + live owners)
  const holds = [];
  if (srvE) {
    for (const h of srvE.holds) {
      const s = { x: h.x, z: h.z, tier: h.tier, idx: h.idx, cx, cz };
      if (h.roadAx != null) s.roadAx = h.roadAx;
      if (h.ring) s.ring = h.ring;                 // the server-persisted wall ring (icon layer traces it)
      const hold = makeSettlementHold(s, h);
      group.add(hold.group);
      holds.push(hold); settlements.push(hold);
    }
  } else {
    for (const s of settlementSites(cx, cz)) {
      // capitals are now ~95u across, so hold sites must clear them by far more than the old 18u
      if (isWater(s.x, s.z) || nearCapital(s.x, s.z, s.tier === 'city' ? 100 : 58)) continue;
      const hold = makeSettlementHold(s);
      group.add(hold.group);
      holds.push(hold); settlements.push(hold);
    }
  }
  mapTerrain.add(group);
  mapChunks.set(key, { group, holds, tiles, sc, terrOverlay, scTier: detailTier(), scStreet: scatterStreetFor(cx, cz) });
  if (_appliedTier === 0) for (const h of holds) { _iconFor(h); if (h.group) h.group.visible = false; } // a chunk born at rung 0 shows icons
  markChunkDiscovered(cx, cz);  // track this area as visited
  paintChunkTerritory(mapChunks.get(key));           // show it immediately, before the first generation
}
function disposeChunk(key) {
  const c = mapChunks.get(key); if (!c) return;
  mapTerrain.remove(c.group); disposeGroup(c.group); // disposeGroup frees the overlay material + its texture too
  for (const h of c.holds) { _dropStreet(h); _dropIcon(h); const i = settlements.indexOf(h); if (i >= 0) settlements.splice(i, 1); } // street/icon layers live under mapTerrain, not the chunk group
  const ci = key.indexOf(','), kx = +key.slice(0, ci), kz = +key.slice(ci + 1); // drop this chunk's cells (bound the Map)
  for (const [q, r] of hexCellsInChunk(kx, kz)) terrCells.delete(hexKey(q, r));
  srvTerr.delete(key);                               // the stored field re-streams on return
  mapChunks.delete(key);
}
function clearChunks() { for (const key of Array.from(mapChunks.keys())) disposeChunk(key); }
function updateChunks(force) {
  if (!mapTerrain) return;
  const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK), pk = pcx + ',' + pcz;
  if (!force && pk === _lastPlayerChunk && !discoveryMode) return;   // only re-stream when the player crosses a chunk line (disabled in discovery mode)
  _lastPlayerChunk = pk;
  if (discoveryMode) {
    // in discovery mode, only show already-discovered chunks (no new terrain generation)
    for (const key of Array.from(mapChunks.keys())) {
      const c = key.indexOf(','), kx = +key.slice(0, c), kz = +key.slice(c + 1);
      // keep discovered chunks even if far away; dispose undiscovered ones to save memory
      if (!discoveredChunks.has(key)) disposeChunk(key);
    }
  } else {
    if (SRV_ON) {
      const ws = worldSeed();
      if (ws !== _srvSeed) { srvChunks.clear(); _srvInflight.clear(); srvDetail.clear(); _srvDetailInflight.clear(); _srvSeed = ws; }  // reroll/region → fresh store
      const want = [];                             // mesh ring + one prefetch ring so riding never waits
      for (let dx = -VIEW - 1; dx <= VIEW + 1; dx++) for (let dz = -VIEW - 1; dz <= VIEW + 1; dz++) want.push((pcx + dx) + ',' + (pcz + dz));
      srvRequest(want);
      if (_appliedTier === 2) {                    // street level: pull the saved detail rows for the mesh ring
        const wantD = [];
        for (let dx = -VIEW; dx <= VIEW; dx++) for (let dz = -VIEW; dz <= VIEW; dz++) wantD.push((pcx + dx) + ',' + (pcz + dz));
        srvDetailRequest(wantD);
      }
    }
    for (let dx = -VIEW; dx <= VIEW; dx++) for (let dz = -VIEW; dz <= VIEW; dz++) buildChunk(pcx + dx, pcz + dz);
    for (const key of Array.from(mapChunks.keys())) {
      const c = key.indexOf(','), kx = +key.slice(0, c), kz = +key.slice(c + 1);
      if (Math.abs(kx - pcx) > VIEW + 1 || Math.abs(kz - pcz) > VIEW + 1) disposeChunk(key);
    }
    if (SRV_ON) for (const key of Array.from(srvChunks.keys())) {   // the store holds ONLY the rings (user rule: viewport memory)
      const c = key.indexOf(','), kx = +key.slice(0, c), kz = +key.slice(c + 1);
      if (Math.abs(kx - pcx) > VIEW + 2 || Math.abs(kz - pcz) > VIEW + 2) srvChunks.delete(key);
    }
    if (SRV_ON) for (const key of Array.from(srvDetail.keys())) {   // detail rows follow the same viewport rule
      const c = key.indexOf(','), kx = +key.slice(0, c), kz = +key.slice(c + 1);
      if (Math.abs(kx - pcx) > VIEW + 2 || Math.abs(kz - pcz) > VIEW + 2) srvDetail.delete(key);
    }
  }
}

// ---------- Living territory: a cellular automaton draped over the streamed map ----------
// The political map is no longer a frozen Voronoi wash. Each chunk carries a grid of territory
// cells; every generation control spreads from strong cells into their neighbours — seeded by the
// holds and hosts that already exist — so fronts ripple, conquests recolour outward, and borders
// breathe (Game-of-Life over the war map). Purely a client-side visualisation: server-authoritative
// capital ownership still wins; the cells are merely seeded by it.
const TERR_GEN_T = 0.5;                       // seconds per generation (the "step" cadence)
const TERR_HYST = 0.04;                       // a challenger must beat the incumbent's influence by this to flip a cell
const TERR_GROW = 0.4;                        // how fast a cell's strength chases its target each gen (the visible "fade")
const POLITICAL_TINT = 0.32;                  // max faction-colour wash over a tile's terrain (0 = pure terrain, 1 = solid politics)
// Each hold/host projects a faction influence that falls off linearly with distance. A cell flies the
// banner of the strongest influence over it — a weighted Voronoi that REBUILDS every generation, so as
// hosts roam and capitals are conquered the fronts genuinely move (capitals are wide stationary anchors;
// hosts are narrow moving sources that drag bulges into enemy land).
// influence weights live in the SHARED kernel (WorldSim.TERRITORY) — the server generates + stores
// the same field from its live tables, so client and server can never disagree where a border falls
const _TK = (typeof WorldSim !== 'undefined' && WorldSim.TERRITORY) || { CAP_W: 1.0, CAP_R: 66, SET_W: 0.6, SET_R: 30, BAND_W: 0.8, BAND_R: 16, PLR_W: 0.85, PLR_R: 16 };
const CAP_W = _TK.CAP_W, CAP_R = _TK.CAP_R;  // capital: strong, reaches across its realm
const SET_W = _TK.SET_W, SET_R = _TK.SET_R;  // town/city: a local anchor
const BAND_W = _TK.BAND_W, BAND_R = _TK.BAND_R; // a roaming host: a moving bulge of its colours that dents nearby fronts
const PLR_W = _TK.PLR_W, PLR_R = _TK.PLR_R;  // the player's own banner carves a little realm wherever it rides
const CONTEST_R = 6;                         // a living clash knocks the ground grey within this
const terrCells = new Map();                  // "q,r" -> { q, r, x, z, o:faction|null, s:0..1, f:flash, w:water, bf/bi/sf/si/ct:per-gen scratch }
let terrGen = 0, terrGenT = 0;
const _terrM4 = new THREE.Matrix4(), _terrQ = new THREE.Quaternion(), _terrV = new THREE.Vector3(), _terrS = new THREE.Vector3(), _terrCol = new THREE.Color();
// gen-0 owner: the heartland Voronoi, or the nearest loaded frontier hold, or wilderness
function _ownerAtInit(x, z) {
  if (Math.hypot(x, z) < HEARTLAND_R) { const n = nationAt(x, z); return n ? n.owner : null; }
  let best = null, bd = (CHUNK * 0.9) * (CHUNK * 0.9);
  for (const h of settlements) { const dx = h.x - x, dz = h.z - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = h; } }
  return best ? best.owner : null;
}
function _ensureCell(q, r, xc, zc) {
  const k = hexKey(q, r);
  let c = terrCells.get(k);
  if (c) return c;
  const water = isWater(xc, zc);
  const owner = water ? null : _ownerAtInit(xc, zc);
  c = { q, r, x: xc, z: zc, o: owner, s: owner ? 0.6 : 0, f: 0, w: water, bf: null, bi: 0, sf: null, si: 0, ct: 0 };
  terrCells.set(k, c);
  return c;
}
function initTerritoryCells(cells) {
  for (let i = 0; i < cells.length; i++) _ensureCell(cells[i][0], cells[i][1], cells[i][2], cells[i][3]);
}

// ---------- the SERVER's territory field: fetched per chunk, applied as each cell's anchor ----------
// GET /api/v1/territory serves the stored per-hex field (owner + heat) that the server generated
// from LIVE ownership (holds/capitals/warlords/presence tables). Cells carry it as (so, ss); each
// CA generation seeds the influence scratch from it BEFORE the local transient stamps (your banner,
// roaming hosts, clashes), so borders ease toward the server's truth and still breathe locally.
const srvTerr = new Map();            // "cx,cz" -> { f:[names], o:Uint8Array, s:Uint8Array }
let _srvTerrAt = 0, _srvTerrBusy = false;
const TERR_SRV_T = 8;                 // seconds between refreshes of the loaded ring
function applySrvTerritory(key) {
  const e = srvTerr.get(key); if (!e) return;
  const ci = key.indexOf(','), cx = +key.slice(0, ci), cz = +key.slice(ci + 1);
  const cells = hexCellsInChunk(cx, cz);
  for (let i = 0; i < cells.length; i++) {
    const c = terrCells.get(hexKey(cells[i][0], cells[i][1])); if (!c) continue;
    const oi = e.o[i];
    c.so = oi ? (factionByName(e.f[oi - 1]) || FREE) : null;
    c.ss = oi ? e.s[i] / 255 : 0;
  }
}
function maybeFetchSrvTerritory(now) {
  if (!SRV_ON || _srvTerrBusy || !window.net || !window.net.loadTerritory) return;
  if (now - _srvTerrAt < TERR_SRV_T * 1000) return;
  const keys = Array.from(mapChunks.keys()).slice(0, 81);
  if (!keys.length) return;
  _srvTerrAt = now; _srvTerrBusy = true;
  const ws = worldSeed();
  window.net.loadTerritory(mapLevel, universeSeed, keys.map(k => k.replace(',', ':'))).then(resp => {
    _srvTerrBusy = false;
    if (!resp || resp.tseed !== ws || ws !== worldSeed()) return;   // a reroll outran this batch
    for (const p of resp.chunks || []) {
      const key = p.cx + ',' + p.cz;
      srvTerr.set(key, { f: p.f || [], o: _srvB64(p.o), s: _srvB64(p.s) });
      applySrvTerritory(key);
    }
  }).catch(() => { _srvTerrBusy = false; });
}
// one generation: rebuild the faction influence field from the live holds/hosts, then let each cell
// flow toward whoever now dominates it. Because the hosts move and capitals change hands, the field
// (and therefore every border) shifts generation to generation.
function stepTerritory() {
  terrGen++;
  maybeFetchSrvTerritory(performance.now());          // keep the server's stored field flowing in
  for (const c of terrCells.values()) {
    c.bf = null; c.bi = 0; c.sf = null; c.si = 0; c.ct = 0;   // reset the field
    if (c.so !== undefined && c.so && !c.w) { c.bf = c.so; c.bi = c.ss * 0.95; }  // the server's anchor seeds the scratch
  }
  // stamp a source's influence onto the loaded hex cells in its reach, tracking the top-2 distinct factions per cell
  const stamp = (sx, sz, fac, W, R) => {
    if (!fac) return;
    const invR = 1 / R;
    const rLo = Math.floor((sz - R) / HEX_H) - 1, rHi = Math.ceil((sz + R) / HEX_H) + 1;
    for (let r = rLo; r <= rHi; r++) {
      const off = 0.5 * (r & 1);
      const qLo = Math.floor((sx - R) / HEX_W - off) - 1, qHi = Math.ceil((sx + R) / HEX_W - off) + 1;
      for (let q = qLo; q <= qHi; q++) {
        const c = terrCells.get(hexKey(q, r)); if (!c || c.w) continue;
        const d = Math.hypot(c.x - sx, c.z - sz);
        if (d >= R) continue;
        const inf = W * (1 - d * invR); if (inf <= 0) continue;
        if (c.bf === fac) { if (inf > c.bi) c.bi = inf; }
        else if (inf > c.bi) { c.sf = c.bf; c.si = c.bi; c.bf = fac; c.bi = inf; }
        else if (c.sf === fac) { if (inf > c.si) c.si = inf; }
        else if (inf > c.si) { c.sf = fac; c.si = inf; }
      }
    }
  };
  for (const n of nations) stamp(n.x, n.z, n.owner, CAP_W, CAP_R);
  for (const h of settlements) stamp(h.x, h.z, h.owner, SET_W, SET_R);
  for (const b of parties) if (b.alive) stamp(b.pos.x, b.pos.z, b.faction, BAND_W, BAND_R);
  stamp(player.pos.x, player.pos.z, PLAYER_REALM, PLR_W, PLR_R);
  for (const bt of mapBattles) if (!bt.done) {        // a living clash knocks the ground grey around it
    const rLo = Math.floor((bt.cz - CONTEST_R) / HEX_H) - 1, rHi = Math.ceil((bt.cz + CONTEST_R) / HEX_H) + 1;
    for (let r = rLo; r <= rHi; r++) {
      const off = 0.5 * (r & 1);
      const qLo = Math.floor((bt.cx - CONTEST_R) / HEX_W - off) - 1, qHi = Math.ceil((bt.cx + CONTEST_R) / HEX_W - off) + 1;
      for (let q = qLo; q <= qHi; q++) {
        const c = terrCells.get(hexKey(q, r)); if (!c) continue;
        const d = Math.hypot(c.x - bt.cx, c.z - bt.cz);
        if (d < CONTEST_R) c.ct = Math.max(c.ct, 1 - d / CONTEST_R);
      }
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
  for (const rec of mapChunks.values()) if (rec.tiles) paintChunkTerritory(rec);
  refreshOwnedPins();                                 // conquests pin/unpin on the same cadence
}
// lay the SUBTLE faction politics over the tile's realistic terrain — only the top-face vertices are
// tinted (cliff sides stay pure terrain), re-derived from the stored base each generation so a tile
// reverts cleanly when it falls to wilderness. Terrain is the star; politics is a faint hue.
function paintChunkTerritory(rec) {
  if (rec.terrOverlay) paintTerrOverlay(rec.terrOverlay);
  if (!rec.tiles) return;
  for (const t of rec.tiles) paintTerrTile(t);
}
function paintTerrTile(t) {
  if (TERR_LAYER) return;                       // politics ride their own sheet now — terrain stays pure
  const items = t.items, base = t.base, arr = t.colorAttr.array, topIdx = t.topIdx, M = topIdx.length;
  for (let i = 0; i < items.length; i++) {
    const c = items[i].cell, vb = items[i].vb;
    let grey = false, gk = 0, tint = false, fr = 0, fg = 0, fb = 0, k = 0;
    if (c && !c.w && c.ct > 0.12) { grey = true; gk = 0.5 * c.ct; }                 // a raging clash → wash toward grey
    else if (c && !c.w && c.o && c.s >= 0.08) {                                     // owned land takes a faint realm hue
      fr = ((c.o.color >> 16) & 255) / 255; fg = ((c.o.color >> 8) & 255) / 255; fb = (c.o.color & 255) / 255;
      if (c.f > 0.02) { const tw = c.f * 0.45; fr += (1 - fr) * tw; fg += (1 - fg) * tw; fb += (1 - fb) * tw; } // flash a fresh flip
      k = POLITICAL_TINT * (0.45 + 0.55 * c.s); tint = true;
    }
    for (let m = 0; m < M; m++) {
      const o = (vb + topIdx[m]) * 3;
      let r = base[o], g = base[o + 1], b = base[o + 2];
      if (grey) { r += (0.78 - r) * gk; g += (0.78 - g) * gk; b += (0.78 - b) * gk; }
      else if (tint) { r += (fr - r) * k; g += (fg - g) * k; b += (fb - b) * k; }
      arr[o] = r; arr[o + 1] = g; arr[o + 2] = b;
    }
  }
  t.colorAttr.needsUpdate = true;
}

// ---------- The BORDER LAYER: politics as its own floating heat-map sheet ----------
// A translucent hex-cap sheet on the logical lattice, draped just above the ground: every owned
// cell gets a cap in its faction's colour whose ALPHA is the heat — deep land bold, contested
// seams faint, live clashes grey. The terrain underneath stays pure (paintTerrTile stands down).
// Hovering a realm lifts its whole area at once; the sheet hides at street level (rung 2).
const TERR_LAYER = true;              // borders ride their own sheet, not the terrain tint
const TERR_LAYER_A = 0.34;            // cap alpha at full heat
const TERR_LAYER_LIFT = 0.5;          // the sheet floats this far above the ground
let hoverNation = null;               // the realm under the cursor (its whole area lifts)
let _terrOvMat = null;
function terrOvMat() {
  if (!_terrOvMat) {
    _terrOvMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
    _terrOvMat.userData.cached = true;              // shared across every chunk — disposeGroup must skip it
  }
  return _terrOvMat;
}
const _OV_RING = [1, 7, 2, 8, 3, 9, 4, 10, 5, 11, 6, 12];   // the hex top fan's ring order (corner, edge-mid, …)
function buildTerrOverlay(group, cx, cz) {
  if (!TERR_LAYER) return null;
  const cells = hexCellsInChunk(cx, cz), OFF = Terra.TOP_OFFSETS;
  const pos = [], idx = [], items = [];
  for (let i = 0; i < cells.length; i++) {
    const c = terrCells.get(hexKey(cells[i][0], cells[i][1]));
    if (!c || c.w) continue;                        // open water flies no banner — no cap at all
    const xc = cells[i][2], zc = cells[i][3], vb = pos.length / 3;
    for (let v = 0; v < OFF.length; v++) {
      const px = xc + OFF[v][0], pz = zc + OFF[v][1];
      pos.push(px, mapElevY(px, pz) + TERR_LAYER_LIFT, pz);
    }
    for (let j = 0; j < 12; j++) idx.push(vb, vb + _OV_RING[j], vb + _OV_RING[(j + 1) % 12]);
    items.push({ cell: c, vb });
  }
  if (!items.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 4), 4)); // RGBA — alpha IS the heat
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, terrOvMat());
  mesh.renderOrder = 3;                             // over the terrain, under the sprites
  mesh.visible = detailTier() !== 2;
  group.add(mesh);
  return { mesh, colorAttr: geo.attributes.color, items };
}
function paintTerrOverlay(ov) {
  const arr = ov.colorAttr.array;
  for (let i = 0; i < ov.items.length; i++) {
    const c = ov.items[i].cell, vb = ov.items[i].vb;
    let r = 0, g = 0, b = 0, a = 0;
    if (c.ct > 0.12) { r = g = b = 0.72; a = 0.5 * c.ct; }          // a raging clash: grey heat
    else if (c.o && c.s >= 0.08) {
      r = ((c.o.color >> 16) & 255) / 255; g = ((c.o.color >> 8) & 255) / 255; b = (c.o.color & 255) / 255;
      if (c.f > 0.02) { const tw = c.f * 0.5; r += (1 - r) * tw; g += (1 - g) * tw; b += (1 - b) * tw; } // flash a fresh flip
      a = TERR_LAYER_A * (0.35 + 0.65 * c.s);                       // the heat IS the alpha
      if (hoverNation) {
        if (c.o === hoverNation) { a = Math.min(0.8, a * 1.9); const w = 0.18; r += (1 - r) * w; g += (1 - g) * w; b += (1 - b) * w; }
        else a *= 0.4;                                              // every other banner recedes
      }
    }
    for (let v = 0; v < 13; v++) { const o = (vb + v) * 4; arr[o] = r; arr[o + 1] = g; arr[o + 2] = b; arr[o + 3] = a; }
  }
  ov.colorAttr.needsUpdate = true;
}
function setHoverNation(fac) {
  if (fac === hoverNation) return;
  hoverNation = fac;
  for (const rec of mapChunks.values()) if (rec.terrOverlay) paintTerrOverlay(rec.terrOverlay);
}

// ============================================================================
// ---------- Roads: a terrain-aware network knitting the settlements together ----------
// A deterministic graph over the settlement lattice (capitals + cities + towns + villages):
//   • trunk roads (MAJOR) link cities & capitals across the realm,
//   • town roads (MEDIUM) and village lanes (SMALL) mesh the local holds,
//   • tiny foot-PATHs spur off into the countryside.
// Every edge is ROUTED, not drawn straight: a seeded S-curve plus a few relaxation passes that
// pull the polyline off water and around steep ground, so roads bend through valleys and skirt
// peaks. The whole in-view network is BRUSHED into the terrain itself: strokes on a world-aligned
// splat canvas that the terrain shader composites over its vertex colours (see _roadSplatPaint).
// Roads also drive movement feel: roadInfoAt() + landRoughAt() let parties march fast & rested on
// a road and slow & tired through the mountains, and bias enemy hosts toward the roads.
// Pure function of (worldSeed, settlement lattice) — no Math.random, so it matches run-to-run.
// ============================================================================
// spec + tier look + movement feel all live in the kernel (tune them THERE — the server shares them)
const ROAD = Terra.ROAD;
const ROAD_TIER = Terra.ROAD_TIER;
const MOVE = Terra.MOVE;
let partyStamina = 100;          // the warband's marching condition on the overworld (separate from combat player.stamina)
let roadMesh = null;             // roadside decoration (waymarker stones) for the loaded region — the roadbeds themselves are painted into the terrain splat
let roadGrid = null;             // Map "gx,gz" -> [segment] spatial hash for O(1) roadInfoAt queries
const ROAD_GRID = 14;            // spatial-hash cell size (u)
let _roadChunk = '';             // player chunk the current network was built for (route/site caches live in the kernel instance)
let _roadStats = { nodes: 0, edges: 0, drawn: 0, segs: 0 };
let _roadEdges = [];   // last-built edge list (for BV.roadGraph inspection)

// ruggedness at a point: 0 = easy lowland, 1 = steep mountain (kernel math; srv payloads carry it per cell)
function landRoughAt(x, z) {
  if (SRV_ON) { const r = srvRoughAt(x, z); if (r !== null) return r; }
  return terra().landRoughAt(x, z);
}
// nearest road influence at a point: { factor 0..1, dx, dz } where (dx,dz) is the road's tangent there.
const _riOut = { factor: 0, dx: 0, dz: 0 };
function roadInfoAt(x, z) {
  _riOut.factor = 0; _riOut.dx = 0; _riOut.dz = 0;
  if (!roadGrid) return _riOut;
  const gx = Math.floor(x / ROAD_GRID), gz = Math.floor(z / ROAD_GRID);
  let bestF = 0, btx = 0, btz = 0;
  for (let ax = -1; ax <= 1; ax++) for (let az = -1; az <= 1; az++) {
    const bucket = roadGrid.get((gx + ax) + ',' + (gz + az)); if (!bucket) continue;
    for (let i = 0; i < bucket.length; i++) {
      const s = bucket[i];
      const vx = s.x2 - s.x1, vz = s.z2 - s.z1, L2 = vx * vx + vz * vz || 1;
      let t = ((x - s.x1) * vx + (z - s.z1) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = s.x1 + vx * t, cz = s.z1 + vz * t, d = Math.hypot(x - cx, z - cz);
      const core = s.w * 0.5;
      const f = s.str * (d <= core ? 1 : clamp(1 - (d - core) / ROAD.fall, 0, 1));
      if (f > bestF) { bestF = f; const il = 1 / Math.sqrt(L2); btx = vx * il; btz = vz * il; }
    }
  }
  _riOut.factor = bestF; _riOut.dx = btx; _riOut.dz = btz;
  return _riOut;
}
function roadFactorAt(x, z) { return roadInfoAt(x, z).factor; }
// the march-speed multiplier at a point given its road factor & ruggedness (1 = open-ground baseline)
function terrainSpeedMul(road, rough, fatigued) { return terra().terrainSpeedMul(road, rough, fatigued ? partyStamina : null); }
// steer a desired heading toward roads & away from rough ground, while still chasing the goal. Returns [dx,dz].
const _steerOut = [0, 0];
function roadSteer(px, pz, desx, desz) {
  const goal = Math.atan2(desx, desz);
  let bx = desx, bz = desz, best = -1e9;
  for (let k = -3; k <= 3; k++) {
    const ang = goal + k * 0.32, cx = Math.sin(ang), cz = Math.cos(ang);
    const look = 11, sx = px + cx * look, sz = pz + cz * look;
    if (isWater(sx, sz)) continue;
    const align = cx * desx + cz * desz;                       // progress toward the goal (−1..1)
    const score = align * 1.0 - landRoughAt(sx, sz) * 0.7 + roadFactorAt(sx, sz) * 0.95;
    if (score > best) { best = score; bx = cx; bz = cz; }
  }
  _steerOut[0] = bx; _steerOut[1] = bz; return _steerOut;
}

// ---------- Deterministic hex-lattice A*: lives in the Terra kernel (one engine, both sides) ----------
// The kernel instance carries the cost model, the walled-hold avoid list (set by its own
// roadBuildNetwork), and the 2u-quantised roughness memo. travelPath keeps its exact signature.
const _angD = Terra.angD;
function travelPath(sx, sz, tx, tz, maxExpand) { return terra().travelPath(sx, sz, tx, tz, maxExpand); }

// ---- the road network: nodes → edges → routed polylines — the BUILDER lives in the kernel ----
// (roadRebuild below feeds kernel output into the client-only splat canvas + spatial hash + rocks)
function villageRoadAxis(st) { return terra().villageRoadAxis(st); }  // the house-builder shares the street axis
// ============================================================================
// The network builder moved into the Terra kernel (roadBuildNetwork/roadRoute/edgeWallSafe) so
// the server knits the SAME roads. What remains below is pure PRESENTATION: the splat painter,
// the spatial query grid, and the waymarker rocks.
// ============================================================================
function _roadGridAdd(seg) {
  const minx = Math.min(seg.x1, seg.x2), maxx = Math.max(seg.x1, seg.x2);
  const minz = Math.min(seg.z1, seg.z2), maxz = Math.max(seg.z1, seg.z2);
  for (let gx = Math.floor(minx / ROAD_GRID); gx <= Math.floor(maxx / ROAD_GRID); gx++)
    for (let gz = Math.floor(minz / ROAD_GRID); gz <= Math.floor(maxz / ROAD_GRID); gz++) {
      const k = gx + ',' + gz; let b = roadGrid.get(k); if (!b) roadGrid.set(k, b = []); b.push(seg);
    }
}
// (re)build the whole in-view network: hierarchy → routed polylines → splat repaint + rocks + query grid
function roadRebuild(pcx, pcz) {
  const T9 = terra();                 // the kernel knits the network (and bounds its own caches)
  const nodes = T9.roadGatherNodes(pcx, pcz);
  const edges = T9.roadBuildNetwork(nodes);
  _roadEdges = edges;
  roadGrid = new Map();
  const rockPts = [], jobs = [];
  const cxw = (pcx + 0.5) * CHUNK, czw = (pcz + 0.5) * CHUNK, renderR = (ROAD.renderChunkR + 0.5) * CHUNK;
  let drawn = 0, segs = 0;
  for (const e of edges) {
    const mx = (e.a.x + e.b.x) * 0.5, mz = (e.a.z + e.b.z) * 0.5;
    if (Math.hypot(mx - cxw, mz - czw) > renderR + Math.hypot(e.a.x - e.b.x, e.a.z - e.b.z) * 0.5) continue;
    const pts = e.pts || (e.pts = T9.roadRoute(e));
    if (!pts || pts.length < 2) continue;
    let wet = 0, run = 0, maxRun = 0;
    for (let w = 0; w < pts.length; w++) { if (isWater(pts[w].x, pts[w].z)) { wet++; run++; if (run > maxRun) maxRun = run; } else run = 0; }
    if (wet / pts.length > 0.18 || maxRun >= 3) continue; // no bridges yet — a road never fords open water
    if (!e.key.startsWith('city:') && !e.key.startsWith('street:') && !T9.edgeWallSafe(e, pts)) continue; // a road NEVER crosses a wall away from a gate — better no road than a breach
    const T = ROAD_TIER[e.tier];
    drawn++;
    // per-JOINT grading, same spirit as the old mitered ribbon: the stroke narrows and its tone
    // dirties on rough ground, and a low-frequency jitter keeps a long haul from reading machine-laid.
    const J = pts.length, jhw = new Float64Array(J), jt = new Float64Array(J);
    for (let i = 0; i < J; i++) {
      const p = pts[i], rgh = landRoughAt(p.x, p.z);
      jhw[i] = T.w * 0.5 * (1.12 - rgh * 0.62);
      jt[i] = (0.95 + _vnoise(p.x * 0.3, p.z * 0.3, worldSeed() + 51) * 0.12) * (1 - rgh * 0.16);
    }
    for (let i = 0; i < J - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      _roadGridAdd({ x1: p.x, z1: p.z, x2: q.x, z2: q.z, w: jhw[i] * 2, str: T.str });
      if (e.tier === 'major' && (i % 3 === 1)) {       // waymarker stones line the great roads
        const pPrev = pts[Math.max(0, i - 1)], pNext = pts[Math.min(J - 1, i + 1)];
        let tx = pNext.x - pPrev.x, tz = pNext.z - pPrev.z;              // joint tangent (central difference)
        const tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
        const side = (i % 6 === 1) ? 1 : -1;
        const ox = p.x + nx * side * (jhw[i] + 0.9), oz = p.z + nz * side * (jhw[i] + 0.9);
        if (!isWater(ox, oz)) rockPts.push({ x: ox, z: oz });
      }
      segs++;
    }
    jobs.push({ pts, T, jhw, jt });
  }
  _roadSplatPaint(jobs, cxw, czw, renderR);            // the roads themselves are brushed INTO the terrain (see _roadSplatPaint)
  if (roadMesh) { if (mapTerrain) mapTerrain.remove(roadMesh); disposeGroup(roadMesh); roadMesh = null; }
  // (the wall-safety cull lives in the kernel's edgeWallSafe — see the draw loop)
  if (rockPts.length && mapTerrain) {
    const grp = new THREE.Group();
    {                                                  // seeded roadside stones (deterministic from position)
      const rm = new THREE.InstancedMesh(cachedGeo('mapRock', () => new THREE.IcosahedronGeometry(1, 0)), mat(0x8d8f95), rockPts.length);
      const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), ee = new THREE.Euler(), vv = new THREE.Vector3(), sv = new THREE.Vector3();
      rockPts.forEach((p, i) => {
        const j = _vnoise(p.x * 1.7, p.z * 1.7, worldSeed() + 77), rr = 0.2 + j * 0.3;
        qq.setFromEuler(ee.set(j * 9 % 3, j * 17 % 3, 0));
        m4.compose(vv.set(p.x, mapElevY(p.x, p.z) + rr * 0.4, p.z), qq, sv.set(rr, rr * 0.8, rr));
        rm.setMatrixAt(i, m4);
      });
      grp.add(rm);
    }
    roadMesh = grp;
    mapTerrain.add(grp);
  }
  _roadStats = { nodes: nodes.length, edges: edges.length, drawn, segs };
}
// ---------- Road splat: the network is PAINTED into the terrain, like a brush ----------
// The old ribbons were separate meshes floated `lift` units above the relief — between hex vertices
// the two surfaces disagreed, so roads read as blocks hovering on the land. Now the routed polylines
// are STROKED into one top-down canvas (soft worn-shoulder pass + opaque core pass, round caps,
// per-segment width/tone), and the terrain material samples that canvas by world XZ in its fragment
// shader. The road IS the terrain surface: it hugs every hex top, takes the same sun and shadows as
// the grass, and its anti-aliased alpha edge feathers into the land like a brush stroke.
const ROAD_SPLAT = {
  size: 2048,      // canvas resolution (px) — ~2.8 px per world unit over the render window
  pad: 30,         // world-margin past the road render window so strokes never clip at the rim
  tone: 0.90,      // painted tint of the tier colour (terrain lighting brings it back up)
  vergeW: 2.2,     // worn shoulder width, × the core width
  vergeA: 0.28,    // shoulder opacity — packed earth bleeding into the grass
};
let _roadCv = null, _roadCtx = null, _roadTex = null, _roadDbg = false;
let _roadPaintedTier = 1;   // width tier the splat was last painted at (2 = street width, else 1)
const _roadWinU = { value: new THREE.Vector3(0, 0, 0) };  // (window centre x, z, 1/span) — one uniform shared by all terrain
function _roadSplatInit() {
  if (_roadCv) return;
  _roadCv = document.createElement('canvas');
  _roadCv.width = _roadCv.height = ROAD_SPLAT.size;
  _roadCtx = _roadCv.getContext('2d');
  _roadTex = new THREE.CanvasTexture(_roadCv);
  _roadTex.flipY = false;                                  // uv.y runs with +z, same as the canvas rows
  _roadTex.wrapS = _roadTex.wrapT = THREE.ClampToEdgeWrapping;
  _roadTex.anisotropy = 4;                                 // keeps the strokes crisp under the shallow map tilt
}
// ONE shared material for every terrain chunk, patched to composite the road splat over the vertex
// colours: sample by world XZ, clip to the splat window, and mask to up-facing ground (the derivative
// normal) so a cliff wall under a road's edge never smears grey down its face. The mix runs after
// color_fragment, so roads override the political tint exactly like the old noTint ribbons did.
let TERRA_MAT = null;
function terraMat() {
  if (TERRA_MAT) return TERRA_MAT;
  _roadSplatInit();
  const m = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 3 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRoadTex = { value: _roadTex };
    sh.uniforms.uRoadWin = _roadWinU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoadWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoadWP = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uRoadTex;\nuniform vec3 uRoadWin;\nvarying vec3 vRoadWP;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + [
        // sampled OUTSIDE any branch (mip derivatives stay defined), then masked: inside the splat
        // window, window active (z>0), and up-facing ground only — cliff walls keep pure terrain.
        'vec2 rUv = (vRoadWP.xz - uRoadWin.xy) * uRoadWin.z + 0.5;',
        'vec4 rd = texture2D(uRoadTex, rUv);',
        'rd.a = min(1.0, rd.a * 1.5);',   // mip levels average the stroke with empty canvas — pull the core back up so roads hold at distance
        'vec2 rIn = step(abs(rUv - 0.5), vec2(0.5));',
        'float rUp = smoothstep(0.25, 0.55, abs(normalize(cross(dFdx(vRoadWP), dFdy(vRoadWP))).y));',
        'diffuseColor.rgb = mix(diffuseColor.rgb, rd.rgb, rd.a * rUp * rIn.x * rIn.y * step(0.0001, uRoadWin.z));',
      ].join('\n'));
  };
  m.userData.cached = true; m.userData.noTint = true;
  TERRA_MAT = m;
  return m;
}
// stroke the routed edges into the splat canvas: first every edge's soft worn shoulder, then every
// opaque core (cores always cross junctions clean), foot-trails as a dashed hairline. setTransform
// maps world→canvas, so widths and dash lengths below are in world units.
function _roadSplatPaint(jobs, cxw, czw, renderR) {
  _roadSplatInit();
  // street level paints the same routes wider — a road you WALK reads broader than a road you chart.
  // Paint-only: the routed polylines, travel costs and ETAs never see this multiplier.
  const RD = _appliedTier === 2 ? STREET.roadWMul : 1;
  _roadPaintedTier = _appliedTier === 2 ? 2 : 1;
  const S = ROAD_SPLAT.size, half = renderR + ROAD_SPLAT.pad, span = half * 2, k = S / span, ctx = _roadCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, S, S);
  ctx.setTransform(k, 0, 0, k, (half - cxw) * k, (half - czw) * k);
  ctx.lineCap = ctx.lineJoin = 'round';
  const css = (hex, m, a) => 'rgba(' + Math.min(255, ((hex >> 16) & 255) * m | 0) + ',' + Math.min(255, ((hex >> 8) & 255) * m | 0) + ',' + Math.min(255, (hex & 255) * m | 0) + ',' + a + ')';
  const trace = (pts) => { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].z); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].z); };
  for (const j of jobs) {                              // pass 1: shoulders (one stroke per edge — a single path never double-blends with itself)
    if (j.T === ROAD_TIER.path) continue;              // a foot-trail has no built shoulder
    ctx.strokeStyle = _roadDbg ? 'rgba(255,90,42,0.5)' : css(j.T.col, ROAD_SPLAT.tone * 0.72, ROAD_SPLAT.vergeA);
    ctx.lineWidth = j.T.w * ROAD_SPLAT.vergeW * RD;
    trace(j.pts); ctx.stroke();
  }
  for (const j of jobs) {                              // pass 2: cores
    const pts = j.pts;
    if (j.T === ROAD_TIER.path) {                      // trail: a worn dashed hairline
      ctx.setLineDash([2.4, 2.0]);
      ctx.strokeStyle = _roadDbg ? '#ff5a2a' : css(j.T.col, ROAD_SPLAT.tone, 0.8);
      ctx.lineWidth = j.T.w * RD;
      trace(pts); ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }
    for (let i = 0; i < pts.length - 1; i++) {         // opaque per-segment strokes keep the per-joint width & tone grading (round caps weld them seamless)
      ctx.strokeStyle = _roadDbg ? '#ff5a2a' : css(j.T.col, ROAD_SPLAT.tone * (j.jt[i] + j.jt[i + 1]) * 0.5, 1);
      ctx.lineWidth = (j.jhw[i] + j.jhw[i + 1]) * RD;
      ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].z); ctx.lineTo(pts[i + 1].x, pts[i + 1].z); ctx.stroke();
    }
  }
  _roadTex.needsUpdate = true;
  _roadWinU.value.set(cxw, czw, 1 / span);
}
// rebuild the network only when the player crosses into a new chunk (cheap, routes are cached)
function ensureRoads(force) {
  if (!mapTerrain) return;
  const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK), pk = pcx + ',' + pcz;
  if (!force && pk === _roadChunk) return;
  _roadChunk = pk;
  roadRebuild(pcx, pcz);
}
// a fresh region wipes the network (terrain teardown disposes the mesh) — clear caches so it regenerates
function roadResetRegion() {
  roadMesh = null; roadGrid = null; _roadChunk = '';
  if (_roadCtx) { _roadCtx.setTransform(1, 0, 0, 1, 0, 0); _roadCtx.clearRect(0, 0, ROAD_SPLAT.size, ROAD_SPLAT.size); _roadTex.needsUpdate = true; }
  _roadWinU.value.set(0, 0, 0);                   // gates the shader mix off until the next rebuild paints
  _terraInst = null;                              // a new region = a fresh kernel instance (all its memos drop with it)
  partyStamina = 100;
  clearMarch();
}

// ---------- March orders & the column-of-route ----------
// Click the map: the warband plans the FASTEST route (big roads beat lanes beat open country beat the
// hills — the same speed model the march uses) and rides it by itself, reporting the ETA. While it
// marches a road the column strings out SINGLE FILE down its own wake: a huge army is a long line on
// the road. Bands and detachments plan the same way, budgeted to one route per frame.
let marchPath = null, marchInfo = null, marchFlag = null;
const _mDir = new THREE.Vector3();
let _pathBudget = 1;                 // route plans allowed this frame (bands + detachments share it)
function clearMarch(msg) {
  marchPath = null; marchInfo = null;
  if (marchFlag) { scene.remove(marchFlag); for (const o of marchFlag.children) if (o.material) o.material.dispose(); marchFlag = null; }
  if (msg) showCmdToast(msg);
}
function orderMarch(tx, tz) {
  if (typeof clearMapFocus === 'function') clearMapFocus(); // a fresh march order pulls the camera back to you
  const land = nearestLand(tx, tz), lx = land[0], lz = land[1];
  const t = travelPath(player.pos.x, player.pos.z, lx, lz);
  if (!t) { showCmdToast('No route — the land bars the way'); return false; }
  marchPath = t.pts.slice(1); marchInfo = t;
  if (!marchFlag) marchFlag = buildDetFlag(PLAYER_REALM.color);
  marchFlag.position.set(lx, mapElevY(lx, lz), lz);
  const secs = Math.max(1, Math.round(t.seconds));
  showCmdToast('March: ~' + (secs >= 90 ? Math.round(secs / 60) + ' min' : secs + ' s') +
    (t.roadFrac > 0.5 ? ' — mostly by road' : t.roadFrac > 0.15 ? ' — part road, part wild' : ' — cross-country'));
  return true;
}
// serve a unit's long march: (re)plan a road-aware route when its goal moves, then hand back the live waypoint
function unitPathStep(u, tx, tz) {
  if (u._route && u._routeGoal && Math.hypot(u._routeGoal.x - tx, u._routeGoal.z - tz) < 24) {
    const rt = u._route;
    while (rt.length && Math.hypot(rt[0].x - u.pos.x, rt[0].z - u.pos.z) < 2.2) rt.shift();
    if (rt.length) return rt[0];
    u._route = null; return null;                    // arrived along the route — direct steering finishes it
  }
  if (_pathBudget <= 0) return (u._route && u._route[0]) || null;
  _pathBudget--;
  const t = travelPath(u.pos.x, u.pos.z, tx, tz, 4500);
  u._routeGoal = { x: tx, z: tz };
  u._route = t ? t.pts.slice(1) : null;
  return (u._route && u._route[0]) || null;
}
// breadcrumb wake behind a moving column (for the single-file stretch)
function trailPush(u, x, z) {
  const tr = u._trail || (u._trail = []);
  const last = tr[tr.length - 1];
  if (last && (last.x - x) ** 2 + (last.z - z) ** 2 < 0.36) return;
  tr.push({ x, z });
  if (tr.length > 96) tr.shift();
}
// stretch the marchers single-file along the wake while filing; ease them home into ranks otherwise
function fileColumn(g, u, filing, dt, spacing) {
  const ms = g.userData.marchers; if (!ms || !ms.length) return;
  if (!g.userData.home) g.userData.home = ms.map(m => m.group.position.clone());
  const k = Math.min(1, dt * 5), tr = u._trail, sp = spacing || 1.15;
  if (filing && tr && tr.length >= 2) {
    const cy = Math.cos(g.rotation.y), sy = Math.sin(g.rotation.y);
    let i = tr.length - 1, ax = u.pos.x, az = u.pos.z, need = sp, mi = 0;
    while (mi < ms.length && i >= 0) {
      const p = tr[i], seg = Math.hypot(p.x - ax, p.z - az);
      if (seg >= need) {
        const tt = need / (seg || 1), wx = ax + (p.x - ax) * tt, wz = az + (p.z - az) * tt;
        const rx = wx - u.pos.x, rz = wz - u.pos.z;
        const lx = rx * cy - rz * sy, lz = rx * sy + rz * cy;        // world → column-local (undo the yaw)
        const m = ms[mi].group.position;
        m.x += (lx - m.x) * k; m.z += (lz - m.z) * k;
        m.y += (mapElevY(wx, wz) - g.position.y - m.y) * k;
        ax = wx; az = wz; need = sp; mi++;
      } else { need -= seg; ax = p.x; az = p.z; i--; }
    }
  } else {
    const home = g.userData.home;
    for (let j = 0; j < ms.length; j++) { const m = ms[j].group.position, h = home[j]; m.x += (h.x - m.x) * k; m.z += (h.z - m.z) * k; m.y += (h.y - m.y) * k; }
  }
}
// a plain left-click on the strategic map (outside command mode) orders the march
let _mvDown = null;
addEventListener('mousedown', (e) => {
  if (mode !== 'map' || mapCmdMode || mapFieldMode || encounter || e.button !== 0) return;
  if (e.target !== canvas) return;
  _mvDown = { x: e.clientX, y: e.clientY };
});
addEventListener('mouseup', (e) => {
  if (!_mvDown) return; const st = _mvDown; _mvDown = null;
  if (mode !== 'map' || mapCmdMode || mapFieldMode || encounter || e.button !== 0) return;
  if (Math.abs(e.clientX - st.x) + Math.abs(e.clientY - st.y) > 6) return;
  const p = groundPointAt(e.clientX, e.clientY); if (!p) return;
  const hit = holdAtPoint(p.x, p.z);               // a hold under the click → its card, not a march
  if (hit) { openHoldPanel(hit); return; }
  if (e.shiftKey) {                                // shift-click open country → that realm's card
    const qr = worldToHex(p.x, p.z), c = terrCells.get(hexKey(qr[0], qr[1]));
    if (c && c.o) { openNationPanel(factionName(c.o)); return; }
  }
  closeRealmPanel();
  orderMarch(p.x, p.z);
});

// ---------- Hover: the border sheet names the realm under the cursor and lifts its whole area ----------
function holdAtPoint(x, z) {
  let best = null, bd = 1e9;
  for (const en of _allHoldEntries()) {
    const spec = SG_SPEC[en.tier || 'capital'] || SG_SPEC.village;
    const R = Math.max(spec.R * 1.15, 9), d = Math.hypot(en.x - x, en.z - z);
    if (d < R && d < bd) { bd = d; best = en; }
  }
  return best;
}
let _hovAt = 0;
addEventListener('mousemove', (e) => {
  const tip = document.getElementById('terrtip');
  if (mode !== 'map' || mapCmdMode || mapFieldMode || encounter || e.target !== canvas || _appliedTier === 2) {
    if (hoverNation) setHoverNation(null);
    if (tip) tip.classList.add('hidden');
    return;
  }
  const now = performance.now(); if (now - _hovAt < 70) return; _hovAt = now;
  const p = groundPointAt(e.clientX, e.clientY);
  let fac = null;
  if (p) { const qr = worldToHex(p.x, p.z); const c = terrCells.get(hexKey(qr[0], qr[1])); if (c && c.o && c.s >= 0.08) fac = c.o; }
  setHoverNation(fac);
  if (!tip) return;
  if (!fac) { tip.classList.add('hidden'); return; }
  const rel = relGet(PLAYER_REALM, fac);
  const st = fac === PLAYER_REALM ? 'your realm' : ((rel && rel.stance) || 'neutral');
  tip.innerHTML = '<span class="tt-dot" style="background:' + _hex6(fac.color) + '"></span>' + _esc(factionName(fac)) +
    ' <span class="tt-dim">· ' + _esc(st) + ' · click a hold · shift-click for the realm</span>';
  tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 16) + 'px';
  tip.classList.remove('hidden');
});

// ---------- The realm/hold card: click a hold — what it shows is the SERVER's live truth ----------
function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function _hex6(c) { return '#' + ('00000' + ((c || 0) >>> 0).toString(16)).slice(-6); }
function closeRealmPanel() { const el = document.getElementById('realm'); if (el) el.classList.add('hidden'); }
document.getElementById('rm-close') && document.getElementById('rm-close').addEventListener('click', closeRealmPanel);
function _openRealmShell(title, colorHex) {
  const el = document.getElementById('realm'); if (!el) return null;
  document.getElementById('rm-title').textContent = title;
  document.getElementById('rm-flag').style.background = _hex6(colorHex);
  el.classList.remove('hidden');
  return document.getElementById('rm-body');
}
function openHoldPanel(entry) {
  const tier = entry.tier || 'capital', ownerName = factionName(entry.owner);
  const body = _openRealmShell(entry.def.name, entry.owner.color); if (!body) return;
  const dist = Math.round(Math.hypot(entry.x - player.pos.x, entry.z - player.pos.z));
  const mine = ownerName === PLAYER_REALM.name;
  let econ = '';
  if (mine && window.net && window.net.holdings) {
    const h = window.net.holdings.find(r => (r.holdKey || r.hold_key) === entry.key);
    if (h) econ = '<div class="rm-row"><span>People</span><b>' + (h.population | 0) + '</b><span class="rm-dim">food ' + Math.round(h.food || 0) + ' · wood ' + Math.round(h.wood || 0) + '</span></div>';
  }
  body.innerHTML =
    '<div class="rm-sec">' +
    '<div class="rm-row"><span class="rm-tier">' + _esc(tier) + '</span><span class="rm-dim">' + dist + 'u away</span></div>' +
    '<div class="rm-row"><span>Sworn to</span><b style="color:' + _hex6(entry.owner.color) + '">' + _esc(ownerName) + '</b></div>' +
    '<div class="rm-row"><span>Garrison</span><b id="rm-gar">' + (entry.garrison != null ? Math.round(entry.garrison) : '—') + '</b></div>' +
    econ +
    '<button class="rm-btn" id="rm-march">March here</button>' +
    '</div><div class="rm-sec" id="rm-nation"><div class="rm-dim">asking the heralds…</div></div>';
  const mb = document.getElementById('rm-march');
  if (mb) mb.addEventListener('click', () => { orderMarch(entry.x, entry.z); closeRealmPanel(); });
  // refresh with the server's live row (ownership may have changed since the chunk streamed)
  if (window.net && window.net.loadHolds) window.net.loadHolds(entry.x, entry.z, 8).then(hs => {
    if (!hs) return;
    let best = null, bd = 1e9;
    for (const h of hs) { const d = Math.hypot(h.x - entry.x, h.z - entry.z); if (d < 4 && d < bd) { bd = d; best = h; } }
    if (!best) return;
    const gar = document.getElementById('rm-gar'); if (gar) gar.textContent = Math.round(best.garrison);
    if (best.owner && best.owner !== ownerName) fillNationSec(best.owner);
  }).catch(() => {});
  fillNationSec(ownerName);
}
function openNationPanel(name) {
  const fac = factionByName(name);
  const body = _openRealmShell(name, fac ? fac.color : 0x9aa0a6); if (!body) return;
  body.innerHTML = '<div class="rm-sec" id="rm-nation"><div class="rm-dim">asking the heralds…</div></div>';
  fillNationSec(name);
}
function fillNationSec(name) {
  const el = document.getElementById('rm-nation'); if (!el) return;
  const fac = factionByName(name);
  const head = '<div class="rm-row"><b style="color:' + _hex6(fac ? fac.color : 0x9aa0a6) + '">' + _esc(name) + '</b><span class="rm-dim">realm</span></div>';
  const fill = (info) => {
    let rows = '';
    if (info && info.capital) rows += '<div class="rm-row"><span>Capital</span><b>' + _esc(info.capital.defName) + '</b>' +
      (info.capital.owner && info.capital.owner !== info.capital.founder ? '<span class="rm-dim">held by ' + _esc(info.capital.owner) + '</span>' : '') + '</div>';
    if (info && info.holds && info.holds.total) rows += '<div class="rm-row"><span>Holds</span><b>' + info.holds.total + '</b><span class="rm-dim">' +
      (info.holds.city || 0) + ' cities · ' + (info.holds.town || 0) + ' towns · ' + (info.holds.village || 0) + ' villages</span></div>';
    if (info && info.armies != null && info.armies > 0) rows += '<div class="rm-row"><span>Hosts afield</span><b>' + info.armies + '</b></div>';
    if (info && info.state) rows += '<div class="rm-row"><span>Posture</span><b>' + _esc(info.state.posture || '—') + '</b><span class="rm-dim">weariness ' +
      Math.round(info.state.warWeariness != null ? info.state.warWeariness : (info.state.war_weariness || 0)) + '</span></div>';
    const rel = ((info && info.relations) || []).slice().sort((a, b) => Math.abs(b.opinion) - Math.abs(a.opinion)).slice(0, 6);
    if (rel.length) rows += '<div class="rm-sub">Relations</div>' + rel.map(r => {
      const other = r.a === name ? r.b : r.a, st = r.stance || 'neutral';
      return '<div class="rm-row"><span>' + _esc(other) + '</span><b class="rm-st rm-st-' + _esc(st) + '">' + _esc(st) + '</b><span class="rm-dim">' +
        (r.opinion > 0 ? '+' : '') + Math.round(r.opinion) + '</span></div>';
    }).join('');
    el.innerHTML = head + (rows || '<div class="rm-dim">a quiet power — little is written of it</div>');
  };
  if (window.net && window.net.loadNation && window.net.online) window.net.loadNation(name).then(fill).catch(() => fill(null));
  else fill(null);
}

// ---------- Map pins: yours at a glance ----------
// A pin marks what is YOURS on the map: your banner (gold), your other characters (gold), and
// every hold sworn to you (realm blue). Pins ride the chart + map rungs — bigger on the chart —
// and stand down at street level.
const PIN_C = { you: 0xffd34d, chars: 0xffcf5b, owned: 0x2f6fd0 };
const _ownedPins = new Map();          // hold entry -> its pin group
const _allPins = new Set();            // every live pin, for rung scaling + pruning
function makeMapPin(colorHex, s) {
  const g = new THREE.Group();
  const m = mat(colorHex);
  const needle = new THREE.Mesh(cachedGeo('pinNeedle', () => new THREE.ConeGeometry(0.4, 3.2, 8)), m);
  needle.rotation.x = Math.PI; needle.position.y = 1.6;                 // tip kisses the anchor point
  const head = new THREE.Mesh(cachedGeo('pinHead', () => new THREE.SphereGeometry(1.0, 10, 8)), m);
  head.position.y = 3.4;
  g.add(needle); g.add(head);
  g.userData.pinScale = s || 1;
  g.scale.setScalar(g.userData.pinScale);
  _allPins.add(g);
  return g;
}
function _pinRoot(o) { while (o.parent) o = o.parent; return o; }
function applyPinTier(tier) {
  for (const g of _allPins) {
    if (_pinRoot(g) !== scene) { _allPins.delete(g); continue; }        // its carrier left the world
    g.visible = tier !== 2;
    g.scale.setScalar(g.userData.pinScale * (tier === 0 ? 2.2 : 1));
  }
}
function refreshOwnedPins() {
  if (!mapTerrain) return;
  const live = new Set();
  for (const en of _allHoldEntries()) {
    if (!en.owner || factionName(en.owner) !== PLAYER_REALM.name) continue;
    live.add(en);
    if (_ownedPins.has(en)) continue;
    const spec = SG_SPEC[en.tier || 'capital'] || SG_SPEC.village;
    const pin = makeMapPin(PIN_C.owned, en.tier === 'village' ? 1.0 : 1.35);
    pin.position.set(en.x, mapElevY(en.x, en.z) + (spec.top || 5) + 2.5, en.z);
    mapTerrain.add(pin); _ownedPins.set(en, pin);
  }
  for (const [en, pin] of _ownedPins) if (!live.has(en)) { _allPins.delete(pin); if (pin.parent) pin.parent.remove(pin); _ownedPins.delete(en); }
  applyPinTier(_appliedTier);
}

// ---------- Strategic map: persistent capitals + streamed chunks ----------
function buildMapTerrain() {
  if (mapTerrain && mapTerrainLevel !== mapLevel) {  // a fresh region — tear the whole world down
    scene.remove(mapTerrain); disposeGroup(mapTerrain); mapTerrain = null;
    mapChunks.clear(); settlements.length = 0; heldOwners.clear(); _lastPlayerChunk = '';
    terrCells.clear(); terrGen = 0; terrGenT = 0; srvTerr.clear(); // a fresh region starts its territory anew
    _holdIcons.clear(); srvDetail.clear(); _srvDetailInflight.clear(); _terrRetessQ.length = 0; // tier layers died with mapTerrain — drop the refs
    _bubX = _bubZ = 1e9;                          // force a fresh bubble reconcile in the new region
    for (const n of nations) { n.iconGroup = null; n.streetGroup = null; }
    roadResetRegion();                            // the road network belongs to this region — drop it
  }
  if (!mapTerrain) {
    mapTerrain = new THREE.Group(); scene.add(mapTerrain);
    for (const n of nations) { n.group = makeCapital(n); recolorCapital(n); mapTerrain.add(n.group); } // capitals always loaded
    mapTerrainLevel = mapLevel;
  }
  mapTerrain.visible = true;
  ensureRoads(true);   // knit the roads FIRST (they need no chunks) — the streamed scatter then avoids them
  updateChunks(true);
}
// ============================================================================
// Terrain-aware procedural settlements (villages, towns, castles, capitals).
// Each place is READ from the land, CLASSIFIED (plain / knoll / hillside / ridge
// / valley / coastal), then authored by that class: villages & towns are organic
// clusters that follow the contours. A SETTLEMENT's outer outline (village footprint,
// town palisade, city wall) is an irregular, seed-driven blob (sgFootprint) — towns &
// cities accrete over generations, so no two share a shape — whereas a CASTLE's curtain
// wall is a tight, near-round iso-elevation CONTOUR MARCH around the keep — so the hill literally
// shapes its walls (a knoll → a tight ring; a hillside → a D-wall stepping down;
// a ridge → an elongated wall on the crest). Every element is seated on its OWN
// mapElevY with a foundation plinth, so nothing floats downhill or buries uphill.
// The whole place bakes into TWO merged flat-shaded meshes: a vertex-colored
// "structure" mesh (masonry/timber/thatch) and an owner-colored mesh (keep & hall
// roofs + banners) that the conquest recolor re-tints. Deterministic per site.
// ============================================================================
const TAU = Math.PI * 2;
// the engine's mat() never enables vertexColors (mat(0xffffff) would render solid
// white); use a dedicated shared material, exactly like the terrain tile meshes.
let SETTLE_VC_MAT = null;
function settleVCMat() {
  if (!SETTLE_VC_MAT) {
    SETTLE_VC_MAT = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 5, specular: 0x0a0a0a });
    SETTLE_VC_MAT.userData.cached = true; SETTLE_VC_MAT.userData.noTint = true;
  }
  return SETTLE_VC_MAT;
}
// unit primitives, de-indexed once so a merge is a plain vertex copy — THREE's own
// winding & normals come along for free (no hand-rolled box verts, no inverted faces).
function sgUnit(key, make) { return cachedGeo('sgU:' + key, () => { const g = make(), n = g.toNonIndexed(); g.dispose(); return n; }); }
const _sgM = new THREE.Matrix4(), _sgQ = new THREE.Quaternion(), _sgE = new THREE.Euler(),
      _sgP = new THREE.Vector3(), _sgScl = new THREE.Vector3(), _sgV = new THREE.Vector3(), _sgCol = new THREE.Color();
function sgPushGeo(buf, geo, m, col) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { _sgV.fromBufferAttribute(p, i).applyMatrix4(m); buf.pos.push(_sgV.x, _sgV.y, _sgV.z); buf.col.push(col[0], col[1], col[2]); }
}
function sgBox(buf, cx, cy, cz, w, h, d, yaw, col) {
  _sgM.compose(_sgP.set(cx, cy, cz), _sgQ.setFromEuler(_sgE.set(0, yaw, 0)), _sgScl.set(w, h, d));
  sgPushGeo(buf, sgUnit('box', () => new THREE.BoxGeometry(1, 1, 1)), _sgM, col);
}
function sgRoof(buf, cx, baseY, cz, w, h, d, yaw, col) {                 // 4-sided pyramidal roof, base at baseY
  _sgM.compose(_sgP.set(cx, baseY + h / 2, cz), _sgQ.setFromEuler(_sgE.set(0, yaw + Math.PI / 4, 0)), _sgScl.set(w, h, d));
  sgPushGeo(buf, sgUnit('roof4', () => new THREE.ConeGeometry(0.5, 1, 4)), _sgM, col);
}
function sgPrism(buf, cx, baseY, cz, rad, h, col) {                      // octagonal tower, base at baseY
  _sgM.compose(_sgP.set(cx, baseY + h / 2, cz), _sgQ.identity(), _sgScl.set(rad * 2, h, rad * 2));
  sgPushGeo(buf, sgUnit('cyl8', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 8)), _sgM, col);
}
function sgCone8(buf, cx, baseY, cz, rad, h, col) {                      // 8-sided conical cap
  _sgM.compose(_sgP.set(cx, baseY + h / 2, cz), _sgQ.identity(), _sgScl.set(rad * 2, h, rad * 2));
  sgPushGeo(buf, sgUnit('cone8', () => new THREE.ConeGeometry(0.5, 1, 8)), _sgM, col);
}
function sgMesh(buf, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf.pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(buf.col), 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material); m.castShadow = true; m.receiveShadow = true; return m;
}
function sgRgb(hex, j) { _sgCol.setHex(hex); return [_sgCol.r * j, _sgCol.g * j, _sgCol.b * j]; }
// biome-driven building palette (sandstone desert, dark timber forest, grey highland stone, ...)
function settlePalette(b) {
  const n = b.name;
  if (n === 'Desert')                       return { stone: 0xc9a878, stoneDk: 0xb09870, wood: 0x9a7a4a, thatch: 0xc2a96a, daub: 0xd8c89c };
  if (n === 'Forest' || n === 'Taiga')      return { stone: 0x8a8780, stoneDk: 0x6f6a60, wood: 0x563c26, thatch: 0x6f5a36, daub: 0x8f7d5c };
  if (n === 'Tundra' || n === 'Mountains')  return { stone: 0x9a9690, stoneDk: 0x7c786f, wood: 0x6a5a48, thatch: 0x80735f, daub: 0xa8a49c };
  if (n === 'Savanna' || n === 'Beach')     return { stone: 0xa89e88, stoneDk: 0x8a8068, wood: 0x7a5a36, thatch: 0xa89a5a, daub: 0xc2b080 };
  return { stone: 0x9a8f80, stoneDk: 0x7d7468, wood: 0x6b4a2e, thatch: 0x9a7b43, daub: 0xb9a888 };
}
// per-tier knobs.  houses/bailey are [base, randomRange] (count = base + r()*range|0).
// castles is [base, +1 chance]: village none; town one (occasionally a second); city 3-4; capital 4-5.
// A town is 3-4x a village's houses; a city 3-4x a town's, with a sparse castle-district centre.
// Per-tier spec + the whole probe/gates/streets family live in the Terra kernel — the road
// engine (server-side later) and the wall/house builders here MUST share one source of truth,
// or gates would drift off their roads. These shims keep the builders' call sites unchanged.
const SG_SPEC = Terra.SG_SPEC;
function sgProbe(X, Z, spec) { return terra().sgProbe(X, Z, spec); }
function sgFootprint(P) { return Terra.sgFootprint(P); }
function cityGateBearings(T, seed, x, z) { return terra().cityGateBearings(T, seed, x, z); }
function cityFlankerCastles(T, seed, spec, gateBearings) { return terra().cityFlankerCastles(T, seed, spec, gateBearings); }
function settlementStreetPlan(x, z, tier, seed) { return terra().settlementStreetPlan(x, z, tier, seed); }
function settlementGates(x, z, tier, seed) { return terra().settlementGates(x, z, tier, seed); }

// --- a building seated on its own grade, with a foundation plinth so it never floats/buries ---
function sgHouse(P, lx, lz, opts) {
  const { seat, pal, S } = P, r = P.r, big = !!opts.big, mh = P.mh || 1, mw = P.mw || 1;
  const w = ((big ? 2.0 : 0.95) + r() * (big ? 0.8 : 0.6)) * mw, d = w * (0.85 + r() * 0.5), h = ((big ? 1.9 : 0.9) + r() * (big ? 0.6 : 0.5)) * mh;
  const yaw = opts.yaw != null ? opts.yaw : r() * TAU, hw = w / 2, hd = d / 2;
  const c0 = seat(lx - hw, lz - hd), c1 = seat(lx + hw, lz - hd), c2 = seat(lx - hw, lz + hd), c3 = seat(lx + hw, lz + hd);
  const lo = Math.min(c0, c1, c2, c3), hi = Math.max(c0, c1, c2, c3);
  if (hi - lo > 3.5 * mw) return false;                                  // too steep a footprint — caller re-rolls (wider houses span more grade)
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

// --- a market cross (on slopes) or village well (on the flat) marking the heart ---
function sgFocalFeature(P) {
  const { T, pal, seat, S } = P, y = seat(0, 0), fm = P.street ? 2 : 1, street = (T.cls === 'HILLSIDE' || T.cls === 'RIDGE' || T.cls === 'COASTAL');
  if (street) { sgBox(S, 0, y + 0.9 * fm, 0, 0.16 * fm, 1.8 * fm, 0.16 * fm, 0, sgRgb(pal.wood, 1)); sgBox(S, 0, y + 1.5 * fm, 0, 0.9 * fm, 0.16 * fm, 0.16 * fm, 0, sgRgb(pal.wood, 1)); } // market cross
  else { sgPrism(S, 0, y - 0.1, 0, 0.45 * fm, 0.7 * fm, sgRgb(pal.stoneDk, 1)); sgBox(S, 0, y + 0.8 * fm, 0, 0.14 * fm, 0.5 * fm, 0.9 * fm, 0, sgRgb(pal.wood, 1)); } // well + winch
}
// --- street village: the ROAD is the village's spine. Houses gather in two rows flanking the roadbed
//     (the road engine lays the actual grey road on this same shared axis), the rest scatter as crofts
//     behind. The corridor itself stays clear, and the well/market cross stands at the crossing. ---
function sgBuildVillage(P) {
  const { r, spec, T, isW, placed } = P;
  // street level: an unwalled village may SPREAD (no wall/gate contract binds its footprint) —
  // rows sit farther off the axis, crofts range wider, and the roadbed corridor widens with the paint
  const sm = P.street ? 1.5 : 1, om = P.street ? 1.8 : 1, cm = P.street ? 2.2 : 1;
  const R = spec.R, n = spec.houses[0] + (r() * spec.houses[1] | 0);
  sgFocalFeature(P);
  const axis = (P.roadAxis != null) ? P.roadAxis
             : (T.cls === 'RIDGE') ? T.spineAz : T.downhill + Math.PI / 2;  // editor/capital fallback: contour street
  const ux = Math.cos(axis), uz = Math.sin(axis);
  let made = 0, tries = 0;
  while (made < n && tries < n * 10) {
    tries++; let lx, lz, yaw;
    if (r() < 0.78) {                                                       // street rows — the village front doors
      const t = (r() * 2 - 1) * R * 0.95 * sm, side = (tries & 1) ? 1 : -1, off = (1.9 + r() * 2.8) * om;
      lx = ux * t + -uz * side * off; lz = uz * t + ux * side * off;
      yaw = axis + (r() - 0.5) * 0.2;
    } else {                                                                // scattered crofts behind the rows
      const a = r() * TAU, maxR = Math.max(2.4, R * P.fp(a)) * sm, rd = 1.8 * sm + Math.sqrt(r()) * (maxR - 1.8 * sm);
      lx = Math.cos(a) * rd; lz = Math.sin(a) * rd; yaw = Math.atan2(-lz, -lx);
    }
    const dPerp = Math.abs(lx * uz - lz * ux), dAlong = Math.abs(lx * ux + lz * uz);
    if (dPerp < 1.6 * cm && dAlong < R * 1.25 * sm) continue;               // the roadbed itself stays clear
    if (Math.hypot(lx, lz) < 1.6 * cm || isW(lx, lz)) continue;
    if (!placed.every(p => (p.lx - lx) ** 2 + (p.lz - lz) ** 2 > spec.gap * spec.gap)) continue;
    if (sgHouse(P, lx, lz, { yaw })) { placed.push({ lx, lz }); made++; }
  }
  sgBanner(P, -uz * 2.4 * cm + ux * 1.2, ux * 2.4 * cm + uz * 1.2);         // the banner stands at the roadside
}

// --- plan castle centres: 0 (village), 1 + occasional 2nd (town), 3-4 (city), 4-5 (capital) ---
// The chief castle holds the centre; a town's extra keep sits off to one side, a city's lesser
// castles ring the heart so the middle reads as a sparse civic/castle district, not packed housing.
function sgPlanCastles(P) {
  const { r, spec } = P;
  const n = (spec.castles[0] | 0) + (r() < (spec.castles[1] || 0) ? 1 : 0);
  if (n <= 0) return [];
  const cR = spec.castleR || spec.R * 0.42, big = !!spec.bigKeep;
  const out = [{ cx: 0, cz: 0, cR, big }];
  if (n === 1) return out;
  if (spec.castles[0] === 1) {                                           // a town's occasional second keep
    for (let t = 0; t < 6; t++) {                                        // dry ground or no keep at all
      const a = r() * TAU, d = spec.R * 0.5, cx = Math.cos(a) * d, cz = Math.sin(a) * d;
      if (!P.isW(cx, cz)) { out.push({ cx, cz, cR: cR * 0.85, big: false }); break; }
    }
    return out;
  }
  // a stone hold: ONE keep at the heart + the two shared flankers on opposite sides (dry ground or none)
  const gb = cityGateBearings(P.T, P.seed, P.X, P.Z);
  for (const c of cityFlankerCastles(P.T, P.seed, spec, gb.big)) {
    if (!P.isW(c.cx, c.cz)) out.push({ cx: c.cx, cz: c.cz, cR: c.cR, big: false });
  }
  return out;
}
// --- houses filling the footprint around the castle(s), keeping clear of their reserved disks and
//     (for cities) a sparse central district. Radial scatter, faces turned inward toward the heart. ---
function sgFillHouses(P) {
  const { r, spec, isW, placed, exclude } = P, mw = P.mw || 1;
  const R = spec.R, n = spec.houses[0] + (r() * spec.houses[1] | 0);
  const inner = Math.max(2.0 * mw, (spec.centerClear || 0) * R);
  // street level: house CENTRES stay inside the same footprint, pulled in by the extra half-width
  // so the bigger walls don't poke through the (fixed) ring; corridors and frontages widen with the
  // painted roadbeds (STREET.roadWMul ≈ mw) — the checks below scale with mw for that reason.
  const edgePull = P.street ? 1.5 : 0, frontage = 4.6 * mw;
  const blocked = (lx, lz) => exclude.some(e => (e.lx - lx) ** 2 + (e.lz - lz) ** 2 < e.r * e.r);
  let made = 0, tries = 0;
  while (made < n && tries < n * 10) {
    tries++;
    const a = r() * TAU, maxR = Math.max(inner + 1, R * P.fp(a) - edgePull), rd = inner + Math.sqrt(r()) * (maxR - inner), lx = Math.cos(a) * rd, lz = Math.sin(a) * rd;
    if (isW(lx, lz) || blocked(lx, lz)) continue;
    let yaw = Math.atan2(-lz, -lx);
    if (P.streets && P.streets.length) {                     // the streets shape the town
      const sn = sgStreetNear(P, lx, lz);
      if (sn.d < sn.w * 0.5 + 0.9 * mw) continue;            // the roadbed stays clear
      if (sn.d > frontage && r() < 0.5) continue;            // crowd the frontages, thin the backlots
      if (sn.d < frontage) yaw = Math.atan2(sn.z - lz, sn.x - lx); // front doors open onto the street
    }
    if (!placed.every(p => (p.lx - lx) ** 2 + (p.lz - lz) ** 2 > spec.gap * spec.gap)) continue;
    if (sgHouse(P, lx, lz, { yaw })) { placed.push({ lx, lz }); made++; }
  }
}
// --- a castle-bearing hold (town / city / capital): castles + houses + an enclosing wall ---
// ---- the interior street plan: the SAME world plan the road engine draws, localised to the site frame,
// so corridors, frontages and the drawn roadbeds always agree. ----
function sgPlanStreets(P) {
  if (!P.spec.castle) return [];
  return settlementStreetPlan(P.X, P.Z, P.tier, P.seed)
    .map(st => ({ w: st.w, pts: st.pts.map(pt => ({ x: pt.x - P.X, z: pt.z - P.Z })) }));
}
// nearest point on the street plan (for corridors + frontage)
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
function sgBuildHold(P) {
  const { spec } = P;
  for (const C of sgPlanCastles(P)) sgBuildCastleAt(P, C);
  P.streets = sgPlanStreets(P);        // corridors + frontages; the ROAD ENGINE drapes the actual roadbeds
  sgFillHouses(P);
  if (spec.wall === 'stone') sgCityWall(P);
  else if (spec.wall === 'palisade') sgPalisade(P);
}
// --- the organic footprint of a SETTLEMENT (town/city/village).  A castle's curtain is a tight planned
//     ring (sgCurtainMarch keeps it round); a town/city, by contrast, ACCRETES over generations, so its
// smallest radius scale R so that, stretched by the footprint fp(a), the ring clears every placed
// building by `margin`. Lets the town/city wall hug the irregular cluster instead of a fat circle.
function sgWallEnvelope(P, margin, minR) {
  const { placed, fp } = P;
  let Rfit = minR;
  for (const p of placed) { const a = Math.atan2(p.lz, p.lx), f = fp(a); if (f > 0.01) Rfit = Math.max(Rfit, (Math.hypot(p.lx, p.lz) + margin) / f); }
  return Rfit;
}
function sgPalisade(P) {                                                 // a timber ring fitted around the built cluster, gate downhill
  const { r, T, pal, seat, S, fp } = P, mh = P.mh || 1, mw = P.mw || 1;
  // street level pins the ring to the KERNEL's radius (spec.R + margin/0.8 — the exact ring
  // settlementGates hands the road engine) instead of hugging the re-laid houses, so the drawn
  // roads still enter at the gateposts; posts pack denser because each is far stouter.
  const Rfit = P.street ? Math.max(3.0, P.spec.R + 1.5 / 0.8) : sgWallEnvelope(P, 1.5, 3.0);
  const N = Math.max(14, Math.round(Rfit * 1.4 * 1.2 * (P.street ? 1.25 : 1))), wood = sgRgb(pal.wood, 1);
  const gateA = cityGateBearings(T, P.seed, P.X, P.Z).big[0];              // the shared (dry-rotated) gate bearing
  for (let k = 0; k < N; k++) {
    const a = k / N * TAU;
    if (Math.abs(((a - gateA + Math.PI) % TAU + TAU) % TAU - Math.PI) < 0.34) continue; // gate gap
    const R = Rfit * fp(a), lx = Math.cos(a) * R, lz = Math.sin(a) * R, y = seat(lx, lz);
    if (P.isW(lx, lz)) continue;                                         // the stockade stops at the water
    sgBox(S, lx, y + 0.85 * mh, lz, 0.34 * mw, (1.6 + r() * 0.2) * mh, 0.34 * mw, a, wood);
  }
  for (const sgn of [-0.4, 0.4]) {                                       // stout gateposts so the town gate reads from the map
    const a2 = gateA + sgn * 0.34, R2 = Rfit * fp(a2), lx = Math.cos(a2) * R2, lz = Math.sin(a2) * R2, y = seat(lx, lz);
    sgPrism(S, lx, y - 0.3, lz, 0.55 * mw, 3.1 * mh + 0.3, sgRgb(pal.wood, 0.85));
    sgCone8(S, lx, y - 0.3 + 3.1 * mh + 0.3, lz, 0.68 * mw, 0.7 * mh, sgRgb(pal.stoneDk, 1));
  }
}
// GRAND GATEHOUSE — stone arch over tall timber doors, twin flanking watchtowers. ONE recipe shared by
// the city wall ring (sgCityWall) and the editor's standalone ?edit=gate stage, so an edit shows in both.
// towerAt(sgn) supplies each watchtower's ground spot — the ring curves, a lone gate's wall runs straight.
function sgGatehouse(S, lx, lz, ang, seat, wallH, thick, pal, towerAt, mh, mw) {
  mh = mh || 1; mw = mw || 1;                                            // street-level multipliers (1 = today's miniature)
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1), woodD = sgRgb(pal.wood, 0.72);
  const y = seat(lx, lz), doorH = wallH + 1.6 * mh, doorW = 2.8 * mw;
  sgBox(S, lx, y + wallH + 0.7 * mh, lz, doorW + 1.0 * mw, 0.95 * mh, thick * 1.8, ang, stoneDk);
  sgBox(S, lx, y + doorH / 2, lz, doorW, doorH, 0.5 * mw, ang, woodD);
  for (const sgn of [-1, 1]) {
    const [tx, tz] = towerAt(sgn), ty = seat(tx, tz), th2 = wallH + 3.8 * mh;
    sgPrism(S, tx, ty - 0.7, tz, 1.34 * mw, th2 + 0.7, stone);
    sgCone8(S, tx, ty - 0.7 + th2 + 0.7, tz, 1.6 * mw, 1.5 * mh, stoneDk);
  }
}
// a lone city gate for the object editor (?edit=gate): a straight stretch of the great stone wall —
// bays + level parapet + end drum towers — broken by the grand gatehouse, so the gate is the subject.
function buildCityGate() {
  const pal = settlePalette(biomeAt(0, 0)), S = { pos: [], col: [] };
  const wallH = (SG_SPEC.city.wallH || 1.7) + 0.4, thick = 0.7, seat = () => 0;
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1);
  const L = 13, gap = 3.4;                                               // the ring leaves this same ±3.4 opening at a gate
  for (const sgn of [-1, 1]) {
    const mx = sgn * (gap + L) / 2, len = L - gap, top = wallH, bot = -0.9;
    sgBox(S, mx, (top + bot) / 2, 0, len, top - bot, thick, 0, stone);
    sgBox(S, mx, top + 0.16, 0, len, 0.3, thick * 1.15, 0, stoneDk);     // level parapet cap
    const th = wallH + 1.0;                                              // a drum tower bookends each stretch
    sgPrism(S, sgn * L, -0.7, 0, 0.8, th + 0.7, stone);
    sgCone8(S, sgn * L, -0.7 + th + 0.7, 0, 0.94, 0.85, stoneDk);
  }
  sgGatehouse(S, 0, 0, 0, seat, wallH, thick, pal, sgn => [sgn * 2.95, 0]);
  const g = new THREE.Group(); g.add(sgMesh(S, settleVCMat())); return g;
}
// A great stone city wall ringing the whole footprint: terrain-seated bays with a level parapet,
// drum towers round the ring, and three gatehouses (downhill + two flanks) so the city can be entered.
function sgCityWall(P) {
  const { r, T, pal, seat, S, spec, fp } = P, mh = P.mh || 1, mw = P.mw || 1, tw = P.street ? 1.6 : 1;
  // street level pins the ring to the KERNEL's radius (spec.R + margin/0.8 — exactly where
  // settlementGates puts the gates for the road engine); the miniature keeps hugging its houses.
  const Rfit = P.street ? Math.max(spec.R * 0.5, spec.R + 2.6 / 0.8) : sgWallEnvelope(P, 2.6, spec.R * 0.5);
  const Rmax = Rfit * 1.4, RA = a => Rfit * fp(a);                       // ring follows the lumpy footprint
  const wallH = ((spec.wallH || 1.7) + 0.4) * mh, thick = 0.7 * mw, N = Math.max(30, Math.round(Rmax * 1.3));
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1), woodD = sgRgb(pal.wood, 0.72);
  // gate bearings come from the SHARED helper — the road engine lands its roads on these exact openings:
  // three grand gatehouses for the big roads, two-three posterns for the lanes.
  const gb = cityGateBearings(T, P.seed, P.X, P.Z), gateAngs = gb.big, postAngs = gb.small;
  const nearGate = a => gateAngs.reduce((m, g) => Math.min(m, _angD(a, g)), 9);
  const nearPost = a => postAngs.reduce((m, g) => Math.min(m, _angD(a, g)), 9);
  const V = [];
  for (let k = 0; k < N; k++) {                                          // wet verts pull ASHORE — the ring stays closed
    const a = k / N * TAU; let R = RA(a), lx = Math.cos(a) * R, lz = Math.sin(a) * R;
    while (P.isW(lx, lz) && R > RA(a) * 0.45) { R -= 1.2; lx = Math.cos(a) * R; lz = Math.sin(a) * R; }
    V.push({ a, lx, lz, y: seat(lx, lz), R });
  }
  for (let i = 0; i < N; i++) {                                          // closed ring of seated wall bays; ONLY gates + posterns open it
    const A = V[i], B = V[(i + 1) % N], am = A.a + (((B.a - A.a) + TAU) % TAU) / 2;
    const gapR = (A.R + B.R) / 2 || 1;
    if (nearGate(am) < 3.4 * mw / gapR || nearPost(am) < 1.35 * mw / gapR) continue; // the opening is exactly the gatehouse, not a breach
    const mx = (A.lx + B.lx) / 2, mz = (A.lz + B.lz) / 2;
    if (P.isW(mx, mz)) continue;                                         // true open water (a deep bay) — the one honest gap
    const ang = Math.atan2(-(B.lz - A.lz), B.lx - A.lx), len = Math.hypot(B.lx - A.lx, B.lz - A.lz) + thick;
    const lo = Math.min(A.y, B.y), hi = Math.max(A.y, B.y), top = hi + wallH, bot = lo - 0.9 * mh;
    sgBox(S, mx, (top + bot) / 2, mz, len, top - bot, thick, ang, stone);
    sgBox(S, mx, top + 0.16 * mw, mz, len, 0.3 * mw, thick * 1.15, ang, stoneDk); // level parapet cap
  }
  const TN = Math.max(10, Math.round(Rmax * 0.45));                      // drum towers round the ring (gatehouses get their own)
  for (let k = 0; k < TN; k++) {
    const a = k / TN * TAU, R0 = RA(a);
    if (nearGate(a) < 5.0 * mw / (R0 || 1)) continue;                    // stand clear of the twin watchtowers
    let R = R0, lx = Math.cos(a) * R, lz = Math.sin(a) * R;
    while (P.isW(lx, lz) && R > R0 * 0.45) { R -= 1.2; lx = Math.cos(a) * R; lz = Math.sin(a) * R; }
    if (P.isW(lx, lz)) continue;
    const y = seat(lx, lz), th = wallH + 1.0 * mh;
    sgPrism(S, lx, y - 0.7, lz, 0.8 * tw, th + 0.7, stone); sgCone8(S, lx, y - 0.7 + th + 0.7, lz, 0.94 * tw, 0.85 * mh, stoneDk);
  }
  for (const ga of gateAngs) {                                          // GRAND GATEHOUSE on the ring (recipe: sgGatehouse)
    const d = 0.06, ax = Math.cos(ga - d) * RA(ga - d), az = Math.sin(ga - d) * RA(ga - d), bx = Math.cos(ga + d) * RA(ga + d), bz = Math.sin(ga + d) * RA(ga + d);
    const R = RA(ga), lx = Math.cos(ga) * R, lz = Math.sin(ga) * R, ang = Math.atan2(-(bz - az), bx - ax);
    const dt = 2.95 * mw / Math.max(4, R);                               // watchtower arc offset: doorW/2 + 1.55
    sgGatehouse(S, lx, lz, ang, seat, wallH, thick, pal,
      sgn => { const a2 = ga + sgn * dt, R2 = RA(a2); return [Math.cos(a2) * R2, Math.sin(a2) * R2]; }, mh, mw);
  }
  for (const pa of postAngs) {                                          // POSTERN: a narrow door with flanking posts for the small roads
    const d = 0.03, ax = Math.cos(pa - d) * RA(pa - d), az = Math.sin(pa - d) * RA(pa - d), bx = Math.cos(pa + d) * RA(pa + d), bz = Math.sin(pa + d) * RA(pa + d);
    const R = RA(pa), lx = Math.cos(pa) * R, lz = Math.sin(pa) * R, y = seat(lx, lz), ang = Math.atan2(-(bz - az), bx - ax);
    sgBox(S, lx, y + wallH * 0.62, lz, 1.6 * mw, 0.55 * mh, thick * 1.5, ang, stoneDk);
    sgBox(S, lx, y + wallH * 0.28, lz, 1.15 * mw, wallH * 0.56, 0.4 * mw, ang, woodD);
    const pd = 1.15 * mw / Math.max(4, R);
    for (const sgn of [-1, 1]) {                                        // squat towers so the postern reads from the map
      const a2 = pa + sgn * pd, R2 = RA(a2), tx = Math.cos(a2) * R2, tz = Math.sin(a2) * R2, ty = seat(tx, tz);
      sgPrism(S, tx, ty - 0.5, tz, 0.62 * tw, wallH + 1.5 * mh, stone);
      sgCone8(S, tx, ty - 0.5 + wallH + 1.5 * mh, tz, 0.74 * tw, 0.7 * mh, stoneDk);
    }
  }
}

// --- a single castle seated at (C.cx, C.cz): keep on the high ground + a curtain wall marched to the
//     contour, an inner bailey (first building a great hall), gate banners, and a reserved exclusion
//     disk so the surrounding houses keep clear of it. ---
function sgBuildCastleAt(P, C) {
  const { r, spec, T, pal, ownerRGB, O, placed, exclude } = P, mw = P.mw || 1;
  const keep = sgFindKeep(P, C.cx, C.cz, C.cR * 0.3);                    // highest buildable cell near the castle's centre
  const DROP = 2.2 + (r() - 0.5) * 1.2;
  const NW = Math.max(10, Math.round(C.cR * 2));
  const verts = sgCurtainMarch(P, keep, DROP, NW, C.cR);                 // the RING is tier-invariant: same march both tiers
  const gates = sgPickGates(verts, cityGateBearings(T, P.seed, P.X, P.Z).big[0]); // the keep's main gate faces the artery, like every other gate
  sgBuildCurtain(P, verts, gates);
  P._cR = C.cR;                                                          // the keep sizes its street-level footprint to its ring
  sgBuildKeep(P, keep, C.big);
  // inner bailey buildings, dart-thrown inside the wall, the first a great hall
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
  for (const gi of gates) sgBanner(P, verts[gi].lx, verts[gi].lz);      // a banner over each gate
  const wallR = Math.max.apply(null, verts.map(v => v.rd));
  exclude.push({ lx: keep.lx, lz: keep.lz, r: wallR + 1.4 * mw });      // keep town/city houses off the castle
}
function sgFindKeep(P, cx, cz, searchR) {
  const { seat } = P; cx = cx || 0; cz = cz || 0; searchR = searchR || P.spec.R * 0.2;  // keep near the castle centre so it sits well inside the snug curtain
  let best = { lx: cx, lz: cz, y: seat(cx, cz) };
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU, lx = cx + Math.cos(a) * searchR, lz = cz + Math.sin(a) * searchR, y = seat(lx, lz); if (y > best.y) best = { lx, lz, y }; }
  return best;
}
// March a ray out from the keep along each spoke; the hill decides where it falls away. But a curtain
// wall is an ENCLOSURE meant to keep people out, so the result is kept near-CIRCULAR: terrain only
// gently modulates the radius around a common base, instead of a spiky star whose deep notches read as
// disjoint, parallel wall runs. Always a single simple closed loop (star-shaped about the keep).
function sgCurtainMarch(P, keep, DROP, NW, cR) {
  const { seat, T, r } = P;
  const platY = keep.y - DROP, minR = cR * 0.78, maxR = cR * 1.12, jit = (r() - 0.5) * 0.25; // a snug curtain hugging the keep+bailey, not a vast ring out at the footprint edge
  const rad = new Array(NW), ang = new Array(NW);
  for (let k = 0; k < NW; k++) {
    const a = k / NW * TAU + jit; ang[k] = a; let rd = minR;
    while (rd < maxR) {
      const wx = keep.lx + Math.cos(a) * rd, wz = keep.lz + Math.sin(a) * rd;
      if (P.isW(wx, wz)) break;                                          // the wall never wades into the sea
      const y = seat(wx, wz); if (y < platY || y > keep.y + 1.4) break;
      rd += 0.6;
    }
    rad[k] = clamp(rd, minR, maxR);
  }
  // base radius = size of the defensible platform; pull every spoke toward it and clamp the deviation,
  // so the wall is a clean closed ring that bulges/contracts gently with the ground — never spikes.
  let base = rad.reduce((s, v) => s + v, 0) / NW;
  if (T.relief < 0.8) base = (minR + maxR) / 2;                          // true plain → a clean circle
  for (let k = 0; k < NW; k++) rad[k] = clamp(base * 0.6 + rad[k] * 0.4, base * 0.88, base * 1.12);
  if (T.cls === 'RIDGE') for (let k = 0; k < NW; k++) rad[k] = clamp(rad[k] * (1 + 0.3 * Math.abs(Math.cos(ang[k] - T.spineAz))), base * 0.8, base * 1.5); // a gentle oval along the crest, not a thin lozenge
  const med = new Array(NW);                                             // 2-pass smooth (median then mean) for a smooth, closed perimeter
  for (let k = 0; k < NW; k++) { const a = rad[(k - 1 + NW) % NW], b = rad[k], c = rad[(k + 1) % NW]; med[k] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); }
  for (let k = 0; k < NW; k++) rad[k] = 0.25 * med[(k - 1 + NW) % NW] + 0.5 * med[k] + 0.25 * med[(k + 1) % NW];
  const verts = [];
  for (let k = 0; k < NW; k++) {
    let rd = rad[k], lx = keep.lx + Math.cos(ang[k]) * rd, lz = keep.lz + Math.sin(ang[k]) * rd;
    while (rd > minR * 0.55 && P.isW(lx, lz)) { rd -= 0.6; lx = keep.lx + Math.cos(ang[k]) * rd; lz = keep.lz + Math.sin(ang[k]) * rd; } // smoothing may have pushed it wet — pull ashore
    verts.push({ a: ang[k], rd, lx, lz, y: seat(lx, lz) });
  }
  return verts;
}
// a castle has at least TWO gates so it can be entered. The main gate faces the gentlest (downhill)
// approach; the second sits on the lowest wall foot, well away from the first (the other natural way in).
function sgPickGates(verts, downhill) {
  const N = verts.length;
  let g1 = 0, bd = 1e9;
  for (let i = 0; i < N; i++) { const d = Math.abs(((verts[i].a - downhill + Math.PI) % TAU + TAU) % TAU - Math.PI); if (d < bd) { bd = d; g1 = i; } }
  let g2 = (g1 + (N >> 1)) % N, bestY = 1e9;
  for (let i = 0; i < N; i++) {
    const da = Math.abs(((verts[i].a - verts[g1].a + Math.PI) % TAU + TAU) % TAU - Math.PI);
    if (da < TAU * 0.27) continue;                                       // keep the two gates well apart
    if (verts[i].y < bestY) { bestY = verts[i].y; g2 = i; }
  }
  return [g1, g2];
}
// stepped-level bays: each segment's base follows the two seated corner heights (battered down to a
// buried sill, no gap); its parapet holds level, so the wall steps down the hill bay by bay. Gate bays
// are left open under a stone arch with tall timber doors, flanked by taller, thicker gatehouse towers.
function sgBuildCurtain(P, verts, gates) {
  const { pal, S, r, spec } = P, N = verts.length, mh = P.mh || 1, mw = P.mw || 1, tw = P.street ? 1.5 : 1;
  const wallH = spec.wallH * mh, thick = 0.55 * mw;
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1), wood = sgRgb(pal.wood, 1);
  const isGate = i => gates.indexOf(i) >= 0, gateTower = new Set();
  for (const gi of gates) { gateTower.add(gi); gateTower.add((gi + 1) % N); }
  for (let i = 0; i < N; i++) {
    const A = verts[i], B = verts[(i + 1) % N];
    const mx = (A.lx + B.lx) / 2, mz = (A.lz + B.lz) / 2, ang = Math.atan2(-(B.lz - A.lz), B.lx - A.lx), len = Math.hypot(B.lx - A.lx, B.lz - A.lz) + thick * 1.8; // yaw must be atan2(-dz,dx): THREE's Y-rotation maps +X to (cos,−sin) — so each bay lies ALONG its edge (no reflected, gapped walls)
    const lo = Math.min(A.y, B.y), hi = Math.max(A.y, B.y), top = hi + wallH, bot = lo - 0.8 * mh;
    if (isGate(i)) {                                                     // a giant gateway: a stone arch over tall timber double doors
      const doorH = wallH + 1.6 * mh, doorW = len * 0.8, doorRGB = sgRgb(pal.wood, 0.72);
      sgBox(S, mx, top + 0.25 * mh, mz, len + thick, 0.95 * mh, thick * 1.7, ang, stoneDk);  // arch/lintel spanning the opening
      sgBox(S, mx, lo + doorH / 2, mz, doorW, doorH, 0.45 * mw, ang, doorRGB);          // the double doors
      sgBox(S, mx, lo + doorH * 0.30, mz, doorW * 1.03, 0.18 * mw, 0.55 * mw, ang, stoneDk); // iron bands
      sgBox(S, mx, lo + doorH * 0.70, mz, doorW * 1.03, 0.18 * mw, 0.55 * mw, ang, stoneDk);
      sgBox(S, mx, lo + doorH / 2, mz, 0.12 * mw, doorH * 0.9, 0.6 * mw, ang, stoneDk);      // seam between the two leaves
      for (const c of [A, B]) {                                                    // twin turrets — the castle gate reads like a gate
        sgPrism(S, c.lx, c.y - 0.5, c.lz, 0.62 * tw, wallH + 2.1 * mh, stone);
        sgCone8(S, c.lx, c.y - 0.5 + wallH + 2.1 * mh, c.lz, 0.74 * tw, 0.7 * mh, stoneDk);
      }
      continue;
    }
    sgBox(S, mx, (top + bot) / 2, mz, len, top - bot, thick, ang, stone);
    sgBox(S, mx, top + 0.16 * mw, mz, len, 0.32 * mw, thick * 1.15, ang, stoneDk); // level parapet cap
  }
  for (let i = 0; i < N; i++) {                                          // drum towers at every vertex, taller & thicker at the gates
    const v = verts[i], gate = gateTower.has(i), th = wallH + ((gate ? 2.2 : 0.9) + r() * 0.4) * mh, rad = (gate ? 1.05 : 0.78) * tw;
    sgPrism(S, v.lx, v.y - 0.7, v.lz, rad, th + 0.7, stone);
    sgCone8(S, v.lx, v.y - 0.7 + th + 0.7, v.lz, rad * 1.18, (gate ? 1.2 : 0.9) * mh, stoneDk);
  }
}
function sgBuildKeep(P, keep, big) {
  const { pal, ownerRGB, S, O, seat } = P, mh = P.mh || 1;
  // the street-level keep grows tall with mulH but its FOOTPRINT is clamped so the motte plinth
  // still fits inside the (tier-invariant) curtain ring — a slender donjon, which is the real shape
  const kw0 = big ? 3.2 : 2.6;
  const km = P.street ? Math.min(P.mw, ((P._cR || 6) * 0.62) / (kw0 * 0.775)) : 1;
  const stone = sgRgb(pal.stone, 1), stoneDk = sgRgb(pal.stoneDk, 1);
  const kw = kw0 * km, kh = (big ? 5.0 : 4.0) * mh, hw = kw * 0.75;
  const c = [seat(keep.lx - hw, keep.lz - hw), seat(keep.lx + hw, keep.lz - hw), seat(keep.lx - hw, keep.lz + hw), seat(keep.lx + hw, keep.lz + hw)];
  const lo = Math.min.apply(null, c), hiC = Math.max.apply(null, c), floorY = hiC + 0.05;
  sgBox(S, keep.lx, (lo - 0.3 + floorY) / 2, keep.lz, kw * 1.55, floorY - (lo - 0.3), kw * 1.55, 0, stoneDk); // motte/plinth
  if (hiC - lo > 2.5) for (let k = 0; k < 5; k++) { const a = k / 5 * TAU, rr = kw * 0.85; sgBox(S, keep.lx + Math.cos(a) * rr, lo + 0.2, keep.lz + Math.sin(a) * rr, 1.1 * km, 0.9 * km, 1.1 * km, a, stoneDk); } // rocky crag skirt on steep keeps
  sgBox(S, keep.lx, floorY + kh / 2, keep.lz, kw, kh, kw, 0, stone);     // donjon
  const top = floorY + kh;
  for (let i = -1; i <= 1; i++) for (const az of [-kw * 0.5, kw * 0.5]) { sgBox(S, keep.lx + i * kw * 0.34, top + 0.25 * km, keep.lz + az, kw * 0.2, 0.5 * km, kw * 0.2, 0, stoneDk); sgBox(S, keep.lx + az, top + 0.25 * km, keep.lz + i * kw * 0.34, kw * 0.2, 0.5 * km, kw * 0.2, 0, stoneDk); } // merlons
  sgRoof(O, keep.lx, top + 0.05, keep.lz, kw * 0.85, (big ? 1.4 : 1.1) * km, kw * 0.85, 0, ownerRGB); // owner roof
  const ph = top + (big ? 2.6 : 2.1) * km;
  sgBox(S, keep.lx, top + (ph - top) / 2, keep.lz, 0.15 * km, ph - top, 0.15 * km, 0, sgRgb(pal.wood, 1));
  sgBox(O, keep.lx + 0.5 * km, ph - 0.5 * km, keep.lz, 0.95 * km, 0.6 * km, 0.08 * km, 0, ownerRGB); // great banner
}
// The one terrain-aware builder behind every settlement and capital. Returns a THREE.Group
// seated at (X, refY, Z); g.userData.ownerMats (the owner-colored material) recolors on conquest.
function buildSettlementGroup(X, Z, tier, name, ownerColor, seed, opts) {
  const r = _mulberry32(seed >>> 0);
  const street = !!(opts && opts.detail === 'street');
  const spec0 = SG_SPEC[tier] || SG_SPEC.village;
  // STREET LEVEL: fewer, far bigger houses on the SAME footprint. Everything positional that other
  // systems depend on is untouched — R, castle centres, gate bearings, street plans — so roads still
  // meet walls exactly at gates; only counts, spacing and the primitive dimensions change.
  const spec = street ? { ...spec0,
      houses: [Math.max(3, Math.round(spec0.houses[0] * STREET.countMul)), Math.max(1, Math.round(spec0.houses[1] * STREET.countMul))],
      bailey: spec0.bailey ? [Math.max(1, Math.round(spec0.bailey[0] * 0.5)), Math.max(1, Math.round(spec0.bailey[1] * 0.5))] : undefined,
      gap: spec0.gap * STREET.gapMul } : spec0;
  const T = sgProbe(X, Z, spec), refY = T.refY;
  const seat = (lx, lz) => T.Y(X + lx, Z + lz) - refY;                   // local Y on the real ground (relative to the site centre)
  const isW = (lx, lz) => isWater(X + lx, Z + lz);
  const pal = settlePalette(biomeAt(X, Z)), ownerRGB = sgRgb(ownerColor, 1);
  const S = { pos: [], col: [] }, O = { pos: [], col: [] };
  const P = { r, tier, spec, X, Z, refY, T, pal, ownerRGB, seat, isW, S, O, placed: [], exclude: [], seed, roadAxis: opts && opts.roadAxis,
              street, mh: street ? STREET.mulH : 1, mw: street ? STREET.mulW : 1 };
  P.fp = sgFootprint(P);                                                 // this site's own organic outline (towns/cities/villages grow irregularly; the castle curtain stays round)
  if (spec.castle) sgBuildHold(P); else sgBuildVillage(P);
  const g = new THREE.Group();
  if (S.pos.length) g.add(sgMesh(S, settleVCMat()));
  const ownerMats = [], om = mat(ownerColor, { shared: false }); ownerMats.push(om);
  if (O.pos.length) g.add(sgMesh(O, om));
  const label = makeNameSprite(name);
  label.scale.set(spec.lbl, spec.lbl / 8, 1); label.position.y = spec.top * (street ? 2 : 1); g.add(label);
  g.userData.ownerMats = ownerMats; g.userData.label = label;
  g.userData.dbg = { buildings: P.placed.length, castles: P.exclude.length, R: spec.R, cls: T.cls };
  g.position.set(X, refY, Z);
  return g;
}

// A nation capital: the grandest castle of all, fitted to its hill like every other hold.
function makeCapital(cap) {
  const seed = (Math.imul(Math.round(cap.x) | 0, 73856093) ^ Math.imul(Math.round(cap.z) | 0, 19349663) ^ (worldSeed() >>> 0)) >>> 0;
  return buildSettlementGroup(cap.x, cap.z, 'capital', cap.def.name, cap.owner.color, seed);
}
// repaint a hold's banners/roofs to its current owner (after a conquest) — street twin included
function recolorCapital(cap) {
  for (const g of [cap.group, cap.streetGroup]) {
    if (!g) continue;
    for (const m of g.userData.ownerMats) m.color.setHex(cap.owner.color);
  }
}

// A streamed settlement: a village is a small organic, contour-following cluster (10-15 houses);
// a town is 3-4x that around a central castle (sometimes two) inside a palisade; a city is 3-4x a
// town again — a sparse castle-district centre with 3-4 keeps, ringed by dense housing and a great
// stone wall. Banner/roof materials are per-hold and mutable, so a conquered settlement re-flies
// the conqueror's colors (recolorCapital). All terrain-aware via buildSettlementGroup above.
function makeSettlement(hold) {
  const s = hold.site;
  const seed = (_chunkHash(s.cx, s.cz) ^ (Math.imul(s.idx + 3, 0x9E3779B1) >>> 0)) >>> 0;
  // a village is built AROUND ITS ROAD: the road engine draws the actual roadbed on this same axis
  const opts = hold.tier === 'village' ? { roadAxis: villageRoadAxis(s) } : null;
  return buildSettlementGroup(hold.x, hold.z, hold.tier, hold.def.name, hold.owner.color, seed, opts);
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

// ---------- The player's army on the strategic map: marching columns ----------
// The lead column (the men riding with you) and each detachment are drawn as a banner over a small
// cluster of WALKING soldiers — reusing the battle humanoid rig + walk cycle. The floating count
// carries the TRUE size; only COLUMN_CAP bodies are ever drawn, so a 200-strong host still costs 6.
const COLUMN_CAP = 6;            // marcher bodies drawn per column (the label carries the real size)
const MAX_DETACH = 6;            // detachments the player may field at once
const COLUMN_LOD2 = 95 * 95;     // beyond this (sq dist from the player) a column shows banner-only
const COLUMN_SCALE = 0.6;        // marcher size under the ~4.4-tall banner

// a banner on a pole: pole + cloth flag + gold trim (the player's colours)
function makeBanner(color) {
  const g = new THREE.Group();
  const h = 4.4;
  const pole = boxMesh(0.2, h, 0.2, mat(0x2a1d10)); pole.position.y = h / 2; g.add(pole);
  const flag = boxMesh(1.8, 1.1, 0.08, mat(color)); flag.position.set(1.0, h - 0.62, 0); g.add(flag);
  const trim = boxMesh(1.8, 0.16, 0.1, mat(0xffd34d)); trim.position.set(1.0, h - 1.18, 0); g.add(trim);
  return g;
}
// set/replace a column's floating count label (disposes the old sprite's texture)
function setColumnLabel(g, text) {
  const old = g.userData.label;
  if (old) { g.remove(old); if (old.material) { if (old.material.map) old.material.map.dispose(); old.material.dispose(); } }
  const label = makeNameSprite(text);
  label.scale.set(Math.min(5.2, 2.6 + text.length * 0.13), 0.62, 1); label.position.y = 5.2; g.add(label);
  g.userData.label = label;
}
// build a marching column from a class-composition: a banner + up to COLUMN_CAP walking soldiers,
// drawn from the class mix. Reuses buildHumanoid + makeAnimator/walkLegs (the battle rig + walk cycle).
function makeColumn(comp, color, labelText) {
  const g = new THREE.Group();
  g.add(makeBanner(color));
  const total = WARBAND_KEYS.reduce((s, k) => s + (comp[k] || 0), 0);
  // proportionally fill the visible slots from the class mix (each present class shows at least once)
  const slots = [];
  if (total > 0) {
    const cap = Math.min(COLUMN_CAP, total);
    for (const k of WARBAND_KEYS) {
      if (!comp[k]) continue;
      const n = Math.max(1, Math.round(cap * comp[k] / total));
      for (let i = 0; i < n && slots.length < cap; i++) slots.push(k);
    }
    while (slots.length < cap) slots.push('sword');
  }
  const marchers = [];
  slots.forEach((k, i) => {
    const def = ALLY_DEF_BY_CLASS[k];
    const hum = buildHumanoid(ALLY_PALETTES[i % ALLY_PALETTES.length], COLUMN_SCALE, def.weapon);
    const row = Math.floor(i / 2), col = i % 2;
    hum.group.position.set((col - 0.5) * 1.0, 0, -1.1 - row * 0.95); // trail behind the banner (local -z = back)
    const anim = makeAnimator(hum.parts);
    setPose(anim, 'guard'); updateAnimator(anim, 1); // settle the arms into a readied stance once
    g.add(hum.group);
    marchers.push({ parts: hum.parts, group: hum.group, phase: Math.random() * Math.PI * 2 });
  });
  g.userData.marchers = marchers;
  if (labelText != null) setColumnLabel(g, labelText);
  return g;
}
// walk the soldiers when the column moves; settle them when it halts (skips banner-only / hidden bodies)
function animateColumn(g, moving, dt) {
  const ms = g.userData.marchers; if (!ms) return;
  for (const m of ms) {
    if (!m.group.visible) continue;
    if (moving) { m.phase += dt * 8; walkLegs(m.parts, m.phase, 0.5); }
    else restLegs(m.parts, dt, false);
  }
}
// distance LOD: far columns drop their bodies and show only the banner + count
function columnLOD(g, distSq) {
  const ms = g.userData.marchers; if (!ms) return;
  const show = distSq < COLUMN_LOD2;
  for (const m of ms) if (m.group.visible !== show) m.group.visible = show;
}

// ---------- The player's detachments: split off the lead column, roam, then merge back ----------
function setDetVisible(v) { for (const d of detachments) { if (d.group) d.group.visible = v; if (d.routeMesh) d.routeMesh.visible = v; if (d.targetMesh) d.targetMesh.visible = v; } } // columns + overlays are map-only
function refreshDetLabel(det) { if (det.group) setColumnLabel(det.group, '✦ ' + det.name + ' · ' + det.size); }
function newDetachment() {
  const id = ++detachCounter;
  return { id, name: 'Detachment ' + id, color: GROUP_COLORS[(id - 1) % GROUP_COLORS.length],
    comp: { sword: 0, long: 0, archer: 0, thrower: 0 }, roster: [], size: 0,
    pos: new THREE.Vector3(), facing: player.facing, group: null,
    order: 'follow', target: null, route: [], routeIdx: 0, routeDir: 1, routeMesh: null, targetMesh: null,
    pace: 'march', garrisonHold: null, faction: PLAYER_REALM, isDetachment: true,
    inBattle: null, clashCd: 0, parleyCd: 0, level: mapLevel, leader: null,
    quality: 1 + 0.04 * mapLevel, alive: true, _shownSize: -1 };
}
// peel `recipe` men of each class off the lead column into a fresh detachment that marches at your side
function detach(recipe) {
  if (detachments.length >= MAX_DETACH) { showCmdToast('Already fielding ' + MAX_DETACH + ' detachments'); return null; }
  ensureWarbandRoster();                        // make the lead roster match its counts before peeling men off
  const det = newDetachment();
  let moved = 0;
  for (const k of WARBAND_KEYS) {
    const n = Math.min(recipe[k] || 0, warbandComp[k]);
    if (n <= 0) continue;
    const pool = warbandRoster.filter(c => !c.fallen && classKeyOf(c.archetype) === k);
    for (let i = 0; i < n; i++) {
      const c = pool[i]; if (!c) break;
      const idx = warbandRoster.indexOf(c); if (idx >= 0) warbandRoster.splice(idx, 1);
      det.roster.push(c);                        // the Character MOVES (never copied) — the single-list invariant
    }
    warbandComp[k] -= n; det.comp[k] = n; moved += n;
  }
  if (moved === 0) { showCmdToast('Nothing spare to detach'); return null; }
  det.size = detSize(det);
  det.pos.copy(player.pos); det.pos.y = 0;
  det.group = makeColumn(det.comp, det.color, '✦ ' + det.name + ' · ' + det.size);
  det.group.position.copy(det.pos); det.group.position.y = mapElevY(det.pos.x, det.pos.z);
  scene.add(det.group);
  detachments.push(det);
  if (player.mapToken) setColumnLabel(player.mapToken, '★ ' + warbandTotal()); // the lead column just shrank
  showCmdToast(det.name + ' marches — ' + det.size + ' strong');
  return det;
}
function orderDet(det, order, target) {
  det.order = order;
  if (order === 'move' || order === 'garrison') det.target = target ? { x: target.x, z: target.z } : { x: det.pos.x, z: det.pos.z };
  else if (order === 'hold') det.target = { x: det.pos.x, z: det.pos.z };
  else if (order === 'follow' || order === 'regroup') det.target = null;
  if (order !== 'patrol' && det.routeMesh) disposeRouteOverlay(det); // leaving patrol clears its route line
}
function setPatrol(det, route) {
  if (!route || route.length < 2) { showCmdToast('A patrol needs at least 2 points'); return; }
  det.route = route.map(p => ({ x: p.x, z: p.z }));
  det.routeIdx = 0; det.routeDir = 1; det.order = 'patrol'; det.target = null;
  if (typeof updateRouteOverlay === 'function') updateRouteOverlay(det);
}
// fold a detachment's men back into the lead column (rebuilds warbandComp from the merged roster)
function mergeDetachment(det) {
  ensureWarbandRoster();                         // lead roster ⇔ counts before we add the detachment's men
  for (const c of det.roster) if (!c.fallen && warbandRoster.indexOf(c) < 0) warbandRoster.push(c);
  for (const k of WARBAND_KEYS) warbandComp[k] = 0;
  for (const c of warbandRoster) if (!c.fallen) warbandComp[classKeyOf(c.archetype)]++;
  disposeRouteOverlay(det); disposeDetFlag(det);
  if (det.group) { scene.remove(det.group); disposeGroup(det.group); }
  const idx = detachments.indexOf(det); if (idx >= 0) detachments.splice(idx, 1);
  if (player.mapToken) setColumnLabel(player.mapToken, '★ ' + warbandTotal());
}
// after a map clash, trim a SURVIVING detachment's comp + roster down to its new (reduced) size
function reconcileDetachment(det) {
  const target = Math.max(0, Math.round(det.size));
  if (target <= 0) { killBand(det); return; }
  if (det.roster.length > target) {
    det.roster.sort((a, b) => (b.renown || 0) - (a.renown || 0)); // the greenest fall first; veterans endure
    for (const c of det.roster.splice(target)) warbandNameSet.delete(c.name);
  }
  for (const k of WARBAND_KEYS) det.comp[k] = 0;
  for (const c of det.roster) det.comp[classKeyOf(c.archetype)]++;
  det.size = detSize(det);
  for (const c of det.roster) { c.renown = (c.renown || 0) + 1; c.battles = (c.battles || 0) + 1; } // survivors harden a little
  refreshDetLabel(det);
}
// order a detachment to guard a hold; it parks there (storming it first if it's a weak-enough enemy hold)
function garrisonDet(det, hold) {
  if (!hold) return;
  det.garrisonHold = hold; det.order = 'garrison'; det.target = { x: hold.x, z: hold.z };
  if (det.routeMesh) disposeRouteOverlay(det);
}
function garrisonInto(det) {
  const hold = det.garrisonHold;
  if (hold && !hold.conquerCd && areFactionEnemies(det.faction, hold.owner) && detSize(det) >= effGarrison(hold) * 0.5) {
    conquerByBand(hold, det);     // strong enough → storm and take it (flips ownership, bloodies the detachment)
    reconcileDetachment(det);
    if (!det.alive) return;       // a pyrrhic storm can break a small detachment
  }
  det.order = 'hold'; det.target = { x: det.pos.x, z: det.pos.z };
  showCmdToast(det.name + ' holds ' + ((hold && hold.def && hold.def.name) || (hold && hold.name) || 'its ground'));
}
// a fresh campaign / new universe musters a clean host — dissolve any detachments from a prior life
function clearDetachments() {
  for (const d of detachments.slice()) { disposeRouteOverlay(d); disposeDetFlag(d); if (d.group) { scene.remove(d.group); disposeGroup(d.group); } }
  detachments.length = 0; detachCounter = 0; cmdSelDet = null;
  if (typeof cancelPatrolDraft === 'function') cancelPatrolDraft();
}
// on (re)entering the map: detachments survive, but any stranded far from the player (a region advance,
// or a teleport) are pulled back to your side; a same-region return leaves them where they stood
function reseatDetachments() {
  detachments.forEach((d, i) => {
    if (d.inBattle) { d.inBattle = null; d.clashCd = 0; } // a map clash never carries across an enterMap
    const far = Math.hypot(d.pos.x - player.pos.x, d.pos.z - player.pos.z) > 180;
    if (!far) { if (d.group) d.group.visible = true; return; }
    const ang = player.facing + Math.PI + (i - (detachments.length - 1) / 2) * 0.5;
    const [lx, lz] = nearestLand(player.pos.x + Math.sin(ang) * 9, player.pos.z + Math.cos(ang) * 9);
    d.pos.set(lx, 0, lz); d.order = 'follow'; d.target = null; d.route = []; d.routeIdx = 0; d.routeDir = 1;
    disposeRouteOverlay(d); disposeDetFlag(d);
    if (d.group) { d.group.position.set(lx, mapElevY(lx, lz), lz); d.group.visible = true; }
  });
}
// steer a detachment toward (tx,tz); returns true while still en route (outside stopR)
function stepDetachmentTo(det, tx, tz, stopR, sp, dt) {
  const dx = tx - det.pos.x, dz = tz - det.pos.z, d = Math.hypot(dx, dz);
  if (d <= stopR) return false;
  let mvx = dx / d, mvz = dz / d;
  if (d > 55) {                                       // far orders march by road, not as the crow flies
    const wp = unitPathStep(det, tx, tz);
    if (wp) { const wd = Math.hypot(wp.x - det.pos.x, wp.z - det.pos.z) || 1; mvx = (wp.x - det.pos.x) / wd; mvz = (wp.z - det.pos.z) / wd; }
  } else det._route = null;
  det.facing = angleLerp(det.facing, Math.atan2(mvx, mvz), dt * 10);
  sp *= terrainSpeedMul(roadFactorAt(det.pos.x, det.pos.z), landRoughAt(det.pos.x, det.pos.z), false); // own columns march fast on roads, slow through the hills
  const [nx, nz] = landStep(det.pos.x, det.pos.z, mvx * sp * dt, mvz * sp * dt);
  det.pos.x = nx; det.pos.z = nz;
  return true;
}
// a fanned point a little behind the player, so trailing columns string out rather than stack
function followOffset(det) {
  const i = Math.max(0, detachments.indexOf(det));
  const ang = player.facing + Math.PI + (i - (detachments.length - 1) / 2) * 0.55;
  return { x: player.pos.x + Math.sin(ang) * 9, z: player.pos.z + Math.cos(ang) * 9 };
}
// advance every detachment one tick under its standing order; called from updateMap
function updateDetachments(dt) {
  for (const det of detachments.slice()) {
    if (!det.alive) continue;
    if (det.clashCd > 0) det.clashCd -= dt;
    if (det.parleyCd > 0) det.parleyCd -= dt;
    let moved = false;
    if (!det.inBattle) {
      const sp = det.pace === 'rush' ? 7 : 5;
      if (det.order === 'follow') {
        const t = followOffset(det); moved = stepDetachmentTo(det, t.x, t.z, 6, sp, dt);
      } else if (det.order === 'move') {
        if (det.target) { moved = stepDetachmentTo(det, det.target.x, det.target.z, 2, sp, dt); if (!moved) det.order = 'hold'; }
      } else if (det.order === 'garrison') {
        if (det.target) { moved = stepDetachmentTo(det, det.target.x, det.target.z, 2.6, sp, dt); if (!moved && typeof garrisonInto === 'function') { garrisonInto(det); continue; } }
      } else if (det.order === 'regroup') {
        moved = stepDetachmentTo(det, player.pos.x, player.pos.z, 4, sp, dt);
        if (!moved) { mergeDetachment(det); continue; }
      } else if (det.order === 'patrol' && det.route.length >= 2) {
        const wp = det.route[det.routeIdx];
        moved = stepDetachmentTo(det, wp.x, wp.z, 2.5, sp, dt);
        if (!moved) {                            // reached this waypoint → advance, bouncing at either end
          det.routeIdx += det.routeDir;
          if (det.routeIdx >= det.route.length) { det.routeIdx = det.route.length - 2; det.routeDir = -1; }
          else if (det.routeIdx < 0) { det.routeIdx = 1; det.routeDir = 1; }
        }
      }
    }
    if (det.group) {
      det.group.position.copy(det.pos);
      det.group.position.y = mapElevY(det.pos.x, det.pos.z);
      det.group.rotation.y = det.facing;
      const dpx = player.pos.x - det.pos.x, dpz = player.pos.z - det.pos.z;
      columnLOD(det.group, dpx * dpx + dpz * dpz);
      trailPush(det, det.pos.x, det.pos.z);
      fileColumn(det.group, det, moved && (det._route != null || roadFactorAt(det.pos.x, det.pos.z) > 0.45), dt,
        clamp(1.05 + det.size / 60, 1.05, 2.4));
      animateColumn(det.group, moved, dt);
    }
    updateDetMarkers(det); // destination flag for move/hold/garrison
  }
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
  if (band.isDetachment) { if (band.group) setColumnLabel(band.group, '✦ ' + band.name + ' · ' + Math.max(0, Math.round(band.size))); return; } // detachments keep their column label
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
  const [x, z] = spawnPointNearPlayer(awayFromPlayer ? 55 : 16, awayFromPlayer ? 150 : 105);
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
// how many bands the region should hold — the map should always feel crowded with war
function targetPopulation() { return 34 + mapLevel * 3; }
function spawnMapParties() {
  // every nation fields hosts and packs from its own territory; spread evenly. Fill only up to the
  // region's target, counting any authoritative server warlords already placed — the ambient swarm
  // and the server's persistent hosts share ONE crowd budget, so the map is busy without exploding.
  const have = parties.filter(p => p.alive).length;
  const total = Math.max(0, targetPopulation() - have);
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
  mapFieldMode = false; clearAllFieldArmies(); // start strategic; clear any stale materialised-host crowds (fieldPref re-enters below)
  encounter = null; siegeCapital = null;
  if (typeof clearCall === 'function' && activeCall) clearCall(); // no stale call/beacon carries into a (new) region
  const encEl = document.getElementById('encounter'); if (encEl) encEl.classList.add('hidden');
  const pb = document.getElementById('cmd-deck'); if (pb) pb.classList.add('hidden'); commandPanelOpen = false; timeScale = 1;
  clearBattlefield();
  applyArenaSize(MAP_HALF);
  player.pos.set(0, 0, 0); player.vel.set(0, 0, 0);
  player.alive = true; player.hp = player.maxHp; player.stamina = player.maxStam;
  player.attacking = player.shooting = player.rolling = player.blocking = false; player.crouchT = 0;
  player.obj.scale.setScalar(1); player.obj.rotation.set(0, 0, 0); // full reset (field mode may have left it at FIELD_SCALE)
  cameraAngle = 0; // top-down map: W = up the screen (toward -Z), D = right
  mapSpawnT = 6;
  if (advanceRegion || !parties.some(p => p.alive)) {
    advanceRegion = false; clearParties();
    // a fresh region shifts worldSeed — but the SHARED world is ONE persistent map for every player,
    // so its level stays pinned (the server generates and contests exactly this terrain forever)
    if (!(typeof window !== 'undefined' && window.net && window.net.sharedWorld)) mapLevel++;
    placeCapitals(); if (isServerMap()) addServerArmies(); spawnMapParties(); // server's named hosts first, then top up the ambient swarm
  }
  applyServerWorldOnce(); // mirror the server's living world (capital owners) + show what changed while away
  // strategic worldmap dressing: biome terrain in, battle set-dressing out, neutral sky
  buildMapTerrain();
  setBattleDressing(false);
  if (ground) ground.material.color.setHex(0x6f9e54);
  scene.fog.color.setHex(0x9fc6e8); scene.background.setHex(0x9fc6e8);
  // shared world: begin in your home realm's lands (per-player offset so kingdoms start spread out);
  // solo: the map centre as before
  let spawnX = 0, spawnZ = 0;
  if (mpHomeIdx != null && nations[mpHomeIdx]) {
    const cap = nations[mpHomeIdx], ang = (mpSpawnJitter % 360) * Math.PI / 180, r = 9 + (mpSpawnJitter % 8);
    spawnX = cap.x + Math.cos(ang) * r; spawnZ = cap.z + Math.sin(ang) * r;
  }
  // start on a SOLID landmass, not just any dry pixel — nearestLand can land you on a coastal sliver
  // surrounded by sea ("half in the water"); bestLandSpot finds a tile with a clear dry radius (footR 28)
  // around it, ranging far (220u) to reach the mainland if the spawn point sits on a small island.
  const land = bestLandSpot(spawnX, spawnZ, 28, 220);
  const [plx, plz] = land ? [land.x, land.z] : nearestLand(spawnX, spawnZ);
  player.pos.set(plx, 0, plz); // never start at sea
  updateChunks(true); // re-centre the streamed world on the actual spawn tile
  // the player rides the map as a banner party, like the rival hosts — not the walking hero
  if (player.mapToken) { scene.remove(player.mapToken); disposeGroup(player.mapToken); }
  player.mapToken = makeColumn(warbandComp, PLAYER_REALM.color, '★ ' + warbandTotal());
  const youPin = makeMapPin(PIN_C.you, 0.9); youPin.position.y = 6.4;   // "you are here", readable from any rung
  player.mapToken.add(youPin);
  player.mapToken.position.copy(player.pos);
  player.mapToken.position.y = mapElevY(player.pos.x, player.pos.z);
  scene.add(player.mapToken);
  setDetVisible(true); // the player's detachments (if any) ride the map alongside the lead column
  reseatDetachments(); // pull any stranded detachments (region advance / teleport) back to your side
  showCmdBtn(true);    // the overworld command button is map-only
  player.obj.visible = false;
  musterOverlay.classList.add('hidden');
  gameoverOverlay.classList.add('hidden');
  hud.classList.remove('hidden');
  if (document.exitPointerLock) document.exitPointerLock(); // map roams with WASD; no aim needed
  pointerLocked = false;
  updateHUD();
  obMapStart(); // first-time-on-the-map onboarding hint (shown once)
  mapFieldMode = false;                                // enterMap rebuilt the strategic banner...
  applyDetailTier(true);                               // ...at the strategic tier (fresh chunks already built to it — this reconciles holds/icons)
  if (fieldPref) setFieldMode(true, { keepPref: true }); // ...but if you were on foot, drop back down and re-muster the company
}

// nearest living band of a DIFFERENT, non-allied faction within `radius` — drives the inter-host war.
// Uses the looser ambient-rivalry test so hosts actively converge into border skirmishes (keeping the
// map full of fights) rather than only when the macro diplomacy is at open war.
function nearestRival(band, radius) {
  let best = null, bestD = radius * radius;
  for (const o of parties) {
    if (!o.alive || o === band || !areAmbientRivals(o.faction, band.faction)) continue; // any non-allied host is a target
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
  if (band.isDetachment) { // a player detachment broken in the field — its men (and names) are lost for good
    for (const c of band.roster) warbandNameSet.delete(c.name);
    disposeRouteOverlay(band); disposeDetFlag(band);
    const idx = detachments.indexOf(band); if (idx >= 0) detachments.splice(idx, 1);
    showCmdToast(band.name + ' is broken — ' + band.roster.length + ' men lost');
  }
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
  for (const b of win.bands) if (b.alive) { b.inBattle = null; b.clashCd = 1.5; b._shownSize = -1; if (b.isDetachment) reconcileDetachment(b); else setBandLabel(b); }
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
// Overworld zoom is keyboard-only (L in / P out). The mouse wheel is intentionally NOT bound: a wheel
// event can't hold the transient activation the browser requires to grant pointer lock, so entering
// action mode from a scroll would land you locked-out. A keydown can — hence L/P below.
// L / P step the overworld zoom from the keyboard — always available, no mouse gesture needed.
// Three rungs, out -> in: 0 = discovery overview · 1 = strategic banner · 2 = action ride-along.
// Only the action rung locks the mouse, and since L is a keydown (a real gesture) that lock is allowed.
function overworldZoom(dir) {                           // dir: +1 = zoom in (L), -1 = zoom out (P)
  if (mode !== 'map' || encounter || mapCmdMode || commandPanelOpen) return;
  clearMapFocus();                                      // changing zoom re-centres on your own banner
  const rung = mapFieldMode ? 2 : discoveryMode ? 0 : 1;
  const to = clamp(rung + dir, 0, 2);
  if (to === rung) return;
  if (to === 2) { discoveryMode = false; setFieldMode(true); }        // -> action (setFieldMode grabs the pointer + toasts)
  else if (to === 1) {                                                // -> strategic banner
    if (mapFieldMode) setFieldMode(false);                           // from action: setFieldMode releases the lock + toasts
    else { discoveryMode = false; showCmdToast('Strategic view — L to lead on foot, P for the wide overview'); }
  } else { if (mapFieldMode) setFieldMode(false); discoveryMode = true; showCmdToast('Overview — every land you\'ve seen · L to return'); } // -> discovery
  applyDetailTier();                                  // each rung renders its own level of detail (chart / miniature / street)
}
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyL' && e.code !== 'KeyP') return;
  if (mode !== 'map' || encounter || mapCmdMode || commandPanelOpen) return;
  const el = document.activeElement;                   // don't steal the key while typing (sign-in fields, etc.)
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  e.preventDefault();
  overworldZoom(e.code === 'KeyL' ? 1 : -1);
});

// Fold the distance just ridden into the running survey reach, then push fog / stream-radius to match.
// (The camera lift+pullback is read from mapVista in updateMapCamera so the zoom-out stays smoothed.)
function applyVista(moved, dt) {
  if (moved > 0 && !discoveryMode) {  // don't move the player in discovery mode
    mapMiles += moved;
    mapVista = mapMiles / (mapMiles + VISTA.k);
    _mileSaveT += dt;
    if (_mileSaveT > 5) { _mileSaveT = 0; try { localStorage.setItem('bv-map-miles', String(Math.round(mapMiles))); } catch (e) {} }
  }
  if (discoveryMode) {
    scene.fog.near = 500;  // far fog for overview
    scene.fog.far = 1500;
  } else if (fieldSimOn()) {
    scene.fog.near = ACTION_VIEW.fogNear;  // ACTION: a ground-level eye ends at the treeline — the close
    scene.fog.far = ACTION_VIEW.fogFar;    // fog is what makes street-level detail affordable (camera.far culls past it)
  } else {
    scene.fog.near = vlerp(VISTA.fogNear);
    scene.fog.far = vlerp(VISTA.fogFar);
  }
  const wantView = Math.round(vlerp(VISTA.view));
  if (wantView !== VIEW && !discoveryMode) {
    const grew = wantView > VIEW;
    VIEW = wantView;
    updateChunks(true); // re-stream at the new radius right away
    if (grew) showCmdToast('The land opens before you — your scouts range farther.');
  }
}

function updateMap(dt) {
  const opx = player.pos.x, opz = player.pos.z;   // ground reference BEFORE movement (hero or banner)
  processTerrainQueue(_appliedTier === 2 ? 1 : 4); // drain pending re-tessellations (runs during discovery too)
  if (_appliedTier === 2) {               // the detail bubble walks with the hero (~every 10u of ground)
    const bdx = player.pos.x - _bubX, bdz = player.pos.z - _bubZ;
    if (bdx * bdx + bdz * bdz > 100) refreshDetailBubble();
  }
  if (encounter || discoveryMode) return; // a parley/siege prompt is open — the whole map (and the character) holds until you choose; discovery mode is view-only
  const serverDriven = isServerMap(); // when online, the server owns the macro war (clashes/conquests)
  tickMapDiplomacy(dt, serverDriven); // evolve faction relations: server truth online, shared kernel in solo
  _pathBudget = 1;                    // one road-route plan per frame across all bands/detachments — no hitches
  const field = fieldSimOn() && !mapCmdMode; // true = you're on foot as the hero, false = strategic banner march
  const dir = inputDir();
  const roaming = !mapCmdMode; // in command mode the cursor is freed and the map holds still for orders
  if (field) {
    // FIELD MODE: you ARE the hero on the ground — full battle controls, the company follows as soldiers
    updatePlayer(dt);     // mouse-aim + WASD + attack/heavy/block/dodge, confined to land + riding terrain
    rebuildSepGrid();     // so the escort spreads instead of stacking
    updateAllies(dt);     // the warband company (order 'free') trails the hero
    updateProjectiles(dt); // arrows you loose still fly
    updateFieldArmies(dt); // nearby hosts render as real soldier crowds (clashing ones fight) instead of flags
    updateStreetHolds();   // nearby settlements rebuild at street scale, one per frame, nearest first
  } else {
    // STRATEGIC MARCH: the party glides across the map as a banner; faster than enemy bands so you can flee
    let mdir = dir;
    if (marchPath && roaming) {                      // an ordered march rides its planned route by itself
      if (dir.lengthSq() > 0) clearMarch('You take the reins');
      else {
        let wp = marchPath[0];
        while (wp && Math.hypot(wp.x - player.pos.x, wp.z - player.pos.z) < 1.7) { marchPath.shift(); wp = marchPath[0]; }
        if (!wp) clearMarch('The column arrives');
        else { const wd = Math.hypot(wp.x - player.pos.x, wp.z - player.pos.z) || 1; _mDir.set((wp.x - player.pos.x) / wd, 0, (wp.z - player.pos.z) / wd); mdir = _mDir; }
      }
    }
    if (roaming && mdir.lengthSq() > 0) {
      player.vel.addScaledVector(mdir, player.speed * 1.5 * dt * 9);
      player.facing = angleLerp(player.facing, Math.atan2(mdir.x, mdir.z), dt * 12);
    }
    player.vel.multiplyScalar(Math.pow(0.0001, dt));
    // roads speed the march & rest the column; mountains slow it & drain its stamina (a graded road tames the climb)
    const pRoad = roadInfoAt(opx, opz), pRough = landRoughAt(opx, opz);
    const pSpeed = terrainSpeedMul(pRoad.factor, pRough, true);
    const [npx, npz] = landStep(opx, opz, player.vel.x * dt * pSpeed, player.vel.z * dt * pSpeed);
    player.pos.x = npx; player.pos.z = npz; player.pos.y = 0;
    if (npx === opx) player.vel.x = 0; // bumped the coast — kill that component
    if (npz === opz) player.vel.z = 0;
    // party stamina: marching tires the column (fast through rough country, almost free on a road); resting restores it
    const pMovedC = Math.hypot(npx - opx, npz - opz);
    if (pMovedC > 0.01 * pSpeed) {
      const effRough = pRough * (1 - pRoad.factor * MOVE.roadGrade);
      const drain = MOVE.drainBase * (1 + effRough * MOVE.roughDrain) * (1 - pRoad.factor * MOVE.roadRelief);
      partyStamina = clamp(partyStamina - drain * dt, 0, 100);
    } else {
      partyStamina = clamp(partyStamina + MOVE.regen * dt * (pRoad.factor > 0.5 ? 1.4 : 1), 0, 100);
    }
    if (player.mapToken) {
      player.mapToken.position.copy(player.pos);
      player.mapToken.position.y = mapElevY(player.pos.x, player.pos.z);
      player.mapToken.rotation.y = player.facing;
      const marching = roaming && mdir.lengthSq() > 0;
      trailPush(player, player.pos.x, player.pos.z);
      // a warband on the road (or under a march order) stretches single-file down its own wake — the
      // bigger the army, the longer its line (spacing grows with the muster)
      fileColumn(player.mapToken, player, marching && pMovedC > 0.012 && (marchPath != null || pRoad.factor > 0.45), dt,
        clamp(1.05 + warbandTotal() / 90, 1.05, 2.6));
      animateColumn(player.mapToken, marching, dt); // the lead column marches as you ride
    }
  }
  // tally the ground actually covered (hero OR banner) → grow the vista (haze, zoom, stream-radius all follow)
  const pMoved = Math.hypot(player.pos.x - opx, player.pos.z - opz);
  applyVista(pMoved, dt);
  updateChunks(); // stream fresh terrain + settlements in as the player crosses chunk lines
  ensureRoads();  // re-knit the road network when the player crosses into a new chunk (routes are cached, so this is cheap)
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
    let sp = band.speed || 5;
    if (mvx !== 0 || mvz !== 0) {
      if (!band.serverId) {
        // a distant objective is MARCHED to by road (a planned route, one plan per frame map-wide);
        // pursuits and near goals keep the direct heading. Local steering still nudges onto the roadbed.
        const goal = answeringCall ? activeCall : (!rival ? objective : null);
        if (goal && Math.hypot(goal.x - band.pos.x, goal.z - band.pos.z) > 55) {
          const wp = unitPathStep(band, goal.x, goal.z);
          if (wp) { const wd = Math.hypot(wp.x - band.pos.x, wp.z - band.pos.z) || 1; mvx = (wp.x - band.pos.x) / wd; mvz = (wp.z - band.pos.z) / wd; }
        } else band._route = null;
        const s = roadSteer(band.pos.x, band.pos.z, mvx, mvz); mvx = s[0]; mvz = s[1];
      }
      sp *= terrainSpeedMul(roadFactorAt(band.pos.x, band.pos.z), landRoughAt(band.pos.x, band.pos.z), false);
    }
    const [bnx, bnz] = landStep(band.pos.x, band.pos.z, mvx * sp * dt, mvz * sp * dt);
    if (bnx === band.pos.x && bnz === band.pos.z) { band.wanderDir = rand(0, Math.PI * 2); band.wanderT = rand(0.6, 1.5); } // shore-blocked → turn
    band.pos.x = bnx; band.pos.z = bnz;
    band.group.position.copy(band.pos);
    band.group.position.y = mapElevY(band.pos.x, band.pos.z);
    // ride into a band (moving toward it) to meet it — then choose: attack, or just hail
    if (d < 3.4 && band.parleyCd <= 0 && -(player.vel.x * to.x + player.vel.z * to.z) > 1) { openEncounter(band); return; }
  }

  updateDetachments(dt); // the player's own columns roam under their standing orders
  updateCmdUI();         // selection ring + command-panel refresh (command mode only)

  const holds = settlements.length ? nations.concat(settlements) : nations; // every hold near you this frame
  // ride up to any hold — capital, city, town or village — to lay siege (or leave); also age its timers
  for (const cap of holds) {
    if (cap.parleyCd > 0) cap.parleyCd -= dt;
    if (cap.conquerCd > 0) cap.conquerCd -= dt;
    const dx = player.pos.x - cap.x, dz = player.pos.z - cap.z;
    const reach = cap.tier === 'city' ? 5.0 : cap.tier === 'town' ? 4.2 : cap.tier === 'village' ? 3.4 : 4.6;
    if (dx * dx + dz * dz < reach * reach && cap.parleyCd <= 0 && -(player.vel.x * dx + player.vel.z * dz) > 1) { openSiege(cap); return; }
  }

  // rival hosts that collide LOCK INTO a living battle (or reinforce one already raging). This runs
  // online too — the ambient swarm is what fills the map with on-screen battles. Server warlords
  // (serverId) sit out these LOCAL clashes (the server owns their truth; ride into one to fight it).
  for (let i = 0; i < parties.length; i++) {
    const p = parties[i];
    if (!p.alive || p.serverId || p.clashCd > 0) continue; // locked bands carry a huge clashCd — they never initiate
    for (let j = i + 1; j < parties.length; j++) {
      const q = parties[j];
      if (!q.alive || q.serverId || !areAmbientRivals(q.faction, p.faction)) continue; // allies, pacts & server hosts don't clash here
      const dx = p.pos.x - q.pos.x, dz = p.pos.z - q.pos.z;
      if (dx * dx + dz * dz >= 3.6 * 3.6) continue;
      if (q.inBattle) joinSide(q.inBattle, p); // p (free) reinforces q's ongoing clash
      else startMapBattle(p, q);               // two free hosts meet — a new visible battle begins
      break;
    }
  }
  // the player's detachments lock into the same visible clashes — but only against declared ENEMIES
  // (not neutrals), so a patrol intercepts foes without starting fresh wars
  for (const det of detachments) {
    if (!det.alive || det.inBattle || det.clashCd > 0) continue;
    for (const q of parties) {
      if (!q.alive || q.serverId || q.inBattle || !areFactionEnemies(q.faction, det.faction)) continue;
      const dx = det.pos.x - q.pos.x, dz = det.pos.z - q.pos.z;
      if (dx * dx + dz * dz >= 3.6 * 3.6) continue;
      startMapBattle(det, q);
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
      if (dx * dx + dz * dz < 3.6 * 3.6 && band.size >= effGarrison(cap) * 0.5) { conquerByBand(cap, band); break; } // your watchtowers stiffen the defense
    }
  }
  // sweep out the fallen so the map and counts stay clean
  for (let i = parties.length - 1; i >= 0; i--) if (!parties[i].alive) parties.splice(i, 1);

  // keep the region topped up to its target so there's always a fight nearby —
  // wars and your hunts thin the bands, fresh hosts march in to replace them
  aliveParties = parties.length;
  mapSpawnT -= dt;
  if (mapSpawnT <= 0) { // trickle fresh ambient hosts in (online too) so the map never empties
    mapSpawnT = 2.2;
    let add = Math.min(3, targetPopulation() - aliveParties);
    while (add-- > 0) { reinforceMap(); aliveParties++; }
  }
  if (activeCall) updateActiveCall(dt); // advance a standing Call to Arms / Crusade
  updateFindFlares(dt);                 // pulse & retire any locator flares from a Find command
  if (aliveParties === 0 && !serverDriven) enterMap(); // somehow emptied → next, bigger region
  sendPresenceMaybe(dt); // multiplayer: heartbeat your banner + refresh rivals
  updateMyCharAgents(dt); // your own waiting characters march out their follow/patrol orders
  enemyCountEl.textContent = 'Army ' + armyTotal() + (detachments.length ? ' (with you ' + warbandTotal() + ', ' + detachments.length + ' detached)' : '') + ' · Foes nearby: ' + aliveParties;
  if (partyStamEl) {                                   // the column's marching condition (drains in the hills, rests on the roads)
    const st = Math.round(partyStamina);
    partyStamEl.textContent = (roadFactorAt(player.pos.x, player.pos.z) > 0.45 ? '🛣 ' : '') + 'March ' + st + '%' + (st < MOVE.fatigueAt ? ' — weary' : '');
    partyStamEl.style.color = st < 20 ? '#ff7a5a' : st < MOVE.fatigueAt ? '#ffcf6a' : '#bfe0a8';
  }
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
  mapFieldMode = false; // leaving the overworld for a real fight — drop the on-foot roam (fieldPref restores it after)
  clearAllFieldArmies(); // dispose the materialised nearby-host crowds (the real fight musters fresh)
  applyDetailTier();     // fold street-level rebuilds back to the miniature — no LOD layers held through a battle
  player.obj.scale.setScalar(1); // back to battle scale
  // the clash takes on the look of the map region it's fought in
  applyBiome(biomeAt(band.pos.x, band.pos.z));
  setBattleDressing(true);
  if (player.mapToken) player.mapToken.visible = false;
  setDetVisible(false); // detachment columns are map-only — hide them during the fight
  toggleCmdMode(false); showCmdBtn(false);
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
  clearFindFlares();           // locator flares belong to the strategic map — drop them for the fight
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
// ----- detachment overlays: a patrol route line + numbered waypoints, and a move/hold/garrison flag -----
function buildRouteMarker(colorHex) {
  const ringGeo = cachedGeo('routering', () => { const g = new THREE.RingGeometry(0.9, 1.3, 16); g.rotateX(-Math.PI / 2); return g; });
  const grp = new THREE.Group();
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
  ring.position.y = 0.08; grp.add(ring);
  return grp;
}
function disposeRouteOverlay(det) {
  if (!det.routeMesh) return;
  scene.remove(det.routeMesh);
  det.routeMesh.traverse(o => {
    if (o.geometry && !o.geometry.userData.cached) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
  det.routeMesh = null;
}
function updateRouteOverlay(det) {
  disposeRouteOverlay(det);
  if (det.order !== 'patrol' || !det.route || det.route.length < 2) return;
  const grp = new THREE.Group();
  const pts = det.route.map(p => new THREE.Vector3(p.x, mapElevY(p.x, p.z) + 0.25, p.z));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: det.color, transparent: true, opacity: 0.85 }));
  grp.add(line);
  det.route.forEach((p, i) => {
    const m = buildRouteMarker(det.color);
    m.position.set(p.x, mapElevY(p.x, p.z), p.z);
    const lbl = makeNameSprite(String(i + 1)); lbl.scale.set(1.3, 0.55, 1); lbl.position.y = 1.7; m.add(lbl);
    grp.add(m);
  });
  scene.add(grp);
  det.routeMesh = grp;
}
function buildDetFlag(colorHex) {
  const grp = new THREE.Group();
  const ring = new THREE.Mesh(cachedGeo('detring', () => { const g = new THREE.RingGeometry(1.3, 1.8, 18); g.rotateX(-Math.PI / 2); return g; }),
    new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
  ring.position.y = 0.06;
  const post = new THREE.Mesh(cachedGeo('detpost', () => new THREE.CylinderGeometry(0.1, 0.1, 2.8, 6)), new THREE.MeshBasicMaterial({ color: colorHex }));
  post.position.y = 1.4;
  const flag = new THREE.Mesh(cachedGeo('detflag', () => new THREE.PlaneGeometry(1.2, 0.7)), new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide }));
  flag.position.set(0.6, 2.4, 0);
  grp.add(ring, post, flag);
  scene.add(grp);
  return grp;
}
function disposeDetFlag(det) {
  if (!det.targetMesh) return;
  scene.remove(det.targetMesh);
  for (const o of det.targetMesh.children) if (o.material) o.material.dispose();
  det.targetMesh = null;
}
// per-frame: show a destination flag for move/hold/garrison (the route line is static, built on setPatrol)
function updateDetMarkers(det) {
  const showFlag = !det.inBattle && (det.order === 'move' || det.order === 'hold' || det.order === 'garrison') && det.target;
  if (showFlag) {
    if (!det.targetMesh) det.targetMesh = buildDetFlag(det.color);
    det.targetMesh.position.set(det.target.x, mapElevY(det.target.x, det.target.z), det.target.z);
  } else if (det.targetMesh) disposeDetFlag(det);
}

// ====== Overworld command UX: split & order detachments (desktop click + on-screen panel + touch) ======
let mapCmdMode = false, cmdSelDet = null, patrolDraft = null, _draftMesh = null, _detSelRing = null, _detPanelSig = '';
const detSplitRecipe = { sword: 0, long: 0, archer: 0, thrower: 0 };
const _disposeOverlayGroup = (g) => { if (!g) return; scene.remove(g); g.traverse(o => { if (o.geometry && !o.geometry.userData.cached) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); };

function setDetPace(det, pace) { det.pace = pace; renderDetPanel(); }
function selectDet(det) { cmdSelDet = (det && det.alive) ? det : null; renderDetPanel(); }

function toggleCmdMode(on) {
  const want = (on == null) ? !mapCmdMode : !!on;
  if (want && mode !== 'map') return;
  if (want && mapFieldMode) setFieldMode(false, { keepPref: true }); // command needs the overhead view — pull out, but keep the field preference (it's a temporary view switch, not a choice to stop roaming)
  mapCmdMode = want;
  if (mapCmdMode) { if (document.exitPointerLock) document.exitPointerLock(); }
  else { cancelPatrolDraft(); cmdSelDet = null; }
  const panel = document.getElementById('det-panel'); if (panel) panel.classList.toggle('hidden', !mapCmdMode);
  const btn = document.getElementById('det-cmd-btn'); if (btn) btn.classList.toggle('on', mapCmdMode);
  if (mapCmdMode) { renderDetPanel(); showCmdToast('Command mode — pick a detachment, then click the map. Esc to exit.'); }
  else showCmdToast('Command mode off');
}

function cancelPatrolDraft() { patrolDraft = null; _disposeOverlayGroup(_draftMesh); _draftMesh = null; }
function beginPatrolDraft() {
  if (!cmdSelDet) { showCmdToast('Pick a detachment first'); return; }
  patrolDraft = [];
  showCmdToast('Patrol: click the map to drop waypoints, then Enter / right-click to set (Esc cancels)');
}
function drawPatrolDraft() {
  _disposeOverlayGroup(_draftMesh); _draftMesh = null;
  if (!patrolDraft || !patrolDraft.length) return;
  const col = cmdSelDet ? cmdSelDet.color : 0xffd34d, g = new THREE.Group();
  if (patrolDraft.length >= 2) {
    const pts = patrolDraft.map(p => new THREE.Vector3(p.x, mapElevY(p.x, p.z) + 0.25, p.z));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.8 })));
  }
  patrolDraft.forEach((p, i) => { const m = buildRouteMarker(col); m.position.set(p.x, mapElevY(p.x, p.z), p.z); const lbl = makeNameSprite(String(i + 1)); lbl.scale.set(1.3, 0.55, 1); lbl.position.y = 1.7; m.add(lbl); g.add(m); });
  scene.add(g); _draftMesh = g;
}
function commitPatrolDraft() {
  if (!patrolDraft || !cmdSelDet) { cancelPatrolDraft(); return; }
  if (patrolDraft.length < 2) { showCmdToast('A patrol needs at least 2 waypoints'); return; }
  setPatrol(cmdSelDet, patrolDraft); cancelPatrolDraft(); renderDetPanel();
}

function holdNear(x, z, r) { let best = null, bd = r * r; for (const h of nations.concat(settlements)) { const dx = h.x - x, dz = h.z - z, dd = dx * dx + dz * dz; if (dd < bd) { bd = dd; best = h; } } return best; }
function detAtScreen(cx, cy) {
  let best = null, bd = 46 * 46;
  for (const d of detachments) { if (!d.alive) continue; tmpV.copy(d.pos); tmpV.y += 2; tmpV.project(camera); if (tmpV.z > 1) continue;
    const sx = (tmpV.x * 0.5 + 0.5) * innerWidth, sy = (-tmpV.y * 0.5 + 0.5) * innerHeight, dd = (sx - cx) ** 2 + (sy - cy) ** 2; if (dd < bd) { bd = dd; best = d; } }
  return best;
}
// a click on the 3D map while in command mode: place a waypoint, select a column, or order the ground
function onMapCmdClick(cx, cy) {
  if (patrolDraft) { const p = groundPointAt(cx, cy); if (p) { const [lx, lz] = nearestLand(p.x, p.z); patrolDraft.push({ x: lx, z: lz }); drawPatrolDraft(); } return; }
  const hit = detAtScreen(cx, cy);
  if (hit && hit !== cmdSelDet) { selectDet(hit); return; }
  if (cmdSelDet) {
    const p = groundPointAt(cx, cy); if (!p) return;
    const hold = holdNear(p.x, p.z, 6);
    if (hold) { garrisonDet(cmdSelDet, hold); showCmdToast(cmdSelDet.name + ' → garrison ' + ((hold.def && hold.def.name) || hold.name || 'the hold')); }
    else { const [lx, lz] = nearestLand(p.x, p.z); orderDet(cmdSelDet, 'move', { x: lx, z: lz }); showCmdToast(cmdSelDet.name + ' → march here'); }
    renderDetPanel();
  } else showCmdToast('Pick a detachment first (click its column or a panel card)');
}
// keep the selection ring + panel in sync each map frame (cheap: rebuild panel only on change)
function updateCmdUI() {
  if (!mapCmdMode) { if (_detSelRing) _detSelRing.visible = false; return; }
  if (cmdSelDet && !cmdSelDet.alive) cmdSelDet = null;
  if (cmdSelDet) {
    if (!_detSelRing) { _detSelRing = new THREE.Mesh(cachedGeo('detselring', () => { const g = new THREE.RingGeometry(2.2, 2.7, 28); g.rotateX(-Math.PI / 2); return g; }), new THREE.MeshBasicMaterial({ color: 0x7dc8ff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide })); scene.add(_detSelRing); }
    _detSelRing.visible = true;
    _detSelRing.position.set(cmdSelDet.pos.x, mapElevY(cmdSelDet.pos.x, cmdSelDet.pos.z) + 0.12, cmdSelDet.pos.z);
  } else if (_detSelRing) _detSelRing.visible = false;
  const sig = detachments.map(d => d.id + ':' + d.size + ':' + d.order + ':' + d.pace).join('|') + '#' + (cmdSelDet ? cmdSelDet.id : 0) + '#' + warbandTotal();
  if (sig !== _detPanelSig) { _detPanelSig = sig; renderDetPanel(); }
}

const DET_ORDER_LABEL = { follow: 'Following you', move: 'Marching', hold: 'Holding ground', patrol: 'On patrol', garrison: 'Garrisoning', regroup: 'Regrouping' };
function renderDetPanel() {
  const panel = document.getElementById('det-panel'); if (!panel || !mapCmdMode) return;
  const ORDERS = [['follow', 'Follow'], ['hold', 'Hold'], ['patrol', 'Patrol'], ['garrison', 'Garrison'], ['regroup', 'Recall']];
  let html = `<h3>Your Army</h3><div class="dp-hint">Lead column <b>★ ${warbandTotal()}</b> rides with you. ${detachments.length}/${MAX_DETACH} detachments. Pick one, then <b>click the map</b>: open ground = march, a hold = garrison. <b>P</b> = draw a patrol route.</div>`;
  if (!detachments.length) html += `<div class="dp-hint" style="opacity:.7">No detachments yet — form one below.</div>`;
  html += detachments.map((d, i) => {
    const hex = '#' + d.color.toString(16).padStart(6, '0'), sel = d === cmdSelDet ? ' sel' : '';
    return `<div class="dp-card${sel}" style="border-left-color:${hex}">
      <div class="dp-head" data-sel="${i}"><span>✦ ${d.name}</span><span>${d.size}</span></div>
      <div class="dp-sub">${i + 1} · ${DET_ORDER_LABEL[d.order] || d.order} ${d.pace === 'rush' ? '· ⚡ Rush' : '· 🐢 March'}</div>
      <div class="dp-btns">${ORDERS.map(([k, l]) => `<button data-ord="${i}:${k}" class="${d.order === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="dp-btns" style="margin-top:4px"><button data-pace="${i}:march" class="${d.pace !== 'rush' ? 'on' : ''}">🐢</button><button data-pace="${i}:rush" class="${d.pace === 'rush' ? 'on' : ''}">⚡</button></div>
    </div>`;
  }).join('');
  const can = detachments.length < MAX_DETACH, recipeTotal = WARBAND_KEYS.reduce((s, k) => s + detSplitRecipe[k], 0);
  html += `<div class="dp-split"><h3>Form a detachment</h3>` +
    WARBAND_KEYS.map(k => `<div class="dp-row"><span>${CLASS_NAME[k]} <i style="color:#9fb2cc;font-style:normal">(${warbandComp[k]})</i></span><span><button data-sp="${k}:-1">−</button><b style="margin:0 8px">${detSplitRecipe[k]}</b><button data-sp="${k}:1">+</button></span></div>`).join('') +
    `<button class="dp-make" data-make="1"${can && recipeTotal > 0 ? '' : ' disabled style="opacity:.4;cursor:default"'}>${can ? 'Form detachment' : 'Max detachments reached'}</button></div>`;
  panel.innerHTML = html;
  panel.querySelectorAll('[data-sel]').forEach(el => el.addEventListener('click', () => selectDet(detachments[+el.dataset.sel])));
  panel.querySelectorAll('[data-ord]').forEach(el => el.addEventListener('click', () => {
    const [i, k] = el.dataset.ord.split(':'), d = detachments[+i]; if (!d) return; selectDet(d);
    if (k === 'patrol') beginPatrolDraft();
    else if (k === 'garrison') { const h = holdNear(d.pos.x, d.pos.z, 1e6); if (h) { garrisonDet(d, h); showCmdToast(d.name + ' → garrison nearest hold'); } else showCmdToast('No hold in range'); }
    else if (k === 'regroup') { d.order = 'regroup'; showCmdToast(d.name + ' → regroup on you'); }
    else { orderDet(d, k); }
    renderDetPanel();
  }));
  panel.querySelectorAll('[data-pace]').forEach(el => el.addEventListener('click', () => { const [i, p] = el.dataset.pace.split(':'), d = detachments[+i]; if (d) setDetPace(d, p); }));
  panel.querySelectorAll('[data-sp]').forEach(el => el.addEventListener('click', () => { const [k, dv] = el.dataset.sp.split(':'); detSplitRecipe[k] = Math.max(0, Math.min(warbandComp[k], detSplitRecipe[k] + (+dv))); renderDetPanel(); }));
  const mk = panel.querySelector('[data-make]'); if (mk) mk.addEventListener('click', () => { const made = detach({ ...detSplitRecipe }); if (made) { for (const k of WARBAND_KEYS) detSplitRecipe[k] = 0; selectDet(made); } renderDetPanel(); });
}

function initDetCmdUI() {
  if (document.getElementById('det-cmd-btn')) return;
  const style = document.createElement('style');
  style.textContent = `
    #det-cmd-btn { position: fixed; left: 24px; bottom: 54px; z-index: 7; pointer-events: auto; cursor: pointer; display: none;
      font: 600 13px "Trebuchet MS", sans-serif; letter-spacing: .5px; color: #cfe9ff; background: rgba(12,18,30,.8);
      border: 1px solid rgba(125,200,255,.5); border-radius: 999px; padding: 7px 15px; text-shadow: 0 1px 3px #000; }
    #det-cmd-btn.show { display: block; }
    #det-cmd-btn.on { background: rgba(125,200,255,.24); border-color: #7dc8ff; color: #fff; }
    #det-panel { position: fixed; right: 0; top: 0; height: 100vh; width: 296px; z-index: 9; pointer-events: auto; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 8px; padding: 16px 12px; overflow-y: auto;
      background: linear-gradient(180deg, rgba(10,16,26,.95), rgba(8,12,20,.98)); border-left: 1px solid rgba(125,200,255,.25);
      font-family: "Trebuchet MS", sans-serif; color: #e9eef5; }
    #det-panel.hidden { display: none; }
    #det-panel h3 { font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; color: #bfe0ff; }
    #det-panel .dp-hint { font-size: 11px; color: #9fb2cc; line-height: 1.45; }
    #det-panel .dp-hint b { color: #cfe9ff; }
    .dp-card { border: 1px solid rgba(255,255,255,.14); border-left-width: 4px; border-radius: 8px; padding: 8px; background: rgba(255,255,255,.03); }
    .dp-card.sel { background: rgba(125,200,255,.12); border-color: #7dc8ff; }
    .dp-head { display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 14px; font-weight: 700; }
    .dp-sub { font-size: 11px; color: #aebccd; margin: 3px 0 6px; }
    .dp-btns { display: flex; flex-wrap: wrap; gap: 4px; }
    .dp-btns button { cursor: pointer; font-size: 11px; padding: 4px 8px; border-radius: 5px; border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.06); color: #dfe9f5; }
    .dp-btns button:hover { background: rgba(125,200,255,.2); }
    .dp-btns button.on { background: rgba(125,200,255,.32); border-color: #7dc8ff; color: #fff; }
    .dp-split { border-top: 1px solid rgba(255,255,255,.12); padding-top: 8px; margin-top: 4px; }
    .dp-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; margin: 4px 0; }
    .dp-row button { width: 24px; height: 24px; border-radius: 5px; border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.06); color: #dfe9f5; cursor: pointer; }
    .dp-make { width: 100%; margin-top: 8px; padding: 8px; border-radius: 6px; border: 1px solid #7dc8ff; background: rgba(125,200,255,.16); color: #eaf4ff; cursor: pointer; font-weight: 700; }
  `;
  document.head.appendChild(style);
  const btn = document.createElement('button'); btn.id = 'det-cmd-btn'; btn.textContent = '⚑ Command (C)';
  btn.addEventListener('click', () => toggleCmdMode());
  document.body.appendChild(btn);
  const panel = document.createElement('div'); panel.id = 'det-panel'; panel.className = 'hidden';
  document.body.appendChild(panel);
}
function showCmdBtn(v) { const b = document.getElementById('det-cmd-btn'); if (b) b.classList.toggle('show', v); }

// pointer: a plain left-click on the map (not on the panel) issues a command
let _cmdDown = null;
addEventListener('mousedown', (e) => {
  if (!mapCmdMode || mode !== 'map' || e.button !== 0) return;
  if (e.target.closest && e.target.closest('#det-panel, #det-cmd-btn')) return;
  _cmdDown = { x: e.clientX, y: e.clientY };
});
addEventListener('mouseup', (e) => {
  if (!mapCmdMode || mode !== 'map' || e.button !== 0 || !_cmdDown) return;
  const moved = Math.abs(e.clientX - _cmdDown.x) + Math.abs(e.clientY - _cmdDown.y) > 6; _cmdDown = null;
  if (moved || (e.target.closest && e.target.closest('#det-panel, #det-cmd-btn'))) return;
  onMapCmdClick(e.clientX, e.clientY);
});
addEventListener('contextmenu', (e) => { if (mapCmdMode && mode === 'map') { e.preventDefault(); if (patrolDraft) commitPatrolDraft(); } });
// touch: a tap on the map in command mode places the order (runs before the move-stick handler)
canvas.addEventListener('touchstart', (e) => {
  if (!mapCmdMode || mode !== 'map') return;
  const t = e.changedTouches[0]; if (!t) return;
  e.preventDefault(); e.stopPropagation();
  onMapCmdClick(t.clientX, t.clientY);
}, { passive: false, capture: true });
// keys: C toggles; in command mode digits select, P patrol, R recall, F follow, H hold, Z/X pace, Enter/Esc
addEventListener('keydown', (e) => {
  if (mode !== 'map' || encounter) return;
  if (e.code === 'KeyC' && !mapFieldMode) { e.preventDefault(); toggleCmdMode(); return; } // in field mode C is crouch, not command
  if (!mapCmdMode) return;
  if (e.code === 'Escape') { e.preventDefault(); if (patrolDraft) cancelPatrolDraft(); else toggleCmdMode(false); return; }
  if (e.code === 'Enter') { e.preventDefault(); if (patrolDraft) commitPatrolDraft(); return; }
  const m = e.code.match(/^Digit([1-9])$/); if (m) { e.preventDefault(); const d = detachments[(+m[1]) - 1]; if (d) selectDet(d); return; }
  if (!cmdSelDet) return;
  if (e.code === 'KeyP') { e.preventDefault(); beginPatrolDraft(); }
  else if (e.code === 'KeyR') { e.preventDefault(); cmdSelDet.order = 'regroup'; showCmdToast(cmdSelDet.name + ' → regroup'); renderDetPanel(); }
  else if (e.code === 'KeyF') { e.preventDefault(); orderDet(cmdSelDet, 'follow'); renderDetPanel(); }
  else if (e.code === 'KeyH') { e.preventDefault(); orderDet(cmdSelDet, 'hold'); renderDetPanel(); }
  else if (e.code === 'KeyZ') { e.preventDefault(); setDetPace(cmdSelDet, 'march'); }
  else if (e.code === 'KeyX') { e.preventDefault(); setDetPace(cmdSelDet, 'rush'); }
});
initDetCmdUI();

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
  grabPointer();
  obBattleStart(); // first-battle onboarding: aim/attack/block/dodge (reliable fallback; windup poll may pre-empt)
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
  grabPointer();
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
    if (typeof window !== 'undefined' && window.net) { // open this hold's town-economy row on the server (settlements + capitals)
      const hk = cap.key || (ni >= 0 ? 'cap:' + ni : null);
      if (hk) window.net.reportHold(hk, cap.def.name, cap.tier || 'capital', Math.round(cap.x), Math.round(cap.z));
    }
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
  // the picker lives wherever it's needed; pull it in front of the march button (and un-hide it —
  // it starts hidden now that the title screen no longer asks you to compose a warband)
  const _wp = document.getElementById('warband-picker');
  _wp.classList.remove('hidden');
  musterOverlay.insertBefore(_wp, document.getElementById('next-wave-btn'));
  renderWarbandPicker();
  if (document.exitPointerLock) document.exitPointerLock(); // free the cursor for the UI
  pointerLocked = false;
  musterOverlay.classList.remove('hidden');
  obMuster(); // first-victory onboarding: spend XP to recruit, then march
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
  obEncounter(ally); // first-parley onboarding: Attack vs Propose Pact vs Say Hi (neutral bands only)
}
function openSiege(cap) {
  encounter = { kind: 'capital', cap };
  player.vel.set(0, 0, 0);
  const yours = cap.owner === PLAYER_REALM;
  const tier = cap.tier ? cap.tier[0].toUpperCase() + cap.tier.slice(1) : 'Stronghold';
  encTitle.textContent = yours ? 'Your ' + tier : 'A ' + tier;
  encInfo.innerHTML = yours
    ? `${swatch(cap.owner.color)}<b>${cap.def.name}</b> flies your banner. Develop your holding — raise farms, lumber camps, and watchtowers.`
    : `${swatch(cap.owner.color)}<b>${cap.def.name}</b>, a ${cap.owner.name} ${cap.tier || 'hold'} — garrison <b>${cap.garrison}</b>. ${cap.tier === 'village' ? 'Raid it?' : 'Storm the walls?'}`;
  encAttackBtn.textContent = yours ? 'Manage ⚒' : 'Lay Siege';
  encAttackBtn.dataset.manage = yours ? '1' : '';
  encAttackBtn.style.display = ''; encHailBtn.textContent = 'Leave';
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
  const e = encounter, manage = encAttackBtn.dataset.manage === '1'; closeEncounter(); if (!e) return;
  if (e.kind === 'band') { if (e.band && e.band.alive) enterBattle(e.band); }
  else if (e.kind === 'joinbattle') { if (e.bt && !e.bt.done) startJoinBattle(e); }
  else if (manage && e.cap) enterTown(e.cap); // your own hold: open the management overlay
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

// ---------- Town management: develop a hold you own (server-backed living economy) ----------
// v1 is a management OVERLAY reached from the "your hold" prompt (Manage ⚒). Phase 2 will turn
// enterTown() into a walkable mode='town' scene with this panel demoted to a HUD. The economy is
// server-authoritative (server/tick.js): every action round-trips and we re-render the returned row.
const TOWN = { // mirrors server/tick.js TOWN — cost/level/cap surface only (keep in sync by hand)
  MAX_LEVEL: 3, WORKERS_PER_LEVEL: 4, TICK_SECONDS: 20,
  WATCHTOWER_GARRISON_PER_LVL: 8, HOUSES_POP_CAP: 6, LEVY_POP_THRESHOLD: 4,
  START_POP: { village: 6, town: 12, city: 22, capital: 30 }, START_FOOD: 20, START_WOOD: 20,
  POP_CAP_BASE: { village: 8, town: 16, city: 28, capital: 40 },
  COSTS: { farm: [[15, 0], [40, 0], [90, 0]], lumber: [[10, 0], [35, 0], [80, 0]], watchtower: [[30, 10], [70, 20], [140, 40]], houses: [[20, 0], [50, 0], [110, 0]] }
};
const TOWN_BUILDINGS = [
  { key: 'farm', name: 'Farm', hint: 'Assign farmers → food (feeds the town).' },
  { key: 'lumber', name: 'Lumber Camp', hint: 'Assign lumberjacks → wood (builds everything).' },
  { key: 'watchtower', name: 'Watchtower', hint: '+8 effective garrison per level — resists reconquest.' },
  { key: 'houses', name: 'Houses', hint: '+6 population cap per level.' },
];
const townOverlay = document.getElementById('town');
const townTitle = townOverlay ? townOverlay.querySelector('h1') : null;
const townSub = document.getElementById('town-sub');
const townBody = document.getElementById('town-body');
let townHold = null;     // the hold object whose panel is open
let townView = null;     // last server-authoritative holding view (or a local synth offline)
let townViewAt = 0;      // ms timestamp of that view (for the live projection)
let townProjTimer = 0, twFoodEl = null, twWoodEl = null;
if (townOverlay) { const tc = document.getElementById('town-close'); if (tc) tc.addEventListener('click', closeTown); }

// a hold's stable server key: settlements use their siteKey; capitals use "cap:<index in nations>"
function holdKeyOf(cap) { if (!cap) return null; if (cap.key) return cap.key; const ni = nations.indexOf(cap); return ni >= 0 ? 'cap:' + ni : null; }
// effective garrison: a player hold's watchtowers add to the size an attacker must beat
function townWatchBonus(cap) {
  if (!cap || cap.owner !== PLAYER_REALM) return 0;
  const key = holdKeyOf(cap); if (!key) return 0;
  const h = ((typeof window !== 'undefined' && window.net && window.net.holdings) || []).find(x => x.holdKey === key);
  return h ? (h.watchtowerBonus || 0) : 0;
}
function effGarrison(cap) { return (cap.garrison || 0) + townWatchBonus(cap); }
function nearestOwnedHold() {
  let best = null, bd = 1e18;
  for (const cap of nations.concat(settlements)) {
    if (cap.owner !== PLAYER_REALM) continue;
    const dx = cap.x - player.pos.x, dz = cap.z - player.pos.z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = cap; }
  }
  return best;
}
function synthHold(cap, key) { // offline / pre-load fallback so the panel still opens
  const tier = cap.tier || 'capital', pop = TOWN.START_POP[tier] || 6;
  return { holdKey: key, defName: cap.def.name, tier, food: TOWN.START_FOOD, wood: TOWN.START_WOOD,
    population: pop, popCap: TOWN.POP_CAP_BASE[tier] || 8, buildings: { farm: 0, lumber: 0, watchtower: 0, houses: 0 },
    jobs: { farm: 0, lumber: 0, idle: pop }, production: { food: 0, wood: 0 }, watchtowerBonus: 0 };
}
function enterTown(cap) {
  if (!cap || !townOverlay) return;
  townHold = cap; townView = null;
  const key = holdKeyOf(cap);
  obTown();
  if (typeof window !== 'undefined' && window.net && key) {
    window.net.reportHold(key, cap.def.name, cap.tier || 'capital', Math.round(cap.x), Math.round(cap.z))
      .then(() => window.net.loadHoldings())
      .then(() => { townView = ((window.net.holdings) || []).find(h => h.holdKey === key) || null; renderTownPanel(cap, key); });
  } else {
    renderTownPanel(cap, key); // offline: local defaults (writes no-op gracefully)
  }
}
function closeTown() { stopTownProjection(); if (townOverlay) townOverlay.classList.add('hidden'); townHold = null; }
function fmtRate(r) { return (r >= 0 ? '+' : '') + r.toFixed(1); }
function townSection(text) { const d = document.createElement('div'); d.className = 'cs-section'; d.textContent = text; return d; }
function townStep(txt, disabled, onClick) {
  const b = document.createElement('button'); b.textContent = txt;
  if (disabled) { b.disabled = true; b.style.opacity = '.35'; } else b.addEventListener('click', onClick);
  return b;
}
function renderTownPanel(cap, key) {
  if (!townOverlay) return;
  const h = townView || synthHold(cap, key);
  townView = h; townViewAt = Date.now();
  if (townTitle) townTitle.textContent = h.defName || (cap.def && cap.def.name) || 'Holding';
  if (townSub) townSub.textContent = (h.tier ? h.tier[0].toUpperCase() + h.tier.slice(1) : 'Holding') + ' — develop it to strengthen your realm.';
  const body = townBody; if (!body) return; body.innerHTML = '';

  // resource readout (food/wood project live toward the next harvest; see updateTownProjection)
  const read = document.createElement('div'); read.className = 'town-read';
  read.innerHTML =
    `<span>🌾 Food <b id="tw-food">${Math.floor(h.food)}</b> <em>${fmtRate(h.production.food)}/t</em></span>` +
    `<span>🪵 Wood <b id="tw-wood">${Math.floor(h.wood)}</b> <em>${fmtRate(h.production.wood)}/t</em></span>` +
    `<span>👥 Folk <b>${Math.floor(h.population)}</b>/${h.popCap}</span>` +
    `<span>🛡 Garrison <b>${(cap.garrison || 0) + (h.watchtowerBonus || 0)}</b>${h.watchtowerBonus ? ` <em>(+${h.watchtowerBonus})</em>` : ''}</span>`;
  body.appendChild(read);
  twFoodEl = read.querySelector('#tw-food'); twWoodEl = read.querySelector('#tw-wood');

  // build / upgrade
  body.appendChild(townSection('Build'));
  for (const def of TOWN_BUILDINGS) {
    const lvl = h.buildings[def.key] | 0, maxed = lvl >= TOWN.MAX_LEVEL;
    const cost = maxed ? null : TOWN.COSTS[def.key][lvl];
    const afford = !!cost && h.wood >= cost[0] && h.food >= cost[1];
    const row = document.createElement('div'); row.className = 'town-brow';
    const label = document.createElement('div'); label.className = 'town-blabel';
    label.innerHTML = `<b>${def.name}</b> <em>Lv ${lvl}/${TOWN.MAX_LEVEL}</em><br><small>${def.hint}</small>`;
    const costEl = document.createElement('div'); costEl.className = 'town-bcost';
    costEl.innerHTML = maxed ? '<span style="color:#9aff6b">MAX</span>' : `🪵${cost[0]}${cost[1] ? ` 🌾${cost[1]}` : ''}`;
    const btn = document.createElement('button'); btn.className = 'town-bbtn'; btn.textContent = lvl ? 'Upgrade' : 'Build';
    if (maxed || !afford) { btn.disabled = true; btn.classList.add('off'); } else btn.addEventListener('click', () => doTownBuild(cap, key, def.key));
    row.appendChild(label); row.appendChild(costEl); row.appendChild(btn);
    body.appendChild(row);
  }

  // assign folk to jobs
  body.appendChild(townSection('Assign folk'));
  const pop = Math.floor(h.population), assigned = (h.jobs.farm | 0) + (h.jobs.lumber | 0);
  body.appendChild(townJobRow('Farmers', 'farm', h, cap, key, pop, assigned));
  body.appendChild(townJobRow('Lumberjacks', 'lumber', h, cap, key, pop, assigned));
  const idleRow = document.createElement('div'); idleRow.className = 'wp-row';
  idleRow.innerHTML = `<span>Idle folk</span><b>${Math.max(0, pop - assigned)}</b>`;
  body.appendChild(idleRow);

  // levy surplus population into recruit XP
  const leviable = Math.max(0, Math.floor(h.population - TOWN.LEVY_POP_THRESHOLD));
  const levyWrap = document.createElement('div'); levyWrap.style.marginTop = '14px';
  const levyBtn = document.createElement('button'); levyBtn.className = 'btn'; levyBtn.style.fontSize = '14px'; levyBtn.style.padding = '10px 24px';
  levyBtn.textContent = leviable > 0 ? `Levy ${leviable} folk → recruit XP` : 'No surplus to levy';
  if (leviable <= 0) { levyBtn.disabled = true; levyBtn.style.opacity = '.4'; levyBtn.style.cursor = 'default'; } else levyBtn.addEventListener('click', () => doTownLevy(cap, key));
  levyWrap.appendChild(levyBtn);
  body.appendChild(levyWrap);

  townOverlay.classList.remove('hidden');
  startTownProjection();
}
function townJobRow(label, jobKey, h, cap, key, pop, assigned) {
  const row = document.createElement('div'); row.className = 'wp-row';
  const cur = h.jobs[jobKey] | 0, buildLvl = h.buildings[jobKey] | 0, jobCap = buildLvl * TOWN.WORKERS_PER_LEVEL;
  const span = document.createElement('span'); span.textContent = buildLvl ? label : label + ' (build first)';
  row.appendChild(span);
  row.appendChild(townStep('−', cur <= 0, () => doTownAssign(cap, key, jobKey, cur - 1, h)));
  const val = document.createElement('b'); val.textContent = cur; row.appendChild(val);
  row.appendChild(townStep('+', cur >= jobCap || assigned >= pop, () => doTownAssign(cap, key, jobKey, cur + 1, h)));
  return row;
}
function applyHoldResult(cap, key, r) {
  if (r && r.ok && r.holding) { townView = r.holding; renderTownPanel(cap, key); return true; }
  return false;
}
function doTownBuild(cap, key, building) { if (window.net) window.net.buildHold(key, building).then(r => applyHoldResult(cap, key, r)); }
function doTownAssign(cap, key, jobKey, val, h) {
  const jobs = { farm: h.jobs.farm | 0, lumber: h.jobs.lumber | 0 }; jobs[jobKey] = Math.max(0, val);
  if (window.net) window.net.assignHold(key, jobs).then(r => applyHoldResult(cap, key, r));
}
function doTownLevy(cap, key) {
  if (!window.net) return;
  window.net.levyHold(key).then(r => {
    if (r && r.ok) {
      xp += r.xp | 0; if (r.holding) townView = r.holding; renderTownPanel(cap, key);
      showWaveBanner('Levy Raised', '+' + (r.xp | 0) + ' recruit XP from ' + (townView.defName || 'your town'));
    }
  });
}
function startTownProjection() { stopTownProjection(); townProjTimer = setInterval(updateTownProjection, 1000); }
function stopTownProjection() { if (townProjTimer) { clearInterval(townProjTimer); townProjTimer = 0; } }
function updateTownProjection() { // project stock forward by whole elapsed ticks (server tick is frozen mid-session)
  if (!townView || !twFoodEl || !twWoodEl) return;
  const ticks = Math.floor((Date.now() - townViewAt) / 1000 / TOWN.TICK_SECONDS);
  if (ticks <= 0) return;
  twFoodEl.textContent = Math.floor(Math.max(0, townView.food + townView.production.food * ticks));
  twWoodEl.textContent = Math.floor(Math.max(0, townView.wood + townView.production.wood * ticks));
}
function obTown() {
  ONBOARD.show('town', 'Your Holding',
    'This hold is yours. Build <b>farms</b> for food, <b>lumber camps</b> for wood, and <b>watchtowers</b> to defend it. Put folk to work, and <b>levy</b> the surplus as recruits — a thriving town strengthens your whole realm.');
}

// ---------- HUD ----------
const hud = document.getElementById('hud');
const hpFill = document.getElementById('hp-fill');
const stamFill = document.getElementById('stam-fill');
const scoreEl = document.getElementById('score');
const enemyCountEl = document.getElementById('enemy-count');
const partyStamEl = document.getElementById('party-stamina');
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
function updateEnemyCount() { enemyCountEl.textContent = 'Enemies: ' + Math.max(0, enemiesRemaining); if (partyStamEl) partyStamEl.textContent = ''; }
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
// ---------- Just-in-time onboarding (one-time contextual hints) ----------
// A new player lands in a dozen systems with zero guidance. These hints are triggered
// by game state, each shown ONCE (flagged in localStorage), fully dismissable, and
// skippable wholesale. They never block input — the card floats over the HUD and only
// its own buttons are clickable. Mobile shows touch-flavoured key labels.
const ONBOARD = (() => {
  const KEY = 'bv-onboard-';        // per-hint flag, e.g. bv-onboard-map
  const SKIP_KEY = 'bv-onboard-skip'; // user opted out of all hints
  const el = document.getElementById('onboard');
  const elTitle = document.getElementById('ob-title');
  const elBody = document.getElementById('ob-body');
  let active = null;       // id currently displayed (so we only flag it once it's been seen)
  let hideT = 0;           // auto-dismiss countdown (seconds); 0 = sticky
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function seen(id) { return !!ls(KEY + id); }
  function skipped() { return !!ls(SKIP_KEY); }
  function flag(id) { if (id) set(KEY + id, '1'); }
  function hide() { if (!el) return; el.classList.remove('show'); flag(active); active = null; hideT = 0; }
  // show a hint once. ttl>0 auto-dismisses after that many seconds (still flagged as seen).
  function show(id, title, body, ttl = 0) {
    if (!el || skipped() || seen(id)) return false;
    if (active === id) return false;
    active = id; hideT = ttl;
    elTitle.textContent = title;
    elBody.innerHTML = body;
    el.classList.add('show');
    return true;
  }
  // counts down any auto-dismiss; called from the main loop with real dt
  function tick(dt) { if (hideT > 0) { hideT -= dt; if (hideT <= 0) hide(); } }
  function skipAll() { set(SKIP_KEY, '1'); hide(); }
  function reset() { // BV.resetOnboarding(): clear every flag so hints re-trigger
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k === SKIP_KEY || k.indexOf(KEY) === 0)) localStorage.removeItem(k);
      }
    } catch (e) {}
    hide();
    return 'onboarding reset';
  }
  if (el) {
    const x = document.getElementById('ob-x'), got = document.getElementById('ob-got'), skip = document.getElementById('ob-skip');
    if (x) x.addEventListener('click', hide);
    if (got) got.addEventListener('click', hide);
    if (skip) skip.addEventListener('click', skipAll);
  }
  // touch-aware key phrasing: tap-buttons on a phone, keys on desktop
  const k = (key, touch) => (typeof TOUCH !== 'undefined' && TOUCH) ? touch : key;
  return { show, hide, tick, skipAll, reset, seen, skipped, k };
})();
// the four core-path hints, keyed by game state. Each fires once.
function obMapStart() { // first time roaming the overworld (Drifter start)
  ONBOARD.show('map',
    'You ride the Vale',
    `<b>${ONBOARD.k('WASD', 'Drag the left stick')}</b> to roam. Ride into an enemy band to start a fight.<br>` +
    `Your goal: <b>raise your band</b> — beat weak packs, then recruit fresh swords at the muster after each win.`);
}
function obEncounter(ally) { // first parley with a band you meet
  if (ally) return; // teach the core choice on a neutral band, not an allied greet
  ONBOARD.show('encounter',
    'Banners Meet',
    `<b>Attack</b> to fight them now · <b>Propose Pact</b> to seek an alliance (they march to your call) · <b>Say Hi</b> to part in peace.<br>` +
    `Hunt the small packs first — they break easy and pay XP.`);
}
function obBattleStart() { // first real battle — the combat controls
  ONBOARD.show('battle',
    'Into the Clash',
    `<b>${ONBOARD.k('MOUSE', 'Look')}</b> to aim · <b>${ONBOARD.k('CLICK', 'ATK')}</b> to strike · ` +
    `<b>${ONBOARD.k('SHIFT', 'BLOCK')}</b> to guard · <b>${ONBOARD.k('SPACE', 'DODGE')}</b> to roll clear.<br>` +
    `Block or dodge the moment an enemy winds up a swing.`, 8);
}
function obMuster() { // first victory / muster screen — recruiting
  ONBOARD.show('muster',
    'Muster the Band',
    `Victory earns <b>XP</b>. Spend it here with the <b>＋</b> buttons to recruit more fighters — a bigger band wins harder fights.<br>` +
    `Then <b>March</b> back out to the Vale.`);
}
BV.resetOnboarding = ONBOARD.reset;
BV.onboard = ONBOARD; // expose for tests/debug

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
  clearDetachments(); // a fresh campaign starts with no detachments
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

// "Enter the Vale" is gated on sign-in (see refreshAuthGate) and runs the full universe boot.
document.getElementById('start-btn').addEventListener('click', () => { if (window.net && window.net.session) enterTheVale(); });
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
  if (EDIT.on) return editFrame(now);   // object-editor mode: orbit + render one model, skip the game sim
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
      // first-battle combat hint, timed to a real threat: pop it the instant a nearby
      // enemy winds up a swing (same one-time 'battle' id as the begin-battle fallback)
      if (!ONBOARD.seen('battle') && !ONBOARD.skipped()) {
        for (const e of enemies) {
          if (e.alive && e.state === 'windup' && e.pos.distanceTo(player.pos) < 7) { obBattleStart(); break; }
        }
      }
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
    ONBOARD.tick(dt); // count down any auto-dismissing onboarding hint
    // real-time field command: fade the order toast, and let the selection rings clear on their own
    if (cmdToastTimer > 0) { cmdToastTimer -= dt; if (cmdToastTimer <= 0 && cmdToastEl) cmdToastEl.style.opacity = '0'; }
    if (selIdle > 0 && mode === 'battle' && !commandPanelOpen) { selIdle -= dt; if (selIdle <= 0) clearSelection(); }

    updateSparks(gdt);
    updateArcs(gdt);
    updateTrails(gdt);
    updatePopups(gdt);
    if (mode === 'map') (fieldSimOn() && !mapCmdMode ? updateCamera : updateMapCamera)(dt); // field = over-the-shoulder; else strategic (held during an encounter too)
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
  setDetVisible(false); // detachment columns are map-only
  toggleCmdMode(false); showCmdBtn(false);
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
BV.terrAt = (x, z) => { const [q, r] = worldToHex(x, z); const c = terrCells.get(hexKey(q, r)); return c ? (c.w ? 'water' : (c.o ? c.o.name : 'unclaimed')) : 'unloaded'; };
// the border sheet + realm cards + pins (this feature set's test hooks)
BV.borders = () => ({ layer: TERR_LAYER, hover: hoverNation ? factionName(hoverNation) : null, srvTerrChunks: srvTerr.size, overlays: Array.from(mapChunks.values()).filter(r => r.terrOverlay).length, pins: _allPins.size, ownedPins: _ownedPins.size });
BV.hoverNation = (name) => { setHoverNation(name ? factionByName(name) : null); return hoverNation ? factionName(hoverNation) : null; };
BV.wallRing = (x, z, tier, seed) => terra().wallRingPts(x, z, tier || 'city', seed >>> 0);
BV.openHold = (name) => { const en = _allHoldEntries().find(e => e.def.name === name); if (en) openHoldPanel(en); return !!en; };
BV.openNation = (name) => { openNationPanel(name); };
BV.allyOrders = () => { const o = {}; for (const a of allies) if (a.alive) o[a.order] = (o[a.order] || 0) + 1; return o; };
BV.allyStats = () => { const g = {}; for (const a of allies) if (a.alive) { const k = defKey(a.def) + ':' + a.order; (g[k] = g[k] || { n: 0, x: 0, z: 0 }); g[k].n++; g[k].x += a.pos.x; g[k].z += a.pos.z; } const o = {}; for (const k in g) o[k] = { n: g[k].n, avgX: Math.round(g[k].x / g[k].n), avgZ: Math.round(g[k].z / g[k].n) }; return o; };
// audit the lattice cities over a region: confirms every emitted city centre is on land + reports spacing
BV.cityAudit = (radius = 700) => {
  const c0x = Math.floor((player.pos.x - radius) / CHUNK), c1x = Math.ceil((player.pos.x + radius) / CHUNK);
  const c0z = Math.floor((player.pos.z - radius) / CHUNK), c1z = Math.ceil((player.pos.z + radius) / CHUNK);
  const cities = [];
  for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++)
    for (const s of settlementSites(cx, cz)) if (s.tier === 'city') cities.push(s);
  const wet = cities.filter(s => isWater(s.x, s.z)).length, R = SG_SPEC.city.R;
  const coastal = s => { for (let k = 0; k < 16; k++) { const a = k / 16 * TAU; if (isWater(s.x + Math.cos(a) * R, s.z + Math.sin(a) * R)) return true; } return false; };
  let mind = 1e9; for (let i = 0; i < cities.length; i++) for (let j = i + 1; j < cities.length; j++) { const d = Math.hypot(cities[i].x - cities[j].x, cities[i].z - cities[j].z); if (d < mind) mind = d; }
  const sample = cities.map(s => ({ at: [Math.round(s.x), Math.round(s.z)], coastal: coastal(s) }));
  return { cities: cities.length, centresInWater: wet, coastalCities: sample.filter(s => s.coastal).length, nearestPair: cities.length > 1 ? Math.round(mind) : null, cityDiam: Math.round(R * 2 + 5), sample };
};
BV._land = (x, z, f = 28, s = 220) => bestLandSpot(x, z, f, s);          // debug: solid-land search
BV._ls = (x, z, f = 28) => +landScore(x, z, f).toFixed(3);              // debug: land fraction of a footprint
// roads: prove the network generated, connects the holds, and shapes the march
BV.roads = () => { const t = {}; for (const e of _roadEdges) t[e.tier] = (t[e.tier] || 0) + 1; return { ..._roadStats, v2: ROAD.v2, tiers: t, chunk: _roadChunk, gridCells: roadGrid ? roadGrid.size : 0, splat: _roadWinU.value.z > 0, rocks: !!roadMesh, partyStamina: Math.round(partyStamina) }; };
// kernel parity: fingerprint of the terrain fields at 256 seeded points — must equal the server's
// `node -e "console.log(require('./sim/terra').hash(SEED))"` exactly (gates every migration phase)
BV.terraHash = (s) => Terra.hash(s == null ? worldSeed() : s);
BV.terraVersion = () => Terra.VERSION;
// srv mode: chunk-store status + the Phase-1 acceptance test (server payload vs local kernel, in quanta)
BV.srv = () => ({ on: SRV_ON, chunks: srvChunks.size, inflight: _srvInflight.size, seed: _srvSeed, built: mapChunks.size });
BV.chunkParity = (cx, cz) => {
  if (cx == null) { cx = Math.floor(player.pos.x / CHUNK); cz = Math.floor(player.pos.z / CHUNK); }
  const e = srvChunks.get(cx + ',' + cz);
  if (!e) return { error: 'chunk ' + cx + ',' + cz + ' not in store' };
  const T = terra(), OFF = Terra.TOP_OFFSETS;
  let mE = 0, mT = 0, mM = 0, mR = 0;
  for (let i = 0; i < e.cells.length; i++) {
    const xc = e.cells[i][2], zc = e.cells[i][3];
    for (let v = 0; v < 13; v++) {
      const px = xc + OFF[v][0], pz = zc + OFF[v][1], o = i * 13 + v;
      mE = Math.max(mE, Math.abs(Math.round(T.elevationAt(px, pz) * 65535) - e.elev[o]));
      mT = Math.max(mT, Math.abs(Math.round(T.tempAt(px, pz) * 255) - e.temp[o]));
      mM = Math.max(mM, Math.abs(Math.round(T.moistureAt(px, pz) * 255) - e.moist[o]));
    }
    mR = Math.max(mR, Math.abs(Math.round(T.landRoughAt(xc, zc) * 255) - e.rough[i]));
  }
  const local = T.settlementSites(cx, cz).filter(s => !T.isWater(s.x, s.z) && !nearCapital(s.x, s.z, s.tier === 'city' ? 100 : 58));
  const holdsMatch = local.length === e.holds.length && local.every((s, i2) =>
    e.holds[i2] && s.idx === e.holds[i2].idx && s.tier === e.holds[i2].tier &&
    Math.abs(s.x - e.holds[i2].x) < 1e-6 && Math.abs(s.z - e.holds[i2].z) < 1e-6);
  return { cells: e.cells.length, maxElevQ: mE, maxTempQ: mT, maxMoistQ: mM, maxRoughQ: mR, holds: e.holds.length, holdsMatch };
};
// inspect the road graph: per-node degree (variable degree proof) + edge list with tiers + gate flags
BV.roadGraph = () => {
  const deg = {}, edges = _roadEdges.map(e => { deg[e.a.key] = (deg[e.a.key] || 0) + 1; deg[e.b.key] = (deg[e.b.key] || 0) + 1; return { a: e.a.key, b: e.b.key, tier: e.tier, gated: !!(e.aGate || e.bGate) }; });
  const degVals = Object.values(deg), hist = {}; for (const d of degVals) hist[d] = (hist[d] || 0) + 1;
  return { edges: edges.length, nodes: degVals.length, degreeHistogram: hist, maxDegree: degVals.length ? Math.max(...degVals) : 0, sample: edges.slice(0, 30) };
};
BV.roadAt = (x, z) => { const r = roadInfoAt(x, z), rough = landRoughAt(x, z); return { factor: +r.factor.toFixed(3), tangent: [+r.dx.toFixed(2), +r.dz.toFixed(2)], rough: +rough.toFixed(3), speedMul: +terrainSpeedMul(r.factor, rough, false).toFixed(3), water: isWater(x, z) }; };
BV.partyStamina = (set) => { if (typeof set === 'number') partyStamina = clamp(set, 0, 100); return Math.round(partyStamina); };
BV.roadDebug = (on) => { // repaint the splat in bright orange for a clear screenshot (debug only)
  _roadDbg = !!on; ensureRoads(true);
  return _roadStats.segs > 0;
};
BV.splatProbe = (x, z) => { // sample the splat canvas at a world point (debug: is there ink here?)
  if (!_roadCv || !_roadWinU.value.z) return null;
  const w = _roadWinU.value, u = (x - w.x) * w.z + 0.5, v = (z - w.y) * w.z + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return { inWindow: false, win: [w.x, w.y, 1 / w.z] };
  const px = _roadCtx.getImageData(Math.floor(u * ROAD_SPLAT.size), Math.floor(v * ROAD_SPLAT.size), 1, 1).data;
  return { inWindow: true, rgba: [...px], win: [w.x, w.y, 1 / w.z] };
};
BV.travelTo = (x, z) => { const ok = orderMarch(x, z); return ok && marchInfo ? { seconds: Math.round(marchInfo.seconds), waypoints: marchPath.length, roadFrac: +marchInfo.roadFrac.toFixed(2) } : null; };
BV.march = () => marchPath ? { left: marchPath.length, eta: marchInfo ? Math.round(marchInfo.seconds) : null } : null;
BV.travelPath = (ax, az, bx, bz) => { const t = travelPath(ax, az, bx, bz); return t ? { seconds: +t.seconds.toFixed(1), roadFrac: +t.roadFrac.toFixed(2), n: t.pts.length } : null; };
BV.gates = (x, z, tier, seed) => settlementGates(x, z, tier, seed || 0);
BV._mode = () => mode;
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
// discovery overview: toggle and inspect visited areas
BV.discovery = (on) => { if (on !== undefined) discoveryMode = !!on; return { mode: discoveryMode, chunks: discoveredChunks.size, list: Array.from(discoveredChunks).slice(0, 20) }; };
// ride-along view: read/set the 3rd-person overworld camera (automated-test + console hook)
BV.rideView = (on) => { if (mode === 'map' && on !== undefined) setFieldMode(!!on); return mapFieldMode; };
BV.fieldMode = BV.rideView; // alias: the real name for the on-foot character roam
// the LOD-by-zoom system: which tier is rendered, how many street rebuilds/icons live, detail-store depth
BV.detailTier = () => {
  let fine = 0, total = 0;
  for (const rec of mapChunks.values()) if (rec.tiles) for (const t of rec.tiles) { total++; if (t.tier === 2) fine++; }
  return { tier: _appliedTier, want: detailTier(),
    streets: _allHoldEntries().filter(e => e.streetGroup).length,
    icons: _holdIcons.size, srvDetail: srvDetail.size, roadPaintTier: _roadPaintedTier,
    terrQ: _terrRetessQ.length, fineTiles: fine, tiles: total, bubbleR: DETAIL_R };
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
BV.enterMap = () => { enterMap(); return BV.advanceMap(0); }; // jump straight to the overworld (headless tests)
// ---- detachment (overworld army-splitting) test hooks ----
BV.map = {
  detach: (recipe = { sword: 1 }) => { const d = detach(recipe); return d ? BV.map.list() : null; },
  list: () => detachments.map((d, i) => ({ i, id: d.id, name: d.name, order: d.order, size: d.size,
    x: Math.round(d.pos.x), z: Math.round(d.pos.z), wp: d.route.length, idx: d.routeIdx, inBattle: !!d.inBattle })),
  orderDet: (i, order, x, z) => { const d = detachments[i]; if (d) orderDet(d, order, (x != null ? { x, z } : null)); return BV.map.list(); },
  patrol: (i, wps) => { const d = detachments[i]; if (d) setPatrol(d, wps.map(p => ({ x: p[0], z: p[1] }))); return d ? d.route.length : 0; },
  regroup: (i) => { const d = detachments[i]; if (d) d.order = 'regroup'; return BV.map.list(); },
  garrison: (i) => { const d = detachments[i]; if (!d) return null; let best = null, bd = 1e9; for (const h of nations.concat(settlements)) { const dx = h.x - d.pos.x, dz = h.z - d.pos.z, dd = dx * dx + dz * dz; if (dd < bd) { bd = dd; best = h; } } if (best) garrisonDet(d, best); return BV.map.list(); },
  engage: (i, foeSize = 6) => { const d = detachments[i]; if (!d) return null; // muster a hostile band and lock the clash (test hook)
    let foe = null; for (const n of nations) if (areFactionEnemies(PLAYER_REALM, n.def)) { foe = n.def; break; }
    if (!foe) for (const n of nations) if (!isAllyFaction(n.def)) { foe = n.def; break; }
    if (!foe) return 'no foe nation';
    const x = d.pos.x + 2, z = d.pos.z, g = makePartyToken(foeSize, foe); g.position.set(x, mapElevY(x, z), z); scene.add(g);
    const band = { group: g, pos: new THREE.Vector3(x, 0, z), size: foeSize, alive: true, speed: 5, faction: foe, raider: false, clashCd: 0, parleyCd: 0, wanderT: 0, wanderDir: 0, level: mapLevel, leader: makeBandLeader(foeSize, mapLevel, true), quality: 1 + 0.04 * mapLevel };
    parties.push(band); setBandLabel(band);
    startMapBattle(d, band);            // lock them immediately so the test is deterministic
    return { foe: foe.name, detSize: d.size, foeSize }; },
  merge: (i) => { const d = detachments[i]; if (d) mergeDetachment(d); return BV.map.armyTotal(); },
  dist: (i) => { const d = detachments[i]; if (!d) return null; return Math.round(Math.hypot(d.pos.x - player.pos.x, d.pos.z - player.pos.z)); },
  armyTotal: () => ({ total: armyTotal(), lead: warbandTotal(), dets: detachments.length }),
};
// ---- town management test hooks ----
BV.town = () => ((typeof window !== 'undefined' && window.net && window.net.holdings) || []);
BV.enterTown = (key) => { const c = nations.concat(settlements).find(x => holdKeyOf(x) === key); if (c) { enterTown(c); return 'opened ' + key; } return 'no loaded hold ' + key; };
BV.buildAt = (key, building) => (window.net ? window.net.buildHold(key, building) : null);
BV.assignAt = (key, jobs) => (window.net ? window.net.assignHold(key, jobs) : null);
BV.levyAt = (key) => (window.net ? window.net.levyHold(key) : null);
BV.effGarrison = (cap) => effGarrison(cap);
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
// --- settlement-generator test hooks ---
// classify the land at a world point (what morphology a settlement there would take)
BV.classify = (x = player.pos.x, z = player.pos.z, tier = 'city') => { const p = sgProbe(x, z, SG_SPEC[tier] || SG_SPEC.city); return { cls: p.cls, slope: +p.slope.toFixed(3), relief: +p.relief.toFixed(2), prom: +p.prom.toFixed(2), refY: +p.refY.toFixed(1) }; };
// drop a settlement of a tier near the player (offset dx,dz). Deterministic when `seed` is given.
BV.spawnSettlement = (tier = 'city', dx = 0, dz = 0, seed) => {
  const X = player.pos.x + dx, Z = player.pos.z + dz;
  const sd = (seed != null ? seed : (Math.imul(X | 0, 73856093) ^ Math.imul(Z | 0, 19349663))) >>> 0;
  const g = buildSettlementGroup(X, Z, tier, tier.toUpperCase(), nations[0].owner.color, sd);
  scene.add(g); (window._sgDbg || (window._sgDbg = [])).push(g);
  return { ...BV.classify(X, Z, tier), ...g.userData.dbg, at: [Math.round(X), Math.round(Z)] };
};
BV.clearSpawned = () => { for (const g of (window._sgDbg || [])) { scene.remove(g); disposeGroup(g); } window._sgDbg = []; return 'cleared'; };
// scan outward for high-relief sites (knolls/ridges) to test castle-on-a-hill fitting
BV.findHill = (radius = 140, n = 8) => {
  const out = [], px = player.pos.x, pz = player.pos.z, rng = _mulberry32((px * 131 + pz * 977) >>> 0);
  for (let i = 0; i < 600 && out.length < n; i++) {
    const a = rng() * TAU, rd = 18 + rng() * radius, X = px + Math.cos(a) * rd, Z = pz + Math.sin(a) * rd;
    if (isWater(X, Z)) continue;
    const p = sgProbe(X, Z, SG_SPEC.city);
    if (p.cls === 'KNOLL' || p.cls === 'RIDGE') out.push({ x: Math.round(X), z: Math.round(Z), cls: p.cls, prom: +p.prom.toFixed(1), relief: +p.relief.toFixed(1) });
  }
  return out;
};
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
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return; // typing a name/password, not commanding
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
  // a settlement you developed (on this or another device) flies your banner when you stream back
  if (w.holdings) for (const h of w.holdings) {
    if (h.ownerName === PLAYER_REALM.name && /^-?\d/.test(h.holdKey)) heldOwners.set(h.holdKey, PLAYER_REALM.name);
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
// the authoritative named warlords, APPENDED onto the ambient swarm (no clear) — the server's
// persistent hosts and the client's living-world bands coexist so the map stays crowded + alive.
function addServerArmies() {
  for (const a of window.net.world.armies) serverArmyToBand(a);
}
function syncPartiesFromServer() { clearParties(); addServerArmies(); }
let otherPlayerTokens = [];
function clearOtherPlayers() { for (const t of otherPlayerTokens) { scene.remove(t); disposeGroup(t); } otherPlayerTokens.length = 0; }
function makeOtherPlayerToken(name, size, opts) {
  const g = makePartyToken(size || 1, { color: (opts && opts.color) || 0x39d0ff }); // cyan banner = another living player
  if (g.userData.label) { g.remove(g.userData.label); if (g.userData.label.material) { if (g.userData.label.material.map) g.userData.label.material.map.dispose(); g.userData.label.material.dispose(); } }
  const label = makeNameSprite(((opts && opts.prefix) || '☆ ') + name);
  label.scale.set(4.4, 0.56, 1); label.position.y = 4.3; g.add(label); g.userData.label = label;
  return g;
}
function renderOtherPlayers() {
  clearOtherPlayers();
  const ps = (window.net && window.net.world && window.net.world.players) || [];
  for (const p of ps) {
    // idle = a signed-in rival's character waiting where its player left it (camped banner)
    const g = makeOtherPlayerToken(p.name + (p.idle ? ' (camp)' : ''), p.size, p.idle ? { color: 0x2f7ea0, prefix: '☾ ' } : null);
    const px = clamp(p.x, -MAP_HALF + 1, MAP_HALF - 1), pz = clamp(p.z, -MAP_HALF + 1, MAP_HALF - 1);
    g.position.set(px, mapElevY(px, pz), pz); scene.add(g); otherPlayerTokens.push(g);
  }
  renderMyChars(); // your own waiting banners refresh on the same beat
}
let presenceT = 0;
// the shared world's settlements are server-authoritative: reflect who currently holds each
// (factions contest the frontier server-side) onto the holds we've streamed in, recoloring banners
// that changed hands. heldOwners is also seeded so settlements streaming in next show the right owner.
let _holdsTick = 0;
function applyServerHolds(holds) {
  if (!holds || !holds.length) return;
  const byKey = new Map();
  for (const h of holds) { heldOwners.set(h.holdKey, h.owner); byKey.set(h.holdKey, h.owner); }
  for (const cap of settlements) {
    const own = cap.key && byKey.get(cap.key); if (!own) continue;
    const f = factionByName(own) || FREE;
    if (f !== cap.owner) { cap.owner = f; recolorCapital(cap); }
  }
}
function sendPresenceMaybe(dt) {
  if (!(window.net && window.net.online)) return;
  presenceT -= dt; if (presenceT > 0) return;
  presenceT = 1.5;
  window.net.sendPresence({ name: playerChar ? playerChar.name : 'A Wanderer', faction: PLAYER_REALM.name, x: player.pos.x, z: player.pos.z, size: warbandTotal(), renown: playerChar ? playerChar.renown : 0 });
  ensureCharAdopted(); // signed in: your live hero becomes (or reports as) your active character
  if (window.net.session && (++_charsTick % 4) === 0) window.net.loadChars().then(() => { if (mode === 'map') renderMyChars(); }); // ~6s: waiting banners follow transfers
  if (window.net.sharedWorld) {
    window.net.loadWorld().then(() => { if (mode === 'map') renderOtherPlayers(); }); // refresh rivals in MP
    if ((++_holdsTick % 3) === 0 && window.net.loadHolds) window.net.loadHolds(player.pos.x, player.pos.z, 160).then(applyServerHolds); // ~every 4.5s: reflect frontier contests
  }
}
BV.serverBands = () => parties.filter(p => p.alive && p.serverId).map(p => ({ name: p.leader && p.leader.name, faction: p.faction.name, size: p.size, serverId: p.serverId }));
BV.otherPlayers = () => otherPlayerTokens.length;

// ============================================================================
//  FIND PARTIES — a locator command so parties can find each other on the map.
//  On the shared world a banner is a speck in a wide land; press F on the
//  strategic map and every OTHER party (other living players, their camps, and
//  your own waiting characters) raises a bright flare + a compass entry you can
//  march straight to. It's symmetric — anyone can call it — so parties find one
//  another. Purely client-side: it reads the presence positions already synced.
// ----------------------------------------------------------------------------
// world bearing to an 8-point compass glyph (-z is North on the overworld).
function compassGlyph(dx, dz) {
  const a = Math.atan2(dx, -dz);                       // 0 = North, +→East
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][i];
}
// the parties you'd want to find: fellow players (live + camped) and your own
// waiting characters — the same banners renderOtherPlayers / renderMyChars draw.
function findablePartyList() {
  const out = [];
  for (const p of (window.net && window.net.world && window.net.world.players) || [])
    out.push({ name: p.name, x: p.x, z: p.z, kind: p.idle ? 'camp' : 'player', men: p.size || 0 });
  if (window.net && window.net.session)
    for (const c of (window.net.charsList || [])) { if (c.active) continue; out.push({ name: c.name, x: c.x, z: c.z, kind: 'own', men: c.men || 0 }); }
  for (const e of out) { const dx = e.x - player.pos.x, dz = e.z - player.pos.z; e.dist = Math.hypot(dx, dz); e.dir = compassGlyph(dx, dz); }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}
// a tall pulsing beam raised over a party so it pops out of a crowded map
const findFlares = [];               // { group, life }
const FIND_FLARE_LIFE = 12;          // seconds a flare burns before fading out
function makeFindFlare(color) {
  const g = new THREE.Group();
  const beam = boxMesh(0.5, 26, 0.5, mat(color, { shared: false, emissive: color, emissiveI: 0.8 }));
  beam.position.y = 13; beam.material.transparent = true; g.add(beam); g.userData.beam = beam;
  const ring = new THREE.Mesh(cachedGeo('findRing', () => { const c = new THREE.RingGeometry(3.4, 4.4, 36); c.rotateX(-Math.PI / 2); return c; }),
    mat(color, { shared: false, emissive: color, emissiveI: 0.6 }));
  ring.material.transparent = true; ring.position.y = 0.3; g.add(ring); g.userData.ring = ring;
  scene.add(g); return g;
}
function clearFindFlares() { for (const f of findFlares) { scene.remove(f.group); disposeGroup(f.group); } findFlares.length = 0; }
function raiseFindFlare(x, z, color) {
  const g = makeFindFlare(color);
  g.position.set(x, mapElevY(x, z), z);
  findFlares.push({ group: g, life: FIND_FLARE_LIFE });
}
// tick from updateMap: pulse the live flares and retire the burnt-out ones
function updateFindFlares(dt) {
  if (!findFlares.length) return;
  for (let i = findFlares.length - 1; i >= 0; i--) {
    const f = findFlares[i]; f.life -= dt;
    if (f.life <= 0) { scene.remove(f.group); disposeGroup(f.group); findFlares.splice(i, 1); continue; }
    const fade = Math.min(1, f.life / 2);              // fade the last 2s out
    const pulse = 0.5 + 0.5 * Math.sin(rtNow * 6);
    f.group.userData.beam.material.opacity = (0.32 + 0.28 * pulse) * fade;
    f.group.userData.ring.material.opacity = (0.4 + 0.35 * pulse) * fade;
  }
}
let findPanel = null;
function ensureFindPanel() {
  if (findPanel) return findPanel;
  findPanel = document.createElement('div');
  findPanel.id = 'find-panel';
  findPanel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);min-width:340px;max-width:80vw;' +
    'background:rgba(16,12,24,.95);border:1px solid #39d0ff;border-radius:14px;padding:20px 22px;z-index:60;color:#f3ead8;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.6);display:none;font-family:inherit';
  document.body.appendChild(findPanel);
  return findPanel;
}
const FIND_ICON = { player: '☆', camp: '☾', own: '◆' };
const FIND_TINT = { player: 0x39d0ff, camp: 0x2f7ea0, own: 0xffcf5b };
// F on the strategic map: flare every other party and open a compass you can march by
function findParties() {
  if (mode !== 'map' || encounter || mapCmdMode || commandPanelOpen) return;
  const list = findablePartyList();
  clearFindFlares();
  if (!list.length) {
    showWaveBanner('No Parties in Sight', (window.net && window.net.sharedWorld)
      ? 'No other players or waiting bands are on the map right now.'
      : 'Ride the shared world (add ?mp) or field more characters to find company.');
    return;
  }
  for (const e of list) raiseFindFlare(e.x, e.z, FIND_TINT[e.kind] || 0x39d0ff);
  const p = ensureFindPanel();
  p.innerHTML = '<h2 style="margin:0 0 4px;color:#39d0ff;font-size:22px">Parties on the Map</h2>' +
    '<div style="font-size:12px;opacity:.65;margin-bottom:10px">Flares raised — pick one to march to it.</div>' +
    list.map((e, i) =>
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid #2c3648">' +
      '<span style="font-size:14px">' + (FIND_ICON[e.kind] || '☆') + ' <b>' + escHtml(e.name) + '</b>' +
      (e.kind === 'own' ? ' <span style="opacity:.6">· your banner</span>' : e.kind === 'camp' ? ' <span style="opacity:.6">· camped</span>' : '') +
      '<br><span style="opacity:.7;font-size:12px">' + e.dir + ' ' + Math.round(e.dist) + ' paces' + (e.men ? ' · ' + e.men + ' men' : '') + '</span></span>' +
      '<button data-find="' + i + '" style="background:#2a6fd0;color:#fff;border:none;border-radius:8px;padding:7px 14px;cursor:pointer;white-space:nowrap">March ⚑</button></div>').join('') +
    '<div style="margin-top:14px;text-align:right"><button id="find-close" style="background:#2a2233;color:#f3ead8;border:1px solid #6b5e7a;border-radius:8px;padding:7px 14px;cursor:pointer">Close</button></div>';
  p.style.display = 'block';
  document.getElementById('find-close').onclick = () => { p.style.display = 'none'; };
  for (const btn of p.querySelectorAll('[data-find]')) btn.onclick = () => {
    const e = list[+btn.getAttribute('data-find')]; p.style.display = 'none';
    orderMarch(e.x, e.z); showCmdToast('Marching to find ' + e.name);
  };
  showCmdToast(list.length + ' part' + (list.length === 1 ? 'y' : 'ies') + ' on the map — flares raised');
}
addEventListener('keydown', (e) => { if (e.code === 'KeyF' && mode === 'map' && !mapFieldMode && !encounter && !mapCmdMode && !commandPanelOpen) { e.preventDefault(); findParties(); } });
BV.findParties = () => findablePartyList();

// ============================================================================
//  MULTIPLE CHARACTERS (signed-in accounts) — one banner rides, the rest wait
// ----------------------------------------------------------------------------
//  Username/password auth (client-net keeps the session; its token rides the
//  X-Player-Token seam). A signed-in account fields several characters ON THE
//  SAME MAP: the active one is the hero you play; the others wait where you
//  left them (gold ◆ banners). The U panel switches banners — parking the live
//  warband into the outgoing character's state bundle and restoring the incoming
//  one's — splits men off under a brand-new character, and trades men when two
//  of your characters stand together (within CH_GIVE_RANGE paces, server-checked).
const charsOverlay = document.getElementById('chars');
const CH_GIVE_RANGE = 30;            // must match server/chars.js GIVE_RANGE
let activeCharId = null;
let charsAdopted = false;
let _charsTick = 0;
const myCharTokens = [];
const chSelected = new Set();        // charIds ticked in the drawer for a bulk order
// client-side orders driving your OWN waiting characters on the map: charId -> live agent
// { kind:'follow'|'patrol'|'hold', x, z, cx, cz, phase }. Movement is a live client visualisation
// (positions aren't persisted server-side yet — a page reload returns each banner to where it waits).
const charOrders = new Map();
function charAgent(c) {
  let a = charOrders.get(c.charId);
  if (!a) { a = { kind: 'hold', x: c.x, z: c.z, cx: c.x, cz: c.z, phase: rand(0, Math.PI * 2) }; charOrders.set(c.charId, a); }
  return a;
}
function setCharOrder(c, kind) { const a = charAgent(c); a.kind = kind; if (kind === 'patrol') { a.cx = a.x; a.cz = a.z; } return a; }
// step the ordered banners each map frame: followers home on your active banner, patrols circle their post
function updateMyCharAgents(dt) {
  if (mode !== 'map' || !charOrders.size || !(window.net && window.net.charsList)) return;
  const spd = 8;
  for (const c of window.net.charsList) {
    if (c.active || c.memberOf) continue;
    const a = charOrders.get(c.charId); if (!a || a.kind === 'hold') continue;
    if (a.kind === 'follow') {
      const dx = player.pos.x - a.x, dz = player.pos.z - a.z, d = Math.hypot(dx, dz) || 1;
      if (d > 7) { const s = Math.min(spd * dt, d - 7); a.x += dx / d * s; a.z += dz / d * s; }
    } else if (a.kind === 'patrol') {
      a.phase += dt * 0.55; a.x = a.cx + Math.cos(a.phase) * 8; a.z = a.cz + Math.sin(a.phase) * 8;
    }
    c.x = a.x; c.z = a.z;                                // keep the drawer distance + tokens on the live spot
    const tok = myCharTokens.find(t => t.userData && t.userData.charId === c.charId);
    if (tok) tok.position.set(a.x, mapElevY(a.x, a.z), a.z);
  }
}

function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function bundleCharState() {
  return { hero: playerChar ? serChar(playerChar) : null,
    comp: Object.assign({}, warbandComp),
    roster: warbandRoster.filter(c => !c.fallen).map(serChar) };
}
// rebuild the composition counts from the roster (and refresh the lead column's label)
function recountComp() {
  for (const k of WARBAND_KEYS) warbandComp[k] = 0;
  for (const c of warbandRoster) if (!c.fallen) warbandComp[classKeyOf(c.archetype)]++;
  if (player.mapToken) setColumnLabel(player.mapToken, '★ ' + warbandTotal());
}
// take n men out of the live warband (the greenest leave first) — returns them serialized,
// so they can ride on under another of your banners with their names and careers intact
function takeMenLocal(n) {
  const pool = warbandRoster.filter(c => !c.fallen).sort((a, b) => (a.xp + a.renown * 5) - (b.xp + b.renown * 5));
  const out = [];
  for (const c of pool.slice(0, n)) {
    out.push(serChar(c));
    warbandNameSet.delete(c.name);
    const i = warbandRoster.indexOf(c); if (i >= 0) warbandRoster.splice(i, 1);
  }
  recountComp();
  return out;
}
// add men to the live warband — the actual soldiers when we have their records, else fresh recruits
function addMenLocal(n, sers) {
  for (let i = 0; i < n; i++) {
    const c = (sers && sers[i]) ? deserChar(sers[i])
      : makeChar(i % 4 === 3 ? 'archer' : i % 4 === 2 ? 'thrower' : 'sword', { team: 'ally', nameSet: warbandNameSet });
    warbandRoster.push(c); warbandNameSet.add(c.name);
  }
  recountComp();
}
// become the given character: restore its parked hero + warband and stand where it waited
function applyActiveChar(c) {
  const st = c.state || {};
  warbandRoster.length = 0; warbandNameSet.clear();
  playerChar = st.hero ? deserChar(st.hero)
    : makeChar(c.archetype || 'sword', { team: 'ally', name: c.name, notability: 3, isPlayer: true });
  playerChar.isPlayer = true;
  if (!st.hero) playerChar.renown = c.renown || 0;
  player.char = playerChar;
  if (st.roster) for (const o of st.roster) { const rc = deserChar(o); warbandRoster.push(rc); warbandNameSet.add(rc.name); }
  let maxId = charIdSeq;
  if (playerChar.id) maxId = Math.max(maxId, playerChar.id);
  for (const rc of warbandRoster) maxId = Math.max(maxId, rc.id);
  charIdSeq = maxId;
  // the server's men count is the truth — transfers may have landed while this banner waited
  const have = warbandRoster.length;
  if (have < c.men) addMenLocal(c.men - have);
  else if (have > c.men) takeMenLocal(have - c.men);
  else recountComp();
  activeCharId = c.charId;
  // stand where the character was waiting
  player.pos.set(c.x, 0, c.z); player.vel.set(0, 0, 0);
  if (player.mapToken) { player.mapToken.position.copy(player.pos); player.mapToken.position.y = mapElevY(c.x, c.z); }
  presenceT = 0;    // report the takeover right away
  saveCareers();
  renderMyChars();
}
// your own WAITING banners on the map (gold ◆) — the active one is your normal ★ column
function clearMyChars() { for (const t of myCharTokens) { scene.remove(t); disposeGroup(t); } myCharTokens.length = 0; }
function renderMyChars() {
  clearMyChars();
  if (!(window.net && window.net.session)) return;
  for (const c of (window.net.charsList || [])) {
    if (c.active) { activeCharId = c.charId; continue; }
    if (c.memberOf) continue;                            // a member rides inside a party — no banner of its own
    const a = charOrders.get(c.charId);                  // a moving character rides its live agent spot
    const cx = a && a.kind !== 'hold' ? a.x : c.x, cz = a && a.kind !== 'hold' ? a.z : c.z;
    const g = makeOtherPlayerToken(c.name + ' · ' + c.men, c.men, { color: 0xffcf5b, prefix: '◆ ' });
    const chPin = makeMapPin(PIN_C.chars, 0.8); chPin.position.y = 5.6; g.add(chPin); // your other self, pinned
    const px = clamp(cx, -MAP_HALF + 1, MAP_HALF - 1), pz = clamp(cz, -MAP_HALF + 1, MAP_HALF - 1);
    g.position.set(px, mapElevY(px, pz), pz);
    g.userData.charId = c.charId;
    scene.add(g); myCharTokens.push(g);
  }
}
// On entering: adopt the freshly-dealt warband as character #1 the FIRST time, OR — for a
// returning account that already has an active character — restore that saved character (its
// warband + where it was left), discarding the throwaway starter band startStationGame dealt.
function ensureCharAdopted() {
  if (charsAdopted || !(window.net && window.net.session && window.net.online) || !playerChar) return;
  charsAdopted = true;
  window.net.adoptChar({ name: playerChar.name, archetype: classKeyOf(playerChar.archetype),
    x: player.pos.x, z: player.pos.z, men: warbandTotal(), renown: playerChar.renown, state: bundleCharState() })
    .then(r => {
      if (!(r && r.ok && r.active)) { charsAdopted = false; return; }
      activeCharId = r.active.charId;
      // returning player (server didn't just create char #1): restore the saved band + position,
      // discarding the throwaway starter band startStationGame dealt this session
      if (!r.created && r.active.state && r.active.state.hero) applyActiveChar(r.active);
      renderMyChars();
    });
}

// ----- the U panel: switch / split / trade -----
function chMsg(t, good) { const el = document.getElementById('ch-msg'); if (el) { el.textContent = t || ''; el.style.color = good ? '#9aff6b' : '#ff9a9a'; } }
function chCard(c) {
  if (c.memberOf) {                                      // rides inside a party — no banner, but keeps its career
    const lead = (window.net && window.net.charsList || []).find(x => x.charId === c.memberOf);
    return '<div class="ch-card member" data-ch="' + c.charId + '">' +
      '<div class="ch-name">◈ ' + escHtml(c.name) + ' <span class="ch-order">in party</span></div>' +
      '<div class="ch-meta">rides with ' + escHtml(lead ? lead.name : 'your banner') + ' · renown ' + Math.round(c.renown) + '</div>' +
      '<div class="ch-row"><button data-act="detach">Re-split…</button></div>' +
    '</div>';
  }
  const a = c.active ? null : charOrders.get(c.charId);
  const px = a && a.kind !== 'hold' ? a.x : c.x, pz = a && a.kind !== 'hold' ? a.z : c.z;
  const d = Math.round(Math.hypot(px - player.pos.x, pz - player.pos.z));
  const near = d <= CH_GIVE_RANGE;
  const sel = chSelected.has(c.charId);
  const order = a && a.kind !== 'hold' ? a.kind : null;
  return '<div class="ch-card' + (c.active ? ' you' : '') + (sel ? ' sel' : '') + '" data-ch="' + c.charId + '"' + (c.active ? '' : ' title="click to frame on the map"') + '>' +
    (c.active ? '' : '<input type="checkbox" class="ch-check"' + (sel ? ' checked' : '') + '>') +
    '<div class="ch-name">' + (c.active ? '★ ' : '◆ ') + escHtml(c.name) + (c.active ? ' <em>RIDING</em>' : '') +
      (order ? ' <span class="ch-order">' + order + '</span>' : '') + '</div>' +
    '<div class="ch-meta">' + c.men + ' men · renown ' + Math.round(c.renown) + (c.active ? '' : ' · ' + d + ' paces') + '</div>' +
    (c.active ? '' :
      '<div class="ch-row">' +
        '<button data-act="focus">Focus</button>' +
        '<button data-act="goto">Go there</button>' +
        '<button data-act="switch">Command</button>' +
        '<button data-act="give"' + (near ? '' : ' disabled title="within ' + CH_GIVE_RANGE + ' paces to trade men"') + '>Give…</button>' +
        '<button data-act="take"' + (near && c.men > 0 ? '' : ' disabled title="within ' + CH_GIVE_RANGE + ' paces to trade men"') + '>Take…</button>' +
      '</div>') +
    '</div>';
}
// paint the cards from the last-loaded roster (no network round-trip) — used after selection/order changes
function paintCharCards() {
  const body = document.getElementById('ch-body'); if (!body) return;
  const list = (window.net && window.net.charsList) || [];
  body.innerHTML = list.map(chCard).join('') || '<div class="cs-empty">No characters yet — ride on, one will be sworn in.</div>';
  updateChBulk();
}
// keep the bulk bar + select-all box in sync with the current selection
function updateChBulk() {
  const others = (window.net && window.net.charsList || []).filter(c => !c.active && !c.memberOf);
  for (const id of [...chSelected]) if (!others.some(c => c.charId === id)) chSelected.delete(id); // drop stale picks
  const bar = document.getElementById('ch-bulk'); if (bar) bar.classList.toggle('on', chSelected.size > 0);
  const n = document.getElementById('ch-bulk-n'); if (n) n.textContent = chSelected.size + ' selected';
  const cnt = document.getElementById('ch-selcount'); if (cnt) cnt.textContent = chSelected.size ? chSelected.size + ' of ' + others.length : '';
  const all = document.getElementById('ch-all'); if (all) all.checked = others.length > 0 && others.every(c => chSelected.has(c.charId));
}
function toggleChSel(id, on) {
  if (on) chSelected.add(id); else chSelected.delete(id);
  const card = document.querySelector('.ch-card[data-ch="' + id + '"]'); if (card) card.classList.toggle('sel', on);
  updateChBulk();
}
function renderCharsPanel() {
  const body = document.getElementById('ch-body'); if (!body) return;
  if (!(window.net && window.net.session)) {
    body.innerHTML = '<div class="cs-empty">Sign in on the title screen to keep several characters on the map.</div>';
    return;
  }
  body.innerHTML = '<div class="cs-empty">Riding out…</div>';
  window.net.loadChars().then(list => {
    if (!list) return void (body.innerHTML = '<div class="cs-empty">The server is out of reach.</div>');
    paintCharCards();
    renderMyChars();
  });
}
// bulk order the ticked characters. join = fold their men into your active party (server merge);
// follow/patrol = live march orders; halt = stand down.
function doBulkOrder(kind) {
  if (mode !== 'map' || encounter) return chMsg('finish what you are doing first');
  const list = (window.net && window.net.charsList) || [];
  const picked = [...chSelected].map(id => list.find(c => c.charId === id)).filter(c => c && !c.active && !c.memberOf);
  if (!picked.length) return;
  if (kind === 'rally') {
    let folded = 0, pending = picked.length;
    for (const c of picked) {
      window.net.mergeChar(c.charId, activeCharId).then(r => {
        if (r && r.ok) { folded++; if (r.men) addMenLocal(r.men); charOrders.delete(c.charId); chSelected.delete(c.charId); }
        if (--pending === 0) {
          presenceT = 0; saveCareers();
          chMsg(folded + ' banner' + (folded === 1 ? '' : 's') + ' folded into your party.', true);
          window.net.loadChars().then(() => { renderMyChars(); paintCharCards(); });
        }
      });
    }
    return;
  }
  for (const c of picked) { if (kind === 'halt') charOrders.delete(c.charId); else setCharOrder(c, kind); }
  const verb = { follow: 'follow your banner', patrol: 'patrol their post', halt: 'stand down' }[kind] || kind;
  chMsg(picked.length + ' ordered to ' + verb + '.', true);
  renderMyChars(); paintCharCards();
}
// re-split a member back out of its party under its own banner, taking some men from the leader
function doDetachMember(id) {
  if (mode !== 'map' || encounter) return chMsg('finish what you are doing first');
  const list = (window.net && window.net.charsList) || [];
  const mem = list.find(c => c.charId === id); if (!mem || !mem.memberOf) return;
  const lead = list.find(c => c.charId === mem.memberOf);
  const cap = lead ? lead.men : 0;
  if (cap < 1) return chMsg('no men to spare — the party is empty');
  const n = parseInt(prompt('Give how many men to ' + mem.name + '? (' + cap + ' available)', String(Math.min(5, cap))) || '0', 10);
  if (!(n > 0)) return;
  window.net.detachMember(id, n).then(r => {
    if (!r || !r.ok) return chMsg((r && r.error) || 'could not re-split');
    if (mem.memberOf === activeCharId) takeMenLocal(n);   // the men leave your live column under the re-split banner
    presenceT = 0; saveCareers();
    chMsg(mem.name + ' rides out again with ' + n + ' men.', true);
    window.net.loadChars().then(() => { renderMyChars(); paintCharCards(); });
  });
}
function toggleCharsPanel(force) {
  if (!charsOverlay) return;
  const willShow = force !== undefined ? force : charsOverlay.classList.contains('hidden');
  if (!willShow) return void charsOverlay.classList.add('hidden');
  if (mode !== 'map') return; // switching banners mid-battle would be desertion
  chMsg('');
  renderCharsPanel();
  charsOverlay.classList.remove('hidden');
  if (document.exitPointerLock) document.exitPointerLock();
}
function doSwitchChar(id) {
  if (mode !== 'map' || encounter) return chMsg('finish what you are doing first');
  window.net.switchChar(id, { x: player.pos.x, z: player.pos.z, men: warbandTotal(),
    renown: playerChar ? playerChar.renown : 0, state: bundleCharState() })
    .then(r => {
      if (!r || !r.ok) return chMsg((r && r.error) || 'switch failed');
      applyActiveChar(r.active);
      chMsg('You now ride as ' + r.active.name + ' — your old banner waits where you left it.', true);
      renderCharsPanel();
    });
}
// look up one of your characters (from the last-loaded roster) by its id
function charById(id) { return (window.net && window.net.charsList || []).find(c => c.charId === id) || null; }
// close the panel and swing the strategic camera onto that character, marking them with a flare
function doFocusChar(id) {
  const c = charById(id); if (!c) return;
  toggleCharsPanel(false);
  if (mapFieldMode) setFieldMode(false);        // the flare + framing live on the strategic map
  focusMapOn(c.x, c.z, 6);
  if (typeof clearFindFlares === 'function') { clearFindFlares(); raiseFindFlare(c.x, c.z, 0xffcf5b); }
  showCmdToast('Framing ' + c.name + ' · ' + Math.round(Math.hypot(c.x - player.pos.x, c.z - player.pos.z)) + ' paces away');
}
// close the panel and march YOUR banner to that character's camp
function doGoToChar(id) {
  const c = charById(id); if (!c) return;
  if (mode !== 'map' || encounter) return chMsg('finish what you are doing first');
  toggleCharsPanel(false);
  if (mapFieldMode) setFieldMode(false);
  clearMapFocus();                               // the camera rides with you as you set off
  if (typeof clearFindFlares === 'function') { clearFindFlares(); raiseFindFlare(c.x, c.z, 0xffcf5b); }
  if (orderMarch(c.x, c.z)) showCmdToast('Marching to ' + c.name);
}
function doGiveMen(fromId, toId, promptTxt) {
  if (fromId == null || toId == null) return;
  const n = parseInt(prompt(promptTxt, '5') || '0', 10);
  if (!(n > 0)) return;
  window.net.giveMen(fromId, toId, n).then(r => {
    if (!r || !r.ok) return chMsg((r && r.error) || 'transfer failed');
    if (fromId === activeCharId) takeMenLocal(n);       // the men leave your live column…
    else if (toId === activeCharId) addMenLocal(n);     // …or fall in with it
    presenceT = 0; saveCareers();
    chMsg(n + ' men changed banners.', true);
    renderCharsPanel();
  });
}
// raise a brand-new INDEPENDENT character: a random person with their own random band, dropped
// somewhere random on the map (known or unknown terrain). Draws nothing from your current warband.
function doCreateRandomChar() {
  const men = 3 + ((Math.random() * 10) | 0);            // a random handful: 3–12
  const tmpNames = new Set();
  const hero = makeChar('sword', { team: 'ally', notability: 3, nameSet: tmpNames });
  const kinds = ['sword', 'sword', 'sword', 'archer', 'thrower', 'long'];
  const roster = [], comp = { sword: 0, long: 0, archer: 0, thrower: 0 };
  for (let i = 0; i < men; i++) {
    const c = makeChar(kinds[(Math.random() * kinds.length) | 0], { team: 'ally', nameSet: tmpNames });
    roster.push(serChar(c)); comp[classKeyOf(c.archetype)]++;
  }
  const x = rand(-MAP_HALF + 4, MAP_HALF - 4), z = rand(-MAP_HALF + 4, MAP_HALF - 4); // anywhere in the vale
  chMsg('raising a banner…', true);
  window.net.createChar({ name: hero.name, archetype: 'sword', men: men, x: x, z: z, renown: 0,
    state: { hero: serChar(hero), comp: comp, roster: roster } })
    .then(r => {
      if (!r || !r.ok) return chMsg((r && r.error) || 'could not raise a new banner');
      chMsg(hero.name + ' now leads ' + men + ' men, camped somewhere in the vale — take command to ride out as them.', true);
      renderCharsPanel();
    });
}
function doSplitChar() {
  const nameEl = document.getElementById('ch-new-name'), menEl = document.getElementById('ch-new-men');
  const name = ((nameEl && nameEl.value) || '').trim();
  const n = parseInt((menEl && menEl.value) || '0', 10);
  if (!name) return chMsg('name the new character');
  if (!(n > 0)) return chMsg('send at least 1 man');
  if (n > warbandTotal()) return chMsg('you only have ' + warbandTotal() + ' men riding with you');
  const moved = takeMenLocal(n);                        // the actual soldiers ride under the new banner
  const hero = makeChar('sword', { team: 'ally', name: name, notability: 3 });
  const comp = { sword: 0, long: 0, archer: 0, thrower: 0 };
  for (const s of moved) comp[classKeyOf(s.archetype)]++;
  window.net.splitChar({ name: name, archetype: 'sword', men: n, x: player.pos.x + 3, z: player.pos.z + 3,
    state: { hero: serChar(hero), comp: comp, roster: moved } })
    .then(r => {
      if (!r || !r.ok) { addMenLocal(moved.length, moved); return chMsg((r && r.error) || 'split failed'); } // put them back
      presenceT = 0; saveCareers();
      if (nameEl) nameEl.value = '';
      chMsg(name + ' now waits beside you with ' + n + ' men.', true);
      renderCharsPanel();
    });
}
if (charsOverlay) {
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.code === 'KeyU' && (mode === 'map' || !charsOverlay.classList.contains('hidden'))) { e.preventDefault(); toggleCharsPanel(); }
    else if (e.code === 'Escape' && !charsOverlay.classList.contains('hidden')) toggleCharsPanel(false);
  });
  const chClose = document.getElementById('ch-close');
  if (chClose) chClose.addEventListener('click', () => toggleCharsPanel(false));
  const chSplit = document.getElementById('ch-split');
  if (chSplit) chSplit.addEventListener('click', doSplitChar);
  const chRandom = document.getElementById('ch-random');
  if (chRandom) chRandom.addEventListener('click', doCreateRandomChar);
  for (const id of ['ch-new-name', 'ch-new-men']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', (e) => e.stopPropagation()); // typing a name must not move the hero / open panels
  }
  const chBody = document.getElementById('ch-body');
  if (chBody) chBody.addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('.ch-card');
    const id = card && parseInt(card.getAttribute('data-ch'), 10);
    if (!id) return;
    if (e.target.classList && e.target.classList.contains('ch-check')) { toggleChSel(id, e.target.checked); return; } // tick for a bulk order
    const btn = e.target.closest('button[data-act]');
    if (!btn) { if (!card.classList.contains('you')) doFocusChar(id); return; } // a bare click on the card frames it on the map
    if (btn.disabled) return;
    const act = btn.getAttribute('data-act');
    if (act === 'focus') doFocusChar(id);
    else if (act === 'goto') doGoToChar(id);
    else if (act === 'switch') doSwitchChar(id);
    else if (act === 'detach') doDetachMember(id);
    else if (act === 'give') doGiveMen(activeCharId, id, 'Give how many men to that banner?');
    else if (act === 'take') doGiveMen(id, activeCharId, 'Take how many men from that banner?');
  });
  const chAll = document.getElementById('ch-all');
  if (chAll) chAll.addEventListener('change', () => {
    const others = (window.net && window.net.charsList || []).filter(c => !c.active && !c.memberOf);
    if (chAll.checked) others.forEach(c => chSelected.add(c.charId)); else chSelected.clear();
    paintCharCards();
  });
  const chBulk = document.getElementById('ch-bulk');
  if (chBulk) chBulk.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-bulk]'); if (b) doBulkOrder(b.getAttribute('data-bulk'));
  });
}
// ----- sign-in gate on the title screen: sign in / create account, THEN "Enter the Vale" -----
// Login is required — the game does not enter until an account is signed in. A successful
// login/register reloads the page (client-net), so on return net.session is set and this shows
// the Enter button instead of the form.
function refreshAuthGate() {
  const form = document.getElementById('auth-form'), who = document.getElementById('auth-who');
  const note = document.getElementById('auth-note'), startBtn = document.getElementById('start-btn');
  if (!form || !window.net) return;
  const sess = window.net.session;
  if (sess) {
    form.style.display = 'none';
    who.classList.remove('hidden');
    document.getElementById('auth-name').textContent = sess.username;
    if (note) note.innerHTML = 'Ready. <b>Enter the Vale</b> to take command — press <b>U</b> in game to switch or raise new characters.';
    if (startBtn) startBtn.classList.remove('hidden');
  } else {
    form.style.display = '';
    who.classList.add('hidden');
    if (startBtn) startBtn.classList.add('hidden');
  }
}
(function wireAuth() {
  const msg = document.getElementById('auth-msg');
  const user = document.getElementById('auth-user'), pass = document.getElementById('auth-pass');
  if (!user || !window.net) return;
  function go(fn) {
    if (!user.value.trim()) { msg.textContent = 'enter a username'; msg.style.color = '#ff9a9a'; return; }
    msg.textContent = 'one moment…'; msg.style.color = '#9fb2cc';
    fn(user.value.trim(), pass.value).then(r => { if (r && !r.ok) { msg.textContent = r.error || 'failed'; msg.style.color = '#ff9a9a'; } }); // success reloads the page under the new identity
  }
  document.getElementById('auth-login').addEventListener('click', () => go(window.net.login));
  document.getElementById('auth-register').addEventListener('click', () => go(window.net.register));
  const out = document.getElementById('auth-logout');
  if (out) out.addEventListener('click', () => window.net.logout());
  user.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(window.net.login); });
  pass.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(window.net.login); });
})();
BV.chars = () => ({ active: activeCharId, list: (window.net && window.net.charsList || []).slice(), waitingTokens: myCharTokens.length });
BV.switchChar = doSwitchChar;
BV.focusChar = doFocusChar;   // frame one of your characters on the map
BV.goToChar = doGoToChar;     // march your banner to one of your characters
BV.selectChar = (id, on) => { toggleChSel(id, on !== false); }; // tick a character for a bulk order
BV.bulkOrder = doBulkOrder;   // 'rally' | 'follow' | 'patrol' | 'halt' on the ticked characters
BV.detachMember = doDetachMember; // re-split a member back out under their own banner
BV.charOrders = () => [...charOrders.entries()].map(([id, a]) => ({ id: id, kind: a.kind, x: Math.round(a.x), z: Math.round(a.z) }));
BV.splitChar = (name, men) => { const n = document.getElementById('ch-new-name'), m = document.getElementById('ch-new-men'); if (n) n.value = name; if (m) m.value = men; doSplitChar(); };
BV.toggleChars = toggleCharsPanel;

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
  if (typeof window !== 'undefined' && window.net && window.net.sharedWorld) return `${s.title} of ${home}`; // distinct realm per player
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
  if (typeof clearDetachments === 'function') clearDetachments(); // ...and no detachments from a prior universe
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
    ensureCharAdopted(); // signed in: adopt char #1, or restore the saved active character
    return;
  }

  const rivalNation = NATIONS[s.rivalIdx];
  const rivalCap = nations[s.rivalIdx] || nations[0];
  const pos = { x: rivalCap.x, z: rivalCap.z };             // the fight takes the biome of the rival's land
  enterBattle({ size: s.enemy, level: mapLevel, alive: true, raider: s.enemy <= 5,
    pos, group: makePartyToken(s.enemy, rivalNation), faction: rivalNation, alliedBands: null });
  updateStationReadout(s);
  ensureCharAdopted(); // signed in: adopt char #1, or restore the saved active character
}

// Deal a universe. With no seed → a fresh random one. Refresh defaults to a NEW universe;
// only an explicitly PINNED seed (#u=<seed>, set via the seed box) reproduces on refresh.
// forceKey pins the station — the default plain load deals the humble 'drifter' (map mode, no
// opening fight); the "New Universe" reroll & seed box deal random dramatic stations.
function bootUniverse(seed, forceKey) {
  if (typeof window !== 'undefined' && window.net && window.net.sharedWorld) {
    // SHARED WORLD: terrain + capitals come from one fixed seed (identical for everyone), but each
    // player is dealt their OWN station from (sharedSeed ^ token hash) and spawns in their home realm.
    universeSeed = SHARED_WORLD_SEED;
    const tok = String(window.net.token || 'p');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
    mpSpawnJitter = h >>> 0;
    const st = rollStation((SHARED_WORLD_SEED ^ h) >>> 0, 'drifter'); // gentle start, distinct realm per player
    // ONE map for everyone: the shared world is pinned to region 0 (mapLevel feeds worldSeed, so a
    // station-rolled region would hand this player DIFFERENT terrain than the server + other players
    // — the frontier's distance scaling supplies the difficulty curve instead)
    st.region = 0;
    mpHomeIdx = st.homeIdx;
    startStationGame(st);
    return;
  }
  mpHomeIdx = null;
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
  if (typeof window !== 'undefined' && window.net && window.net.sharedWorld) {
    // the shared world is fixed — rerolling/seed-pinning don't apply, so hide them to avoid confusion
    const rr = p.querySelector('#sp-reroll'); if (rr) rr.style.display = 'none';
    const seedInp = p.querySelector('#sp-seed'); const seedRow = seedInp && seedInp.closest('div'); if (seedRow) seedRow.style.display = 'none';
  }
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

/* ============================================================================
   OBJECT EDITOR — an isolated stage to view & iterate ONE procedural object.
   Activated by ?edit=<kind> (or by setting window.BV_EDIT before this script).
   It suppresses the normal world boot, drops the battle dressing, builds the
   requested object on a clean stage with an orbit camera, and frames it.
   Crucially, every object is built by the REAL generators (buildHumanoid,
   buildSettlementGroup, sgHouse, makeBanner, …) — so any edit to those
   functions shows up here AND in the live game. Driven by the `object-editor`
   skill. Live hooks: BV.edit / BV.editSpin / BV.editSeed / BV.editFrameCam. */
const EDIT = { on: false, spec: null, obj: null, ground: null, spin: true, mtn: null,
               spinRate: 0.35, last: 0,
               orbit: { target: new THREE.Vector3(), r: 14, theta: 0.7, phi: 1.0 } };

// ---- "city on a mountain": a sculpted peak the editor seats a settlement on (via the mapElevY hook) ----
// A rounded, buildable SUMMIT (a gentle dome the size of the town footprint) atop steep flanks that
// fall to a flat base — so the real settlement generator terraces its houses over the crown while its
// curtain wall drapes down the shoulder, and steeper faces below naturally reject buildings.
function editMtnSpec(seed) {
  const r = _mulberry32((seed >>> 0) || 7);
  return { peak: 50, shoulder: 30, base: 68, summitFall: 10, ridges: 6, rough: 3.5, phase: r() * TAU };
}
function editMountainY(x, z) {
  const M = EDIT.mtn, d = Math.hypot(x, z), sh = M.shoulder, base = M.base, peak = M.peak, sf = M.summitFall;
  let h;
  if (d <= sh)       { const t = d / sh;               h = peak - sf * t * t; }              // gentle dome crown
  else if (d < base) { const t = (d - sh) / (base - sh); h = (peak - sf) * (1 - t * t * (3 - 2 * t)); } // steep flank (smootherstep)
  else               { h = 0; }                                                              // flat foot
  const flank = Math.max(0, Math.min(1, (d - sh) / (base - sh)));                             // 0 crown → 1 base
  const fade = flank * (1 - flank) * 4;                                                       // 0 at crown & foot, 1 mid-flank
  h += Math.sin(Math.atan2(z, x) * M.ridges + M.phase) * M.rough * fade;                      // ridge folds — a natural, non-conical silhouette
  return Math.max(0, h);
}
// alpine ground under the peak: grass foot → earthy rock → bare grey crag → a thin snow tip. Kept
// value-controlled (no pale mid-tones) so the studio key doesn't clamp the crown to a white blob;
// the city then crowns grey stone, with green slopes falling away and snow only at the very summit.
const _MTN_STOPS = [[0.00, 0x3f6a24], [0.40, 0x4f6f2c], [0.58, 0x6b6a48], [0.74, 0x726d63], [0.90, 0x8a867f], [0.975, 0xaab0b3], [1.00, 0xd7dce0]];
function editMtnColor(c, y, peak) {
  const f = Math.max(0, Math.min(1, y / peak));
  let a = _MTN_STOPS[0], b = _MTN_STOPS[_MTN_STOPS.length - 1];
  for (let i = 0; i < _MTN_STOPS.length - 1; i++) if (f >= _MTN_STOPS[i][0] && f <= _MTN_STOPS[i + 1][0]) { a = _MTN_STOPS[i]; b = _MTN_STOPS[i + 1]; break; }
  const t = (b[0] - a[0]) < 1e-6 ? 0 : (f - a[0]) / (b[0] - a[0]);
  return c.setHex(a[1]).lerp(_tmpCol.setHex(b[1]), t);
}
const _tmpCol = new THREE.Color();
function editMountainGround(M) {
  const pad = M.base * 1.35, seg = 100;
  const geo = new THREE.PlaneGeometry(pad * 2, pad * 2, seg, seg); geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = editMountainY(p.getX(i), p.getZ(i)); p.setY(i, y);
    editMtnColor(c, y, M.peak); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 2, specular: 0x000000 }));
  m.receiveShadow = true; return m;
}

// one-word request / ?edit= keyword  ->  a build spec
const EDIT_KINDS = {
  house: { kind: 'house' }, hut: { kind: 'house' }, cottage: { kind: 'house' },
  villa: { kind: 'house', big: true }, manor: { kind: 'house', big: true },
  village: { kind: 'settlement', tier: 'village' }, town: { kind: 'settlement', tier: 'town' },
  city: { kind: 'settlement', tier: 'city' }, capital: { kind: 'settlement', tier: 'capital' },
  castle: { kind: 'settlement', tier: 'town' }, keep: { kind: 'settlement', tier: 'town' },
  knight: { kind: 'humanoid', weapon: 'sword' }, soldier: { kind: 'humanoid', weapon: 'sword' },
  warrior: { kind: 'humanoid', weapon: 'sword' }, swordsman: { kind: 'humanoid', weapon: 'sword' },
  archer: { kind: 'humanoid', weapon: 'bow' }, humanoid: { kind: 'humanoid', weapon: 'sword' },
  fighter: { kind: 'humanoid', weapon: 'sword' }, banner: { kind: 'banner' },
  gate: { kind: 'gate' }, gatehouse: { kind: 'gate' }, citygate: { kind: 'gate' },
};
function parseEditSpec(word, q) {
  const spec = { seed: 3, spin: true, ...(EDIT_KINDS[(word || 'house').toLowerCase()] || { kind: 'house' }) };
  if (q) {
    if (q.get('tier')) spec.tier = q.get('tier');
    const sd = q.get('seed'); if (sd != null && sd !== '') spec.seed = parseInt(sd, 10) >>> 0;
    if (q.get('weapon')) spec.weapon = q.get('weapon');
    if (q.get('spin') === '0' || q.get('spin') === 'false') spec.spin = false;
    if (q.get('big') === '1') spec.big = true;
    const at = q.get('at'); if (at) { const p = at.split(',').map(Number); if (p.length === 2 && p.every(n => !isNaN(n))) spec.at = p; }
    if (q.get('mountain') === '1' || q.get('mtn') === '1') { spec.mtn = editMtnSpec(spec.seed); spec.at = [0, 0]; }
  }
  return spec;
}

// build exactly ONE object via the real generators; {seated:true} => sits on real mapElevY terrain
function editBuild(spec) {
  const seed = (spec.seed >>> 0) || 1;
  if (spec.kind === 'raw' && typeof spec.build === 'function') return { obj: spec.build(), seated: !!spec.seated, at: spec.at };
  if (spec.kind === 'humanoid') {
    const pal = spec.palette || { skin: 0xe0b088, cloth: 0x356fb0, accent: 0x223a66, blade: 0xeaf2ff };
    const h = buildHumanoid(pal, spec.scale || 1, spec.weapon || 'sword'); // returns {group, parts}
    return { obj: h.group || h, seated: false };
  }
  if (spec.kind === 'banner') return { obj: makeBanner(spec.color || 0xffcf5b), seated: false };
  if (spec.kind === 'gate') return { obj: buildCityGate(), seated: false };
  if (spec.kind === 'settlement' || spec.kind === 'street') {   // 'street' = the action rung's human-proportion rebuild
    const at = spec.at || [0, 0], tier = spec.tier || 'village';
    return { obj: buildSettlementGroup(at[0], at[1], tier, tier.toUpperCase(), spec.color || 0xffcf5b, seed,
                                       spec.kind === 'street' ? { detail: 'street' } : undefined),
             seated: true, at };
  }
  // default: a single house from the real sgHouse, on a flat seat
  const pal = settlePalette(biomeAt(0, 0)), S = { pos: [], col: [] };
  const P = { r: _mulberry32(seed), spec: SG_SPEC.village, seat: () => 0, pal,
              ownerRGB: sgRgb(0xffcf5b, 1), S, O: { pos: [], col: [] } };
  for (let i = 0; i < 6 && !sgHouse(P, 0, 0, { big: !!spec.big, yaw: 0.6 }); i++) { /* re-roll on a steep reject */ }
  const g = new THREE.Group(); if (S.pos.length) g.add(sgMesh(S, settleVCMat()));
  return { obj: g, seated: false };
}

// a ground patch: real displaced mapElevY terrain under a settlement, a flat disc otherwise
function editGround(spec, built) {
  if (EDIT.mtn && built.seated) return editMountainGround(EDIT.mtn);
  if (built.seated) {
    const [X, Z] = built.at, R = (SG_SPEC[spec.tier] || SG_SPEC.village).R, pad = R * 1.7;
    const geo = new THREE.PlaneGeometry(pad * 2, pad * 2, 56, 56); geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, mapElevY(X + p.getX(i), Z + p.getZ(i)));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat(biomeAt(X, Z).ground || 0x6f8f4a, { smooth: false }));
    m.position.set(X, 0, Z); m.receiveShadow = true; return m;
  }
  const bs = new THREE.Box3().setFromObject(built.obj).getSize(tmpV);     // the disc grows with the subject (a gate span, a long wall)
  const geo = new THREE.CircleGeometry(Math.max(7, Math.max(bs.x, bs.z) * 0.72), 56); geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat(0x5f7a44, { smooth: false }));
  m.position.y = -0.26; m.receiveShadow = true; return m;
}

function editClear() {
  for (const k of ['obj', 'ground']) { const o = EDIT[k]; if (o) { scene.remove(o); try { disposeGroup(o); } catch (e) {} EDIT[k] = null; } }
}
function editFrameCam() {
  if (!EDIT.obj) return;
  if (EDIT.mtn) {                                    // frame the whole peak from a low, majestic 3/4 angle
    const M = EDIT.mtn;
    EDIT.orbit.target.set(0, M.peak * 0.5, 0);
    EDIT.orbit.r = M.base * 2.2; EDIT.orbit.theta = 2.2; EDIT.orbit.phi = 1.1;  // off the sun axis → raking light models the slopes
    return;
  }
  const box = new THREE.Box3().setFromObject(EDIT.obj); if (box.isEmpty()) return;
  EDIT.orbit.target.copy(box.getCenter(tmpV));
  const s = box.getSize(tmpV2);
  EDIT.orbit.r = Math.max(5, Math.max(s.x, s.y, s.z) * 1.7);
  EDIT.orbit.theta = 0.7; EDIT.orbit.phi = 1.0;
}
function editStatus() {
  const s = EDIT.spec, sz = EDIT.obj ? new THREE.Box3().setFromObject(EDIT.obj).getSize(new THREE.Vector3()) : null;
  return { kind: s.kind, tier: s.tier, seed: s.seed, weapon: s.weapon, spin: EDIT.spin,
           size: sz ? [+sz.x.toFixed(1), +sz.y.toFixed(1), +sz.z.toFixed(1)] : null };
}
function editApply(spec) {
  EDIT.spec = spec; EDIT.spin = spec.spin !== false;
  EDIT.mtn = spec.mtn || null;
  editTerrainFn = EDIT.mtn ? editMountainY : null;   // sculpt the peak while building (or restore world terrain)
  // studio key: the peak's height-tint (rock→snow) only reads if the bright sky+sun don't clamp the
  // pale facets to white, so dim to a calm key while a landform is shown (runtime-only; never the live game).
  if (typeof hemi !== 'undefined') hemi.intensity = EDIT.mtn ? 0.35 : 0.85;
  if (typeof sun !== 'undefined') sun.intensity = EDIT.mtn ? 0.80 : 1.15;
  editClear();
  const built = editBuild(spec);
  EDIT.obj = built.obj; scene.add(EDIT.obj);
  EDIT.ground = editGround(spec, built); scene.add(EDIT.ground);
  editFrameCam();
  return editStatus();
}
function editFrame(now) {
  const o = EDIT.orbit, dt = Math.min((now - (EDIT.last || now)) / 1000, 0.05); EDIT.last = now;
  if (EDIT.spin) o.theta += EDIT.spinRate * dt;
  const st = Math.sin(o.phi);
  camera.position.set(o.target.x + o.r * st * Math.sin(o.theta),
                      o.target.y + o.r * Math.cos(o.phi),
                      o.target.z + o.r * st * Math.cos(o.theta));
  camera.lookAt(o.target);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
function editInstallControls() {
  const o = EDIT.orbit; let drag = false, px = 0, py = 0;
  canvas.addEventListener('pointerdown', e => { drag = true; EDIT.spin = false; px = e.clientX; py = e.clientY; });
  window.addEventListener('pointermove', e => {
    if (!drag) return;
    o.theta -= (e.clientX - px) * 0.01; o.phi = clamp(o.phi - (e.clientY - py) * 0.01, 0.15, 1.5);
    px = e.clientX; py = e.clientY;
  });
  window.addEventListener('pointerup', () => drag = false);
  canvas.addEventListener('wheel', e => { o.r = clamp(o.r * (1 + Math.sign(e.deltaY) * 0.08), 2, 280); e.preventDefault(); }, { passive: false });
}
function editorBoot(spec) {
  EDIT.on = true;
  try { setBattleDressing(false); } catch (e) {}        // clear the battle arena/torches/treeline
  // hide ALL pre-existing world geometry so the stage holds only our object: the load-time
  // buildWorld() (arena/decor) and initPlayer() (a humanoid at the origin) both clutter it.
  for (const c of scene.children.slice()) { if (!c.isLight) c.visible = false; }
  scene.fog = null;                                      // fog at 45–95 would swallow a whole city
  scene.background = new THREE.Color(0x223040);          // calm studio backdrop
  const hud = document.getElementById('hud'); if (hud) hud.classList.add('hidden');
  const tch = document.getElementById('touch'); if (tch) tch.classList.add('hidden');
  document.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden'));
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.22); fill.position.set(-30, 24, -18); scene.add(fill);
  editInstallControls();
  editApply(spec);
  try { console.log('[object-editor]', JSON.stringify(editStatus())); } catch (e) {}
}
const _toSpec = (s) => typeof s === 'string' ? parseEditSpec(s) : s;
BV.edit = (s) => { if (!EDIT.on) editorBoot(_toSpec(s) || { kind: 'house' }); else editApply(typeof s === 'string' ? parseEditSpec(s) : { ...EDIT.spec, ...s }); return editStatus(); };
BV.editSpin = (on) => { EDIT.spin = on === undefined ? !EDIT.spin : !!on; return EDIT.spin; };
BV.editSeed = (n) => editApply({ ...EDIT.spec, seed: n >>> 0 });
BV.editFrameCam = () => { editFrameCam(); return 'framed'; };
BV.editStatus = editStatus;

// Boot. ?edit=<kind> (or window.BV_EDIT) opens the object editor; otherwise show the sign-in gate
// and DEFER the universe boot until the player clicks "Enter the Vale". The game no longer auto-
// enters: you sign in (or create an account) first, and entering loads your active character.
const _editQ = (typeof location !== 'undefined') ? new URLSearchParams(location.search) : null;
const _editWord = (_editQ && _editQ.get('edit')) ||
  ((typeof location !== 'undefined' && location.hash || '').match(/edit=([^&]+)/) || [])[1];
// the deferred universe boot: a PINNED #u=<seed> reproduces a dramatic station, else the humble drifter
function enterTheVale() {
  const m = (typeof location !== 'undefined' && location.hash || '').match(/u=(\d+)/);
  if (m) bootUniverse(parseInt(m[1], 10) >>> 0);
  else bootUniverse(undefined, 'drifter');
}
if (window.BV_EDIT || _editWord) {
  editorBoot(window.BV_EDIT || parseEditSpec(_editWord, _editQ));
} else {
  refreshAuthGate(); // show login vs. signed-in Enter button (the sim idles behind the overlay)
}

})();
