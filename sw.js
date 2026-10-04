// Caches the app shell and airport data. Map tiles (cross-origin) always go to the network.
// Bump VERSION when shipping changes so old caches are dropped.
const VERSION = 'v1';
const CACHE = `airport-guesser-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/core.js',
  'js/store.js',
  'js/config.js',
  'data/airports.json',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/fonts/instrument-serif-latin-400-normal.woff2',
  'vendor/fonts/instrument-serif-latin-ext-400-normal.woff2',
  'vendor/fonts/instrument-serif-latin-400-italic.woff2',
  'vendor/fonts/hanken-grotesk-latin-wght-normal.woff2',
  'vendor/fonts/hanken-grotesk-latin-ext-wght-normal.woff2',
  'vendor/fonts/jetbrains-mono-latin-400-normal.woff2',
  'vendor/fonts/jetbrains-mono-latin-500-normal.woff2',
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('airport-guesser-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate for same-origin GETs; navigations fall back to the cached shell offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) { network.catch(() => {}); return cached; }
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') return cache.match('index.html');
      return new Response('Offline', { status: 503 });
    }),
  );
});
