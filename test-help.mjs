/**
 * Asking for help, the nearest place that can treat somebody, and a shift that cannot be moved.
 *
 * Three promises are tested here because each one, broken, hurts somebody:
 *   - nobody is ever told that help was called. An email was sent, and 911 is still theirs to ring;
 *   - nobody is sent to a hospital the map says has no emergency department;
 *   - nothing about a medicine or a condition reaches a family member's inbox.
 * It runs with the DEFAULT scope, the tools a customer actually gets.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-help';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const care = await import('./dist/care.js');
const shelters = await import('./dist/shelters.js');
const notify = await import('./dist/notify.js');
const personal = await import('./dist/personal.js');
const { registerTools, SECONDARY_TOOLS } = await import('./dist/tools.js');
const { speakErrorsPlainly } = await import('./dist/plainly.js');
globalThis.fetch = async () => { throw new Error('network is off for this test'); };

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

async function connect(id) {
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => id);
  speakErrorsPlainly(server);
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {}, isError: r.isError };
  };
  return { call, tools: async () => (await client.listTools()).tools };
}

const sent = [];
notify.configureForTest({ from: 'sudor@example.org', transport: async (email) => { sent.push(email); } });
const settle = () => new Promise((r) => setTimeout(r, 30));

// Minneapolis. Three hospitals: the nearest has no emergency department, the second does, the third does and is further.
const lat = 44.98, lon = -93.27;
const HOSPITALS = [
  { name: 'Lakeside Rehabilitation Hospital', address: '10 Lake St', city: 'Minneapolis', phone: null, lat: 44.981, lon: -93.271, emergency: false },
  { name: 'Hennepin County Medical Center', address: '701 Park Ave', city: 'Minneapolis', phone: '+1 612-873-3000', lat: 44.972, lon: -93.262, emergency: true },
  { name: 'North Memorial', address: '3300 Oakdale Ave N', city: 'Robbinsdale', phone: '763-520-5200', lat: 45.014, lon: -93.321, emergency: true },
];
function seedWeather(tempF, hourTemp) {
  const offset = -6 * 3600;
  const local = (ms) => new Date(ms + offset * 1000).toISOString();
  const hourly = [];
  for (const date of [local(Date.now()).slice(0, 10), local(Date.now() + 86_400_000).slice(0, 10)]) {
    for (let h = 0; h < 24; h += 1) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      hourly.push({ local: at, time: weather.localToUtc(at, offset), tempF: hourTemp(h), humidityPct: 45, uvIndex: 5, windMph: 6, isDay: h >= 6 && h < 19, aqi: 40, solarWm2: 500, wetBulbF: hourTemp(h) - 15 });
    }
  }
  weather.seedForTest({ lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Chicago', utcOffsetSeconds: offset, tempF, humidityPct: 45, uvIndex: 5, windMph: 6, isDay: true, aqi: 40, solarWm2: 500, wetBulbF: tempF - 15, hourly, stale: false });
}

console.log('\nThe map data, read honestly');
{
  const parsed = care.parseAmazon({ ResultItems: [
    { Title: 'Banner University Medical Center', Position: [-112.057, 33.465], Address: { AddressNumber: '1111', Street: 'E McDowell Rd', Locality: 'Phoenix' }, Contacts: { Phones: [{ Value: '+16028392000' }] }, Categories: [{ Id: 'hospital', Name: 'Hospital' }], Distance: 1800 },
    { Title: 'Valleywise Emergency', Position: [-112.03, 33.47], Categories: [{ Id: 'hospital_emergency_room', Name: 'Hospital Emergency Room' }] },
    { Title: 'No Position Hospital', Address: {} },
    { Position: [-112, 33] },
  ] });
  check('a result becomes a place with its door, town and number', parsed.length === 2 && parsed[0].address === '1111 E McDowell Rd' && parsed[0].city === 'Phoenix' && parsed[0].phone === '+16028392000', JSON.stringify(parsed));
  check('the position is read longitude first, as the service sends it', parsed[0].lat === 33.465 && parsed[0].lon === -112.057);
  check('a hospital with no name or no position is left out', !parsed.some((p) => /No Position/.test(p.name)));
  check('a plain hospital is not assumed to have an emergency department', parsed[0].emergency === null);
  check('one the service itself calls an emergency room is', parsed[1].emergency === true);
  check('an error body is no hospitals', care.parseAmazon({ message: 'AccessDenied' }).length === 0 && care.parseAmazon(null).length === 0);
  check('a phone number is said in groups, digit by digit', care.spokenPhone('+1 612-873-3000') === '6 1 2, 8 7 3, 3 0 0 0' && care.spokenPhone('+16028392000') === '6 0 2, 8 3 9, 2 0 0 0', care.spokenPhone('+1 612-873-3000'));
  check('a number that is not ten digits is left as written', care.spokenPhone('999') === '999');
}

console.log('\nWhich hospital is named');
{
  care.configureForTest(null);
  check('nothing is known before the lookup lands, and nothing is invented', care.nearestEmergency(lat, lon) === null && care.sentence(lat, lon) === '');
  care.seedForTest(lat, lon, HOSPITALS);
  const near = care.nearestEmergency(lat, lon);
  check('the nearest one WITH an emergency department, not the nearest building', near?.name === 'Hennepin County Medical Center', near?.name);
  const said = care.sentence(lat, lon);
  check('it is called an emergency department, with the address', /nearest emergency department is Hennepin County Medical Center, at 701 Park Ave in Minneapolis/.test(said), said);
  check('less than a mile is said as that, not as zero miles', /less than a mile away/.test(said), said);
  check('the number is spoken so it can be dialled', /Their number is 6 1 2, 8 7 3, 3 0 0 0\./.test(said), said);
  care.seedForTest(lat, lon, [HOSPITALS[0], { ...HOSPITALS[2], emergency: null }]);
  const unsure = care.sentence(lat, lon);
  check('where the map does not say, it is called a hospital and no department is promised', /nearest hospital is North Memorial/.test(unsure) && !/emergency department/.test(unsure), unsure);
  care.seedForTest(lat, lon, [HOSPITALS[0]]);
  check('a hospital marked as having no emergency department is never offered', care.sentence(lat, lon) === '');
  check('with no place there is no sentence', care.sentence(null, null) === '');

  let calls = 0;
  care.configureForTest(async () => { calls += 1; return HOSPITALS; });
  await care.refresh(lat, lon);
  await care.refresh(lat, lon);
  check('a place is looked up once and then held', calls === 1 && care.nearestEmergency(lat, lon)?.name === 'Hennepin County Medical Center', String(calls));
  care.configureForTest(async () => { throw new Error('down'); });
  await care.refresh(lat, lon);
  check('a failed lookup is not an answer and not a crash', care.nearestEmergency(lat, lon) === null);
  care.configureForTest(null);
  care.seedForTest(lat, lon, HOSPITALS);
}

console.log('\nThe federal list, which knows who has an emergency department');
{
  const rows = [
    { facility_name: "CHILDREN'S HOSPITALS & CLINICS OF MN", address: '2525 CHICAGO AVENUE SOUTH', citytown: 'MINNEAPOLIS', telephone_number: '(612) 813-6112', emergency_services: 'Yes', hospital_type: 'Childrens' },
    { facility_name: 'HENNEPIN COUNTY MEDICAL CENTER', address: '701 PARK AVENUE', citytown: 'MINNEAPOLIS', telephone_number: '(612) 873-3000', emergency_services: 'Yes', hospital_type: 'Acute Care Hospitals' },
    { facility_name: 'QUIET REHAB', address: '1 A ST', citytown: 'MINNEAPOLIS', telephone_number: '', emergency_services: 'No', hospital_type: 'Acute Care Hospitals' },
    { facility_name: '', citytown: 'MINNEAPOLIS', emergency_services: 'Yes' },
  ];
  const listed = care.parseListed(rows);
  check('only hospitals that said yes are kept', listed.length === 1 && !listed.some((l) => /Rehab/.test(l.name)), JSON.stringify(listed));
  check('a hospital for children is left out: its emergency department is not for everybody', !listed.some((l) => /Children/.test(l.name)));
  check('shouted names are written normally', listed[0].name === 'Hennepin County Medical Center' && listed[0].address === '701 Park Avenue', listed[0].name);
  const anchorage = care.parseListed([
    { facility_name: 'NORTH STAR HOSPITAL', address: '2530 DEBARR RD', citytown: 'ANCHORAGE', telephone_number: '(907) 264-3526', emergency_services: 'Yes', hospital_type: 'Psychiatric' },
    { facility_name: 'ALASKA REGIONAL HOSPITAL', address: '2801 DEBARR ROAD', citytown: 'ANCHORAGE', telephone_number: '(907) 276-1131', emergency_services: 'Yes', hospital_type: 'Acute Care Hospitals' },
    { facility_name: "ST. MARY'S HOSPITAL", address: '1 A ST', citytown: 'ANCHORAGE', telephone_number: '', emergency_services: 'Yes', hospital_type: 'Critical Access Hospitals' },
  ]);
  check('a psychiatric hospital is never listed, whatever it reports (found live in Anchorage)', anchorage.length === 2 && !anchorage.some((l) => /North Star/.test(l.name)), JSON.stringify(anchorage));
  check('an apostrophe does not start a new capital', anchorage[1].name === "St. Mary's Hospital", anchorage[1].name);
  const ak = care.confirm([
    { name: 'North Star Hospital', address: '2530 Debarr Rd', city: 'Anchorage', phone: null, lat: 61.2001, lon: -149.8001, emergency: null },
    { name: 'Chris Kyle Patriots Hospital', address: '1650 Bragaw St', city: 'Anchorage', phone: null, lat: 61.2, lon: -149.81, emergency: null },
    { name: 'Southcentral Foundation Detox', address: '4330 Elmore Rd', city: 'Anchorage', phone: null, lat: 61.18, lon: -149.8, emergency: null },
    { name: 'Alaska Regional Hospital', address: '2801 Debarr Rd', city: 'Anchorage', phone: null, lat: 61.21, lon: -149.82, emergency: null },
  ], anchorage);
  check('...and on the map the general hospital is the one marked', ak[3].emergency === true && ak[0].emergency !== true, JSON.stringify(ak.map((x) => x.emergency)));
  check('...a detox centre is marked as not an emergency department', ak[2].emergency === false);
  care.configureForTest(null);
  care.seedForTest(61.2, -149.8, ak);
  check('...so the sentence names Alaska Regional, not the nearer psychiatric hospital', /nearest emergency department is Alaska Regional Hospital/.test(care.sentence(61.2, -149.8)), care.sentence(61.2, -149.8));
  care.seedForTest(61.2, -149.8, care.confirm([{ name: 'Mercy Behavioral Health Hospital', address: null, city: null, phone: null, lat: 61.2, lon: -149.8, emergency: null }], []));
  check('with no list to check against, a behavioural health hospital is still never offered', care.sentence(61.2, -149.8) === '');
  check('something that is not a list is no hospitals', care.parseListed(null).length === 0 && care.parseListed({}).length === 0);
  check('a town and a state are read from the place name', JSON.stringify(care.townOf('Minneapolis, Minnesota')) === '{"city":"MINNEAPOLIS","state":"MN"}' && care.townOf('Phoenix, AZ').state === 'AZ');
  check('a place with no state is not sent to a US list', care.townOf('Minneapolis') === null && care.townOf('Lyon, France') === null && care.townOf(null) === null);

  const mapped = [
    { name: 'Hennepin Healthcare', address: '701 Park Ave', city: 'Minneapolis', phone: null, lat: 44.972, lon: -93.262, emergency: null },
    { name: 'Hennepin County Medical Centre', address: null, city: null, phone: null, lat: 44.95, lon: -93.26, emergency: null },
    { name: 'Lakeside Rehabilitation Hospital', address: '10 Lake St', city: null, phone: null, lat: 44.981, lon: -93.271, emergency: false },
    { name: 'Some Other Clinic', address: '9 Elm St', city: null, phone: null, lat: 44.98, lon: -93.27, emergency: null },
  ];
  const marked = care.confirm(mapped, listed);
  check('a mapped hospital at the same door as a listed one is marked yes', marked[0].emergency === true);
  check('...and one with the same name, written differently', marked[1].emergency === true);
  check('...a no on the map stays a no', marked[2].emergency === false);
  check('...and one the list does not name stays unknown, not no', marked[3].emergency === null);

  const tt = [{ name: 'Banner University Medical Center', address: '1111 E McDowell Rd', city: 'Phoenix', phone: null, lat: 33.465, lon: -112.057, emergency: null }];
  const phoenix = care.confirm(tt, care.parseListed([{ facility_name: 'BANNER - UNIVERSITY MEDICAL CENTER PHOENIX', address: '1111 EAST MCDOWELL ROAD', citytown: 'PHOENIX', telephone_number: '(602) 839-2000', emergency_services: 'Yes', hospital_type: 'Acute Care Hospitals' }]));
  check('East McDowell Road and E McDowell Rd are the same door', phoenix[0].emergency === true);
  check('...and the number reported to Medicare is the one given', phoenix[0].phone === '(602) 839-2000', String(phoenix[0].phone));
}

console.log('\nWhen the map does not answer and the federal list does');
{
  care.configureForTest(async () => { throw new Error('map is down'); }, async (city, state) => (city === 'MINNEAPOLIS' && state === 'MN' ? care.parseListed([{ facility_name: 'HENNEPIN COUNTY MEDICAL CENTER', address: '701 PARK AVENUE', citytown: 'MINNEAPOLIS', telephone_number: '(612) 873-3000', emergency_services: 'Yes', hospital_type: 'Acute Care Hospitals' }]) : []));
  await care.refresh(lat, lon, 'Minneapolis, Minnesota');
  const said = care.sentence(lat, lon);
  check('a hospital in the same town is named', /A hospital with an emergency department in Minneapolis is Hennepin County Medical Center, at 701 Park Avenue\. Their number is 6 1 2, 8 7 3, 3 0 0 0\./.test(said), said);
  check('...and it is not called the nearest, because no distance was measured', !/nearest|miles? away/.test(said) && care.named(lat, lon).measured === false && care.named(lat, lon).link === null, said);
  care.configureForTest(async () => HOSPITALS.map((h) => ({ ...h, emergency: h.emergency === false ? false : null, phone: null })), async () => care.parseListed([{ facility_name: 'HENNEPIN COUNTY MEDICAL CENTER', address: '701 PARK AVENUE', citytown: 'MINNEAPOLIS', telephone_number: '(612) 873-3000', emergency_services: 'Yes', hospital_type: 'Acute Care Hospitals' }]));
  await care.refresh(lat, lon, 'Minneapolis, Minnesota');
  const both = care.sentence(lat, lon);
  check('with both, the map gives the distance and the list gives the certainty and the number', /nearest emergency department is Hennepin County Medical Center/.test(both) && /less than a mile away/.test(both) && /6 1 2, 8 7 3, 3 0 0 0/.test(both), both);
  care.configureForTest(async () => { throw new Error('down'); }, async () => { throw new Error('down'); });
  await care.refresh(lat, lon, 'Minneapolis, Minnesota');
  check('with neither, nothing is said', care.sentence(lat, lon) === '');
  care.configureForTest(null);
  care.seedForTest(lat, lon, HOSPITALS);
}

console.log('\nThe tools a customer gets');
const mum = await connect('acct:mum');
{
  const names = (await mum.tools()).map((t) => t.name);
  check('asking for help, shelters and storm preparation are published by default', ['get_help', 'somewhere_to_go', 'storm_prep'].every((n) => names.includes(n)), names.join(','));
  check('the neighbouring products are still held back', SECONDARY_TOOLS.every((n) => !names.includes(n)) && SECONDARY_TOOLS.length === 3 && !names.includes('medicine_recalls'));
  const tool = (await mum.tools()).find((t) => t.name === 'get_help');
  check('the description says it cannot phone or reach 911', /cannot phone anyone and cannot reach 911/.test(tool.description));
  check('it is declared as a write that reaches the outside world', tool.annotations.readOnlyHint === false && tool.annotations.openWorldHint === true);
}

console.log('\nAsking for help with nobody to tell');
seedWeather(8, () => 8);
shelters.seedForTest([{ name: 'Central High School', address: '275 Lexington Pkwy', city: 'Minneapolis', state: 'MN', lat: 44.99, lon: -93.25, generator: true, accessible: true, pets: 'Allowed' }]);
await mum.call('register_location', { place: 'Minneapolis, Minnesota', lat, lon });
care.seedForTest(lat, lon, HOSPITALS);
{
  const r = await mum.call('get_help', { what: 'the power is out and I am cold' });
  check('it says nobody can be told', /nobody I can tell yet/.test(r.said) && r.data.told.length === 0, r.said);
  check('...and still gives 911, the nearest emergency department and 211', /call 911 yourself/.test(r.said) && /Hennepin County Medical Center/.test(r.said) && /call 211/.test(r.said), r.said);
  check('...and nothing was sent', sent.length === 0);
  await mum.call('contact', { action: 'add', name: 'Priya', email: 'priya@example.com', relation: 'daughter', when: 'hot_day' });
  const staged = await mum.call('get_help', {});
  check('somebody added but not confirmed is not emailed, and is named as waiting', /Priya has not been confirmed/.test(staged.said) && sent.length === 0, staged.said);
}

console.log('\nAsking for help with a confirmed contact');
await mum.call('medication', { action: 'add', name: 'metoprolol' });
await mum.call('health_condition', { action: 'add', condition: 'heart disease' });
await mum.call('contact', { action: 'confirm', name: 'Priya' });
await mum.call('contact', { action: 'add', name: 'Sam', email: 'sam@example.com', when: 'emergency' });
await mum.call('contact', { action: 'confirm', name: 'Sam' });
{
  const r = await mum.call('get_help', { what: 'the power is out and I am cold' });
  await settle();
  check('everybody confirmed is told, whatever they were added for', sent.length === 2 && r.data.told.join() === 'Priya,Sam', `${sent.length} ${r.data.told}`);
  check('the answer says who is being emailed', /I'm emailing Priya and Sam now that you need help/.test(r.said), r.said);
  check('it says plainly that it cannot phone or reach 911', /I cannot phone anyone or reach 911 for you\. If you are in danger, call 911 yourself now\./.test(r.said), r.said);
  check('it never claims help was called, is coming, or that anything was delivered', !/help is (on its way|coming)|have called|I called|was delivered|has been notified/i.test(r.said), r.said);
  check('it says to ring as well, because email can sit unread', /ring Priya as well/.test(r.said), r.said);
  check('the whole answer is spoken, not cut to three sentences', /call 211\.$/.test(r.said) && !/Ask for more/.test(r.said), r.said);
  const body = sent[0].text;
  check('the email carries what was said', /"the power is out and I am cold"/.test(body), body);
  check('...and roughly where', /near Minneapolis, Minnesota/.test(body), body);
  check('...and the nearest emergency department with its number and a map link', /Nearest emergency department: Hennepin County Medical Center, 701 Park Ave, Minneapolis, \+1 612-873-3000\. https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=44\.97200,-93\.26200/.test(body), body);
  check('...and the nearest open shelter', /Nearest open shelter: Central High School, 275 Lexington Pkwy, Minneapolis, MN\./.test(body), body);
  check('...and tells the reader to ring, and when to call 911', /Please ring them now/.test(body) && /call 911/.test(body), body);
  check('...and nothing about a medicine or a condition', !/metoprolol|heart disease|beta.blocker|medication|medicine|condition|diagnos/i.test(body), body);
  check('it is counted as urgent mail', sent[0].reason === 'help');
  check('the card says the same thing as the voice', r.data.card.title === 'Told Priya and Sam' && r.data.card.lines[0] === 'In danger: call 911 yourself.', JSON.stringify(r.data.card));
}

console.log('\nIt cannot be used to flood an inbox');
{
  sent.length = 0;
  await mum.call('get_help', {});
  await mum.call('get_help', {});
  await settle();
  check('three in an hour reach each person', sent.length === 4, String(sent.length));
  const fourth = await mum.call('get_help', {});
  await settle();
  check('the fourth is not sent', sent.length === 4, String(sent.length));
  check('...and the answer says so, and still gives 911', /already emailed Priya and Sam several times this hour/.test(fourth.said) && /call 911 yourself/.test(fourth.said) && fourth.data.told.length === 0, fourth.said);
  notify.resetEmailLimitsForTest();
  sent.length = 0;
  for (let i = 0; i < 10; i += 1) notify.withinEmailLimits({ to: 'priya@example.com', reason: 'report', sender: 'acct:mum' });
  await mum.call('get_help', {});
  await settle();
  check('a day of ordinary mail never blocks a call for help', sent.length === 2, String(sent.length));
}

console.log('\nA visitor to the public demo');
{
  const visitor = await connect('demo:abc');
  await visitor.call('register_location', { place: 'Minneapolis, Minnesota', lat, lon });
  await visitor.call('contact', { action: 'add', name: 'Stranger', email: 'victim@example.com' });
  await visitor.call('contact', { action: 'confirm', name: 'Stranger' });
  sent.length = 0;
  const r = await visitor.call('get_help', { what: 'anything a visitor types' });
  await settle();
  check('nothing is emailed from the demo', sent.length === 0);
  check('...the contact has not agreed, so nobody is told, with 911 all the same', /Stranger has not agreed to be emailed yet/.test(r.said) && /call 911 yourself/.test(r.said) && r.data.told.length === 0, r.said);
}

console.log('\nWhen email is not set up on the server');
{
  notify.configureForTest({ from: undefined });
  notify.resetEmailLimitsForTest();
  const r = await mum.call('get_help', {});
  check('it says it cannot email, and does not say it did', /I can't email Priya and Sam, because email isn't set up/.test(r.said) && r.data.told.length === 0 && r.data.card.title === 'Nobody told yet', r.said);
  notify.configureForTest({ from: 'sudor@example.org' });
  notify.resetEmailLimitsForTest();
}

console.log('\nLooking for somewhere to go');
{
  const r = await mum.call('somewhere_to_go');
  check('the shelter answer offers to tell the family', /Want me to tell Priya and Sam you need help\? Say get help\.$/.test(r.said), r.said.slice(-120));
  check('...and still says the carbon monoxide warning in full', /carbon monoxide/.test(r.said));
  check('...and carries the nearest emergency department for a screen', r.data.nearestEmergency?.name === 'Hennepin County Medical Center');
  const alone = await connect('acct:alone');
  await alone.call('register_location', { place: 'Minneapolis, Minnesota', lat, lon });
  check('with nobody confirmed there is no offer to tell anyone', !/Say get help/.test((await alone.call('somewhere_to_go')).said));
}

console.log('\nFeeling unwell: where to go is said after what to do');
{
  sent.length = 0;
  const cold = await mum.call('warning_signs', { symptoms: 'he is confused and his speech is slurred and he stopped shivering' });
  check('a cold emergency says 911 before any hospital', cold.said.indexOf('911') >= 0 && cold.said.indexOf('911') < cold.said.indexOf('Hennepin'), cold.said);
  seedWeather(101, () => 101);
  const stroke = await mum.call('warning_signs', { symptoms: 'she is confused and collapsed and her skin is hot and dry' });
  check('heat stroke says 911 before any hospital', stroke.data.level === 'emergency' && stroke.said.indexOf('911') < stroke.said.indexOf('Hennepin') && stroke.said.indexOf('Hennepin') > 0, stroke.said);
  const cramps = await mum.call('warning_signs', { symptoms: 'my legs are cramping' });
  check('cramps are not sent to an emergency department', !/Hennepin/.test(cramps.said), cramps.said);
  const info = await mum.call('warning_signs', {});
  check('a general question about the signs is not either', !/Hennepin/.test(info.said), info.said);
}

console.log('\nA shift that cannot be moved');
{
  // 70 at dawn, 80 by nine, 90 by noon, 99 at three.
  const temp = (h) => (h < 6 ? 70 : h < 9 ? 76 : h < 12 ? 84 : h < 14 ? 93 : 99);
  seedWeather(84, temp);
  const snap = weather.current(lat, lon);
  const general = personal.profileOf([], [], { outings: [] });
  const now = new Date();
  const hot = personal.planShift(snap, general, { now, day: 'tomorrow', fromHour: 7, untilHour: 15 });
  check('it covers the hours of the shift and no others', hot.hours.length === 8 && hot.label === '7 am to 3 pm', `${hot.hours.length} ${hot.label}`);
  check('the first hour past 80 is found', hot.initialFrom === '9 am', String(hot.initialFrom));
  check('the first hour past 90 is found', hot.highFrom === '12 pm', String(hot.highFrom));
  check('breaks are every two hours from then, inside the shift', hot.breaks.join() === '2 pm', hot.breaks.join());
  check('the peak and when it comes are said', new RegExp(`peaks at heat index ${hot.peakHeatIndexF} at 2 pm`).test(hot.spoken), hot.spoken);
  check('the rule is named as proposed, not as law', /the workplace heat rule OSHA proposed/.test(hot.spoken), hot.spoken);
  check('heat stroke and 911 are in a shift past 90', /call 911/.test(hot.spoken));

  const warm = personal.planShift(snap, general, { now, day: 'tomorrow', fromHour: 6, untilHour: 12 });
  check('a shift that only passes 80 gets water and shade, not break times', /past 80/.test(warm.spoken) && warm.breaks.length === 0 && !/15 minute/.test(warm.spoken), warm.spoken);
  const cool = personal.planShift(snap, general, { now, day: 'tomorrow', fromHour: 0, untilHour: 6 });
  check('a shift below 80 says so and adds no rules', /below where workplace heat rules start/.test(cool.spoken) && cool.initialFrom === null, cool.spoken);
  const none = personal.planShift({ ...snap, hourly: [] }, general, { now, day: 'tomorrow', fromHour: 7, untilHour: 15 });
  check('with no forecast it says so and does not guess', /don't have the forecast/.test(none.spoken) && none.peakHeatIndexF === null, none.spoken);

  const r = await mum.call('plan_my_day', { day: 'tomorrow', shiftStart: 7, shiftEnd: 15 });
  check('through the tool, somebody on a heart medicine hears their own earlier line', /For you, .*the risky part starts earlier, at/.test(r.said) && r.data.shift.personalFrom !== null, r.said);
  check('...and it comes before the general 90 line, or there would be nothing to say', r.data.shift.hours === undefined && typeof r.data.shift.highFrom === 'string');
  check('...and the medicine itself is not what a shift answer is cut for: 911 keeps it whole', /call 911/.test(r.said));
  const night = await mum.call('plan_my_day', { shiftStart: 22, shiftEnd: 6 });
  check('an overnight shift is refused in plain words', night.data.planned === false && /starts and ends on the same day/.test(night.said), night.said);
  const walk = await mum.call('plan_my_day', { activity: 'a walk', minutes: 30, day: 'tomorrow' });
  check('without shift hours the ordinary day plan still answers', walk.data.shift === undefined && walk.data.best !== undefined, walk.said);

  seedWeather(10, () => 10);
  const frozen = personal.planShift(weather.current(lat, lon), general, { now, day: 'tomorrow', fromHour: 7, untilHour: 15 });
  check('a freezing shift is answered as cold, with no heat rule', /is a cold one/.test(frozen.spoken) && !/OSHA/.test(frozen.spoken), frozen.spoken);
}

console.log('\nGetting used to the heat');
{
  const today = '2026-07-10';
  check('somebody new does a fifth of a day on day one', personal.acclimatization({ kind: 'new', since: today }, today).fraction === 0.2);
  check('...two fifths on day two', Math.abs(personal.acclimatization({ kind: 'new', since: '2026-07-09' }, today).fraction - 0.4) < 1e-9 && personal.acclimatization({ kind: 'new', since: '2026-07-09' }, today).day === 2);
  check('...and is treated as used to it from day five', personal.acclimatization({ kind: 'new', since: '2026-07-06' }, today) === null);
  check('somebody returning does half, then 60 and 80 percent', [0, 1, 2].map((d) => personal.acclimatization({ kind: 'returning', since: `2026-07-${String(10 - d).padStart(2, '0')}` }, today).fraction).join() === '0.5,0.6,0.8');
  check('...and a full day on day four', personal.acclimatization({ kind: 'returning', since: '2026-07-07' }, today) === null);
  check('nothing said about it means nothing is assumed', personal.acclimatization(null, today) === null && personal.acclimatization(undefined, today) === null);
  check('a start date in the future is ignored', personal.acclimatization({ kind: 'new', since: '2026-07-20' }, today) === null);

  const temp = (h) => (h < 6 ? 70 : h < 9 ? 76 : 96);
  seedWeather(90, temp);
  const snap = weather.current(lat, lon);
  const anybody = personal.profileOf([], [], { outings: [] });
  const now = new Date();
  const localToday = new Date(now.getTime() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + snap.utcOffsetSeconds * 1000 + 86_400_000).toISOString().slice(0, 10);
  const fresh = personal.planShift(snap, anybody, { now, day: 'tomorrow', fromHour: 7, untilHour: 17, heatWork: { kind: 'new', since: tomorrow } });
  check('day one of a ten hour shift is two hours of heat', fresh.acclimatization.heatHoursAllowed === 2 && fresh.acclimatization.day === 1, JSON.stringify(fresh.acclimatization));
  check('...counted from the first hot hour, so done by 11', fresh.acclimatization.doneBy === '11 am', fresh.acclimatization.doneBy);
  check('...and said in the plan', /This is day 1 of getting used to the heat, so no more than 2 hours of it tomorrow: done by 11 am\./.test(fresh.spoken), fresh.spoken);
  const back = personal.planShift(snap, anybody, { now, day: 'tomorrow', fromHour: 7, untilHour: 17, heatWork: { kind: 'returning', since: tomorrow } });
  check('somebody returning gets half the shift', back.acclimatization.heatHoursAllowed === 5 && /being back in the heat/.test(back.spoken), back.spoken);
  const settled = personal.planShift(snap, anybody, { now, day: 'tomorrow', fromHour: 7, untilHour: 17, heatWork: null });
  check('somebody settled gets no limit', settled.acclimatization === null && !/day \d of/.test(settled.spoken));
  seedWeather(70, () => 70);
  const cool = personal.planShift(weather.current(lat, lon), anybody, { now, day: 'tomorrow', fromHour: 7, untilHour: 17, heatWork: { kind: 'new', since: tomorrow } });
  check('on a cool day there is no heat to ration', cool.acclimatization === null);

  seedWeather(90, temp);
  const worker = await connect('acct:worker');
  await worker.call('register_location', { place: 'Minneapolis, Minnesota', lat, lon });
  await worker.call('medication', { action: 'add', name: 'metoprolol' });
  const said = await worker.call('plan_my_day', { shiftStart: 7, shiftEnd: 17, startedWork: 'new' });
  check('"I started today" is remembered, dated where they are', store.get('acct:worker').heatWork.kind === 'new' && store.get('acct:worker').heatWork.since === localToday, JSON.stringify(store.get('acct:worker').heatWork));
  check('...and settled clears it', (await worker.call('plan_my_day', { shiftStart: 7, shiftEnd: 17, startedWork: 'settled' })) && store.get('acct:worker').heatWork === null);
  await worker.call('plan_my_day', { shiftStart: 7, shiftEnd: 17, startedWork: 'new' });

  console.log('\nA crew asking, through a link');
  const code = (await worker.call('share_my_day', { action: 'invite' })).data.code;
  const farm = await connect('demo:orbita-sandbox');
  check('with no link, a crew is told nobody is sharing', (await farm.call('check_on', { crewLink: 'a'.repeat(48) })).data.sharing === false);
  const joined = await farm.call('share_my_day', { action: 'join', code, as: 'crew' });
  const link = joined.data.crewLink;
  check('the code is exchanged for a link', joined.data.joined === true && /^[0-9a-f]{48}$/.test(link));
  check('only a hash of the link is stored', !JSON.stringify(store.get('acct:worker')).includes(link) && store.get('acct:worker').crewLinks.length === 1);
  check('the code works once', (await farm.call('share_my_day', { action: 'join', code, as: 'crew' })).data.joined === false);
  const day = await farm.call('check_on', { crewLink: link, shiftStart: 7, shiftEnd: 17 });
  check('the crew hears the day and how much heat they should do', day.data.sharing === true && /They are on day 1 in the heat: 2 hours of it today/.test(day.said), day.said);
  check('...and when it turns risky for them, without the reason', day.data.crew.riskyFrom !== undefined && !/metoprolol|beta|medic|heart|condition/i.test(JSON.stringify(day)), JSON.stringify(day.data));
  check('...and nothing else about them: no place, no name, no profile', Object.keys(day.data.crew).sort().join() === 'acclimatization,highFrom,label,peakAt,peakHeatIndexF,riskyFrom,timezone', Object.keys(day.data.crew).join());
  check('a made-up link gets nothing', (await farm.call('check_on', { crewLink: 'b'.repeat(48) })).data.sharing === false && (await farm.call('check_on', { crewLink: 'not a link' })).data.sharing === false);
  await worker.call('share_my_day', { action: 'stop' });
  check('when they stop sharing, the link stops at once', (await farm.call('check_on', { crewLink: link })).data.sharing === false && store.get('acct:worker').crewLinks.length === 0);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
