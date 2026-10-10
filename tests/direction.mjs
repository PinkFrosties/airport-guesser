// Distance and direction: maths against an independent implementation (Turf, dev-only), edge cases with expected values,
// and the rendered arrow (rotation, label, accessible text) on every guess row, after reload and after a theme switch.
// Run: node tests/direction.mjs   (AG_ROOT=dist for the built site, AG_BROWSER=webkit)
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import turfBearing from '@turf/bearing';
import turfDistance from '@turf/distance';
import * as C from '../js/core.js';
import { launchBrowser } from './browser.mjs';
import { createServer } from '../scripts/serve.mjs';
const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const rd = (f) => JSON.parse(readFileSync(path('../data/' + f), 'utf8')).airports;
const all = [...rd('airports.json'), ...rd('airports-hard.json')];
const byCode = (c) => all.find((a) => a.iata === c || a.icao === c);
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split('\n').slice(0, 5).join('\n       ')}`); } };

// ---- independent reference (Turf): bearing in -180..180, distance in km (mean Earth radius 6371.0088 km, same as the app)
const pt = (a) => [a.lon, a.lat];
const refBearing = (g, a) => (turfBearing(pt(g), pt(a)) + 360) % 360;
const refKm = (g, a) => turfDistance(pt(g), pt(a), { units: 'kilometers' });
const angDiff = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
const P = (lat, lon, id = 0) => ({ id, lat, lon });

console.log('maths');
await test('bearing is the initial great-circle bearing FROM the guess TO the answer, 0..360, in degrees', () => {
  const g = byCode('ZRH'), a = byCode('JFK');
  const b = C.bearingDeg(g.lat, g.lon, a.lat, a.lon);
  assert.ok(b >= 0 && b < 360); assert.ok(angDiff(b, refBearing(g, a)) < 1e-6);
  assert.ok(b > 275 && b < 300, `Zurich -> New York should be west-north-west, got ${b.toFixed(1)}`); // hand check
  const b2 = C.bearingDeg(a.lat, a.lon, g.lat, g.lon); assert.ok(b2 > 40 && b2 < 60, `New York -> Zurich north-east, got ${b2.toFixed(1)}`);
  const s = C.bearingDeg(byCode('SYD').lat, byCode('SYD').lon, byCode('SIN').lat, byCode('SIN').lon);
  assert.ok(s > 290 && s < 330, `Sydney -> Singapore should be north-west, got ${s.toFixed(1)}`); assert.equal(C.compassLabel(s), 'NW');
});
await test('25 random guess/answer pairs agree with Turf (and 5,000 more for the maximum error)', () => {
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const worst = { km: 0, deg: 0 };
  const check = () => {
    const g = all[Math.floor(rnd() * all.length)], a = all[Math.floor(rnd() * all.length)]; if (g.id === a.id) return;
    const km = C.haversineKm(g.lat, g.lon, a.lat, a.lon), rk = refKm(g, a);
    worst.km = Math.max(worst.km, Math.abs(km - rk));
    if (km < 19900) worst.deg = Math.max(worst.deg, angDiff(C.bearingDeg(g.lat, g.lon, a.lat, a.lon), refBearing(g, a))); // near-antipodal bearings are ill-conditioned
  };
  for (let i = 0; i < 5025; i++) check();
  console.log(`       max error over 5,025 pairs: ${worst.km.toExponential(2)} km, ${worst.deg.toExponential(2)} deg`);
  assert.ok(worst.km < 0.01 && worst.deg < 0.001, JSON.stringify(worst));
});
await test('distance is great-circle km, rounded once (to a whole km, at least 1 for a wrong guess); there is no miles option', () => {
  const r = C.evaluateGuess(byCode('ZRH'), byCode('JFK')); assert.ok(Number.isInteger(r.km) && Math.abs(r.km - refKm(byCode('ZRH'), byCode('JFK'))) < 0.51);
  assert.equal(C.evaluateGuess(P(0, 0, 1), P(0, 0, 2)).km, 1);
  assert.ok(!/miles|\bmi\b/i.test(readFileSync(path('../js/app.js'), 'utf8').replace(/\bmin\b|\bmillis\b/g, '')), 'no miles anywhere in the UI code');
});
await test('antimeridian: Fiji -> Hawaii and Tokyo -> Anchorage take the short way (east/north-east), not across the whole map', () => {
  for (const [from, to, label] of [['NAN', 'HNL', 'NE'], ['NRT', 'ANC', 'NE']]) {
    const g = byCode(from), a = byCode(to); const b = C.bearingDeg(g.lat, g.lon, a.lat, a.lon);
    assert.ok(angDiff(b, refBearing(g, a)) < 1e-6, `${from}->${to}`); assert.equal(C.compassLabel(b), label, `${from}->${to} ${b.toFixed(1)}`);
    assert.ok(Math.abs(C.haversineKm(g.lat, g.lon, a.lat, a.lon) - refKm(g, a)) < 1e-6);
  }
  const r = C.evaluateGuess(P(0, 179.9), P(0, -179.9, 2)); assert.equal(r.dir, 'E'); assert.ok(r.km < 25);
  const r2 = C.evaluateGuess(P(0, -179.9), P(0, 179.9, 2)); assert.equal(r2.dir, 'W');
});
await test('poles: across the pole the answer is "north"; no NaN anywhere near the poles', () => {
  const r = C.evaluateGuess(P(89.99, 0), P(89.99, 180, 2)); assert.equal(r.dir, 'N'); assert.ok(Number.isFinite(r.bearing) && r.km < 5);
  const s = C.evaluateGuess(P(-89.99, 20), P(-89.99, -160, 2)); assert.equal(s.dir, 'S');
  for (const lat of [90, -90, 89.9999999]) { const x = C.evaluateGuess(P(lat, 10), P(10, 20, 2)); assert.ok(Number.isFinite(x.bearing) && Number.isFinite(x.km), `lat ${lat}`); }
});
await test('due north, south, east, west and the 22.5-degree edges: label, arrow angle and numeric bearing agree', () => {
  const dirs = [[10, 0, 'N', 0], [-10, 0, 'S', 180], [0, 10, 'E', 90], [0, -10, 'W', 270]];
  for (const [la, lo, label, b] of dirs) { const r = C.evaluateGuess(P(0, 0), P(la, lo, 2)); assert.equal(r.dir, label); assert.ok(angDiff(r.bearing, b) < 1e-6, `${label}: ${r.bearing}`); }
  // boundaries: exactly on an edge goes to the clockwise-next point, one tenth of a degree either side is unambiguous
  for (const [deg, label] of [[22.4, 'N'], [22.5, 'NE'], [67.4, 'NE'], [67.5, 'E'], [337.4, 'NW'], [337.5, 'N'], [359.9, 'N'], [0, 'N'], [180, 'S'], [202.4, 'S'], [202.5, 'SW']]) assert.equal(C.compassLabel(deg), label, `${deg}`);
  for (let d = 0; d < 360; d += 0.5) { // the label is always within 22.5 degrees of the exact arrow, and the arrow angle is the same direction as the bearing
    const idx = C.compassIndex(d); assert.ok(angDiff(d, idx * 45) <= 22.5 + 1e-9, `${d}`);
    const turn = C.arrowAngle(d); assert.ok(turn > -180 && turn <= 180); assert.ok(angDiff(turn, d) < 1e-9);
  }
  assert.equal(C.arrowAngle(350), -10); assert.equal(C.arrowAngle(180), 180); assert.equal(C.arrowAngle(0), 0); assert.equal(C.arrowAngle(190), -170);
});
await test('great-circle, not rhumb: London -> Tokyo points north-north-east initially', () => {
  const g = byCode('LHR'), a = byCode('NRT'); const b = C.bearingDeg(g.lat, g.lon, a.lat, a.lon);
  assert.ok(angDiff(b, refBearing(g, a)) < 1e-6); assert.ok(b > 15 && b < 45, `${b.toFixed(1)}`); // a rhumb line would be ~ 80 degrees (east)
  const rhumb = (Math.atan2(((a.lon - g.lon) * Math.PI) / 180, Math.log(Math.tan(Math.PI / 4 + (a.lat * Math.PI) / 360) / Math.tan(Math.PI / 4 + (g.lat * Math.PI) / 360))) * 180) / Math.PI;
  assert.ok(angDiff(b, rhumb) > 20, `great circle ${b.toFixed(1)} vs rhumb ${rhumb.toFixed(1)}`);
});
await test('very small distances: identical coordinates and airports of one city give "very close", never a noisy arrow', () => {
  const same = C.evaluateGuess(P(-34.16917, -71.53111, 1), P(-34.16917, -71.53111, 2));
  assert.equal(same.near, true); assert.ok(same.km >= 1);
  const near = C.evaluateGuess(P(40.0, 10.0, 1), P(40.0, 10.05, 2)); assert.equal(near.near, true); // 4 km
  const far = C.evaluateGuess(P(40.0, 10.0, 1), P(40.0, 10.2, 2)); assert.equal(far.near, false); // 17 km
  assert.equal(C.evaluateGuess(P(1, 1, 1), P(1, 1, 1)).near, false, 'the correct airport is not "near"');
  assert.equal(C.directionPhrase(same), 'Very close, about 1 km away');
  assert.match(C.directionPhrase(C.evaluateGuess(byCode('ZRH'), byCode('JFK'))), /^About [\d,]+ km to the north-west$/);
  assert.equal(C.directionPhrase(C.evaluateGuess(byCode('SYD'), byCode('SIN'))).replace(/[\d,]+/, 'N'), 'About N km to the north-west');
});
await test('near-antipodal pairs stay finite and the distance is right', () => {
  for (const [a, b] of [[P(0, 0, 1), P(0, 179.999, 2)], [P(45, 10, 1), P(-45, -170, 2)], [P(-33.9, 151.2, 1), P(33.9, -28.8, 2)]]) {
    const r = C.evaluateGuess(a, b); assert.ok(Number.isFinite(r.bearing) && r.km > 19900 && r.km <= 20016 && r.pct === 0, JSON.stringify(r));
    assert.ok(Math.abs(r.km - refKm(a, b)) < 0.51);
  }
});

console.log('rendering');
const server = createServer(); await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser; for (const o of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await launchBrowser(o); break; } catch { /* next */ } }
mkdirSync(path('../qa/'), { recursive: true });
const open = async (scheme = 'light', width = 390) => {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } });
  const page = await ctx.newPage(); await page.goto(BASE); await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 });
  return { ctx, page };
};
const start = async (page, id) => { await page.evaluate((i) => window.__ag.debugStart(i), id); await page.waitForFunction(() => { const v = document.querySelector('#veil'); return v.hidden || v.classList.contains('out'); }, null, { timeout: 40000 }); await page.waitForTimeout(500); };
const guess = async (page, q, exact) => { await page.locator('#guess-input').fill(q); await page.waitForSelector('#suggestions li[role=option]'); await page.locator('#suggestions li[role=option]', exact ? { hasText: exact } : undefined).first().click(); await page.locator('#guess-btn').click(); await page.waitForTimeout(1100); };
/** What the user sees: arrow angle from the computed CSS transform, the direction its tip points to, the label and the accessible text, per row. */
const rows = (page) => page.evaluate(() => [...document.querySelectorAll('#guesses li.row')].map((li) => {
  const svg = li.querySelector('.dir svg'); const t = svg ? getComputedStyle(svg).transform : 'none';
  let angle = null, tipBearing = null;
  if (svg && t !== 'none') { const m = new DOMMatrix(t); angle = Math.atan2(m.b, m.a) * 180 / Math.PI; const tip = m.transformPoint(new DOMPoint(0, -8)); tipBearing = (Math.atan2(tip.x, -tip.y) * 180 / Math.PI + 360) % 360; } // the glyph's tip is straight up at 0 deg
  const d = li.querySelector('.dir');
  return { name: li.querySelector('.nm').textContent, km: li.querySelector('.nums b').textContent, label: d.querySelector('span').textContent, role: d.getAttribute('role'), aria: d.getAttribute('aria-label'), angle, tipBearing, hasArrow: !!svg && getComputedStyle(svg).display !== 'none' };
}));
const zrh = byCode('ZRH'), jfk = byCode('JFK'), lhr = byCode('LHR'), sin = byCode('SIN'), syd = byCode('SYD');
for (const scheme of ['light', 'dark']) {
  await test(`${scheme}: every row shows the right arrow, 8-point label and spoken distance; same after reload and after a theme switch; only the newest arrow animates`, async () => {
    const { ctx, page } = await open(scheme);
    const answer = await page.evaluate(() => window.__ag.round.answer); // the real Daily (it survives a reload)
    const pool = [[zrh, 'zurich airport'], [lhr, 'heathrow'], [syd, 'sydney kingsford'], [sin, 'singapore changi'], [jfk, 'john f kennedy']].filter(([g]) => g.id !== answer.id).slice(0, 3);
    for (const g of pool) await guess(page, g[1]);
    const check = async (label) => {
      const rs = await rows(page); assert.equal(rs.length, 3, label);
      const guessesInOrder = pool.map(([g]) => g).reverse(); // newest first
      rs.forEach((r, i) => {
        const g = guessesInOrder[i]; const ev = C.evaluateGuess(g, answer);
        assert.equal(r.hasArrow, true); assert.equal(r.role, 'img');
        assert.ok(angDiff(r.angle, ev.bearing) < 0.2, `${label} row ${i} (${g.iata}): arrow ${r.angle} vs bearing ${ev.bearing}`);
        assert.ok(angDiff(r.tipBearing, ev.bearing) < 0.2, `${label} row ${i}: the glyph's tip points ${r.tipBearing}, answer is at ${ev.bearing}`);
        assert.equal(r.label, ev.dir, `${label} row ${i} label`); assert.ok(angDiff(ev.bearing, C.COMPASS.indexOf(r.label) * 45) <= 22.5);
        assert.equal(r.aria, C.directionPhrase(ev), `${label} row ${i} aria`); assert.match(r.aria, /^About [\d,]+ km to the [a-z-]+$/);
        assert.equal(r.km, ev.km.toLocaleString('en-US') + ' km');
      });
    };
    await check('after three guesses');
    await page.reload(); await page.waitForFunction(() => window.__ag && window.__ag.round && window.__ag.round.results.length === 3, null, { timeout: 40000 }); await page.waitForTimeout(1200);
    await check('after reload');
    await page.locator('#theme-seg button').nth(scheme === 'light' ? 2 : 1).click(); await page.waitForTimeout(1200); await check('after a theme switch');
    await page.screenshot({ path: path(`../qa/direction-rows-${scheme}.png`) });
    await ctx.close();
  });
}
await test('desktop width: the same rows, arrows not accumulating across re-renders (hint, zoom, extra guess keep every angle)', async () => {
  const { ctx, page } = await open('light', 1280);
  await start(page, jfk.id); await guess(page, 'zurich airport'); const first = await rows(page);
  await page.locator('#btn-hint').click(); await page.locator('#sheet [data-hint]').first().click(); await page.locator('#sheet [data-confirm]').click(); await page.waitForTimeout(900);
  await guess(page, 'singapore changi'); const after = await rows(page);
  const old = after.find((r) => r.name === first[0].name); assert.ok(angDiff(old.angle, first[0].angle) < 0.2, `${first[0].angle} -> ${old.angle}`);
  const ev = C.evaluateGuess(sin, jfk); assert.ok(angDiff(after[0].angle, ev.bearing) < 0.2); assert.equal(after[0].label, ev.dir);
  await ctx.close();
});
await test('very close: two different airports at the same spot show "NEAR", a ring instead of an arrow, and the spoken "very close"', async () => {
  const a = byCode('SCMR'), g = byCode('SCGL'); assert.ok(a && g);
  const { ctx, page } = await open('light'); await start(page, a.id);
  await guess(page, g.name.slice(0, 14), g.name);
  const [r] = await rows(page); assert.equal(r.label, 'NEAR'); assert.equal(r.hasArrow, true, 'a glyph (ring) is shown'); assert.equal(r.angle, null, 'the glyph is not rotated');
  assert.match(r.aria, /^Very close, about 1 km away$/); assert.equal(r.km, '1 km');
  await page.screenshot({ path: path('../qa/direction-near.png') }); await ctx.close();
});
await test('the arrow is not colour-only: it comes with a text label and an accessible name, readable in both themes (contrast checked in tests/theme.mjs)', async () => {
  const css = readFileSync(path('../css/style.css'), 'utf8'); assert.match(css, /\.row \.dir span\{/); assert.match(css, /\.row \.dir svg\{[^}]*color:var\(--accent-text\)/);
});
await browser.close(); server.close();
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} direction checks passed`); process.exit(failed ? 1 : 0);
