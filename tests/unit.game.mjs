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
const topList = airports.filter((x) => x.top).sort((x, y) => x.top - y.top);
const hardPool = [...airports.filter((x) => !x.top), ...hard]; // what the app builds: every airport not in the Daily top list
const ranking = JSON.parse(readFileSync(new URL('../data/top50.json', import.meta.url), 'utf8'));

test('Daily pool = the busiest airports from the ACI ranking (data/top50.json): all matched by IATA and ICAO', () => {
  assert.equal(ranking.count, ranking.airports.length);
  assert.equal(topList.length, ranking.airports.length);
  assert.ok(ranking.year >= 2025 && /ACI/.test(ranking.source) && /wikipedia/.test(ranking.sourceUrl) && ranking.retrieved);
  ranking.airports.forEach((r, i) => {
    const a = topList[i];
    assert.equal(r.rank, i + 1);
    assert.equal(a.top, r.rank);
    assert.equal(a.iata, r.iata);
    assert.equal(a.icao, r.icao, 'ICAO matches for ' + r.iata);
    assert.ok(r.passengers > 1e7 && r.year === ranking.year && r.sourceUrl && r.name && r.city && r.country);
    if (i) assert.ok(r.passengers <= ranking.airports[i - 1].passengers, 'sorted by passengers');
  });
  assert.deepEqual(topList.slice(0, 3).map((x) => x.iata), ['ATL', 'DXB', 'HND']);
});
test('Daily: same airport for everyone on a date, drawn only from the top list', () => {
  const o1 = C.dailyTopOrder(topList, '2026-10-04');
  assert.deepEqual(o1.map((x) => x.id), C.dailyTopOrder([...topList].reverse(), '2026-10-04').map((x) => x.id), 'independent of input order');
  assert.equal(o1.length, topList.length, 'fallback list covers the whole cycle');
  assert.ok(o1.every((x) => x.top >= 1 && x.top <= 50));
  assert.notEqual(C.dailyTopOrder(topList, '2026-10-05')[0].id, o1[0].id);
});
test('Daily: every airport once per cycle, reshuffled each cycle, and never twice within 30 days (also across cycles)', () => {
  const n = topList.length;
  const total = n * 6 + 11;
  const seq = [];
  for (let d = 0; d < total; d++) seq.push(C.dailyTopOrder(topList, C.addDays(C.TOP_EPOCH, d))[0].id);
  for (let c = 0; c < 6; c++) assert.equal(new Set(seq.slice(c * n, (c + 1) * n)).size, n, 'cycle ' + c + ' uses every airport exactly once');
  for (let c = 1; c < 6; c++) assert.notEqual(seq.slice((c - 1) * n, c * n).join(), seq.slice(c * n, (c + 1) * n).join(), 'cycle ' + c + ' is reshuffled');
  const last = new Map();
  for (let d = 0; d < seq.length; d++) {
    if (last.has(seq[d])) assert.ok(d - last.get(seq[d]) >= C.TOP_MIN_GAP, `airport repeated after ${d - last.get(seq[d])} days (day ${d})`);
    last.set(seq[d], d);
  }
  // any 30 consecutive days are distinct, including windows spanning a cycle boundary
  for (let d = 0; d + 30 <= seq.length; d++) assert.equal(new Set(seq.slice(d, d + 30)).size, 30, 'window at day ' + d);
  // dates before the epoch work too
  assert.ok(topList.some((x) => x.id === C.dailyTopOrder(topList, '2025-06-01')[0].id));
  // the schedule is a pure function of the date (recomputed from scratch it is identical)
  assert.equal(C.dailyTopOrder(topList, '2027-03-09')[0].id, C.dailyTopOrder([...topList].reverse(), '2027-03-09')[0].id);
});
test('Daily simulation: 30 consecutive days from today are all distinct and all in the list', () => {
  const start = C.localDateString();
  const days = Array.from({ length: 30 }, (_, i) => C.dailyTopOrder(topList, C.addDays(start, i))[0]);
  const ids = new Set(days.map((x) => x.id));
  assert.equal(ids.size, 30, 'no repeats in 30 days');
  assert.ok(days.every((x) => x.top >= 1 && x.top <= 50));
});
test('Hard pool = every airport not in the Daily list (main non-top + hard file), Hard daily is deterministic', () => {
  const topIds = new Set(topList.map((x) => x.id));
  assert.equal(hardPool.length, airports.length - topList.length + hard.length);
  assert.ok(hardPool.every((x) => !topIds.has(x.id)));
  assert.equal(new Set(hardPool.map((x) => x.id)).size, hardPool.length, 'no duplicates');
  const h1 = C.dailyOrder(hardPool, '2026-10-04', 'hard:');
  assert.deepEqual(h1.slice(0, 20).map((x) => x.id), C.dailyOrder([...hardPool].reverse(), '2026-10-04', 'hard:').slice(0, 20).map((x) => x.id));
  const days = new Set();
  for (let d = 1; d <= 28; d++) days.add(C.dailyOrder(hardPool, '2026-11-' + String(d).padStart(2, '0'), 'hard:')[0].id);
  assert.ok(days.size >= 25, 'variety across a month: ' + days.size);
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

console.log('daily schedule (build) and local dates');
const { buildDaily, inlineSubset } = await import('../scripts/daily_build.mjs');
const { execFileSync } = await import('node:child_process');
const schedule = buildDaily({ root: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), now: new Date('2026-10-05T12:00:00Z') });
test('schedule: dates cover yesterday..+14 days, 3 candidates per kind, entries are complete records equal to the full data', () => {
  const dates = Object.keys(schedule.days);
  assert.equal(schedule.from, '2026-10-04');
  assert.equal(schedule.to, '2026-10-19');
  assert.equal(dates.length, 16);
  assert.ok(schedule.meta && /^\d{4}-\d{2}-\d{2}$/.test(schedule.meta.ourairports_retrieved), 'data date travels with the schedule');
  const byId = new Map([...airports, ...hard].map((a) => [a.id, a]));
  for (const d of dates) {
    for (const kind of ['daily', 'hard']) {
      const e = schedule.days[d][kind];
      assert.equal(e.length, 3);
      assert.equal(new Set(e.map((x) => x.id)).size, 3, 'distinct fallbacks');
      for (const x of e) {
        const full = byId.get(x.id);
        for (const k of Object.keys(x)) assert.deepEqual(x[k], full[k], d + ' ' + kind + ' ' + x.name + ' ' + k);
        for (const k of ['id', 'name', 'lat', 'lon', 'view', 'z', 'nz', 'rw', 'continent', 'country', 'type']) assert.ok(x[k] !== undefined, 'has ' + k);
      }
    }
    assert.ok(schedule.days[d].daily.every((x) => x.top >= 1), 'Daily entries are top-list airports');
    assert.ok(schedule.days[d].hard.every((x) => !x.top), 'Hard entries are outside the top list');
  }
});
test('schedule equals what the app computes from the full lists (so the inlined entry is the same answer)', () => {
  const day = schedule.days['2026-10-06'];
  assert.deepEqual(day.daily.map((x) => x.id), C.dailyTopOrder(topList, '2026-10-06').slice(0, 3).map((x) => x.id));
  assert.deepEqual(day.hard.map((x) => x.id), C.dailyOrder(hardPool, '2026-10-06', 'hard:').slice(0, 3).map((x) => x.id));
});
test('inlined subset: yesterday, today, tomorrow (UTC) only, small enough to inline', () => {
  const sub = inlineSubset(schedule, new Date('2026-10-05T12:00:00Z'));
  assert.deepEqual(Object.keys(sub.days), ['2026-10-04', '2026-10-05', '2026-10-06']);
  assert.ok(JSON.stringify(sub).length < 12000, 'inline size ' + JSON.stringify(sub).length);
  assert.ok(JSON.stringify(schedule).length < 60000, 'daily.json size');
});
test('local date helpers across time zones and DST (run in separate processes with TZ set)', () => {
  const run = (tz, code) => execFileSync(process.execPath, ['--input-type=module', '-e', "import * as C from '" + new URL('../js/core.js', import.meta.url).href + "';" + code], { env: { ...process.env, TZ: tz } }).toString().trim();
  // 23:30 local on 5 Oct is still 5 Oct locally even though it is already 6 Oct in UTC (New York, UTC-4)
  assert.equal(run('America/New_York', "console.log(C.localDateString(new Date('2026-10-06T03:30:00Z')))"), '2026-10-05');
  // 00:30 local on 6 Oct in Auckland (UTC+13) is 5 Oct in UTC
  assert.equal(run('Pacific/Auckland', "console.log(C.localDateString(new Date('2026-10-05T11:30:00Z')))"), '2026-10-06');
  // everyone with the same local date gets the same airport: the date string is the only input
  assert.equal(run('Asia/Tokyo', "console.log(C.localDateString(new Date(2026, 9, 5, 0, 1)))"), run('America/Los_Angeles', "console.log(C.localDateString(new Date(2026, 9, 5, 23, 59)))"));
  // hours to the next local midnight on DST days: 23-hour day (spring forward) and 25-hour day (fall back)
  const h = (tz, y, m, d) => Number(run(tz, "console.log(C.msUntilNextLocalDay(new Date(" + y + ", " + m + ", " + d + ", 0, 30)) / 3600000)"));
  assert.equal(h('America/New_York', 2026, 2, 8), 22.5, 'spring forward day');
  assert.equal(h('America/New_York', 2026, 10, 1), 24.5, 'fall back day');
  assert.equal(h('Europe/Zurich', 2026, 2, 29), 22.5);
  assert.equal(h('Asia/Tokyo', 2026, 5, 15), 23.5, 'no DST');
  // the schedule window (UTC date +-1) always contains the local date of every time zone
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland']) {
    for (const iso of ['2026-10-05T00:00:00Z', '2026-10-05T12:00:00Z', '2026-10-05T23:59:00Z']) {
      const local = run(tz, "console.log(C.localDateString(new Date('" + iso + "')))");
      assert.ok(Object.keys(inlineSubset(schedule, new Date(iso)).days).includes(local), tz + ' ' + iso + ' -> ' + local);
    }
  }
});

console.log('locked view: zoom fitting and image quality');
const everyone = [...airports, ...hard];
const FRAMES = [[358, 371, 27], [604, 585, 18], [328, 326, 27], [736, 451, 18], [390, 250, 27]]; // phone, desktop, small phone, tablet, short
test('fit: whole zoom, rounded down; every runway endpoint inside the safe rect (>= 6% margin, clear of chips and pill); fill <= 78%', () => {
  for (const [W, H, pill] of FRAMES) {
    const r = C.safeRect(W, H, pill);
    assert.ok(r.l >= 0.06 * W - 1e-9 && W - r.r >= 0.06 * W - 1e-9 && r.t >= 0.06 * H - 1e-9 && H - r.b >= 0.06 * H - 1e-9, 'margin');
    assert.ok(r.t >= C.CHIPS_BOTTOM + C.GAP - 1e-9 && H - r.b >= pill + C.GAP - 1e-9, 'chips and pill are occupied space');
    for (const a of everyone) {
      const z = C.fitZoom(a, W, H, { pill });
      assert.ok(Number.isInteger(z), 'whole zoom');
      if (z <= 8 || z >= 19) continue;
      const k = C.pxPerMetre(z, a.view[0]);
      const ex = Math.max(a.view[2], C.MIN_BOX_M) * k, ey = Math.max(a.view[3], C.MIN_BOX_M) * k;
      assert.ok(C.fillAt(a, W, H, z) <= C.MAX_FILL + 1e-9, a.name + ' fill ' + C.fillAt(a, W, H, z));
      assert.ok(ex <= r.r - r.l + 1e-6 && ey <= r.b - r.t + 1e-6, a.name + ' endpoints inside the safe rect');
      // rounding down: one level tighter would break a rule
      const k1 = C.pxPerMetre(z + 1, a.view[0]);
      const ex1 = Math.max(a.view[2], C.MIN_BOX_M) * k1, ey1 = Math.max(a.view[3], C.MIN_BOX_M) * k1;
      assert.ok(C.fillAt(a, W, H, z + 1) > C.MAX_FILL || ex1 > r.r - r.l || ey1 > r.b - r.t, a.name + ' is the largest zoom that fits');
    }
  }
});
test('airfield centred in the safe rect: no endpoint within 6% of an edge, none under the chips or the pill', () => {
  for (const [W, H, pill] of FRAMES.slice(0, 2)) {
    const r = C.safeRect(W, H, pill);
    const lift = C.airfieldLift(W, H, pill);
    for (const a of everyone) {
      const z = C.finalZoom(a, W, H, 1, { pill });
      const k = C.pxPerMetre(z, a.view[0]);
      const ex = Math.max(a.view[2], C.MIN_BOX_M) * k, ey = Math.max(a.view[3], C.MIN_BOX_M) * k;
      const left = W / 2 - ex / 2, right = W / 2 + ex / 2, top = H / 2 - lift - ey / 2, bottom = H / 2 - lift + ey / 2;
      const small = a.nz - 1 < a.z;
      if (small || a.z <= 8 || a.z >= 19) continue; // imagery-capped (smaller than the fit by design) or at the zoom limits
      assert.ok(left >= 0.06 * W - 1 && right <= W - 0.06 * W + 1 && top >= 0.06 * H - 1 && bottom <= H - 0.06 * H + 1, a.name + ' 6% margin');
      assert.ok(top >= C.CHIPS_BOTTOM + C.GAP - 1 && bottom <= H - pill - C.GAP + 1, a.name + ' clear of chips and pill');
    }
  }
});
test('one zoom per airport: a.z = the smaller of the phone and desktop fits (build and app agree); same on every normal frame', () => {
  for (const a of everyone) {
    assert.equal(a.z, C.baseZoom(a), a.name);
    const phone = C.fitZoom(a, 358, 371, { pill: 27 }), desktop = C.fitZoom(a, 604, 585, { pill: 18 });
    assert.equal(a.z, Math.min(phone, desktop));
    for (const [W, H, pill] of [[358, 371, 27], [604, 585, 18], [736, 451, 18], [900, 700, 18]]) assert.equal(C.finalZoom(a, W, H, 1, { pill }), Math.min(a.z, a.nz - 1), a.name + ' ' + W);
  }
});
test('a frame smaller than the reference frames only ever zooms OUT further (the airfield never leaves the frame)', () => {
  let wider = 0;
  for (const a of everyone) {
    const z = C.finalZoom(a, 328, 150, 1, { pill: 27 });
    assert.ok(z <= Math.min(a.z, a.nz - 1));
    if (z < a.z) wider++;
  }
  assert.ok(wider > 0, 'a very short frame (keyboard open) does zoom out');
});
test('small airfields are much tighter than hubs', () => {
  const hub = byIata('ATL').z;
  assert.ok(byIata('DQM').z >= hub - 1);
  const small = hard.find((a) => a.view[2] < 400 && a.view[3] > 500 && a.view[3] < 900);
  assert.ok(small.z - hub >= 1, 'small airfield vs ATL: ' + small.z + ' vs ' + hub);
  const zs = hard.map((a) => a.z).sort((x, y) => x - y);
  assert.ok(zs[Math.floor(zs.length / 2)] - hub >= 1, 'median hard airfield is >= 1 level tighter than a hub');
});
test('retina levels: tiles are requested deeper so every CSS pixel has real pixels (capped at +1)', () => {
  assert.deepEqual([1, 1.25, 1.5, 2, 2.625, 3, 3.5, 4].map(C.retinaLevels), [0, 1, 1, 1, 1, 1, 1, 1], 'extra levels capped at +1');
  for (const dpr of [1, 1.5, 2]) assert.ok(2 ** C.retinaLevels(dpr) / dpr >= 1 - 1e-9, 'dpr ' + dpr + ': native 1:1 or better');
});
test('native cap: zoom + retina levels <= nz for every airport, and a smaller airport beats a blurry one', () => {
  for (const a of everyone) for (const dpr of [1, 2, 3]) {
    const n = C.retinaLevels(dpr);
    assert.ok(C.finalZoom(a, 358, 371, n) + n <= a.nz, a.name);
  }
  const poor = { ...byIata('ATL'), nz: 13 };
  assert.equal(C.finalZoom(poor, 358, 371, 1), 12);
  assert.equal(C.finalZoom(poor, 358, 371, 0), Math.min(poor.z, 13));
});
test('pool filter: an airport is kept unless the imagery cap forces a view where the airfield fills < 45% of the reference phone (worst-case retina)', () => {
  const { W, H, retinaLevels } = C.REF_FRAME;
  for (const a of everyone) {
    assert.ok(a.nz >= 10 && a.nz <= 19, a.name + ' nz ' + a.nz);
    const cap = a.nz - retinaLevels;
    assert.ok(a.z <= cap || C.fillAt(a, W, H, cap) >= C.MIN_FILL - 1e-9, a.name + ' z' + a.z + ' cap ' + cap);
  }
  for (const a of airports.filter((x) => x.top)) assert.ok(a.z <= a.nz - retinaLevels, 'top airport ' + a.iata + ' is never capped');
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
