// Hardening: the debug hook is only on a local host, the CSP is on in the built site and blocks injected scripts,
// daily.json lists no future answers beyond tomorrow. Run: node tests/hardening.mjs   (AG_ROOT=dist for the CSP checks)
import { launchBrowser, browserName } from './browser.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from '../scripts/serve.mjs';
const path = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const built = process.env.AG_ROOT === 'dist';
const server = createServer(); await new Promise((r) => server.listen(0, r));
const port = server.address().port;
let browser; for (const o of [{ channel: 'msedge', args: ['--host-resolver-rules=MAP app.example 127.0.0.1'] }, { channel: 'chrome', args: ['--host-resolver-rules=MAP app.example 127.0.0.1'] }, { args: ['--host-resolver-rules=MAP app.example 127.0.0.1'] }]) { try { browser = await launchBrowser(o); break; } catch { /* next */ } }
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split('\n').slice(0, 4).join('\n       ')}`); } };
const open = async (host) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } });
  const page = await ctx.newPage(); await page.goto(`http://${host}:${port}/`); return { ctx, page };
};

if (browserName === 'chromium') await test('debug hook window.__ag exists on localhost only; on any other host the app still plays and the answer is not exposed', async () => {
  const local = await open('localhost');
  await local.page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 }); await local.ctx.close();
  const { ctx, page } = await open('app.example');
  await page.waitForFunction(() => { const v = document.querySelector('#veil'); return v.hidden || v.classList.contains('out'); }, null, { timeout: 40000 });
  assert.equal(await page.evaluate(() => typeof window.__ag), 'undefined');
  await page.locator('#guess-input').fill('JFK'); await page.waitForSelector('#suggestions li[role=option]');
  await page.locator('#suggestions li[role=option]').first().click(); await page.locator('#guess-btn').click(); await page.waitForTimeout(500);
  assert.equal(await page.locator('#guesses li').count(), 1, 'a guess works without the hook');
  const leak = await page.evaluate(() => Object.keys(window).filter((k) => k !== '__AG_DATA' && /^__ag|answer|round|game$/i.test(k)));
  assert.deepEqual(leak, []);
  await ctx.close();
});
if (built) {
  await test('built site: Content-Security-Policy is present; an injected inline script and an off-list host are blocked', async () => {
    const { ctx, page } = await open('localhost');
    await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 });
    const r = await page.evaluate(async () => {
      const viol = []; document.addEventListener('securitypolicyviolation', (e) => viol.push(e.violatedDirective));
      const s = document.createElement('script'); s.textContent = 'window.__pwn = 1'; document.body.appendChild(s);
      const img = new Image(); img.src = 'https://example.org/x.png'; document.body.appendChild(img);
      let fetched = 'ok'; try { await fetch('https://example.org/'); } catch { fetched = 'blocked'; }
      await new Promise((r) => setTimeout(r, 400));
      return { csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'), pwn: window.__pwn, viol, fetched };
    });
    assert.equal(r.csp, true); assert.equal(r.pwn, undefined, 'inline script ran'); assert.equal(r.fetched, 'blocked');
    assert.ok(r.viol.some((v) => /script-src/.test(v)) && r.viol.some((v) => /img-src/.test(v)), JSON.stringify(r.viol));
    await ctx.close();
  });
  await test('built site: the whole session (play, hint, Help, About, Stats, theme, service worker) causes no CSP violation', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
    await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } document.addEventListener('securitypolicyviolation', (e) => { (window.__viol = window.__viol || []).push(e.violatedDirective + ' ' + e.blockedURI); }); });
    const page = await ctx.newPage(); const logs = []; page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) logs.push(m.text().slice(0, 160)); });
    await page.goto(`http://localhost:${port}/`); await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 }); await page.waitForTimeout(2500);
    await page.locator('#guess-input').fill('JFK'); await page.waitForSelector('#suggestions li[role=option]'); await page.locator('#suggestions li[role=option]').first().click(); await page.locator('#guess-btn').click();
    await page.locator('#btn-hint').click(); await page.locator('#sheet [data-hint=country]').click(); await page.locator('#sheet [data-confirm]').click();
    for (const b of ['#btn-help', '#btn-about', '#btn-stats']) { await page.locator(b).click(); await page.waitForTimeout(900); await page.keyboard.press('Escape'); }
    await page.locator('#theme-seg button').nth(2).click(); await page.locator('#mode-seg button').nth(1).click(); await page.waitForTimeout(1500);
    assert.deepEqual(await page.evaluate(() => window.__viol || []), []); assert.deepEqual(logs, []);
    await ctx.close();
  });
  await test('built site: data/daily.json holds yesterday, today and tomorrow only (no further answers)', async () => {
    const d = JSON.parse(readFileSync(path('../dist/data/daily.json'), 'utf8'));
    assert.equal(Object.keys(d.days).length, 3, Object.keys(d.days).join());
  });
}
await browser.close(); server.close();
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} hardening checks passed`); process.exit(failed ? 1 : 0);
