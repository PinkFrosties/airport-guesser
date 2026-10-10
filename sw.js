// Service worker: instant repeat visits, offline shell, tile cache.
//  - The shell (HTML, hashed JS bundles, Leaflet, icons, today's schedule) is precached. The big airport lists are NOT
//    precached (they would compete with the first image's tiles); they are cached the first time they are fetched.
//  - HTML and data: stale-while-revalidate (instant from cache, refreshed in the background), so a new deploy never
//    causes a blank wait. Hashed files under /assets/ are immutable: cache first. Map tiles: cache first.
// VERSION is written by scripts/sync_version.mjs from js/version.js (the single source of truth). The deploy build
// (scripts/build_site.mjs) replaces the SHELL list with the hashed files it produced.
const VERSION = '1.4.3';
const DATA_BUILD = 'dev'; // written by the site build: a hash of the data file names, so sw.js is different whenever the data is
const CACHE = `airport-guesser-v${VERSION}`;
const TILE_CACHE = 'airport-guesser-tiles-v1'; // survives app updates: tiles never change with the app version
const TILE_LIMIT = 500; // roughly 10 MB
const SHELL = [/*SHELL*/
  './',
  'index.html',
  'manifest.webmanifest',
  'js/app.js',
  'js/core.js',
  'js/store.js',
  'js/config.js',
  'js/satview.js',
  'js/theme.js',
  'js/version.js',
  'js/extras.js',
  'js/tilemath.js',
  'data/daily.json',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'css/style.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
/*END*/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

const semver = (k) => k.replace('airport-guesser-v', '').split('.').map(Number);
const cmp = (a, b) => { const x = semver(a), y = semver(b); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); };

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      // keep the current and the previous app cache: a page still open from the previous version may load a lazy chunk
      const apps = keys.filter((k) => /^airport-guesser-v\d/.test(k)).sort(cmp);
      const drop = apps.slice(2).concat(keys.filter((k) => k.startsWith('airport-guesser-') && !/^airport-guesser-v\d/.test(k) && k !== TILE_CACHE));
      return Promise.all(drop.map((k) => caches.delete(k)));
    }).then(() => self.clients.claim()),
  );
});

// data files are named by content hash in the deployed site (data/airports.3fa9c1d2.json): cache first, forever
const HASHED_DATA = /\/data\/[\w-]+\.[0-9a-f]{8}\.json$/;
const TILE_RE = /\/World_Imagery\/MapServer\/tile\//;
/** Source-tree code (development server): prefer the network so edits show up, but never wait more than 700 ms. */
const isDevCode = (url) => /\/(js|css)\/[^/]+$/.test(url.pathname); // the built site has no /js/ or /css/ folders

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_RE.test(url.pathname) && /arcgisonline\.com$/.test(url.hostname)) { event.respondWith(tileResponse(req)); return; }
  if (url.origin !== self.location.origin) return;
  if (req.cache === 'reload' || req.cache === 'no-store') { event.respondWith(networkRefresh(req)); return; } // the page asked for a fresh copy (it found a stale one)
  if (/\/assets\//.test(url.pathname) || HASHED_DATA.test(url.pathname)) { event.respondWith(cacheFirst(req)); return; } // content-hashed files never change
  if (isDevCode(url)) { event.respondWith(networkFirst(req)); return; }
  event.respondWith(staleWhileRevalidate(req));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function networkRefresh(req) {
  const res = await fetch(req);
  if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = (await cache.match(req, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
  const network = fetch(req, { cache: 'no-cache' })
    .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  if (cached) { network.catch(() => {}); return cached; }
  const res = await network;
  if (res) return res;
  if (req.mode === 'navigate') { const shell = await caches.match('index.html'); if (shell) return shell; }
  return new Response('Offline', { status: 503 });
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req, { cache: 'no-cache' })
    .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  const res = cached ? await Promise.race([network, new Promise((r) => setTimeout(() => r(null), 700))]) : await network;
  return res || cached || new Response('Offline', { status: 503 });
}

// Tiles: cache first. A reload (or the same airport tomorrow) is served from the Cache API without touching the network.
async function tileResponse(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.type !== 'opaque') {
    await cache.put(req.url, res.clone());
    trimTiles(cache);
  }
  return res;
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys(); // oldest first
    for (const k of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT))) await cache.delete(k);
  } finally { trimming = false; }
}

// The page tells us which tiles it just showed (they are in the HTTP cache already): keep them for instant repeat visits.
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'cache-data' && Array.isArray(msg.urls)) { // the big lists: cache them once the page has them (HTTP cache hit, no competing download)
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      for (const u of msg.urls.slice(0, 4)) {
        if (!/^data\/[\w.-]+\.json$/.test(u) || (await cache.match(u))) continue;
        try { const res = await fetch(u); if (res.ok) await cache.put(u, res); } catch { /* offline: skip */ }
      }
    })());
    return;
  }
  if (!msg || msg.type !== 'cache-tiles' || !Array.isArray(msg.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(TILE_CACHE);
    for (const url of msg.urls.slice(0, 64)) {
      if (!TILE_RE.test(url) || (await cache.match(url))) continue;
      try { const res = await fetch(url, { mode: 'cors' }); if (res.ok) await cache.put(url, res); } catch { /* offline: skip */ }
    }
    trimTiles(cache);
  })());
});
