// The third hint is never missing (v1.4.2): in every mode (Daily, Hard, Practice Major hubs / Large / Mid-size) the hint menu shows three
// enabled items on a fresh game, the third one is a real clue (never "Not available"), and a service worker cache left by an older version
// (data without hint3, old tier meaning) cannot hand the new page old data.
// Run: node tests/thirdhint.mjs   (AG_ROOT=dist for the built site, AG_BROWSER=webkit; N=6 airports per mode, set N=10 for the full matrix)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './browser.mjs';
import { createServer } from '../scripts/serve.mjs';
const N = Number(process.env.N || 6);
const server = createServer(); await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser; for (const o of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await launchBrowser(o); break; } catch { /* next */ } }
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split('\n').slice(0, 5).join('\n       ')}`); } };

const modes = [
  ['Daily', { mode: 'daily', hard: false }, true],
  ['Hard', { mode: 'daily', hard: true }, true],
  ['Practice Major hubs', { mode: 'practice', diff: 'easy', hard: false }],
  ['Practice Large', { mode: 'practice', diff: 'medium', hard: false }],
  ['Practice Mid-size', { mode: 'practice', diff: 'hard', hard: false }],
];
const ready = async (page) => {
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 60000 });
  await page.waitForFunction(() => { const v = document.querySelector('#veil'); return v.hidden || v.classList.contains('out'); }, null, { timeout: 60000 });
  await page.waitForTimeout(300);
};
const menu = async (page) => {
  await page.locator('#btn-hint').click(); await page.waitForSelector('#sheet .opt');
  return page.evaluate(() => ({
    answer: (({ iata, icao, tier, hint3 }) => ({ code: iata || icao, tier, hint3 }))(window.__ag.round.answer),
    opts: [...document.querySelectorAll('#sheet .opt')].map((o) => ({ text: o.childNodes[0].textContent.trim(), small: o.querySelector('small').textContent.trim(), disabled: o.disabled })),
    intro: (document.querySelector('#sheet p, #sheet .sheet-note') || {}).textContent || '',
    sheet: document.querySelector('#sheet').textContent,
  }));
};

for (const [label, prefs, dated] of modes) {
  await test(`${label}: ${N} airports, each shows an enabled third clue (never "Not available")`, async () => {
    for (let i = 0; i < N; i++) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      await ctx.addInitScript(([p]) => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); localStorage.setItem('airportGuesser.prefs.v2', JSON.stringify(p)); } catch { /* */ } }, [prefs]);
      const page = await ctx.newPage(); const errs = [];
      page.on('console', (m) => { if (m.type() === 'error' && !/arcgisonline|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 160)); });
      if (dated) await page.clock.setFixedTime(new Date(2026, 10, 1 + i * 3, 12, 0, 0));
      await page.goto(BASE); await ready(page);
      const m = await menu(page);
      assert.equal(m.opts.length, 3, `${m.answer.code}: three hint items, got ${m.opts.map((o) => o.text).join(' / ')}`);
      const third = m.opts[2];
      assert.ok(m.answer.hint3, `${m.answer.code} has hint3`);
      assert.ok(!third.disabled && !/not available/i.test(third.text + third.small), `${m.answer.code}: third item "${third.text} | ${third.small}"`);
      assert.ok(!/not available/i.test(m.sheet), 'no "Not available" anywhere in the menu');
      const airline = /^(airline|airlinec)\|/.test(m.answer.hint3);
      assert.equal(/main airline costs 2/i.test(m.sheet), airline, `${m.answer.code}: the "main airline costs 2" sentence appears only with an airline clue`);
      assert.deepEqual(errs, [], `${m.answer.code}: console errors`);
      await ctx.close();
    }
  });
}

await test('Practice Large: every airport offers an airline clue (sampled)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); localStorage.setItem('airportGuesser.prefs.v2', JSON.stringify({ mode: 'practice', diff: 'medium', hard: false })); } catch { /* */ } });
  const page = await ctx.newPage(); await page.goto(BASE); await ready(page);
  const m = await menu(page);
  assert.ok(/^(airline|airlinec)\|/.test(m.answer.hint3), m.answer.code + ' ' + m.answer.hint3);
  assert.match(m.opts[2].text, /airline/i);
  await ctx.close();
});

await test('a service worker cache from an older version (data without hint3, old schema) is not used by the new page', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); localStorage.setItem('airportGuesser.prefs.v2', JSON.stringify({ mode: 'practice', diff: 'medium', hard: false })); } catch { /* */ } });
  const page = await ctx.newPage(); const msgs = [];
  page.on('console', (m) => { if (['warning', 'error'].includes(m.type())) msgs.push(m.text()); });
  await page.goto(BASE); await ready(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // an "old" cache: the plain data URLs hold the pre-v1.3.3 shape (no hint3, no schema marker); the newest-but-one cache is kept by the worker
  const root = process.env.AG_ROOT || '.';
  const full = JSON.parse(readFileSync(new URL(`../${root === 'dist' ? 'dist' : '.'}/data/airports.json`, import.meta.url), 'utf8'));
  const old = { meta: { ourairports_retrieved: '2026-01-01' }, airports: full.airports.map(({ hint3, ...a }) => ({ ...a, tier: a.tier === 1 ? 1 : 2 })) };
  await page.evaluate(async (body) => {
    const c = await caches.open('airport-guesser-v0.0.1'); const r = () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    for (const u of ['data/airports.json', 'data/airports-hard.json']) await c.put(new URL(u, location.href).href, r());
    for (const k of await caches.keys()) if (/^airport-guesser-v\d/.test(k) && k !== 'airport-guesser-v0.0.1') { const cur = await caches.open(k); for (const u of ['data/airports.json', 'data/airports-hard.json']) await cur.delete(new URL(u, location.href).href); }
  }, old);
  await page.reload(); await ready(page);
  const m = await menu(page);
  assert.ok(m.answer.hint3, 'the answer has hint3 although an older cache held data without it: ' + JSON.stringify(m.answer));
  assert.equal(m.opts.length, 3); assert.ok(!m.opts[2].disabled);
  await ctx.close();
});

await browser.close(); server.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
