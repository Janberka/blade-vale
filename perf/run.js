#!/usr/bin/env node
// Perf harness — the trustworthy measurement substrate the optimization loop stands on.
//
//   node perf/run.js            check current numbers against perf/budgets.json (exit 1 on regression)
//   node perf/run.js --update   (re-)capture budgets from the current tree (do this on a known-good commit)
//   node perf/run.js --json     emit the raw metrics as JSON (for the /loop agent to read)
//
// Why counters, not FPS: headless Chrome renders via software GL (a single 977k-triangle frame takes
// ~15s), so on-screen FPS here is meaningless. Draw calls, triangle counts, and CPU-timed sim steps
// ARE stable and regression-meaningful — they're the *causes* of bad device FPS. Real iPhone-13 FPS
// is a separate, manual device check (see perf/README.md).

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { start } = require('./serve');
const { SCENARIOS } = require('./scenarios');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BUDGETS = path.join(__dirname, 'budgets.json');
const TOL = 0.15; // 15% headroom before a metric counts as a regression
const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const JSON_OUT = args.includes('--json');
const runsArg = args.indexOf('--runs');
const RUNS = runsArg >= 0 ? Math.max(1, parseInt(args[runsArg + 1], 10) || 3) : 3;

// Per-metric median across the repeated runs. Non-numeric fields take the first sample's value.
function median(samples) {
  const out = {};
  for (const k of Object.keys(samples[0])) {
    const vals = samples.map(s => s[k]).filter(v => typeof v === 'number').sort((a, b) => a - b);
    out[k] = vals.length ? vals[Math.floor((vals.length - 1) / 2)] : samples[0][k];
  }
  return out;
}

// Metrics where SMALLER is better (draws/tris/ms). Everything here is guarded as "must not exceed
// baseline * (1+TOL)". LOD-presence metrics (fineTiles/streets/fighters) are recorded but not failed
// on — they're context, and a dedicated floor check guards against LOD silently switching OFF.
const LOWER_IS_BETTER = /drawCalls|triangles|geometries|Ms$|MsPerFrame$/;
// Metrics that must not DROP to zero — that would mean the detail/LOD system stopped engaging.
// fineTiles/hyperTiles prove the detail bubble is engaging (#6). NOT `streets` — that's legitimately 0
// when the deterministic spawn isn't adjacent to a settlement, so a floor on it would false-positive.
const MUST_STAY_POSITIVE = { 'action-street-rung2': ['fineTiles'], 'action-battle-200': ['fighters'] };

// Per-metric regression tolerance. Render COUNTERS (draws/tris/geometries) are near-exact run-to-run
// — seed + reseed + freeze + fixed camera make them repeat to the digit — and they're LOAD-INDEPENDENT
// (renderer.info counts geometry, not wall-clock), so they're the trustworthy device-FPS proxy and keep
// the tight TOL. Everything TIME-based is a different story on a shared dev box: it scales with machine
// load. simMsPerFrame is a MEAN over 100+ deterministic steps, so it only wobbles moderately (a wider
// band absorbs light background load). The `switchTo*Ms` numbers are the worst case — each is ONE
// wall-clock timing of a whole detail-tier rebuild (terrain re-tessellation + scatter + geometry
// construction + whatever GC lands mid-transition), swinging ~40% even between back-to-back quiet runs.
// Their bands still catch the regression these guards exist for — a rebuild that stops being budgeted
// and goes fully synchronous, or a per-frame sim cost that jumps 1.5x+ — without flapping on noise.
// NB none of these survive a pathologically loaded machine (load avg ≫ cores inflates them ~3x); that's
// inherent to CPU-time benchmarking — capture baselines and check on a reasonably quiet box.
const SIM_MS_TOL = 0.4;      // averaged per-frame CPU sim cost
const SWITCH_MS_TOL = 0.6;   // single-shot transition wall-clock
function tolFor(k) {
  if (/switchTo\w*Ms$/.test(k)) return SWITCH_MS_TOL;
  if (/MsPerFrame$/.test(k)) return SIM_MS_TOL;
  return TOL;
}

function log(...a) { if (!JSON_OUT) console.log(...a); }

async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    // A street-tier transition (mode-switch) genuinely rebuilds terrain tessellation + scatter, which
    // under software-GL takes ~1.5s; the default 180s protocol timeout can trip under multi-run load.
    protocolTimeout: 600000,
    args: [
      '--headless=new', '--no-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
}

// Injected before ANY page script runs. Seeding Math.random makes worldgen + band/reserve spawning
// deterministic, so the render counters are identical run-to-run (the whole point of a budget guard).
const SEED = 0xC0FFEE;
const SEED_RNG = `(() => {
  let a = ${SEED} >>> 0;
  Math.random = function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Reset the stream to a fixed point right before the deterministic world rebuild, so a variable
  // number of pre-measurement rAF frames (each consuming draws) can't shift the world we sample.
  window.__reseed = (s = ${SEED}) => { a = s >>> 0; };
})();`;

async function measure(page, scn) {
  // __render forces exactly one draw so renderer.info counters reflect this scenario's scene.
  // BV.freeze stops the concurrent rAF loop from mutating the world mid-measurement — from here only
  // the scenario's own deterministic BV.advance*/processTerrainQueue steps change state.
  const code = `(async () => {
    window.__render = () => BV.renderer.render(BV.scene, BV.camera);
    BV.freeze = true;
    if (window.__reseed) window.__reseed();
    try { ${scn.body} } catch (e) { return { __error: String(e && e.stack || e) }; }
  })()`;
  return page.evaluate(code);
}

async function runAll() {
  const { server, port } = await start();
  const url = `http://127.0.0.1:${port}/index.html`;
  const browser = await launch();
  const results = {};
  try {
    for (const scn of SCENARIOS) {
      // Repeat each scenario and take the per-metric MEDIAN. Counters are near-exact after the settle
      // (seed + reseed + freeze + forced tier + fresh chunk ring + pinned camera), but an occasional
      // lazily-built settlement and normal CPU-timing jitter still wobble a run — median absorbs both.
      const samples = [];
      let lastErr = null;
      for (let i = 0; i < RUNS; i++) {
        const page = await browser.newPage();
        // Small viewport: counters are resolution-independent, but software-GL raster cost scales with
        // pixels — keeping it tiny is what makes each scenario finish in seconds, not minutes.
        await page.setViewport({ width: 640, height: 400 });
        await page.evaluateOnNewDocument(SEED_RNG); // deterministic world before the game script runs
        page.on('pageerror', () => {});
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        await page.waitForFunction(
          () => window.BV && typeof BV.bootUniverse === 'function' && typeof BV.perfSample === 'function',
          { timeout: 20000 }
        );
        const m = await measure(page, scn);
        await page.close();
        if (m && m.__error) lastErr = m.__error; else samples.push(m);
      }
      if (!samples.length) { log(`  ✗ ${scn.key}: scenario threw\n    ${(lastErr||'').split('\\n')[0]}`); results[scn.key] = { __error: lastErr || 'no samples' }; }
      else { const m = median(samples); results[scn.key] = m; log(`  • ${scn.key.padEnd(22)} ${fmt(m)}`); }
    }
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

function fmt(m) {
  return Object.entries(m).map(([k, v]) => `${k}=${v}`).join('  ');
}

function check(results, budgets) {
  const fails = [];
  for (const scn of SCENARIOS) {
    const cur = results[scn.key], base = budgets[scn.key];
    if (!cur || cur.__error) { fails.push(`${scn.key}: scenario error`); continue; }
    if (!base) { fails.push(`${scn.key}: no baseline (run --update)`); continue; }
    for (const [k, v] of Object.entries(cur)) {
      if (LOWER_IS_BETTER.test(k) && typeof v === 'number' && typeof base[k] === 'number') {
        const tol = tolFor(k);
        const ceil = base[k] * (1 + tol) + (/Ms/.test(k) ? 1 : 0); // +1ms slack on timing noise
        if (v > ceil) fails.push(`${scn.key}.${k}: ${v} > ${ceil.toFixed(1)} (baseline ${base[k]}, +${(tol * 100)|0}%)`);
      }
    }
    for (const k of (MUST_STAY_POSITIVE[scn.key] || [])) {
      if (!(cur[k] > 0)) fails.push(`${scn.key}.${k}: ${cur[k]} — LOD/detail no longer engaging`);
    }
  }
  return fails;
}

(async () => {
  log(`Perf harness — ${SCENARIOS.length} scenarios × ${RUNS} runs (median; proxy metrics, not device FPS)\n`);
  const results = await runAll();

  if (JSON_OUT) { console.log(JSON.stringify(results, null, 2)); }

  if (UPDATE) {
    const clean = {};
    for (const [k, v] of Object.entries(results)) if (!v.__error) clean[k] = v;
    fs.writeFileSync(BUDGETS, JSON.stringify(clean, null, 2) + '\n');
    log(`\n✓ baselines written to ${path.relative(process.cwd(), BUDGETS)} (${Object.keys(clean).length} scenarios)`);
    return;
  }

  if (!fs.existsSync(BUDGETS)) {
    log('\n! no perf/budgets.json yet — run:  node perf/run.js --update  on a known-good commit');
    process.exit(2);
  }
  const budgets = JSON.parse(fs.readFileSync(BUDGETS, 'utf8'));
  const fails = check(results, budgets);
  if (fails.length) {
    log(`\n✗ ${fails.length} perf regression(s):`);
    for (const f of fails) log('   - ' + f);
    process.exit(1);
  }
  log('\n✓ all scenarios within budget');
})().catch((e) => { console.error('HARNESS FAILED:', e); process.exit(1); });
