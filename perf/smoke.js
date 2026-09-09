// De-risk probe: does the game boot under headless Chrome, and are the perf hooks live?
const puppeteer = require('puppeteer-core');
const { start } = require('./serve');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  const { server, port } = await start();
  const url = `http://127.0.0.1:${port}/index.html`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--headless=new', '--no-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--window-size=1280,800',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  // Wait for the boot to expose the hooks we need.
  await page.waitForFunction(
    () => window.BV && typeof BV.bootUniverse === 'function' && typeof BV.perfSample === 'function',
    { timeout: 20000 }
  );

  const sample = await page.evaluate(async () => {
    BV.bootUniverse(1337);                 // deterministic-ish world, bypasses the sign-in gate
    await new Promise(r => setTimeout(r, 1500)); // let a world settle + frames accrue
    return BV.perfSample();
  });

  console.log('BOOTED. perfSample =', JSON.stringify(sample, null, 2));
  if (errs.length) console.log('\n--- page errors (' + errs.length + ') ---\n' + errs.slice(0, 12).join('\n'));

  await browser.close();
  server.close();
})().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
