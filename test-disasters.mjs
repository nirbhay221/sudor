/**
 * Every disaster as thorough as the heat: the home that cannot stay warm, smoke from the forecast, and what a
 * hurricane, a flood, a tornado or a winter storm asks of one particular person.
 *
 * No network: the forecast is seeded, email goes to a fake transport.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-disasters';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
process.env.SUDOR_PUBLIC_URL = 'https://sudor.example.org';
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_RECIPIENT_CONSENT;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

globalThis.fetch = async () => { throw new Error('offline in this test'); };

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const notify = await import('./dist/notify.js');
const shelters = await import('./dist/shelters.js');
const cold = await import('./dist/indoorcold.js');
const smoke = await import('./dist/smoke.js');
const hazard = await import('./dist/hazard.js');
const { QUESTIONS } = await import('./dist/setup.js');
const { checkColdHome } = await import('./dist/alerts.js');
const { registerTools } = await import('./dist/tools.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

async function connect(id, scope) {
  if (scope) process.env.SUDOR_SCOPE = scope;
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => id);
  delete process.env.SUDOR_SCOPE;
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };
}

const sent = [];
notify.configureForTest({ from: 'sudor@example.org', transport: async (email) => { sent.push(email); } });
shelters.seedForTest([]);

/** A day at the seeded place: `high` in the afternoon, `low` overnight, local time `hour`, and the air at `aqi`. */
const LAT = 44.98, LON = -93.27;
function seedDay(high, low, hour = 12, aqi = 40) {
  let shift = hour - new Date().getUTCHours();
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
      const t = low + (high - low) * Math.max(0, Math.cos(((h - 15) / 12) * Math.PI));
      hourly.push({ local: at, time: weather.localToUtc(at, off), tempF: t, humidityPct: 40, uvIndex: 2, windMph: 2, isDay: h >= 7 && h < 17, aqi, solarWm2: 200, wetBulbF: t - 5 });
    }
  }
  const daily = [0, 1, 2].map((d) => ({ date: local(Date.now() + d * 86_400_000).slice(0, 10), maxF: high, feelsMaxF: high, minF: low, weatherCode: 0 }));
  const now = hourly.find((h) => h.local.startsWith(today) && h.local.slice(11, 13) === local(Date.now()).slice(11, 13)) ?? hourly[12];
  const snap = { lat: LAT, lon: LON, fetchedAt: new Date().toISOString(), timezone: 'America/Chicago', utcOffsetSeconds: off, tempF: now.tempF, humidityPct: 40, uvIndex: 2, windMph: 2, isDay: true, aqi, solarWm2: 200, wetBulbF: now.tempF - 5, hourly, daily };
  weather.seedForTest(snap);
  return snap;
}

const agreed = (name, email) => ({ id: `c-${name}`, name, email, relation: 'son', notifyOn: ['hot_day', 'emergency'], addedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), acceptedAt: new Date().toISOString(), stopId: `stop-${name}` });

async function personIn(id, { medicine, conditions = [], heating, cooling, contacts = [], indoor } = {}) {
  const setup = await connect(id, 'all');
  await setup('register_location', { place: 'Minneapolis, Minnesota', lat: LAT, lon: LON });
  if (medicine) await setup('medication', { action: 'add', name: medicine });
  for (const c of conditions) await setup('health_condition', { action: 'add', condition: c });
  store.update(id, (p) => {
    p.contacts = contacts;
    if (heating) p.heating = heating;
    if (cooling) p.cooling = cooling;
    if (indoor != null) p.indoor = { f: indoor, at: new Date().toISOString() };
  });
  return connect(id);
}

console.log('\nA home that cannot stay warm');
{
  const snap = seedDay(38, 26, 14);
  const older = { conditions: ['older_adult'], indoor: { f: 58, at: new Date().toISOString() } };
  check('58 degrees inside, for somebody over 65, is too cold to stay in', cold.coldHomeRisk(snap, older)?.level === 'danger');
  check('...and the answer says where to go, and never the oven or a generator', /warming centre/.test(cold.coldHomeRisk(snap, older).line) && /carbon monoxide/.test(cold.coldHomeRisk(snap, older).line));
  check('66 degrees inside is a watch for them, below the 68 the NIA advises', cold.coldHomeRisk(snap, { conditions: ['older_adult'], indoor: { f: 66, at: new Date().toISOString() } })?.level === 'watch');
  check('62 inside says nothing to somebody the cold is not hard on', cold.coldHomeRisk(snap, { conditions: [], indoor: { f: 62, at: new Date().toISOString() } }) === null);
  check('...but 54 inside is too cold for anybody', cold.coldHomeRisk(snap, { conditions: [], indoor: { f: 54, at: new Date().toISOString() } })?.level === 'danger');
  check('a medicine that blunts shivering counts as the cold being harder on them', cold.coldVulnerable({ medications: [{ generic: 'quetiapine', drugClass: 'atypical antipsychotic' }] }));
  check('broken heating and a 26 degree night is danger for an older person', cold.coldHomeRisk(snap, { conditions: ['older_adult'], heating: 'broken' })?.level === 'danger');
  check('...but only a watch threshold for somebody younger, until a hard freeze', cold.coldHomeRisk(snap, { conditions: [], heating: 'broken' }) === null);
  const freeze = seedDay(25, 12, 14);
  check('a 12 degree night with no heating is danger for anybody, and says to drip a tap', cold.coldHomeRisk(freeze, { conditions: [], heating: 'none' })?.level === 'danger' && /pipes/.test(cold.coldHomeRisk(freeze, { conditions: [], heating: 'none' }).line));
  check('heating kept off for the bill, in the US, gives the LIHEAP heating line', /LIHEAP helps pay for heating/.test(cold.coldHomeRisk(freeze, { conditions: [], heating: 'cost', country: 'US' }).line));
  check('...and not outside the US, where nobody checked the help', !/LIHEAP/.test(cold.coldHomeRisk(freeze, { conditions: [], heating: 'cost', country: 'GB' }).line));
  const heater = cold.coldHomeRisk(freeze, { conditions: [], heating: 'space_heater' });
  check('a space heater on a freezing night gets the three rules: three feet, the wall, off when asleep', heater?.level === 'watch' && /three feet/.test(heater.line) && /straight into the wall/.test(heater.line) && /when you sleep/.test(heater.line));
  check('working heating says nothing', cold.coldHomeRisk(freeze, { conditions: ['older_adult'], heating: 'working' }) === null);
}

console.log('\nTold through the add-on');
{
  seedDay(38, 26, 14);
  const ask = await personIn('acct:cold-talk', { conditions: ['older_adult'] });
  const first = await ask('weather_check');
  check('on a cold day with nothing known, it asks once whether the heating works', /Is it working\?/.test(first.said) && /heating/.test(first.said) && first.data.asks === 'heating', first.said);
  const again = await ask('weather_check');
  check('...and not again the same day', !/heating works\. Is it working/.test(again.said), again.said);
  const broke = await ask('about_me', { heating: 'broken' });
  check('"my heating is broken" on a 26 degree night says the home will get too cold, and where to go', /colder than is safe/.test(broke.said) && /warming centre/.test(broke.said), broke.said);
  const reading = await ask('about_me', { indoorTempF: 58 });
  check('"it is 58 in here" is too cold to stay in', /too cold to stay in/.test(reading.said), reading.said);
  const back = await ask('about_me');
  check('the profile reads the heating back', /Heating at home: not working/.test(back.said), back.said);
  const now = await ask('weather_check');
  check('the weather answer carries the cold home, and points somewhere warm', /too cold to stay in/.test(now.said) && now.data.nextAction?.tool === 'somewhere_to_go', JSON.stringify(now.data.nextAction));
}

console.log('\nThe family, told once that the home is too cold');
{
  seedDay(30, 10, 14);
  await personIn('acct:cold-home', { conditions: ['older_adult'], heating: 'broken', contacts: [agreed('Sam', 'sam@example.org')] });
  seedDay(30, 10, 14);
  sent.length = 0;
  await checkColdHome();
  check('broken heating and a 10 degree night emails the contact who agreed', sent.length === 1 && sent[0].to === 'sam@example.org', JSON.stringify(sent.map((e) => e.subject)));
  check('...saying the home is too cold, before dark, with nothing about health', /too cold to stay in/.test(sent[0]?.text ?? '') && /before dark/.test(sent[0]?.text ?? '') && !/\bolder\b|\b65\b|\bage\b/i.test(sent[0]?.text ?? ''), sent[0]?.text);
  await checkColdHome();
  check('once a day', sent.length === 1, String(sent.length));
  seedDay(30, 10, 9);
  sent.length = 0;
  await personIn('acct:cold-early', { conditions: ['older_adult'], heating: 'none', contacts: [agreed('Lee', 'lee@example.org')] });
  seedDay(30, 10, 9);
  await checkColdHome();
  check('a forecast is not acted on in the morning, so it comes with the afternoon still to act in', !sent.some((e) => e.to === 'lee@example.org'));
}

console.log('\nSmoke, from the forecast');
{
  const hazy = seedDay(75, 55, 14, 120);
  check('an AQI of 120 is a watch for somebody over 65', smoke.smokeDay(hazy, { conditions: ['older_adult'] })?.level === 'watch');
  check('...and nothing for somebody it is not harder on', smoke.smokeDay(hazy, { conditions: [] }) === null);
  const thick = seedDay(75, 55, 14, 180);
  const anybody = smoke.smokeDay(thick, { conditions: [] });
  check('an AQI of 180 is said to anybody, with the clean room and the N95', anybody?.level === 'danger' && /MERV 13/.test(anybody.line) && /N95/.test(anybody.line), anybody?.line);
  const hotSmoky = seedDay(97, 75, 14, 180);
  const conflict = smoke.smokeDay(hotSmoky, { conditions: [], cooling: 'broken' });
  check('smoke on a hot day without cooling names the heat as the bigger danger', /the heat is the bigger danger/.test(conflict?.line ?? ''), conflict?.line);
  check('...and does not, when the cooling works', !/bigger danger/.test(smoke.smokeDay(hotSmoky, { conditions: [], cooling: 'working' })?.line ?? ''));
  check('asthma gets the inhaler and the action plan', /inhaler/.test(smoke.smokeDay(thick, { conditions: ['asthma_copd'] })?.line ?? ''));
  check('older adults, pregnancy, young children and diabetes now count for air quality', ['older_adult', 'pregnancy', 'young_child', 'diabetes'].every((c) => smoke.sensitiveToSmoke([c])));
  seedDay(75, 55, 14, 180);
  const ask = await personIn('acct:smoke-talk', { conditions: ['older_adult'] });
  const said = await ask('weather_check');
  check('the weather answer says the smoke with no warning issued', /air quality index reaches 180/.test(said.said) && said.data.smoke?.level === 'danger', said.said);
}

console.log('\nA disaster, for one person');
{
  const base = { coldMedicine: false, poweredEquipment: false, dialysis: false, breathing: false, heart: false, medicines: true, older: false, us: true };
  const fl = hazard.stepsFor('hurricane', { ...base, state: 'FL', older: true, livesAlone: true });
  check('Florida: the special needs registry, and that sign-ups close 72 hours before the winds', fl.some((s) => /special needs registry/.test(s) && /72 hours/.test(s)), fl.join(' | '));
  check('Florida: the early refill the law allows once a hurricane warning is out', fl.some((s) => /insurers must allow early refills/.test(s)));
  check('an older person hears the heat after the storm, from Ida', fl.some((s) => /Hurricane Ida/.test(s)));
  check('living alone: tell somebody the plan and agree a check', fl.some((s) => /agree a time they will check on you/.test(s)));
  const tx = hazard.stepsFor('hurricane', { ...base, state: 'TX', poweredEquipment: true, poweredNames: 'oxygen concentrator', oxygen: true });
  check('Texas: STEAR, by 211', tx.some((s) => /STEAR/.test(s) && /211/.test(s)), tx.join(' | '));
  check('oxygen: a battery lasts hours, so spare cylinders', tx.some((s) => /spare oxygen cylinders/.test(s)));
  const elsewhere = hazard.stepsFor('flood', { ...base, mobility: true });
  check('elsewhere in the US: ask the county about its registry', elsewhere.some((s) => /Ask your county emergency management whether it keeps a registry/.test(s)));
  check('a flood: a cut in flood water and the boil water notice', elsewhere.some((s) => /tetanus/.test(s) && /boil water/.test(s)));
  const fit = hazard.stepsFor('hurricane', { ...base });
  check('nobody who needs help to leave is not told about a registry', !fit.some((s) => /registry/.test(s)));
  const twister = hazard.stepsFor('tornado', { ...base, mobility: true });
  check('a tornado, when stairs are hard: a ground floor room and something to cover you', twister.some((s) => /ground floor bathroom or closet/.test(s) && /mattress/.test(s)));
  check('...and the general first step still comes first', twister[0].startsWith('Go now to the lowest floor'), twister[0]);
  const winter = hazard.stepsFor('winter', { ...base, heating: 'broken' });
  check('a winter storm with the heating out: decide now where to go', winter.some((s) => /Your heating cannot be relied on/.test(s)));
  const heaterStorm = hazard.stepsFor('winter', { ...base, heating: 'space_heater' });
  check('...and with a space heater, the safety rules', heaterStorm.some((s) => /three feet/.test(s)));
  check('a child: a week of formula, nappies and their medicines', hazard.stepsFor('hurricane', { ...base, youngChild: true }).some((s) => /formula/.test(s)));
  check('dementia: somebody to stay, and a card in the pocket', hazard.stepsFor('winter', { ...base, dementia: true }).some((s) => /card in your pocket/.test(s)));
}

console.log('\nEvery condition, in a disaster');
{
  const base = { coldMedicine: false, poweredEquipment: false, dialysis: false, breathing: false, heart: false, medicines: true, older: false, us: true, country: 'US' };
  const steps = (h, conditions, extra = {}) => hazard.stepsFor(h, { ...base, conditions, ...extra }).join(' | ');
  check('pregnancy: leave early, prenatal records, and the warning signs that mean care now', /Leave early rather than late/.test(steps('hurricane', ['pregnancy'])) && /the baby moving less/.test(steps('hurricane', ['pregnancy'])));
  check('sickle cell: warm, dry, drinking, and a fever of 101 is an emergency', /set off a crisis/.test(steps('winter', ['sickle_cell'])) && /101 degrees/.test(steps('cold', ['sickle_cell'])));
  check('MS: the cooling goes with the power, so a cooling vest and a battery fan', /cooling vest/.test(steps('hurricane', ['multiple_sclerosis'])));
  check('spinal cord injury: catheters, an autonomic dysreflexia card, and turning on a cot', /autonomic dysreflexia/.test(steps('flood', ['spinal_cord_injury'])) && /shift your weight/.test(steps('flood', ['spinal_cord_injury'])));
  check('erythromelalgia: a battery fan and cool water, never ice', /never ice/.test(steps('wind', ['erythromelalgia'])));
  check('POTS: fluids, salt, compression, and a seat in the queue', /compression stockings/.test(steps('hurricane', ['pots'])) && /ask for a seat/.test(steps('hurricane', ['pots'])));
  check("Raynaud's: gloves and hand warmers in a winter storm", /hand warmers/.test(steps('winter', ['raynauds'])));
  check('migraine: the medicine, an eye mask and earplugs', /eye mask and earplugs/.test(steps('fire', ['migraine'])));
  check('hay fever: mould after a flood', /mould grows/.test(steps('flood', ['hay_fever'])));
  check('fasting: the fast is not required of the ill or the traveller, so drink', /not required of somebody who is ill or travelling/.test(steps('heat', ['fasting'])) && /not required/.test(steps('hurricane', ['fasting'])));
  check('a condition the hazard does not touch adds nothing: migraine in a heat warning', !/eye mask/.test(steps('heat', ['migraine'])));
  check('methadone, in the US: take-home doses and a letter, before the clinic closes', /take-home doses/.test(steps('hurricane', [], { dailyClinic: true })));
  check('...and in the UK, that an emergency supply does not cover it', /does not cover methadone/.test(steps('hurricane', [], { dailyClinic: true, country: 'GB', us: false })));
  check('nothing personal said without a profile: the general steps only', hazard.stepsFor('hurricane', { coldMedicine: false, poweredEquipment: false, dialysis: false, breathing: false, heart: false, medicines: false, older: false }).every((s) => !/registry|refill|pregnan|sickle/.test(s)));
}

console.log('\nThe help that is a country’s own');
{
  const aid = await import('./dist/aid.js');
  check('211 in the US and Canada, nothing pretended elsewhere', aid.helpLine('US') === '211' && aid.helpLine('CA') === '211' && aid.helpLine('GB') === null && aid.helpLine('DE') === null);
  check('the UK: the Priority Services Register', /Priority Services Register/.test(aid.registry('GB', null, true)));
  check('Australia: life support registration and four business days of notice', /life support/.test(aid.registry('AU', null, false)) && /four business days/.test(aid.registry('AU', null, false)));
  // Every country Alexa+ is in, October 2026. See aid.ts.
  const ALEXA_PLUS = ['US', 'CA', 'MX', 'BR', 'GB', 'DE', 'AT', 'FR', 'IT', 'ES', 'AU', 'IN'];
  check('every Alexa+ country has somewhere warm and somewhere cool to go, said its own way', ALEXA_PLUS.every((c) => aid.warmPlace(c) && aid.coolPlace(c)) && new Set(ALEXA_PLUS.map((c) => aid.coolPlace(c))).size >= 8);
  check('...and nobody outside the US and Canada is told to call 211', ALEXA_PLUS.filter((c) => !['US', 'CA'].includes(c)).every((c) => !/211/.test(aid.warmPlace(c) + aid.coolPlace(c) + aid.registry(c, null, true) + aid.billHelp(c, 'heating'))));
  check('France: the mairie register, Canicule Info Service and the chèque énergie', /mairie/.test(aid.registry('FR', null, false)) && /0 800 06 66 66/.test(aid.coolPlace('FR')) && /chèque énergie/.test(aid.billHelp('FR', 'heating')));
  check('Italy: 1500 in a heatwave, and the bonus sociale', /1500/.test(aid.coolPlace('IT')) && /bonus sociale/.test(aid.billHelp('IT', 'cooling')));
  check('Spain: the bono social, and no cut-off for those who get it', /bono social/.test(aid.billHelp('ES', 'heating')) && /cannot be cut off/.test(aid.billHelp('ES', 'heating')));
  check('Germany: no cut-off where life is in danger, and the pharmacy emergency line', /in writing/.test(aid.billHelp('DE', 'heating')) && /22833/.test(aid.earlySupply('DE', null, false)));
  check('Austria: Apothekenruf 1455', /1455/.test(aid.earlySupply('AT', null, false)));
  check('Brazil: Defesa Civil on 199, SMS alerts on 40199, the Tarifa Social', /199/.test(aid.warmPlace('BR')) && /40199/.test(aid.registry('BR', null, true)) && /Tarifa Social/.test(aid.billHelp('BR', 'cooling')));
  check('Mexico: Protección Civil refuges, found through 911', /Protección Civil/.test(aid.warmPlace('MX')) && /911/.test(aid.warmPlace('MX')));
  check('India: cooling centres from the heat action plans', /heat action plan/.test(aid.coolPlace('IN')));
  check('Australia: three days from the pharmacist, never for a controlled drug', /three days/.test(aid.earlySupply('AU', null, false)) && !/three days/.test(aid.earlySupply('AU', null, false, true)));
  check('Canada: Ontario LEAP and the winter ban', /LEAP/.test(aid.billHelp('CA', 'heating')) && /November 15/.test(aid.billHelp('CA', 'heating')));
  check('who knows where to go: the mairie, the comune, Defesa Civil, never "211"', aid.whoKnows('FR') === 'your mairie' && aid.whoKnows('IT') === 'your comune' && /199/.test(aid.whoKnows('BR')) && aid.whoKnows('GB') === 'your local council');
  check('Germany: an honest line, not an American one', !/county|STEAR|Florida/.test(aid.registry('DE', null, true)) && /electricity company/.test(aid.registry('DE', null, true)));
  check('the UK pharmacist emergency supply, up to 30 days', /emergency supply/.test(aid.earlySupply('GB', null, true)));
  check('...but never for methadone', !/emergency supply/.test(aid.earlySupply('GB', null, true, true)));
  check('heating bill help: LIHEAP, the Warm Home Discount, a hardship program, and nothing invented elsewhere', /LIHEAP/.test(aid.billHelp('US', 'heating')) && /Warm Home Discount/.test(aid.billHelp('GB', 'heating')) && /hardship program/.test(aid.billHelp('AU', 'heating')) && aid.billHelp('JP', 'heating') === '' && aid.billHelp('IN', 'heating') === '');
  const freeze = seedDay(30, 15, 14);
  const uk = cold.coldHomeRisk(freeze, { conditions: ['older_adult'], heating: 'cost', country: 'GB' });
  check('a cold home in the UK points to a warm space and the Warm Home Discount, not 211 or LIHEAP', /warm space/.test(uk.line) && /Warm Home Discount/.test(uk.line) && !/211|LIHEAP/.test(uk.line), uk.line);

  const ask = await personIn('acct:leeds', { conditions: ['older_adult'] });
  store.update('acct:leeds', (p) => { p.country = 'GB'; p.locationName = 'Leeds, United Kingdom'; p.heating = 'broken'; });
  const said = await ask('weather_check');
  check('said in the UK, the temperatures come in Celsius too', /Celsius/.test(said.said), said.said);
  check('...and the emergency number is 999', !/\b911\b/.test(said.said));
  store.update('acct:leeds', (p) => { p.contacts = [agreed('Amy', 'amy@example.org')]; });
  const help = await ask('get_help', {});
  check('"get help" in the UK sends them to the council, not to 211', /local council/.test(help.said) && !/211/.test(help.said), help.said);
}

console.log('\nTelling the person they asked for, and nobody else');
{
  seedDay(98, 75, 14);
  const ask = await personIn('acct:who', {});
  store.update('acct:who', (p) => { p.contacts = [agreed('Priya', 'priya@example.org')]; p.contacts[0].relation = 'daughter'; });
  sent.length = 0;
  const son = await ask('get_help', { what: 'I am going to the library', who: 'my son' });
  await new Promise((r) => setTimeout(r, 30));
  check('"let my son know", with no son on the list, tells nobody', sent.length === 0 && son.data.reason === 'not_on_list', JSON.stringify(sent.map((e) => e.to)));
  check('...says so, and offers the daughter who is there, or adding him', /don't have your son on your list/.test(son.said) && /tell Priya/.test(son.said) && /add my son/.test(son.said), son.said);
  store.update('acct:who', (p) => { p.contacts = [{ ...agreed('Priya', 'priya@example.org'), relation: 'daughter' }, { ...agreed('Sam', 'sam@example.org'), relation: 'son' }]; });
  sent.length = 0;
  await ask('get_help', { what: 'I am going to the library', who: 'my son' });
  await new Promise((r) => setTimeout(r, 30));
  check('with a son on the list, only the son is emailed', sent.length === 1 && sent[0].to === 'sam@example.org', JSON.stringify(sent.map((e) => e.to)));
  sent.length = 0;
  await ask('get_help', { what: 'I need help' });
  await new Promise((r) => setTimeout(r, 30));
  check('naming nobody still tells everybody who agreed', sent.length === 2, String(sent.length));
}

console.log('\nThe medicine just added is the one named');
{
  seedDay(108, 88, 15);
  const ask = await personIn('acct:lasix', { medicine: 'lisinopril' });
  await ask('about_me', { medicines: ['Lasix'] });
  const today = await ask('weather_check');
  check('"started on Lasix", then the weather: furosemide is named', /furosemide/.test(today.said) || /furosemide/.test(JSON.stringify(today.data.more ?? '')), today.said);
}

console.log('\nSomebody who lives alone, on any dangerous day');
{
  const { checkOnAlone } = await import('./dist/alerts.js');
  const warnings = await import('./dist/warnings.js');
  seedDay(5, -10, 15);
  await personIn('acct:alone-cold', { conditions: ['older_adult'], contacts: [agreed('Ana', 'ana@example.org')] });
  store.update('acct:alone-cold', (p) => { p.livesAlone = true; p.lastSeenAt = new Date(Date.now() - 2 * 86_400_000).toISOString(); });
  seedDay(5, -10, 15);
  sent.length = 0;
  await checkOnAlone();
  const cold = sent.find((e) => e.to === 'ana@example.org');
  check('a dangerous cold day, not heard from: the family is asked to check', !!cold, JSON.stringify(sent.map((e) => e.to)));
  check('...and the email says the cold, not the heat', /cold/.test(cold?.text ?? '') && !/heat is in/.test(cold?.text ?? ''), cold?.text);

  seedDay(75, 60, 15);
  await personIn('acct:alone-storm', { contacts: [agreed('Joe', 'joe@example.org')] });
  store.update('acct:alone-storm', (p) => { p.livesAlone = true; p.lastSeenAt = new Date(Date.now() - 2 * 86_400_000).toISOString(); });
  warnings.seedForTest(LAT, LON, [{ id: 'hw1', event: 'Hurricane Warning', kind: 'other', severity: 'Extreme', urgency: 'Immediate', headline: 'Hurricane Warning', instruction: null, areaDesc: 'here', onset: null, ends: null }]);
  seedDay(75, 60, 15);
  sent.length = 0;
  await checkOnAlone();
  const storm = sent.find((e) => e.to === 'joe@example.org' && /check on them/i.test(e.subject));
  check('a mild day under a Hurricane Warning counts as dangerous too, and says so', !!storm && /Hurricane Warning/.test(storm.text), JSON.stringify(sent.map((e) => e.subject)));
  warnings.seedForTest(LAT, LON, []);

  seedDay(5, -10, 12);
  await personIn('acct:alone-eleven', { conditions: ['older_adult'], contacts: [agreed('Kim', 'kim@example.org')] });
  store.update('acct:alone-eleven', (p) => { p.livesAlone = true; p.lastSeenAt = new Date(Date.now() - 2 * 86_400_000).toISOString(); });
  seedDay(5, -10, 12);
  sent.length = 0;
  await checkOnAlone();
  check('at noon, with the usual two o’clock, nobody is asked yet', !sent.some((e) => e.to === 'kim@example.org'));
  const ask = await connect('acct:alone-eleven');
  const set = await ask('about_me', { checkInBy: 11 });
  check('"check on me if you have not heard from me by eleven" is kept, and said back', /by 11 in the morning/.test(set.said), set.said);
  store.update('acct:alone-eleven', (p) => { p.lastSeenAt = new Date(Date.now() - 2 * 86_400_000).toISOString(); });
  sent.length = 0;
  await checkOnAlone();
  check('...and at noon the family is asked, because eleven has passed', sent.some((e) => e.to === 'kim@example.org'));
}

console.log('\nAsking, a question at a time');
{
  seedDay(72, 55, 14);
  const ask = await personIn('acct:new', {});
  const first = await ask('weather_check');
  check('somebody with only a place is asked about medicines, once', first.data.asks === 'medicines' && /Do you take any medicines/.test(first.said), first.said);
  check('...instead of the general "tell me your medications" line, not as well', !/Tell me your medications or health conditions/.test(first.said), first.said);
  const again = await ask('weather_check');
  check('...and not asked anything again the same day', !again.data.asks, JSON.stringify(again.data.asks));
  // Insulin is not in the heat list, but it was named: asking "do you take any medicines?" next would be absurd.
  const named = await personIn('acct:insulin', {});
  await named('about_me', { medicines: ['insulin'] });
  const told = await named('weather_check');
  check('somebody who named a medicine the heat list lacks is not asked whether they take any', told.data.asks !== 'medicines' && !/Do you take any medicines/.test(told.said), told.said);
  // Found in a live sweep across the twelve countries.
  const abroad = await personIn('acct:abroad', {});
  const doli = await abroad('about_me', { medicines: ['Doliprane'] });
  check('Doliprane is added as acetaminophen, not called a different medicine in India and France', /Added acetaminophen/.test(doli.said) && !/different medicine/.test(doli.said), doli.said);
  const none = await abroad('about_me', { conditions: ['none'] });
  check('"none" for conditions is kept as no conditions, not a condition called none', !/"none"/.test(none.said) && store.get('acct:abroad').noConditions === true, none.said);
  const blank = await abroad('about_me', { medicines: [''] });
  check('a blank medicine name is not repeated back as one', !/""/.test(blank.said), blank.said);
  const german = await abroad('about_me', { medicines: ['Furosemid'] });
  check('the German spelling Furosemid is read as furosemide', /Furosemid is furosemide/.test(german.said), german.said);
  const nowhere = await personIn('acct:nowhere', {});
  store.update('acct:nowhere', (x) => { x.lat = null; x.lon = null; x.country = null; });
  const faint = await nowhere('warning_signs', { symptoms: 'my mother just fainted and she is hot' });
  check('with no place known, an emergency number is said so it is right anywhere', /911, or your local emergency number/.test(faint.said), faint.said);
  await ask('about_me', { noMedicines: true });
  store.update('acct:new', (p) => { p.setupAsked = { medicines: new Date(Date.now() - 2 * 86_400_000).toISOString() }; });
  const next = await ask('weather_check');
  check('"no medicines" is kept, and the next day the next question is conditions', next.data.asks === 'conditions' && /health conditions/.test(next.said), next.said);
  store.update('acct:new', (p) => { p.setupAsked = { medicines: new Date(Date.now() - 3 * 86_400_000).toISOString(), conditions: new Date(Date.now() - 2 * 86_400_000).toISOString() }; p.noConditions = true; });
  const age = await ask('weather_check');
  check('...then age', age.data.asks === 'age' && /how old are you\?$/.test(age.said) && /don't have to say/.test(age.said), age.said);
  await ask('about_me', { age: 74 });
  check('74 is kept, and adds the older adult condition', store.get('acct:new').age === 74 && store.get('acct:new').conditions.includes('older_adult'));
  store.update('acct:new', (p) => { p.setupAsked = { ...p.setupAsked, age: new Date(Date.now() - 2 * 86_400_000).toISOString() }; });
  const alone = await ask('weather_check');
  check('...then whether they live alone', alone.data.asks === 'alone' && /live on your own/.test(alone.said), alone.said);
  seedDay(110, 90, 14);
  store.update('acct:new', (p) => { p.setupAsked = {}; p.livesAlone = undefined; });
  const hot = await ask('weather_check');
  check('on a dangerous day the cooling question comes first, never a setup one', hot.data.asks !== 'alone', JSON.stringify(hot.data.asks));
  check('every setup question says why first and ends on the question', Object.values(QUESTIONS).every((q) => /\?$/.test(q) && q.split(/(?<=[.?])\s+/).length >= 2), JSON.stringify(QUESTIONS));

  seedDay(72, 55, 14);
  const kid = await personIn('acct:kid', {});
  const young = await kid('about_me', { age: 12 });
  check('an age under 18 is not kept, and they are told why', store.get('acct:kid').age === undefined && /made for adults/.test(young.said), young.said);
  const med = await kid('about_me', { medicines: ['furosemide'] });
  check('the first health detail kept says what it is for and the disclaimer, once', /only to tailor/.test(med.said) && /not a substitute for professional medical advice/.test(med.said), med.said);
  const med2 = await kid('about_me', { medicines: ['metoprolol'] });
  check('...and not again on the next one', !/only to tailor/.test(med2.said), med2.said);
  store.update('acct:kid', (p) => { p.setupAsked = {}; });
  const aloud = await kid('weather_check');
  check('once medicines are known, they are asked whether the names may be said aloud', aloud.data.asks === 'aloud' && /Should I say the names\?$/.test(aloud.said), aloud.said);
  await kid('about_me', { privacy: true });
  store.update('acct:kid', (p) => { p.setupAsked = {}; });
  const after = await kid('weather_check');
  const { conversation } = await import('./dist/standin.js');
  const turns = conversation([{ role: 'user', text: 'is it safe out' }, { role: 'assistant', text: aloud.said }]);
  check('the stand-in keeps the question just asked, so a bare "no" after it can be read', turns.length === 2 && /Should I say the names\?$/.test(turns[1].text));
  const rules = await import('./dist/rules.js');
  const asked = [{ role: 'user', text: 'is it safe out' }, { role: 'assistant', text: QUESTIONS.medicines }];
  check('with no model, a bare "no" after the medicines question is kept as no medicines', JSON.stringify(rules.bareAnswer('No', asked)) === JSON.stringify({ tool: 'about_me', args: { noMedicines: true } }));
  check('...a bare "yes" takes the next step the last answer named', rules.bareAnswer('yes please', [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'Want me to find the safest time to go out today?' }], { tool: 'plan_my_day', arguments: {} })?.tool === 'plan_my_day');
  check('...and "no" to "should I say the names" turns privacy on', rules.bareAnswer('no', [{ role: 'user', text: 'x' }, { role: 'assistant', text: QUESTIONS.aloud }])?.args?.privacy === true);
  check('...and a bare "no" with no question before it is not guessed at', rules.bareAnswer('no', []) === null);
  const agentMod = await import('./dist/agent.js');
  const step = (text) => ({ tool: 'warning_signs', args: {}, result: { content: [{ type: 'text', text }] } });
  check('a reworded reply that drops the emergency number is replaced by the tool\'s own words', agentMod.keepSafety('Rest somewhere cool.', [step('Call 911 now. Get somewhere cool.')]) === 'Call 911 now. Get somewhere cool.');
  check('...and one that keeps it stands', agentMod.keepSafety('Call 911 now, and get cool.', [step('Call 911 now. Get somewhere cool.')]) === 'Call 911 now, and get cool.');
  // Found with the model: the reason the answer is about this person was dropped in the rewording.
  const tomorrow = step('The best time to be outside tomorrow, because your medication blocks your sweating, is 6 to 10 am, heat index about 76.');
  check('a reworded reply that drops "because your medication ..." gets it back', /because your medication blocks your sweating/.test(agentMod.keepReason('Tomorrow is fine from 6 to 10 am.', [tomorrow])));
  check('...and one that kept it is left alone', agentMod.keepReason('Because your medication blocks your sweating, go 6 to 10 am.', [tomorrow]) === 'Because your medication blocks your sweating, go 6 to 10 am.');
  const shiftStep = { result: { content: [{ type: 'text', text: 'Your shift, 7 am to 5 pm today, peaks at heat index 104 at 12 pm.' }] } };
  check('"your 7 am to 5 pm shift" counts as keeping "Your shift", so the shift is not said twice', agentMod.keepReason('Your 7 am to 5 pm shift peaks at 104 at noon.', [shiftStep]) === 'Your 7 am to 5 pm shift peaks at 104 at noon.');
  const stayIn = step('For you, it is better to stay in right now. Your carvedilol blocks your sweating, so you may not feel overheating until it is serious. Is it working?');
  const kept = agentMod.keepReason('Better to stay in right now. Is your cooling working?', [stayIn]);
  check('a dropped "Your carvedilol ..." sentence goes back before the closing question', /Your carvedilol blocks your sweating.*Is your cooling working\?$/.test(kept), kept);
  check('...and drops malformed turns, or ones ending on the customer', conversation([{ role: 'user', text: 'a' }]).length === 0 && conversation(null).length === 0);
  check('...and a choice of privacy is kept, so it is not asked again', after.data.asks !== 'aloud' && store.get('acct:kid').privacyChosen === true, JSON.stringify(after.data.asks));
  const what = await kid('what_can_you_do');
  check('"what can you do" says the Amazon disclaimer word for word', /This information is not a substitute for professional medical advice\./.test(what.said), what.said);
}

console.log('\nOne carer, several people');
{
  seedDay(110, 88, 14);
  const mum = await personIn('acct:mum', { medicine: 'metoprolol', conditions: ['older_adult'] });
  const lee = await personIn('acct:lee', {});
  const codeMum = (await mum('share_my_day', { action: 'invite' })).data.code;
  const codeLee = (await lee('share_my_day', { action: 'invite' })).data.code;
  const carer = await connect('acct:carer');
  await carer('share_my_day', { action: 'join', code: codeMum, called: 'Mum' });
  const joined = await carer('share_my_day', { action: 'join', code: codeLee, called: 'Mr Lee' });
  check('a carer can join a second person, each by their own code, and hears how many', /now check on 2 people/.test(joined.said) && JSON.stringify(joined.data.watching) === '["Mum","Mr Lee"]', joined.said);
  const all = await carer('share_my_day', { action: 'check' });
  check('asked with no name, everybody in one answer, one line each', /Mum:/.test(all.said) && /Mr Lee:/.test(all.said), all.said);
  check('...the one at risk first, and named as the next step', all.said.indexOf('Mum:') < all.said.indexOf('Mr Lee:') && all.data.nextAction?.arguments?.who === 'Mum', all.said);
  const one = await carer('share_my_day', { action: 'check', who: 'mum' });
  check('asked about one by name, that person, with what to do', /Right now in/.test(one.said) && !/Mr Lee/.test(one.said), one.said);
  const nobody = await carer('share_my_day', { action: 'check', who: 'Grandad' });
  check('a name nobody shared under says who they do check on', /not checking on anybody called Grandad/.test(nobody.said) && /Mum, Mr Lee/.test(nobody.said), nobody.said);
  check('...and never a medicine or a condition, in any of it', !/metoprolol|beta blocker|over 65|your age|condition/i.test(all.said + one.said), all.said + ' || ' + one.said);
  await carer('share_my_day', { action: 'leave', who: 'Mum' });
  const after = await carer('share_my_day', { action: 'check' });
  check('leaving one by name leaves the other', /Right now in/.test(after.said) && !/Mum:/.test(after.said), after.said);
  check('...and Mum is no longer sharing with them', !(store.get('acct:mum').sharedWith ?? []).includes('acct:carer'));
}

console.log('\nA warming centre by name');
{
  const coolingMod = await import('./dist/cooling.js');
  const STL = { lat: 38.63, lon: -90.2 };
  const snap = seedDay(18, 5, 15);
  weather.seedForTest({ ...snap, lat: STL.lat, lon: STL.lon });
  const ask = await personIn('acct:stl', { conditions: ['older_adult'] });
  store.update('acct:stl', (p) => { p.lat = STL.lat; p.lon = STL.lon; p.locationName = 'St. Louis, Missouri'; });
  weather.seedForTest({ ...snap, lat: STL.lat, lon: STL.lon });
  coolingMod.seedForTest('Missouri DHSS warming centers', [{ name: 'Central Library', address: '1301 Olive St, St. Louis', kind: 'warming centre', lat: 38.6301, lon: -90.1985, hours: 'Mon-Sat 10am to 6pm', phone: null, openTo: null, accessible: true, pets: null, source: 'Missouri Department of Health and Senior Services', warm: true }]);
  const r = await ask('somewhere_to_go');
  check('on a cold day in St. Louis, the nearest warming centre by name', /nearest warming centre is Central Library/.test(r.said) && r.data.warmingCentres?.[0]?.name === 'Central Library', r.said);
  check('...and a cooling list is never offered for the cold', !/cooling centre/.test(r.said));
}

console.log('\nSmoke, on the scale Europe uses');
{
  const snap = seedDay(75, 55, 14, 60);
  const europe = { ...snap, hourly: snap.hourly.map((h) => ({ ...h, aqi: 60, eaqi: 85 })), aqi: 60, eaqi: 85 };
  const fr = smoke.smokeDay(europe, { conditions: [], country: 'FR' });
  check('in France, a European index of 85 is said as very poor, to everybody', fr?.level === 'danger' && /European air quality index reaches 85/.test(fr.line) && /very poor/.test(fr.line), fr?.line);
  check('...while the same air on the US scale, 60, says nothing in the US', smoke.smokeDay(europe, { conditions: [], country: 'US' }) === null);
  const poor = { ...europe, hourly: europe.hourly.map((h) => ({ ...h, eaqi: 65 })), eaqi: 65 };
  check('a European 65, poor, is a watch for somebody over 65 in Germany', smoke.smokeDay(poor, { conditions: ['older_adult'], country: 'DE' })?.level === 'watch');
  check('...and nothing for somebody it is not harder on', smoke.smokeDay(poor, { conditions: [], country: 'DE' }) === null);
}

console.log('\nCold first aid, on a day that is not cold');
{
  seedDay(98, 75, 14);
  const ask = await personIn('acct:numb', {});
  const r = await ask('warning_signs', { symptoms: 'my hands are numb and I am shivering' });
  check('"numb and shivering" on a hot day is answered as the cold, not as heat stroke', /frostbite|cold/i.test(r.said) && !/heat stroke/i.test(r.said), r.said);
  const hot = await ask('warning_signs', { symptoms: 'I feel dizzy and hot' });
  check('...while "dizzy and hot" is still the heat', /heat/i.test(hot.said), hot.said);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
