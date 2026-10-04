/**
 * What Sudor would have said, on days that already happened.
 *
 * The routing evaluation shows a host picks the right tool. This asks whether the answer is worth having:
 * how often does judging the heat for one person's medicines and conditions give a different answer from
 * judging it for anybody?
 *
 * It replays the measured hourly weather for July 2026 (Open-Meteo's archive, which is reanalysis of
 * observations, not a forecast) in six American cities through the same code the server runs, for two
 * people: one with nothing registered, and one on a beta blocker and a diuretic with heart disease, which
 * is an ordinary medicine cabinet for somebody over seventy.
 *
 * What it does not show: that anybody was harmed or protected. It counts how often the two answers differ.
 * UV and air quality are left out of both, because the archive does not carry them, so the difference
 * counted here is from heat alone and is, if anything, an undercount.
 *
 *   node evals/backtest.mjs          # prints the table and writes BACKTEST.md
 */
import { writeFileSync } from 'node:fs';

const personal = await import('../dist/personal.js');
const meds = await import('../dist/meds.js');

const CITIES = [
  { name: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 },
  { name: 'Houston, Texas', lat: 29.76, lon: -95.37 },
  { name: 'Tampa, Florida', lat: 27.95, lon: -82.46 },
  { name: 'St. Louis, Missouri', lat: 38.63, lon: -90.2 },
  { name: 'Chicago, Illinois', lat: 41.88, lon: -87.63 },
  { name: 'Minneapolis, Minnesota', lat: 44.98, lon: -93.27 },
];
const START = '2026-07-01';
const END = '2026-07-31';

const taken = ['metoprolol', 'furosemide'].map((g) => meds.MEDICATIONS.find((m) => m.generic === g));
if (taken.some((m) => !m)) throw new Error('a medicine in this replay is not in the table');
const anybody = personal.profileOf([], [], { outings: [] });
const person = personal.profileOf(taken.flatMap((m) => m.mechanisms), ['heart_disease'], { outings: [] });

async function month(city) {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&start_date=${START}&end_date=${END}` +
    '&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,is_day&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`archive ${res.status} for ${city.name}`);
  const h = (await res.json()).hourly;
  return h.time
    .map((local, i) => ({ local, time: local, tempF: h.temperature_2m[i], humidityPct: h.relative_humidity_2m[i], windMph: h.wind_speed_10m[i], isDay: h.is_day[i] === 1, uvIndex: 0, aqi: null, solarWm2: null, wetBulbF: null }))
    .filter((x) => typeof x.tempF === 'number' && typeof x.humidityPct === 'number');
}

const rows = [];
for (const city of CITIES) {
  const hours = (await month(city)).filter((h) => { const hr = Number(h.local.slice(11, 13)); return hr >= 6 && hr <= 21; });
  let differ = 0, fineForAnybodyStayInForThem = 0;
  const days = new Map();
  for (const h of hours) {
    const a = personal.judgeHour(h, anybody).status;
    const p = personal.judgeHour(h, person).status;
    if (a !== p) differ += 1;
    if (a === 'good' && p !== 'good') fineForAnybodyStayInForThem += 1;
    const d = days.get(h.local.slice(0, 10)) ?? { anyGoodA: false, anyGoodP: false };
    if (a === 'good') d.anyGoodA = true;
    if (p === 'good') d.anyGoodP = true;
    days.set(h.local.slice(0, 10), d);
  }
  const noGoodP = [...days.values()].filter((d) => !d.anyGoodP).length;
  const noGoodA = [...days.values()].filter((d) => !d.anyGoodA).length;
  rows.push({ city: city.name, hours: hours.length, differ, fine: fineForAnybodyStayInForThem, days: days.size, noGoodA, noGoodP });
}

const pct = (n, d) => `${((100 * n) / d).toFixed(0)}%`;
const lines = [
  '# Backtest: July 2026, replayed',
  '',
  'Measured hourly weather (Open-Meteo archive), 6 am to 10 pm, through the same code the server runs.',
  '"Anybody" has nothing registered. "This person" takes metoprolol and furosemide and has heart disease.',
  '',
  '| City | Waking hours | Hours the two answers differ | Fine for anybody, not for this person | Days with no fine hour: anybody | Days with no fine hour: this person |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.city} | ${r.hours} | ${r.differ} (${pct(r.differ, r.hours)}) | ${r.fine} (${pct(r.fine, r.hours)}) | ${r.noGoodA} of ${r.days} | ${r.noGoodP} of ${r.days} |`),
  '',
  'What this shows: how often the answer for one person differs from the answer for anybody, on real days.',
  'What it does not show: that anybody was harmed or protected. UV and air quality are left out of both',
  'columns because the archive does not carry them, so the difference is from heat alone.',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`node evals/backtest.mjs\`.`,
  '',
];
writeFileSync('BACKTEST.md', lines.join('\n'));
console.log(lines.join('\n'));
