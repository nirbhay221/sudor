/**
 * The people at home, tested.
 *
 * The household tool was added beside the others. Two things are checked: that each person at home is judged
 * for their own body and said in one line after the customer's answer, and that a customer who never mentions
 * anybody else is answered exactly as before. Children are kept as an age group only. The network is off.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-household';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const week = await import('./dist/week.js');
const hh = await import('./dist/household.js');
const { registerTools } = await import('./dist/tools.js');
globalThis.fetch = async () => { throw new Error('network is off for this test'); };

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const LAT = 33.66, LON = -112.34, OFFSET = -7 * 3600;
const localDate = (ms) => new Date(ms + OFFSET * 1000).toISOString().slice(0, 10);
const dayMs = 86_400_000;
function snapOf(startMs, days, temp, lat = LAT, lon = LON, now = 92) {
  const hourly = [];
  for (let d = 0; d < days; d++) {
    const date = localDate(startMs + d * dayMs);
    for (let h = 0; h < 24; h++) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      const t = temp(d, h);
      hourly.push({ local: at, time: weather.localToUtc(at, OFFSET), tempF: t, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: h >= 6 && h < 19, aqi: 30, solarWm2: 500, wetBulbF: t - 20 });
    }
  }
  return { lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: OFFSET, tempF: now, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: true, aqi: 30, solarWm2: 500, wetBulbF: 60, hourly, daily: [], stale: false };
}
// Every afternoon, 11 am to 6 pm, at 100 F; 74 otherwise.
const hot = (d, h) => (h >= 11 && h <= 18 ? 100 : 74);

console.log('\nWho is kept, and as what');
{
  check('an age under one is a baby', hh.groupOf(0, undefined, 'the baby') === 'baby');
  check('three is a young child', hh.groupOf(3, undefined, 'my son') === 'young_child');
  check('82 is an older adult', hh.groupOf(82, undefined, 'Mum') === 'older_adult');
  check('Grandma with no age is an older adult', hh.groupOf(undefined, undefined, 'Grandma') === 'older_adult');
  check('a said age wins over a said group', hh.groupOf(40, 'older_adult', 'Raj') === 'adult');
  check('a child is never kept by name: "my son Arjun" is "your son"', hh.childCalled('young_child', 'my son Arjun') === 'your son');
  check('a baby is "the baby"', hh.childCalled('baby', 'little Maya') === 'the baby');
  const mum = { id: 'a', called: 'Mum', group: 'older_adult', medicines: [{ spoken: 'Lasix', generic: 'furosemide' }], conditions: [], at: '' };
  const p = hh.memberProfile(mum, false);
  check("a member's medicines and age make their profile", p.sensitivity !== 'general' && p.conditions.some((c) => c.id === 'older_adult'), JSON.stringify(p.sensitivity));
  const kid = hh.memberProfile({ id: 'b', called: 'the baby', group: 'baby', medicines: [], conditions: [], at: '' }, false);
  check("a baby is judged as a young child, the CDC's group", kid.conditions.some((c) => c.id === 'young_child'));
  check('"the kids" finds every child', hh.whoIs([mum, { id: 'b', called: 'the baby', group: 'baby', medicines: [], conditions: [], at: '' }], ['the kids']).map((m) => m.id).join() === 'b');
  check('"everyone" finds everybody', hh.whoIs([mum, { id: 'b', called: 'the baby', group: 'baby', medicines: [], conditions: [], at: '' }], ['everyone']).length === 2);
  check('a two letter word matches nobody by accident', hh.whoIs([mum], ['me']).length === 0);
}

console.log('\nThe tool, end to end, with the network off');
const id = 'acct:household';
store.update(id, (p) => { p.lat = LAT; p.lon = LON; p.locationName = 'Sun City West, Arizona'; p.locationStatus = 'ready'; });
weather.seedForTest(snapOf(Date.now(), 2, hot));
const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => id);
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {}, isError: r.isError };
};
{
  const names = (await client.listTools()).tools.map((t) => t.name);
  check('the household tool is published', names.includes('household'), names.join(','));

  const alone = await call('weather_check');
  check('on their own, the answer has no line about anybody else', !/At home:/.test(alone.said) && !alone.data.household, alone.said);
  const aloneDay = await call('plan_my_day');
  check('...and the day plan has none either', !/At home:/.test(aloneDay.said), aloneDay.said);

  const none = await call('household', { action: 'list' });
  check('listing nobody says how to add somebody', none.data.count === 0 && /Tell me who lives with you/.test(none.said), none.said);

  const mum = await call('household', { action: 'add', called: 'my mum', age: 82, medicines: ['Lasix'] });
  check('"my mum" is kept as Mum, with her age and medicine', mum.data.saved && /Added Mum, 82, furosemide/.test(mum.said), mum.said);
  check('the first health detail kept says what it is for', /only to warn you about the heat and the cold for them/.test(mum.said), mum.said);
  check('it says the answers will now cover her', /I'll say what it means for Mum too/.test(mum.said), mum.said);

  const son = await call('household', { action: 'add', called: 'my son Arjun', age: 3, conditions: ['asthma'] });
  const kept = store.get(id).household.find((m) => m.group === 'young_child');
  check('a child is kept as an age group, without the name', kept && kept.called === 'your son' && !JSON.stringify(store.get(id).household).includes('Arjun'), JSON.stringify(kept));
  check("...and without the child's age or health details", kept && kept.age === undefined && !kept.conditions.length && !kept.medicines.length, JSON.stringify(kept));
  check('...and the customer is told why', /For children I keep only the age group/.test(son.said), son.said);

  const raj = await call('household', { action: 'add', called: 'my husband Raj' });
  check('"my husband Raj" is kept as Raj', /Added Raj,/.test(raj.said) || /Added Raj at|Added Raj,/.test(raj.said), raj.said);

  const more = await call('household', { action: 'add', called: 'Mum', medicines: ['metoprolol', 'zorbix'] });
  check('telling about Mum again adds to her, not a second Mum', store.get(id).household.filter((m) => m.called === 'Mum').length === 1 && /Updated Mum: metoprolol/.test(more.said), more.said);
  check('a medicine it does not know is said plainly, not guessed', /I don't know how zorbix affects the heat/.test(more.said), more.said);

  const list = await call('household', { action: 'list' });
  check('list reads them all back', /Mum, 82, furosemide, metoprolol; your son; Raj/.test(list.said), list.said);
  store.update(id, (p) => void (p.privacy = true));
  const quiet = await call('household', { action: 'list' });
  check('in privacy mode the list names no medicine', !/furosemide|metoprolol/.test(quiet.said) && /kept private/.test(quiet.said), quiet.said);
  store.update(id, (p) => void (p.privacy = false));

  const now = await call('weather_check');
  check('the answer about now ends with one line about the people at home', /At home:/.test(now.said) && Array.isArray(now.data.household), now.said);
  check("...naming who should stay in, most at risk first", /At home: (Mum|Your son)/.test(now.said), now.said);
  check('...and the small child is never to be left in a car', /never (be )?left in a parked car|never leave them in a parked car/.test(now.said), now.said);
  check("the customer's own answer still comes first", now.said.indexOf('At home:') > 20, now.said);

  const day = await call('plan_my_day');
  check('the day plan gives each person their own stay-in hours', /At home:/.test(day.said) && /Mum should stay in \d/.test(day.said), day.said);

  const shift = await call('plan_my_day', { shiftStart: 7, shiftEnd: 15 });
  check("a work shift is the customer's alone: no household line", !/At home:/.test(shift.said), shift.said);

  // A trip with some of them going.
  globalThis.fetch = async (url) => {
    if (String(url).includes('geocoding-api')) {
      return new Response(JSON.stringify({ results: [{ name: 'Cancún', admin1: 'Quintana Roo', latitude: 21.16, longitude: -86.85, timezone: 'America/Cancun', country_code: 'MX', country: 'Mexico', population: 888797 }] }), { status: 200 });
    }
    throw new Error('network is off for this test');
  };
  week.seedForTest('week', 21.16, -86.85, snapOf(Date.now(), 7, (d, h) => (h >= 11 && h <= 17 ? 99 : 78), 21.16, -86.85));
  const from = localDate(Date.now() + 2 * dayMs), to = localDate(Date.now() + 4 * dayMs);
  const trip = await call('my_trips', { action: 'add', place: 'Cancun, Mexico', from, to, travellers: ['Mum', 'the kids'] });
  check('a family trip judges the others going, by name', /For the others going: Mum/.test(trip.said) && /your son/.test(trip.said) && !/Raj/.test(trip.said), trip.said);
  const solo = await call('my_trips', { action: 'add', place: 'Cancun, Mexico', from: localDate(Date.now() + 5 * dayMs), to: localDate(Date.now() + 6 * dayMs) });
  check('a trip with nobody else named is the customer\'s own, as before', !/the others going/.test(solo.said), solo.said);
  globalThis.fetch = async () => { throw new Error('network is off for this test'); };

  const gone = await call('household', { action: 'remove', called: 'Raj' });
  check('one person can be removed', gone.data.removed === true && !store.get(id).household.some((m) => m.called === 'Raj'), gone.said);
  const missing = await call('household', { action: 'remove', called: 'Priya' });
  check('removing somebody not there names who is', missing.data.removed === false && /I have Mum and your son/.test(missing.said), missing.said);
  const cleared = await call('household', { action: 'clear' });
  check('clear forgets everybody at home', cleared.data.cleared === 2 && !store.get(id).household.length, cleared.said);
  const after = await call('weather_check');
  check('...and the answers are the customer\'s own again', !/At home:/.test(after.said), after.said);

  // First aid, for whoever is unwell, on a hot day and a mild one.
  await call('household', { action: 'add', called: 'my mum', age: 82, medicines: ['Lasix'], conditions: ['heart disease'] });
  weather.seedForTest(snapOf(Date.now(), 2, () => 74, LAT, LON, 74));
  const mildFaint = await call('warning_signs', { symptoms: 'My mother just fainted' });
  check('on a mild day a faint is an emergency, but not called heat stroke', /Call 911 now/.test(mildFaint.said) && !/heat stroke/.test(mildFaint.said) && /may not be the heat/.test(mildFaint.said), mildFaint.said);
  check('...the operator is told what Sudor knows about Mum', /Tell them Mum is 82, takes furosemide and has heart disease/.test(mildFaint.said), mildFaint.said);
  check('...with the NHS fainting steps and CPR if not breathing', /lay them on their back and raise their legs/.test(mildFaint.said) && /push hard and fast/.test(mildFaint.said), mildFaint.said);
  check('...and the card does not say to cool them', mildFaint.data.card && !/cool/i.test(mildFaint.data.card.lines.join(' ')), JSON.stringify(mildFaint.data.card));
  const hotCar = await call('warning_signs', { symptoms: 'My mother fainted after sitting in the car' });
  check('a hot car keeps the heat answer even on a mild day', /heat stroke/.test(hotCar.said), hotCar.said);
  const garden = await call('warning_signs', { symptoms: 'My husband was working in the garden. Now he is confused and has stopped sweating' });
  check('working in the garden keeps the heat answer on a mild day', /can be heat stroke/.test(garden.said), garden.said);
  const site = await call('warning_signs', { symptoms: 'My son collapsed on the building site' });
  check('hard work on a mild day keeps the heat answer (Korey Stringer Institute: not always hot)', /can be heat stroke/.test(site.said), site.said);
  const told = await call('warning_signs', { symptoms: 'She collapsed', where: 'hard_work_or_exercise' });
  check('...and so does the model saying where, in any words', /can be heat stroke/.test(told.said), told.said);
  const kitchen = await call('warning_signs', { symptoms: 'My mother fainted in the kitchen' });
  check('a kitchen at home on a mild day is not called heat stroke', !/heat stroke/.test(kitchen.said), kitchen.said);
  const fever = await call('warning_signs', { symptoms: 'He is confused and running a temperature of 104' });
  check('a fever on a mild day is an emergency, not called heat stroke', /Call 911 now/.test(fever.said) && !/heat stroke/.test(fever.said), fever.said);
  const power = await call('warning_signs', { symptoms: 'My father fainted, the power has been out since yesterday' });
  check('a power cut on a day that has been mild throughout is not called heat stroke', !/heat stroke/.test(power.said), power.said);
  const molly = await call('warning_signs', { symptoms: 'My daughter collapsed at a party after taking molly' });
  check('a stimulant keeps the heat answer (Victoria Department of Health, MDMA)', /can be heat stroke/.test(molly.said), molly.said);
  const mildDizzy = await call('warning_signs', { symptoms: 'I feel dizzy and have a headache' });
  check('dizzy on a mild day is not called heat exhaustion', !/heat exhaustion/.test(mildDizzy.said) && /may not be the heat/.test(mildDizzy.said), mildDizzy.said);
  weather.seedForTest(snapOf(Date.now(), 2, () => 100, LAT, LON, 100));
  const hotFaint = await call('warning_signs', { symptoms: 'My husband is confused and has stopped sweating' });
  check('on a hot day it says heat stroke, and that it can have other causes', /^This is an emergency. Call 911 now./.test(hotFaint.said) && /can be heat stroke, though it can have other causes too/.test(hotFaint.said), hotFaint.said);
  check('...somebody not at home gets "tell them any medicines"', /Tell them any medicines they take/.test(hotFaint.said) && !/furosemide/.test(hotFaint.said), hotFaint.said);
  const cool = await call('warning_signs', { symptoms: 'My husband fainted', where: 'cool_indoors' });
  check('on a hot day, somebody who has been somewhere cool is not told it is heat stroke', /They have been somewhere cool, so this may not be the heat/.test(cool.said), cool.said);
  const out = await call('warning_signs', { symptoms: 'My husband fainted', where: 'outside' });
  check('...but outside on a hot day it is', /can be heat stroke/.test(out.said), out.said);
  weather.seedForTest(snapOf(Date.now(), 2, () => 100, LAT, LON, 74));
  const night = await call('warning_signs', { symptoms: 'My husband fainted' });
  check('mild now but hot in the last twelve hours is still the heat', /can be heat stroke/.test(night.said), night.said);
  weather.seedForTest(snapOf(Date.now(), 2, () => 100, LAT, LON, 100));

  // Somebody unwell in another city: that city's number and weather.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('geocoding-api')) return new Response(JSON.stringify({ results: [{ name: 'Delhi', admin1: 'Delhi', latitude: 28.65, longitude: 77.23, timezone: 'Asia/Kolkata', country_code: 'IN', country: 'India', population: 11034555 }] }), { status: 200 });
    throw new Error('network is off for this test');
  };
  week.seedForTest('week', 28.65, 77.23, snapOf(Date.now(), 7, () => 70, 28.65, 77.23, 70));
  const far = await call('warning_signs', { symptoms: 'My mother just fainted', place: 'Delhi, India' });
  check("somebody in another city gets that country's number, said so it is not swapped", /Somebody near them in Delhi should call 1 1 2, or 1 0 8 for an ambulance/.test(far.said) && !/\b911\b/.test(far.said), far.said);
  check("...and that city's weather: mild in Delhi, so not called heat stroke", !/heat stroke/.test(far.said), far.said);
  const same = await call('warning_signs', { symptoms: 'My husband fainted', place: 'Sun City West, Arizona' });
  check('naming the same place changes nothing', /Call 911 now/.test(same.said), same.said);
  globalThis.fetch = realFetch;
  store.update(id, (p) => { p.conditions = ['diabetes']; });
  const sugar = await call('warning_signs', { symptoms: 'I passed out for a moment' });
  check('for the customer on insulin: sugar only if awake and able to swallow', /if they are awake and can swallow, give them juice/.test(sugar.said) && !/Give them nothing to drink/.test(sugar.said), sugar.said);
  check('...and they are told to say they have diabetes', /Tell them you have diabetes/.test(sugar.said), sugar.said);
  store.update(id, (p) => { p.conditions = []; });
  await call('household', { action: 'clear' });

  for (let k = 0; k < 10; k++) await call('household', { action: 'add', called: `Friend${k}`, age: 30 });
  const full = await call('household', { action: 'add', called: 'One more', age: 30 });
  check('no more than ten people are kept', full.data.saved === false && store.get(id).household.length === 10, full.said);
}

await client.close();
await server.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
