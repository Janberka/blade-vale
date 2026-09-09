// Determinism probe: run two scenarios twice each and print the counters side by side.
// If seeding + freeze worked, the two runs of each scenario are byte-identical.
const puppeteer = require('puppeteer-core');
const { start } = require('./serve');
const { SCENARIOS } = require('./scenarios');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEED_RNG = `(() => { let a=0xC0FFEE>>>0; Math.random=function(){a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}; window.__reseed=(s=0xC0FFEE)=>{a=s>>>0;}; })();`;
const KEYS = ['boot-map', 'action-battle-200'];

async function once(browser, url, scn) {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 400 });
  await page.evaluateOnNewDocument(SEED_RNG);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.BV && BV.bootUniverse && BV.perfSample, { timeout: 20000 });
  const m = await page.evaluate(`(async () => {
    window.__render=()=>BV.renderer.render(BV.scene,BV.camera); BV.freeze=true; if(window.__reseed)window.__reseed();
    const r = await (async () => { ${scn.body} })();
    const d = BV.detailTier();
    return Object.assign(r, { _tier:d.tier, _fine:d.fineTiles, _hyper:d.hyperTiles, _tiles:d.tiles, _closeup:d.closeup });
  })()`);
  await page.close();
  return m;
}

(async () => {
  const { server, port } = await start();
  const url = `http://127.0.0.1:${port}/index.html`;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--disable-background-timer-throttling'],
  });
  const N = 4;
  for (const key of KEYS) {
    const scn = SCENARIOS.find(s => s.key === key);
    console.log('\n' + key);
    for (let i = 0; i < N; i++) {
      const r = await once(browser, url, scn);
      console.log(`  draws=${r.drawCalls} geo=${r.geometries} tier=${r._tier} fine=${r._fine} hyper=${r._hyper} tiles=${r._tiles} closeup=${r._closeup}`);
    }
  }
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
