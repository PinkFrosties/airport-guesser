// Zoom-fit verification on real renders: fill %, runway endpoints vs the frame edges (>= 6% margin), chips and attribution pill.
// Run: node tests/zoomfit.mjs      (needs network for Esri tiles; writes qa/zoomfit-*.png and qa/zoomfit-report.json)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';
import * as C from '../js/core.js';

const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const QA = path('../qa/');
mkdirSync(QA, { recursive: true });
const data = (f) => JSON.parse(readFileSync(path('../data/' + f), 'utf8')).airports;
const main = data('airports.json');
const byIata = (i) => main.find((a) => a.iata === i);
const top = main.filter((a) => a.top).sort((a, b) => a.top - b.top);

// 6 reproducible "random" Top 50 airports
const rnd = C.mulberry32(C.hashSeed('zoomfit-qa'));
const pool = [...top];
const random6 = [];
while (random6.length < 6) random6.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);

const CASES = [
  ['SZX Shenzhen (southern China, diagonal runways)', byIata('SZX').id], ['KMG Kunming (southern China, diagonal runways)', byIata('KMG').id],
  ['ATL Atlanta', 3384], ['DQM Duqm (remote desert)', 299738], ['Small regional airfield (General Dewitt Spain)', 20403],
  ...random6.map((a) => [`#${a.top} ${a.iata} ${a.name}`, a.id]),
];

const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }

const PROFILES = [['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true }], ['desktop', { viewport: { width: 1280, height: 800 } }]];
const report = [];
const problems = [];
for (const [pname, profile] of PROFILES) {
  const ctx = await browser.newContext({ ...profile, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* blocked */ } }); // the first-run help dialog opens after the first image; tests do not want it
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag, null, { timeout: 30000 });
  if (await page.locator('#dlg-help[open]').count()) await page.keyboard.press('Escape');
  await page.evaluate(() => window.__ag.debugStart(21)); // loads the Hard data
  await page.waitForFunction(() => window.__ag.round && document.querySelector('#veil').hidden, null, { timeout: 60000 });
  for (const [label, id] of CASES) {
    await page.evaluate((i) => window.__ag.debugStart(i), id);
    await page.waitForFunction((i) => window.__ag.round.answer.id === i && (document.querySelector('#veil').hidden || document.querySelector('#veil').classList.contains('out')) && document.querySelectorAll('.sat.front img.leaflet-tile-loaded').length > 0, id, { timeout: 60000 });
    await page.waitForTimeout(600);
    const g = await page.evaluate(() => {
      const gm = window.__ag, m = gm.map, a = gm.round.answer;
      const stage = document.querySelector('#stage').getBoundingClientRect();
      const rel = (r) => ({ l: r.left - stage.left, r: r.right - stage.left, t: r.top - stage.top, b: r.bottom - stage.top });
      const [clat, clon, w, h] = a.view;
      const dLat = h / 2 / 110574, dLon = w / 2 / (111320 * Math.cos((clat * Math.PI) / 180));
      const sw = m.latLngToContainerPoint([clat - dLat, clon - dLon]), ne = m.latLngToContainerPoint([clat + dLat, clon + dLon]);
      return {
        W: stage.width, H: stage.height, zoom: m.getZoom(), nz: a.nz, retina: gm.views.main.retinaLevels, iata: a.iata || a.icao,
        box: { l: Math.min(sw.x, ne.x), r: Math.max(sw.x, ne.x), t: Math.min(sw.y, ne.y), b: Math.max(sw.y, ne.y) },
        pill: rel(document.querySelector('.sat.front .leaflet-control-attribution').getBoundingClientRect()),
        chips: [...document.querySelectorAll('.hud .chip')].map((c) => rel(c.getBoundingClientRect())),
      };
    });
    const a = main.find((x) => x.id === id) || null;
    const { box, W, H } = g;
    const fill = Math.max((box.r - box.l) / W, (box.b - box.t) / H);
    const edge = { left: box.l / W, right: (W - box.r) / W, top: box.t / H, bottom: (H - box.b) / H };
    const hit = (r) => box.l < r.r && box.r > r.l && box.t < r.b && box.b > r.t;
    const flags = [];
    for (const [k, v] of Object.entries(edge)) if (v < 0.06 - 0.004) flags.push(`endpoint ${(v * 100).toFixed(1)}% from the ${k} edge`);
    if (hit(g.pill)) flags.push('attribution pill overlaps the airfield');
    g.chips.forEach((c, i) => { if (hit(c)) flags.push('chip ' + i + ' overlaps the airfield'); });
    if (fill > 0.785) flags.push('fill ' + Math.round(fill * 100) + '% above the 78% maximum');
    await page.locator('#stage').screenshot({ path: QA + `zoomfit-${pname}-${label.split(' ')[0].replace('#', 'top')}-${g.iata}.png` });
    const row = { device: pname, airport: label, frame: `${Math.round(W)}x${Math.round(H)}`, zoom: g.zoom, nz: g.nz, fillPct: Math.round(fill * 100), minEdgePct: Math.round(Math.min(...Object.values(edge)) * 1000) / 10, flags };
    report.push(row);
    if (flags.length) problems.push(`${pname} ${label}: ${flags.join('; ')}`);
  }
  await ctx.close();
}
await browser.close();
server.close();

console.table(report.map((r) => ({ device: r.device, airport: r.airport.slice(0, 44), frame: r.frame, zoom: r.zoom, 'fill %': r.fillPct, 'min edge %': r.minEdgePct, flags: r.flags.length ? r.flags.join('; ') : '' })));
writeFileSync(QA + 'zoomfit-report.json', JSON.stringify(report, null, 2));
// Desktop shows the SAME zoom as the phone (one zoom per airport for everyone), so its fill is lower by design: only the
// edge rules are asserted there. On the phone every rule applies.
const phoneProblems = problems.filter((p) => p.startsWith('phone'));
const desktopProblems = problems.filter((p) => p.startsWith('desktop'));
console.log(phoneProblems.length ? 'PHONE PROBLEMS:\n' + phoneProblems.join('\n') : 'phone: no endpoint within 6% of an edge, nothing under the chips or the pill, fill <= 78% for all ' + CASES.length + ' airports');
console.log(desktopProblems.length ? 'DESKTOP PROBLEMS:\n' + desktopProblems.join('\n') : 'desktop: same checks clean');
assert.equal(phoneProblems.length + desktopProblems.length, 0);
const zooms = new Map(CASES.map(([l, id]) => [l, report.filter((r) => r.airport === l).map((r) => r.zoom)]));
for (const [l, z] of zooms) assert.equal(new Set(z).size, 1, 'same zoom on phone and desktop for ' + l);
console.log('same zoom on phone and desktop for every airport: yes');
