// Text scaling: the app follows the browser's default font size (rem) and still fits at 150% / 200% on narrow screens.
// The overlays on the satellite image (chips, attribution) deliberately stay in px: the airfield fit is measured against them.
// Run: node tests/textscale.mjs   (AG_ROOT=dist for the built site)
import { launchBrowser } from './browser.mjs';
import assert from 'node:assert/strict';
import { createServer } from '../scripts/serve.mjs';
const server = createServer(); await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser; for (const o of [{ channel: "msedge" }, { channel: "chrome" }, {}]) { try { browser = await launchBrowser(o); break; } catch { /* next */ } }
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split('\n').slice(0, 4).join('\n       ')}`); } };

const probe = (page) => page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.closest('[hidden]') && !e.closest('dialog:not([open])'); };
  const clipped = [...document.querySelectorAll('button, .chip, .row .nm, .hints-used li, .eyebrow, h1, h2, label, .wiki, #left')].filter(vis)
    .filter((e) => !e.closest('.sat') && getComputedStyle(e).overflow !== 'hidden' ? false : (e.scrollWidth > e.clientWidth + 1 && !/ellipsis/.test(getComputedStyle(e).textOverflow) && getComputedStyle(e).overflow === 'hidden'))
    .map((e) => (e.id || e.className || e.tagName) + ':' + e.textContent.trim().slice(0, 20));
  const wide = [...document.querySelectorAll('body *')].filter(vis).filter((e) => !e.closest('.sat, dialog, #suggestions') && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
    .map((e) => (e.id || e.className || e.tagName).toString().slice(0, 30) + ' right=' + Math.round(e.getBoundingClientRect().right));
  return { overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, clipped, wide: wide.slice(0, 5), fs: getComputedStyle(document.querySelector('#guess-input')).fontSize };
});
async function session(width, rootPct, fn) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } });
  const page = await ctx.newPage(); await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 });
  await page.addStyleTag({ content: `html{font-size:${rootPct}% !important}` }); await page.waitForTimeout(500);
  try { await fn(page); } finally { await ctx.close(); }
}
const guess = async (page, q) => { await page.locator('#guess-input').fill(q); await page.waitForSelector('#suggestions li[role=option]'); await page.locator('#suggestions li[role=option]').first().click(); await page.locator('#guess-btn').click(); await page.waitForTimeout(250); };

await test('type follows the root font size (rem): 200% root = 2x input text', async () => {
  let a, b;
  await session(390, 100, async (p) => { a = parseFloat((await probe(p)).fs); });
  await session(390, 200, async (p) => { b = parseFloat((await probe(p)).fs); });
  assert.ok(Math.abs(b / a - 2) < 0.01, `${a}px -> ${b}px`);
});
for (const [w, pct] of [[390, 100], [390, 150], [390, 200], [320, 200], [320, 150]]) {
  await test(`${w}px wide at ${pct}% text: no horizontal overflow or clipped controls (play, result with a long name, all dialogs)`, async () => {
    await session(w, pct, async (page) => {
      const check = async (label) => { const r = await probe(page); assert.equal(r.overflowX, 0, `${label}: horizontal overflow ${r.overflowX}px ${r.wide}`); assert.deepEqual(r.clipped, [], `${label}: clipped`); assert.deepEqual(r.wide, [], `${label}: element beyond the right edge`); };
      await check('start');
      const longest = await page.evaluate(async () => { const h = await fetch('data/airports-hard.json').then((r) => r.json()); return h.airports.reduce((m, a) => (a.name.length > m.name.length ? a : m)); });
      await page.evaluate((id) => window.__ag.debugStart(id), longest.id); await page.waitForTimeout(1500);
      await guess(page, 'JFK'); await check('after a guess');
      for (const q of ['LHR', 'SIN', 'DXB', 'AMS']) { if (await page.locator('#result:not([hidden])').count()) break; await guess(page, q); }
      await page.waitForSelector('#result:not([hidden])'); await page.waitForTimeout(500); await check('result');
      for (const [btn, dlg] of [['#btn-help', '#dlg-help'], ['#btn-about', '#dlg-about'], ['#btn-stats', '#dlg-stats']]) {
        await page.locator(btn).click(); await page.waitForTimeout(700);
        const r = await page.evaluate((d) => { const e = document.querySelector(d); const b = e.querySelector('.dlg-head button, button.link'); const br = b.getBoundingClientRect(); return { sw: e.scrollWidth - e.clientWidth, doneVisible: br.right <= innerWidth && br.left >= 0 && br.width > 0 }; }, dlg);
        assert.equal(r.sw, 0, `${dlg} scrolls sideways`); assert.ok(r.doneVisible, `${dlg} close button reachable`);
        await page.keyboard.press('Escape'); await page.waitForTimeout(250);
      }
    });
  });
}
await browser.close(); server.close();
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} text-scale checks passed`); process.exit(failed ? 1 : 0);
