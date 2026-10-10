// Wikipedia link on the result card: never before the game ends, correct and safe after it. Run: node tests/wikipedia.mjs
// (needs network for Esri tiles; writes qa/wikipedia-result-*.png). The app itself must never contact Wikipedia.
import { launchBrowser } from './browser.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';
import * as C from '../js/core.js';

const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const QA = path('../qa/');
mkdirSync(QA, { recursive: true });
const read = (f) => JSON.parse(readFileSync(path('../data/' + f), 'utf8')).airports;
const main = read('airports.json');
const byIata = (i) => main.find((a) => a.iata === i);

const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await launchBrowser(opts); break; } catch { /* next */ } }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
let passed = 0;
const test = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 5).join('\n       ')}`); process.exitCode = 1; }
};
const wikiHosts = /(^|\.)(wikipedia|wikimedia|wikidata)\.org$/;

async function newPage(profile, colorScheme = 'light') {
  const ctx = await browser.newContext({ ...profile, colorScheme, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } });
  const page = await ctx.newPage();
  const wikiRequests = [];
  page.on('request', (r) => { try { if (wikiHosts.test(new URL(r.url()).hostname)) wikiRequests.push(r.url()); } catch { /* */ } });
  return { ctx, page, wikiRequests };
}
async function open(page) {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag, null, { timeout: 30000 });
}
const settled = (page) => page.waitForFunction(() => window.__ag.round && (document.querySelector('#veil').hidden || document.querySelector('#veil').classList.contains('out')) && document.querySelectorAll('.sat.front img.leaflet-tile-loaded').length > 0, null, { timeout: 60000 });
async function start(page, id) {
  await page.evaluate((i) => window.__ag.debugStart(i), id);
  await settled(page);
  await page.waitForTimeout(400);
}
async function guess(page, q, { expectWin = false } = {}) {
  await page.locator('#guess-input').fill(q);
  await page.waitForSelector('#suggestions li[role=option]');
  await page.locator('#suggestions li[role=option]').first().click();
  await page.locator('#guess-btn').click();
  await page.waitForTimeout(250);
}

/** Everything the page shows or carries in its DOM, without <script> data and closed dialogs (those are not "visible" content). */
const domLeak = (page, answer) => page.evaluate((a) => {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script, style, dialog').forEach((n) => n.remove());
  const html = clone.outerHTML;
  const terms = [a.wp && a.wp.split('|').pop(), a.wp && a.wp.split('|').pop().replace(/_/g, ' '), a.name].filter(Boolean);
  return {
    links: [...clone.querySelectorAll('a[href]')].map((l) => l.getAttribute('href')).filter((h) => /wikipedia|wikidata|wikimedia/i.test(h)),
    resourceHints: [...clone.querySelectorAll('link[rel]')].map((l) => l.getAttribute('rel') + ' ' + l.getAttribute('href')).filter((h) => /wiki/i.test(h)),
    wikiWord: /wikipedia/i.test(clone.querySelector('#panel').innerHTML + clone.querySelector('#stage').innerHTML),
    termsFound: terms.filter((t) => html.includes(t) || html.includes(encodeURIComponent(t))),
    resultHidden: document.querySelector('#result').hidden,
  };
}, answer);

console.log('data and link rules');
await test('every Daily (top 50) airport has a verified article link; every link in the data is well-formed and safe', () => {
  const top = main.filter((a) => a.top);
  assert.equal(top.length, 50);
  for (const a of top) {
    assert.ok(a.wp, a.iata + ' has an article');
    const l = C.wikipediaLink(a);
    assert.equal(l.kind, 'article', a.iata);
    assert.ok(C.isWikipediaUrl(l.url), a.iata + ' ' + l.url);
    assert.ok(l.url.startsWith('https://'), 'https');
  }
  const all = [...main, ...read('airports-hard.json')];
  let withWp = 0;
  for (const a of all) {
    const l = C.wikipediaLink(a);
    assert.ok(C.isWikipediaUrl(l.url), a.name + ' ' + l.url);
    if (a.wp) { withWp++; assert.match(a.wp, /^([a-z-]{2,10}\|)?[^\s|?#<>]+$/, 'title only, no URL: ' + a.wp); }
  }
  console.log(`       ${withWp} of ${all.length} airports carry an article title; the rest use a Wikipedia search link`);
});

console.log('result card');
for (const [scheme, profile, name] of [['light', PHONE, 'phone'], ['dark', PHONE, 'phone'], ['light', DESKTOP, 'desktop'], ['dark', DESKTOP, 'desktop']]) {
  await test(`${scheme} ${name}: link absent during play (every state), present on win and on loss, safe, 44pt target, long names fit; no request to Wikipedia`, async () => {
    const { ctx, page, wikiRequests } = await newPage(profile, scheme);
    await open(page);
    const GRU = byIata('GRU'); // the longest official name among the top 50
    await start(page, GRU.id);
    const answer = await page.evaluate(() => window.__ag.round.answer);
    assert.ok(answer.wp, 'answer has an article title in the data');
    const wrong = ['JFK', 'LHR', 'SIN', 'DXB'];
    const states = [];
    states.push(['start', await domLeak(page, answer)]);
    await guess(page, wrong[0]); states.push(['after 1 wrong guess', await domLeak(page, answer)]);
    await page.locator('#btn-hint').click(); states.push(['hint menu open', await domLeak(page, answer)]);
    await page.locator('#sheet [data-hint=country]').click(); states.push(['hint confirmation', await domLeak(page, answer)]);
    await page.locator('#sheet [data-confirm]').click(); states.push(['after a hint', await domLeak(page, answer)]);
    await page.locator('#btn-zoom').click(); states.push(['zoom confirmation', await domLeak(page, answer)]);
    await page.locator('#sheet [data-confirm]').click(); await page.waitForTimeout(400); states.push(['zoomed out', await domLeak(page, answer)]);
    for (const [label, s] of states) {
      assert.deepEqual(s.links, [], label + ': no Wikipedia link in the DOM');
      assert.deepEqual(s.resourceHints, [], label + ': no prefetch/preload hints');
      assert.equal(s.wikiWord, false, label + ': no "Wikipedia" text in the game area');
      assert.equal(s.resultHidden, true, label + ': result card hidden');
      assert.deepEqual(s.termsFound.filter((t) => t !== answer.name), [], label + ': article title not in the DOM');
    }
    // lose on the last attempt (5 spent: guess, hint, zoom, guess, guess)
    await guess(page, wrong[1]);
    states.push(['4 attempts spent', await domLeak(page, answer)]);
    assert.deepEqual(states.at(-1)[1].links, [], 'still no link with one attempt left');
    await guess(page, wrong[2]);
    await page.waitForSelector('#result:not([hidden])');
    await page.waitForTimeout(600);
    const lost = await page.evaluate(() => { const a = document.querySelector('#result a.wiki'); const r = a.getBoundingClientRect(); return { href: a.href, target: a.target, rel: a.rel, text: a.innerText, h: r.height, w: r.width, vw: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth, count: document.querySelectorAll('#result a').length, eyebrow: document.querySelector('#result .eyebrow').innerText }; });
    assert.match(lost.eyebrow, /Out of attempts/i);
    assert.equal(lost.count, 1);
    assert.equal(lost.href, C.wikipediaLink(answer).url);
    assert.equal(lost.target, '_blank');
    assert.ok(/noopener/.test(lost.rel) && /noreferrer/.test(lost.rel), lost.rel);
    assert.ok(lost.h >= 44, 'touch target height ' + lost.h);
    assert.ok(lost.text.includes('Read about') && lost.text.includes(answer.name) && lost.text.includes('Wikipedia'), lost.text);
    assert.equal(lost.overflowX, false, 'a long airport name does not overflow the screen');
    await page.screenshot({ path: QA + `wikipedia-result-lose-${scheme}-${name}.png`, fullPage: name === 'phone' });
    // win: new round, guess it outright
    await start(page, byIata('ZRH').id);
    const zrh = await page.evaluate(() => window.__ag.round.answer);
    assert.deepEqual((await domLeak(page, zrh)).links, []);
    await guess(page, 'ZRH');
    await page.waitForSelector('#result:not([hidden])');
    await page.waitForTimeout(600);
    const won = await page.evaluate(() => ({ href: document.querySelector('#result a.wiki').href, eyebrow: document.querySelector('#result .eyebrow').innerText }));
    assert.match(won.eyebrow, /Solved/i);
    assert.equal(won.href, C.wikipediaLink(zrh).url);
    await page.screenshot({ path: QA + `wikipedia-result-win-${scheme}-${name}.png`, fullPage: name === 'phone' });
    // offline: the link is still there (the click would simply fail normally)
    await ctx.setOffline(true);
    assert.equal(await page.locator('#result a.wiki').isVisible(), true, 'link shown offline');
    await ctx.setOffline(false);
    assert.deepEqual(wikiRequests, [], 'the app made no request to Wikipedia / Wikidata: ' + wikiRequests.join(', '));
    await ctx.close();
  });
}

await test('Practice, Hard and Daily all show the link at the end; an airport without a verified article gets a search link, not a guessed URL', async () => {
  const { ctx, page, wikiRequests } = await newPage(DESKTOP);
  await open(page);
  // Daily: finish by guessing the airport of the day
  await page.waitForFunction(() => window.__ag.round && document.querySelector('#veil').hidden, null, { timeout: 60000 });
  let a = await page.evaluate(() => window.__ag.round.answer);
  assert.equal(a.top >= 1, true);
  await guess(page, a.iata);
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.evaluate(() => document.querySelector('#result a.wiki').href), C.wikipediaLink(a).url, 'Daily');
  // Hard: toggle, finish
  await page.locator('#hard-switch').click();
  await page.waitForFunction(() => window.__ag.round && window.__ag.round.kind === 'hard' && document.querySelector('#veil').hidden, null, { timeout: 60000 });
  a = await page.evaluate(() => window.__ag.round.answer);
  await guess(page, a.iata || a.name);
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.evaluate(() => document.querySelector('#result a.wiki').href), C.wikipediaLink(a).url, 'Hard');
  // Practice on an airport that has no article title in the data (search fallback), if the data has one
  const noWp = read('airports-hard.json').find((x) => !x.wp && x.name.length < 40 && !/[^\x20-\x7e]/.test(x.name));
  if (noWp) {
    await start(page, noWp.id);
    await guess(page, noWp.name);
    await page.waitForSelector('#result:not([hidden])');
    const href = await page.evaluate(() => document.querySelector('#result a.wiki').href);
    assert.equal(href, 'https://en.wikipedia.org/w/index.php?search=' + encodeURIComponent(noWp.name));
    assert.match(await page.locator('#result a.wiki').innerText(), /Search Wikipedia for/);
  }
  assert.deepEqual(wikiRequests, []);
  await ctx.close();
});

await browser.close();
server.close();
console.log(`\n${passed} wikipedia checks passed${process.exitCode ? ', some FAILED' : ''}. Screenshots: qa/wikipedia-result-*.png`);
