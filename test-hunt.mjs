/**
 * Bugs found by reading the code against what the services it calls really send, each tested as fixed.
 * No network: every service answer here is a copy of a real one, cut down.
 *
 *   1. "London, UK" and "San Juan, Puerto Rico" were not found, and a geocoder that did not answer was told
 *      to the person as a place that does not exist.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const geo = await import('./dist/geocode.js');
const realFetch = globalThis.fetch;

console.log('\nA place, said the way people say it');
{
  const london = [
    { name: 'London', admin1: 'England', country: 'United Kingdom', country_code: 'GB', latitude: 51.51, longitude: -0.13 },
    { name: 'London', admin1: 'Ontario', country: 'Canada', country_code: 'CA', latitude: 42.98, longitude: -81.25 },
  ];
  check('"London, UK" is found', geo.pickPlace('London, UK', london)?.country === 'GB');
  // The geocoder gives Puerto Rico a code and no country name.
  const sanJuan = [{ name: 'San Juan', admin1: 'San Juan', country_code: 'PR', latitude: 18.47, longitude: -66.11 }];
  const pr = geo.pickPlace('San Juan, Puerto Rico', sanJuan);
  check('"San Juan, Puerto Rico" is found, and named', pr?.country === 'PR' && pr?.countryName === 'Puerto Rico', JSON.stringify(pr));
  check('"France" is FR, not the FX code that also reads "France"', geo.countryCodeOf('France') === 'FR');
  check('"Lyon, France" still is not Lyon, Mississippi', geo.pickPlace('Lyon, France', [
    { name: 'Lyon', admin1: 'Mississippi', country: 'United States', country_code: 'US', latitude: 34.2, longitude: -90.5 },
    { name: 'Lyon', admin1: 'Auvergne-Rhône-Alpes', country: 'France', country_code: 'FR', latitude: 45.75, longitude: 4.85 },
  ])?.country === 'FR');

  // The search is made within the country that was named.
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ results: sanJuan })); };
  await geo.geocode('San Juan, Puerto Rico');
  check('...and searched within that country', asked.some((u) => u.includes('countryCode=PR')), asked.join(' '));

  globalThis.fetch = async () => { throw new Error('timeout'); };
  let down = false;
  try { await geo.geocode('Phoenix, AZ', 100); } catch (err) { down = err instanceof geo.GeocoderDown; }
  check('a geocoder that does not answer is "down", not "no such place"', down);
  globalThis.fetch = async () => new Response('busy', { status: 503 });
  down = false;
  try { await geo.geocode('Phoenix, AZ', 100); } catch (err) { down = err instanceof geo.GeocoderDown; }
  check('...and so is one that answers 503', down);
  globalThis.fetch = async () => new Response(JSON.stringify({}));
  check('a place the geocoder does not know is still null', (await geo.geocode('Xyzzyville, AZ', 100)) === null);
  globalThis.fetch = realFetch;
}

console.log('\nThe night the clocks change');
{
  const weather = await import('./dist/weather.js');
  // Open-Meteo, asked on the evening of 31 October 2026 in Chicago: one offset, CDT's, for every hour.
  const snap = weather.parseForecast(41.88, -87.63, {
    timezone: 'America/Chicago', utc_offset_seconds: -18000,
    current: { temperature_2m: 50, relative_humidity_2m: 60 },
    hourly: { time: ['2026-10-31T23:00', '2026-11-01T03:00', '2026-11-01T15:00'], temperature_2m: [50, 48, 60], relative_humidity_2m: [60, 60, 50] },
  }, null);
  check('an hour before the change keeps daylight time', snap.hourly[0].time === '2026-11-01T04:00:00.000Z', snap.hourly[0].time);
  check('an hour after it is on standard time, not an hour out', snap.hourly[1].time === '2026-11-01T09:00:00.000Z', snap.hourly[1].time);
  check('...and so is the afternoon', snap.hourly[2].time === '2026-11-01T21:00:00.000Z', snap.hourly[2].time);
  check('a place with no zone given still uses the offset', weather.localToUtc('2026-09-12T15:00', -25200) === '2026-09-12T22:00:00.000Z');
}

console.log('\nGuessing a share code from the sandbox');
{
  const { mkdirSync, rmSync } = await import('node:fs');
  rmSync('./data/test-hunt', { recursive: true, force: true });
  mkdirSync('./data/test-hunt', { recursive: true });
  process.env.SUDOR_DATA = './data/test-hunt/people.json';
  process.env.SUDOR_OUTBOX = './data/test-hunt/outbox.jsonl';
  process.env.SUDOR_AUTH_DATA = './data/test-hunt/auth.json';
  const { registerTools } = await import('./dist/tools.js');
  const { requestCaller } = await import('./dist/caller.js');
  const { randomBytes } = await import('node:crypto');
  let who = '';
  const t = {};
  registerTools({ registerTool: (name, _cfg, handler) => { t[name] = handler; }, registerResource() {}, resource() {} }, () => who);
  // Every request a new made-up sandbox id, all from one address.
  const answers = [];
  for (let i = 0; i < 7; i++) {
    who = `demo:${randomBytes(16).toString('hex')}`;
    answers.push(await requestCaller.run('ip:203.0.113.9', () => t.share_my_day({ action: 'join', code: String(10_000_000 + i) })));
  }
  check('a new sandbox id for every guess does not buy new guesses', answers.slice(5).every((a) => a.structuredContent.reason === 'limit'), answers.map((a) => a.structuredContent.reason).join(','));
  who = `demo:${randomBytes(16).toString('hex')}`;
  const elsewhere = await requestCaller.run('ip:198.51.100.4', () => t.share_my_day({ action: 'join', code: '12345678' }));
  check('...while somebody at another address still gets theirs', elsewhere.structuredContent.reason === 'unknown', elsewhere.structuredContent.reason);
  rmSync('./data/test-hunt', { recursive: true, force: true });
}

console.log('\nA phone number typed on the consent page');
{
  const texts = await import('./dist/texts.js');
  check('a US number is taken, in any of the usual forms', ['(602) 555-0100', '+1 602 555 0100', '16025550100'].every((n) => texts.phoneOf(n) === '+16025550100'));
  check('a number in a country nobody switched on is not', texts.phoneOf('+44 7700 900123') === null && texts.phoneOf('+881 1234 5678') === null);
  check('+1 with the wrong number of digits is not', texts.phoneOf('+1 602 555 01') === null);
  process.env.SUDOR_SMS_COUNTRY_CODES = '1,44';
  check('...and a country switched on is', texts.phoneOf('+44 7700 900123') === '+447700900123');
  delete process.env.SUDOR_SMS_COUNTRY_CODES;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
