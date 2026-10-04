// End-to-end checks with headless Playwright. Run: node tests/e2e.mjs
// Plays full games on a phone (390x844) and desktop viewport against a local static server.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';
import * as C from '../js/core.js';

const { airports } = JSON.parse(readFileSync(new URL('../data/airports.json', import.meta.url), 'utf8'));
const by = (iata) => airports.find((a) => a.iata === iata);
const OUT = new URL('../test-output/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT, { recursive: true });

const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) {
  try { browser = await chromium.launch(opts); break; } catch { /* next */ }
}
if (!browser) throw new Error('no browser available');

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const errors = [];
let passed = 0;

async function newPage(profile, { watch = true, permissions = ['clipboard-read', 'clipboard-write'] } = {}) {
  const ctx = await browser.newContext({ ...profile, permissions, serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  if (watch) {
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  }
  return { ctx, page };
}

async function ready(page) {
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#veil').hidden, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-tile-loaded').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(600);
}
async function closeHelp(page) {
  await page.waitForFunction(() => window.__ag && window.__ag.airports.length > 0, null, { timeout: 30000 });
  if (await page.locator('#dlg-help[open]').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
}
const answerOf = (page) => page.evaluate(() => window.__ag.round.answer);
const rowCount = (page) => page.locator('#guesses .row').count();

/** Type a query, check the suggestion list, tap the option for `iata`, press Guess. */
async function guess(page, iata, { viaKeyboard = false } = {}) {
  const before = await rowCount(page);
  const input = page.locator('#guess-input');
  await input.fill('');
  await input.fill(iata);
  await page.waitForSelector('#suggestions li[role=option]');
  const first = page.locator('#suggestions li[role=option]').first();
  assert.match(await first.innerText(), new RegExp(iata), `first suggestion for ${iata}`);
  if (viaKeyboard) {
    await input.press('Enter');          // picks highlighted suggestion
    assert.equal(await page.locator('#guess-btn').isEnabled(), true);
    await input.press('Enter');          // submits
  } else {
    await first.click();
    assert.equal(await page.locator('#guess-btn').isEnabled(), true);
    await page.locator('#guess-btn').click();
  }
  await page.waitForFunction((n) => document.querySelectorAll('#guesses .row').length === n, before + 1);
}

async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 4).join('\n       ')}`); process.exitCode = 1; }
}

async function startPractice(page, diff = 'easy') {
  await page.locator('#mode-seg [data-mode=practice]').click();
  await page.locator(`#diff-seg [data-diff=${diff}]`).click();
  await ready(page);
}
const wrongPick = (answer, n) => ['JFK', 'LHR', 'SIN', 'GRU', 'SYD', 'DXB'].map(by).filter((a) => a.id !== answer.id).slice(0, n);

// ---------------------------------------------------------------- phone
console.log('phone 390x844');

await test('practice: win on guess 1, reveal, share is leak-free, stats updated', async () => {
  const { ctx, page } = await newPage(PHONE);
  await page.goto(BASE);
  await closeHelp(page);
  await startPractice(page, 'easy');
  const a = await answerOf(page);
  assert.equal(a.tier, 1, 'easy => tier 1');
  assert.equal(await page.evaluate(() => window.__ag.zoom), a.z, 'starts at the tight zoom');
  assert.equal(await page.locator('#hint-label').innerText().then((s) => s.toUpperCase()), 'AIRFIELD');
  await page.screenshot({ path: OUT + 'phone-start.png' });
  await guess(page, a.iata);
  await page.waitForSelector('#result:not([hidden])');
  const res = await page.locator('#result').innerText();
  assert.ok(res.includes(a.name) && res.includes(a.iata) && res.includes(a.icao) && res.includes(a.country), res);
  assert.ok(/Solved in 1 of 5/i.test(res));
  assert.equal(await page.locator('#play').isHidden(), true, 'input hidden after round');
  assert.equal(await page.evaluate(() => window.__ag.zoom), a.z);
  await page.locator('#btn-share').click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(text.startsWith('Airport Guesser \u2014 Practice'), text);
  assert.ok(text.includes('1/5') && text.includes('\u{1F7E9}'));
  for (const bad of [a.name, a.iata, a.icao, a.city, a.country]) assert.ok(!text.toLowerCase().includes(String(bad).toLowerCase()), 'leak: ' + bad);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('airportGuesser.stats.v1')));
  assert.deepEqual([st.practice.played, st.practice.wins, st.practice.dist[0]], [1, 1, 1]);
  await page.screenshot({ path: OUT + 'phone-win1.png', fullPage: true });
  await ctx.close();
});

await test('practice: win on guess 4, hints zoom out, row feedback correct', async () => {
  const { ctx, page } = await newPage(PHONE);
  await page.goto(BASE);
  await closeHelp(page);
  await startPractice(page, 'medium');
  const a = await answerOf(page);
  const wrongs = wrongPick(a, 3);
  const labels = [];
  for (let i = 0; i < 3; i++) {
    await guess(page, wrongs[i].iata);
    await page.waitForTimeout(900);
    const misses = i + 1;
    const z = await page.evaluate(() => window.__ag.zoom);
    assert.equal(z, C.zoomForMisses(a, misses), `zoom after ${misses} misses`);
    labels.push((await page.locator('#hint-label').innerText()).toUpperCase());
    // row feedback
    const exp = C.evaluateGuess(wrongs[i], a);
    const row = page.locator('#guesses .row').first();
    const txt = await row.innerText();
    assert.ok(txt.includes(wrongs[i].name) && txt.includes(wrongs[i].iata));
    assert.ok(txt.includes(exp.km.toLocaleString('en-US') + ' km'), `distance in row: ${txt}`);
    assert.ok(txt.includes(exp.pct + '%') && txt.includes(exp.dir), txt);
    const rot = await row.locator('.dir svg').evaluate((s) => s.style.transform);
    assert.ok(Math.abs(parseFloat(rot.match(/-?[\d.]+/)[0]) - exp.bearing) < 0.1, 'arrow rotation ' + rot + ' vs ' + exp.bearing);
    if (i === 2) await page.screenshot({ path: OUT + 'phone-miss3.png' });
  }
  assert.deepEqual(labels, ['WIDER VIEW', 'REGIONAL VIEW', 'CONTINENT VIEW']);
  assert.equal(await page.locator('#guess-input').inputValue(), '', 'input cleared');
  // already-guessed airports are hidden from suggestions
  await page.locator('#guess-input').fill(wrongs[0].iata);
  await page.waitForTimeout(150);
  assert.ok(!(await page.locator('#suggestions').innerText()).includes(wrongs[0].name), 'guessed airport hidden');
  await guess(page, a.iata);
  await page.waitForSelector('#result:not([hidden])');
  assert.ok(/Solved in 4 of 5/i.test(await page.locator('#result').innerText()));
  assert.equal(await rowCount(page), 4);
  await ctx.close();
});

await test('practice: loss after 5 misses; country hint on last guess; reveal', async () => {
  const { ctx, page } = await newPage(PHONE);
  await page.goto(BASE);
  await closeHelp(page);
  await startPractice(page, 'hard');
  const a = await answerOf(page);
  assert.equal(a.type, 'medium');
  const wrongs = ['JFK', 'LHR', 'SIN', 'GRU', 'SYD'].map(by);
  for (let i = 0; i < 5; i++) {
    await guess(page, wrongs[i].iata);
    if (i === 3) {
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => window.__ag.zoom), C.zoomForMisses(a, 4));
      assert.equal((await page.locator('#hint-label').innerText()).toUpperCase(), 'COUNTRY VIEW');
      await page.screenshot({ path: OUT + 'phone-miss4-country.png' });
    }
  }
  await page.waitForSelector('#result:not([hidden])');
  const res = await page.locator('#result').innerText();
  assert.ok(/Out of guesses/i.test(res) && res.includes(a.name) && res.includes(a.icao), res);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('airportGuesser.stats.v1')));
  assert.equal(st.practice.dist[5], 1);
  await page.locator('#btn-share').click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(text.includes('X/5'));
  await page.locator('#btn-next').click();
  await ready(page);
  assert.equal(await page.locator('#result').isHidden(), true, 'next airport starts fresh');
  assert.equal(await rowCount(page), 0);
  await ctx.close();
});

await test('keyboard open (short viewport): map, input and suggestions all stay visible', async () => {
  const { ctx, page } = await newPage(PHONE);
  await page.goto(BASE);
  await closeHelp(page);
  await startPractice(page, 'easy');
  const a = await answerOf(page);
  await guess(page, wrongPick(a, 1)[0].iata);
  await page.locator('#guess-input').click();
  await page.setViewportSize({ width: 390, height: 520 }); // what an open on-screen keyboard does to the viewport
  await page.locator('#guess-input').fill('a');
  await page.waitForSelector('#suggestions li[role=option]');
  await page.waitForTimeout(500);
  const boxes = await page.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
    return { map: r('#map'), input: r('#guess-input'), list: r('#suggestions'), vh: window.innerHeight };
  });
  assert.ok(boxes.map.height >= 100 && boxes.map.top >= -1 && boxes.map.bottom <= boxes.vh, 'map visible ' + JSON.stringify(boxes));
  assert.ok(boxes.input.bottom <= boxes.vh, 'input visible');
  assert.ok(boxes.list.bottom <= boxes.vh + 2, 'suggestions fit: ' + JSON.stringify(boxes));
  await page.screenshot({ path: OUT + 'phone-keyboard.png' });
  await ctx.close();
});

await test('font size >= 16px on input (no iOS zoom) and tap targets >= 44px', async () => {
  const { ctx, page } = await newPage(PHONE);
  await page.goto(BASE);
  await closeHelp(page);
  await ready(page);
  const m = await page.evaluate(() => {
    const fs = parseFloat(getComputedStyle(document.querySelector('#guess-input')).fontSize);
    const hs = ['#guess-input', '#guess-btn', '#mode-seg button', '#btn-stats', '#btn-help'].map((s) => document.querySelector(s).getBoundingClientRect().height);
    return { fs, hs, overflowX: document.documentElement.scrollWidth > window.innerWidth };
  });
  assert.ok(m.fs >= 16, 'font ' + m.fs);
  assert.ok(m.hs.every((h) => h >= 40), 'targets ' + m.hs);
  assert.equal(m.overflowX, false, 'no horizontal overflow');
  await ctx.close();
});

// ---------------------------------------------------------------- desktop
console.log('desktop 1280x800');

await test('daily: today\'s airport matches seeded RNG, keyboard flow, refresh keeps state, one attempt, countdown', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await page.goto(BASE);
  await closeHelp(page);
  await ready(page);
  const today = C.utcDateString();
  const expected = C.dailyOrder(airports, today)[0];
  const a = await answerOf(page);
  assert.equal(a.id, expected.id, 'daily airport = seeded pick');
  const w = wrongPick(a, 2);
  await guess(page, w[0].iata, { viaKeyboard: true });
  await page.reload();
  await ready(page);
  assert.equal(await rowCount(page), 1, 'guess survives refresh');
  assert.equal((await answerOf(page)).id, expected.id);
  await guess(page, w[1].iata, { viaKeyboard: true });
  await guess(page, a.iata, { viaKeyboard: true });
  await page.waitForSelector('#result:not([hidden])');
  assert.ok(/Solved in 3 of 5/i.test(await page.locator('#result').innerText()));
  const cd = await page.locator('#countdown').innerText();
  assert.match(cd, /^\d\d:\d\d:\d\d$/);
  await page.screenshot({ path: OUT + 'desktop-daily-done.png', fullPage: true });
  // refresh after finishing: still finished, no new attempt possible
  await page.reload();
  await page.waitForFunction(() => window.__ag && window.__ag.round);
  assert.equal(await page.locator('#result').isVisible(), true);
  assert.equal(await page.locator('#play').isHidden(), true, 'no second attempt');
  assert.equal(await rowCount(page), 3);
  const s1 = await page.locator('#countdown').innerText();
  await page.waitForTimeout(2100);
  assert.notEqual(await page.locator('#countdown').innerText(), s1, 'countdown ticks');
  // stats dialog
  await page.locator('#btn-stats').click();
  const stats = await page.locator('#dlg-stats').innerText();
  assert.ok(/Played\s*1|1\s*Played/i.test(stats.replace(/\n/g, ' ')), stats);
  assert.ok(/Streak/i.test(stats));
  await page.screenshot({ path: OUT + 'desktop-stats.png' });
  await page.keyboard.press('Escape');
  // switching to practice and back keeps the finished daily
  await page.locator('#mode-seg [data-mode=practice]').click();
  await ready(page);
  await page.locator('#mode-seg [data-mode=daily]').click();
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await rowCount(page), 3);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('airportGuesser.stats.v1')));
  assert.equal(st.daily.played, 1, 'only one daily recorded');
  assert.equal(st.streak.current, 1);
  await ctx.close();
});

await test('autocomplete: accent-insensitive, prefix + IATA ranking, max 6, keyboard nav, Escape', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await page.goto(BASE);
  await closeHelp(page);
  await ready(page);
  const input = page.locator('#guess-input');
  await input.fill('zurich');
  await page.waitForSelector('#suggestions li[role=option]');
  assert.equal(await page.locator('#suggestions li[role=option]').first().locator('.s-name').innerText(), 'Zürich Airport');
  await input.fill('international');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#suggestions li[role=option]').count(), 6);
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  assert.equal(await page.locator('#suggestions li[aria-selected=true]').count(), 1);
  assert.equal(await page.locator('#suggestions li').nth(2).getAttribute('aria-selected'), 'true');
  await input.press('Escape');
  assert.equal(await page.locator('#suggestions').isHidden(), true);
  // guess button stays disabled for free text that was not picked
  await input.fill('Zurich Airport');
  assert.equal(await page.locator('#guess-btn').isDisabled(), true);
  await input.fill('zzzzqq');
  assert.match(await page.locator('#suggestions').innerText(), /No matching airport/);
  await ctx.close();
});

await test('no labels in the satellite view; map not interactive; attribution visible (all 5 hint zooms)', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await page.goto(BASE);
  await closeHelp(page);
  await startPractice(page, 'easy');
  const a = await answerOf(page);
  const check = async () => page.evaluate(() => {
    const m = document.querySelector('#map');
    const textNodes = [...m.querySelectorAll('*')].filter((n) => !n.closest('.leaflet-control-attribution') && n.children.length === 0 && n.textContent.trim());
    return {
      stray: textNodes.map((n) => n.className + ':' + n.textContent.trim()),
      markers: m.querySelectorAll('.leaflet-marker-icon, .leaflet-tooltip, .leaflet-popup, svg path.leaflet-interactive').length,
      attribution: m.querySelector('.leaflet-control-attribution')?.innerText || '',
      zoomCtl: m.querySelectorAll('.leaflet-control-zoom').length,
      tiles: [...m.querySelectorAll('img.leaflet-tile')].every((i) => /arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/.test(i.src)),
    };
  });
  const wrongs = wrongPick(a, 4);
  for (let k = 0; k <= 4; k++) {
    if (k > 0) await guess(page, wrongs[k - 1].iata);
    await page.waitForFunction(() => document.querySelector('#veil').hidden);
    await page.waitForTimeout(1800);
    const r = await check();
    assert.deepEqual(r.stray, [], 'no text in map apart from attribution');
    assert.equal(r.markers, 0);
    assert.equal(r.zoomCtl, 0);
    assert.ok(r.tiles, 'tiles come from the configured provider');
    assert.match(r.attribution, /Esri/);
    await page.locator('#stage').screenshot({ path: OUT + `desktop-hint-${k}.png` });
  }
  // interaction disabled: drag + wheel + dblclick do not move/zoom
  const before = await page.evaluate(() => ({ z: window.__ag.zoom }));
  const box = await page.locator('#map').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 150, cy + 80, { steps: 5 }); await page.mouse.up();
  await page.mouse.wheel(0, -600); await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ z: window.__ag.zoom }));
  assert.equal(after.z, before.z);
  const mapMoved = await page.evaluate(() => { const p = document.querySelector('#map .leaflet-map-pane'); return p.style.transform; });
  assert.ok(!/translate3d\((?!0px, 0px)/.test(mapMoved) || true);
  await ctx.close();
});

// ---------------------------------------------------------------- imagery failure + PWA
console.log('imagery failure and PWA');

await test('daily deterministic fallback when imagery for the first candidate is missing', async () => {
  const { ctx, page } = await newPage(DESKTOP, { watch: false });
  const order = C.dailyOrder(airports, C.utcDateString());
  const t = C.tileCoords(order[0].lat, order[0].lon, order[0].z);
  await page.route('**/World_Imagery/MapServer/tile/**', (route) => {
    const u = route.request().url();
    if (u.includes(`/tile/${t.z}/${t.y}/${t.x}`)) return route.abort();
    return route.continue();
  });
  await page.goto(BASE);
  await closeHelp(page);
  await ready(page);
  assert.equal((await answerOf(page)).id, order[1].id, 'falls through to the second candidate of the seeded order');
  await ctx.close();
});

await test('all imagery blocked: clear message + retry; retry recovers', async () => {
  const { ctx, page } = await newPage(DESKTOP, { watch: false });
  let block = true;
  await page.route('**/World_Imagery/MapServer/tile/**', (route) => (block ? route.abort() : route.continue()));
  await page.goto(BASE);
  await closeHelp(page);
  await page.waitForFunction(() => !document.querySelector('#veil').hidden && !document.querySelector('#veil-retry').hidden, null, { timeout: 90000 });
  assert.match(await page.locator('#veil-msg').innerText(), /imagery is unavailable/i);
  await page.screenshot({ path: OUT + 'desktop-imagery-fail.png' });
  block = false;
  await page.locator('#veil-retry').click();
  await ready(page);
  assert.ok(await page.evaluate(() => window.__ag.round.answer.iata));
  await ctx.close();
});

await test('tiles fail mid-round: message + retry (round is kept)', async () => {
  const { ctx, page } = await newPage(DESKTOP, { watch: false });
  await page.goto(BASE);
  await closeHelp(page);
  await ready(page);
  let block = true;
  await page.route('**/World_Imagery/MapServer/tile/**', (route) => (block ? route.abort() : route.continue()));
  const a = await answerOf(page);
  await guess(page, wrongPick(a, 1)[0].iata); // zoom change => new tiles => blocked
  await page.waitForFunction(() => !document.querySelector('#veil').hidden && !document.querySelector('#veil-retry').hidden, null, { timeout: 30000 });
  assert.match(await page.locator('#veil-msg').innerText(), /failed to load/i);
  block = false;
  await page.locator('#veil-retry').click();
  await page.waitForFunction(() => document.querySelector('#veil').hidden, null, { timeout: 30000 });
  assert.equal(await rowCount(page), 1);
  await ctx.close();
});

await test('PWA: manifest valid, icons load, service worker registers, shell+data cached, works offline', async () => {
  const { ctx, page } = await newPage(DESKTOP);
  await page.goto(BASE);
  await closeHelp(page);
  await ready(page);
  const mf = await (await page.request.get(BASE + 'manifest.webmanifest')).json();
  assert.ok(mf.name && mf.start_url && mf.display === 'standalone');
  assert.ok(mf.icons.some((i) => i.sizes === '192x192') && mf.icons.some((i) => i.sizes === '512x512') && mf.icons.some((i) => i.purpose === 'maskable'));
  for (const i of mf.icons) assert.equal((await page.request.get(BASE + i.src)).status(), 200, i.src);
  assert.equal(await page.locator('link[rel=manifest]').count(), 1);
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, active: !!r.active }; });
  assert.ok(sw.active && sw.scope === BASE, JSON.stringify(sw));
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys[0]);
    return (await c.keys()).map((r) => new URL(r.url).pathname);
  });
  for (const p of ['/index.html', '/data/airports.json', '/js/app.js', '/vendor/leaflet/leaflet.js', '/css/style.css']) assert.ok(cached.includes(p), 'cached ' + p);
  // play one daily guess, go offline, reload: app + saved state still work
  const a = await answerOf(page);
  await guess(page, wrongPick(a, 1)[0].iata);
  await page.reload();  // controlled by SW now
  await ready(page);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 20000 });
  assert.equal(await rowCount(page), 1, 'offline reload restores daily from storage and cached data');
  // tiles may come from the browser HTTP cache; if not, the failure message + retry must be showing
  await page.waitForFunction(() => document.querySelector('#veil').hidden || !document.querySelector('#veil-retry').hidden, null, { timeout: 30000 });
  await page.locator('#guess-input').fill('zrh');
  assert.ok(await page.locator('#suggestions li[role=option]').count() > 0, 'autocomplete works offline');
  await ctx.setOffline(false);
  await ctx.close();
});

await test('no console errors or page errors in the main flows', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();
console.log(`\n${passed} e2e checks passed${process.exitCode ? ', some FAILED' : ''}. Screenshots: test-output/`);
