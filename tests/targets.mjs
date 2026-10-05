// Touch targets: every visible control must have a 44x44 hit area (the visible shape may be smaller: .seg buttons extend theirs with ::after).
// Run: node tests/targets.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from '../scripts/serve.mjs';
const server = createServer(); await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let browser; for (const o of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) { try { browser = await chromium.launch(o); break; } catch { /* */ } }
let failed = 0;
for (const [name, vp] of [['phone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }], ['desktop', { width: 1280, height: 800 }]]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, ...(vp.isMobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('airportGuesser.seenHelp.v2', 'true'); } catch { /* */ } });
  const page = await ctx.newPage(); await page.goto(BASE);
  await page.waitForFunction(() => window.__ag && window.__ag.round, null, { timeout: 40000 }); await page.waitForTimeout(800);
  const res = await page.evaluate(() => {
    const out = [];
    const hit = (e, dx, dy) => { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2 + dx, y = r.top + r.height / 2 + dy; const t = document.elementFromPoint(x, y); return !!t && (t === e || e.contains(t) || t.contains(e) && t.tagName === 'LABEL'); };
    for (const e of document.querySelectorAll('.seg button, #btn-hint, #btn-zoom, #guess-btn, #btn-about, #btn-stats, #btn-help, .switch')) {
      if (!e.getBoundingClientRect().width || e.closest('[hidden]')) continue; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();
      // can a press 22 px above and below the centre (44 px tall) still reach the control?
      const up = hit(e, 0, -Math.min(21, r.height / 2 + 21 - 1)), down = hit(e, 0, 21);
      out.push({ id: e.id || e.textContent.trim().slice(0, 14), h: Math.round(r.height), up, down });
    }
    return out;
  });
  const bad = res.filter((r) => r.h < 44 && !(r.up && r.down));
  if (bad.length) { failed++; console.log(`  FAIL ${name}: hit area under 44 px`, JSON.stringify(bad)); } else console.log(`  ok   ${name}: ${res.length} controls have a 44 px hit area (${res.filter((r) => r.h < 44).length} extended by padding)`);
  await ctx.close();
}
await browser.close(); server.close();
console.log(failed ? 'targets: FAILED' : 'targets checks passed'); process.exit(failed ? 1 : 0);
