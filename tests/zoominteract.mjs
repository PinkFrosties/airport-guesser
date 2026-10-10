// Interactive zoom (v1.3.4): zoom IN from the start view with pinch / wheel / double tap / keys, pan while zoomed, never wider than the
// start view, never beyond real imagery, exact reset, no page-scroll trapping, typing never changes the view.
// Run: node tests/zoominteract.mjs   (AG_ROOT=dist for the built site; pinch / touch drag need Chromium)
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { devices } from 'playwright';
import * as C from '../js/core.js';
import { launchBrowser, browserName } from './browser.mjs';
import { createServer } from '../scripts/serve.mjs';
const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const rd = (f) => JSON.parse(readFileSync(path('../data/' + f), 'utf8')).airports;
const all = [...rd('airports.json'), ...rd('airports-hard.json')];
mkdirSync(path('../qa/'), { recursive: true });
const server = createServer(); await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser; for (const o of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await launchBrowser(o); break; } catch { /* next */ } }
const chromium = browserName === 'chromium';
let passed = 0, failed = 0;
const test = async (name, fn, needsChromium = false) => {
  if (needsChromium && !chromium) { console.log(`  skip ${name} (needs Chromium touch tooling)`); return; }
  try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split('\n').slice(0, 6).join('\n       ')}`); }
};

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 520 }, deviceScaleFactor: 1 };
async function open(profile, extra = {}) {
  const ctx = await browser.newContext({ ...profile, serviceWorkers: 'block', ...extra });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } });
  const page = await ctx.newPage(); const tiles = [];
  page.on('request', (r) => { const m = r.url().match(/World_Imagery\/MapServer\/tile\/(\d+)\//); if (m) tiles.push(+m[1]); });
  await page.goto(BASE); await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 });
  return { ctx, page, tiles };
}
const start = async (page, id) => {
  await page.evaluate((i) => window.__ag.debugStart(i), id);
  await page.waitForFunction(() => { const v = document.querySelector('#veil'); return (v.hidden || v.classList.contains('out')) && window.__ag.views.main.interactive !== undefined; }, null, { timeout: 40000 });
  await page.waitForFunction(() => window.__ag.views.main.interactive || window.__ag.round.answer.nz - window.__ag.views.main.retinaLevels <= window.__ag.views.main.map.getZoom(), null, { timeout: 15000 });
  await page.waitForTimeout(500);
};
const state = (page) => page.evaluate(() => {
  const v = window.__ag.round.zoomed && !window.__ag.round.done ? window.__ag.views.wide : window.__ag.views.main; const m = v.map; const c = m.getCenter(); const b = m.getBounds();
  return { zoom: m.getZoom(), level: v.level, maxLevel: v.maxLevel, lat: c.lat, lng: c.lng, interactive: v.interactive, minZoom: m.getMinZoom(), maxZoom: m.getMaxZoom(), n: v.retinaLevels, sw: [b.getSouth(), b.getWest()], ne: [b.getNorth(), b.getEast()],
    chip: !document.querySelector('#reset-view').hidden, live: document.querySelector('#zoom-live').textContent, scrollY: Math.round(scrollY), nz: window.__ag.round.answer.nz, z: window.__ag.round.answer.z, ta: getComputedStyle(v.container).touchAction };
});
const px = (page, lat, lng, zoom) => page.evaluate(([la, lo, z]) => { const p = window.__ag.views.main.map.project(L.latLng(la, lo), z); return [p.x, p.y]; }, [lat, lng, zoom]);
const rect = (page) => page.locator('#map').boundingBox();
const settle = async (page) => { await page.waitForFunction(() => { const v = window.__ag.round.zoomed && !window.__ag.round.done ? window.__ag.views.wide : window.__ag.views.main; const ts = [...v.container.querySelectorAll('img.leaflet-tile')]; const want = String(v.map.getZoom() + v.retinaLevels); return !v.map._animatingZoom && ts.length > 0 && ts.every((i) => i.classList.contains('leaflet-tile-loaded') && (i.src.match(/tile[/]([0-9]+)[/]/) || [])[1] === want); }, null, { timeout: 20000 }); await page.waitForTimeout(250); };
/** Two-finger pinch with real touch events (CDP). from/to = finger distance in px. */
async function pinch(page, cx, cy, from, to, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const pts = (d) => [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + ((to - from) * i) / steps) }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
}
async function swipe(page, x0, y0, x1, y1, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
  for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, id: 1 }] }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
}
const sample = {
  hub: all.find((a) => a.iata === 'JFK'),
  small: all.find((a) => a.type === 'small' && a.z >= 14 && a.nz - 1 - a.z >= 3 && a.name.length < 28),
  remote: all.find((a) => a.type === 'small' && a.nz - 1 - a.z >= 1 && ['PG', 'ID', 'CD', 'AQ'].includes(a.countryCode) && a.name.length < 28) || all.find((a) => a.type === 'small' && a.nz - 1 - a.z >= 1),
  capped: all.find((a) => a.nz - 1 - a.z === 1 && a.type !== 'large') || all.find((a) => a.nz - 1 - a.z === 2),
};
console.log('       airports:', Object.entries(sample).map(([k, a]) => `${k}=${a.iata || a.icao} (z${a.z}, native ${a.nz})`).join(', '));

for (const [kind, a] of Object.entries(sample)) {
  await test(`phone DPR3, ${kind} (${a.iata || a.icao}): pinch out zooms in up to the limit, never wider than the start view, never past native imagery; sharp tiles only; exact reset`, async () => {
    const { ctx, page, tiles } = await open(PHONE); await start(page, a.id);
    const s0 = await state(page); const limit = Math.min(s0.z + 3, a.nz - s0.n);
    assert.equal(s0.level, 0); assert.equal(s0.chip, false, 'no Reset chip at the start view'); assert.match(s0.ta, /pan-y/, 'a one-finger swipe scrolls the page at the start view');
    assert.equal(s0.interactive, limit > s0.z, 'interactive exactly when real imagery goes deeper'); assert.equal(s0.minZoom === s0.z || !s0.interactive, true);
    const box = await rect(page); const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const base = await px(page, s0.lat, s0.lng, s0.z);
    const before = tiles.length;
    await pinch(page, cx, cy, 60, 360); await page.waitForTimeout(900); await settle(page);
    const s1 = await state(page);
    if (limit > s0.z) {
      assert.ok(s1.zoom > s0.z && s1.zoom <= limit, `zoomed in: ${s0.z} -> ${s1.zoom} (limit ${limit})`); assert.equal(s1.chip, true); assert.match(s1.ta, /none/, 'one finger pans while zoomed');
      assert.match(s1.live, /Zoomed in/); assert.equal(s1.maxZoom, limit);
      await pinch(page, cx, cy, 360, 40); await page.waitForTimeout(600); await settle(page);
      const s2 = await state(page); assert.ok(s2.zoom >= s0.z, `pinching in never goes wider than the start view (${s2.zoom} >= ${s0.z})`);
      await pinch(page, cx, cy, 60, 380, 12); await pinch(page, cx, cy, 60, 380, 12); await page.waitForTimeout(900); await settle(page);
      const s3 = await state(page); assert.ok(s3.zoom <= limit, `never past the native cap (${s3.zoom} <= ${limit})`);
      const levels = new Set(tiles.slice(before)); assert.ok(Math.max(...levels) <= a.nz, `requested levels ${[...levels]} stay within native ${a.nz}`);
      assert.ok(tiles.slice(before).length < 120, `a modest number of extra tiles (${tiles.slice(before).length})`);
      // sharp: after settling only current-level tiles remain, drawn at 1:1
      const sharp = await page.evaluate(() => { const v = window.__ag.views.main; const imgs = [...v.container.querySelectorAll('img.leaflet-tile')]; const zs = new Set(imgs.map((i) => (i.src.match(/tile\/(\d+)\//) || [])[1])); const css = new Set(imgs.map((i) => Math.round(i.getBoundingClientRect().width * 100) / 100)); return { zs: [...zs], css: [...css], loaded: imgs.every((i) => i.classList.contains('leaflet-tile-loaded')) }; });
      assert.equal(sharp.zs.length, 1, 'no stand-in tiles of another level once settled: ' + sharp.zs); assert.equal(sharp.loaded, true);
      assert.ok(sharp.css.every((w) => Math.abs(w - 256 / 2 ** s0.n) < 0.6), `tiles drawn at 256/2^n CSS px: ${sharp.css} (n=${s0.n})`);
      if (kind === 'hub') await page.screenshot({ path: path('../qa/zoom-max-phone.png') });
      // pan clamp: drag far to the right and down: the view never leaves the start frame
      await swipe(page, cx - 100, cy - 100, cx + 160, cy + 160, 10); await page.waitForTimeout(500);
      const s4 = await state(page); const tol = 1e-5;
      assert.ok(s4.sw[0] >= s1.sw[0] - 1 && true); // sanity
      const b0 = await page.evaluate(() => 0);
      // the start frame, from the first state: bounds at level 0 are the whole viewport
      assert.ok(s4.ne[0] <= s0.ne[0] + tol && s4.sw[0] >= s0.sw[0] - tol && s4.ne[1] <= s0.ne[1] + tol && s4.sw[1] >= s0.sw[1] - tol, 'panned view stays inside the start frame');
    }
    // reset exactly (chip), centre within 1 px
    if (limit > s0.z) { await page.locator('#reset-view').click(); await page.waitForTimeout(1300); }
    const s5 = await state(page); const after = await px(page, s5.lat, s5.lng, s0.z);
    assert.equal(s5.zoom, s0.z); assert.ok(Math.hypot(after[0] - base[0], after[1] - base[1]) <= 1, `centre within 1 px of the start (${Math.hypot(after[0] - base[0], after[1] - base[1]).toFixed(2)})`);
    assert.equal(s5.chip, false);
    await ctx.close();
  }, true);
}

await test('phone: screenshots at the start view, at maximum zoom and after the reset (qa/zoom-*.png)', async () => {
  const { ctx, page } = await open(PHONE); await start(page, sample.hub.id);
  const box = await rect(page); const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.screenshot({ path: path('../qa/zoom-base-phone.png') });
  await pinch(page, cx, cy, 60, 380, 12); await pinch(page, cx, cy, 60, 380, 12); await pinch(page, cx, cy, 60, 380, 12); await page.waitForTimeout(900); await settle(page);
  assert.equal((await state(page)).chip, true); await page.screenshot({ path: path('../qa/zoom-max-phone.png') });
  await page.locator('#reset-view').click(); await page.waitForTimeout(1300); await settle(page); await page.screenshot({ path: path('../qa/zoom-reset-phone.png') });
  await ctx.close();
}, true);

await test('phone: double tap zooms in one step, a double tap while zoomed resets; the image does not trap the page scroll at the start view', async () => {
  const { ctx, page } = await open(PHONE); await start(page, sample.hub.id);
  const box = await rect(page); const cx = box.x + box.width / 2, cy = box.y + box.height / 2; const s0 = await state(page);
  await page.touchscreen.tap(cx + 40, cy + 20); await page.waitForTimeout(80); await page.touchscreen.tap(cx + 40, cy + 20); await page.waitForTimeout(900);
  const s1 = await state(page); assert.equal(s1.level, 1, 'one step in'); assert.equal(s1.chip, true);
  await page.touchscreen.tap(cx, cy); await page.waitForTimeout(80); await page.touchscreen.tap(cx, cy); await page.waitForTimeout(1300);
  const s2 = await state(page); assert.equal(s2.level, 0, 'a second double tap resets'); assert.equal(s2.chip, false);
  // vertical swipe starting on the image at the start view scrolls the page
  await page.setViewportSize({ width: 390, height: 500 }); await page.waitForTimeout(600);
  const b2 = await rect(page); const y0 = await page.evaluate(() => scrollY); await swipe(page, b2.x + b2.width / 2, b2.y + b2.height - 20, b2.x + b2.width / 2, b2.y - 100 > 0 ? b2.y - 100 : 10, 10); await page.waitForTimeout(500);
  assert.ok((await page.evaluate(() => scrollY)) > y0, 'the page scrolled');
  await ctx.close();
}, true);

await test('desktop: wheel over the image zooms in and does not scroll the page; wheel out stops at the start view; dragging pans only while zoomed', async () => {
  const { ctx, page } = await open(DESKTOP); await start(page, sample.hub.id);
  await page.evaluate(() => { window.__wheelPrevented = []; window.addEventListener('wheel', (e) => window.__wheelPrevented.push(e.defaultPrevented), { passive: true }); });
  const box = await rect(page); const cx = box.x + box.width / 2, cy = box.y + box.height / 2; const s0 = await state(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), 'the page is scrollable in this window');
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 120); await page.waitForTimeout(400); assert.equal((await state(page)).level, 0, 'wheel out at the start view does nothing');
  await page.mouse.wheel(0, -120); await page.waitForTimeout(900); await settle(page);
  const s1 = await state(page); assert.equal(s1.level, 1); assert.equal(s1.scrollY, 0, 'the page did not scroll');
  assert.ok((await page.evaluate(() => window.__wheelPrevented)).every(Boolean), 'wheel events over the image are consumed');
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(350); }
  await settle(page); const s2 = await state(page); assert.ok(s2.zoom <= Math.min(s0.z + 3, s0.nz - s0.n), 'capped'); assert.ok(s2.level >= 1);
  // drag pans while zoomed, clamped to the start frame
  const c0 = await px(page, s2.lat, s2.lng, s2.zoom);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 120, cy + 60, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(500);
  const c1 = await px(page, (await state(page)).lat, (await state(page)).lng, s2.zoom); assert.ok(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) > 20, 'the view panned');
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 2000, cy + 1500, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(500);
  const s3 = await state(page); assert.ok(s3.ne[0] <= s0.ne[0] + 1e-5 && s3.sw[0] >= s0.sw[0] - 1e-5 && s3.ne[1] <= s0.ne[1] + 1e-5 && s3.sw[1] >= s0.sw[1] - 1e-5, 'never outside the start frame');
  await page.screenshot({ path: path('../qa/zoom-max-desktop.png') });
  // double click resets; at the start view no pan
  await page.mouse.dblclick(cx, cy); await page.waitForTimeout(1300); const s4 = await state(page); assert.equal(s4.level, 0);
  const c2 = await px(page, s4.lat, s4.lng, s0.z), c3 = await px(page, s0.lat, s0.lng, s0.z); assert.ok(Math.hypot(c2[0] - c3[0], c2[1] - c3[1]) <= 1, 'centre exact');
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 80, cy + 80, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(300);
  const c4 = await px(page, (await state(page)).lat, (await state(page)).lng, s0.z); assert.ok(Math.hypot(c4[0] - c3[0], c4[1] - c3[1]) <= 1, 'no pan at the start view');
  await page.screenshot({ path: path('../qa/zoom-reset-desktop.png') });
  await ctx.close();
});

await test('keyboard: + and - zoom, 0 and Esc reset, typing a guess is not affected, the live region announces it', async () => {
  const { ctx, page } = await open(DESKTOP); await start(page, sample.hub.id);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('+'); await page.waitForTimeout(700); let s = await state(page); assert.equal(s.level, 1); assert.match(s.live, /Zoomed in\. Press 0 to reset/);
  await page.keyboard.press('='); await page.waitForTimeout(500); assert.ok((await state(page)).level >= 2 || (await state(page)).level === (await state(page)).maxLevel);
  await page.keyboard.press('-'); await page.waitForTimeout(600); s = await state(page); assert.ok(s.level >= 1);
  await page.keyboard.press('0'); await page.waitForTimeout(1300); s = await state(page); assert.equal(s.level, 0); assert.match(s.live, /View reset/);
  await page.keyboard.press('-'); await page.waitForTimeout(300); assert.equal((await state(page)).level, 0, '- never goes wider than the start view');
  await page.keyboard.press('+'); await page.waitForTimeout(700); await page.keyboard.press('Escape'); await page.waitForTimeout(1300); assert.equal((await state(page)).level, 0, 'Esc resets');
  await page.keyboard.press('+'); await page.waitForTimeout(700);
  await page.locator('#guess-input').focus(); await page.keyboard.type('+-0 zurich', { delay: 20 });
  assert.equal(await page.locator('#guess-input').inputValue(), '+-0 zurich', 'the keys are text while typing'); assert.equal((await state(page)).level, 1, 'typing did not zoom');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400); assert.equal((await state(page)).level, 1, 'Esc inside the input only closes the suggestions');
  await ctx.close();
});

await test('typing while zoomed in (Android keyboard emulation): zoom, centre and zoom level do not change; the compact frame keeps the same view', async () => {
  const PIXEL = devices['Pixel 7'];
  const { ctx, page } = await open({ ...PIXEL }); await start(page, sample.hub.id);
  await page.evaluate(() => { const v = window.__ag.views.main; v.zoomBy(1); }); await page.waitForTimeout(900); await settle(page);
  const rest = await state(page); assert.equal(rest.level, 1);
  await page.locator('#guess-input').focus(); await page.setViewportSize({ width: PIXEL.viewport.width, height: 470 }); await page.keyboard.type('zurich ai', { delay: 25 }); await page.waitForTimeout(800);
  const near = async (s, label) => { const a = await px(page, rest.lat, rest.lng, rest.zoom), b = await px(page, s.lat, s.lng, rest.zoom); assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1, `${label}: centre moved ${Math.hypot(a[0] - b[0], a[1] - b[1]).toFixed(2)} px`); }; // Leaflet re-derives its centre from whole-pixel pane offsets: sub-pixel noise is not a movement
  const typed = await state(page); assert.equal(typed.zoom, rest.zoom); await near(typed, 'while typing'); assert.equal(typed.chip, true);
  await page.locator('#guess-input').blur(); await page.setViewportSize({ width: PIXEL.viewport.width, height: PIXEL.viewport.height }); await page.waitForTimeout(1000);
  const closed = await state(page); assert.equal(closed.zoom, rest.zoom); await near(closed, 'after the keyboard closed');
  await ctx.close();
});

await test('Zoom out (1 guess) coexists: the zoom state resets to the wider base, zooming in works from there, never wider than it; reduced motion resets without animation', async () => {
  const { ctx, page } = await open(DESKTOP, { reducedMotion: 'reduce' }); await start(page, sample.hub.id);
  await page.keyboard.press('+'); await page.waitForTimeout(500); assert.equal((await state(page)).level, 1);
  await page.locator('#btn-zoom').click(); await page.locator('#sheet [data-confirm]').click(); await page.waitForTimeout(1500);
  await page.waitForFunction(() => window.__ag.views.wide.interactive, null, { timeout: 20000 });
  let s = await state(page); assert.equal(s.level, 0, 'zoom state reset with the new base'); assert.equal(s.chip, false); assert.equal(s.zoom, s.z - 2, 'the wider view is the new minimum');
  await page.keyboard.press('-'); await page.waitForTimeout(300); assert.equal((await state(page)).zoom, s.zoom, 'not wider than the wider view');
  await page.keyboard.press('+'); await page.waitForTimeout(700); s = await state(page); assert.equal(s.level, 1);
  await page.keyboard.press('0'); await page.waitForTimeout(150); s = await state(page); assert.equal(s.level, 0, 'reduced motion: immediate reset');
  await ctx.close();
});
await browser.close(); server.close();
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} zoom checks passed`); process.exit(failed ? 1 : 0);
