// Unit checks for the pure logic. Run: node tests/unit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../js/core.js';

// minimal in-memory localStorage so store.js can be exercised
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const S = await import('../js/store.js');

const { airports } = JSON.parse(readFileSync(new URL('../data/airports.json', import.meta.url), 'utf8'));
const by = (iata) => airports.find((a) => a.iata === iata);
const index = C.prepareIndex(airports);

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected}±${tol}, got ${actual}`);

console.log('geo');
test('ZRH -> JFK ~6,300 km, points W/NW', () => {
  const z = by('ZRH'), j = by('JFK');
  const km = C.haversineKm(z.lat, z.lon, j.lat, j.lon);
  near(km, 6330, 60, 'distance');
  const b = C.bearingDeg(z.lat, z.lon, j.lat, j.lon);
  assert.ok(b > 270 && b < 315, 'bearing ' + b);
  assert.ok(['W', 'NW'].includes(C.compassLabel(b)), C.compassLabel(b));
  const r = C.evaluateGuess(z, j);
  assert.equal(r.correct, false);
  assert.ok(r.pct >= 65 && r.pct <= 70, 'pct ' + r.pct);
});
test('JFK -> ZRH points NE (reverse)', () => {
  const z = by('ZRH'), j = by('JFK');
  assert.equal(C.compassLabel(C.bearingDeg(j.lat, j.lon, z.lat, z.lon)), 'NE');
});
test('LHR -> JFK ~5,540 km, W', () => {
  const l = by('LHR'), j = by('JFK');
  near(C.haversineKm(l.lat, l.lon, j.lat, j.lon), 5540, 40);
  assert.ok(['W', 'NW'].includes(C.compassLabel(C.bearingDeg(l.lat, l.lon, j.lat, j.lon))));
});
test('SYD -> AKL ~2,155 km, E/SE', () => {
  const s = by('SYD'), a = by('AKL');
  near(C.haversineKm(s.lat, s.lon, a.lat, a.lon), 2155, 40);
  assert.ok(['E', 'SE'].includes(C.compassLabel(C.bearingDeg(s.lat, s.lon, a.lat, a.lon))));
});
test('cardinal / intercardinal arrows', () => {
  assert.equal(C.compassLabel(C.bearingDeg(0, 0, 10, 0)), 'N');
  assert.equal(C.compassLabel(C.bearingDeg(0, 0, -10, 0)), 'S');
  assert.equal(C.compassLabel(C.bearingDeg(0, 0, 0, 10)), 'E');
  assert.equal(C.compassLabel(C.bearingDeg(0, 0, 0, -10)), 'W');
  assert.equal(C.compassLabel(C.bearingDeg(0, 0, 10, 10)), 'NE');
  assert.equal(C.compassLabel(C.bearingDeg(0, 0, 10, -10)), 'NW');
  assert.equal(C.compassLabel(C.bearingDeg(0, 0, -10, 10)), 'SE');
  assert.equal(C.compassLabel(C.bearingDeg(0, 0, -10, -10)), 'SW');
});
test('proximity percentage', () => {
  assert.equal(C.proximityPct(0), 100);
  assert.equal(C.proximityPct(10000), 50);
  assert.equal(C.proximityPct(20000), 0);
  assert.equal(C.proximityPct(30000), 0);
});
test('tile coordinates', () => {
  assert.deepEqual(C.tileCoords(0.0001, 0.0001, 1), { x: 1, y: 0, z: 1 });
  const t = C.tileCoords(47.458, 8.548, 12);
  assert.deepEqual([t.x, t.y], [2145, 1432]);
});

console.log('search');
test('accent-insensitive: "zurich" finds Zürich and normalises', () => {
  assert.equal(C.normalize('Zürich'), 'zurich');
  const hits = C.search(index, 'zurich');
  assert.ok(hits.some((a) => a.iata === 'ZRH'));
  assert.equal(hits[0].iata, 'ZRH');
  assert.equal(C.search(index, 'ZÜRICH')[0].iata, 'ZRH');
});
test('accents in query and data (São Paulo, Düsseldorf, Reykjavík)', () => {
  assert.ok(C.search(index, 'sao paulo').some((a) => a.iata === 'GRU'));
  assert.ok(C.search(index, 'dusseldorf').some((a) => a.iata === 'DUS'));
  assert.ok(C.search(index, 'reykjavik').some((a) => a.iata === 'KEF'));
  assert.ok(C.search(index, 'düsseldorf').some((a) => a.iata === 'DUS'));
});
test('exact IATA ranks first; ICAO exact next', () => {
  assert.equal(C.search(index, 'ham')[0].iata, 'HAM');
  assert.equal(C.search(index, 'jfk')[0].iata, 'JFK');
  assert.equal(C.search(index, 'LSZH')[0].iata, 'ZRH');
});
test('prefix beats substring; substring works; city match works', () => {
  const hits = C.search(index, 'heath');
  assert.ok(hits.some((a) => a.iata === 'LHR'));
  assert.ok(C.search(index, 'kennedy').some((a) => a.iata === 'JFK'), 'substring in name');
  assert.ok(C.search(index, 'new york').some((a) => a.iata === 'JFK'), 'city');
  const q = C.search(index, 'lon');
  const firstSub = q.findIndex((a) => !C.normalize(a.name).startsWith('lon') && !C.normalize(a.city).startsWith('lon') && !a.iata.toLowerCase().startsWith('lon'));
  assert.ok(firstSub === -1 || q.slice(0, firstSub).every((a) => C.normalize(a.name).startsWith('lon') || C.normalize(a.city).startsWith('lon') || a.iata.toLowerCase().startsWith('lon')));
});
test('max 6 results; excludes guessed ids', () => {
  assert.ok(C.search(index, 'international').length <= 6);
  assert.equal(C.search(index, 'international').length, 6);
  const zrh = by('ZRH');
  assert.ok(!C.search(index, 'zurich', { exclude: new Set([zrh.id]) }).some((a) => a.id === zrh.id));
  assert.deepEqual(C.search(index, ''), []);
  assert.deepEqual(C.search(index, 'qqqqzzzz'), []);
});
test('row format', () => {
  assert.equal(C.suggestionLabel(by('ZRH')), 'Zürich Airport · ZRH · Zurich, CH');
});

console.log('daily / practice');
test('daily airport deterministic per date, differs across dates', () => {
  const a1 = C.dailyOrder(airports, '2026-10-04').map((x) => x.id);
  const a2 = C.dailyOrder([...airports].reverse(), '2026-10-04').map((x) => x.id);
  assert.deepEqual(a1.slice(0, 20), a2.slice(0, 20), 'independent of input order');
  assert.deepEqual(a1, C.dailyOrder(airports, '2026-10-04').map((x) => x.id));
  const days = new Set();
  for (let d = 1; d <= 28; d++) days.add(C.dailyOrder(airports, `2026-11-${String(d).padStart(2, '0')}`)[0].id);
  assert.ok(days.size >= 25, 'variety across a month: ' + days.size);
  assert.ok(C.dailyOrder(airports, '2026-10-04').every((a) => a.type === 'large'));
});
test('UTC date helpers', () => {
  assert.equal(C.utcDateString(new Date('2026-10-04T23:59:59Z')), '2026-10-04');
  assert.equal(C.utcDateString(new Date('2026-10-05T00:00:00Z')), '2026-10-05');
  assert.equal(C.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(C.msUntilNextUtcDay(new Date('2026-10-04T23:00:00Z')), 3600_000);
});
test('difficulty pools', () => {
  const n = (d) => C.practiceOrder(airports, d).length;
  assert.equal(n('easy'), 100);
  assert.ok(n('medium') > 500 && n('hard') > 1000);
  assert.ok(C.practiceOrder(airports, 'easy').every((a) => a.type === 'large'));
  assert.ok(C.practiceOrder(airports, 'hard').every((a) => a.type === 'medium'));
});

console.log('hints');
test('zoom progression zooms out then continent then country', () => {
  for (const a of airports) {
    const z = [0, 1, 2, 3, 4].map((m) => C.zoomForMisses(a, m));
    assert.ok(z[0] >= 12 && z[0] <= 15);
    assert.equal(z[1], z[0] - 1);
    assert.equal(z[2], z[0] - 2);
    assert.ok(z[3] < z[2] && z[4] > z[3] && z[4] < z[2], `${a.iata} ${z}`);
  }
});

console.log('share');
test('share text is correct and leak-free', () => {
  const ans = by('ZRH');
  const guesses = [by('JFK'), by('LHR'), by('MUC'), ans];
  const results = guesses.map((g) => C.evaluateGuess(g, ans));
  const text = C.buildShareText({ results, won: true, title: 'Daily 2026-10-04', url: 'https://example.github.io/airport-guesser/' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Airport Guesser — Daily 2026-10-04');
  assert.equal(lines[1], '4/5');
  assert.equal(lines.filter((l) => /^[\u{1F7E5}\u{1F7E7}\u{1F7E8}\u{1F7E9}⬛]/u.test(l)).length, 4);
  assert.match(lines[3], /^⬛ ↗️$|^⬛ ➡️$|^⬛/u); // JFK->ZRH: >5000 km
  assert.equal(lines[6], '\u{1F7E9} \u{1F3AF}');
  for (const bad of [ans.name, ans.iata, ans.icao, ans.city, ans.country, by('JFK').iata, by('LHR').iata, 'Zurich', 'Switzerland']) {
    assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), 'leaks ' + bad);
  }
  const loss = C.buildShareText({ results: results.slice(0, 3), won: false, title: 'Practice · Easy' });
  assert.equal(loss.split('\n')[1], 'X/5');
});
test('distance bands', () => {
  const sq = (km, correct = false) => C.bandSquare({ km, correct });
  assert.equal(sq(0, true), '\u{1F7E9}');
  assert.equal(sq(499), '\u{1F7E8}');
  assert.equal(sq(500), '\u{1F7E7}');
  assert.equal(sq(1999), '\u{1F7E7}');
  assert.equal(sq(2000), '\u{1F7E5}');
  assert.equal(sq(4999), '\u{1F7E5}');
  assert.equal(sq(5000), '⬛');
});
test('arrow emoji covers 8 directions', () => {
  assert.equal(new Set([0, 45, 90, 135, 180, 225, 270, 315].map(C.arrowEmoji)).size, 8);
});

console.log('stats');
test('streak, distribution, win rate', () => {
  mem.clear();
  S.recordResult('daily', true, 3, '2026-10-01');
  S.recordResult('daily', true, 1, '2026-10-02');
  let st = S.recordResult('daily', true, 5, '2026-10-03');
  assert.deepEqual(st.streak, { current: 3, best: 3, last: '2026-10-03' });
  assert.deepEqual(st.daily.dist, [1, 0, 1, 0, 1, 0]);
  assert.deepEqual(S.displayStreak(S.loadStats(), '2026-10-04'), { current: 3, best: 3 });
  assert.deepEqual(S.displayStreak(S.loadStats(), '2026-10-06'), { current: 0, best: 3 }, 'missed a day');
  st = S.recordResult('daily', false, 5, '2026-10-04');
  assert.equal(st.streak.current, 0);
  assert.equal(st.streak.best, 3);
  st = S.recordResult('daily', true, 2, '2026-10-06'); // gap -> restarts at 1
  assert.equal(st.streak.current, 1);
  st = S.recordResult('practice', true, 4, '2026-10-06');
  assert.equal(st.practice.played, 1);
  assert.equal(st.daily.played, 5);
  assert.equal(st.daily.wins, 4);
});
test('storage failures are swallowed', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(S.loadDaily(), null);
  assert.equal(S.loadStats().daily.played, 0);
  assert.doesNotThrow(() => S.recordResult('daily', true, 1, '2026-01-01'));
  assert.equal(S.saveDaily({ date: 'x' }), false);
  globalThis.localStorage = saved;
});
test('daily state round-trips', () => {
  mem.clear();
  S.saveDaily({ date: '2026-10-04', id: 4505, guesses: [1, 2], done: false, won: false });
  assert.deepEqual(S.loadDaily().guesses, [1, 2]);
});

console.log('data');
test('dataset integrity', () => {
  assert.ok(airports.length > 2000);
  assert.equal(new Set(airports.map((a) => a.id)).size, airports.length);
  assert.equal(new Set(airports.map((a) => a.iata)).size, airports.length);
  for (const a of airports) {
    assert.match(a.iata, /^[A-Z0-9]{3}$/);
    assert.ok(a.name && a.icao && a.country && a.countryCode && a.continent);
    assert.ok(a.lat >= -90 && a.lat <= 90 && a.lon >= -180 && a.lon <= 180);
    assert.ok(['large', 'medium'].includes(a.type) && [1, 2, 3].includes(a.tier));
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
