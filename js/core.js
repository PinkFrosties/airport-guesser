// Pure game logic. No DOM access, so it can be unit-tested in Node.

export const MAX_GUESSES = 5;
export const HALF_EARTH_KM = 20000;
const EARTH_RADIUS_KM = 6371.0088;

// ---------- geo ----------
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees [0,360) from point 1 toward point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassIndex(bearing) {
  return Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
}
export const compassLabel = (bearing) => COMPASS[compassIndex(bearing)];

export const proximityPct = (km) => Math.max(0, Math.min(100, Math.floor(100 * (1 - km / HALF_EARTH_KM))));

/** Feedback for guessing airport `g` when the answer is `a`. */
export function evaluateGuess(g, a) {
  const correct = g.id === a.id;
  const km = correct ? 0 : haversineKm(g.lat, g.lon, a.lat, a.lon);
  const bearing = correct ? 0 : bearingDeg(g.lat, g.lon, a.lat, a.lon);
  return {
    id: g.id,
    correct,
    km: Math.round(km),
    bearing,
    dir: compassLabel(bearing),
    pct: correct ? 100 : proximityPct(km),
  };
}

// ---------- text search ----------
const SPECIAL = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ı': 'i', 'ħ': 'h' };

/** Lower-case, strip diacritics, collapse punctuation to spaces. */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øłđðþßæœıħ]/g, (c) => SPECIAL[c])
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function prepareIndex(airports) {
  return airports.map((a) => ({
    a,
    name: normalize(a.name),
    city: normalize(a.city),
    iata: a.iata.toLowerCase(),
    icao: a.icao.toLowerCase(),
  }));
}

const wordStart = (hay, q) => hay.startsWith(q) || hay.includes(' ' + q);

function scoreEntry(e, q, tokens) {
  if (e.iata === q) return 0;
  if (e.icao === q) return 1;
  if (e.name.startsWith(q)) return 2;
  if (e.city.startsWith(q)) return 3;
  if (e.iata.startsWith(q) || e.icao.startsWith(q)) return 4;
  if (wordStart(e.name, q) || wordStart(e.city, q)) return 5;
  if (e.name.includes(q) || e.city.includes(q)) return 6;
  if (e.iata.includes(q) || e.icao.includes(q)) return 7;
  if (tokens.length > 1) {
    const all = `${e.name} ${e.city} ${e.iata} ${e.icao}`;
    if (tokens.every((t) => all.includes(t))) return 8;
  }
  return -1;
}

/** Ranked suggestions; excludes ids in `exclude`. */
export function search(index, query, { exclude = new Set(), limit = 6 } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const tokens = q.split(' ');
  const hits = [];
  for (const e of index) {
    if (exclude.has(e.a.id)) continue;
    const s = scoreEntry(e, q, tokens);
    if (s >= 0) hits.push({ s, e });
  }
  hits.sort((x, y) => x.s - y.s || x.e.a.tier - y.e.a.tier || x.e.name.localeCompare(y.e.name));
  return hits.slice(0, limit).map((h) => h.e.a);
}

export function suggestionLabel(a) {
  return `${a.name} · ${a.iata || a.icao} · ${a.city ? a.city + ', ' : ''}${a.countryCode}`;
}

// ---------- seeded RNG / daily ----------
export function hashSeed(str) {
  // xmur3
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const utcDateString = (d = new Date()) => d.toISOString().slice(0, 10);

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return utcDateString(d);
}

export const msUntilNextUtcDay = (now = new Date()) =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();

/** Deterministic ordering of `pool` for a UTC date. Element 0 is the airport of the day; later elements are
 *  the fallback order if imagery for earlier ones is unusable. `salt` gives each pool its own daily. */
export function dailyOrder(pool, dateStr, salt = '') {
  const list = [...pool].sort((a, b) => a.id - b.id);
  const rnd = mulberry32(hashSeed('airport-guesser:' + salt + dateStr));
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export const DIFFICULTIES = {
  easy: { label: 'Top 100', filter: (a) => a.tier === 1 },
  medium: { label: 'Large', filter: (a) => a.type === 'large' },
  hard: { label: 'Mid-size', filter: (a) => a.type === 'medium' },
};

/** Random candidate order for practice (all candidates, shuffled). */
export function practiceOrder(pool, difficulty, rnd = Math.random) {
  const list = difficulty && DIFFICULTIES[difficulty] ? pool.filter(DIFFICULTIES[difficulty].filter) : [...pool];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ---------- locked view: zoom that fits the airfield, sharp on any screen ----------
export const FILL = 0.75;       // target: airfield box fills ~75% of the limiting frame dimension
export const MAX_FILL = 0.9;    // rounding up to the next whole zoom is allowed while the box stays within 90%
export const MIN_FILL = 0.45;   // pool quality filter: below this the airfield is too small in the frame ("about 50%")
export const MIN_BOX_M = 150;   // never zoom in tighter than a 150 m airfield
const MPP_Z0 = 156543.03392;    // metres per pixel at zoom 0 on the equator
export const REF_FRAME = { W: 358, H: 371, retinaLevels: 2 }; // reference phone frame used by the build-time pool filter

/** Pixels per metre at zoom z, latitude lat. */
export const pxPerMetre = (z, lat) => 2 ** z / (MPP_Z0 * Math.cos(rad(lat)));

/** Fraction (0..1+) of the viewport's limiting dimension that the airfield box occupies at zoom z. */
export function fillAt(a, W, H, z) {
  const [clat, , w, h] = a.view;
  const k = pxPerMetre(z, clat);
  return Math.max((Math.max(w, MIN_BOX_M) * k) / W, (Math.max(h, MIN_BOX_M) * k) / H);
}

/**
 * Whole zoom at which the airfield box fills ~75% of the viewport (rounded up when that still fits within 90%).
 * Integer zoom only: Leaflet then never rescales a tile layer with a CSS transform.
 */
export function fitZoom(a, W, H, { minZoom = 8, maxZoom = 19 } = {}) {
  const [clat, , w, h] = a.view;
  const ppm = Math.min((FILL * W) / Math.max(w, MIN_BOX_M), (FILL * H) / Math.max(h, MIN_BOX_M));
  const zl = Math.floor(Math.log2(ppm * MPP_Z0 * Math.cos(rad(clat))));
  const z = fillAt(a, W, H, zl + 1) <= MAX_FILL ? zl + 1 : zl;
  return Math.max(minZoom, Math.min(maxZoom, z));
}

/**
 * Extra tile levels to request: level = zoom + n, tiles drawn at 256/2^n CSS px. Capped at +1 (2 bitmap pixels per CSS
 * pixel): +2 would give a bit more detail on 3x screens but needs 3-4x as many tiles and is what made loading slow.
 * dpr 1 -> 0; above 1 -> 1.
 */
export const retinaLevels = (dpr) => (dpr > 1.0001 ? 1 : 0);

/** Highest map zoom whose tiles (level zoom+n) are still real, native-resolution imagery at this airport. */
export const maxSharpZoom = (a, n) => a.nz - n;

/** Zoom actually used: the fitted zoom, but never deeper than real imagery allows (smaller airport beats a blurry one). */
export function finalZoom(a, W, H, n, opts) {
  return Math.min(fitZoom(a, W, H, opts), maxSharpZoom(a, n));
}

/** Tile block (at level zoom+n) covering the viewport, plus a one-tile margin. */
export function tileBlock(a, W, H, z, n) {
  const [clat, clon] = a.view;
  const L = z + n;
  const tiles = 2 ** L;
  const latR = rad(clat);
  const fx = ((clon + 180) / 360) * tiles;
  const fy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * tiles;
  const css = 256 / 2 ** n; // CSS px per tile
  const hx = W / 2 / css + 1;
  const hy = H / 2 / css + 1;
  const x0 = Math.max(0, Math.floor(fx - hx));
  const x1 = Math.min(tiles - 1, Math.floor(fx + hx));
  const y0 = Math.max(0, Math.floor(fy - hy));
  const y1 = Math.min(tiles - 1, Math.floor(fy + hy));
  return { z: L, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export const ZOOM_OUT_LEVELS = 2;
export const zoomedOut = (z) => Math.max(2, z - ZOOM_OUT_LEVELS);

// ---------- hints ----------
export const CONTINENT_NAMES = { AF: 'Africa', AN: 'Antarctica', AS: 'Asia', EU: 'Europe', NA: 'North America', OC: 'Oceania', SA: 'South America' };

export const HINTS = [
  { key: 'continent', label: 'Continent', value: (a) => CONTINENT_NAMES[a.continent] || a.continent },
  { key: 'country', label: 'Country', value: (a) => a.country },
  { key: 'letter', label: 'First letter of name', value: (a) => a.name.trim().charAt(0).toUpperCase() },
  { key: 'runways', label: 'Number of runways', value: (a) => String(a.rw), available: (a) => a.rw > 0 },
];
export const hintAvailable = (h, a) => (h.available ? h.available(a) : true);

/** Attempts left. Every guess, hint and zoom-out spends one. */
export const attemptsLeft = (spent) => MAX_GUESSES - spent;
/** Hints and zoom-out are only offered while at least 2 attempts remain (spending the last one would just end the game). */
export const canSpend = (spent) => attemptsLeft(spent) >= 2;

// ---------- share ----------
export function bandSquare(r) {
  if (r.correct) return '\u{1F7E9}'; // green
  if (r.km < 500) return '\u{1F7E8}'; // yellow
  if (r.km < 2000) return '\u{1F7E7}'; // orange
  if (r.km < 5000) return '\u{1F7E5}'; // red
  return '⬛'; // black
}
const ARROWS = ['⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️'];
export const arrowEmoji = (bearing) => ARROWS[compassIndex(bearing)];

/**
 * Never includes anything identifying the answer (or which hint was used).
 * `entries`: in play order, each a guess result (evaluateGuess output), {hint:true} or {zoom:true}.
 */
export function buildShareText({ entries, won, title, url }) {
  const score = won ? `${entries.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  const lines = entries.map((e) => {
    if (e.hint) return '💡'; // light bulb
    if (e.zoom) return '🔭'; // telescope
    return e.correct ? `${bandSquare(e)} 🎯` : `${bandSquare(e)} ${arrowEmoji(e.bearing)}`;
  });
  return [`Airport Guesser — ${title}`, score, '', ...lines, ...(url ? ['', url] : [])].join('\n');
}

// ---------- imagery tile probe ----------
export function tileCoords(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latR = rad(lat);
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)), z };
}
