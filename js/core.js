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
  return `${a.name} · ${a.iata} · ${a.city ? a.city + ', ' : ''}${a.countryCode}`;
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

export const DAILY_POOL = (airports) => airports.filter((a) => a.type === 'large').sort((a, b) => a.id - b.id);

/** Deterministic ordering of the pool for a UTC date. Element 0 is the airport of the day;
 *  later elements are the fallback order if imagery for earlier ones is unavailable. */
export function dailyOrder(airports, dateStr) {
  const pool = DAILY_POOL(airports);
  const rnd = mulberry32(hashSeed('airport-guesser:' + dateStr));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export const DIFFICULTIES = {
  easy: { label: 'Easy', filter: (a) => a.tier === 1 },
  medium: { label: 'Medium', filter: (a) => a.type === 'large' },
  hard: { label: 'Hard', filter: (a) => a.type === 'medium' },
};

/** Random candidate order for practice (all candidates, shuffled). */
export function practiceOrder(airports, difficulty, rnd = Math.random) {
  const pool = airports.filter(DIFFICULTIES[difficulty].filter);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// ---------- hints ----------
const CONTINENT_ZOOM = { EU: 4, AS: 3, AF: 3, NA: 3, SA: 3, OC: 3, AN: 2 };

/** Map zoom for the next view given how many guesses have been missed so far (0..4). */
export function zoomForMisses(a, misses) {
  const z0 = a.z;
  if (misses <= 0) return z0;
  if (misses === 1) return z0 - 1;
  if (misses === 2) return z0 - 2;
  const cont = CONTINENT_ZOOM[a.continent] ?? 3;
  if (misses === 3) return cont;
  return Math.max(a.cz, cont + 1);
}

export const HINT_LABELS = ['Airfield', 'Wider view', 'Regional view', 'Continent view', 'Country view'];

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

/** Never includes anything identifying the answer. `results` = evaluateGuess outputs. */
export function buildShareText({ results, won, title, url }) {
  const score = won ? `${results.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  const lines = results.map((r) => (r.correct ? `${bandSquare(r)} \u{1F3AF}` : `${bandSquare(r)} ${arrowEmoji(r.bearing)}`));
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
