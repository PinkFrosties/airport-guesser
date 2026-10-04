// Caches the app shell and airport data. Map tiles (cross-origin) always go to the network.
// Bump VERSION when shipping changes so old caches are dropped.
const VERSION = 'v7';
const CACHE = `airport-guesser-${VERSION}`;
// Map tiles live in their own cache that survives app updates (they never change with the app version).
const TILE_CACHE = 'airport-guesser-tiles-v1';
const TILE_LIMIT = 500; // roughly 10 MB
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/core.js',
  'js/store.js',
  'js/config.js',
  'js/satview.js',
  'js/theme.js',
  'data/airports.json',
  'data/airports-hard.json',
  'data/credits.json',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('airport-guesser-') && k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Code (HTML/JS/CSS/manifest) is network-first so a new deploy shows up on the next load; data, vendor files and
// icons are stale-while-revalidate. Both fall back to the cache offline.
const isCode = (req, url) => req.mode === 'navigate' || /\.(js|css|html|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/\/World_Imagery\/MapServer\/tile\//.test(url.pathname) && /arcgisonline\.com$/.test(url.hostname)) {
    event.respondWith(tileResponse(req));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req, isCode(req, url) ? { cache: 'no-cache' } : undefined)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached && !isCode(req, url)) { network.catch(() => {}); return cached; }
      // code: prefer the network (fresh deploys), but never make a slow connection wait: fall back to the cached copy after 700 ms
      const res = cached ? await Promise.race([network, new Promise((r) => setTimeout(() => r(null), 700))]) : await network;
      if (res) return res;
      if (cached) return cached;
      if (req.mode === 'navigate') return cache.match('index.html');
      return new Response('Offline', { status: 503 });
    }),
  );
});

// Tiles: cache-first. A reload (or the same airport tomorrow) is served from the Cache API without touching the network.
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
