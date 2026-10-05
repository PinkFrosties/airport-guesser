// Prints the Daily list in rank order and the next days' schedule. Usage: node scripts/preview_daily.mjs [days=30]
import { readFileSync } from 'node:fs';
import * as C from '../js/core.js';

const data = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const airports = data('airports.json').airports;
const hard = data('airports-hard.json').airports;
const ranking = data('top50.json');
const top = airports.filter((a) => a.top).sort((a, b) => a.top - b.top);
const days = Number(process.argv[2]) || 30;

console.log(`Daily pool: ${top.length} airports, ${ranking.source}, ${ranking.year}, retrieved ${ranking.retrieved}\n`);
console.log('rank  IATA  ICAO  passengers   airport (city, country)');
for (const r of ranking.airports) {
  const a = top.find((x) => x.top === r.rank);
  console.log(`${String(r.rank).padStart(4)}  ${a.iata}   ${a.icao}  ${String(r.passengers).padStart(11)}  ${a.name} (${a.city || r.city}, ${a.country})`);
}
const start = C.localDateString();
const seq = Array.from({ length: days }, (_, i) => ({ date: C.addDays(start, i), a: C.dailyTopOrder(top, C.addDays(start, i))[0] }));
console.log(`\nNext ${days} days:`);
console.log(seq.map((s, i) => `${String(i + 1).padStart(2)} ${s.date} #${String(s.a.top).padStart(2)} ${s.a.iata}`).join('\n'));
const ids = new Set(seq.map((s) => s.a.id));
console.log(`\nunique airports in ${days} days: ${ids.size}; all from the list: ${seq.every((s) => s.a.top >= 1)}`);
const hardPool = [...airports.filter((a) => !a.top), ...hard];
console.log(`\nPool sizes: Daily ${top.length}, Hard ${hardPool.length} (${airports.length - top.length} other international + ${hard.length} regional/small/remote), full database ${airports.length + hard.length}`);
