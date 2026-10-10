// End-to-end checks with headless Playwright. Run: node tests/e2e.mjs
// Plays full games on a phone (390x844) and desktop viewport against a local static server (needs network for Esri tiles).
import { launchBrowser, browserName } from './browser.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';
import * as C from '../js/core.js';
import { IMAGERY } from '../js/config.js';
import * as TM from '../js/tilemath.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8')).airports;
const airports = read('airports.json');
const hardList = read('airports-hard.json');
const topList = airports.filter((x) => x.top).sort((x, y) => x.top - y.top);          // Daily pool: the busiest airports (ACI ranking)
const hardPool = [...airports.filter((x) => !x.top), ...hardList];                      // Hard pool: every other airport
const by = (iata) => airports.find((a) => a.iata === iata);
const OUT = new URL('../test-output/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT, { recursive: true });

const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) {
  try { browser = await launchBrowser(opts); break; } catch { /* next */ }
}
if (!browser) throw new Error('no browser available');

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const errors = [];
let passed = 0;

// Test airports: a hub, a small regional airfield (hard pool), a remote desert airfield (the v1 screenshot), an Antarctic station.
const HUB = 3384, SMALL = 20403, REMOTE = 299738;

// `sw: false` blocks service workers so page.route() sees every tile request (SW-initiated fetches bypass page.route)
async function newPage(profile, { watch = true, sw = true } = {}) {
  const ctx = await browser.newContext({ ...profile, ...(browserName === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}), serviceWorkers: sw ? 'allow' : 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* blocked */ } }); // the first-run help dialog opens after the first image; tests do not want it
  const page = await ctx.newPage();
  if (watch) {
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  }
  return { ctx, page };
}
async function ready(page) {
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 });
  await page.waitForFunction(() => document.querySelector('#veil').hidden, null, { timeout: 40000 });
  await page.waitForFunction(() => document.querySelectorAll('.sat.front .leaflet-tile-loaded').length > 0, null, { timeout: 40000 });
  await page.waitForTimeout(700);
}
async function open(page) {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag, null, { timeout: 30000 });
  if (await page.locator('#dlg-help[open]').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
}
/** Start a practice round on a specific airport (test hook), wait for tiles. */
async function start(page, id) {
  const res = await page.evaluate((i) => window.__ag.debugStart(i), id);
  await page.waitForFunction(() => document.querySelector('#veil').hidden, null, { timeout: 40000 });
  await page.waitForTimeout(1200);
  return res;
}
const answerOf = (page) => page.evaluate(() => window.__ag.round.answer);
const rowCount = (page) => page.locator('#guesses .row').count();
const spentOf = (page) => page.evaluate(() => window.__ag.round.log.length);
const leftText = (page) => page.locator('#left').innerText();

async function guess(page, query, { viaKeyboard = false, expect = query } = {}) {
  const before = await rowCount(page);
  const input = page.locator('#guess-input');
  await input.fill('');
  await input.fill(query);
  await page.waitForSelector('#suggestions li[role=option]');
  const first = page.locator('#suggestions li[role=option]').first();
  assert.match(await first.innerText(), new RegExp(expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `first suggestion for ${query}`);
  if (viaKeyboard) {
    await input.press('Enter');
    assert.equal(await page.locator('#guess-btn').isEnabled(), true);
    await input.press('Enter');
  } else {
    await first.click();
    await page.locator('#guess-btn').click();
  }
  await page.waitForFunction((n) => document.querySelectorAll('#guesses .row').length === n, before + 1);
}
const wrongPick = (answer, n) => ['JFK', 'LHR', 'SIN', 'GRU', 'SYD', 'DXB'].map(by).filter((a) => a.id !== answer.id).slice(0, n);

// Playwright's WebKit/Firefox have no CDP, no Touch constructor, no clipboard-read and an unstable service worker on Windows:
// these tests exercise the test harness, not the app, so they run on Chromium only (AG_BROWSER=chromium, the default).
const CHROMIUM_ONLY = /stalled tiles|built site only|start view: nothing moves|win after a hint|Hard mode: separate toggle|PWA: manifest|service worker caches tiles/;
async function test(name, fn) {
  if (browserName !== 'chromium' && CHROMIUM_ONLY.test(name)) { console.log(`  skip ${name} (needs Chromium test tooling)`); return; }
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 4).join('\n       ')}`); process.exitCode = 1; }
}

/** Measure the airfield box as actually rendered: fraction of the viewport and offset of its centre from the frame centre. */
const measure = (page) => page.evaluate(() => {
  const g = window.__ag, m = g.map, a = g.round.answer;
  const [clat, clon, w, h] = a.view;
  const size = m.getSize();
  const dLat = Math.max(h, 150) / 2 / 110574;
  const dLon = Math.max(w, 150) / 2 / (111320 * Math.cos((clat * Math.PI) / 180));
  const p1 = m.latLngToContainerPoint([clat - dLat, clon - dLon]);
  const p2 = m.latLngToContainerPoint([clat + dLat, clon + dLon]);
  const pw = Math.abs(p2.x - p1.x), ph = Math.abs(p2.y - p1.y);
  const c = m.latLngToContainerPoint([clat, clon]);
  return {
    W: size.x, H: size.y, zoom: m.getZoom(),
    fillW: pw / size.x, fillH: ph / size.y, fill: Math.max(pw / size.x, ph / size.y),
    offX: Math.abs(c.x - size.x / 2), offY: Math.abs(c.y - size.y / 2), lift: g.lift,
  };
});

/** Every loaded tile must be real imagery at native resolution (tilemap says it exists). */
async function assertTilesReal(page) {
  const srcs = await page.$$eval('.sat.front img.leaflet-tile-loaded', (imgs) => imgs.map((i) => i.src));
  assert.ok(srcs.length > 0);
  const zs = new Set();
  for (const s of srcs.slice(0, 10)) {
    const m = s.match(/tile\/(\d+)\/(\d+)\/(\d+)/);
    assert.ok(m, s);
    zs.add(+m[1]);
    const r = await (await page.request.get(`https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/${m[1]}/${m[2]}/${m[3]}/1/1?f=json`)).json();
    assert.equal(r.data[0], 1, 'placeholder tile (no imagery) shown: ' + s);
  }
  return [...zs];
}

// ---------------------------------------------------------------- phone
console.log('phone 390x844');

const QA = new URL('../qa/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(QA, { recursive: true });
const qaReport = [];

/** Sharpness audit of what is on screen: bitmap pixels per device pixel, tile levels, transforms, placeholders. */
async function auditSharp(page) {
  const a = await page.evaluate(() => {
    const g = window.__ag, dpr = devicePixelRatio;
    const tiles = [...document.querySelectorAll('.sat.front img.leaflet-tile')];
    const rects = tiles.map((t) => ({ css: t.getBoundingClientRect().width, nat: t.naturalWidth, loaded: t.classList.contains('leaflet-tile-loaded'), level: +t.src.match(/tile\/(\d+)\//)[1] }));
    return {
      dpr, zoom: g.map.getZoom(), n: g.view.retinaN, nz: g.round.answer.nz,
      levels: [...new Set(rects.map((r) => r.level))], allLoaded: rects.every((r) => r.loaded), count: rects.length,
      minBitmapPerDevicePx: Math.min(...rects.map((r) => r.nat / (r.css * dpr))),
      tileCss: rects[0].css,
      transforms: [...document.querySelectorAll('.sat.front .leaflet-tile-container')].map((e) => e.style.transform).filter((t) => /scale\((?!1\))/.test(t)),
      rendering: getComputedStyle(tiles[0]).imageRendering,
    };
  });
  assert.equal(a.levels.length, 1, 'only one tile level on screen (no stand-in tiles): ' + a.levels);
  assert.equal(a.levels[0], a.zoom + a.n, 'tiles come from level zoom + retina levels');
  assert.ok(a.levels[0] <= a.nz, `never deeper than native imagery (level ${a.levels[0]} > nz ${a.nz})`);
  assert.ok(a.allLoaded, 'all tiles of the view are loaded before the image is shown');
  assert.ok(a.minBitmapPerDevicePx >= (a.dpr > 1 ? 2 / a.dpr : 1) - 0.01, `bitmap pixels per device pixel ${a.minBitmapPerDevicePx.toFixed(2)} (+1 level: 2 bitmap px per CSS px)`);
  assert.deepEqual(a.transforms, [], 'no CSS scaling of the tile layer');
  assert.equal(a.rendering, 'auto');
  assert.equal(Number.isInteger(a.zoom), true);
  return a;
}

await test('DPR 3 phone: hub, small regional airfield, remote airfield are sharp (retina tiles, integer zoom, native-capped), fill the frame, centred', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  assert.equal(await page.evaluate(() => devicePixelRatio), 3);
  const results = {};
  for (const [name, id] of [['hub', HUB], ['small', SMALL], ['remote', REMOTE]]) {
    const res = await start(page, id);
    assert.ok(res && res.z, name + ' resolved');
    const m = await measure(page);
    const s = await auditSharp(page);
    results[name] = { m, s };
    assert.ok(m.fill >= 0.38 && m.fill <= 0.785, `${name}: airfield fills ${(m.fill * 100).toFixed(0)}% of the frame`);
    assert.ok(m.offX < 3 && Math.abs(m.offY - Math.abs(m.lift)) < 3, `${name}: centred in the space free of chips and pill (offset ${m.lift}px) (${m.offX.toFixed(1)}, ${m.offY.toFixed(1)})`);
    assert.equal(s.n, 1, 'extra tile levels capped at +1 even at dpr 3');
    assert.equal(s.tileCss, 128, 'tiles drawn at 128 CSS px (256 bitmap px)');
    await assertTilesReal(page);
    await page.screenshot({ path: QA + `phone-dpr3-${name}.png` });
    const a = await answerOf(page);
    qaReport.push({ airport: a.name, iata: a.iata || a.icao, pool: a.top ? 'daily (top ' + a.top + ')' : 'hard', dpr: s.dpr, zoomUsed: s.zoom, tileLevelRequested: s.levels[0], nativeMaxLevel: s.nz, fillPct: Math.round(m.fill * 100), bitmapPxPerDevicePx: +s.minBitmapPerDevicePx.toFixed(2) });
  }
  assert.ok(results.small.m.zoom - results.hub.m.zoom >= 1, `small airfield (${results.small.m.zoom}) tighter than hub (${results.hub.m.zoom})`);
  console.log('       zoom: hub ' + results.hub.m.zoom + ', small ' + results.small.m.zoom + ', remote ' + results.remote.m.zoom + ' (tile levels +2)');
  await ctx.close();
});

await test('native cap: when imagery is shallower than the fitted zoom, the airport gets smaller instead of blurry', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  // simulate a location whose real imagery ends at level 13 (data patched in memory only)
  await start(page, 21); // loads the airport lists (they are no longer fetched before the first image)
  await page.evaluate((id) => { window.__ag.byId.get(id).nz = 13; }, HUB);
  await start(page, HUB);
  const s = await auditSharp(page);
  const m = await measure(page);
  const fit = C.fitZoom(await answerOf(page), m.W, m.H);
  assert.ok(fit > s.zoom, 'fitted zoom ' + fit + ' was reduced');
  assert.equal(s.zoom, 12, 'zoom = nz (13) - retina levels (1)');
  assert.equal(s.levels[0], 13, 'requested tile level never beyond native max');
  assert.ok(m.fill < 0.7, 'airport is smaller in the frame (' + (m.fill * 100).toFixed(0) + '%) rather than upscaled');
  await page.screenshot({ path: QA + 'phone-dpr3-native-cap-simulated.png' });
  await ctx.close();
});

await test('DPR 1 and DPR 2 renders also pick matching tile levels and stay sharp', async () => {
  for (const dsf of [1, 2]) {
    const { ctx, page } = await newPage({ ...PHONE, deviceScaleFactor: dsf });
    await open(page);
    await start(page, SMALL);
    const s = await auditSharp(page);
    assert.equal(s.n, dsf === 1 ? 0 : 1);
    assert.equal(s.tileCss, 256 / 2 ** s.n);
    await ctx.close();
  }
});

await test('zoom-out reveals only after all tiles of the wider view are loaded (no stand-in tiles)', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await start(page, HUB);
  const a = await answerOf(page);
  await guess(page, wrongPick(a, 1)[0].iata);
  await page.locator('#btn-zoom').click();
  await page.locator('#sheet [data-confirm]').click();
  // while loading the veil covers the map; sample until it is gone
  await page.waitForFunction(() => document.querySelector('#veil').hidden, null, { timeout: 30000 });
  const s = await auditSharp(page);
  assert.equal(s.zoom, (await measure(page)).zoom);
  await page.screenshot({ path: QA + 'phone-dpr3-hub-zoomed-out.png' });
  await ctx.close();
});

await test('tile requests are cacheable plain GETs spread over both hosts; only the frame is loaded (no buffer, no off-screen tiles)', async () => {
  const { ctx, page } = await newPage(PHONE);
  const reqs = [];
  page.on('request', (r) => { if (/World_Imagery\/MapServer\/tile\//.test(r.url())) reqs.push(r); });
  await open(page);
  await start(page, HUB);
  await page.waitForFunction(() => window.__ag.views.wide.status === 'ready', null, { timeout: 30000 });
  assert.ok(reqs.length > 0);
  for (const r of reqs) assert.ok(!r.url().includes('?') && r.method() === 'GET', 'no cache-busting params: ' + r.url());
  const hosts = new Set(reqs.map((r) => new URL(r.url()).hostname));
  assert.deepEqual([...hosts].sort(), ['server.arcgisonline.com', 'services.arcgisonline.com']);
  // main view: exactly the tiles intersecting the frame
  const m = await page.evaluate(() => { const v = window.__ag.views.main; const a = window.__ag.round.answer; const c = [a.view[0], a.view[1]]; const z = v.map.getZoom(); return { expected: v.tilesFor(c, z).length, inDom: document.querySelectorAll('#map img.leaflet-tile').length, size: v.map.getSize() }; });
  assert.equal(m.inDom, m.expected, 'DOM tiles = frame tiles');
  assert.ok(m.expected <= 25, `a 358x371 frame needs ${m.expected} tiles at +1 (was 49 at +2)`);
  const frame = await page.evaluate(() => { const s = document.querySelector('#stage').getBoundingClientRect(), mp = document.querySelector('#map').getBoundingClientRect(); return { dw: Math.abs(s.width - mp.width), dh: Math.abs(s.height - mp.height) }; });
  assert.deepEqual([frame.dw, frame.dh], [0, 0], 'map container is exactly the frame');
  await ctx.close();
});

await test('zoom-out view is preloaded in the background; Zoom out is an instant swap with no new requests and no loading state', async () => {
  const { ctx, page } = await newPage(PHONE);
  const reqs = [];
  page.on('request', (r) => { if (/World_Imagery\/MapServer\/tile\//.test(r.url())) reqs.push(r.url()); });
  await open(page);
  await start(page, HUB);
  await page.waitForFunction(() => window.__ag.views.wide.status === 'ready', null, { timeout: 30000 }); // no user action needed
  const a = await answerOf(page);
  await guess(page, wrongPick(a, 1)[0].iata);
  reqs.length = 0;
  await page.locator('#btn-zoom').click();
  await page.locator('#sheet [data-confirm]').click();
  const state = await page.evaluate(() => ({ wideFront: document.querySelector('#map-wide').classList.contains('front'), veilHidden: document.querySelector('#veil').hidden }));
  assert.deepEqual(state, { wideFront: true, veilHidden: true }, 'swapped synchronously, skeleton never shown');
  await page.waitForTimeout(400);
  assert.equal(reqs.length, 0, 'no tile requests on Zoom out: ' + reqs.length);
  const s = await auditSharp(page);
  assert.equal(s.zoom, (await measure(page)).zoom);
  await ctx.close();
});

await test('loading state: skeleton with spinner + tiles-loaded progress; nothing but the skeleton until every tile is in, then a fade', async () => {
  const { ctx, page } = await newPage(PHONE, { sw: false });
  await open(page);
  await page.evaluate(() => window.__ag.debugStart(21)); // warm-up: loads the Hard dataset first
  await ready(page);
  let k = 0;
  await page.route('**/World_Imagery/MapServer/tile/**', async (route) => { await new Promise((r) => setTimeout(r, 150 + (k++ % 16) * 120)); await route.continue(); }); // staggered so progress advances
  await page.evaluate(() => { window.__ag.debugStart(3384); }); // does not wait for the load
  await page.waitForFunction(() => !document.querySelector('#veil').hidden && document.querySelector('#veil-count').textContent !== '');
  const seen = { counts: new Set(), spinner: false, bar: false, covered: true, partialVisible: false };
  for (let i = 0; i < 400; i++) {
    const s = await page.evaluate(() => {
      const v = document.querySelector('#veil');
      if (v.hidden || v.classList.contains('out')) return { done: true };
      const tiles = [...document.querySelectorAll('.sat.front img.leaflet-tile-loaded')].length;
      return { done: false, count: document.querySelector('#veil-count').textContent, spinner: getComputedStyle(document.querySelector('.spinner')).display !== 'none', bar: parseFloat(document.querySelector('#veil-bar').style.width || '0'), opacity: getComputedStyle(v).opacity, bg: getComputedStyle(v).backgroundImage !== 'none', tiles };
    });
    if (s.done) break;
    seen.counts.add(s.count);
    seen.spinner ||= s.spinner;
    seen.bar ||= s.bar > 0;
    if (s.opacity !== '1' || !s.bg) seen.covered = false;
    if (s.tiles > 0 && s.tiles < 5) seen.partialVisible = true; // partial tiles may exist in the DOM but must be covered
    await page.waitForTimeout(40);
  }
  const counts = [...seen.counts].filter((c) => /^\d+ \/ \d+ tiles$/.test(c));
  assert.ok(counts.length >= 3, 'progress text advanced: ' + [...seen.counts].join(' | '));
  assert.ok(seen.spinner && seen.bar && seen.covered, JSON.stringify({ ...seen, counts: counts.length }));
  const done = await page.evaluate(() => { const v = document.querySelector('#veil'); const t = [...document.querySelectorAll('.sat.front img.leaflet-tile')]; return { fading: v.hidden || v.classList.contains('out'), allLoaded: t.every((i) => i.classList.contains('leaflet-tile-loaded')), n: t.length }; });
  assert.deepEqual([done.fading, done.allLoaded], [true, true], 'fade starts only when every tile is loaded');
  await page.screenshot({ path: OUT + 'phone-loaded.png' });
  await ctx.close();
});

await test('stalled tiles: retried once after the timeout, then a tap-to-retry state instead of hanging; tapping recovers', async () => {
  const { ctx, page } = await newPage(PHONE, { watch: false, sw: false });
  await page.addInitScript(() => { window.__AG_TILE_TIMEOUT_MS = 1200; });
  let stall = true, stalled = 0;
  await page.route('**/World_Imagery/MapServer/tile/**', (route) => { if (stall) { stalled++; return; } return route.continue(); });
  const t0 = Date.now();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag, null, { timeout: 30000 });
  if (await page.locator('#dlg-help[open]').count()) await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#veil').hidden && !document.querySelector('#veil-retry').hidden, null, { timeout: 20000 });
  const took = Date.now() - t0;
  assert.match(await page.locator('#veil-msg').innerText(), /taking too long/i);
  assert.match(await page.locator('#veil-retry').innerText(), /tap to retry/i);
  assert.ok(took > 2300 && took < 9000, `two attempts of 1.2 s each, then give up (${took} ms)`);
  assert.ok(stalled >= 12, 'tile requests were made and stalled: ' + stalled);
  await page.screenshot({ path: OUT + 'phone-tap-to-retry.png' });
  stall = false;
  await page.locator('#veil').click({ position: { x: 20, y: 20 } }); // the whole state is tappable
  await ready(page);
  assert.ok(await page.evaluate(() => window.__ag.round.answer.iata));
  await ctx.close();
});

await test('service worker caches tiles: a reload is served from the Cache API (no tile network requests), also offline', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await ready(page);
  await page.waitForFunction(() => window.__ag.views.wide.status === 'ready', null, { timeout: 30000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();                    // now controlled by the service worker; first controlled load fills the tile cache
  await ready(page);
  await page.waitForTimeout(1000);
  const cached = await page.evaluate(async () => (await (await caches.open('airport-guesser-tiles-v1')).keys()).length);
  assert.ok(cached >= 16, 'tiles in the Cache API: ' + cached);
  // reload again with the network cut for tiles: everything must come from the cache
  const live = [];
  await page.route('**/World_Imagery/MapServer/tile/**', (route) => { live.push(route.request().url()); return route.abort(); });
  await page.reload();
  await page.waitForFunction(() => window.__ag && window.__ag.round && (document.querySelector('#veil').hidden || document.querySelector('#veil').classList.contains('out')), null, { timeout: 20000 });
  const t = await page.evaluate(() => { const t = [...document.querySelectorAll('.sat.front img.leaflet-tile')]; return { n: t.length, ok: t.every((i) => i.classList.contains('leaflet-tile-loaded')) }; });
  assert.ok(t.n > 0 && t.ok, 'all tiles shown from the cache: ' + JSON.stringify(t));
  await ctx.close();
});

await test('tile maths (used by the inline preloader) equals what Leaflet requests: same zoom, same shifted centre, same tiles, on phone and desktop', async () => {
  for (const profile of [PHONE, DESKTOP]) {
    const { ctx, page } = await newPage(profile);
    await open(page);
    await start(page, 21); // loads the lists
    for (const id of [HUB, SMALL, REMOTE, by('KMG').id, by('SZX').id]) {
      const a = await page.evaluate((i) => window.__ag.byId.get(i), id);
      const pv = await page.evaluate((i) => { const g = window.__ag, p = g.viewParams(g.byId.get(i)); return { ...p, tiles: g.views.main.tilesFor(p.center, p.zMain), n: g.views.main.retinaLevels }; }, id);
      const pill = pv.W < 520 ? C.REF_PHONE.pill : C.REF_DESKTOP.pill;
      const z = C.finalZoom(a, pv.W, pv.H, pv.n, { minZoom: IMAGERY.minZoom, maxZoom: IMAGERY.maxZoom - pv.n, pill });
      const center = TM.shiftedCenter(a.view[0], a.view[1], z, C.airfieldLift(pv.W, pv.H, pill, C.CHIPS_BOTTOM));
      assert.equal(z, pv.zMain, a.name + ' zoom');
      assert.ok(Math.abs(center[0] - pv.center[0]) < 1e-7 && Math.abs(center[1] - pv.center[1]) < 1e-7, a.name + ' centre ' + center + ' vs ' + pv.center);
      assert.deepEqual(TM.tilesForView(IMAGERY, pv.n, center, z, pv.W, pv.H), pv.tiles, a.name + ' tiles');
    }
    await ctx.close();
  }
});

await test('built site only: the inline preloader fetches exactly the first view\'s tiles before the app code runs, and no tile is downloaded twice', async () => {
  const { ctx, page } = await newPage(PHONE, { sw: false });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const reqs = new Map();
  cdp.on('Network.requestWillBeSent', (e) => { if (/World_Imagery\/MapServer\/tile\//.test(e.request.url)) reqs.set(e.requestId, { url: e.request.url, type: e.type, first: e.type === 'Fetch', wire: 0 }); });
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) r.wire = e.encodedDataLength; });
  await open(page);
  await ready(page);
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => { const g = window.__ag, p = g.viewParams(g.round.answer); return { pre: window.__preloadedTiles ? window.__preloadedTiles.length : null, tiles: g.views.main.tilesFor(p.center, p.zMain) }; });
  if (info.pre === null) { console.log('       (source tree: no inline preloader, nothing to check)'); await ctx.close(); return; }
  assert.equal(info.pre, info.tiles.length, 'the preloader worked out the same tiles as the map');
  const transferred = [...reqs.values()].filter((r) => r.wire > 1000); // a request answered from the HTTP cache transfers nothing
  for (const u of info.tiles) {
    const n = transferred.filter((r) => r.url === u).length;
    assert.equal(n, 1, 'downloaded exactly once: ' + u);
    assert.ok([...reqs.values()].some((r) => r.url === u && r.type === 'Fetch'), 'first requested by the inline preloader (fetch): ' + u);
  }
  await ctx.close();
});

await test('local-midnight rollover (New York clock): the tab switches to the new date\'s airport without reloading and without fetching the airport lists', async () => {
  const ctx = await browser.newContext({ ...DESKTOP, serviceWorkers: 'block', timezoneId: 'America/New_York' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } });
  const page = await ctx.newPage();
  const attempts = [];
  await page.route('**/data/airports*.json', (route) => { attempts.push(route.request().url()); return route.abort(); });
  let navs = 0;
  page.on('framenavigated', () => navs++);
  // 60 s before the New York midnight that starts today's UTC date (04:00Z in summer, 05:00Z in winter)
  const nyDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  const utcMidnight = new Date(C.utcDateString() + 'T00:00:00Z').getTime();
  const nyMidnight = [4, 5].map((h) => utcMidnight + h * 3600000).find((ms) => nyDate(new Date(ms - 1000)) !== nyDate(new Date(ms)));
  await page.clock.install({ time: new Date(nyMidnight - 60000) });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round && document.querySelector('#veil').hidden, null, { timeout: 60000 });
  const before = await page.evaluate(() => ({ date: window.__ag.round.date, id: window.__ag.round.answer.id }));
  const attemptsBefore = attempts.length;
  await page.clock.fastForward(90000); // jump past local midnight (due timers fire once; nothing is in flight to time out)
  await page.waitForFunction((d) => window.__ag.round && window.__ag.round.date && window.__ag.round.date !== d && document.querySelector('#veil').hidden, before.date, { timeout: 60000 });
  const after = await page.evaluate(() => ({ date: window.__ag.round.date, id: window.__ag.round.answer.id }));
  assert.equal(C.addDays(before.date, 1), after.date, 'moved to the next local date');
  assert.equal(before.id, C.dailyTopOrder(topList, before.date)[0].id);
  assert.equal(after.id, C.dailyTopOrder(topList, after.date)[0].id, 'the new date\'s airport, the same as for everyone on that date');
  assert.equal(navs, 1, 'no reload (only the initial navigation)');
  assert.equal(attempts.length, attemptsBefore, 'the rollover did not trigger any airport-list request');
  await ctx.close();
});

await test('typing before the airport lists have arrived: the query waits ("Loading airports"), then results appear; the lists are not needed for the first image', async () => {
  const { ctx, page } = await newPage(PHONE, { sw: false });
  let release;
  const gate = new Promise((r) => { release = r; });
  const listRequests = [];
  await page.route('**/data/airports*.json', async (route) => { listRequests.push({ url: route.request().url(), at: Date.now() }); await gate; await route.continue(); });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round && document.querySelector('#veil').hidden, null, { timeout: 60000 }); // image is up while the lists are held back
  const input = page.locator('#guess-input');
  await input.fill('zur');
  assert.match(await page.locator('#suggestions').innerText(), /Loading airports/i);
  assert.equal(await page.locator('#suggestions li[role=option]').count(), 0);
  release();
  await page.waitForSelector('#suggestions li[role=option]', { timeout: 30000 });
  assert.ok((await page.locator('#suggestions').innerText()).includes('Zürich'), 'results appear for the queued query');
  assert.ok(listRequests.length >= 1, 'the lists were requested (on focus / after the image)');
  await ctx.close();
});

await test('first paint: header, mode switches and the guess panel are there immediately and the image area shows the loading skeleton while JavaScript is still downloading', async () => {
  const { ctx, page } = await newPage(PHONE, { sw: false, watch: false });
  await page.route(/\/(assets|js)\/.*\.js$|leaflet.*\.js$/, async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue(); });
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForSelector('.brand', { timeout: 5000 });
  await page.waitForTimeout(800); // still no app code
  assert.equal(await page.evaluate(() => !!window.__ag), false, 'the app has not started yet');
  const s = await page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    return { brand: vis('.brand'), modes: vis('#mode-seg'), input: vis('#guess-input'), guessBtn: vis('#guess-btn'), hard: vis('#hard-switch'), veil: vis('#veil'), veilText: document.querySelector('#veil-msg').textContent, spinner: getComputedStyle(document.querySelector('.spinner')).display !== 'none', bg: getComputedStyle(document.body).backgroundColor };
  });
  assert.deepEqual([s.brand, s.modes, s.input, s.guessBtn, s.hard, s.veil, s.spinner], [true, true, true, true, true, true, true], JSON.stringify(s));
  assert.equal(s.veilText, 'Loading imagery');
  await page.screenshot({ path: OUT + 'first-paint-before-js.png' });
  await ctx.close();
});

await test('start view: nothing moves it sideways (no pan, no arrow keys, no on-screen +/- buttons); it only zooms IN (see tests/zoominteract.mjs)', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await start(page, HUB);
  assert.equal(await page.locator('#map .leaflet-control-zoom, #map .leaflet-bar a').count(), 0, 'no +/- buttons');
  const snap = () => page.evaluate(() => { const m = window.__ag.map; const c = m.getCenter(); return JSON.stringify([m.getZoom(), +c.lat.toFixed(6), +c.lng.toFixed(6)]); });
  const before = await snap();
  const box = await page.locator('#map').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.touchscreen.tap(cx, cy); // a single tap does nothing
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 120, cy + 90, { steps: 6 }); await page.mouse.up(); // dragging at the start view does not pan
  await page.locator('#map').click({ position: { x: 100, y: 100 } });
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('-'); // arrow keys never pan, minus never goes wider
  await page.waitForTimeout(600);
  assert.equal(await snap(), before, 'view unchanged');
  assert.equal(await page.locator('.leaflet-control-zoom').count(), 0, 'no on-screen zoom buttons');
  assert.equal(await page.evaluate(() => !!window.__ag.map.dragging.enabled()), false, 'panning is off until the player zooms in');
  await ctx.close();
});

await test('wrong guesses do not zoom out; zoom-out costs 1 guess, needs confirmation, once per game', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await start(page, HUB);
  const a = await answerOf(page);
  const z0 = (await measure(page)).zoom;
  await guess(page, wrongPick(a, 1)[0].iata);
  await page.waitForTimeout(800);
  assert.equal((await measure(page)).zoom, z0, 'no automatic zoom-out');
  assert.match(await page.locator('#btn-zoom').innerText(), /Zoom out\s*[\u2212-]1 guess/);
  // cancel path: nothing spent
  await page.locator('#btn-zoom').click();
  const sheet = await page.locator('#sheet').innerText();
  assert.match(sheet, /Zoom out for 1 guess\?/);
  assert.match(sheet, /once per game/i);
  assert.match(sheet, /You'll have 3 left/);
  await page.locator('#sheet [data-cancel]').click();
  assert.equal(await spentOf(page), 1);
  assert.equal((await measure(page)).zoom, z0);
  // confirm
  await page.locator('#btn-zoom').click();
  await page.locator('#sheet [data-confirm]').click();
  await page.waitForTimeout(900);
  assert.equal(await spentOf(page), 2);
  assert.equal((await measure(page)).zoom, z0 - 2, 'about 2 levels wider');
  assert.match(await leftText(page), /3\s*of 5 attempts left/i);
  assert.equal(await page.locator('#btn-zoom').isDisabled(), true, 'disabled after use');
  assert.match(await page.locator('#btn-zoom').innerText(), /Zoomed out/);
  assert.match(await page.locator('#hints-used').innerText(), /Zoomed out/);
  assert.equal(await page.locator('#hint-label').innerText(), 'Wider view');
  assert.equal(await page.locator('#pips .pip.aid').count(), 1);
  assert.equal(await page.locator('#pips .pip.miss').count(), 1);
  await page.screenshot({ path: OUT + 'phone-zoomed-out.png' });
  await ctx.close();
});

await test('hints: 3 kinds (country, first letter, third clue), each costs 1 guess with confirmation, shown persistently; budget shared; game over reveals answer', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await start(page, HUB);
  const a = await answerOf(page);
  const third = C.hintInfo('extra', a);
  await page.locator('#btn-hint').click();
  const labels = await page.locator('#sheet .opt').allInnerTexts();
  assert.deepEqual(labels.map((l) => l.split('\n')[0]), ['Country', 'First letter of the name', third.menu]);
  assert.ok(labels.every((l) => /1 guess/.test(l)));
  assert.ok(!(await page.locator('#sheet').innerText()).includes(third.text()), 'the menu names the kind of clue, not its content');
  // country
  await page.locator('#sheet [data-hint=country]').click();
  assert.match(await page.locator('#sheet').innerText(), /Reveal: country\?/i);
  await page.locator('#sheet [data-cancel]').click();
  assert.equal(await spentOf(page), 0, 'cancel spends nothing');
  await page.locator('#btn-hint').click();
  await page.locator('#sheet [data-hint=country]').click();
  await page.locator('#sheet [data-confirm]').click();
  assert.equal(await spentOf(page), 1);
  const used = () => page.locator('#hints-list').innerText();
  assert.match(await used(), new RegExp(a.country));
  // first letter + third clue
  await page.locator('#btn-hint').click();
  assert.equal(await page.locator('#sheet [data-hint=country]').isDisabled(), true, 'used hint cannot be reused');
  await page.locator('#sheet [data-hint=letter]').click();
  await page.locator('#sheet [data-confirm]').click();
  await page.locator('#btn-hint').click();
  await page.locator('#sheet [data-hint=extra]').click();
  await page.locator('#sheet [data-confirm]').click();
  const text = await used();
  assert.ok(/Name starts with/i.test(text) && text.includes(C.firstChar(a.name)), 'first letter ' + text);
  assert.ok(text.toLowerCase().includes(third.label.toLowerCase()) && text.includes(third.text()), 'third clue ' + text); // labels are upper-cased by CSS
  assert.equal(await spentOf(page), 3);
  assert.equal(await page.locator('#pips .pip.aid').count(), 3);
  assert.match(await leftText(page), /2\s*of 5 attempts left/i);
  await guess(page, wrongPick(a, 1)[0].iata);
  // 4 spent: only 1 attempt left -> hints and zoom are off (spending the last attempt would end the game)
  assert.equal(await page.locator('#btn-hint').isDisabled(), true);
  assert.equal(await page.locator('#btn-zoom').isDisabled(), true);
  assert.equal(await page.locator('#hints-list li').count(), 3, 'hints stay visible');
  await page.screenshot({ path: OUT + 'phone-hints.png', fullPage: true });
  await guess(page, wrongPick(a, 2)[1].iata);
  await page.waitForSelector('#result:not([hidden])');
  const res = await page.locator('#result').innerText();
  assert.ok(/Out of attempts/i.test(res) && res.includes(a.name) && res.includes(a.icao), res);
  assert.equal(await page.locator('#play').isHidden(), true);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('airportGuesser.stats.v1')));
  assert.equal(st.practice.dist[5], 1, 'loss recorded');
  assert.equal(await page.locator('#pips .pip.aid').count(), 3);
  assert.equal(await page.locator('#hints-list li').count(), 3, 'hints still shown after game over');
  await ctx.close();
});

await test('win after a hint: attempts used counts hints; share has bulb + telescope lines and no leaks', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await start(page, HUB);
  const a = await answerOf(page);
  await guess(page, wrongPick(a, 1)[0].iata);
  await page.locator('#btn-hint').click();
  await page.locator('#sheet [data-hint=country]').click();
  await page.locator('#sheet [data-confirm]').click();
  await page.locator('#btn-zoom').click();
  await page.locator('#sheet [data-confirm]').click();
  await guess(page, a.iata);
  await page.waitForSelector('#result:not([hidden])');
  assert.match(await page.locator('#result').innerText(), /Solved in 4 of 5/i);
  await page.locator('#btn-share').click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split(/\r?\n/); // the Windows clipboard turns \n into \r\n
  assert.equal(lines[1], '4/5');
  assert.deepEqual(lines.slice(3, 7).map((l) => l.codePointAt(0)), [lines[3].codePointAt(0), 0x1f4a1, 0x1f52d, 0x1f7e9]);
  for (const bad of [a.name, a.iata, a.icao, a.city, a.country]) assert.ok(!text.toLowerCase().includes(String(bad).toLowerCase()), 'leak: ' + bad);
  await ctx.close();
});

await test('mobile layout: image on top, panel below; light theme; system font; footer credit; Esri attribution visible', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await ready(page);
  const m = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const st = r('#stage'), pn = r('#panel'), at = r('.leaflet-control-attribution');
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return {
      stackedOk: st.bottom <= pn.top + 1 && Math.abs(st.left - pn.left) < 2,
      stageH: st.height, vw: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth,
      bg, font: getComputedStyle(document.body).fontFamily, foot: document.querySelector('.foot span').innerText,
      attrib: document.querySelector('.leaflet-control-attribution').innerText,
      attribVisible: at.width > 40 && at.height > 5 && at.bottom <= st.bottom + 1 && at.right <= st.right + 1,
      inputFs: parseFloat(getComputedStyle(document.querySelector('#guess-input')).fontSize),
      targets: ['#guess-input', '#guess-btn', '#mode-seg button', '#btn-stats', '#btn-hint', '#btn-zoom', '#hard-switch'].map((s) => r(s).height),
      radius: parseFloat(getComputedStyle(document.querySelector('#panel')).borderRadius),
    };
  });
  assert.ok(m.stackedOk, 'image above panel');
  assert.ok(m.bg.every((v) => v >= 235), 'light background ' + m.bg);
  assert.match(m.font, /-apple-system/);
  assert.equal(m.foot, 'Created by Kevin Pahud');
  assert.match(m.attrib, /Esri/);
  assert.ok(m.attribVisible, 'attribution visible inside the image');
  assert.ok(m.inputFs >= 16 && m.targets.every((h) => h >= 40) && !m.overflowX && m.radius >= 16, JSON.stringify(m));
  await page.screenshot({ path: OUT + 'phone-layout.png', fullPage: true });
  await ctx.close();
});

await test('keyboard open (short viewport): image, input and suggestions all stay visible', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await start(page, HUB);
  await page.locator('#guess-input').click();
  await page.setViewportSize({ width: 390, height: 520 }); // what an open on-screen keyboard does to the viewport
  await page.locator('#guess-input').fill('a');
  await page.waitForSelector('#suggestions li[role=option]');
  await page.waitForTimeout(700);
  const boxes = await page.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
    return { map: r('#map'), input: r('#guess-input'), list: r('#suggestions'), vh: window.innerHeight };
  });
  assert.ok(boxes.map.height >= 100 && boxes.map.top >= -1 && boxes.map.bottom <= boxes.vh, 'map visible ' + JSON.stringify(boxes));
  assert.ok(boxes.input.bottom <= boxes.vh && boxes.list.bottom <= boxes.vh + 2, JSON.stringify(boxes));
  const m = await measure(page);
  assert.ok(m.fill <= 0.785 && m.fill > 0.2, 'view re-fitted to the smaller frame: ' + m.fill);
  await page.screenshot({ path: OUT + 'phone-keyboard.png' });
  await ctx.close();
});

// ---------------------------------------------------------------- desktop
console.log('desktop 1280x800');

await test('wide layout: image left, guess panel right, same height; light Apple-style cards', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await open(page);
  await ready(page);
  const a = await answerOf(page);
  await guess(page, wrongPick(a, 1)[0].iata);
  const m = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const st = r('#stage'), pn = r('#panel');
    return { leftOf: st.right <= pn.left, sameTop: Math.abs(st.top - pn.top) < 1, sameH: Math.abs(st.height - pn.height) < 1, stW: st.width, pnW: pn.width,
      shadow: getComputedStyle(document.querySelector('#panel')).boxShadow, radius: parseFloat(getComputedStyle(document.querySelector('#stage')).borderRadius),
      inPanel: ['#guess-input', '#btn-hint', '#btn-zoom', '#guesses .row'].every((s) => { const b = r(s); return b.left >= pn.left && b.right <= pn.right; }) };
  });
  assert.ok(m.leftOf && m.sameTop && m.sameH && m.inPanel, JSON.stringify(m));
  assert.ok(m.radius >= 16 && m.shadow !== 'none');
  await page.screenshot({ path: OUT + 'desktop-layout.png' });
  await ctx.close();
});

await test('daily (default): one of the busiest airports, seeded cycle order, refresh keeps guesses+hints+zoom, one attempt, countdown', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await open(page);
  await ready(page);
  const today = C.localDateString();
  const order = C.dailyTopOrder(topList, today);
  const a = await answerOf(page);
  const idx = order.findIndex((x) => x.id === a.id);
  assert.ok(idx >= 0 && idx < 10, 'daily answer from the seeded order (index ' + idx + ')');
  assert.ok(a.top >= 1 && a.top <= topList.length, 'Daily airport is in the top list: rank ' + a.top);
  const w = wrongPick(a, 2);
  await guess(page, w[0].iata, { viaKeyboard: true });
  await page.locator('#btn-hint').click();
  await page.locator('#sheet [data-hint=country]').click();
  await page.locator('#sheet [data-confirm]').click();
  await page.locator('#btn-zoom').click();
  await page.locator('#sheet [data-confirm]').click();
  await page.reload();
  await ready(page);
  assert.equal((await answerOf(page)).id, a.id);
  assert.equal(await rowCount(page), 1);
  assert.equal(await spentOf(page), 3, 'guess + hint + zoom restored');
  assert.match(await page.locator('#hints-list').innerText(), new RegExp(a.country));
  assert.equal(await page.locator('#btn-zoom').isDisabled(), true);
  assert.equal(await page.locator('#hint-label').innerText(), 'Wider view');
  await guess(page, a.iata, { viaKeyboard: true });
  await page.waitForSelector('#result:not([hidden])');
  assert.match(await page.locator('#result').innerText(), /Solved in 4 of 5/i);
  assert.match(await page.locator('#countdown').innerText(), /^\d\d:\d\d:\d\d$/);
  await page.reload();
  await page.waitForFunction(() => window.__ag && window.__ag.round);
  assert.equal(await page.locator('#result').isVisible(), true);
  assert.equal(await page.locator('#play').isHidden(), true, 'no second attempt');
  const s1 = await page.locator('#countdown').innerText();
  await page.waitForTimeout(2100);
  assert.notEqual(await page.locator('#countdown').innerText(), s1, 'countdown ticks');
  await page.locator('#btn-stats').click();
  const stats = await page.locator('#dlg-stats').innerText();
  assert.match(stats.replace(/\n/g, ' '), /Played/);
  await page.screenshot({ path: OUT + 'desktop-stats.png' });
  await page.keyboard.press('Escape');
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('airportGuesser.stats.v1')));
  assert.deepEqual([st.daily.played, st.streaks.daily.current, st.hard.played], [1, 1, 0]);
  await ctx.close();
});

await test('the Daily airport and its zoom are identical on a phone and on desktop (one zoom per airport for everyone)', async () => {
  const got = [];
  for (const profile of [PHONE, DESKTOP, { viewport: { width: 768, height: 1024 } }]) {
    const { ctx, page } = await newPage(profile);
    await open(page);
    await ready(page);
    got.push(await page.evaluate(() => ({ id: window.__ag.round.answer.id, zoom: window.__ag.map.getZoom(), z: window.__ag.round.answer.z })));
    await ctx.close();
  }
  assert.equal(new Set(got.map((g) => g.id)).size, 1, 'same airport: ' + JSON.stringify(got));
  assert.equal(new Set(got.map((g) => g.zoom)).size, 1, 'same zoom: ' + JSON.stringify(got));
  assert.equal(got[0].zoom, got[0].z);
});

await test('Hard mode: separate toggle, own daily from every airport outside the top list, full-database search, own state/streak/results', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await open(page);
  await ready(page);
  const dailyAnswer = await answerOf(page);
  // finish nothing in Daily; switch to Hard
  await page.locator('#hard-switch').click();
  await page.waitForFunction(() => window.__ag.hard && window.__ag.hardLoaded && window.__ag.round && window.__ag.round.kind === 'hard', null, { timeout: 60000 });
  await ready(page);
  const a = await answerOf(page);
  assert.ok(!a.top, 'hard answer is not in the Daily top list: ' + a.name);
  assert.ok(hardPool.some((x) => x.id === a.id));
  const order = C.dailyOrder(hardPool, C.localDateString(), 'hard:');
  assert.ok(order.slice(0, 10).some((x) => x.id === a.id), 'seeded hard order');
  assert.notEqual(a.id, dailyAnswer.id);
  assert.equal(await page.locator('#hard-toggle').isChecked(), true);
  await page.screenshot({ path: OUT + 'desktop-hard.png' });
  // autocomplete searches the full DB: another hard-only airport and an international one are both findable
  const other = hardList.find((x) => x.id !== a.id && x.iata === '' && x.name.length < 40 && !/[^\x20-\x7e]/.test(x.name));
  const input = page.locator('#guess-input');
  await input.fill(other.name);
  await page.waitForSelector('#suggestions li[role=option]');
  assert.ok((await page.locator('#suggestions').innerText()).includes(other.name), 'finds hard-only airport');
  await input.fill('zurich');
  await page.waitForTimeout(150);
  assert.ok((await page.locator('#suggestions').innerText()).includes('Zürich'), 'also finds international airports');
  // play: wrong guess by name, refresh persists in Hard mode (separate saved state), then solve
  await input.fill('');
  await guess(page, other.name, { expect: other.name });
  await page.reload();
  await ready(page);
  assert.equal(await page.evaluate(() => window.__ag.hard), true, 'hard preference remembered');
  assert.equal((await answerOf(page)).id, a.id);
  assert.equal(await rowCount(page), 1);
  await guess(page, a.name, { expect: a.name });
  await page.waitForSelector('#result:not([hidden])');
  assert.match(await page.locator('#result').innerText(), /Solved in 2 of 5/i);
  let st = await page.evaluate(() => JSON.parse(localStorage.getItem('airportGuesser.stats.v1')));
  assert.deepEqual([st.hard.played, st.hard.wins, st.streaks.hard.current, st.daily.played], [1, 1, 1, 0], 'Hard results separate from Daily');
  // share title names the mode
  await page.locator('#btn-share').click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(text.startsWith('Airport Guesser \u2014 Hard Daily ' + C.localDateString()), text);
  // back to Daily: its own untouched game
  await page.locator('#hard-switch').click();
  await page.waitForFunction(() => !window.__ag.hard && window.__ag.round && window.__ag.round.kind === 'daily', null, { timeout: 60000 });
  await ready(page);
  assert.equal((await answerOf(page)).id, dailyAnswer.id);
  assert.equal(await rowCount(page), 0);
  assert.equal(await page.locator('#play').isVisible(), true);
  // stats dialog has a Hard tab
  await page.locator('#btn-stats').click();
  await page.locator('#stats-seg [data-stats=hard]').click();
  assert.match((await page.locator('#stats-body').innerText()).replace(/\n/g, ' '), /1\s*Played|Played/);
  await ctx.close();
});

await test('autocomplete in Daily (and every mode) searches the full database: hard-file airports appear once loaded in the background', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await open(page);
  await ready(page);
  assert.equal(await page.evaluate(() => window.__ag.kind ?? window.__ag.round.kind), 'daily');
  await page.waitForFunction(() => window.__ag.hardLoaded, null, { timeout: 60000 });
  const other = hardList.find((x) => x.iata === '' && x.name.length < 40 && !/[^\x20-\x7e]/.test(x.name));
  await page.locator('#guess-input').fill(other.name);
  await page.waitForSelector('#suggestions li[role=option]');
  assert.ok((await page.locator('#suggestions').innerText()).includes(other.name), 'Daily autocomplete finds ' + other.name);
  // a non-top international airport too, and a guess on it counts as a normal wrong guess
  const plain = airports.find((x) => !x.top && x.type === 'medium' && /^[A-Za-z .'-]+$/.test(x.name));
  await page.locator('#guess-input').fill(plain.iata);
  await page.waitForSelector('#suggestions li[role=option]');
  await page.locator('#suggestions li[role=option]').first().click();
  await page.locator('#guess-btn').click();
  await page.waitForFunction(() => document.querySelectorAll('#guesses .row').length === 1);
  await page.reload();
  await ready(page);
  assert.equal(await rowCount(page), 1, 'a guess on an airport from the other file survives a reload');
  await ctx.close();
});

await test('autocomplete: accent-insensitive, ranking, max 6, keyboard nav, Escape, free text cannot be guessed', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await open(page);
  await ready(page);
  const input = page.locator('#guess-input');
  await input.fill('zurich');
  await page.waitForSelector('#suggestions li[role=option]');
  assert.equal(await page.locator('#suggestions li[role=option]').first().locator('.s-name').innerText(), 'Zürich Airport');
  await input.fill('international');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#suggestions li[role=option]').count(), 6);
  await input.press('ArrowDown'); await input.press('ArrowDown');
  assert.equal(await page.locator('#suggestions li').nth(2).getAttribute('aria-selected'), 'true');
  await input.press('Escape');
  assert.equal(await page.locator('#suggestions').isHidden(), true);
  await input.fill('Zurich Airport');
  assert.equal(await page.locator('#guess-btn').isDisabled(), true);
  await input.fill('zzzzqq');
  assert.match(await page.locator('#suggestions').innerText(), /No matching airport/);
  await ctx.close();
});

await test('practice mode still works; Hard toggle hides the practice set picker', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await open(page);
  await ready(page);
  await page.locator('#mode-seg [data-mode=practice]').click();
  await page.waitForFunction(() => window.__ag.round && window.__ag.round.kind === 'practice', null, { timeout: 60000 });
  await ready(page);
  assert.equal(await page.locator('#diff-seg').isVisible(), true);
  await page.locator('#diff-seg [data-diff=easy]').click();
  await page.waitForFunction(() => window.__ag.round && window.__ag.round.answer.tier === 1, null, { timeout: 60000 });
  await ready(page);
  const a = await answerOf(page);
  await guess(page, a.iata);
  await page.waitForSelector('#result:not([hidden])');
  assert.ok(await page.locator('#btn-next').isVisible());
  await page.locator('#hard-switch').click();
  await page.waitForFunction(() => window.__ag.round && !window.__ag.round.answer.top && window.__ag.hard, null, { timeout: 60000 });
  assert.equal(await page.locator('#diff-seg').isHidden(), true);
  await ctx.close();
});

await test('no text or markers in the satellite view (hub, small, remote); attribution only', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await open(page);
  for (const id of [HUB, SMALL, REMOTE]) {
    await start(page, id);
    const r = await page.evaluate(() => {
      const m = document.querySelector('#map');
      return {
        stray: [...m.querySelectorAll('*')].filter((n) => !n.closest('.leaflet-control-attribution') && n.children.length === 0 && n.textContent.trim()).map((n) => n.textContent.trim()),
        markers: m.querySelectorAll('.leaflet-marker-icon, .leaflet-tooltip, .leaflet-popup, svg path.leaflet-interactive').length,
        tilesFromProvider: [...m.querySelectorAll('img.leaflet-tile')].every((i) => /arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/.test(i.src)),
      };
    });
    assert.deepEqual(r.stray, []);
    assert.equal(r.markers, 0);
    assert.ok(r.tilesFromProvider);
    await page.locator('#stage').screenshot({ path: OUT + `desktop-view-${id}.png` });
  }
  await ctx.close();
});

// ---------------------------------------------------------------- imagery failure + PWA
console.log('imagery failure and PWA');

await test('daily deterministic fallback when imagery for the first candidate is unreachable', async () => {
  const { ctx, page } = await newPage(DESKTOP, { watch: false, sw: false });
  const order = C.dailyTopOrder(topList, C.localDateString());
  // Block the centre tile of the first candidate at every level it might use
  await page.route('**/World_Imagery/MapServer/tile/**', (route) => {
    const m = route.request().url().match(/tile\/(\d+)\/(\d+)\/(\d+)/);
    const c = C.tileCoords(order[0].view[0], order[0].view[1], +m[1]);
    return c.x === +m[3] && c.y === +m[2] ? route.abort() : route.continue();
  });
  await open(page);
  await ready(page);
  assert.equal((await answerOf(page)).id, order[1].id, 'falls through to the second candidate of the seeded order');
  await ctx.close();
});

await test('all imagery blocked: clear message + retry; retry recovers', async () => {
  const { ctx, page } = await newPage(DESKTOP, { watch: false, sw: false });
  let block = true;
  await page.route('**/World_Imagery/MapServer/tile/**', (route) => (block ? route.abort() : route.continue()));
  await open(page);
  await page.waitForFunction(() => !document.querySelector('#veil').hidden && !document.querySelector('#veil-retry').hidden, null, { timeout: 120000 });
  assert.match(await page.locator('#veil-msg').innerText(), /imagery is unavailable/i);
  block = false;
  await page.locator('#veil-retry').click();
  await ready(page);
  assert.ok(await page.evaluate(() => window.__ag.round.answer.iata));
  await ctx.close();
});

await test('PWA: manifest valid, icons load, service worker registers, shell+both datasets cached, works offline', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await open(page);
  await ready(page);
  const mf = await (await page.request.get(BASE + 'manifest.webmanifest')).json();
  assert.ok(mf.name && mf.start_url && mf.display === 'standalone');
  assert.ok(mf.icons.some((i) => i.sizes === '192x192') && mf.icons.some((i) => i.sizes === '512x512') && mf.icons.some((i) => i.purpose === 'maskable'));
  for (const i of mf.icons) assert.equal((await page.request.get(BASE + i.src)).status(), 200, i.src);
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, active: !!r.active }; });
  assert.ok(sw.active && sw.scope === BASE);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys[0]);
    return (await c.keys()).map((r) => new URL(r.url).pathname);
  });
  for (const p of ['/index.html', '/data/daily.json']) assert.ok(cached.includes(p), 'precached ' + p);
  assert.ok(cached.some((p) => /\/js\/app\.js$|\/assets\/app-/.test(p)) && cached.some((p) => /leaflet/.test(p)), 'app bundle and Leaflet precached: ' + cached.join(' '));
  const swSource = await (await page.request.get(BASE + 'sw.js')).text();
  const shellList = swSource.match(/\/\*SHELL\*\/([\s\S]*?)\/\*END\*\//)[1];
  assert.ok(!/airports/.test(shellList), 'the big airport lists are NOT in the install-time precache (they would compete with the first image)');
  // the big lists are cached the first time they are fetched (in the background after the first image)
  await page.waitForFunction(() => window.__ag.hardLoaded, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const later = await page.evaluate(async () => { const keys = await caches.keys(); const c = await caches.open(keys.filter((k) => /^airport-guesser-v\d/.test(k)).sort().pop()); return (await c.keys()).map((r) => new URL(r.url).pathname); });
  for (const p of ['/data/airports.json', '/data/airports-hard.json']) assert.ok(later.includes(p), 'runtime-cached ' + p);
  const a = await answerOf(page);
  await guess(page, wrongPick(a, 1)[0].iata);
  await page.reload();
  await ready(page);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 30000 });
  assert.equal(await rowCount(page), 1, 'offline reload restores the saved daily');
  await page.waitForFunction(() => document.querySelector('#veil').hidden || !document.querySelector('#veil-retry').hidden, null, { timeout: 30000 });
  await page.locator('#guess-input').fill('zrh');
  assert.ok(await page.locator('#suggestions li[role=option]').count() > 0, 'autocomplete works offline');
  await ctx.setOffline(false);
  await ctx.close();
});

await test('no console errors or page errors in the main flows', async () => {
  assert.deepEqual(errors, []);
});

writeFileSync(QA + 'report.json', JSON.stringify(qaReport, null, 2));
await browser.close();
server.close();
console.log(`\n${passed} e2e checks passed${process.exitCode ? ', some FAILED' : ''}. Screenshots: test-output/`);
