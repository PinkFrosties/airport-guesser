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
    // a wrong guess is never shown as "0 km / 100%" (two different airports can share coordinates in the source data)
    km: correct ? 0 : Math.max(1, Math.round(km)),
    bearing,
    dir: compassLabel(bearing),
    pct: correct ? 100 : Math.min(99, proximityPct(km)),
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

// ---------- Wikipedia link: shown only on the result card, after the game has ended ----------
// The data stores only the article title in `wp` ("Zurich_Airport", or "de|Flughafen_Zürich" for another language);
// the URL is built here. Airports without a verified article get a Wikipedia SEARCH link built from their name
// (never a guessed article URL). The app itself never requests anything from Wikipedia.
const encodeTitle = (t) => encodeURIComponent(t).replace(/%28/g, '(').replace(/%29/g, ')').replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%27/g, "'").replace(/%2F/g, '/');
export function parseWp(wp) {
  const i = wp.indexOf('|');
  return i > 0 ? { lang: wp.slice(0, i), title: wp.slice(i + 1) } : { lang: 'en', title: wp };
}
/** { kind: 'article' | 'search', url } for an airport record. */
export function wikipediaLink(a) {
  if (a.wp) {
    const { lang, title } = parseWp(a.wp);
    return { kind: 'article', url: `https://${lang}.wikipedia.org/wiki/${encodeTitle(title)}` };
  }
  return { kind: 'search', url: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(a.name)}` };
}
/** Safety rule used by tests and the build: https, a wikipedia.org host, an article path or a search. */
export const isWikipediaUrl = (u) => /^https:\/\/[a-z-]+\.wikipedia\.org\/(wiki\/[^\s?#]+|w\/index\.php\?search=[^\s&#]+)$/.test(u);

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

// The Daily follows the player's LOCAL calendar date: everyone with the same date on their clock gets the same airport.
const pad2 = (n) => String(n).padStart(2, '0');
export const localDateString = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Milliseconds until the next local midnight (correct across DST changes: the Date constructor does the calendar maths). */
export const msUntilNextLocalDay = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();

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

// ---------- Daily: the busiest airports, no repeats until all of them have been used ----------
export const TOP_EPOCH = '2026-01-01'; // fixed: day 0 of the first cycle (never change, it would reshuffle every future day)
const DAY_MS = 86_400_000;
export const dayIndex = (dateStr) => Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(TOP_EPOCH + 'T00:00:00Z')) / DAY_MS);

export const TOP_MIN_GAP = 30; // days between two plays of the same airport, also across cycles
const cycleCache = new Map();
/**
 * The play order of cycle `c`. Cycle 0 is a fixed-seed shuffle. Each later cycle is a fixed-seed shuffle constrained so
 * that an airport is never played less than TOP_MIN_GAP days after its play in the previous cycle (so no 30-day window
 * ever contains a repeat, even across the reshuffle). Always feasible: at position j at least n - gap + j + 1 airports
 * are still eligible.
 */
function topCycle(top, c) {
  const key = `${top.map((a) => a.id).join(',')}:${c}`;
  if (cycleCache.has(key)) return cycleCache.get(key);
  const n = top.length;
  const base = [...top].sort((a, b) => (a.top ?? 0) - (b.top ?? 0) || a.id - b.id);
  const rnd = mulberry32(hashSeed(`airport-guesser:top:cycle:${c}`));
  let order;
  if (c <= 0) {
    order = base;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } else {
    const prev = topCycle(top, c - 1);
    const posPrev = new Map(prev.map((x, i) => [x.id, i]));
    const slack = n - Math.min(TOP_MIN_GAP, n - 1); // may appear at most this many places earlier than last time
    const remaining = base;
    order = [];
    for (let j = 0; j < n; j++) {
      const eligible = remaining.filter((x) => posPrev.get(x.id) <= j + slack);
      const pick = eligible[Math.floor(rnd() * eligible.length)];
      order.push(pick);
      remaining.splice(remaining.indexOf(pick), 1);
    }
  }
  cycleCache.set(key, order);
  return order;
}

/**
 * Candidate list for a UTC date: element 0 is the airport of the day (same for everyone), the rest is the fallback
 * order if its imagery cannot load. Day d plays position d mod n of cycle floor(d / n): every airport is used exactly
 * once per cycle, then the list is reshuffled with the next cycle's fixed seed.
 */
export function dailyTopOrder(top, dateStr) {
  const n = top.length;
  const d = dayIndex(dateStr);
  const c = Math.floor(d / n);
  const p = ((d % n) + n) % n;
  const order = topCycle(top, c);
  return [...order.slice(p), ...order.slice(0, p)];
}

export const DIFFICULTIES = {
  easy: { label: 'Major hubs', filter: (a) => a.tier === 1 },
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
// Keep in sync with scripts/build_data.py (the build writes each airport's zoom `z`; unit tests check parity).
export const MARGIN = 0.06;     // no runway endpoint closer than 6% of the frame to an edge
export const MAX_FILL = 0.78;   // hard maximum: the airfield box fills at most 78% of the frame, per dimension
export const MIN_FILL = 0.45;   // pool filter: when imagery caps the zoom, the airfield must still fill this much
export const MIN_BOX_M = 150;   // never zoom in tighter than a 150 m airfield
export const CHIPS_BOTTOM = 41; // px: the top corner chips (Airfield view, dots) end here
export const GAP = 6;           // px clearance kept around the chips and the attribution pill
const MPP_Z0 = 156543.03392;    // metres per pixel at zoom 0 on the equator
/** Reference frames (CSS px) and attribution pill height: phone (390 px wide) and desktop (1280x800). */
export const REF_PHONE = { W: 358, H: 371, pill: 27 };
export const REF_DESKTOP = { W: 604, H: 585, pill: 18 };
export const REF_FRAME = { W: REF_PHONE.W, H: REF_PHONE.H, retinaLevels: 2 }; // pool filter: reference phone, worst-case retina levels

/** Pixels per metre at zoom z, latitude lat. */
export const pxPerMetre = (z, lat) => 2 ** z / (MPP_Z0 * Math.cos(rad(lat)));

/** Fraction (0..1+) of the frame's limiting dimension that the airfield box (all runway endpoints) occupies at zoom z. */
export function fillAt(a, W, H, z) {
  const [clat, , w, h] = a.view;
  const k = pxPerMetre(z, clat);
  return Math.max((Math.max(w, MIN_BOX_M) * k) / W, (Math.max(h, MIN_BOX_M) * k) / H);
}

/**
 * The part of the frame the airfield must stay inside: edge margin all round, below the top corner chips and above the
 * attribution pill (both counted as occupied, full width, to be safe).
 */
export function safeRect(W, H, pill = REF_PHONE.pill, chipsBottom = CHIPS_BOTTOM) {
  return { l: MARGIN * W, r: W - MARGIN * W, t: Math.max(MARGIN * H, chipsBottom + GAP), b: H - Math.max(MARGIN * H, pill + GAP) };
}

/**
 * Largest WHOLE zoom at which every runway endpoint lies inside the safe rect and the airfield box fills at most MAX_FILL
 * of the frame in each dimension. Always rounds down (wider). The extents are those of the endpoints themselves, so this
 * is the exact condition for "all endpoints inside", whatever the runway angle.
 */
export function fitZoom(a, W, H, { pill = REF_PHONE.pill, chipsBottom = CHIPS_BOTTOM, minZoom = 8, maxZoom = 19 } = {}) {
  const r = safeRect(W, H, pill, chipsBottom);
  const [clat, , w, h] = a.view;
  const ex = Math.max(w, MIN_BOX_M), ey = Math.max(h, MIN_BOX_M);
  const ppm = Math.min(Math.min(MAX_FILL * W, r.r - r.l) / ex, Math.min(MAX_FILL * H, r.b - r.t) / ey);
  const z = Math.floor(Math.log2(ppm * MPP_Z0 * Math.cos(rad(clat))));
  return Math.max(minZoom, Math.min(maxZoom, z));
}

/** The airport's zoom for everyone: the smaller (wider) of the phone and desktop fits, written by the build as `a.z`. */
export const baseZoom = (a) => Math.min(fitZoom(a, REF_PHONE.W, REF_PHONE.H, { pill: REF_PHONE.pill }), fitZoom(a, REF_DESKTOP.W, REF_DESKTOP.H, { pill: REF_DESKTOP.pill }));

/** Pixels the airfield must be moved up (+) so its box is centred in the safe rect instead of the whole frame. */
export function airfieldLift(W, H, pill = REF_PHONE.pill, chipsBottom = CHIPS_BOTTOM) {
  const r = safeRect(W, H, pill, chipsBottom);
  return Math.round(H / 2 - (r.t + r.b) / 2);
}

/**
 * Extra tile levels to request: level = zoom + n, tiles drawn at 256/2^n CSS px. Capped at +1 (2 bitmap pixels per CSS
 * pixel): +2 would give a bit more detail on 3x screens but needs 3-4x as many tiles and is what made loading slow.
 * dpr 1 -> 0; above 1 -> 1.
 */
export const retinaLevels = (dpr) => (dpr > 1.0001 ? 1 : 0);

/** Highest map zoom whose tiles (level zoom+n) are still real, native-resolution imagery at this airport. */
export const maxSharpZoom = (a, n) => a.nz - n;

/**
 * Zoom actually used: the airport's zoom `a.z` (the same for everyone), never deeper than real imagery allows, and wider
 * still if this frame is smaller than the reference frames (so the airfield never leaves the frame, e.g. while typing).
 */
export function finalZoom(a, W, H, n, opts) {
  return Math.min(a.z ?? fitZoom(a, W, H, opts), maxSharpZoom(a, n), fitZoom(a, W, H, opts));
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
