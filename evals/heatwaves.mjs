/**
 * Real heat disasters, replayed: what Sudor would have told the people who died, on the days they died.
 *
 * BACKTEST.md counts how often Sudor's answer for a sensitive person differs from the answer for anybody. That says
 * nothing about whether it would have helped. The county reports on two of the worst heat disasters in America say
 * who died and how, and the archived hourly weather says what those days were like, so the question can be asked
 * directly: for the person the report describes, on that day, would Sudor have said what mattered?
 *
 *   Portland, the June 2021 heat dome. Multnomah County: 72 heat deaths in 2021, 69 of them in one five day heat
 *   wave in June; 78 percent were 60 or older, 71 percent lived alone, 94 percent died in their own home, and only
 *   10 death investigations mentioned a cooling unit, 7 of them broken or unplugged.
 *
 *   Phoenix, July 2023. Maricopa County counted 645 heat deaths that year, a record; in its following report, among
 *   people who died indoors, 88 percent had an air conditioner and 70 percent of those did not work.
 *
 * For each, the person is built from the report (an older adult, living alone, no working cooling) and judged at
 * nine in the morning on each day of the event, through the same code the server runs: the indoor judgement, which
 * decides "your home is too hot to stay in" and the email to family who agreed; the hourly verdict at the hottest
 * hour; and the measured older adult limit. A control with working cooling must hear nothing about the home.
 *
 * The weather is Open-Meteo's archive (reanalysis of observations, not a forecast), fetched once with `--fetch` and
 * kept in evals/heatwaves-weather.json, so the replay runs offline. It is a check written by the same project it
 * checks: it shows where Sudor and the record part company, and is not an independent score.
 *
 *   node evals/heatwaves.mjs --fetch   # fetch the archive once
 *   node evals/heatwaves.mjs           # replay, print, write evals/heatwaves-last-run.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const WEATHER = new URL('heatwaves-weather.json', here);

export const EVENTS = [
  {
    id: 'portland2021',
    title: 'Portland, June 2021 heat dome',
    lat: 45.52, lon: -122.68, utcOffsetSeconds: -7 * 3600, timezone: 'America/Los_Angeles',
    start: '2021-06-25', end: '2021-06-30', days: ['2021-06-26', '2021-06-27', '2021-06-28'],
    source: 'https://multco.us/news/2021-heat-killed-72-people-multnomah-county-most-were-older-lived-alone-had-no-ac',
    who: 'over 60, living alone, no working cooling, at home',
    person: { conditions: ['older_adult'], medications: [], cooling: 'none', livesAlone: true },
  },
  {
    id: 'phoenix2023',
    title: 'Phoenix, July 2023',
    lat: 33.45, lon: -112.07, utcOffsetSeconds: -7 * 3600, timezone: 'America/Phoenix',
    start: '2023-07-14', end: '2023-07-24', days: ['2023-07-15', '2023-07-18', '2023-07-20', '2023-07-22'],
    source: 'https://www.maricopa.gov/CivicAlerts.aspx?AID=3222',
    who: 'over 65, living alone, an air conditioner that does not work, at home',
    person: { conditions: ['older_adult'], medications: [], cooling: 'broken', livesAlone: true },
  },
];

async function fetchArchive() {
  const out = {};
  for (const e of EVENTS) {
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${e.lat}&longitude=${e.lon}&start_date=${e.start}&end_date=${e.end}` +
      '&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,is_day&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`archive ${res.status} for ${e.id}`);
    const h = (await res.json()).hourly;
    out[e.id] = h.time.map((t, i) => ({ time: `${t}:00Z`, tempF: h.temperature_2m[i], humidityPct: h.relative_humidity_2m[i], windMph: h.wind_speed_10m[i], isDay: h.is_day[i] === 1 }));
  }
  writeFileSync(WEATHER, JSON.stringify({ source: 'Open-Meteo historical weather archive', url: 'https://open-meteo.com/en/docs/historical-weather-api', events: out }, null, 1) + '\n');
  return out;
}

export async function replay() {
  const personal = await import('../dist/personal.js');
  const indoor = await import('../dist/indoor.js');
  const { events } = JSON.parse(readFileSync(WEATHER, 'utf8'));
  const runs = [];
  for (const e of EVENTS) {
    const all = events[e.id].filter((h) => Number.isFinite(h.tempF) && Number.isFinite(h.humidityPct));
    const localOf = (iso) => new Date(new Date(iso).getTime() + e.utcOffsetSeconds * 1000).toISOString().slice(0, 16);
    const hourly = all.map((h) => ({ ...h, local: localOf(h.time), uvIndex: 0, aqi: null, wetBulbF: 0 }));
    const profile = personal.profileOf(e.person.medications, e.person.conditions);
    const results = e.days.map((day) => {
      // Nine in the morning, local: the time a person first asks, and the time the family email is judged from.
      const now = new Date(new Date(`${day}T09:00:00Z`).getTime() - e.utcOffsetSeconds * 1000);
      const at = hourly.reduce((a, h) => (Math.abs(new Date(h.time) - now) < Math.abs(new Date(a.time) - now) ? h : a));
      const snap = { lat: e.lat, lon: e.lon, fetchedAt: now.toISOString(), timezone: e.timezone, utcOffsetSeconds: e.utcOffsetSeconds, tempF: at.tempF, humidityPct: at.humidityPct, uvIndex: 0, windMph: at.windMph, isDay: at.isDay, aqi: null, wetBulbF: 0, hourly, stale: false };
      const home = indoor.indoorRisk(snap, e.person, true, now);
      const control = indoor.indoorRisk(snap, { ...e.person, cooling: 'working' }, true, now);
      const today = hourly.filter((h) => h.local.startsWith(day));
      const hottest = today.reduce((a, h) => (h.tempF > a.tempF ? h : a), today[0]);
      const judged = personal.judgeHour(hottest, profile);
      const nights = hourly.filter((h) => { const t = new Date(h.time).getTime(); return t >= now.getTime() && t <= now.getTime() + 24 * 3600e3 && !h.isDay; });
      return {
        day,
        highF: Math.round(hottest.tempF),
        overnightLowF: nights.length ? Math.round(Math.min(...nights.map((h) => h.tempF))) : null,
        homeLevel: home?.level ?? null,
        familyTold: home?.level === 'danger',
        homeLine: home?.line ?? null,
        hottestHour: { local: hottest.local, status: judged.status, pastOlderLimit: judged.reasons.includes(personal.OLDER_LIMIT_REASON) },
        controlQuiet: control === null,
      };
    });
    runs.push({ id: e.id, title: e.title, who: e.who, source: e.source, results });
  }
  return runs;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('evals/heatwaves.mjs')) {
  if (process.argv.includes('--fetch') || !existsSync(WEATHER)) await fetchArchive();
  const runs = await replay();
  for (const r of runs) {
    console.log(`\n${r.title}: ${r.who}`);
    for (const x of r.results) {
      console.log(`  ${x.day}  high ${x.highF}, night ${x.overnightLowF}  home: ${x.homeLevel ?? 'nothing said'}${x.familyTold ? ', family told' : ''}  hottest hour: ${x.hottestHour.status}${x.hottestHour.pastOlderLimit ? ', past the measured limit' : ''}  control quiet: ${x.controlQuiet}`);
    }
  }
  if (!process.env.HEATWAVES_NO_WRITE) writeFileSync(new URL('heatwaves-last-run.json', here), JSON.stringify(runs, null, 2) + '\n');
}
