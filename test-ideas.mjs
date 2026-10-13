/**
 * Things added from the 2026 research and city heat plans, tested here:
 *
 *   Cooling centres the city or county publishes, named instead of "call 211".
 *   The power already out at the address, from California's emergency office.
 *   Hot days in a row, said in advance to older adults and people whose medicines make heat riskier.
 *   Fire weather and a powered medical device: the planned shutoff, and the utility's medical list.
 *   An Alexa temperature routine, suggested to somebody without working cooling.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-ideas';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

/*
 * No network: the weather download is refused so the test's own day stands, and the map layers answer from the
 * rows below, written in each publisher's own field names.
 */
const LAYERS = {
  HRN_Public_view: [
    { attributes: { Active: 'Yes', HeatRelief: 'Yes', HeatRelief_Type: 'Cooling Center', Start_Date: '2020-01-01', End_Date: '2099-12-31', Location: 'Burton Barr Library', Address: '1221 N Central Ave, Phoenix', MondayOpen: '9:00 AM', MondayClose: '8:00 PM', TuesdayOpen: '9:00 AM', TuesdayClose: '8:00 PM', WednesdayOpen: '9:00 AM', WednesdayClose: '8:00 PM', ThursdayOpen: '9:00 AM', ThursdayClose: '8:00 PM', FridayOpen: '9:00 AM', FridayClose: '8:00 PM', SaturdayOpen: '9:00 AM', SaturdayClose: '8:00 PM', SundayOpen: '9:00 AM', SundayClose: '8:00 PM', PrimaryPhone: '602-262-4636', ADA_accessible: 'Yes' }, geometry: { x: -112.0735, y: 33.4615 } },
    // Water only: not somewhere to sit out the afternoon.
    { attributes: { Active: 'Yes', HeatRelief: 'Yes', HeatRelief_Type: 'Hydration Station', Location: 'Water Stop', Address: '1 Main St', MondayOpen: '8:00 AM', MondayClose: '5:00 PM' }, geometry: { x: -112.0701, y: 33.4501 } },
    // Out of season.
    { attributes: { Active: 'Yes', HeatRelief: 'Yes', HeatRelief_Type: 'Cooling Center', Start_Date: '2020-05-01', End_Date: '2020-10-31', Location: 'Last Year Hall', Address: '2 Main St', MondayOpen: '8:00 AM', MondayClose: '5:00 PM' }, geometry: { x: -112.0702, y: 33.4502 } },
    // Closed every day of the week in its own hours, so closed today whatever today is.
    { attributes: { Active: 'Yes', HeatRelief: 'Yes', HeatRelief_Type: 'Cooling Center', Start_Date: '2020-01-01', End_Date: '2099-12-31', Location: 'Never Open Centre', Address: '3 Main St', Hours: 'Closed' }, geometry: { x: -112.0703, y: 33.4503 } },
    // An outdoor spray pad.
    { attributes: { Active: 'Yes', HeatRelief: 'Yes', HeatRelief_Type: 'Cooling Center', Start_Date: '2020-01-01', End_Date: '2099-12-31', Location: 'Encanto Spray Pad', Address: '4 Main St' }, geometry: { x: -112.0704, y: 33.4504 } },
    // Older adults only, and nearer than the library.
    { attributes: { Active: 'Yes', HeatRelief: 'Yes', HeatRelief_Type: 'Cooling Center', Start_Date: '2020-01-01', End_Date: '2099-12-31', Location: 'Senior Centre - SENIORS ONLY', Address: '5 Main St' }, geometry: { x: -112.0700, y: 33.4500 } },
  ],
  CoolingCenters_PROD_view: [
    { attributes: { Finder_status: 'CLOSED', Facility_name: 'Closed Branch', Address: '1 Ave' }, geometry: { x: -73.98, y: 40.75 } },
    { attributes: { Finder_status: 'OPEN', Facility_name: 'Midtown Library', Address: '455 5 Ave', Borough_name: 'Manhattan', Facility_type: 'Library' }, geometry: { x: -73.9819, y: 40.7516 } },
  ],
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/open-meteo\.com/.test(u)) return new Response('{}', { status: 503 });
  for (const [name, features] of Object.entries(LAYERS)) if (u.includes(name)) return new Response(JSON.stringify({ features }), { status: 200 });
  if (/arcgis/.test(u)) return new Response(JSON.stringify({ features: [] }), { status: 200 });
  return realFetch(url, init);
};

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const cooling = await import('./dist/cooling.js');
const outages = await import('./dist/outages.js');
const streak = await import('./dist/streak.js');
const hazard = await import('./dist/hazard.js');
const shelters = await import('./dist/shelters.js');
const { registerTools } = await import('./dist/tools.js');

async function connect(id) {
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => id);
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };
}

/** A day in a place, with each day's high heat index given, today first. Local time is midday wherever the clock is. */
function seedDays(lat, lon, highs, humidity = 20) {
  let shift = 12 - new Date().getUTCHours();
  if (shift > 14) shift -= 24;
  if (shift < -11) shift += 24;
  const off = shift * 3600;
  const local = (ms) => new Date(ms + off * 1000).toISOString();
  const today = local(Date.now()).slice(0, 10);
  const hourly = [];
  for (let d = 0; d < 2; d += 1) {
    const date = local(Date.now() + d * 86_400_000).slice(0, 10);
    for (let h = 0; h < 24; h += 1) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      const t = highs[d] - Math.abs(h - 15) * 1.5;
      hourly.push({ local: at, time: weather.localToUtc(at, off), tempF: t, humidityPct: humidity, uvIndex: 5, windMph: 5, isDay: h >= 6 && h < 19, aqi: 40, solarWm2: 500, wetBulbF: t - 25 });
    }
  }
  const daily = highs.map((f, d) => ({ date: local(Date.now() + d * 86_400_000).slice(0, 10), maxF: f, feelsMaxF: f, minF: f - 20, weatherCode: 0 }));
  const now = hourly.find((h) => h.local.slice(11, 13) === local(Date.now()).slice(11, 13) && h.local.startsWith(today)) ?? hourly[12];
  weather.seedForTest({ lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: off, tempF: now.tempF, humidityPct: humidity, uvIndex: 5, windMph: 5, isDay: true, aqi: 40, solarWm2: 500, wetBulbF: now.tempF - 25, hourly, daily, stale: false });
  return today;
}

console.log('\nCooling centres, from the lists cities and counties publish');
{
  await cooling.start();
  const counts = cooling.counts();
  check('every list was read', Object.keys(counts).length === cooling.sourceNames().length, JSON.stringify(counts));
  const phx = cooling.near(33.45, -112.07);
  check('in Phoenix: the library, the seniors centre, and nothing else', phx?.map((c) => c.name).sort().join('|') === 'Burton Barr Library|Senior Centre', JSON.stringify(phx?.map((c) => c.name)));
  check('...a hydration station, a closed-today centre, an out-of-season one and a spray pad are all left out', !phx.some((c) => /Water Stop|Never Open|Last Year|Spray/.test(c.name)));
  check('..."SENIORS ONLY" in a name becomes who it is for, and leaves the name', phx.find((c) => c.name === 'Senior Centre')?.openTo === 'older adults');
  const lib = phx.find((c) => c.name === 'Burton Barr Library');
  check('the library is said with today\'s hours, as "open today"', /^The nearest cooling centre open today is Burton Barr Library, at 1221 N Central Ave, Phoenix, (less than a mile|about 1 mile) away, from 9 am to 8 pm\.$/.test(cooling.sentence(lib)), cooling.sentence(lib));
  const nyc = cooling.near(40.758, -73.985);
  check('in Manhattan: the open library, not the closed branch', nyc?.length === 1 && nyc[0].name === 'Midtown Library', JSON.stringify(nyc?.map((c) => c.name)));
  check('Chicago, which no list covers, is undefined, not "none"', cooling.near(41.88, -87.63) === undefined);
  cooling.seedForTest('Maricopa County Heat Relief Network', null);
  check('a list that could not be read is null, "could not check", not empty', cooling.near(33.45, -112.07) === null);
  await cooling.start();
}

console.log('\n"Where can I go", on a hot day in Phoenix');
{
  shelters.seedForTest([]);
  const today = seedDays(33.45, -112.07, [108, 108, 108]);
  const young = await connect('acct:young');
  await young('register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 });
  seedDays(33.45, -112.07, [108, 108, 108]);
  await young('medication', { action: 'add', name: 'lisinopril' });
  const r = await young('somewhere_to_go');
  check('a named cooling centre, open today, instead of only 211', /Burton Barr Library/.test(r.said) && /open today/.test(r.said), r.said);
  check('...not the centre kept for older adults, for someone who has not said they are one', !/Senior Centre/.test(r.said));
  check('...and the list is in the structured answer with its source', r.data.coolingCentres?.[0]?.source === 'Maricopa County Heat Relief Network', JSON.stringify(r.data.coolingCentres));
  const older = await connect('acct:older');
  await older('register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 });
  seedDays(33.45, -112.07, [108, 108, 108]);
  await older('health_condition', { action: 'add', condition: 'I am 80 years old' });
  const o = await older('somewhere_to_go');
  check('for somebody over 65, the nearer seniors centre, and who it is for', /Senior Centre/.test(o.said) && /It is for older adults\./.test(o.said), o.said);
  void today;
}

console.log('\nThe power already out at the address, in California');
{
  const sac = { lat: 38.58, lon: -121.49 };
  const box = (lat, lon, d = 0.05) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];
  outages.seedForTest([{ utility: 'PG&E', planned: false, cause: 'PUBLIC SAFETY PATROLLING', startedAt: new Date().toISOString(), backBy: '2026-10-14T01:00:00Z', customers: 1200, rings: box(sac.lat, sac.lon) }]);
  const hit = outages.at(sac.lat, sac.lon);
  check('a point inside an outage area finds it', hit && hit.utility === 'PG&E', JSON.stringify(hit));
  check('a point in California outside every area is false: checked, and on', outages.at(37.77, -122.42) === false);
  check('outside California the list says nothing either way', outages.at(33.45, -112.07) === undefined);
  check('...said with the utility and when it should be back, in local time', /^California's emergency office shows the power out where you live: PG&E, a safety shutoff, expected back by Tue 6 PM\.$/.test(outages.sentence(hit, 'America/Los_Angeles')), outages.sentence(hit, 'America/Los_Angeles'));
  const who = await connect('acct:sac');
  await who('register_location', { place: 'Sacramento, California', lat: sac.lat, lon: sac.lon });
  seedDays(sac.lat, sac.lon, [80, 80]);
  await who('about_me', { equipment: ['oxygen concentrator'] });
  const prep = await who('storm_prep');
  check('storm_prep opens with the outage at their address', /^California's emergency office shows the power out where you live/.test(prep.said) && prep.data.powerOut?.utility === 'PG&E', prep.said.slice(0, 120));
  const go = await who('somewhere_to_go');
  check('...and so does "where can I go"', /shows the power out where you live/.test(go.said), go.said.slice(0, 160));
  outages.seedForTest(null);
  check('an unread list is null, never "the power is on"', outages.at(sac.lat, sac.lon) === null);
}

console.log('\nHot days in a row');
{
  // Humid enough that the heat index is at least the temperature, as on most hot days east of the Rockies.
  const today = seedDays(40.0, -100.0, [86, 93, 95, 97, 88], 45);
  const run = streak.hotRun(weather.current(40.0, -100.0), today);
  check('a run of three days at 90 or more, starting tomorrow, is found', run && run.days === 3 && run.start > today && run.peakF >= 95, JSON.stringify(run));
  check('it is said to an older adult with the second-day finding', /^Tomorrow starts 3 days in a row that feel like 90 or more, up to \d+\. For people over 65 the risk climbs on the second hot day/.test(streak.line(run, today, { older: true, sensitive: false })), streak.line(run, today, { older: true, sensitive: false }));
  check('...said differently to someone whose medicines make heat riskier', /Heat builds up over days in a row/.test(streak.line(run, today, { older: false, sensitive: true })));
  check('...and not to somebody it was not found in', streak.line(run, today, { older: false, sensitive: false }) === '');
  const single = seedDays(40.0, -100.0, [95, 85, 95, 85]);
  check('one hot day between cooler ones is not a run', streak.hotRun(weather.current(40.0, -100.0), single) === null);
  const far = seedDays(40.0, -100.0, [80, 80, 80, 80, 80, 95, 95]);
  check('a run five days out is a forecast to watch, not said', streak.line(streak.hotRun(weather.current(40.0, -100.0), far), far, { older: true, sensitive: true }) === '');

  const nan = await connect('acct:nan');
  await nan('register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 });
  seedDays(33.45, -112.07, [84, 96, 99, 101]);
  await nan('about_me', { conditions: ['I am 78'] });
  const w = await nan('weather_check');
  check('"is it safe to go out" tells an older adult tomorrow starts a run, aloud', /Tomorrow starts 3 days in a row/.test(w.said) && w.data.hotRun?.days === 3, w.said);
}

console.log('\nFire weather and a powered medical device');
{
  const needs = { coldMedicine: false, poweredEquipment: true, poweredNames: 'oxygen concentrator', dialysis: false, breathing: false, heart: false, medicines: false, older: false };
  const steps = hazard.stepsFor('fire', needs);
  check('a Red Flag day tells an oxygen user the power may be cut on purpose, and to get on the medical list', steps.some((s) => /switch the power off on purpose/.test(s) && /medical or life-support list/.test(s)), steps.join(' | '));
  check('...and not somebody without such equipment', !hazard.stepsFor('fire', { ...needs, poweredEquipment: false }).some((s) => /on purpose/.test(s)));
  check('...and not in a hurricane, where the power is not cut to prevent fires', !hazard.stepsFor('hurricane', needs).some((s) => /on purpose/.test(s)));
}

console.log('\nAn Alexa routine, for a home without working cooling');
{
  const who = await connect('acct:fan');
  const r = await who('about_me', { cooling: 'fan' });
  check('a fan only: the temperature routine is suggested, at 79 degrees', /ask Alexa for a routine that tells you when this room passes 79 degrees/.test(r.said), r.said);
  const ok = await who('about_me', { cooling: 'working' });
  check('working cooling: it is not', !/routine/.test(ok.said), ok.said);
}

console.log('\nOne request, several steps: the chain every answer is on');
{
  const flow = await import('./dist/flow.js');
  flow.resetForTest();
  shelters.seedForTest([]);
  outages.seedForTest([]);

  // A fine day is one answer, not the start of four.
  const fine = await connect('acct:chain-fine');
  await fine('register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 });
  seedDays(33.45, -112.07, [70, 70]);
  flow.resetForTest();
  const ok = await fine('weather_check');
  check('a fine day names no next step and starts no chain', ok.data.nextAction == null && ok.data.flow === undefined, JSON.stringify(ok.data.flow));

  // A dangerous day, with cooling that works: when, then how to go out anyway, then the signs to watch for.
  const hot = await connect('acct:chain-hot');
  await hot('register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 });
  seedDays(33.45, -112.07, [112, 112]);
  await hot('about_me', { medicines: ['metoprolol'], cooling: 'working' });
  seedDays(33.45, -112.07, [112, 112]);
  const w = await hot('weather_check');
  check('"is it safe to go out" on a dangerous day points at the safest hour, and says what follows that', w.data.nextAction?.tool === 'plan_my_day' && w.data.flow?.next === 'plan_my_day' && w.data.flow.then.join() === 'going_out_now,warning_signs', JSON.stringify(w.data.flow));
  check('...and the chain knows the setup that came before it', w.data.flow.done.includes('about_me') && w.data.flow.done[w.data.flow.done.length - 1] === 'weather_check', JSON.stringify(w.data.flow.done));
  const p = await hot('plan_my_day');
  check('the plan for a day with no good hour points at going out anyway', p.data.nextAction?.tool === 'going_out_now' && p.data.flow?.done.slice(-2).join() === 'weather_check,plan_my_day', JSON.stringify(p.data.flow));

  // The same day in a home with no working cooling: staying in is not the answer, so the chain goes somewhere.
  const stuck = await connect('acct:chain-stuck');
  await stuck('register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 });
  seedDays(33.45, -112.07, [112, 112]);
  await stuck('about_me', { medicines: ['metoprolol'], cooling: 'broken' });
  seedDays(33.45, -112.07, [112, 112]);
  const plan = await stuck('plan_my_day');
  check('with no good hour and no working cooling, the plan ends by offering somewhere cool', /Want me to find somewhere cool you can go\?$/.test(plan.said) && plan.data.nextAction?.tool === 'somewhere_to_go' && plan.data.flow?.then.join() === 'get_help', plan.said.slice(-80));
  const go = await stuck('somewhere_to_go');
  check('somewhere to go names the cooling centre, and with nobody to tell says how to fix that', /Burton Barr Library/.test(go.said) && /Tell me who to tell, and next time I can let them know where you are going\.$/.test(go.said) && go.data.nextAction == null, go.said.slice(-110));
  check('...the chain shows the three steps taken', go.data.flow?.done.slice(-2).join() === 'plan_my_day,somewhere_to_go', JSON.stringify(go.data.flow?.done));

  // Help asked for first: where to go has not been looked for yet, so that is next. Asked second, it is not.
  const help = await connect('acct:chain-help');
  await help('register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 });
  seedDays(33.45, -112.07, [112, 112]);
  const h1 = await help('get_help', { what: 'the power is out and it is hot' });
  check('a call for help with nowhere looked for yet points at somewhere to go', h1.data.nextAction?.tool === 'somewhere_to_go' && h1.data.flow?.next === 'somewhere_to_go', JSON.stringify(h1.data.nextAction));
  await help('somewhere_to_go');
  const h2 = await help('get_help', { what: 'still here' });
  check('...and does not point back at it once it has been asked', h2.data.nextAction == null, JSON.stringify(h2.data.nextAction));

  // The power already out, in California: the storm answer leads to somewhere with power.
  const sac = { lat: 38.58, lon: -121.49 };
  const d = 0.05;
  outages.seedForTest([{ utility: 'PG&E', planned: false, cause: 'PUBLIC SAFETY PATROLLING', startedAt: new Date().toISOString(), backBy: null, customers: 900, rings: [[[sac.lon - d, sac.lat - d], [sac.lon + d, sac.lat - d], [sac.lon + d, sac.lat + d], [sac.lon - d, sac.lat + d], [sac.lon - d, sac.lat - d]]] }]);
  const dark = await connect('acct:chain-dark');
  await dark('register_location', { place: 'Sacramento, California', lat: sac.lat, lon: sac.lon });
  seedDays(sac.lat, sac.lon, [80, 80]);
  const prep = await dark('storm_prep');
  check('with the power out at the address, the storm answer points at somewhere with power, then at telling somebody', prep.data.nextAction?.tool === 'somewhere_to_go' && prep.data.flow?.then.join() === 'get_help', JSON.stringify(prep.data.flow));
  outages.seedForTest(null);

  check('what was done is forgotten after a quarter of an hour', flow.record('acct:t', 'weather_check', 1000).length === 1 && flow.record('acct:t', 'plan_my_day', 1000 + 16 * 60_000).join() === 'plan_my_day');
  check('...and the same tool asked twice is one step, not two', flow.record('acct:u', 'weather_check', 1).length === 1 && flow.record('acct:u', 'weather_check', 2).join() === 'weather_check');
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
