// Builds the Daily schedule: for each calendar date, the airport of the day (and its fallbacks) for the Daily and for Hard mode.
// Used by scripts/build_site.mjs (deploy) and scripts/serve.mjs (dev server, so source and deployed pages behave the same).
// Dates are plain calendar dates ("2026-10-06"): every player gets the entry for THEIR local date.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as C from '../js/core.js';

/** Fields the app needs for an answer (everything the full record has except nothing optional is left out). */
const FIELDS = ['id', 'name', 'iata', 'icao', 'lat', 'lon', 'country', 'countryCode', 'continent', 'city', 'type', 'tier', 'rw', 'view', 'z', 'nz', 'top', 'wp'];
const slim = (a) => Object.fromEntries(FIELDS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

export function loadPools(root) {
  const file = (f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
  const read = (f) => file(f).airports;
  const main = read('airports.json');
  const hard = read('airports-hard.json');
  const top = main.filter((a) => a.top).sort((a, b) => a.top - b.top);
  const hardPool = [...main.filter((a) => !a.top), ...hard]; // Hard pool = every airport outside the Daily top list
  return { top, hardPool, meta: file('airports.json').meta || null };
}

/**
 * @param {object} o  root: project root; now: Date; pastDays/futureDays: calendar days around the UTC date of `now`;
 *                    fallbacks: how many candidates per kind and date (first = airport of the day, rest = imagery fallbacks).
 */
export function buildDaily({ root, now = new Date(), pastDays = 1, futureDays = 14, fallbacks = 3 }) {
  const { top, hardPool, meta } = loadPools(root);
  const base = C.utcDateString(now);
  const days = {};
  for (let i = -pastDays; i <= futureDays; i++) {
    const date = C.addDays(base, i);
    days[date] = {
      daily: C.dailyTopOrder(top, date).slice(0, fallbacks).map(slim),
      hard: C.dailyOrder(hardPool, date, 'hard:').slice(0, fallbacks).map(slim),
    };
  }
  return { generated: now.toISOString(), meta, from: C.addDays(base, -pastDays), to: C.addDays(base, futureDays), days };
}

/** The part of the schedule worth inlining in the HTML: yesterday, today and tomorrow (UTC), which covers every local date on Earth. */
export function inlineSubset(daily, now = new Date()) {
  const base = C.utcDateString(now);
  const days = {};
  for (const d of [C.addDays(base, -1), base, C.addDays(base, 1)]) if (daily.days[d]) days[d] = daily.days[d];
  return { generated: daily.generated, meta: daily.meta, days };
}
