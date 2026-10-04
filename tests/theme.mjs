// Theme checks: system/light/dark, manual override, live OS switching, no flash on load, WCAG AA contrast, QA screenshots.
// Run: node tests/theme.mjs      (needs network for Esri tiles; writes qa/theme-*.png and test-output/theme/*)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';

const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = path('../test-output/theme/');
const QA = path('../qa/');
mkdirSync(OUT, { recursive: true });
mkdirSync(QA, { recursive: true });

const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const HUB = 3384;
let passed = 0;
const test = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 5).join('\n       ')}`); process.exitCode = 1; }
};

async function newPage(profile, { colorScheme, pref, sw = false } = {}) {
  const ctx = await browser.newContext({ ...profile, colorScheme, serviceWorkers: sw ? 'allow' : 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (pref) await page.addInitScript((p) => { try { localStorage.setItem('airportGuesser.theme.v1', p); } catch { /* */ } }, pref);
  return { ctx, page, errors };
}
const settled = (page) => page.waitForFunction(() => window.__ag && window.__ag.round && (document.querySelector('#veil').hidden || document.querySelector('#veil').classList.contains('out')) && document.querySelectorAll('.sat.front img.leaflet-tile-loaded').length > 0, null, { timeout: 60000 });
const themeOf = (page) => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, pref: document.documentElement.dataset.themePref, scheme: document.documentElement.style.colorScheme, meta: document.querySelector('meta[name="theme-color"]').content, bg: getComputedStyle(document.body).backgroundColor }));
const lum = (rgb) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };

// ------------------------------------------------------------------ contrast audit (runs in the page)
const AUDIT = () => {
  const parse = (c) => {
    let m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[,/ ]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
    m = c.match(/color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] ?? 1 }; }
    return { r: 0, g: 0, b: 0, a: 0 };
  };
  const over = (top, bot) => { const a = top.a + bot.a * (1 - top.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (top.r * top.a + bot.r * bot.a * (1 - top.a)) / a, g: (top.g * top.a + bot.g * bot.a * (1 - top.a)) / a, b: (top.b * top.a + bot.b * bot.a * (1 - top.a)) / a, a }; };
  const tokColor = (name) => { const t = document.createElement('i'); t.style.color = `var(${name})`; document.body.appendChild(t); const c = parse(getComputedStyle(t).color); t.remove(); return c; };
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const canvas = parse(getComputedStyle(document.documentElement).backgroundColor).a ? parse(getComputedStyle(document.documentElement).backgroundColor) : { r: 255, g: 255, b: 255, a: 1 };

  /** Effective backgrounds behind `el`: a list (several when the element sits on imagery: worst cases black and white). */
  const backgrounds = (el) => {
    const layers = [];
    let overImagery = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (n.classList.contains('veil') || (cs.backgroundImage && cs.backgroundImage.includes('gradient'))) { layers.push(tokColor('--skel-1')); break; }
      const c = parse(cs.backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a === 1) break;
      if (n.classList.contains('sat') || n.classList.contains('leaflet-container') || n.classList.contains('stage')) { overImagery = true; }
    }
    const unders = overImagery ? [{ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }] : [canvas];
    return unders.map((u) => layers.reduceRight((acc, l) => over(l, acc), u));
  };
  const opacityOf = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !el.closest('[hidden]') && !el.closest('.sat:not(.front)'); };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || el.matches('input');

  const SELECTORS = ['.brand', '.link', '#mode-seg button', '#diff-seg button', '.switch-label', '#theme-seg button', '.foot span', '.foot .link-inline', 'dialog[open] .prose a', 'dialog[open] .prose i', 'dialog[open] .prose ul li', '.left', '.left b',
    '#guess-input', '#guess-btn', '.btn.ghost', '.cost', '#suggestions .s-name', '#suggestions .s-meta', '#suggestions .s-meta b', '#suggestions mark', '.noresults',
    '.sheet h4', '.sheet p', '.sheet .opt', '.sheet .opt small', '.sheet .cancel', '.sheet .btn', '.sheet .btn.primary',
    '.hints-used h3', '.hints-used li span', '.hints-used li b', '.row .n', '.row .nm', '.row .code', '.row .nums b', '.row .nums > span:not(.bar)', '.row .dir span',
    '.result .eyebrow', '.result h2', '.result .codes', '.result .where', '.result .next', '.result .next b', '.result .btn',
    '#toast.show', '.veil p', '.veil small', '#veil-retry', '.chip', '.leaflet-control-attribution', '.leaflet-control-attribution a',
    'dialog[open] .dlg-head h2', 'dialog[open] .link', 'dialog[open] .prose p', 'dialog[open] .prose li', 'dialog[open] .prose h3', 'dialog[open] .prose b',
    '.tile b', '.tile span', '.drow', '.drow .fill', 'dialog[open] .seg button'];
  const seen = [], fails = [];
  for (const sel of SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el) || el.disabled || !ownText(el)) continue;
      const cs = getComputedStyle(el);
      let fg = parse(cs.color);
      fg = { ...fg, a: fg.a * opacityOf(el) };
      const checks = [{ pseudo: false, fg }];
      if (el.matches('#guess-input')) checks.push({ pseudo: true, fg: parse(getComputedStyle(el, '::placeholder').color) });
      for (const ck of checks) {
        if (ck.pseudo && el.value) continue;
        const target = el.matches('input') && !ck.pseudo ? null : 1;
        if (el.matches('input') && !ck.pseudo) continue; // typed text is checked via the placeholder colour pair (same background)
        const worst = Math.min(...backgrounds(el).map((bg) => ratio(over(ck.fg, bg), bg)));
        seen.push(sel + (ck.pseudo ? '::placeholder' : ''));
        if (worst < 4.5) fails.push({ sel: sel + (ck.pseudo ? '::placeholder' : ''), text: (el.innerText || el.placeholder || '').trim().slice(0, 30), ratio: +worst.toFixed(2) });
        void target;
      }
    }
  }
  return { seen, fails };
};

const seenAll = new Set();
async function audit(page, label, theme) {
  await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { /* infinite animation */ } } }); // entrance animations (dialogs, rows) must be done
  const r = await page.evaluate(AUDIT);
  r.seen.forEach((s) => seenAll.add(s));
  if (r.fails.length) console.log('       contrast fails', theme, label, JSON.stringify(r.fails));
  assert.deepEqual(r.fails, [], `${theme}/${label}: contrast below 4.5:1`);
  return r.seen.length;
}
const guessVia = async (page, q) => { // touch devices blur the input after picking, so tap the suggestion and the Guess button
  await page.locator('#guess-input').fill(q);
  await page.waitForSelector('#suggestions li[role=option]');
  await page.locator('#suggestions li[role=option]').first().click();
  await page.locator('#guess-btn').click();
};
const shot = async (page, name, { full = false } = {}) => { const p = OUT + name + '.png'; await page.screenshot({ path: p, fullPage: full }); return p; };

async function walkthrough(theme) {
  const { ctx, page, errors } = await newPage(PHONE, { colorScheme: theme });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.main.length > 0, null, { timeout: 30000 });
  await page.waitForSelector('dialog[open]');
  await audit(page, 'help dialog (about & credits)', theme);
  await shot(page, `${theme}-help`);
  await page.keyboard.press('Escape');
  await page.locator('#btn-about').scrollIntoViewIfNeeded();
  await page.locator('#btn-about').click();
  await page.waitForSelector('#dlg-about[open]');
  await page.waitForFunction(() => document.querySelectorAll('#oss-list li a').length > 0);
  await page.waitForTimeout(300);
  await audit(page, 'about & credits', theme);
  await shot(page, `${theme}-about`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__ag.debugStart(21)); await settled(page);        // loads the Hard dataset
  await page.evaluate((id) => window.__ag.debugStart(id), HUB); await settled(page);
  await page.waitForTimeout(500);
  await audit(page, 'start', theme);
  await shot(page, `${theme}-start`);
  await page.locator('#guess-input').fill('zur');
  await page.waitForSelector('#suggestions li[role=option]');
  await audit(page, 'autocomplete', theme);
  await shot(page, `${theme}-autocomplete`);
  await guessVia(page, 'JFK');
  await page.waitForFunction(() => document.querySelectorAll('#guesses .row').length === 1);
  await page.waitForTimeout(900);
  await audit(page, 'guess row', theme);
  await page.locator('#btn-hint').click();
  await audit(page, 'hint menu', theme);
  await shot(page, `${theme}-hint-menu`);
  await page.locator('#sheet [data-hint=continent]').click();
  await audit(page, 'hint confirmation', theme);
  await page.locator('#sheet [data-confirm]').click();
  await page.locator('#btn-zoom').click();
  await audit(page, 'zoom confirmation', theme);
  await shot(page, `${theme}-zoom-confirm`);
  await page.locator('#sheet [data-cancel]').click();
  await audit(page, 'hint chips, disabled-free', theme);
  const a = await page.evaluate(() => window.__ag.round.answer);
  await guessVia(page, a.iata);
  await page.waitForSelector('#result:not([hidden])');
  await page.waitForTimeout(700);
  await audit(page, 'result', theme);
  await shot(page, `${theme}-result`, { full: true });
  await page.locator('#btn-share').click();
  await page.waitForSelector('#toast.show');
  await audit(page, 'toast', theme);
  await shot(page, `${theme}-toast`);
  await page.waitForTimeout(2400);
  await page.locator('#btn-stats').click();
  await page.waitForSelector('#dlg-stats[open]');
  await page.locator('#stats-seg [data-stats=practice]').click(); // the finished practice game has a distribution bar
  await page.waitForTimeout(500);
  await audit(page, 'stats dialog', theme);
  await shot(page, `${theme}-stats`);
  await page.keyboard.press('Escape');
  // loading skeleton, then tap-to-retry
  let mode = 'slow';
  await page.route('**/World_Imagery/MapServer/tile/**', async (route) => {
    if (mode === 'fail') return route.abort();
    await new Promise((r) => setTimeout(r, 400)); return route.continue();
  });
  await page.evaluate(() => { window.__ag.debugStart(5000 < 1 ? 0 : 3622); }); // JFK
  await page.waitForFunction(() => !document.querySelector('#veil').hidden && /\d+ \/ \d+ tiles/.test(document.querySelector('#veil-count').textContent));
  await audit(page, 'loading skeleton', theme);
  await shot(page, `${theme}-loading`);
  await settled(page);
  mode = 'fail';
  await page.evaluate(() => { window.__ag.debugStart(3486); }); // DEN
  await page.waitForFunction(() => !document.querySelector('#veil-retry').hidden && !document.querySelector('#veil').hidden, null, { timeout: 30000 });
  await audit(page, 'tap to retry', theme);
  await shot(page, `${theme}-retry`);
  assert.deepEqual(errors, []);
  await ctx.close();
}

console.log('themes');
for (const theme of ['light', 'dark']) {
  await test(`${theme}: every component readable (WCAG AA 4.5:1) across all states`, () => walkthrough(theme));
}
await test('contrast audit covered the key components in both themes', async () => {
  for (const s of ['.brand', '.link', '#mode-seg button', '#theme-seg button', '#guess-input::placeholder', '.btn.ghost', '#suggestions .s-name', '#suggestions mark', '.sheet h4', '.sheet .opt', '.sheet .btn.primary', '.hints-used li b', '.row .nm', '.row .nums b', '.row .dir span', '.result h2', '.result .btn', '#toast.show', '.veil p', '#veil-retry', '.chip', '.leaflet-control-attribution', 'dialog[open] .prose p', '.tile b', '.drow .fill', '.foot span', '.foot .link-inline', 'dialog[open] .prose a']) {
    assert.ok(seenAll.has(s), 'audit never saw ' + s);
  }
});

await test('follows the OS setting; tokens, color-scheme and browser-bar colour change per theme', async () => {
  const { ctx, page } = await newPage(PHONE, { colorScheme: 'light' });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.main.length > 0);
  const light = await themeOf(page);
  assert.deepEqual([light.theme, light.pref, light.scheme, light.meta, light.bg], ['light', 'system', 'light', '#f5f5f7', 'rgb(245, 245, 247)']);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--card').trim()), '#ffffff');
  await ctx.close();
  const d = await newPage(PHONE, { colorScheme: 'dark' });
  await d.page.goto(BASE);
  await d.page.waitForFunction(() => window.__ag && window.__ag.main.length > 0);
  const dark = await themeOf(d.page);
  assert.deepEqual([dark.theme, dark.pref, dark.scheme, dark.meta, dark.bg], ['dark', 'system', 'dark', '#000000', 'rgb(0, 0, 0)']);
  assert.equal(await d.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--card').trim()), '#1c1c1e');
  await d.ctx.close();
});

await test('System mode reacts live when the OS setting changes (no reload)', async () => {
  const { ctx, page } = await newPage(PHONE, { colorScheme: 'light' });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.main.length > 0);
  await page.evaluate(() => { window.__marker = 'same-document'; });
  assert.equal((await themeOf(page)).theme, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 2000 });
  const dark = await themeOf(page);
  assert.deepEqual([dark.meta, dark.bg], ['#000000', 'rgb(0, 0, 0)']);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 2000 });
  assert.equal((await themeOf(page)).meta, '#f5f5f7');
  assert.equal(await page.evaluate(() => window.__marker), 'same-document', 'no reload happened');
  await ctx.close();
});

await test('manual switch (System / Light / Dark) overrides the OS, persists across reloads, and System follows the OS again', async () => {
  const { ctx, page } = await newPage(PHONE, { colorScheme: 'light' });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.main.length > 0);
  if (await page.locator('dialog[open]').count()) await page.keyboard.press('Escape');
  const pressed = () => page.$$eval('#theme-seg button', (b) => b.filter((x) => x.getAttribute('aria-pressed') === 'true').map((x) => x.dataset.themePref));
  assert.deepEqual(await pressed(), ['system']);
  await page.locator('#theme-seg [data-theme-pref=dark]').scrollIntoViewIfNeeded();
  await page.locator('#theme-seg [data-theme-pref=dark]').click();
  assert.deepEqual([(await themeOf(page)).theme, await pressed()], ['dark', ['dark']], 'dark chosen while the OS is light');
  assert.equal(await page.evaluate(() => localStorage.getItem('airportGuesser.theme.v1')), 'dark');
  await page.emulateMedia({ colorScheme: 'dark' }); await page.emulateMedia({ colorScheme: 'light' });
  assert.equal((await themeOf(page)).theme, 'dark', 'OS changes are ignored while a manual choice is set');
  await page.screenshot({ path: OUT + 'override-dark-on-light-os.png' });
  await page.reload();
  await page.waitForFunction(() => window.__ag && window.__ag.main.length > 0);
  assert.deepEqual([(await themeOf(page)).theme, await pressed()], ['dark', ['dark']], 'persisted');
  await page.locator('#theme-seg [data-theme-pref=light]').click();
  assert.equal((await themeOf(page)).theme, 'light');
  await page.locator('#theme-seg [data-theme-pref=system]').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('airportGuesser.theme.v1')), null);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 2000 });
  assert.deepEqual(await pressed(), ['system']);
  await ctx.close();
});

await test('storage blocked: the switch still works for this page view and nothing throws', async () => {
  const { ctx, page, errors } = await newPage(PHONE, { colorScheme: 'light' });
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__ag === undefined || true);
  await page.waitForSelector('dialog[open]'); await page.keyboard.press('Escape');
  await page.locator('#theme-seg [data-theme-pref=dark]').scrollIntoViewIfNeeded();
  await page.locator('#theme-seg [data-theme-pref=dark]').click();
  assert.equal((await themeOf(page)).theme, 'dark');
  assert.deepEqual(errors.filter((e) => !/blocked/.test(e)), []);
  await ctx.close();
});

// ------------------------------------------------------------------ no flash of the wrong theme
async function frames(profile, opts) {
  const { ctx, page } = await newPage(profile, opts);
  // slow the stylesheet and scripts so there is a long window in which a wrong-theme flash could show
  await page.route(/\/(css|js)\//, async (route) => { await new Promise((r) => setTimeout(r, 700)); await route.continue(); });
  const cdp = await ctx.newCDPSession(page);
  const shots = [];
  cdp.on('Page.screencastFrame', (f) => { shots.push(f.data); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
  await page.goto(BASE, { waitUntil: 'commit' }); // frames of the previous blank page are not part of the app's load
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.waitForFunction(() => window.__ag && window.__ag.main.length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await cdp.send('Page.stopScreencast');
  const scorer = await ctx.newPage();
  await scorer.setContent('<canvas id=c></canvas>');
  const lums = [];
  for (const b64 of shots) {
    lums.push(await scorer.evaluate(async (data) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const c = document.getElementById('c'); c.width = 40; c.height = 40; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 40, 40);
      const px = g.getImageData(0, 0, 40, 40).data; let s = 0;
      for (let i = 0; i < px.length; i += 4) s += (px[i] + px[i + 1] + px[i + 2]) / 3;
      return s / (px.length / 4) / 255;
    }, b64));
  }
  await ctx.close();
  return lums;
}
await test('no white flash on load in dark mode (OS dark): every frame of a slowed load is dark', async () => {
  const lums = await frames(PHONE, { colorScheme: 'dark' });
  console.log('       frames captured: ' + lums.length + ', brightest ' + Math.max(...lums).toFixed(2));
  assert.ok(lums.length >= 2, 'captured frames');
  assert.ok(Math.max(...lums) < 0.35, 'a light frame appeared: ' + lums.map((l) => l.toFixed(2)).join(' '));
});
await test('no flash when the manual choice is dark but the OS is light (and vice versa)', async () => {
  const a = await frames(PHONE, { colorScheme: 'light', pref: 'dark' });
  assert.ok(a.length >= 2 && Math.max(...a) < 0.35, 'dark pref on light OS: ' + a.map((l) => l.toFixed(2)).join(' '));
  const b = await frames(PHONE, { colorScheme: 'dark', pref: 'light' });
  assert.ok(b.length >= 2 && Math.min(...b) > 0.6, 'light pref on dark OS: ' + b.map((l) => l.toFixed(2)).join(' '));
});

// ------------------------------------------------------------------ QA screenshots (committed to /qa)
await test('QA screenshots: 390px and desktop, light and dark, plus overrides', async () => {
  for (const [theme, profile, name] of [['light', PHONE, 'phone'], ['dark', PHONE, 'phone'], ['light', DESKTOP, 'desktop'], ['dark', DESKTOP, 'desktop']]) {
    const { ctx, page } = await newPage(profile, { colorScheme: theme });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__ag && window.__ag.main.length > 0);
    await page.keyboard.press('Escape');
    await page.evaluate((id) => window.__ag.debugStart(id), HUB);
    await settled(page);
    await page.waitForTimeout(600);
    await guessVia(page, 'JFK');
    await page.waitForFunction(() => document.querySelectorAll('#guesses .row').length === 1);
    await page.locator('#btn-hint').click(); await page.locator('#sheet [data-hint=country]').click(); await page.locator('#sheet [data-confirm]').click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: QA + `theme-${theme}-${name}.png`, fullPage: name === 'phone' });
    await ctx.close();
  }
  const o = await newPage(PHONE, { colorScheme: 'light', pref: 'dark' }); // switch set against the OS setting
  await o.page.goto(BASE);
  await o.page.waitForFunction(() => window.__ag && window.__ag.main.length > 0);
  await o.page.keyboard.press('Escape');
  await o.page.evaluate((id) => window.__ag.debugStart(id), HUB);
  await settled(o.page);
  await o.page.locator('#theme-seg').scrollIntoViewIfNeeded();
  await o.page.screenshot({ path: QA + 'theme-override-dark-on-light-os-phone.png', fullPage: true });
  await o.ctx.close();
  const p = await newPage(DESKTOP, { colorScheme: 'dark', pref: 'light' });
  await p.page.goto(BASE);
  await p.page.waitForFunction(() => window.__ag && window.__ag.main.length > 0);
  await p.page.keyboard.press('Escape');
  await p.page.evaluate((id) => window.__ag.debugStart(id), HUB);
  await settled(p.page);
  await p.page.screenshot({ path: QA + 'theme-override-light-on-dark-os-desktop.png' });
  await p.ctx.close();
  copyFileSync(OUT + 'dark-hint-menu.png', QA + 'theme-dark-phone-hint-menu.png');
  copyFileSync(OUT + 'light-hint-menu.png', QA + 'theme-light-phone-hint-menu.png');
});

await browser.close();
server.close();
console.log(`\n${passed} theme checks passed${process.exitCode ? ', some FAILED' : ''}. Screenshots: qa/theme-*.png, test-output/theme/`);
