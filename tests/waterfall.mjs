// Cold/warm Daily load waterfall on a throttled phone. Run: node tests/waterfall.mjs [label] [baseUrl]
//   390px wide, devicePixelRatio 3, fresh profile. Fast 4G = 9 Mbit/s down, 1.5 up, 170 ms RTT.
//   Slow 4G = 1.6 Mbit/s down, 0.75 up, 150 ms RTT. (CDP page-level throttling does not slow service-worker fetches,
//   so cold runs block the service worker; warm runs allow it and only show what comes from its caches.)
// Writes qa/perf/waterfall-<label>.json and prints the tables. With a baseUrl it measures that site instead of the local one.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';

const label = process.argv[2] || 'run';
const remote = process.argv[3] || null;
const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(path('../qa/perf/'), { recursive: true });
const PROFILES = {
  'Fast 4G': { offline: false, latency: 170, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 },
  'Slow 4G': { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (0.75 * 1024 * 1024) / 8 },
};
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
let server = null;
let BASE = remote;
if (!BASE) { server = createServer(); await new Promise((r) => server.listen(0, r)); BASE = `http://localhost:${server.address().port}/`; }
let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }

const short = (u) => u.replace(BASE, '/').replace(/^https:\/\/([a-z.]+arcgisonline\.com)\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\//, '$1 tile ');
const kb = (n) => (n == null ? '-' : (n / 1024).toFixed(1));

async function run(profileName, { warm = false } = {}) {
  const ctx = await browser.newContext({ ...PHONE, serviceWorkers: warm ? 'allow' : 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* blocked */ } }); // the first-run help dialog opens after the first image; tests do not want it
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }); // a fresh context starts with an empty cache anyway
  if (warm) { // first visit unthrottled to fill the HTTP cache and the service worker caches, then wait for the SW
    await page.goto(BASE);
    await page.waitForFunction(() => performance.getEntriesByName('ag:revealed').length > 0, null, { timeout: 120000 });
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForTimeout(4000);
    await page.reload(); await page.waitForTimeout(2500);
  }
  const req = new Map();
  let t0 = null;
  cdp.on('Network.requestWillBeSent', (e) => { if (t0 === null) t0 = e.timestamp; req.set(e.requestId, { url: e.request.url, start: (e.timestamp - t0) * 1000, type: e.type, initiator: e.initiator.type }); });
  cdp.on('Network.responseReceived', (e) => { const r = req.get(e.requestId); if (r) { r.protocol = e.response.protocol; r.status = e.response.status; r.encoding = e.response.headers['content-encoding'] || e.response.headers['Content-Encoding'] || ''; r.raw = Number(e.response.headers['content-length'] || e.response.headers['Content-Length'] || 0); r.fromSW = e.response.fromServiceWorker; r.fromCache = e.response.fromDiskCache || e.response.fromPrefetchCache; r.ttfb = (e.timestamp - t0) * 1000; } });
  cdp.on('Network.loadingFinished', (e) => { const r = req.get(e.requestId); if (r) { r.end = (e.timestamp - t0) * 1000; r.wire = e.encodedDataLength; } });
  cdp.on('Network.loadingFailed', (e) => { const r = req.get(e.requestId); if (r) { r.end = (e.timestamp - t0) * 1000; r.failed = e.errorText; } });
  await cdp.send('Network.emulateNetworkConditions', PROFILES[profileName]);
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForFunction(() => performance.getEntriesByName('ag:revealed').length > 0, null, { timeout: 180000, polling: 50 });
  await page.waitForTimeout(warm ? 1500 : 3500); // background requests after the reveal
  const marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('ag:')).map((m) => [m.name, Math.round(m.startTime)])));
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { responseStart: Math.round(n.responseStart), domContentLoaded: Math.round(n.domContentLoadedEventEnd) }; });
  const rows = [...req.values()].sort((a, b) => a.start - b.start);
  const firstTile = rows.find((r) => /World_Imagery/.test(r.url));
  const revealed = marks['ag:revealed'];
  const before = rows.filter((r) => r.end !== undefined && r.end <= revealed);
  const sum = (arr, f) => arr.reduce((s, r) => s + (f(r) || 0), 0);
  const result = {
    profile: profileName, mode: warm ? 'warm' : 'cold',
    milestones: { htmlResponse: nav.responseStart, dataParsed: marks['ag:data-parsed'] ?? null, airportKnown: marks['ag:airport-known'] ?? null, firstTileRequest: firstTile ? Math.round(firstTile.start) : null, revealed },
    requests: rows.length, requestsBeforeReveal: before.length,
    wireKBBeforeReveal: +kb(sum(before, (r) => r.wire)), rawKBBeforeReveal: +kb(sum(before, (r) => r.raw || r.wire)),
    totalWireKB: +kb(sum(rows, (r) => r.wire)),
    waterfall: rows.map((r) => ({ start: Math.round(r.start), end: r.end === undefined ? null : Math.round(r.end), wireKB: +kb(r.wire), rawKB: +kb(r.raw || null) || null, enc: r.encoding || '', proto: r.protocol || '', sw: !!r.fromSW, url: short(r.url), initiator: r.initiator })),
  };
  await ctx.close();
  return result;
}

const out = { label, base: BASE, runs: [] };
for (const p of Object.keys(PROFILES)) {
  for (const warm of [false, true]) {
    const r = await run(p, { warm });
    out.runs.push(r);
    console.log(`\n=== ${r.profile} ${r.mode} ===`);
    console.log(`milestones (ms from navigation start): html ${r.milestones.htmlResponse} | data parsed ${r.milestones.dataParsed} | airport known ${r.milestones.airportKnown} | first tile request ${r.milestones.firstTileRequest} | IMAGE REVEALED ${r.milestones.revealed}`);
    console.log(`requests: ${r.requests} (${r.requestsBeforeReveal} before reveal), wire KB before reveal ${r.wireKBBeforeReveal} (raw ${r.rawKBBeforeReveal}), total wire KB ${r.totalWireKB}`);
    if (!warm) console.table(r.waterfall.filter((w) => !/tile /.test(w.url)).map((w) => ({ start: w.start, end: w.end, 'wire KB': w.wireKB, 'raw KB': w.rawKB, enc: w.enc, proto: w.proto, url: w.url.slice(0, 60) })));
    if (!warm) console.log(`tile requests: ${r.waterfall.filter((w) => /tile /.test(w.url)).length}, first at ${r.milestones.firstTileRequest} ms`);
  }
}
writeFileSync(path(`../qa/perf/waterfall-${label}.json`), JSON.stringify(out, null, 1));
await browser.close();
if (server) server.close();
