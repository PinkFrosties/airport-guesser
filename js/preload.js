// Inline preloader (the deploy build inlines a minified copy right after the image frame in index.html).
// It runs as soon as the frame has its size and today's schedule is in the page: it works out exactly which map tiles
// the first view needs and starts fetching them, before the app's JavaScript has even been downloaded. The app then
// finds the tiles in the HTTP cache. Same maths as the app (core.js fit + tilemath.js), so the requests are identical.
import { IMAGERY } from './config.js';
import { retinaLevels, finalZoom, airfieldLift, localDateString, REF_PHONE, REF_DESKTOP, CHIPS_BOTTOM } from './core.js';
import { tilesForView, shiftedCenter } from './tilemath.js';

(function preloadFirstView() {
  try {
    const daily = window.__DAILY;
    const stage = document.getElementById('stage');
    if (!daily || !stage) return;
    const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
    const prefs = read('airportGuesser.prefs.v2') || {};
    if (prefs.mode === 'practice') return; // a random airport: nothing to know in advance
    const kind = prefs.hard ? 'hard' : 'daily';
    const date = localDateString();
    const day = daily.days && daily.days[date];
    if (!day) return;
    const saved = read(kind === 'hard' ? 'airportGuesser.hardDaily.v2' : 'airportGuesser.daily.v2');
    const candidates = day[kind];
    const answer = (saved && saved.date === date && candidates.find((c) => c.id === saved.id)) || candidates[0];
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    const n = retinaLevels(window.devicePixelRatio || 1);
    const pill = W < 520 ? REF_PHONE.pill : REF_DESKTOP.pill;
    const z = finalZoom(answer, W, H, n, { minZoom: IMAGERY.minZoom, maxZoom: IMAGERY.maxZoom - n, pill });
    const center = shiftedCenter(answer.view[0], answer.view[1], z, airfieldLift(W, H, pill, CHIPS_BOTTOM));
    // fetch(), not new Image(): a fetch does not hold up the page's load event, and a CORS fetch fills the same HTTP cache entry
    // that the map's <img crossorigin> tiles will read (they wait for it instead of sending a second request).
    window.__preloadedTiles = tilesForView(IMAGERY, n, center, z, W, H).map((url) => fetch(url, { mode: 'cors' }).then((r) => r.blob()).catch(() => null));
  } catch { /* the app does everything itself if this fails */ }
}());
