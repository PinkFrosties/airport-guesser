// Generates icons/*.png from an inline SVG by screenshotting it with Playwright.
// Usage: node scripts/make_icons.mjs   (needs `npm i` and a Chromium/Edge/Chrome install)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'icons');
mkdirSync(out, { recursive: true });

// Two crossing runways inside a ring, on the accent-blue background. `inset` shrinks art for the maskable safe zone.
const svg = ({ rounded, scale }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="#0071e3"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <circle cx="256" cy="256" r="170" fill="none" stroke="#ffffff" stroke-width="14"/>
    <g transform="rotate(-18 256 256)">
      <rect x="238" y="112" width="36" height="288" rx="5" fill="#ffffff"/>
      <path d="M256 126V386" stroke="#0071e3" stroke-width="4" stroke-dasharray="20 16"/>
    </g>
    <g transform="rotate(48 256 256) translate(0 24)">
      <rect x="245" y="156" width="22" height="170" rx="4" fill="#bcd9f8"/>
    </g>
  </g>
</svg>`;

writeFileSync(join(out, 'icon.svg'), svg({ rounded: true, scale: 1 }));

let browser;
for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) {
  try { browser = await chromium.launch(opts); break; } catch { /* try next */ }
}
if (!browser) throw new Error('No Chromium-based browser available');

const targets = [
  ['icon-192.png', 192, { rounded: true, scale: 1 }],
  ['icon-512.png', 512, { rounded: true, scale: 1 }],
  ['icon-maskable-512.png', 512, { rounded: false, scale: 0.78 }],
  ['apple-touch-icon.png', 180, { rounded: false, scale: 0.9 }],
  ['favicon-32.png', 32, { rounded: true, scale: 1 }],
];
const page = await browser.newPage();
for (const [name, size, opt] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg(opt)}`);
  await page.screenshot({ path: join(out, name), omitBackground: true });
  console.log('wrote', name);
}
await browser.close();
