// Unit checks for the pure logic. Run: node tests/unit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../js/core.js';

// minimal in-memory localStorage so store.js can be exercised
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const S = await import('../js/store.js');

const { airports } = JSON.parse(readFileSync(new URL('../data/airports.json', import.meta.url), 'utf8'));
const { airports: hard } = JSON.parse(readFileSync(new URL('../data/airports-hard.json', import.meta.url), 'utf8'));
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


console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
