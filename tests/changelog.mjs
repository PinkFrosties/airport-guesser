// Version and changelog consistency. Run: node tests/changelog.mjs
// One source of truth (js/version.js); the README changelog is newest-first with strictly descending versions, the
// top entry equals the constant, and the footer, About screen, package.json and service worker all show it.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';

const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (f) => readFileSync(path('../' + f), 'utf8');
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const VERSION = read('js/version.js').match(/APP_VERSION = '(\d+\.\d+\.\d+)'/)[1];
const section = read('README.md').split('## Changelog')[1].split(/\n## /)[0];
const entries = [...section.matchAll(/^### v(\d+)\.(\d+)(?:\.(\d+))?\b(.*)$/gm)].map((m) => ({ raw: m[0], v: [+m[1], +m[2], +(m[3] ?? 0)], text: m[4] }));
const str = (v) => v.join('.');
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

console.log('changelog');
await test('README changelog has entries, each with a (name) and a date', () => {
  assert.ok(entries.length >= 7);
  for (const e of entries) assert.match(e.text, /^ \([^)]+\) - \d{4}-\d{2}-\d{2}$/, 'heading format: ' + e.raw);
});
await test('versions are strictly descending (newest first) with no duplicates', () => {
  for (let i = 1; i < entries.length; i++) assert.ok(cmp(entries[i - 1].v, entries[i].v) > 0, `${entries[i - 1].raw} must come before ${entries[i].raw}`);
  assert.equal(new Set(entries.map((e) => str(e.v))).size, entries.length, 'no duplicate versions');
});
await test('dates never increase going down the list', () => {
  const dates = entries.map((e) => e.text.match(/\d{4}-\d{2}-\d{2}/)[0]);
  for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1] >= dates[i], `${entries[i - 1].raw} is older than ${entries[i].raw}`);
});
await test('the top changelog entry is the current version (js/version.js)', () => {
  assert.equal(str(entries[0].v), VERSION);
});
await test('package.json and the service worker carry the same version', () => {
  assert.equal(JSON.parse(read('package.json')).version, VERSION, 'package.json');
  assert.match(read('sw.js'), new RegExp(`const VERSION = '${VERSION.replace(/\./g, '\\.')}';`), 'sw.js');
});

console.log('shown in the app');
const server = createServer();
await new Promise((r) => server.listen(0, r));
let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }
await test('footer and About & credits show the version', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* blocked */ } }); // the first-run help dialog opens after the first image; tests do not want it
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForFunction(() => window.__ag);
  if (await page.locator('#dlg-help[open]').count()) await page.keyboard.press('Escape');
  assert.equal(await page.locator('#app-version').innerText(), 'v' + VERSION);
  await page.locator('#btn-about').click();
  await page.waitForSelector('#dlg-about[open]');
  assert.equal(await page.locator('#about-version').innerText(), VERSION);
  assert.ok((await page.locator('#dlg-about').innerText()).includes('Version ' + VERSION));
  await ctx.close();
});
await browser.close();
server.close();
console.log(`\n${passed} changelog checks passed${process.exitCode ? ', some FAILED' : ''}`);
