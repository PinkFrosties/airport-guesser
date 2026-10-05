// Build-time image check: how visible is the runway in the imagery the game will actually show?
//   node scripts/image_contrast.mjs [--limit N] [--ids 1,2,3] [--refresh]
// For every airport in data/*.json it downloads the (few) Esri tiles that cover the runways at the airport's display
// zoom (+1 level), samples the pixels along each open runway's centre line and next to it, and writes
//   scripts/.cache/contrast.json  { id: score }       score = median |centre - sides| brightness along the best runway (0..255)
// scripts/build_data.py then drops Hard airports below CONTRAST_MIN (see there). Results are cached; --refresh redoes all.
// Uses Playwright only as a JPEG decoder (canvas) and fetches the same public tiles the app uses, 8 at a time.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CACHE = path('./.cache/contrast.json');
mkdirSync(dirname(CACHE), { recursive: true });
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const limit = Number(opt('--limit')) || Infinity;
const onlyIds = opt('--ids') ? new Set(opt('--ids').split(',').map(Number)) : null;
const refresh = args.includes('--refresh');

const rd = (f) => JSON.parse(readFileSync(path('../data/' + f), 'utf8')).airports;
const airports = [...rd('airports.json'), ...rd('airports-hard.json')];

function csv(txt) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  const h = rows.shift();
  return rows.filter((r) => r.length === h.length).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
const runways = new Map();
for (const r of csv(readFileSync(path('./.cache/runways.csv'), 'utf8'))) {
  if (r.closed === '1') continue;
  const a = [r.le_latitude_deg, r.le_longitude_deg, r.he_latitude_deg, r.he_longitude_deg];
  const id = +r.airport_ref;
  const len = Number(r.length_ft) || 0;
  const list = runways.get(id) || runways.set(id, []).get(id);
  if (a.every((v) => v !== '' && Number.isFinite(Number(v)))) list.push({ a: a.map(Number), w: Number(r.width_ft) || 100, len });
  else if (len > 0) { // no end coordinates: the build assumes the runway is centred on the airport reference point; its heading may be known
    const h = Number(r.le_heading_degT), ident = parseInt(r.le_ident, 10);
    list.push({ a: null, w: Number(r.width_ft) || 100, len, head: r.le_heading_degT !== '' && Number.isFinite(h) ? h : Number.isFinite(ident) ? ident * 10 : null });
  }
}

const cache = !refresh && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const todo = airports.filter((a) => (onlyIds ? onlyIds.has(a.id) : cache[a.id] === undefined)).slice(0, limit);
console.log(`${airports.length} airports, ${todo.length} to score`);

let browser; for (const o of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(o); break; } catch { /* next */ } }
const page = await browser.newPage();
await page.goto('about:blank');
await page.evaluate(() => {
  const worldPx = (lat, lon, L) => { const n = 256 * 2 ** L; const s = Math.sin((lat * Math.PI) / 180); return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n]; };
  const tileUrl = (s, L, x, y) => `https://${s}.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${L}/${y}/${x}`;
  window.score = async (a, rws) => {
    const L = Math.min(a.nz, a.z + 1);
    const mpp0 = (156543.03392 * Math.cos((a.lat * Math.PI) / 180)) / 2 ** L; // metres per pixel
    const [cx0, cy0] = worldPx(a.lat, a.lon, L);
    const lines = [];
    for (const r of rws) {
      if (r.a) { lines.push([worldPx(r.a[0], r.a[1], L), worldPx(r.a[2], r.a[3], L), r.w]); continue; }
      // unknown position: search the reference point's neighbourhood (best line wins), heading known or any of 18
      const lp = (r.len * 0.3048) / mpp0, heads = r.head === null ? Array.from({ length: 18 }, (_, i) => i * 10) : [r.head];
      for (const h of heads) {
        const ux = Math.sin((h * Math.PI) / 180), uy = -Math.cos((h * Math.PI) / 180), nx = -uy, ny = ux;
        for (let s = -1; s <= 1; s++) for (let o = -0.15; o <= 0.151; o += 0.05) {
          const mx = cx0 + ux * s * lp * 0.1 + nx * o * lp, my = cy0 + uy * s * lp * 0.1 + ny * o * lp;
          lines.push([[mx - (ux * lp) / 2, my - (uy * lp) / 2], [mx + (ux * lp) / 2, my + (uy * lp) / 2], r.w]);
        }
      }
    }
    let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    for (const [p, q] of lines) for (const [x, y] of [p, q]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 24; x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad); x1 = Math.ceil(x1 + pad); y1 = Math.ceil(y1 + pad);
    const tx0 = Math.floor(x0 / 256), tx1 = Math.floor(x1 / 256), ty0 = Math.floor(y0 / 256), ty1 = Math.floor(y1 / 256);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 16) return { err: 'too many tiles' };
    const W = x1 - x0, H = y1 - y0; const cv = new OffscreenCanvas(W, H); const cx = cv.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push((async () => {
        for (let k = 0; k < 3; k++) {
          try { const r = await fetch(tileUrl(k % 2 ? 'server' : 'services', L, tx, ty), { mode: 'cors' }); if (!r.ok) continue; const bm = await createImageBitmap(await r.blob()); cx.drawImage(bm, tx * 256 - x0, ty * 256 - y0); return true; } catch { /* retry */ }
        }
        return false;
      })());
    }
    const okAll = (await Promise.all(jobs)).every(Boolean);
    if (!okAll) return { err: 'tile fetch failed' };
    const d = cx.getImageData(0, 0, W, H).data;
    const lum = (x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= W || y >= H) return null; const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    const box = (x, y) => { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = lum(x + dx, y + dy); if (v !== null) { s += v; n++; } } return n ? s / n : null; };
    const mpp = (156543.03392 * Math.cos((a.lat * Math.PI) / 180)) / 2 ** L; // metres per pixel
    let best = 0, bestRw = null;
    for (const [[px, py], [qx, qy], wft] of lines) {
      const len = Math.hypot(qx - px, qy - py); if (len < 12) continue;
      const ux = (qx - px) / len, uy = (qy - py) / len, nx = -uy, ny = ux;
      const wpx = Math.max(3, (wft * 0.3048) / mpp);
      const off = wpx / 2 + Math.max(3, wpx * 0.6);
      const diffs = [];
      for (let t = len * 0.12; t < len * 0.88; t += 1) {
        const x = px + ux * t - x0, y = py + uy * t - y0;
        const c = box(x, y), l = box(x + nx * off, y + ny * off), r = box(x - nx * off, y - ny * off);
        if (c === null || l === null || r === null) continue;
        diffs.push(Math.abs(c - (l + r) / 2));
      }
      if (diffs.length < 8) continue;
      diffs.sort((p, q) => p - q);
      const med = diffs[Math.floor(diffs.length / 2)];
      if (med > best) { best = med; bestRw = { len: Math.round(len * mpp), wpx: +wpx.toFixed(1) }; }
    }
    return { score: +best.toFixed(1), rw: bestRw, L };
  };
});

const errors = {};
let done = 0;
const t0 = Date.now();
const queue = [...todo];
async function worker() {
  while (queue.length) {
    const a = queue.shift();
    const rws = runways.get(a.id);
    let res;
    if (!rws || !rws.length) res = { score: null, note: 'no runway coordinates' };
    else { try { res = await page.evaluate(([x, r]) => window.score(x, r), [a, rws]); } catch (e) { res = { err: String(e.message).slice(0, 80) }; } }
    if (res && res.err) errors[a.id] = res.err; else cache[a.id] = res.score === null ? -1 : res.score;
    if (onlyIds) console.log(a.iata || a.icao, a.name, JSON.stringify(res));
    if (++done % 500 === 0) { writeFileSync(CACHE, JSON.stringify(cache)); console.log(`${done}/${todo.length} (${Math.round((Date.now() - t0) / 1000)} s)`); }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
writeFileSync(CACHE, JSON.stringify(cache));
console.log(`scored ${done}; errors ${Object.keys(errors).length}`, Object.keys(errors).length ? JSON.stringify(Object.entries(errors).slice(0, 5)) : '');
await browser.close();
