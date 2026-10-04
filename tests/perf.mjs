// Load-speed measurements: tile requests, KB and time-to-reveal on a throttled phone.
// Run: node tests/perf.mjs [label]      (needs network; writes qa/perf-<label>.json)
// Profile: 390px wide, devicePixelRatio 3, "Fast 4G" = 9 Mbit/s down, 1.5 Mbit/s up, 170 ms RTT, fresh browser profile each run.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';

const label = process.argv[2] || 'run';
const QA = new URL('../qa/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(QA, { recursive: true });
const AIRPORTS = { Atlanta: 3384, 'General Dewitt Spain': 20403, Duqm: 299738 };
const FAST_4G = { offline: false, latency: 170, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
const isTile = (u) => /World_Imagery\/MapServer\/tile\//.test(u);

const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }

// service workers are blocked for the throttled first-visit measurements (SW fetches are not throttled by page-level emulation)
async function freshPage({ throttleFromStart = false, sw = false } = {}) {
  const ctx = await browser.newContext({ ...PHONE, serviceWorkers: sw ? 'allow' : 'block' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const tiles = [];
  page.on('response', (r) => { if (isTile(r.url())) tiles.push(r); });
  const throttle = () => cdp.send('Network.emulateNetworkConditions', FAST_4G);
  if (throttleFromStart) await throttle();
  return { ctx, page, tiles, throttle };
}
const sizeOf = async (tiles) => {
  let bytes = 0; const urls = new Set();
  for (const r of tiles) { try { bytes += (await r.body()).length; urls.add(r.url()); } catch { /* aborted */ } }
  return { requests: tiles.length, uniqueTiles: urls.size, kb: Math.round(bytes / 1024) };
};
const revealed = (page, id = null) => page.waitForFunction((want) => {
  const g = window.__ag;
  if (!g || window.__stale || !g.round || (want && g.round.answer.id !== want)) return false;
  const veil = document.querySelector('#veil');
  if (!(veil.hidden || veil.classList.contains('out'))) return false; // fade-out starts the moment every tile is in
  const t = [...document.querySelectorAll('.sat.front img.leaflet-tile')];
  return t.length > 0 && t.every((i) => i.classList.contains('leaflet-tile-loaded'));
}, id, { timeout: 120000, polling: 20 });

const out = { label, profile: '390px, DPR 3, Fast 4G (9 Mbit/s, 170 ms RTT)', rounds: {}, cold: null, zoomOut: {} };

// (a) one round per airport, after the app is loaded: tiles only
for (const [name, id] of Object.entries(AIRPORTS)) {
  const { ctx, page, tiles, throttle } = await freshPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 60000 });
  await revealed(page);
  if (await page.locator('#dlg-help[open]').count()) await page.keyboard.press('Escape');
  await page.evaluate(() => window.__ag.debugStart(21)); // warm-up: loads the Hard dataset unthrottled
  await revealed(page, 21);
  await page.waitForFunction(() => window.__ag.views.wide.status === 'ready', null, { timeout: 60000 }); // let the warm-up's background preload finish
  await page.waitForTimeout(500);
  await throttle();
  tiles.length = 0;
  const t0 = Date.now();
  await page.evaluate((i) => { window.__ag.debugStart(i); }, id);
  await revealed(page, id);
  const ms = Date.now() - t0;
  const atReveal = await sizeOf([...tiles]); // tiles requested by the moment the image is revealed (before background preload)
  const info = await page.evaluate(() => ({ zoom: window.__ag.map.getZoom(), n: window.__ag.view.retinaN, tilesInDom: document.querySelectorAll('.sat.front img.leaflet-tile').length, size: window.__ag.map.getSize() }));
  await page.waitForTimeout(1500); // let any background preloading finish so the counts are complete
  out.rounds[name] = { atReveal, totalWithBackgroundPreload: await sizeOf(tiles), revealMs: ms, ...info };
  await page.screenshot({ path: QA + `perf-${label}-${name.replace(/\W+/g, '')}.png` });
  await ctx.close();
}

// (b) cold start of today's daily on a fresh profile, throttled from the first byte: page load -> image revealed
{
  const { ctx, page, tiles } = await freshPage({ throttleFromStart: true });
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'commit' });
  await revealed(page);
  const ms = Date.now() - t0;
  const atReveal = await sizeOf([...tiles]);
  await page.waitForTimeout(1500);
  out.cold = { atReveal, totalWithBackgroundPreload: await sizeOf(tiles), revealMs: ms, airport: await page.evaluate(() => window.__ag.round.answer.name) };
  await ctx.close();
}

// (c) Zoom out after the main view is ready (tiles for the wider view)
{
  const { ctx, page, tiles, throttle } = await freshPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 60000 });
  await revealed(page);
  if (await page.locator('#dlg-help[open]').count()) await page.keyboard.press('Escape');
  await page.evaluate(() => window.__ag.debugStart(3384));
  await revealed(page, 3384);
  await page.waitForTimeout(6000); // time for any background preload of the zoom-out view
  await throttle();
  tiles.length = 0;
  await page.locator('#btn-zoom').click();
  await page.evaluate(() => { document.querySelector('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-confirm]')) { window.__zt0 = performance.now(); requestAnimationFrame(function f() { const v = document.querySelector('#veil'); const w = document.querySelector('#map-wide'); if (w.classList.contains('front') && (v.hidden || v.classList.contains('out')) && [...w.querySelectorAll('img.leaflet-tile')].every((i) => i.classList.contains('leaflet-tile-loaded'))) window.__zms = performance.now() - window.__zt0; else requestAnimationFrame(f); }); } }, true); });
  await page.locator('#sheet [data-confirm]').click();
  await page.waitForFunction(() => window.__zms !== undefined, null, { timeout: 60000, polling: 5 });
  out.zoomOut = { ...(await sizeOf(tiles)), revealMs: Math.round(await page.evaluate(() => window.__zms)) };
  await ctx.close();
}

// (d) repeat visit with the service worker: tiles come from the Cache API, whole app from the SW shell cache
{
  const { ctx, page, tiles, throttle } = await freshPage({ sw: true });
  await page.goto(BASE);
  await revealed(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await revealed(page);
  await page.waitForTimeout(4000); // let the wide view and the tile cache fill
  await page.reload(); await revealed(page);            // controlled load, caches warm
  await throttle();
  tiles.length = 0;
  await page.evaluate(() => { window.__stale = true; });
  const t0 = Date.now();
  await page.reload({ waitUntil: 'commit' });
  await revealed(page);
  const ms = Date.now() - t0;
  const fromSW = tiles.filter((r) => r.fromServiceWorker()).length;
  out.repeatVisit = { revealMs: ms, tileResponses: tiles.length, fromServiceWorker: fromSW };
  await ctx.close();
}

await browser.close();
server.close();
writeFileSync(QA + `perf-${label}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
