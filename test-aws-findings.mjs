/**
 * What a session against the deployed server found, October 2026, each pinned here.
 *
 *   the first question after setting a place   "I'm still looking up Phoenix, ask me again in a moment": the
 *                                               lookup finished a tenth of a second after the question arrived
 *   first aid for heat exhaustion              spoke to "you" and then "if they vomit" in the same breath
 *
 * Nothing here touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-aws-findings';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.SUDOR_DATA_KEY;

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const { settle } = await import('./dist/tools/shared.js');
const { triage } = await import('./dist/firstaid.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

console.log('\nThe first question after setting a place waits for it, briefly');
{
  const LAT = 33.45, LON = -112.07;
  store.update('acct:soon', (p) => { p.locationName = 'Phoenix'; p.locationStatus = 'locating'; });
  // The lookup and the weather land 300 ms later, as they did on the deployed server.
  setTimeout(() => {
    store.update('acct:soon', (p) => { p.lat = LAT; p.lon = LON; p.locationName = 'Phoenix, Arizona'; p.locationStatus = 'ready'; });
    weather.seedForTest({ lat: LAT, lon: LON, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: -25200, tempF: 90, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: true, aqi: 40, wetBulbF: 65, hourly: [], daily: [] });
  }, 300);
  const t0 = Date.now();
  await settle('acct:soon');
  const waited = Date.now() - t0;
  check('it waits for the lookup and the weather, then answers', store.get('acct:soon').locationStatus === 'ready' && weather.current(LAT, LON) && waited >= 250 && waited < 2500, `${waited} ms`);
  const t1 = Date.now();
  await settle('acct:nobody');
  check('with no place set it does not wait at all', Date.now() - t1 < 50, `${Date.now() - t1} ms`);
  store.update('acct:lost', (p) => { p.locationName = 'Nowhere'; p.locationStatus = 'not_found'; });
  const t2 = Date.now();
  await settle('acct:lost');
  check('nor for a place that could not be found', Date.now() - t2 < 50);
  store.update('acct:slow', (p) => { p.locationName = 'Somewhere'; p.locationStatus = 'locating'; });
  const t3 = Date.now();
  await settle('acct:slow', 400);
  check('and a lookup that never lands is waited for only so long', Date.now() - t3 < 700, `${Date.now() - t3} ms`);
}

console.log('\nFirst aid speaks to one person at a time');
{
  for (const said of ['dizzy and headache', 'my dad is dizzy and has a headache']) {
    const r = triage(said);
    check(`"${said}": no "they" beside "you"`, !/\bthey vomit\b/.test(r.spoken) && /vomiting/.test(r.spoken), r.spoken);
  }
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
