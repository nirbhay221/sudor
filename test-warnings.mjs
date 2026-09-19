/**
 * Official warnings, and what a storm means for a medicine cabinet.
 *
 * The weather service is faked here: what is being tested is the judgement
 * around an alert, not the feed. Namely that the weather service's own words
 * are read out rather than reworded, that the personal half follows the
 * person's own list, that privacy still holds, and that "I could not check"
 * never comes out as "no warnings".
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-warnings.json', { force: true });
process.env.SUDOR_DATA = './data/test-warnings.json';

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const warnings = await import('./dist/warnings.js');
const { registerTools } = await import('./dist/tools.js');

const tools = {};
const who = 'warn-tester';
registerTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => who);
const text = (r) => r.content[0].text;

const LAT = 33.45, LON = -112.07;
const alert = (event, severity = 'Severe', instruction = 'Move to higher ground now. Act quickly to protect your life.') => ({
  id: event,
  event,
  kind: warnings.classify(event),
  severity,
  urgency: 'Immediate',
  headline: `${event} issued`,
  instruction,
  areaDesc: 'Maricopa, AZ',
  onset: null,
  ends: new Date(Date.now() + 3 * 3600e3).toISOString(),
});

// A real forecast is not wanted here either, so the location is seeded.
weather.seedForTest({
  lat: LAT, lon: LON, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: -25200,
  tempF: 96, humidityPct: 20, uvIndex: 7, windMph: 5, isDay: true, aqi: 40, hourly: [], stale: false,
});
store.update(who, (p) => {
  p.lat = LAT;
  p.lon = LON;
  p.locationName = 'Phoenix, Arizona';
  p.locationStatus = 'ready';
});

console.log('\nWhat kind of trouble an alert is');
for (const [event, kind] of [
  ['Extreme Heat Warning', 'heat'], ['Heat Advisory', 'heat'],
  ['Winter Storm Warning', 'cold'], ['Extreme Cold Warning', 'cold'], ['Blizzard Warning', 'cold'],
  ['Air Quality Alert', 'air'], ['Flash Flood Warning', 'flood'],
  ['Hurricane Warning', 'power'], ['High Wind Warning', 'power'],
]) {
  check(`${event} is a ${kind} problem`, warnings.classify(event) === kind, warnings.classify(event));
}
check('an ice storm counts as one that takes the power out', warnings.cutsPower(alert('Ice Storm Warning')));
check('a heat advisory does not', !warnings.cutsPower(alert('Heat Advisory')));

console.log('\nThe weather service is quoted, not reworded');
const long = 'Turn around, do not drown. Most flood deaths occur in vehicles. Report flooding to local law enforcement when it is safe. Stay away from creeks.';
const brief = warnings.brief(long);
check('it stops at a sentence end, never mid word', /vehicles\.|that\./.test(brief) && !/enforcemen$/.test(brief), brief);
check('...and says when there is more', /There is more to it than that\./.test(brief), brief);

console.log('\nBefore anything has been checked');
warnings.configureForTest(async () => { throw new Error('unreachable'); });
check('it says it has not checked, rather than saying there is nothing',
  /managed to reach the weather service/.test(text(await tools.weather_warnings({}))), text(await tools.weather_warnings({})));
await warnings.refresh(LAT, LON, true);
check('...and a failed check still does not become an all clear',
  /managed to reach the weather service/.test(text(await tools.weather_warnings({}))), text(await tools.weather_warnings({})));

console.log('\nWith nothing running');
warnings.configureForTest(async () => []);
await warnings.refresh(LAT, LON, true);
check('it says so, and how often it looks',
  /No weather warnings for Phoenix, Arizona right now/.test(text(await tools.weather_warnings({}))));

console.log('\nA heat warning, for someone heat sensitive');
warnings.seedForTest(LAT, LON, [alert('Extreme Heat Warning', 'Extreme', 'Drink plenty of fluids and stay out of the sun.')]);
await tools.health_condition({ action: 'add', condition: 'multiple sclerosis' });
const heat = await tools.weather_warnings({});
check('the alert and the area are named', /Extreme Heat Warning for Maricopa, AZ/.test(text(heat)), text(heat));
check('...with an end time in their own clock', / until /.test(text(heat)), text(heat));
check('...the words of the weather service are read out', /Drink plenty of fluids/.test(text(heat)));
check('...and it says why this one is worse for them', /harder on you than on most people/.test(text(heat)), text(heat));

console.log('\nA storm that can take the power out');
await tools.health_condition({ action: 'add', condition: 'diabetes' });
warnings.seedForTest(LAT, LON, [alert('Ice Storm Warning', 'Severe', 'Travel could become nearly impossible.')]);
check('it points at the medicines before the power goes, not after',
  /ask me what to do about your medicines before it does/.test(text(await tools.weather_warnings({}))));

console.log('\nA flood, where leaving is the risk');
warnings.seedForTest(LAT, LON, [alert('Flash Flood Warning')]);
await tools.medication({ action: 'add', name: 'lisinopril' });
check('it says to take the medicines and the list',
  /take your medicines and a written list/.test(text(await tools.weather_warnings({}))));

console.log('\nGetting ready, by what this person actually takes');
warnings.seedForTest(LAT, LON, [alert('Ice Storm Warning')]);
const prep = await tools.storm_prep({});
check('insulin gets its temperature range and the emergency exception',
  /36 and 46 degrees/.test(text(prep)) && /still be used in an emergency/.test(text(prep)), text(prep).slice(0, 120));
check('...and it never says to skip a dose', !/skip (a|your) dose/i.test(text(prep)));
check('a week of everything, written on paper', /at least a week of everything/.test(text(prep)));
check('the alert is named at the front', /^Ice Storm Warning is up for your area\./.test(text(prep)), text(prep).slice(0, 60));
check('a cold outage warns about generators indoors', /never run a generator, grill or/.test(text(prep)), text(prep).slice(-140));
await tools.health_condition({ action: 'add', condition: 'dialysis' });
const withDialysis = text(await tools.storm_prep({}));
check('dialysis gets the clinic call and the three day diet',
  /Ring your dialysis unit today/.test(withDialysis) && /three day emergency diet/.test(withDialysis), withDialysis.slice(0, 120));

console.log('\nIn a room with other people in it');
await tools.set_privacy({ on: true });
warnings.seedForTest(LAT, LON, [alert('Extreme Heat Warning', 'Extreme', 'Stay out of the sun.')]);
const priv = await tools.weather_warnings({});
check('privacy mode still warns, without naming the condition',
  /Something in your health profile/.test(text(priv)) && !/multiple sclerosis/i.test(text(priv)), text(priv));
await tools.set_privacy({ on: false });

warnings.configureForTest(null);
rmSync('./data/test-warnings.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
