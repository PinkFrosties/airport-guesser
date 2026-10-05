// Builds the deployable site into dist/ (GitHub Pages serves that folder).  Usage: node scripts/build_site.mjs
//  - bundles and minifies the JS (one critical bundle + a lazy "extras" chunk), content-hashed file names
//  - inlines the minified CSS, the theme/Daily scripts and an inline preloader that starts the first tile requests
//  - writes data/daily.json (the next two weeks of Daily airports) and inlines yesterday/today/tomorrow into the HTML
//  - writes sw.js with the real file list
// The source tree keeps working without this step (it just loads more files); tests run against both.
import { build, transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { buildDaily, inlineSubset } from './daily_build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const read = (p) => readFileSync(join(root, p), 'utf8');
const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);
const version = read('js/version.js').match(/APP_VERSION = '(\d+\.\d+\.\d+)'/)[1];
const now = new Date();

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'assets'), { recursive: true });
mkdirSync(join(dist, 'data'), { recursive: true });

// ---- JS: critical bundle + lazy chunks
const result = await build({
  entryPoints: [join(root, 'js/app.js')], bundle: true, splitting: true, format: 'esm', minify: true, target: ['es2020'], legalComments: 'none',
  outdir: join(dist, 'assets'), entryNames: 'app-[hash]', chunkNames: 'chunk-[hash]', metafile: true, write: true,
});
const outputs = Object.keys(result.metafile.outputs).map((p) => relative(dist, p).split('\\').join('/'));
const appFile = outputs.find((f) => /assets\/app-/.test(f));
const chunks = outputs.filter((f) => f !== appFile);

// ---- the inline preloader (classic script)
const pre = await build({ entryPoints: [join(root, 'js/preload.js')], bundle: true, format: 'iife', minify: true, target: ['es2020'], write: false, legalComments: 'none' });
const preloadJs = pre.outputFiles[0].text.trim();

// ---- CSS: Leaflet's + ours, minified, inlined
const css = (await transform(read('vendor/leaflet/leaflet.css') + '\n' + read('css/style.css'), { loader: 'css', minify: true })).code.trim();

// ---- Leaflet (already minified): copy with a hashed name
const leafletSrc = readFileSync(join(root, 'vendor/leaflet/leaflet.js'));
const leafletFile = `assets/leaflet-${hash(leafletSrc)}.js`;
writeFileSync(join(dist, leafletFile), leafletSrc);

// ---- schedule
const daily = buildDaily({ root, now });
writeFileSync(join(dist, 'data/daily.json'), JSON.stringify(daily));
const inline = JSON.stringify(inlineSubset(daily, now));

// ---- HTML
let html = read('index.html');
const sub = (re, to, label) => { if (!re.test(html)) throw new Error('index.html: no match for ' + label); html = html.replace(re, to); };
sub(/<!--@DAILY@-->/, () => `<script>window.__DAILY=${inline}</script>`, 'daily placeholder');
sub(/<link rel="stylesheet" href="vendor\/leaflet\/leaflet\.css">\s*/, () => `<style>${css}</style>\n`, 'leaflet stylesheet');
sub(/<link rel="stylesheet" href="css\/style\.css">\s*/, '', 'app stylesheet');
sub(/<link rel="modulepreload" href="js\/app\.js">\s*/, () => `<link rel="modulepreload" href="${appFile}">\n`, 'app modulepreload');
html = html.replace(/<link rel="modulepreload" href="js\/[^"]*">\s*/g, ''); // the other modules are inside the bundle
sub(/<script src="vendor\/leaflet\/leaflet\.js"><\/script>\s*<script type="module" src="js\/app\.js"><\/script>/, `<script>${preloadJs}</script>\n<script defer src="${leafletFile}"></script>\n<script type="module" src="${appFile}"></script>`, 'scripts');
html = html.replace(/<!--(?!\[)[\s\S]*?-->/g, '').replace(/\n\s+/g, '\n').replace(/\n{2,}/g, '\n').trim() + '\n';
// Opt-in Content-Security-Policy (proposal, tested; not enabled): AG_CSP=1 node scripts/build_site.mjs. Inline scripts are allowed by hash only.
if (process.env.AG_CSP) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => "'sha256-" + createHash('sha256').update(m[1]).digest('base64') + "'");
  const csp = [
    "default-src 'none'",
    "script-src 'self' " + hashes.join(' '),
    "style-src 'self' 'unsafe-inline'", // inline <style> and style="" attributes (Leaflet positions tiles with inline styles)
    "img-src 'self' data: blob: https://services.arcgisonline.com https://server.arcgisonline.com",
    "connect-src 'self' https://services.arcgisonline.com https://server.arcgisonline.com",
    "manifest-src 'self'", "worker-src 'self'", "font-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + csp + '">');
}
writeFileSync(join(dist, 'index.html'), html);

// ---- static files
for (const dir of ['icons']) cpSync(join(root, dir), join(dist, dir), { recursive: true });
for (const f of ['manifest.webmanifest', '.nojekyll']) cpSync(join(root, f), join(dist, f));
for (const f of ['airports.json', 'airports-hard.json', 'credits.json', 'top50.json']) cpSync(join(root, 'data', f), join(dist, 'data', f));
writeFileSync(join(dist, '404.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Page not found - Airport Guesser</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;text-align:center;background:#f5f5f7;color:#1d1d1f}a{color:#0066cc}@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}a{color:#64b0ff}}</style></head><body><main><h1>Page not found</h1><p><a href="./">Back to Airport Guesser</a></p></main></body></html>\n`);

// ---- service worker with the real shell list
const shell = ['./', 'index.html', 'manifest.webmanifest', 'data/daily.json', leafletFile, ...outputs, 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png', 'icons/apple-touch-icon.png'];
let sw = read('sw.js');
if (!/\/\*SHELL\*\/[\s\S]*?\/\*END\*\//.test(sw)) throw new Error('sw.js: SHELL markers missing');
sw = sw.replace(/\/\*SHELL\*\/[\s\S]*?\/\*END\*\//, `/*SHELL*/\n${shell.map((s) => `  '${s}',`).join('\n')}\n/*END*/`);
writeFileSync(join(dist, 'sw.js'), sw);

// ---- report
const files = [];
(function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(p); } }(dist));
const rows = files.map((p) => { const b = readFileSync(p); return { file: relative(dist, p).split('\\').join('/'), raw: b.length, gzip: /\.(png)$/.test(p) ? b.length : gzipSync(b, { level: 9 }).length, brotli: /\.(png)$/.test(p) ? b.length : brotliCompressSync(b).length }; });
writeFileSync(join(dist, 'build-info.json'), JSON.stringify({ version, built: now.toISOString(), files: rows }, null, 1));
console.log(`built v${version} into dist/ (${rows.length} files)`);
console.table(rows.filter((r) => !/icons\//.test(r.file)).map((r) => ({ file: r.file, 'raw KB': +(r.raw / 1024).toFixed(1), 'gzip KB': +(r.gzip / 1024).toFixed(1), 'brotli KB': +(r.brotli / 1024).toFixed(1) })));
console.log('critical path (HTML + app bundle + Leaflet), gzip KB:', +(rows.filter((r) => r.file === 'index.html' || r.file === appFile || r.file === leafletFile).reduce((s, r) => s + r.gzip, 0) / 1024).toFixed(1));
