/* A headset out of thin air — a fake WebXR device for the browser tests (?xrshim). NOT shipped (not in tools/build-site.js).
   Enough of navigator.xr / XRSession / XRFrame / XRWebGLLayer for three r128's WebXRManager: a two-eyed viewer pose, two
   Touch-shaped input sources with grip + ray spaces, an xr-standard gamepad each (sticks, buttons, a haptic that logs),
   local-floor reference space, and stereo viewports over the canvas. Poses are read from window.XRSHIM each frame, so a
   test moves the head or a hand by writing XRSHIM.head.p / XRSHIM.hands[i].p (metres) and .q (quaternion xyzw). */
(() => {
  if (!/[?&]xrshim\b/.test(location.search)) return;
  const S = window.XRSHIM = {
    head: { p: [0, 1.65, 0], q: [0, 0, 0, 1] },
    hands: [{ hand: 'left', p: [-0.22, 1.15, -0.35], q: [0, 0, 0, 1], buttons: [0, 0, 0, 0, 0, 0, 0], axes: [0, 0, 0, 0] },
            { hand: 'right', p: [0.22, 1.15, -0.35], q: [0, 0, 0, 1], buttons: [0, 0, 0, 0, 0, 0, 0], axes: [0, 0, 0, 0] }],
    ipd: 0.064, fov: 90, session: null, frames: 0, sessions: 0, pulses: [], pending: new Map(), rafId: 0,
  };
  S.tick = (t) => { const cbs = [...S.pending.values()]; S.pending.clear(); const s = S.session; if (!s || s.ended) return 0; for (const cb of cbs) cb(t == null ? performance.now() : t, new Frame(s)); return cbs.length; };   // tests: run one XR frame now
  const mat = (p, q) => {                                    // column-major, like DOMMatrix / three
    const [x, y, z, w] = q, xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    return new Float32Array([1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0, 2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0, 2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0, p[0], p[1], p[2], 1]);
  };
  const persp = (fovDeg, aspect, n, f) => { const t = 1 / Math.tan(fovDeg * Math.PI / 360); return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]); };
  const rot = (q, v) => { const [x, y, z, w] = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]; };
  class Transform { constructor(p, q) { this.position = { x: p[0], y: p[1], z: p[2], w: 1 }; this.orientation = { x: q[0], y: q[1], z: q[2], w: q[3] }; this.matrix = mat(p, q); } }
  class Space { constructor(kind, i) { this.kind = kind; this.i = i; } }
  class Layer {
    constructor(session, gl, init) { this.gl = gl; this.init = init || {}; this.framebuffer = null; this.ignoreDepthValues = false; S.layer = this; }
    get framebufferWidth() { return this.gl.drawingBufferWidth; } get framebufferHeight() { return this.gl.drawingBufferHeight; }
    getViewport(view) { const w = this.gl.drawingBufferWidth, h = this.gl.drawingBufferHeight; return view.eye === 'right' ? { x: w >> 1, y: 0, width: w - (w >> 1), height: h } : { x: 0, y: 0, width: w >> 1, height: h }; }
  }
  Layer.getNativeFramebufferScaleFactor = () => 1;
  window.XRWebGLLayer = Layer;
  class Frame {
    constructor(session) { this.session = session; S.frames++; }
    getViewerPose() {
      const w = S.layer ? S.layer.gl.drawingBufferWidth : 1280, h = S.layer ? S.layer.gl.drawingBufferHeight : 720, aspect = (w / 2) / Math.max(1, h);
      const views = ['left', 'right'].map((eye, i) => { const o = rot(S.head.q, [(i ? 1 : -1) * S.ipd / 2, 0, 0]); return { eye, transform: new Transform([S.head.p[0] + o[0], S.head.p[1] + o[1], S.head.p[2] + o[2]], S.head.q), projectionMatrix: persp(S.fov, aspect, this.session.renderState.depthNear, this.session.renderState.depthFar) }; });
      return { transform: new Transform(S.head.p, S.head.q), views, emulatedPosition: false };
    }
    getPose(space) { const H = S.hands[space.i]; return H ? { transform: new Transform(H.p, H.q), emulatedPosition: false } : null; }
  }
  const source = i => { const H = S.hands[i]; return {
    handedness: H.hand, targetRayMode: 'tracked-pointer', targetRaySpace: new Space('ray', i), gripSpace: new Space('grip', i), profiles: ['oculus-touch-v3', 'generic-trigger-squeeze-thumbstick'],
    gamepad: { id: 'shim-' + H.hand, index: i, connected: true, mapping: 'xr-standard', hapticActuators: [{ pulse(v, ms) { S.pulses.push([H.hand, +v.toFixed(2), ms]); return Promise.resolve(true); } }],
      get buttons() { return H.buttons.map(v => ({ pressed: v > 0.5, touched: v > 0, value: v })); }, get axes() { return H.axes; } } }; };
  class Session extends EventTarget {
    constructor() { super(); this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000, inlineVerticalFieldOfView: null }; this.inputSources = [source(0), source(1)]; this.environmentBlendMode = 'opaque'; this.visibilityState = 'visible'; this.ended = false; }
    updateRenderState(s) { Object.assign(this.renderState, s || {}); }
    requestReferenceSpace(type) { this.refType = type; return Promise.resolve(new Space('ref', -1)); }
    requestAnimationFrame(cb) { const id = ++S.rafId; S.pending.set(id, cb); requestAnimationFrame(t => { if (S.pending.delete(id) && !this.ended) cb(t, new Frame(this)); }); return id; }   // (a hidden tab never fires rAF: XRSHIM.tick drives the pending frame by hand)
    cancelAnimationFrame(id) { S.pending.delete(id); }
    end() { if (this.ended) return Promise.resolve(); this.ended = true; S.session = null; this.dispatchEvent(new Event('end')); return Promise.resolve(); }
  }
  const xr = {
    isSessionSupported: mode => Promise.resolve(mode === 'immersive-vr' || mode === 'inline'),
    requestSession: () => { const s = new Session(); S.session = s; S.sessions++; setTimeout(() => { const e = new Event('inputsourceschange'); e.added = s.inputSources; e.removed = []; s.dispatchEvent(e); }, 0); return Promise.resolve(s); },
    addEventListener() {}, removeEventListener() {}, ondevicechange: null,
  };
  try { Object.defineProperty(navigator, 'xr', { value: xr, configurable: true }); } catch (e) { navigator.xr = xr; }
  for (const P of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) if (P) P.prototype.makeXRCompatible = function () { return Promise.resolve(); };   // (the real one waits on a device that is not there)
  console.log('[xr-shim] a fake headset is plugged in');
})();
