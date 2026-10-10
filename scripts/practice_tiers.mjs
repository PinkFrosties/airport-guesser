// Practice tiers (v1.4.0). Build time only: nothing here runs in the app, which just reads `tier` / `ps` / `py` from data/*.json.
//
//   node scripts/practice_tiers.mjs [--refresh] [--report]
//
// Three disjoint tiers (an airport is in at most one; the rest stay available in Hard and in autocomplete):
//   1 Major hubs  100 airports: ranks 1-50 = the Daily list (ACI World 2025, data/top50.json); ranks 51-100 = the next 50 by Wikidata
//                 passenger count (P3872, the latest year per airport: 2023-2025 preferred, otherwise 2019-2022), matched by IATA / ICAO to airports that exist in
//                 our data (so closed, duplicate and image-quality failures are already out), minus anything in the top 50.
//   2 Large       NOT tier 1, third hint = Main airline (the confident rule of scripts/hint_data.py), not excluded, playability >= T2
//   3 Mid-size    NOT tier 1/2, third hint is not Main airline, scheduled service (OurAirports scheduled_service = yes, or an IATA code and at
//                 least 1 OpenFlights route), not excluded, playability >= T3
// Playability score 0-100 (see scoreFeatures): fame 25, service 30, imagery 25, distinctiveness 10, hint quality 10.
// Output: data/tiers.json (tier, score and the features the score is computed from, so tests can reproduce every score).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as C from '../js/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => join(root, ...p);
const CACHE = P('scripts/.cache');
mkdirSync(CACHE, { recursive: true });
const UA = 'airport-guesser-build/1.0 (https://github.com/PinkFrosties/airport-guesser)';

// ---------------- the formula (the one place it is defined; tests import it) ----------------
export const WEIGHTS = { fame: 25, service: 30, imagery: 25, distinct: 10, hint: 10 };
export const T2 = 55;   // minimum playability of a tier-2 (Large) airport
export const T3 = 64;   // minimum playability of a tier-3 (Mid-size) airport
export const PAX_YEARS = [2019, 2025];   // accepted years; an airport's latest figure wins, so 2023-2025 is preferred when it exists
const lg = (x, cap) => Math.min(1, Math.log1p(Math.max(0, x)) / Math.log1p(cap));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** f = { article, sites, sched, routes, dests, contrast, fill, head, rw, len, paved, hint } -> integer 0..100 */
export function scoreFeatures(f) {
  const fame = (f.article ? 8 : 0) + 17 * lg(f.sites, 80);                                   // a Wikipedia article (8) + language editions on Wikidata (17, saturating at 80)
  const service = (f.sched ? 6 : 0) + 12 * lg(f.routes, 120) + 12 * lg(f.dests, 80);         // scheduled service (6) + OpenFlights routes (12) + destinations (12)
  const imagery = 10 * clamp01((f.contrast ?? 12) / 30) + 8 * clamp01((f.fill - 0.45) / 0.33) + 7 * clamp01(f.head / 3); // runway contrast (10), airfield fill of the frame (8), levels of real imagery to zoom into (7)
  const distinct = f.rw >= 2 ? 10 : f.rw === 1 ? (f.len >= 1800 ? (f.paved ? 8 : 4) : f.len >= 1200 ? (f.paved ? 4 : 2) : f.paved ? 1 : 0) : 0; // two runways, or a long paved one
  const hint = { airline: 10, region: 7, grid: 4, elev: 2 }[f.hint] ?? 0;                    // a clue that exists and does not give it away; elevation-only is penalised
  return Math.round(Math.min(100, fame + service + imagery + distinct + hint));
}
export const EXCLUDE = /\b(air base|air force|afb|army|aaf|naval|navy|marine corps|military|raf|usaf|air station|heliport|helipad|seaplane|water aerodrome|floatplane|glider|ultralight|balloon)\b/i;

// ---------------- helpers ----------------
function csv(txt) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  const h = rows.shift();
  return rows.filter((r) => r.length === h.length).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
async function sparql(name, query, refresh) {
  const file = join(CACHE, name);
  if (!refresh && existsSync(file)) return readJson(file);
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
      const txt = await r.text();
      const rows = JSON.parse(txt).results.bindings;
      writeFileSync(file, JSON.stringify(rows));
      return rows;
    } catch (e) { console.log('  wikidata attempt', i + 1, 'failed:', String(e.message).slice(0, 80)); await new Promise((r) => setTimeout(r, 8000 * (i + 1))); }
  }
  throw new Error('Wikidata query failed: ' + name);
}
const v = (r, k) => (r[k] ? r[k].value : '');

// ---------------- build ----------------
export async function build({ refresh = false } = {}) {
  const main = readJson(P('data/airports.json')).airports;
  const hard = readJson(P('data/airports-hard.json')).airports;
  const all = [...main, ...hard];
  const top50 = readJson(P('data/top50.json'));
  const topIds = new Set(main.filter((a) => a.top).map((a) => a.id));
  if (topIds.size !== 50) throw new Error('expected the 50 Daily airports');

  // ---- sources on disk (build_data.py downloads them)
  const apt = new Map(csv(readFileSync(join(CACHE, 'airports.csv'), 'utf8')).map((r) => [+r.id, r]));
  const rwy = new Map();
  for (const r of csv(readFileSync(join(CACHE, 'runways.csv'), 'utf8'))) {
    if (r.closed === '1') continue;
    const e = rwy.get(+r.airport_ref) || rwy.set(+r.airport_ref, { n: 0, len: 0, paved: false }).get(+r.airport_ref);
    e.n++; const m = (+r.length_ft || 0) * 0.3048;
    if (m > e.len) { e.len = m; e.paved = /^(ASP|CON|PEM|BIT|TAR|PAV|ASPH|CONC|MAC|PSP)/i.test(r.surface || ''); }
  }
  const routes = new Map(), dests = new Map();
  for (const l of readFileSync(join(CACHE, 'routes.dat'), 'utf8').split('\n')) {
    const c = l.split(','); if (c.length < 8 || c[6] === 'Y' || !c[2] || c[2] === '\\N') continue;
    routes.set(c[2], (routes.get(c[2]) || 0) + 1);
    (dests.get(c[2]) || dests.set(c[2], new Set()).get(c[2])).add(c[4]);
  }
  const contrast = existsSync(join(CACHE, 'contrast.json')) ? readJson(join(CACHE, 'contrast.json')) : {};

  // ---- Wikidata (build time only, cached): language editions and passenger counts
  const sitesRows = [...await sparql('wd_sitelinks_icao.json', 'SELECT ?code ?n WHERE { ?apt wdt:P239 ?code ; wikibase:sitelinks ?n }', refresh), ...await sparql('wd_sitelinks_faa.json', 'SELECT ?code ?n WHERE { ?apt wdt:P240 ?code ; wikibase:sitelinks ?n }', refresh), ...await sparql('wd_sitelinks_iata.json', 'SELECT ?code ?n WHERE { ?apt wdt:P238 ?code ; wikibase:sitelinks ?n }', refresh)];
  const sites = new Map();
  for (const r of sitesRows) { const k = v(r, 'code'), n = +v(r, 'n'); if (k && n > (sites.get(k) || 0)) sites.set(k, n); }
  const paxRows = await sparql('wd_pax3.json', 'SELECT ?apt ?aptLabel ?icao ?iata ?faa ?pax ?t WHERE { ?apt p:P3872 ?st . ?st ps:P3872 ?pax ; pq:P585 ?t . FILTER(YEAR(?t) >= 2019 && YEAR(?t) <= 2025) OPTIONAL { ?apt wdt:P239 ?icao } OPTIONAL { ?apt wdt:P238 ?iata } OPTIONAL { ?apt wdt:P240 ?faa } SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } }', refresh);
  const byCode = new Map();
  for (const a of all) for (const k of [a.icao, a.iata]) if (k && !byCode.has(k)) byCode.set(k, a);
  const best = new Map(); // wikidata item -> latest year, then largest figure
  for (const r of paxRows) {
    const key = v(r, 'apt'), year = +v(r, 't').slice(0, 4), pax = +v(r, 'pax');
    if (year < PAX_YEARS[0] || year > PAX_YEARS[1] || !(pax >= 1e6 && pax <= 1.3e8)) continue; // older years and aggregates / nonsense are discarded
    const cur = best.get(key);
    if (!cur || year > cur.year || (year === cur.year && pax > cur.pax)) best.set(key, { year, pax, label: v(r, 'aptLabel'), codes: [v(r, 'icao'), v(r, 'iata'), v(r, 'faa')].filter(Boolean) });
  }
  const paxAirports = new Map(); // our airport id -> { pax, year }
  for (const e of best.values()) {
    const a = e.codes.map((c) => byCode.get(c)).find(Boolean);
    if (!a || topIds.has(a.id)) continue;
    const cur = paxAirports.get(a.id);
    if (!cur || e.year > cur.year || (e.year === cur.year && e.pax > cur.pax)) paxAirports.set(a.id, { pax: e.pax, year: e.year, a });
  }
  const ranked = [...paxAirports.values()].sort((x, y) => y.pax - x.pax);
  const rawPax = [...best.values()].map((e) => { const a = e.codes.map((c) => byCode.get(c)).find(Boolean); return { id: a ? a.id : 0, a, pax: e.pax, year: e.year, label: (e.codes.find((c) => /^[A-Z]{3}$/.test(c)) || e.codes[0] || '') + ' ' + e.label }; }).sort((x, y) => y.pax - x.pax);

  // ---- features and scores for every airport
  const feat = {};
  for (const a of all) {
    const src = apt.get(a.id) || {}; const r = rwy.get(a.id) || { n: 0, len: 0, paved: false };
    const c = contrast[a.id];
    feat[a.id] = {
      article: a.wp && !/^$/.test(a.wp) ? 1 : 0,
      sites: Math.max(sites.get(a.icao) || 0, sites.get(a.iata) || 0),
      sched: src.scheduled_service === 'yes' ? 1 : 0,
      routes: a.iata ? routes.get(a.iata) || 0 : 0,
      dests: a.iata ? (dests.get(a.iata) || new Set()).size : 0,
      contrast: c >= 0 && c !== undefined ? Math.round(c * 10) / 10 : null,
      fill: Math.round(C.fillAt(a, C.REF_PHONE.W, C.REF_PHONE.H, a.z) * 1000) / 1000,
      head: Math.max(0, a.nz - a.z - 1),
      rw: r.n, len: Math.round(r.len), paved: r.paved ? 1 : 0,
      hint: C.hint3Of(a)?.type || 'none',
    };
  }
  const score = {}; for (const a of all) score[a.id] = scoreFeatures(feat[a.id]);
  const excluded = (a) => EXCLUDE.test(a.name);

  // ---- tier 1: the Daily 50 + the next 50 by Wikidata passenger count
  const tier = new Map(), year = new Map(), paxOf = new Map();
  for (const id of topIds) { tier.set(id, 1); year.set(id, top50.year || 2025); }
  const extra = [];
  for (const e of ranked) { if (extra.length >= 50) break; extra.push(e); tier.set(e.a.id, 1); year.set(e.a.id, e.year); paxOf.set(e.a.id, e.pax); }
  // ---- tiers 2 and 3
  const sched = (a) => feat[a.id].sched || (a.iata && feat[a.id].routes >= 1);
  for (const a of all) {
    if (tier.has(a.id) || excluded(a)) continue;
    const t = C.hint3Of(a)?.type;
    if (t === 'airline') { if (score[a.id] >= T2) tier.set(a.id, 2); }
    else if (sched(a) && score[a.id] >= T3) tier.set(a.id, 3);
  }
  const out = {
    meta: { generated: new Date().toISOString().slice(0, 10), formula: 'fame 25 + service 30 + imagery 25 + distinctiveness 10 + hint quality 10', weights: WEIGHTS, thresholds: { tier2: T2, tier3: T3 }, paxYears: PAX_YEARS, features: ['article', 'sites', 'sched', 'routes', 'dests', 'contrast', 'fill', 'head', 'rw', 'len', 'paved', 'hint'] },
    tiers: Object.fromEntries([...tier].map(([id, t]) => [id, [t, score[id], year.get(id) || 0]])),
    features: Object.fromEntries(all.filter((a) => feat[a.id].sched || feat[a.id].routes || tier.has(a.id) || C.hint3Of(a)?.type === 'airline').map((a) => [a.id, Object.values(feat[a.id])])),
  };
  writeFileSync(P('data/tiers.json'), JSON.stringify(out) + '\n');
  return { out, all, main, hard, feat, score, tier, extra, ranked, paxOf, excluded, top50, paxAirports, rawPax, topIdsSet: topIds };
}

// ---------------- report ----------------
function report(R) {
  const { all, feat, score, tier, extra, ranked, paxOf, excluded } = R;
  const name = (a) => `${(a.iata || a.icao).padEnd(5)} ${a.name.slice(0, 38).padEnd(39)} ${a.country.slice(0, 14).padEnd(15)}`;
  const byTier = (t) => all.filter((a) => tier.get(a.id) === t);
  console.log('\n== 1. tier sizes');
  for (const t of [1, 2, 3]) {
    const list = byTier(t); const h = {};
    for (const a of list) { const b = Math.min(9, Math.floor(score[a.id] / 10)); h[b] = (h[b] || 0) + 1; }
    console.log(`tier ${t}: ${list.length}  score histogram (by tens): ${Object.entries(h).map(([k, n]) => `${k}0s:${n}`).join(' ')}`);
  }
  console.log('\n== 2. Major hubs ranks 51-100 (Wikidata passenger counts)');
  extra.forEach((e, i) => console.log(`${String(51 + i).padStart(3)} ${name(e.a)} ${(e.pax / 1e6).toFixed(1).padStart(6)}M ${e.year}  score ${String(score[e.a.id]).padStart(3)}  hint ${feat[e.a.id].hint}`));
  const skipped = ranked.filter((e) => !extra.includes(e)).slice(0, 5);
  console.log('next in line:', skipped.map((e) => `${e.a.iata} ${(e.pax / 1e6).toFixed(1)}M`).join(', '));
  // raw Wikidata ranking vs our data: which of the next candidates were lost (not in our data = closed, duplicate, image-quality or no code match)
  const rawRows = R.rawPax.slice(0, 130).filter((x) => !R.topIdsSet.has(x.id));
  const lost = rawRows.filter((x) => !x.a);
  console.log('Wikidata candidates ranked 51..~100 that are NOT in our data (no match / failed the image filter):', lost.slice(0, 30).map((x) => x.label + ' ' + (x.pax / 1e6).toFixed(1) + 'M').join(', ') || 'none');
  const cc = {}; for (const e of extra) cc[e.a.countryCode] = (cc[e.a.countryCode] || 0) + 1;
  console.log('countries among 51-100:', Object.entries(cc).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}:${n}`).join(' '));
}
function report2(R) {
  const { all, feat, score, tier, excluded } = R;
  let seed = 140; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (list, n) => { const l = [...list], o = []; while (o.length < n && l.length) o.push(l.splice(Math.floor(rnd() * l.length), 1)[0]); return o; };
  const hintTxt = (a) => { const h = C.hintInfo('extra', a); return `${h.label}: ${h.text()}`; };
  const line = (a) => `${(a.iata || a.icao).padEnd(5)} ${a.name.slice(0, 36).padEnd(37)} ${a.country.slice(0, 13).padEnd(14)} score ${String(score[a.id]).padStart(3)}  ${hintTxt(a)}`;
  const t2 = all.filter((a) => tier.get(a.id) === 2), t3 = all.filter((a) => tier.get(a.id) === 3);
  console.log('\n== 3a. 50 random tier-2 (Large)'); pick(t2, 50).forEach((a) => console.log(line(a)));
  console.log('\n== 3b. 50 random tier-3 (Mid-size)'); pick(t3, 50).forEach((a) => console.log(line(a)));
  console.log('\nspecific cases:'); for (const c of ['GVA', 'BSL', 'LUG', 'ZRH', 'BRN', 'SZG', 'TRN']) { const a = all.find((x) => x.iata === c); console.log(c, a ? `tier ${tier.get(a.id) || 'none'} score ${score[a.id]} ${hintTxt(a)}` : 'not in the data'); }
  const eligible2 = all.filter((a) => !tier.has(a.id) && !excluded(a) && C.hint3Of(a)?.type === 'airline');
  const sched = (a) => feat[a.id].sched || (a.iata && feat[a.id].routes >= 1);
  const eligible3 = all.filter((a) => !tier.has(a.id) && !excluded(a) && C.hint3Of(a)?.type !== 'airline' && sched(a));
  const asc = (l) => [...l].sort((x, y) => score[x.id] - score[y.id]), desc = (l) => [...l].sort((x, y) => score[y.id] - score[x.id]);
  console.log('\n== 4. 40 lowest KEPT / 40 highest LEFT OUT'); 
  console.log('-- tier 2 lowest kept'); asc(t2).slice(0, 40).forEach((a) => console.log(line(a)));
  console.log('-- tier 2 highest left out (airline hint, below the threshold)'); desc(eligible2).slice(0, 40).forEach((a) => console.log(line(a)));
  console.log('-- tier 3 lowest kept'); asc(t3).slice(0, 40).forEach((a) => console.log(line(a)));
  console.log('-- tier 3 highest left out (scheduled, below the threshold)'); desc(eligible3).slice(0, 40).forEach((a) => console.log(line(a)));
  const outAirline = all.filter((a) => !tier.has(a.id) && !excluded(a) && C.hint3Of(a)?.type === 'airline').length;
  console.log(`\nairports with an airline clue left in no tier: ${outAirline} (below T2=${T2}); excluded by name (military, heliport, glider...): ${all.filter((a) => excluded(a) && (sched(a) || C.hint3Of(a)?.type === 'airline')).length} scheduled/airline ones`);
  // ---- 5. moved vs v1.3.5
  const old = JSON.parse(execFileSync('git', ['show', 'd39cf11:data/airports.json'], { cwd: root, maxBuffer: 1 << 28 }).toString()).airports;
  const cls = (id) => (tier.get(id) ? 'tier ' + tier.get(id) : 'none');
  const tally = (list) => { const c = {}; for (const a of list) { const k = cls(a.id); c[k] = (c[k] || 0) + 1; } return c; };
  console.log('\n== 5. moved vs v1.3.5 (old Practice sets were drawn from the 3,222 airports of airports.json)');
  console.log('old Major hubs (' + old.filter((a) => a.tier === 1).length + ') ->', JSON.stringify(tally(old.filter((a) => a.tier === 1))));
  console.log('old Large (' + old.filter((a) => a.type === 'large').length + ') ->', JSON.stringify(tally(old.filter((a) => a.type === 'large'))));
  console.log('old Mid-size (' + old.filter((a) => a.type === 'medium').length + ') ->', JSON.stringify(tally(old.filter((a) => a.type === 'medium'))));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const R = await build({ refresh: process.argv.includes('--refresh') });
  const n = [1, 2, 3].map((t) => [...R.tier.values()].filter((x) => x === t).length);
  console.log(`wrote data/tiers.json: tier 1 ${n[0]}, tier 2 ${n[1]}, tier 3 ${n[2]}`);
  if (process.argv.includes('--report')) { report(R); report2(R); }
}
