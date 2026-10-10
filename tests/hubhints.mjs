// Curated Major hub airlines (v1.4.3), through the real UI: on every one of the 100 Major hubs (Practice > Major hubs) and on each of the 50 Daily
// airports (Daily mode, on a date that serves it) the third clue is bought from the hint menu and its label, cost and text are checked against
// data/hub_airlines.json. Nothing of the clue is in the page before the purchase. Run: node tests/hubhints.mjs   (AG_ROOT=dist for the built site)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../js/core.js';
import { launchBrowser } from './browser.mjs';
import { createServer } from '../scripts/serve.mjs';
const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const json = (f) => JSON.parse(readFileSync(path('../data/' + f), 'utf8'));
const hubs = Object.values(json('hub_airlines.json').hubs);
const all = [...json('airports.json').airports, ...json('airports-hard.json').airports];
const majors = all.filter((a) => a.tier === 1);
const entryOf = (a) => hubs.find((h) => h.icao === a.icao);
const server = createServer(); await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser; for (const o of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await launchBrowser(o); break; } catch { /* next */ } }
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split('\n').slice(0, 6).join('\n       ')}`); } };

const open = async (prefs, date) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.addInitScript(([p]) => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); localStorage.setItem('airportGuesser.prefs.v2', JSON.stringify(p)); } catch { /* */ } }, [prefs]);
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/arcgisonline|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  if (date) await page.clock.setFixedTime(date);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 60000 });
  await page.waitForFunction(() => { const v = document.querySelector('#veil'); return v.hidden || v.classList.contains('out'); }, null, { timeout: 60000 });
  return { ctx, page, errors };
};
const pageText = (page) => page.evaluate(() => {
  const c = document.documentElement.cloneNode(true); c.querySelectorAll('script,style,dialog').forEach((n) => n.remove());
  const attrs = []; c.querySelectorAll('*').forEach((e) => { for (const n of e.getAttributeNames()) attrs.push(e.getAttribute(n)); });
  return (c.querySelector('body').textContent + ' ' + attrs.join(' ')).replace(/\s+/g, ' ');
});
/** Opens the hint menu, checks the third item, buys it and checks the chip. Returns the attempts the purchase cost. */
async function checkThird(page, a) {
  const e = entryOf(a); const code = a.iata || a.icao;
  assert.ok(e, code + ' has an entry in hub_airlines.json');
  const before = await pageText(page);
  if (e.airline) assert.ok(!before.includes(e.airline), `${code}: "${e.airline}" is in the page before the purchase`);
  await page.locator('#btn-hint').click(); await page.waitForSelector('#sheet [data-hint=extra]');
  const item = page.locator('#sheet [data-hint=extra]');
  const text = await item.innerText();
  assert.equal(await item.isDisabled(), false, `${code}: third item disabled (${text})`); assert.ok(!/not available/i.test(await page.locator('#sheet').innerText()), code + ': "Not available" in the menu');
  const airline = e.airline && e.confidence !== 'low';
  if (airline) {
    const label = e.dominant ? 'Main airline' : 'A main airline here';
    assert.ok(text.includes(label), `${code}: menu says "${text}", expected "${label}"`); assert.match(text, /2 guesses/, code + ': cost 2');
    assert.ok(!(await page.locator('#sheet').innerText()).includes(e.airline), `${code}: the open menu shows the airline`);
    assert.ok(/main airline costs 2/i.test(await page.locator('#sheet').innerText()), code + ': the menu explains the cost of 2');
  } else {
    assert.ok(!/airline/i.test(text), `${code}: low-confidence hub shows "${text}"`); assert.match(text, /1 guess\b/, code + ': cost 1');
    assert.ok(!/main airline costs 2/i.test(await page.locator('#sheet').innerText()), code + ': no airline sentence without an airline hint');
  }
  await item.click(); await page.locator('#sheet [data-confirm]').click(); await page.waitForTimeout(200);
  const chip = (await page.locator('#hints-list').innerText()).trim();
  if (airline) { assert.ok(chip.toLowerCase().includes((e.dominant ? 'main airline' : 'a main airline here')) && chip.includes(e.airline), `${code}: chip "${chip}"`); } else assert.ok(!/airline/i.test(chip), `${code}: chip "${chip}"`);
  return page.evaluate(() => window.__ag.round.log.filter((x) => x.t === 'h').length);
}

await test('Practice > Major hubs: all 100 hubs offer the curated third clue (label, cost 2, text) through the real hint menu', async () => {
  const { ctx, page, errors } = await open({ mode: 'practice', diff: 'easy', hard: false });
  const seen = new Set();
  for (const a of majors) {
    await page.evaluate((i) => window.__ag.debugStart(i), a.id); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__ag.round.answer.tier), 1);
    assert.equal(await checkThird(page, a), 1, 'one hint bought'); seen.add(a.id);
  }
  assert.equal(seen.size, 100); assert.deepEqual(errors, [], 'console errors');
  await ctx.close();
});

await test('Daily: each of the 50 Daily airports shows the same curated third clue (a date is chosen for every airport)', async () => {
  const top = json('airports.json').airports.filter((a) => a.top).sort((x, y) => x.top - y.top); assert.equal(top.length, 50);
  const dateFor = new Map(); const d0 = new Date(2026, 10, 1);
  for (let i = 0; i < 400 && dateFor.size < 50; i++) {
    const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i, 12), key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const id = C.dailyTopOrder(top, key)[0].id; if (!dateFor.has(id)) dateFor.set(id, d);
  }
  assert.equal(dateFor.size, 50, 'every Daily airport is served on some date');
  for (const a of top) {
    const { ctx, page, errors } = await open({ mode: 'daily', hard: false }, dateFor.get(a.id));
    assert.equal(await page.evaluate(() => window.__ag.round.answer.id), a.id, 'the Daily airport for that date'); assert.equal(await page.evaluate(() => window.__ag.round.kind), 'daily');
    await checkThird(page, a); assert.deepEqual(errors, [], (a.iata || a.icao) + ': console errors');
    await ctx.close();
  }
});

await test('the airline clue needs 3 attempts left: after three wrong guesses the hub still offers it disabled with the reason, never as "Not available"', async () => {
  const a = majors.find((x) => x.iata === 'ATL');
  const { ctx, page } = await open({ mode: 'practice', diff: 'easy', hard: false });
  await page.evaluate((i) => window.__ag.debugStart(i), a.id); await page.waitForTimeout(200);
  const wrong = all.filter((x) => x.id !== a.id && x.iata && x.tier === 1).slice(0, 3);
  for (const w of wrong) { await page.locator('#guess-input').fill(w.iata); await page.waitForSelector('#suggestions li[role=option]'); await page.locator('#suggestions li[role=option]').first().click(); await page.locator('#guess-btn').click(); await page.waitForTimeout(350); }
  assert.equal(await page.evaluate(() => window.__ag.round.log.length), 3);
  await page.locator('#btn-hint').click(); await page.waitForSelector('#sheet [data-hint=extra]');
  const text = await page.locator('#sheet [data-hint=extra]').innerText();
  assert.equal(await page.locator('#sheet [data-hint=extra]').isDisabled(), true); assert.match(text, /Needs 3 attempts left/); assert.ok(!/not available/i.test(await page.locator('#sheet').innerText()));
  await ctx.close();
});

await browser.close(); server.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
