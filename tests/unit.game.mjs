// Unit checks for v1.1 rules: pools, locked-view zoom fitting, hints/attempts, share, stats. Run: node tests/unit.game.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../js/core.js';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const S = await import('../js/store.js');

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8')).airports;
const airports = read('airports.json');
const hard = read('airports-hard.json');
const byIata = (iata) => airports.find((a) => a.iata === iata);

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('search (Hard = full database)');
test('Hard search covers the full database; airports without IATA show their ICAO code', () => {
  const full = C.prepareIndex([...airports, ...hard]);
  const h = hard.find((a) => !a.iata);
  assert.ok(h, 'hard airports without IATA exist');
  assert.ok(C.search(full, h.name).some((a) => a.id === h.id), 'finds ' + h.name);
  assert.ok(C.suggestionLabel(h).includes(h.icao));
  assert.ok(C.search(full, h.icao.toLowerCase()).some((a) => a.id === h.id), 'ICAO exact');
  assert.ok(C.search(C.prepareIndex(airports), h.name).every((a) => a.id !== h.id), 'Daily index has no hard airports');
});

console.log('pools');
test('Daily is deterministic per date; Daily and Hard have separate draws', () => {
  const a1 = C.dailyOrder(airports, '2026-10-04').map((x) => x.id);
  assert.deepEqual(a1.slice(0, 20), C.dailyOrder([...airports].reverse(), '2026-10-04').slice(0, 20).map((x) => x.id), 'independent of input order');
  const days = new Set();
  for (let d = 1; d <= 28; d++) days.add(C.dailyOrder(airports, '2026-11-' + String(d).padStart(2, '0'))[0].id);
  assert.ok(days.size >= 25, 'variety across a month: ' + days.size);
  assert.equal(a1.length, airports.length, 'Daily pool = all international (scheduled, IATA) airports');
  const h1 = C.dailyOrder(hard, '2026-10-04', 'hard:');
  assert.deepEqual(h1.slice(0, 20).map((x) => x.id), C.dailyOrder([...hard].reverse(), '2026-10-04', 'hard:').slice(0, 20).map((x) => x.id));
  const ids = new Set(airports.map((a) => a.id));
  assert.ok(h1.every((a) => a.tier === 4 && !ids.has(a.id)), 'Hard pool has no Daily airports');
});
test('UTC date helpers', () => {
  assert.equal(C.utcDateString(new Date('2026-10-04T23:59:59Z')), '2026-10-04');
  assert.equal(C.utcDateString(new Date('2026-10-05T00:00:00Z')), '2026-10-05');
  assert.equal(C.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(C.msUntilNextUtcDay(new Date('2026-10-04T23:00:00Z')), 3600_000);
});
test('practice sets', () => {
  const n = (d) => C.practiceOrder(airports, d).length;
  assert.equal(n('easy'), 100);
  assert.ok(n('medium') > 500 && n('hard') > 1000);
  assert.ok(C.practiceOrder(airports, 'hard').every((a) => a.type === 'medium'));
  assert.equal(C.practiceOrder(hard, null).length, hard.length);
});

console.log('locked view: zoom fitting and image quality');
test('airfield fills 45-90% of the frame (target 75%) for every airport, any viewport size, whole zoom levels', () => {
  for (const [W, H] of [[358, 371], [604, 600], [700, 420], [390, 250]]) {
    for (const a of [...airports, ...hard]) {
      const z = C.fitZoom(a, W, H);
      assert.ok(Number.isInteger(z), 'integer zoom: no CSS scaling of the tile layer');
      const f = C.fillAt(a, W, H, z);
      if (z > 8 && z < 19) assert.ok(f > 0.449 && f <= 0.901, a.name + ' ' + [W, H, z, f].join(' '));
      assert.ok(f <= 0.901 || z <= 8, 'never overfills ' + a.name);
    }
  }
});
test('small airfields are much tighter than hubs', () => {
  const hub = C.fitZoom(byIata('ATL'), 600, 600);
  assert.ok(C.fitZoom(byIata('DQM'), 600, 600) >= hub);
  const small = hard.find((a) => a.view[2] < 400 && a.view[3] > 500 && a.view[3] < 900);
  assert.ok(C.fitZoom(small, 600, 600) - hub >= 1, 'small airfield vs ATL');
  const zs = hard.map((a) => C.fitZoom(a, 600, 600)).sort((x, y) => x - y);
  assert.ok(zs[Math.floor(zs.length / 2)] - hub >= 1, 'median hard airfield is >= 1 level tighter than a hub');
});
test('retina levels: tiles are requested deeper so every CSS pixel has >= devicePixelRatio real pixels', () => {
  assert.deepEqual([1, 1.25, 1.5, 2, 2.625, 3, 3.5, 4].map(C.retinaLevels), [0, 1, 1, 1, 2, 2, 2, 2]);
  for (const dpr of [1, 1.5, 2, 2.625, 3, 4]) {
    const n = C.retinaLevels(dpr);
    const bitmapPxPerDevicePx = 2 ** n / dpr; // 256px bitmap drawn at 256/2^n CSS px
    assert.ok(bitmapPxPerDevicePx >= 1 - 1e-9, `dpr ${dpr}: ${bitmapPxPerDevicePx}`);
  }
});
test('final zoom never exceeds native imagery: zoom + retina levels <= nz, for every airport and dpr', () => {
  for (const a of [...airports, ...hard]) {
    for (const dpr of [1, 2, 3]) {
      const n = C.retinaLevels(dpr);
      const z = C.finalZoom(a, 358, 371, n);
      assert.ok(z + n <= a.nz, `${a.name}: z${z} + ${n} > nz${a.nz}`);
    }
  }
  // the pool filter removes airports whose cap would shrink them below 45%, so kept airports are never capped at dpr 3 ...
  assert.ok([...airports, ...hard].every((a) => C.fitZoom(a, 358, 371) <= C.maxSharpZoom(a, 2)));
  // ... but the rule itself: a smaller airport in the frame beats a blurry upscale
  const poor = { ...byIata('ATL'), nz: 14 };
  assert.ok(C.fitZoom(poor, 358, 371) > 12);
  assert.equal(C.finalZoom(poor, 358, 371, 2), 12);
  assert.equal(C.finalZoom(poor, 358, 371, 1), 13);
  assert.equal(C.finalZoom(poor, 358, 371, 0), 14 <= C.fitZoom(poor, 358, 371) ? 14 : C.fitZoom(poor, 358, 371));
});
test('pool quality filter: on the reference phone at dpr 3 every airport fills >= 45% of the frame', () => {
  const { W, H, retinaLevels } = C.REF_FRAME;
  for (const a of [...airports, ...hard]) {
    assert.ok(a.nz >= 10 && a.nz <= 19, a.name + ' nz ' + a.nz);
    const f = C.fillAt(a, W, H, C.finalZoom(a, W, H, retinaLevels));
    assert.ok(f >= C.MIN_FILL - 1e-9, `${a.name} (nz ${a.nz}) fills only ${(f * 100).toFixed(0)}%`);
  }
});
test('tile block (at level zoom + n) covers the frame and contains the centre tile', () => {
  const a = byIata('ZRH');
  for (const n of [0, 1, 2]) {
    const z = C.finalZoom(a, 358, 371, n);
    const b = C.tileBlock(a, 358, 371, z, n);
    assert.equal(b.z, z + n);
    assert.ok(b.w >= 3 && b.h >= 3 && b.w < 20 && b.h < 20, JSON.stringify(b));
    const c = C.tileCoords(a.view[0], a.view[1], b.z);
    assert.ok(c.x >= b.x && c.x < b.x + b.w && c.y >= b.y && c.y < b.y + b.h);
  }
});
test('zoom-out is 2 levels wider (whole levels)', () => {
  assert.equal(C.zoomedOut(14), 12);
  assert.equal(C.zoomedOut(13), 11);
});

console.log('hints and attempts');
test('hint values', () => {
  const z = byIata('ZRH');
  assert.deepEqual(Object.fromEntries(C.HINTS.map((h) => [h.key, h.value(z)])), { continent: 'Europe', country: 'Switzerland', letter: 'Z', runways: '4' });
  assert.equal(C.hintAvailable(C.HINTS[3], { rw: 0 }), false);
});
test('attempt budget: guesses, hints and zoom share 5; hints need 2 left', () => {
  assert.equal(C.attemptsLeft(0), 5);
  assert.equal(C.attemptsLeft(3), 2);
  assert.equal(C.canSpend(3), true);
  assert.equal(C.canSpend(4), false);
});

console.log('share');
test('share text is correct and leak-free (guesses, hint, zoom-out)', () => {
  const ans = byIata('ZRH');
  const g = (iata) => C.evaluateGuess(byIata(iata), ans);
  const entries = [g('JFK'), { hint: true }, g('LHR'), { zoom: true }, g('ZRH')];
  const text = C.buildShareText({ entries, won: true, title: 'Daily 2026-10-04', url: 'https://example.github.io/airport-guesser/' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Airport Guesser — Daily 2026-10-04');
  assert.equal(lines[1], '5/5');
  assert.equal(lines[3].codePointAt(0), 0x2b1b); // JFK->ZRH > 5000 km
  assert.equal(lines[4], '\u{1F4A1}');
  assert.equal(lines[6], '\u{1F52D}');
  assert.equal(lines[7], '\u{1F7E9} \u{1F3AF}');
  for (const bad of [ans.name, ans.iata, ans.icao, ans.city, ans.country, 'JFK', 'LHR', 'Zurich', 'Switzerland', 'Europe']) {
    assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), 'leaks ' + bad);
  }
  assert.equal(C.buildShareText({ entries: entries.slice(0, 3), won: false, title: 'Hard Daily 2026-10-04' }).split('\n')[1], 'X/5');
});
test('distance bands and arrows', () => {
  const sq = (km, correct = false) => C.bandSquare({ km, correct });
  assert.deepEqual([sq(0, true), sq(499), sq(500), sq(1999), sq(2000), sq(4999), sq(5000)],
    ['\u{1F7E9}', '\u{1F7E8}', '\u{1F7E7}', '\u{1F7E7}', '\u{1F7E5}', '\u{1F7E5}', '⬛']);
  assert.equal(new Set([0, 45, 90, 135, 180, 225, 270, 315].map(C.arrowEmoji)).size, 8);
});

console.log('stats');
test('streaks are per mode; distribution counts attempts used', () => {
  mem.clear();
  S.recordResult('daily', true, 3, '2026-10-01');
  S.recordResult('daily', true, 1, '2026-10-02');
  S.recordResult('daily', true, 5, '2026-10-03');
  S.recordResult('hard', true, 4, '2026-10-03');
  let st = S.loadStats();
  assert.deepEqual(st.streaks.daily, { current: 3, best: 3, last: '2026-10-03' });
  assert.deepEqual(st.streaks.hard, { current: 1, best: 1, last: '2026-10-03' });
  assert.deepEqual(st.daily.dist, [1, 0, 1, 0, 1, 0]);
  assert.deepEqual(st.hard.dist, [0, 0, 0, 1, 0, 0]);
  assert.deepEqual(S.displayStreak(st, 'daily', '2026-10-04'), { current: 3, best: 3 });
  assert.deepEqual(S.displayStreak(st, 'daily', '2026-10-06'), { current: 0, best: 3 }, 'missed a day');
  st = S.recordResult('daily', false, 5, '2026-10-04');
  assert.equal(st.streaks.daily.current, 0);
  assert.equal(st.streaks.daily.best, 3);
  assert.equal(st.streaks.hard.current, 1, 'hard streak untouched');
  assert.equal(S.recordResult('daily', true, 2, '2026-10-06').streaks.daily.current, 1);
  st = S.recordResult('practice', true, 4, '2026-10-06');
  assert.deepEqual([st.practice.played, st.daily.played, st.daily.wins, st.hard.played], [1, 5, 4, 1]);
});
test('v1 stats (single streak) are migrated', () => {
  mem.clear();
  mem.set('airportGuesser.stats.v1', JSON.stringify({ daily: { played: 2, wins: 2, dist: [1, 1, 0, 0, 0, 0] }, practice: { played: 0, wins: 0, dist: [0, 0, 0, 0, 0, 0] }, streak: { current: 2, best: 2, last: '2026-10-03' } }));
  const st = S.loadStats();
  assert.equal(st.daily.played, 2);
  assert.deepEqual(st.streaks.daily, { current: 2, best: 2, last: '2026-10-03' });
  assert.equal(st.hard.played, 0);
});
test('storage failures are swallowed', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(S.loadDaily('daily'), null);
  assert.equal(S.loadStats().daily.played, 0);
  assert.doesNotThrow(() => S.recordResult('daily', true, 1, '2026-01-01'));
  assert.equal(S.saveDaily('daily', { date: 'x', log: [] }), false);
  globalThis.localStorage = saved;
});
test('daily state round-trips, separately for Daily and Hard', () => {
  mem.clear();
  S.saveDaily('daily', { date: '2026-10-04', id: 4505, log: [{ t: 'g', id: 1 }, { t: 'h', k: 'country' }, { t: 'z' }], done: false, won: false });
  S.saveDaily('hard', { date: '2026-10-04', id: 21, log: [], done: false, won: false });
  assert.equal(S.loadDaily('daily').log.length, 3);
  assert.equal(S.loadDaily('hard').id, 21);
});

console.log('data');
test('Daily pool integrity', () => {
  assert.ok(airports.length > 2000);
  assert.equal(new Set(airports.map((a) => a.id)).size, airports.length);
  assert.equal(new Set(airports.map((a) => a.iata)).size, airports.length);
  for (const a of airports) {
    assert.match(a.iata, /^[A-Z0-9]{3}$/);
    assert.ok(a.name && a.icao && a.country && a.countryCode && a.continent);
    assert.ok(['large', 'medium'].includes(a.type) && [1, 2, 3].includes(a.tier));
    assert.ok(a.view.length === 4 && a.view.every(Number.isFinite) && Number.isInteger(a.rw));
  }
});
test('Hard pool integrity: small/regional/remote, disjoint from Daily, runway data present', () => {
  assert.ok(hard.length > 5000);
  assert.equal(new Set(hard.map((a) => a.id)).size, hard.length);
  const ids = new Set(airports.map((a) => a.id));
  for (const a of hard) {
    assert.ok(!ids.has(a.id));
    assert.ok(a.name && a.icao && a.countryCode && a.continent && a.rw >= 1);
    assert.ok(['large', 'medium', 'small'].includes(a.type) && a.tier === 4);
    assert.ok(a.view.length === 4 && a.view.every(Number.isFinite) && Math.abs(a.view[0]) <= 90 && Math.abs(a.view[1]) <= 180);
  }
  assert.ok(hard.filter((a) => a.type === 'small').length > 5000);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
