// The single place that knows WHERE the big data files are and checks that what came back is the data this build expects.
//
//  - The deployed site names its data files by content hash (data/airports.3fa9c1d2.json, written by scripts/build_site.mjs and announced to the page
//    in window.__AG_DATA), so a service-worker or HTTP cache can never hand a new page an old file: a new file has a new URL.
//  - The source tree (and the dev server) uses the plain names, so every file is also checked by content: the schema number must match and nearly
//    every airport must carry its third clue. A stale file is fetched again with the caches bypassed; if it is still wrong, a console error says so.

/** Bump when the shape or meaning of the data files changes (scripts/build_data.py writes it into meta.schema). */
export const DATA_SCHEMA = 3;

const PLAIN = { full: 'data/airports.json', hard: 'data/airports-hard.json', top50: 'data/top50.json', credits: 'data/credits.json' };
export const dataUrl = (key) => (globalThis.__AG_DATA && globalThis.__AG_DATA[key]) || PLAIN[key];

const THIRD_CLUE = /^(airline|airlinec|region|grid|elev|zone)\|.+/;
/** { ok, reason } for an airports file: right schema, plausible size, and (nearly) every record has a third clue. */
export function checkAirports(data, key) {
  const list = data && data.airports;
  if (!Array.isArray(list) || !list.length) return { ok: false, reason: 'no airports' };
  if (!data.meta || data.meta.schema !== DATA_SCHEMA) return { ok: false, reason: `schema ${data.meta && data.meta.schema} (expected ${DATA_SCHEMA})` };
  const missing = list.filter((a) => !THIRD_CLUE.test(a.hint3 || '')).length;
  if (missing / list.length > 0.002) return { ok: false, reason: `${missing} of ${list.length} airports have no third clue` };
  if (key === 'full' && list.length < 1000) return { ok: false, reason: `only ${list.length} airports` };
  return { ok: true, missing };
}

async function getJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/** Load one data file. `low`: low fetch priority (background loads must not compete with the first image's tiles). */
export async function loadData(key, { low = false } = {}) {
  const url = dataUrl(key);
  let data = await getJson(url, low ? { priority: 'low' } : undefined);
  if (key !== 'full' && key !== 'hard') return data;
  let check = checkAirports(data, key);
  if (!check.ok) { // a stale copy from a cache: ask the network once, bypassing every cache
    console.warn(`[airport-guesser] ${url} is stale (${check.reason}); fetching it again`);
    data = await getJson(url, { cache: 'reload' });
    check = checkAirports(data, key);
    if (!check.ok) console.error(`[airport-guesser] ${url} is not the data this version expects: ${check.reason}`);
  }
  return data;
}
