// Caches the app shell and airport data. Map tiles (cross-origin) always go to the network.
// Bump VERSION when shipping changes so old caches are dropped.
const VERSION = 'v3';
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
  'data/airports-hard.json',
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('airport-guesser-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Code (HTML/JS/CSS/manifest) is network-first so a new deploy shows up on the next load; data, vendor files and
// icons are stale-while-revalidate. Both fall back to the cache offline.
const isCode = (req, url) => req.mode === 'navigate' || /.(js|css|html|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
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
      const res = await network;
      if (res) return res;
      if (cached) return cached;
      if (req.mode === 'navigate') return cache.match('index.html');
      return new Response('Offline', { status: 503 });
    }),
  );
});
