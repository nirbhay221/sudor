/**
 * Somewhere to go, and the honesty rules around saying it.
 *
 * Three things can go wrong here and all three send someone back into a cold
 * house: saying nothing is open when the check simply failed, saying a building
 * has a generator when the feed did not say so, and burying 211, which is the
 * number that actually knows about the library that opened this morning.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-shelters.json', { force: true });
process.env.SUDOR_DATA = './data/test-shelters.json';

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const shelters = await import('./dist/shelters.js');
const { registerTools } = await import('./dist/tools.js');

const tools = {};
let who = 'shelter-test';
registerTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => who);
const text = (r) => r.content[0].text;

// Minneapolis in a cold snap, and a real distance to measure against.
const lat = 44.98, lon = -93.27;
weather.seedForTest({
  lat,
  lon,
  fetchedAt: new Date().toISOString(),
  timezone: 'America/Chicago',
  utcOffsetSeconds: -21600,
  tempF: 8,
  humidityPct: 65,
  uvIndex: 0,
  windMph: 12,
  isDay: true,
  aqi: 20,
  hours: [],
});

console.log('\nHow far away things are');
const miles = shelters.milesBetween(44.98, -93.27, 44.95, -93.09);
check('the distance between two real points is right to within a mile', miles > 8 && miles < 11, `${miles.toFixed(1)} miles`);

console.log('\nWhen the list could not be checked');
shelters.seedForTest(null);
await tools.register_location({ place: 'Minneapolis, Minnesota', lat, lon });
const unchecked = text(await tools.somewhere_to_go({}));
check('it says it could not find out, rather than that nothing is open',
  /could not reach/.test(unchecked) && !/nothing is open/i.test(unchecked), unchecked);
check('...and still hands over the number that does know', /211/.test(unchecked), unchecked);

console.log('\nWhen the list is checked and empty');
shelters.seedForTest([]);
const none = text(await tools.somewhere_to_go({}));
check('it says so plainly', /Nothing is open near you/.test(none), none);
check('...and explains why the federal list is usually empty', /declared disaster/.test(none), none);
check('...and sends them to 211 by phone and by text', /call 211/.test(none) && /898-211/.test(none), none);

console.log('\nWhen something is open');
shelters.seedForTest([
  { name: 'Far Away Armory', address: '1 Long Rd', city: 'Duluth', state: 'MN', lat: 46.79, lon: -92.1, generator: true, accessible: true, pets: 'Service animals only' },
  { name: 'Central Presbyterian Church', address: '500 Cedar St', city: 'Saint Paul', state: 'MN', lat: 44.95, lon: -93.09, generator: false, accessible: true, pets: null },
  { name: 'Powderhorn Rec Center', address: '3400 15th Ave S', city: 'Minneapolis', state: 'MN', lat: 44.94, lon: -93.25, generator: true, accessible: false, pets: 'Pets welcome' },
]);
const open = text(await tools.somewhere_to_go({}));
check('the nearest one is the one named', /Powderhorn Rec Center/.test(open), open);
check('...with the other nearby one counted, not listed', /1 more within an hour/.test(open), open);
check('...and one 135 miles away left out altogether', !/Far Away Armory/.test(open), open);
check('...and the relative or friend comes first, because the CDC says so',
  open.indexOf('relative or a friend') < open.indexOf('Powderhorn'), open.slice(0, 120));
check('...and it says to ring before setting off', /still open/.test(open), open);
const structured = (await tools.somewhere_to_go({})).structuredContent;
check('...and the list is there for a screen, nearest first, still inside the radius',
  structured.shelters[0].name === 'Powderhorn Rec Center' && structured.shelters.length === 2,
  JSON.stringify(structured.shelters.map((s) => s.name)));
check('...with the distance to one decimal, not rounded to nothing',
  structured.shelters[0].milesAway < 3, String(structured.shelters[0].milesAway));

console.log('\nWhat matters depends on who is asking');
await tools.health_condition({ action: 'add', condition: 'COPD' });
const powered = text(await tools.somewhere_to_go({}));
check('someone whose equipment needs power is told about the generator',
  /has a generator/.test(powered), powered);
shelters.seedForTest([
  { name: 'Quiet Hall', address: '2 Main St', city: 'Minneapolis', state: 'MN', lat: 44.98, lon: -93.28, generator: false, accessible: true, pets: null },
]);
const unknownPower = text(await tools.somewhere_to_go({}));
check('...and when the feed does not say, that gap is said out loud rather than glossed',
  /does not say whether it has a generator/.test(unknownPower), unknownPower);
check('...never claiming a generator that was not recorded',
  !/it has a generator, so equipment/.test(unknownPower), unknownPower);
check('every sentence in the answer starts with a capital',
  unknownPower.split(/(?<=\.)\s+/).every((sentence) => !/^[a-z]/.test(sentence.trim())), unknownPower);
check('a place under a mile away is not "about 0 miles"',
  /less than a mile away/.test(unknownPower) && !/0 miles/.test(unknownPower), unknownPower);

console.log('\nThe cold half');
check('in a cold snap it warns about heating the house with an oven or a generator indoors',
  /carbon monoxide/.test(unknownPower) && /never heat the house/i.test(unknownPower), unknownPower);
who = 'older-test';
await tools.register_location({ place: 'Minneapolis, Minnesota', lat, lon });
await tools.health_condition({ action: 'add', condition: 'I am 80 years old' });
const older = text(await tools.somewhere_to_go({}));
check('an older adult is told the indoor temperature that matters', /60 to 65 degrees/.test(older), older);
check('...and that it will not feel like an emergency', /will not feel like an emergency/.test(older), older);

console.log('\nWithout a place registered');
who = 'no-place-test';
const nowhere = text(await tools.somewhere_to_go({}));
check('it asks for a location instead of guessing one', /don't know where you are/.test(nowhere), nowhere);
check('...and still gives 211, which works anywhere', /211/.test(nowhere), nowhere);

rmSync('./data/test-shelters.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
