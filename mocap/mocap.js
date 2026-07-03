// mocap.js — webcam body tracking driving the Blade Vale soldier, in real time.
//
// Pipeline: getUserMedia video -> MediaPipe PoseLandmarker (vendored, runs local)
//   -> EMA-smoothed world landmarks -> retarget.js solver (joint quaternions)
//   -> soldier rig (soldier.js copy of the game's buildHumanoid).
//
// Keys: M mirror, C calibrate head neutral, D demo pose (also auto-fallback when
// the camera is unavailable). ?demo=1 starts in demo mode.

/* global THREE */
import { FilesetResolver, PoseLandmarker, DrawingUtils } from './vendor/vision_bundle.mjs';
import { solvePose, captureHeadOffset } from './retarget.js';
import { buildHumanoid, PLAYER_PALETTE, mat } from './soldier.js';
import { demoLandmarks } from './demo.js';

const params = new URLSearchParams(location.search);

// ---------- state ----------
let mirror = true;
let demo = params.get('demo') === '1';
let alpha = 0.4;              // EMA responsiveness (1 = raw, snappy; low = floaty)
const VIS_GATE = 0.5;         // below this a limb group holds its last pose
const SLERP_K = 0.55;         // per-frame quaternion damping on top of the EMA
let headOffset = null, calibratePending = false;
let prevYaw = 0;
let smoothed = null;          // EMA'd copy of the 33 world landmarks
let landmarker = null, camReady = false, lastVideoTime = -1;
let lastVis = null, infMs = 0, trackedOnce = false;

// ---------- dom ----------
const $ = id => document.getElementById(id);
const statusEl = $('status'), statsEl = $('stats'), noteEl = $('note');
const video = $('cam'), overlay = $('overlay'), pip = $('pip');
const octx = overlay.getContext('2d');
const drawUtils = new DrawingUtils(octx);

function setStatus(txt, cls) { statusEl.textContent = txt; statusEl.className = cls || ''; }

// ---------- three scene (matches the game's look: flat Phong, warm sun) ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8e8);
scene.fog = new THREE.Fog(0x8fb8e8, 20, 70);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

// simple orbit: drag to swing, wheel to zoom
const orbit = { az: 0, el: 0.22, dist: 7.2, target: new THREE.Vector3(0, 1.8, 0) };
function placeCamera() {
  const { az, el, dist, target } = orbit;
  camera.position.set(
    target.x + dist * Math.sin(az) * Math.cos(el),
    target.y + dist * Math.sin(el),
    target.z + dist * Math.cos(az) * Math.cos(el),
  );
  camera.lookAt(target);
}
let dragId = null; // pointer-captured so a drag can't leak past pointercancel / context menus
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button !== 0 || dragId !== null) return;
  dragId = e.pointerId;
  renderer.domElement.setPointerCapture(dragId);
  e.preventDefault();
});
renderer.domElement.addEventListener('pointermove', e => {
  if (e.pointerId !== dragId) return;
  orbit.az -= e.movementX * 0.005;
  orbit.el = Math.min(1.2, Math.max(-0.1, orbit.el + e.movementY * 0.005));
  placeCamera();
});
const endDrag = e => { if (e.pointerId === dragId) dragId = null; };
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
renderer.domElement.addEventListener('wheel', e => {
  orbit.dist = Math.min(16, Math.max(3, orbit.dist + e.deltaY * 0.01));
  placeCamera();
  e.preventDefault();
}, { passive: false });

scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x4a5d3a, 0.85));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.05);
sun.position.set(6, 11, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -9; sun.shadow.camera.right = 9;
sun.shadow.camera.top = 9; sun.shadow.camera.bottom = -9;
sun.shadow.camera.updateProjectionMatrix(); // r128 shadows read the matrix, not the bounds
scene.add(sun);

// ground: gently rumpled green field + dirt pad, like the arena
{
  const geo = new THREE.PlaneGeometry(90, 90, 40, 40);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    if (Math.hypot(x, z) > 5) pos.setY(i, (Math.sin(x * 0.11) * Math.cos(z * 0.09) + Math.sin(x * 0.23 + 2.1) * 0.5) * 0.5);
  }
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, mat(0x6f9e54, { shared: false }));
  ground.receiveShadow = true;
  scene.add(ground);
  const pad = new THREE.Mesh(new THREE.CircleGeometry(4, 40), mat(0x8a6a45, { shared: false }));
  pad.rotateX(-Math.PI / 2); pad.position.y = 0.02; pad.receiveShadow = true;
  scene.add(pad);
}

const soldier = buildHumanoid(PLAYER_PALETTE, 1, 'sword');
const root = new THREE.Group();
root.add(soldier.group);
scene.add(root);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
placeCamera();

// ---------- pose -> rig ----------
const tmpQ = new THREE.Quaternion();
const soleL = new THREE.Vector3(), soleR = new THREE.Vector3();
function applyQ(part, q) { tmpQ.set(q.x, q.y, q.z, q.w); part.quaternion.slerp(tmpQ, SLERP_K); }
const shortAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

let lastSolved = null; // feeds solvePose's twist-continuity (opts.prev)
function applyPose(lms) {
  if (calibratePending) {
    calibratePending = false;
    if (demo) {
      note('calibration is for camera mode — look straight at the screen there, then press C');
    } else {
      const raw = solvePose(lms, { mirror, headOffset: null, prevYaw });
      if (raw) { headOffset = captureHeadOffset(raw); note('head calibrated — current pose is now neutral'); }
    }
  }
  const solved = solvePose(lms, { mirror, headOffset, prevYaw, prev: lastSolved?.q });
  if (!solved) return false;
  lastSolved = solved;
  lastVis = solved.vis;
  const p = soldier.parts, q = solved.q, v = solved.vis;

  if (v.torso >= VIS_GATE) {
    // yaw chases the hips only while they're actually seen — otherwise the rig
    // would spin on hallucinated landmarks under an intentionally frozen pose
    prevYaw = solved.yaw;
    root.rotation.y += shortAngle(solved.yaw - root.rotation.y) * 0.35;
    applyQ(p.upperBody, q.upperBody);
  }
  if (v.head >= VIS_GATE) applyQ(p.neck, q.neck);
  if (v.armL >= VIS_GATE) { applyQ(p.shoulderL, q.shoulderL); applyQ(p.elbowL, q.elbowL); }
  if (v.armR >= VIS_GATE) { applyQ(p.shoulderR, q.shoulderR); applyQ(p.elbowR, q.elbowR); }
  if (v.legL >= VIS_GATE) { applyQ(p.hipL, q.hipL); applyQ(p.kneeL, q.kneeL); }
  if (v.legR >= VIS_GATE) { applyQ(p.hipR, q.hipR); applyQ(p.kneeR, q.kneeR); }

  // plant the lowest sole on the ground so squats read as squats,
  // instead of the hips staying pinned at standing height
  root.updateMatrixWorld(true);
  p.kneeL.localToWorld(soleL.set(0, -1.0, 0.1));
  p.kneeR.localToWorld(soleR.set(0, -1.0, 0.1));
  const minY = Math.min(soleL.y, soleR.y);
  root.position.y += (0.02 - minY) * 0.3;
  return true;
}

// EMA the raw landmarks; solver + overlay both read the smoothed set
function smooth(raw) {
  if (!smoothed || smoothed.length !== raw.length) {
    smoothed = raw.map(l => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 1 }));
    return smoothed;
  }
  for (let i = 0; i < raw.length; i++) {
    const s = smoothed[i], r = raw[i];
    s.x += (r.x - s.x) * alpha; s.y += (r.y - s.y) * alpha; s.z += (r.z - s.z) * alpha;
    s.visibility += ((r.visibility ?? 1) - s.visibility) * alpha;
  }
  return smoothed;
}

// ---------- webcam + landmarker ----------
async function initLandmarker() {
  setStatus('loading pose model…');
  const vision = await FilesetResolver.forVisionTasks('./vendor/wasm');
  const opts = delegate => ({
    baseOptions: { modelAssetPath: './vendor/pose_landmarker_lite.task', delegate },
    runningMode: 'VIDEO', numPoses: 1,
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, opts('GPU'));
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(vision, opts('CPU'));
    note('GPU delegate unavailable — running the model on CPU');
  }
}
async function initCamera() {
  setStatus('starting camera…');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' }, audio: false,
  });
  video.srcObject = stream;
  await video.play();
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  camReady = true;
  pip.classList.remove('hidden'); // hidden until a real stream exists (demo mode shows no dead box)
}

function drawOverlay(normLms) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!normLms) return;
  drawUtils.drawConnectors(normLms, PoseLandmarker.POSE_CONNECTIONS, { color: '#6cf', lineWidth: 2 });
  drawUtils.drawLandmarks(normLms, { color: '#fff', radius: 2 });
}

// ---------- hud ----------
let noteTimer = 0;
function note(txt, sticky = false) {
  noteEl.textContent = txt;
  clearTimeout(noteTimer);
  if (!sticky) noteTimer = setTimeout(() => { noteEl.textContent = ''; }, 4000);
}
function syncButtons() {
  $('btnMirror').textContent = `mirror: ${mirror ? 'on' : 'off'} (M)`;
  $('btnDemo').textContent = `demo: ${demo ? 'on' : 'off'} (D)`;
  pip.classList.toggle('mirrored', mirror);
}
function toggleMirror() { mirror = !mirror; syncButtons(); }
function toggleDemo() {
  demo = !demo;
  smoothed = null; lastSolved = null; // never EMA-blend demo landmarks with live ones (pose lurch)
  syncButtons();
  if (!demo) ensureLive(); // camera may never have started (booted in demo / earlier failure)
}
$('btnMirror').onclick = toggleMirror;
$('btnDemo').onclick = toggleDemo;
$('btnCal').onclick = () => { calibratePending = true; };
$('smooth').oninput = e => { alpha = +e.target.value; };
$('smooth').value = alpha;
addEventListener('keydown', e => {
  if (e.repeat) return; // holding a key must not strobe the toggles
  if (e.key === 'm' || e.key === 'M') toggleMirror();
  if (e.key === 'd' || e.key === 'D') toggleDemo();
  if (e.key === 'c' || e.key === 'C') calibratePending = true;
});
syncButtons();

// ---------- main loop ----------
let frames = 0, fpsT = performance.now(), fps = 0;
const t0 = performance.now();

function tick() {
  requestAnimationFrame(tick);
  let applied = false;

  if (demo) {
    applied = applyPose(smooth(demoLandmarks((performance.now() - t0) / 1000)));
    drawOverlay(null);
    setStatus('DEMO — synthetic pose (D for camera)', 'ok');
  } else if (landmarker && camReady && video.readyState >= 2) {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const s = performance.now();
      const res = landmarker.detectForVideo(video, s);
      infMs = infMs * 0.9 + (performance.now() - s) * 0.1;
      if (res.worldLandmarks && res.worldLandmarks.length) {
        smooth(res.worldLandmarks[0]);
        drawOverlay(res.landmarks[0]);
      } else {
        drawOverlay(null);
        // nobody in frame: decay the stale visibilities so the limb gates close
        // and the status flips to LOST instead of showing TRACKING forever
        if (smoothed) for (const s of smoothed) s.visibility *= 0.8;
      }
    }
    if (smoothed) applied = applyPose(smoothed);
    if (applied && lastVis && lastVis.torso >= VIS_GATE) {
      trackedOnce = true;
      setStatus('TRACKING', 'ok');
    } else {
      setStatus(trackedOnce ? 'LOST — step back, whole body in frame' : 'looking for you — stand ~2 m back, whole body in frame', 'warn');
    }
  }

  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - fpsT > 500) {
    fps = Math.round(frames * 1000 / (now - fpsT));
    frames = 0; fpsT = now;
    statsEl.textContent = demo ? `${fps} fps` : `${fps} fps · pose ${infMs.toFixed(1)} ms`;
  }
}

// ---------- boot ----------
// Everything needed for live tracking inits on demand: at boot when not in demo
// mode, and again whenever the user leaves demo mode (D) after a camera-less start.
let liveInitInFlight = false;
async function ensureLive() {
  if (liveInitInFlight || (landmarker && camReady)) return;
  liveInitInFlight = true;
  try {
    if (!landmarker) await initLandmarker();
    try {
      if (!camReady) await initCamera();
    } catch (err) {
      console.error(err);
      note('camera unavailable or denied — showing demo pose instead');
      demo = true; syncButtons();
    }
  } catch (err) {
    console.error(err);
    note('pose model failed to load — demo pose only (see console)', true);
    demo = true; syncButtons();
  } finally {
    liveInitInFlight = false;
  }
}
if (!demo) ensureLive();
tick();
