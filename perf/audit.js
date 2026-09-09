// Draw-call audit: boot a scenario, then traverse the live scene and bucket every visible mesh by
// what it is, so we know WHERE the draw calls go before touching anything. InstancedMesh counts as
// ONE draw call no matter how many instances — that distinction is the whole game in low-poly.
const puppeteer = require('puppeteer-core');
const { start } = require('./serve');
const { SCENARIOS } = require('./scenarios');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEED_RNG = `(() => { let a=0xC0FFEE>>>0; Math.random=function(){a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}; window.__reseed=(s=0xC0FFEE)=>{a=s>>>0;}; })();`;
const KEY = process.argv[2] || 'boot-map';

const AUDIT = `
  const buckets = {};
  const bump = (k, tris) => { const b = buckets[k] || (buckets[k] = { draws: 0, tris: 0, instanced: 0 }); b.draws++; b.tris += tris || 0; };
  let visibleMeshes = 0, instancedDraws = 0;
  BV.scene.traverse((o) => {
    if (!o.visible) return;
    // a hidden ancestor hides the whole subtree
    for (let p = o.parent; p; p = p.parent) if (!p.visible) return;
    if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
    visibleMeshes++;
    const g = o.geometry, pos = g && g.attributes && g.attributes.position;
    const tris = g && g.index ? g.index.count / 3 : pos ? pos.count / 3 : 0;
    // label = nearest named ancestor (or geometry type)
    let label = o.name || '';
    for (let p = o.parent; p && !label; p = p.parent) label = p.name || (p.userData && p.userData.kind) || '';
    if (!label) label = (g && g.type) || o.type;
    const inst = o.isInstancedMesh ? o.count : 0;
    if (o.isInstancedMesh) instancedDraws++;
    bump(label + (o.isInstancedMesh ? ' [instanced×' + inst + ']' : ''), tris * (inst || 1));
  });
  const sorted = Object.entries(buckets).sort((a, b) => b[1].draws - a[1].draws);
  return { perf: BV.perf(), visibleMeshes, instancedDraws, top: sorted.slice(0, 30) };
`;

(async () => {
  const { server, port } = await start();
  const url = `http://127.0.0.1:${port}/index.html`;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--disable-background-timer-throttling'],
  });
  const scn = SCENARIOS.find(s => s.key === KEY);
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 400 });
  await page.evaluateOnNewDocument(SEED_RNG);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.BV && BV.bootUniverse && BV.perfSample, { timeout: 20000 });
  const r = await page.evaluate(`(async () => { window.__render=()=>BV.renderer.render(BV.scene,BV.camera); BV.freeze=true; if(window.__reseed)window.__reseed(); ${scn.body.replace(/return \{[\s\S]*?\};\s*$/, '')} ${AUDIT} })()`);
  console.log(`\nAUDIT: ${KEY}`);
  console.log(`renderer.info: ${r.perf.drawCalls} draws, ${(r.perf.triangles/1000).toFixed(0)}k tris`);
  console.log(`scene: ${r.visibleMeshes} visible render objects, ${r.instancedDraws} instanced\n`);
  console.log('top draw-call sources (label: draws / ktris):');
  for (const [label, b] of r.top) console.log(`  ${String(b.draws).padStart(4)}  ${(b.tris/1000).toFixed(0).padStart(5)}k  ${label}`);
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
