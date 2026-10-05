// Minimal static file server for local development and tests.
//   node scripts/serve.mjs [port]            serves the source tree (ES modules); data/daily.json and the inlined Daily are generated on the fly
//   AG_ROOT=dist node scripts/serve.mjs      serves the built site (npm run build) instead
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, resolve } from 'node:path';
import { buildDaily, inlineSubset } from './daily_build.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

/** @param {string} [rootDir] directory to serve (default: AG_ROOT or the project root) */
export function createServer(rootDir = process.env.AG_ROOT || '.') {
  const root = resolve(projectRoot, rootDir);
  const isDist = root !== projectRoot;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      let body, type;
      if (!isDist && p === '/data/daily.json') { // source tree: same content the deploy build writes
        body = Buffer.from(JSON.stringify(buildDaily({ root: projectRoot })));
        type = TYPES['.json'];
      } else {
        const file = normalize(join(root, p));
        if (!file.startsWith(root) || file.includes(`${root}${'/node_modules'}`)) throw new Error('forbidden');
        if (!(await stat(file)).isFile()) throw new Error('nf');
        type = TYPES[extname(file)] || 'application/octet-stream';
        body = await readFile(file);
        if (!isDist && p === '/index.html') { // inline today's entry like the deploy build does
          const inline = `<script>window.__DAILY=${JSON.stringify(inlineSubset(buildDaily({ root: projectRoot })))}</script>`;
          body = Buffer.from(body.toString('utf8').replace('<!--@DAILY@-->', inline));
        }
      }
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
      // like GitHub Pages: compress text assets
      if (/^text\/|json|manifest|svg/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body); headers['Content-Encoding'] = 'gzip'; }
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 8080;
  createServer().listen(port, () => console.log(`Airport Guesser: http://localhost:${port}/ (${process.env.AG_ROOT || 'source tree'})`));
}
