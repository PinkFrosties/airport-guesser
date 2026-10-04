// Minimal static file server for local development and tests.  Usage: node scripts/serve.mjs [port]
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(root, p));
      if (!file.startsWith(root) || file.includes(`${root}${'/node_modules'}`)) throw new Error('forbidden');
      if (!(await stat(file)).isFile()) throw new Error('nf');
      const type = TYPES[extname(file)] || 'application/octet-stream';
      let body = await readFile(file);
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
  createServer().listen(port, () => console.log(`Airport Guesser: http://localhost:${port}/`));
}
