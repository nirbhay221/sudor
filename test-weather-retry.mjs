/**
 * A failed forecast read is tried again soon, not at the next twenty minute tick. See RETRY_MS in weather.ts.
 *
 * No network: fetch is replaced. The retry delays are shortened for the test.
 */
process.env.SUDOR_WEATHER_RETRY_MS = '50,50,50';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const forecast = {
  timezone: 'America/Phoenix', utc_offset_seconds: -25200,
  current: { time: '2026-10-18T12:00', temperature_2m: 88, relative_humidity_2m: 20, uv_index: 5, is_day: 1, wind_speed_10m: 4, shortwave_radiation: 600, wet_bulb_temperature_2m: 62 },
  hourly: { time: ['2026-10-18T12:00'], temperature_2m: [88], relative_humidity_2m: [20], uv_index: [5], is_day: [1], wind_speed_10m: [4], shortwave_radiation: [600], wet_bulb_temperature_2m: [62], weather_code: [0], surface_pressure: [1010] },
  daily: { time: ['2026-10-18'], temperature_2m_max: [90], temperature_2m_min: [65], apparent_temperature_max: [89], weather_code: [0] },
};
let calls = 0;
globalThis.fetch = async (url) => {
  const forecastCall = String(url).includes('/v1/forecast');
  if (forecastCall) calls += 1;
  // The first two forecast reads fail, as Open-Meteo did on 18 October 2026: a 503, then a timeout.
  if (forecastCall && calls <= 2) return { ok: false, status: 503, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => (forecastCall ? forecast : { current: { us_aqi: 30 }, hourly: { time: [], us_aqi: [] } }) };
};

const weather = await import('./dist/weather.js');
console.log('\nA failed forecast read is tried again soon');
weather.watch(33.45, -112.07, true);
await new Promise((r) => setTimeout(r, 20));
const first = weather.current(33.45, -112.07);
check('the first read failed, and that is said as stale, never as a temperature', !first || first.stale === true);
await new Promise((r) => setTimeout(r, 400));
const later = weather.current(33.45, -112.07);
check('...and within the retries the forecast arrives, without waiting twenty minutes', later && later.stale !== true && later.tempF === 88, JSON.stringify(later?.error ?? later?.tempF));
check('...after exactly three reads, two failed and one good', calls === 3, String(calls));
weather.stopAll();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
