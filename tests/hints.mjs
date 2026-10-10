// Hints: exactly three (country, first letter, third clue); each costs 1 attempt; no double spend; last-attempt rule; reload keeps them;
// nothing about any clue is in the page before it is bought; older saved games keep their spent attempts.
// Run: node tests/hints.mjs   (AG_ROOT=dist for the built site, AG_BROWSER=webkit)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../js/core.js';
import { launchBrowser } from './browser.mjs';
import { createServer } from '../scripts/serve.mjs';
const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const rd = (f) => JSON.parse(readFileSync(path('../data/' + f), 'utf8')).airports;
const all = [...rd('airports.json'), ...rd('airports-hard.json')];
const ofType = (t) => all.filter((a) => C.hint3Of(a)?.type === t);
const server = createServer(); await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser; for (const o of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await launchBrowser(o); break; } catch { /* next */ } }
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split('\n').slice(0, 5).join('\n       ')}`); } };

const open = async (storage) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript((s) => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); if (s && !sessionStorage.getItem('seeded')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } } catch { /* */ } }, storage || null);
  const page = await ctx.newPage(); await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 });
  await page.waitForFunction(() => { const v = document.querySelector('#veil'); return v.hidden || v.classList.contains('out'); }, null, { timeout: 40000 });
  await page.waitForTimeout(400);
  return { ctx, page };
};
const start = async (page, id) => { await page.evaluate((i) => window.__ag.debugStart(i), id); await page.waitForTimeout(1200); };
const spent = (page) => page.evaluate(() => { const r = window.__ag.round; return r.results.length + r.hints.length + (r.zoomed ? 1 : 0); });
const buy = async (page, key) => { await page.locator('#btn-hint').click(); await page.locator(`#sheet [data-hint=${key}]`).click(); await page.locator('#sheet [data-confirm]').click(); await page.waitForTimeout(250); };
const guess = async (page, q) => { await page.locator('#guess-input').fill(q); await page.waitForSelector('#suggestions li[role=option]'); await page.locator('#suggestions li[role=option]').first().click(); await page.locator('#guess-btn').click(); await page.waitForTimeout(300); };
/** All the text, attribute values and accessible names of the page outside <script>/<style> and closed dialogs. */
const pageText = (page) => page.evaluate(() => {
  const c = document.documentElement.cloneNode(true); c.querySelectorAll('script,style,dialog').forEach((n) => n.remove());
  const attrs = []; c.querySelectorAll('*').forEach((e) => { for (const n of e.getAttributeNames()) attrs.push(e.getAttribute(n)); });
  return (c.querySelector('body').textContent + ' ' + attrs.join(' ')).replace(/\s+/g, ' ');
});

for (const type of ['airline', 'region', 'grid', 'elev']) {
  await test(`${type} clue: menu names the kind only, nothing of any clue is in the page before it is bought, the chip shows it afterwards`, async () => {
    const a = ofType(type).find((x) => x.name.length < 30 && x.iata) || ofType(type)[0];
    const { ctx, page } = await open(); await start(page, a.id);
    const info = C.hintInfo('extra', a), h = C.hint3Of(a);
    const before = await pageText(page);
    for (const secret of [h.v, a.country, `Name starts with`, C.firstChar(a.name) === 'A' ? null : `starts with ${C.firstChar(a.name)}`]) if (secret) assert.ok(!before.includes(secret), `before any hint, the page contains "${secret}"`);
    for (const word of [a.name, a.iata, a.icao]) assert.ok(!before.includes(word), `the answer ${word} is in the page`);
    await page.locator('#btn-hint').click();
    const menu = await page.locator('#sheet').innerText(); const menuAttrs = await page.locator('#sheet').evaluate((e) => [...e.querySelectorAll('*')].flatMap((x) => x.getAttributeNames().map((n) => x.getAttribute(n))).join(' '));
    assert.ok(menu.includes(info.menu), `menu has "${info.menu}"`);
    for (const secret of [h.v, a.country]) assert.ok(!menu.includes(secret) && !menuAttrs.includes(secret), `the open menu leaks "${secret}"`);
    await page.locator('#sheet [data-hint=extra]').click();
    const confirmText = await page.locator('#sheet').innerText(); assert.ok(confirmText.toLowerCase().includes(`reveal: ${info.menu.toLowerCase()}?`) && !confirmText.includes(h.v), 'confirmation names the kind only');
    assert.equal(await spent(page), 0, 'nothing spent before the confirmation');
    await page.locator('#sheet [data-confirm]').click(); await page.waitForTimeout(250);
    assert.equal(await spent(page), 1);
    const chip = await page.locator('#hints-list').innerText(); assert.ok(chip.toLowerCase().includes(info.label.toLowerCase()) && chip.includes(info.text()), chip);
    if (type === 'region') assert.ok(chip.includes(', ' + a.country), 'region is shown as "<region>, <country>"');
    await ctx.close();
  });
}
await test('each hint costs exactly 1 attempt, is offered once, and the country is "already shown" after a region clue', async () => {
  const a = ofType('region').find((x) => x.iata);
  const { ctx, page } = await open(); await start(page, a.id);
  await buy(page, 'extra'); assert.equal(await spent(page), 1);
  await page.locator('#btn-hint').click();
  assert.equal(await page.locator('#sheet [data-hint=extra]').isDisabled(), true, 'cannot buy the same hint twice');
  assert.equal(await page.locator('#sheet [data-hint=country]').isDisabled(), true, 'the region clue already contains the country');
  assert.match(await page.locator('#sheet [data-hint=country]').innerText(), /Already shown/);
  assert.equal(await page.locator('#sheet [data-hint=letter]').isDisabled(), false);
  await page.locator('#sheet [data-cancel]').click();
  // double-confirm cannot spend twice
  await page.locator('#btn-hint').click(); await page.locator('#sheet [data-hint=letter]').click();
  await page.evaluate(() => { const b = document.querySelector('#sheet [data-confirm]'); b.click(); b.click(); });
  await page.waitForTimeout(300); assert.equal(await spent(page), 2, 'a double click on Reveal spends once');
  assert.match(await page.locator('#hints-list').innerText(), new RegExp('Name starts with', 'i'));
  await ctx.close();
});
await test('airline clue does not reveal the country: the country hint stays available after it', async () => {
  const a = ofType('airline').find((x) => x.iata);
  const { ctx, page } = await open(); await start(page, a.id);
  await buy(page, 'extra'); await page.locator('#btn-hint').click();
  assert.equal(await page.locator('#sheet [data-hint=country]').isDisabled(), false); await ctx.close();
});
await test('last attempt: a hint needs 2 attempts left (the game would end), the button is disabled with 1 left; 2 left allows it and leaves 1', async () => {
  const a = ofType('region').find((x) => x.iata);
  const { ctx, page } = await open(); await start(page, a.id);
  await guess(page, 'JFK'); await guess(page, 'LHR'); await guess(page, 'SIN'); // 3 spent, 2 left
  assert.equal(await page.locator('#btn-hint').isDisabled(), false);
  await buy(page, 'letter'); assert.equal(await spent(page), 4);
  assert.equal(await page.locator('#btn-hint').isDisabled(), true, 'one attempt left: no more hints');
  assert.equal(await page.evaluate(() => window.__ag.round.done), false, 'buying with 2 left does not end the game'); await ctx.close();
});
await test('reload keeps the bought hints and the spent attempts (Daily); the clue text comes back', async () => {
  const { ctx, page } = await open();
  const a = await page.evaluate(() => window.__ag.round.answer); const info = C.hintInfo('extra', a);
  await buy(page, 'letter'); await buy(page, 'extra'); assert.equal(await spent(page), 2);
  await page.reload(); await page.waitForFunction(() => window.__ag && window.__ag.round && window.__ag.round.hints.length === 2, null, { timeout: 40000 }); await page.waitForTimeout(600);
  assert.equal(await spent(page), 2); const chips = await page.locator('#hints-list').innerText();
  assert.ok(chips.includes(C.firstChar(a.name)) && chips.includes(info.text()), chips);
  assert.match(await page.locator('#left').innerText(), /3\s*of 5/i);
  await ctx.close();
});
await test('a game saved by the previous version (continent + runways hints) keeps its 2 spent attempts and does not crash', async () => {
  const first = await open(); const a = await first.page.evaluate(() => window.__ag.round.answer);
  const date = await first.page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }); await first.ctx.close();
  const saved = JSON.stringify({ date, id: a.id, log: [{ t: 'h', k: 'continent' }, { t: 'h', k: 'runways' }], done: false, won: false });
  const { ctx, page } = await open({ 'airportGuesser.daily.v2': saved });
  assert.equal(await spent(page), 2, 'both old hints still count'); assert.match(await page.locator('#left').innerText(), /3\s*of 5/i);
  assert.equal(await page.locator('#hints-list li').count(), 1, 'the first old hint shows as the extra clue; the second is only counted');
  await page.locator('#btn-hint').click(); assert.equal(await page.locator('#sheet [data-hint=extra]').isDisabled(), true);
  await ctx.close();
});
await browser.close(); server.close();
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} hint checks passed`); process.exit(failed ? 1 : 0);
