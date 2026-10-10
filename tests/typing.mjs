// Typing must never change the satellite view: same zoom, centre and map size before, while the keyboard is open, and after.
// Android: soft keyboard emulated by shrinking the viewport (the layout viewport shrinks). Desktop: focus, type, shrink the window height.
// Run: node tests/typing.mjs   (AG_ROOT=dist for the built site, AG_BROWSER=webkit)
import { launchBrowser } from './browser.mjs';
import { devices } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from '../scripts/serve.mjs';
const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const server = createServer(); await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser; for (const o of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await launchBrowser(o); break; } catch { /* next */ } }
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split('\n').slice(0, 5).join('\n       ')}`); } };

async function open(profile) {
  const ctx = await browser.newContext({ ...profile, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } });
  const page = await ctx.newPage(); await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 });
  await page.waitForFunction(() => { const v = document.querySelector('#veil'); return v.hidden || v.classList.contains('out'); }, null, { timeout: 40000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { // count every view change from now on
    const g = window.__ag; window.__log = { setView: 0 };
    for (const v of Object.values(g.views)) { const m = v.map; const sv = m.setView.bind(m); m.setView = (...a) => { window.__log.setView++; return sv(...a); }; }
  });
  return { ctx, page };
}
const snap = (page) => page.evaluate(() => {
  const m = window.__ag.views.main.map; const c = m.getCenter(); const s = m.getSize();
  const st = document.querySelector('#stage').getBoundingClientRect();
  return { zoom: m.getZoom(), lat: c.lat, lng: c.lng, w: s.x, h: s.y, kb: document.documentElement.classList.contains('kb'), stageH: Math.round(st.height), setView: window.__log.setView, scrollY: Math.round(scrollY) };
});
const same = (a, b, label) => {
  for (const k of ['zoom', 'w', 'h']) assert.equal(a[k], b[k], `${label}: ${k} ${a[k]} -> ${b[k]}`);
  assert.ok(Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9, `${label}: centre moved ${a.lat},${a.lng} -> ${b.lat},${b.lng}`);
};

const PIXEL = devices['Pixel 7'];
await test('viewport meta asks for a visual-viewport keyboard (interactive-widget=resizes-visual)', async () => {
  const { ctx, page } = await open({ viewport: { width: 412, height: 915 } });
  assert.match(await page.locator('meta[name=viewport]').getAttribute('content'), /interactive-widget=resizes-visual/); await ctx.close();
});
await test('Android: focus, type 10 characters, pick a suggestion, dismiss the keyboard, rotate and back: zoom, centre and map size never change', async () => {
  const { ctx, page } = await open({ ...PIXEL });
  const rest = await snap(page); const H = PIXEL.viewport.height, W = PIXEL.viewport.width;
  await page.locator('#guess-input').focus();
  await page.setViewportSize({ width: W, height: Math.round(H * 0.55) }); // the soft keyboard opens
  await page.waitForTimeout(700);
  const open1 = await snap(page); assert.equal(open1.kb, true, 'compact keyboard layout'); same(rest, open1, 'keyboard open');
  assert.ok(open1.stageH < rest.stageH, 'the frame is compact while typing'); assert.equal(open1.scrollY, 0, 'page not scrolled');
  for (const ch of 'zurich air') { await page.keyboard.type(ch, { delay: 30 }); same(rest, await snap(page), `after typing "${ch}"`); }
  await page.waitForSelector('#suggestions li[role=option]');
  const vis = await page.evaluate(() => { const v = window.visualViewport; const r = (s) => document.querySelector(s).getBoundingClientRect(); return { inputIn: r('#guess-input').top >= 0 && r('#guess-input').bottom <= v.height, stageIn: r('#stage').top >= 0 && r('#stage').bottom <= v.height, sugg: r('#suggestions').bottom <= v.height + 1 }; });
  assert.deepEqual(vis, { inputIn: true, stageIn: true, sugg: true }, 'input, image and suggestions all above the keyboard');
  await page.locator('#suggestions li[role=option]').first().click(); // choosing blurs the input on touch devices: the keyboard goes away
  await page.setViewportSize({ width: W, height: H }); await page.waitForTimeout(1000);
  const closed = await snap(page); assert.equal(closed.kb, false); same(rest, closed, 'suggestion chosen and keyboard dismissed'); assert.equal(closed.stageH, rest.stageH, 'frame back to its size');
  assert.equal(closed.setView, rest.setView, 'the view was never re-set while typing');
  await page.setViewportSize({ width: H, height: W }); await page.waitForTimeout(1200); // rotate to landscape (a real width change: a re-fit is allowed)
  await page.setViewportSize({ width: W, height: H }); await page.waitForTimeout(1500); // and back
  same(rest, await snap(page), 'after rotating back'); await ctx.close();
});
await test('Android: the image and attribution stay visible in the compact frame and show the same airfield (screenshot)', async () => {
  const { ctx, page } = await open({ ...PIXEL });
  await page.locator('#guess-input').focus(); await page.setViewportSize({ width: PIXEL.viewport.width, height: 470 }); await page.keyboard.type('zur', { delay: 30 }); await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const sat = document.querySelector('#map').getBoundingClientRect(), st = document.querySelector('#stage').getBoundingClientRect(), at = document.querySelector('#map .leaflet-control-attribution').getBoundingClientRect();
    return { satInside: sat.top >= st.top - 1 && sat.bottom <= st.bottom + 1 && sat.left >= st.left - 1 && sat.right <= st.right + 1, attrInside: at.right <= st.right + 1 && at.bottom <= st.bottom + 1 && at.left >= st.left - 1, attrH: Math.round(at.height) };
  });
  assert.equal(r.satInside, true, 'the scaled map lies inside the compact frame'); assert.equal(r.attrInside, true, 'the attribution is visible'); assert.ok(r.attrH > 6);
  await page.screenshot({ path: path('../qa/typing-keyboard-open.png') }); await ctx.close();
});
await test('desktop: focus, type, shrink and restore the window height: no zoom or framing change and no compact layout', async () => {
  const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } });
  const rest = await snap(page);
  await page.locator('#guess-input').focus(); await page.keyboard.type('frankfurt', { delay: 20 }); same(rest, await snap(page), 'typed');
  await page.setViewportSize({ width: 1280, height: 420 }); await page.waitForTimeout(700); const small = await snap(page);
  assert.equal(small.kb, false, 'the touch keyboard layout is not used with a mouse'); assert.equal(small.zoom, rest.zoom, 'height-only resize does not re-fit');
  await page.keyboard.type(' airport', { delay: 20 }); await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(900);
  same(rest, await snap(page), 'restored'); await ctx.close();
});
await test('a real width change (window resize on desktop) still re-fits the view', async () => {
  const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } });
  const before = await snap(page); await page.setViewportSize({ width: 600, height: 800 }); await page.waitForTimeout(1500);
  const after = await snap(page); assert.ok(after.w !== before.w, 'map width follows the layout'); assert.ok(after.setView > before.setView, 'view was re-presented'); await ctx.close();
});
await browser.close(); server.close();
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} typing checks passed`); process.exit(failed ? 1 : 0);
