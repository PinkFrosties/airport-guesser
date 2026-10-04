// Credits checks: footer, always-visible attribution that never covers the airfield, About & credits screen.
// Run: node tests/credits.mjs     (needs network for Esri tiles; writes qa/credits-*.png)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';

const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const QA = path('../qa/');
mkdirSync(QA, { recursive: true });
const pkg = JSON.parse(readFileSync(path('../package.json'), 'utf8'));
const credits = JSON.parse(readFileSync(path('../data/credits.json'), 'utf8'));
const read = (f) => readFileSync(path('../' + f), 'utf8');

const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const HUB = 3384, SMALL = 20403, REMOTE = 299738;
const ATTRIBUTION = 'Tiles © Esri, Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
let passed = 0;
const test = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 5).join('\n       ')}`); process.exitCode = 1; }
};
async function newPage(profile, colorScheme = 'light') {
  const ctx = await browser.newContext({ ...profile, colorScheme, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}
async function open(page) {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.main.length > 0, null, { timeout: 30000 });
  if (await page.locator('#dlg-help[open]').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
}
const settled = (page) => page.waitForFunction(() => window.__ag.round && (document.querySelector('#veil').hidden || document.querySelector('#veil').classList.contains('out')) && document.querySelectorAll('.sat.front img.leaflet-tile-loaded').length > 0, null, { timeout: 60000 });
async function start(page, id) {
  await page.evaluate((i) => window.__ag.debugStart(i), id);
  await settled(page);
  await page.waitForTimeout(500);
}

/** Frame, attribution pill and the airfield's bounding box (runway extent) in container pixels. */
const geometry = (page) => page.evaluate(() => {
  const g = window.__ag, m = g.map, a = g.round.answer;
  const stage = document.querySelector('#stage').getBoundingClientRect();
  const att = document.querySelector('.sat.front .leaflet-control-attribution').getBoundingClientRect();
  const [clat, clon, w, h] = a.view;
  const dLat = Math.max(h, 150) / 2 / 110574, dLon = Math.max(w, 150) / 2 / (111320 * Math.cos((clat * Math.PI) / 180));
  const sw = m.latLngToContainerPoint([clat - dLat, clon - dLon]), ne = m.latLngToContainerPoint([clat + dLat, clon + dLon]);
  const rel = (r) => ({ left: r.left - stage.left, right: r.right - stage.left, top: r.top - stage.top, bottom: r.bottom - stage.top });
  return {
    frame: { w: stage.width, h: stage.height },
    att: rel(att), text: document.querySelector('.sat.front .leaflet-control-attribution').innerText,
    box: { left: Math.min(sw.x, ne.x), right: Math.max(sw.x, ne.x), top: Math.min(sw.y, ne.y), bottom: Math.max(sw.y, ne.y) },
    pillBg: getComputedStyle(document.querySelector('.sat.front .leaflet-control-attribution')).backgroundColor,
    topEl: (() => { const x = (att.left + att.right) / 2, y = (att.top + att.bottom) / 2; const e = document.elementFromPoint(x, y); return !!(e && e.closest('.leaflet-control-attribution')); })(),
  };
});
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

console.log('footer');
await test('footer on the page: Created by Kevin Pahud, About & credits link, version matching package.json, theme switch', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  const f = await page.evaluate(() => ({ credit: document.querySelector('.foot span').innerText, about: document.querySelector('#btn-about').innerText, version: document.querySelector('#app-version').innerText, seg: document.querySelectorAll('#theme-seg button').length }));
  assert.equal(f.credit, 'Created by Kevin Pahud');
  assert.equal(f.about, 'About & credits');
  assert.equal(f.version, 'v' + pkg.version.replace(/\.0$/, ''));
  assert.equal(f.seg, 3);
  const cfg = read('js/config.js').match(/APP_VERSION = '([^']+)'/)[1];
  assert.equal(cfg, pkg.version, 'config APP_VERSION matches package.json');
  await ctx.close();
});

console.log('attribution');
for (const [scheme, profile, name] of [['light', PHONE, 'phone'], ['dark', PHONE, 'phone'], ['light', DESKTOP, 'desktop'], ['dark', DESKTOP, 'desktop']]) {
  await test(`${scheme} ${name}: Esri attribution is on the image bottom-right in a translucent pill and never covers the airfield (hub, small, remote)`, async () => {
    const { ctx, page } = await newPage(profile, scheme);
    await open(page);
    await page.evaluate(() => window.__ag.debugStart(21)); await settled(page); // loads the Hard data
    for (const [label, id] of [['hub', HUB], ['small', SMALL], ['remote', REMOTE]]) {
      await start(page, id);
      const g = await geometry(page);
      assert.equal(g.text.replace(/\s+/g, ' ').trim(), ATTRIBUTION, 'exact attribution text');
      assert.ok(g.att.right > g.frame.w - 4 && g.att.bottom > g.frame.h - 4, `bottom-right corner (${JSON.stringify(g.att)})`);
      assert.ok(g.att.left >= 0 && g.att.top >= 0 && g.att.right <= g.frame.w + 1 && g.att.bottom <= g.frame.h + 1, 'fully inside the frame');
      assert.ok(/rgba\(.+,\s*0?\.\d+\)/.test(g.pillBg), 'translucent backdrop pill: ' + g.pillBg);
      assert.ok(g.topEl, 'attribution is the topmost element at its position');
      assert.ok(!overlaps(g.att, g.box), `${label}: attribution ${JSON.stringify(g.att)} overlaps the airfield ${JSON.stringify(g.box)}`);
      assert.ok(g.box.top >= -1 && g.box.bottom <= g.frame.h + 1, `${label}: airfield stays inside the frame`);
      if (label === 'hub') await page.locator('#stage').screenshot({ path: QA + `credits-attribution-${scheme}-${name}.png` });
    }
    await ctx.close();
  });
}
await test('attribution stays visible while loading, on the zoomed-out view, after the game, and in the retry state', async () => {
  const { ctx, page } = await newPage(PHONE);
  await open(page);
  await start(page, HUB);
  const visible = () => page.evaluate(() => { const a = document.querySelector('.sat.front .leaflet-control-attribution'); const r = a.getBoundingClientRect(); const e = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return r.width > 50 && !!e && !!e.closest('.leaflet-control-attribution') && /Esri/.test(a.innerText); });
  assert.equal(await visible(), true, 'main view');
  // loading skeleton on top of the map
  let slow = true;
  await page.route('**/World_Imagery/MapServer/tile/**', async (route) => { if (slow) await new Promise((r) => setTimeout(r, 600)); await route.continue(); });
  await page.evaluate(() => { window.__ag.debugStart(3622); });
  await page.waitForFunction(() => !document.querySelector('#veil').hidden && !document.querySelector('#veil').classList.contains('out'));
  assert.equal(await visible(), true, 'while the skeleton is showing');
  slow = false;
  await settled(page);
  // zoomed out
  await page.locator('#guess-input').fill('LHR'); await page.locator('#suggestions li[role=option]').first().click(); await page.locator('#guess-btn').click();
  await page.locator('#btn-zoom').click(); await page.locator('#sheet [data-confirm]').click();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.querySelector('#map-wide').classList.contains('front')), true);
  assert.equal(await visible(), true, 'zoomed-out view');
  // tap to retry
  await page.unroute('**/World_Imagery/MapServer/tile/**');
  await page.route('**/World_Imagery/MapServer/tile/**', (route) => route.abort());
  await page.evaluate(() => { window.__ag.debugStart(3486); });
  await page.waitForFunction(() => !document.querySelector('#veil-retry').hidden, null, { timeout: 30000 });
  assert.equal(await visible(), true, 'tap-to-retry state');
  await ctx.close();
});

console.log('about & credits');
for (const [scheme, profile, name] of [['light', PHONE, 'phone'], ['dark', PHONE, 'phone'], ['light', DESKTOP, 'desktop'], ['dark', DESKTOP, 'desktop']]) {
  await test(`${scheme} ${name}: About & credits opens from the footer, scrolls and closes (button, Escape, backdrop); content reflects the real code`, async () => {
    const { ctx, page, errors } = await newPage(profile, scheme);
    await open(page);
    await page.locator('#btn-about').scrollIntoViewIfNeeded();
    await page.locator('#btn-about').click();
    await page.waitForSelector('#dlg-about[open]');
    await page.waitForFunction(() => document.querySelectorAll('#oss-list li a').length > 0);
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const d = document.querySelector('#dlg-about'), body = d.querySelector('.dlg-body');
      const r = d.getBoundingClientRect();
      return { text: d.innerText, h3: [...d.querySelectorAll('h3')].map((h) => h.innerText), scrollable: d.scrollHeight > d.clientHeight || body.scrollHeight > body.clientHeight, fits: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1,
        links: [...d.querySelectorAll('a')].map((a) => ({ href: a.href, target: a.target, rel: a.rel })), bg: getComputedStyle(d).backgroundColor, version: d.querySelector('#about-version').innerText, date: d.querySelector('#about-data-date').innerText, oss: [...d.querySelectorAll('#oss-list li')].map((l) => l.innerText) };
    });
    assert.deepEqual(info.h3, ['ABOUT', 'CREATED BY', 'IMAGERY', 'AIRPORT DATA', 'OTHER DATA', 'OPEN-SOURCE SOFTWARE', 'FONTS AND ICONS', 'DISCLAIMER']);
    assert.ok(info.fits, 'dialog fits the viewport');
    if (name === 'phone') assert.ok(info.scrollable, 'content scrolls on a phone');
    for (const l of info.links) assert.ok(l.target === '_blank' && /noopener/.test(l.rel), 'external link opens safely: ' + l.href);
    assert.equal(info.version, pkg.version);
    assert.match(info.date, /^\d{4}-\d{2}-\d{2}$/, 'data date shown');
    assert.ok(info.text.includes('Not affiliated with or endorsed by any airport, airline, or data and imagery provider. Imagery may be outdated.'));
    assert.ok(info.text.includes('Tiles © Esri, Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community'));
    assert.ok(info.oss.length === credits.software.length && info.oss[0].includes(credits.software[0].name) && info.oss[0].includes(credits.software[0].license), 'open-source list comes from credits.json: ' + info.oss);
    // scroll to the end, then take screenshots
    await page.evaluate(() => { const b = document.querySelector('#dlg-about'); b.scrollTop = 0; document.querySelector('#dlg-about .dlg-body').scrollTop = 0; });
    await page.screenshot({ path: QA + `credits-about-${scheme}-${name}.png` });
    await page.evaluate(() => { const d = document.querySelector('#dlg-about'); d.scrollTop = d.scrollHeight; document.querySelector('#dlg-about .dlg-body').scrollTop = 99999; });
    await page.waitForTimeout(200);
    if (name === 'phone') await page.screenshot({ path: QA + `credits-about-${scheme}-${name}-end.png` });
    // close three ways
    await page.locator('#dlg-about .link').click();
    assert.equal(await page.locator('#dlg-about[open]').count(), 0, 'Done closes');
    await page.locator('#btn-about').click(); await page.waitForSelector('#dlg-about[open]');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#dlg-about[open]').count(), 0, 'Escape closes');
    await page.locator('#btn-about').click(); await page.waitForSelector('#dlg-about[open]');
    await page.mouse.click(2, 2);
    assert.equal(await page.locator('#dlg-about[open]').count(), 0, 'backdrop click closes');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

await test('nothing is credited that the code does not use; everything that is used is credited', async () => {
  const about = read('index.html').match(/<dialog id="dlg-about"[\s\S]*?<\/dialog>/)[0];
  const code = read('js/app.js') + read('js/config.js') + read('js/satview.js') + read('css/style.css') + read('index.html');
  // used -> credited
  assert.ok(/arcgisonline\.com/.test(code) && /Esri/.test(about), 'imagery');
  assert.ok(/data\/airports\.json/.test(code) && /OurAirports/.test(about), 'airport data');
  assert.ok(/vendor\/leaflet/.test(read('index.html')) && credits.software.some((s) => s.name === 'Leaflet'), 'Leaflet');
  // not used -> not credited
  assert.ok(!/@font-face|fonts\.googleapis|@import/.test(read('css/style.css') + read('index.html')), 'no bundled or remote fonts');
  for (const word of ['Playwright', 'Google Fonts', 'Inter', 'Fontsource', 'MapLibre', 'Mapbox', 'OpenStreetMap', 'React', 'jQuery']) assert.ok(!about.includes(word), 'About mentions unused: ' + word);
  assert.ok(!existsSync(path('../vendor/fonts')), 'no vendored fonts');
  const dirs = credits.software.map((s) => s.name.toLowerCase());
  assert.deepEqual(dirs, ['leaflet']);
  // notices file generated from the same list
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.ok(notices.includes('Leaflet ' + credits.software[0].version) && notices.includes('BSD 2-Clause License'));
});

await browser.close();
server.close();
console.log(`\n${passed} credits checks passed${process.exitCode ? ', some FAILED' : ''}. Screenshots: qa/credits-*.png`);
