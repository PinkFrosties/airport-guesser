// Compare +1 and +2 extra tile levels at devicePixelRatio 3: tiles requested, KB, and a sharpness score of the frame.
// Run: node tests/quality-compare.mjs   (writes qa/quality-<airport>-n1.png / -n2.png and prints a table)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';

const QA = new URL('../qa/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(QA, { recursive: true });
const AIRPORTS = { Atlanta: 3384, 'General Dewitt Spain': 20403, Duqm: 299738 };
const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const tiles = [];
page.on('response', (r) => { if (/World_Imagery\/MapServer\/tile\//.test(r.url())) tiles.push(r); });
await page.goto(BASE);
await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 60000 });
if (await page.locator('#dlg-help[open]').count()) await page.keyboard.press('Escape');

// Laplacian variance of the luminance of an image (higher = more fine detail / sharper), computed in the browser
const scorer = await ctx.newPage();
await scorer.setContent('<canvas id=c></canvas>');
async function sharpness(buf) {
  return scorer.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.getElementById('c'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, img.width, img.height);
    const L = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) L[i] = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2];
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const v = 4 * L[y * width + x] - L[y * width + x - 1] - L[y * width + x + 1] - L[(y - 1) * width + x] - L[(y + 1) * width + x];
      sum += v; sum2 += v * v; n++;
    }
    const mean = sum / n; return sum2 / n - mean * mean;
  }, buf.toString('base64'));
}

const rows = [];
for (const [name, id] of Object.entries(AIRPORTS)) {
  const row = { airport: name };
  for (const n of [1, 2]) {
    await page.evaluate((v) => { window.__ag.retinaOverride = v; }, n);
    await page.evaluate(() => window.__ag.debugStart(21)); // different airport so the next load is a real reload of this view
    await page.waitForTimeout(300);
    tiles.length = 0;
    await page.evaluate((i) => window.__ag.debugStart(i), id);
    await page.waitForFunction((i) => window.__ag.round.answer.id === i && (document.querySelector('#veil').hidden || document.querySelector('#veil').classList.contains('out')), id);
    await page.waitForTimeout(700);
    const shot = await page.locator('#stage').screenshot({ path: QA + `quality-${name.replace(/\W+/g, '')}-n${n}.png` });
    let bytes = 0; for (const t of tiles) { try { bytes += (await t.body()).length; } catch { /* */ } }
    row[`n${n}`] = { tiles: tiles.length, kb: Math.round(bytes / 1024), sharpness: Math.round(await sharpness(shot)) };
  }
  rows.push(row);
}
console.table(rows.map((r) => ({ airport: r.airport, '+1 tiles': r.n1.tiles, '+1 KB': r.n1.kb, '+1 sharp': r.n1.sharpness, '+2 tiles': r.n2.tiles, '+2 KB': r.n2.kb, '+2 sharp': r.n2.sharpness, 'sharp ratio +1/+2': (r.n1.sharpness / r.n2.sharpness).toFixed(2) })));
writeFileSync(QA + 'quality-compare.json', JSON.stringify(rows, null, 2));
await browser.close();
server.close();
