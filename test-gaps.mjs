/**
 * The gaps the 2026 research pointed at, tested here as closed.
 *
 *   A home too hot to stay in. Most heat deaths are at home, and Japan's 2026 pilot tells the family when the
 *   home gets too hot. Sudor now emails the contacts who agreed, once a day, from a reading or the forecast.
 *   Asking afterwards. Told to leave a hot home, the next question half an hour later asks whether they went.
 *   The carer. Somebody checking on a person hears what to do today, and never a medicine or a condition.
 *   How sure. A warning that rests on how a drug works, not on studies in the heat, says so.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-gaps';
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

// No network: the forecast download is refused so the seeded day stands.
globalThis.fetch = async () => { throw new Error('offline in this test'); };

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const notify = await import('./dist/notify.js');
const attention = await import('./dist/attention.js');
const shelters = await import('./dist/shelters.js');
const meds = await import('./dist/meds.js');
const { checkHotHome } = await import('./dist/alerts.js');
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

/** A day in Phoenix: `high` in the afternoon, `low` overnight, with local time `hour` wherever the clock is. */
const LAT = 33.45, LON = -112.07;
function seedDay(high, low, hour = 12) {
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
      hourly.push({ local: at, time: weather.localToUtc(at, off), tempF: t, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: h >= 6 && h < 19, aqi: 40, solarWm2: 500, wetBulbF: t - 25 });
    }
  }
  const daily = [0, 1, 2].map((d) => ({ date: local(Date.now() + d * 86_400_000).slice(0, 10), maxF: high, feelsMaxF: high, minF: low, weatherCode: 0 }));
  const now = hourly.find((h) => h.local.startsWith(today) && h.local.slice(11, 13) === local(Date.now()).slice(11, 13)) ?? hourly[12];
  weather.seedForTest({ lat: LAT, lon: LON, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: off, tempF: now.tempF, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: true, aqi: 40, solarWm2: 500, wetBulbF: now.tempF - 25, hourly, daily });
  return today;
}

/** A contact who has agreed to hear about bad days. */
const agreed = (name, email) => ({ id: `c-${name}`, name, email, relation: 'daughter', notifyOn: ['hot_day', 'emergency'], addedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), acceptedAt: new Date().toISOString(), stopId: `stop-${name}` });

async function personIn(id, { medicine, cooling, contacts = [], indoor, livesAlone } = {}) {
  const setup = await connect(id, 'all');
  await setup('register_location', { place: 'Phoenix, Arizona', lat: LAT, lon: LON });
  if (medicine) await setup('medication', { action: 'add', name: medicine });
  store.update(id, (p) => {
    p.contacts = contacts;
    if (cooling) p.cooling = cooling;
    if (indoor != null) p.indoor = { f: indoor, at: new Date().toISOString() };
    if (livesAlone != null) p.livesAlone = livesAlone;
  });
}

console.log('\nA home too hot to stay in, and the family told');
{
  seedDay(110, 90, 12);
  await personIn('acct:hot-home', { medicine: 'metoprolol', cooling: 'broken', contacts: [agreed('Priya', 'priya@example.org')] });
  seedDay(110, 90, 12);
  sent.length = 0;
  const first = await checkHotHome();
  check('a broken air conditioner on a 110 degree day with a 90 degree night emails the family', sent.length === 1 && sent[0].to === 'priya@example.org', JSON.stringify(sent.map((e) => e.subject)));
  check('...saying the home is too hot to stay in, and why, from the forecast', /too hot to stay in today/.test(sent[0]?.text ?? '') && /reaches 110 outside today and only falls to 90 tonight/.test(sent[0]?.text ?? ''), sent[0]?.text);
  check('...with nothing about their health in it', !/metoprolol|medicine|medication|beta/i.test(sent[0]?.text ?? ''));
  check('...and the stop link every email carries', /To stop these emails, open https:\/\/sudor\.example\.org\//.test(sent[0]?.text ?? ''), sent[0]?.text.slice(-120));
  await checkHotHome();
  check('once a day, not every ten minutes', sent.length === 1 && first.length === 1, String(sent.length));

  await personIn('acct:cool-home', { medicine: 'metoprolol', cooling: 'working', contacts: [agreed('Sam', 'sam@example.org')] });
  sent.length = 0;
  await checkHotHome();
  check('a home whose cooling works is not reported', !sent.some((e) => e.to === 'sam@example.org'));

  await personIn('acct:early', { cooling: 'none', contacts: [agreed('Ana', 'ana@example.org')] });
  seedDay(110, 90, 5);
  sent.length = 0;
  await checkHotHome();
  check('a forecast is not acted on before eight in the morning, their time', !sent.some((e) => e.to === 'ana@example.org'));
  seedDay(110, 90, 12);

  await personIn('acct:reading', { cooling: 'working', contacts: [agreed('Lee', 'lee@example.org')] });
  const me = await connect('acct:reading');
  sent.length = 0;
  const told = await me('about_me', { indoorTempF: 91 });
  check('a reading of 91 with working air conditioning: turn it on, below 79, with the words that make Alexa do it', /even though your air conditioning works/.test(told.said) && /set it below 79/.test(told.said) && /say: Alexa, turn on the air conditioner\./.test(told.said), told.said);
  check('...and to leave if the room has not cooled within the hour', /not cooler within the hour, go somewhere with working cooling/.test(told.said));
  const home = told.data.did?.find((d) => d.tool === 'home');
  check('...with the same request as data, for a host that controls devices', home?.homeControl?.device === 'air conditioner' && home.homeControl.action === 'turn_on' && home.homeControl.setBelowF === 79, JSON.stringify(home));
  check('...and says the family is being told, by name', /I am letting Lee know your home is too hot today\./.test(told.said), told.said);
  await new Promise((r) => setTimeout(r, 20));
  check('...and the email goes, from the reading', sent.some((e) => e.to === 'lee@example.org' && /told Sudor it is 91 degrees inside/.test(e.text)), JSON.stringify(sent.map((e) => e.text.slice(0, 80))));

  await personIn('acct:warm-room', { medicine: 'metoprolol', cooling: 'working' });
  const warm = await (await connect('acct:warm-room'))('about_me', { indoorTempF: 82 });
  check('82 inside with working cooling, for someone the heat is hard on: switch it on, and no leaving yet', /Turn it on now/.test(warm.said) && !/within the hour/.test(warm.said) && warm.data.nextAction?.tool !== 'somewhere_to_go', warm.said);
  await personIn('acct:fan-room', { medicine: 'metoprolol', cooling: 'fan' });
  const fanRoom = await (await connect('acct:fan-room'))('about_me', { indoorTempF: 84 });
  check('a fan at 84: turn the fan on, and the smart plug words', /Turn your fan on now/.test(fanRoom.said) && /Alexa, turn on the fan/.test(fanRoom.said), fanRoom.said);
  await personIn('acct:fan-hot', { medicine: 'metoprolol', cooling: 'fan' });
  const fanHot = await (await connect('acct:fan-hot'))('about_me', { indoorTempF: 95 });
  check('a fan at 95 is not offered: the CDC says a fan stops helping above 90', !/Turn your fan on/.test(fanHot.said) && /90/.test(fanHot.said), fanHot.said);

  await personIn('demo:0123456789abcdef0123456789abcdef', { cooling: 'none', contacts: [agreed('Kim', 'kim@example.org')] });
  sent.length = 0;
  await checkHotHome();
  check('the public demo sends no email', !sent.some((e) => e.to === 'kim@example.org'));
}

console.log('\nAsked afterwards whether they went');
{
  attention.resetForTest();
  seedDay(110, 90, 12);
  await personIn('acct:follow', { medicine: 'metoprolol', cooling: 'none' });
  const me = await connect('acct:follow');
  const warned = await me('weather_check');
  check('a home with no way to cool down points them somewhere cool', warned.data.nextAction?.tool === 'somewhere_to_go', JSON.stringify(warned.data.nextAction));
  const soon = await me('plan_my_day');
  check('straight afterwards nothing is asked yet', !/Earlier I said your home was too hot/.test(soon.said));
  const today = new Date(Date.now() + weather.current(LAT, LON).utcOffsetSeconds * 1000).toISOString().slice(0, 10);
  // As if the warning had been half an hour ago.
  attention.resetForTest();
  attention.sentAway('acct:follow', today, Date.now() - 31 * 60 * 1000);
  const later = await me('plan_my_day');
  check('half an hour later the next answer begins with the question', /^Earlier I said your home was too hot to stay in\. If you are still there, want me to find somewhere cool now\?/.test(later.said), later.said.slice(0, 140));
  check('...and names somewhere to go as the next step', later.data.followedUp === true && later.data.nextAction?.tool === 'somewhere_to_go', JSON.stringify(later.data.nextAction));
  const again = await me('plan_my_day');
  check('it is asked once, not every time', !/Earlier I said your home was too hot/.test(again.said));

  attention.resetForTest();
  attention.sentAway('acct:follow', today, Date.now() - 31 * 60 * 1000);
  const urgent = await me('warning_signs', { symptoms: 'I feel dizzy' });
  check('never in front of an urgent answer', !/Earlier I said your home was too hot/.test(urgent.said));
  await me('somewhere_to_go');
  const after = await me('plan_my_day');
  check('looking for somewhere to go ends it', !/Earlier I said your home was too hot/.test(after.said), after.said.slice(0, 120));
  attention.sentAway('acct:follow', '2000-01-01', Date.now() - 31 * 60 * 1000);
  const old = await me('plan_my_day');
  check('yesterday\'s warning is not asked about today', !/Earlier I said your home was too hot/.test(old.said));
}

console.log('\nThe carer checking on them');
{
  seedDay(110, 90, 12);
  await personIn('acct:mum', { medicine: 'metoprolol', cooling: 'broken', livesAlone: true });
  const mum = await connect('acct:mum');
  const invite = await mum('share_my_day', { action: 'invite' });
  const code = invite.data.code ?? (/\b([A-Z0-9]{4}[ -]?[A-Z0-9]{4})\b/.exec(invite.said) || [])[1];
  const daughter = await connect('acct:daughter');
  const joined = await daughter('share_my_day', { action: 'join', code });
  check('the daughter joins with the code', /Ask me how their day is looking/.test(joined.said), joined.said);
  store.update('acct:mum', (p) => void (p.lastSeenAt = new Date(Date.now() - 20 * 3600_000).toISOString()));
  const day = await daughter('share_my_day', { action: 'check' });
  check('a risky day is said to her as things to do', Array.isArray(day.data.forCarer) && day.data.forCarer.length >= 4, JSON.stringify(day.data.forCarer));
  check('...the home first, when it is too hot to stay in', day.data.homeTooHot === true && /^Their home is too hot to stay in today/.test(day.data.forCarer[0]), day.data.forCarer?.[0]);
  check('...that her mother has not been heard from since this morning', day.data.forCarer.some((l) => /not spoken to me since this morning/.test(l)));
  check('...the indoor limit, water, and when to call 911', day.data.forCarer.some((l) => /79 degrees/.test(l)) && day.data.forCarer.some((l) => /drink/.test(l)) && day.data.forCarer.some((l) => /call 911/.test(l)));
  check('...and never the medicine or what it does', !/metoprolol|beta|sweat|medic/i.test(`${day.said} ${JSON.stringify(day.data)}`));
  store.update('acct:mum', (p) => void (p.privacy = true));
  const kept = await daughter('share_my_day', { action: 'check' });
  check('a private profile keeps even the home out of it', !kept.data.homeTooHot && !/home is too hot/.test(kept.said));
  store.update('acct:mum', (p) => void (p.privacy = false));
  seedDay(75, 60, 12);
  const fine = await daughter('share_my_day', { action: 'check' });
  check('a fine day is a status, with nothing to do', !fine.data.forCarer, JSON.stringify(fine.data.forCarer));
}

console.log('\nHow sure each warning is');
{
  check('anticholinergics are measured in trials', meds.evidenceFor('anticholinergic') === 'trial' && meds.evidenceFor('anticholinergic antihistamine') === 'trial');
  check('diuretics, beta blockers and antipsychotics are seen in studies of admissions', ['loop diuretic', 'beta blocker', 'atypical antipsychotic'].every((c) => meds.evidenceFor(c) === 'observational'));
  check('GLP-1 and SGLT2 drugs rest on how they work', ['GLP-1 agonist', 'GLP-1 and GIP agonist', 'SGLT2 inhibitor'].every((c) => meds.evidenceFor(c) === 'mechanism'));
  check('every class in the list has a level', meds.MEDICATIONS.every((m) => ['trial', 'observational', 'mechanism'].includes(meds.evidenceFor(m.drugClass))));

  seedDay(108, 85, 12);
  await personIn('acct:glp', { medicine: 'semaglutide', cooling: 'working' });
  const glp = await connect('acct:glp');
  const said = await glp('weather_check');
  check('semaglutide is named, and said to be a precaution from how the drug works', /semaglutide/.test(said.said) && said.data.evidence === 'mechanism', `${said.data.evidence} | ${said.said}`);
  const more = await glp('tell_me_more');
  check('...in the answer or the detail behind it', /rather than from studies in the heat, so take it as a precaution/.test(`${said.said} ${more.said}`), `${said.said} || ${more.said}`);
  await personIn('acct:beta', { medicine: 'metoprolol', cooling: 'working' });
  const beta = await (await connect('acct:beta'))('weather_check');
  check('metoprolol is said as before, without the precaution line', beta.data.evidence === 'observational' && !/take it as a precaution/.test(beta.said), beta.said);
}

console.log('\nMore cities and provinces: cooling centres, read in each publisher\'s own field names');
{
  const cooling = await import('./dist/cooling.js');
  const pt = (x, y) => ({ x, y });
  const weekday = new Date(Date.now() - 6 * 3_600_000).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const ROWS = {
    Warming_Cooling_Sites_PUBLICVIEW: [
      { attributes: { site_name: 'Germantown House', site_address: '5457 Wayne Ave', site_hours: 'M-F; 9A-5P', cooling_site: 'yes', site_status: 'open', handicap_accessible: 'yes' }, geometry: pt(-75.17, 40.03) },
      { attributes: { site_name: 'Closed Hall', site_address: '1 Main St', site_hours: '9A-5P', cooling_site: 'yes', site_status: 'closed' }, geometry: pt(-75.171, 40.031) },
      { attributes: { site_name: 'Warming Only', site_address: '2 Main St', site_hours: '9A-5P', cooling_site: 'no', site_status: 'open' }, geometry: pt(-75.172, 40.032) },
    ],
    HLTH_COOL_ZONES_PUBLIC: [{ attributes: { NAME: 'Logan Heights Library', Address: '567 S 28th St', City: 'San Diego', Phone: '+1 (619) 533-3968', PetPolicy: 'Service Animals Only' }, geometry: pt(-117.13, 32.70) }],
    Maryland_Cooling_Centers_by_Jurisdiction: [
      { attributes: { Cooling_Center: 'Pratt Library', Location: '400 Cathedral St, Baltimore, MD', Note: null }, geometry: pt(-76.617, 39.294) },
      { attributes: { Cooling_Center: 'Shut Branch', Location: '1 Elm St, Towson, MD', Note: 'Baltimore County Public Library / Closed for rennovation' }, geometry: pt(-76.61, 39.30) },
      { attributes: { Cooling_Center: 'Senior Centre', Location: '2 Elm St, Ellicott City, MD', Note: 'Department of Community Resources and Services 50+ Centers' }, geometry: pt(-76.62, 39.29) },
    ],
    Cooling_Centers_Viewer: [{ attributes: { NAME: 'Central Library', ADDRESS: '600 Soledad St', CITY: 'San Antonio', PHONE: '210.207.2500', TYPE: 'Library', status: 'Active', USETYPE: 'Cooling Site', MONDAY: '10am-6pm', TUESDAY: '10am-6pm', WEDNESDAY: '10am-6pm', THURSDAY: '10am-6pm', FRIDAY: '10am-6pm', SATURDAY: '10am-6pm', SUNDAY: '10am-6pm' }, geometry: pt(-98.49, 29.43) }],
    CoolingCenters_view: [
      { attributes: { LABEL: 'Main Library', ADDRESS1: '96 S Grant Ave', ADDRESS2: 'Columbus, OH 43215', LAYER_TYPE: 'Library', RegularHours: '9 am to 9 pm', ExtendedHours: 'None', CoolingCenter_YN: 'Yes' }, geometry: pt(-82.99, 39.96) },
      { attributes: { LABEL: 'Not A Centre', ADDRESS1: '1 Main', ADDRESS2: 'Columbus', LAYER_TYPE: 'Community Center', RegularHours: '', ExtendedHours: 'None', CoolingCenter_YN: 'No' }, geometry: pt(-82.991, 39.961) },
    ],
    Warming_and_Cooling_Submittal_view: [
      { attributes: { centername: 'Open Now Center', centertype: 'cooling', publicview: 'yes', firstday: Date.now() - 86_400_000, lastday: Date.now() + 86_400_000, pntaddr: '1370 Victory Dr, South Euclid, OH' }, geometry: pt(-81.52, 41.52) },
      { attributes: { centername: 'Last Summer Center', centertype: 'cooling', publicview: 'yes', firstday: Date.parse('2025-07-01'), lastday: Date.parse('2025-07-03'), pntaddr: '2 Elm, Cleveland, OH' }, geometry: pt(-81.521, 41.521) },
    ],
    RI_Cooling_Centers_July_2026: [{ attributes: { USER_Name: 'Providence Public Library', USER_Address: '150 Empire Street', USER_Municipality: 'Providence', [`USER_${weekday}`]: '8:30am-7pm' }, geometry: pt(-71.415, 41.82) }],
    TPH_Cooling_Centres_View: [
      { attributes: { locationName: 'Metro Hall', locationTypeDesc: 'Cooling Centre', address: '55 John St', status: 'active', lat: '43.646', lon: '-79.389', ...Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].flatMap((d) => [[`${d}Open`, '0800'], [`${d}Close`, '2030']])) } },
      { attributes: { locationName: 'Christie Pits', locationTypeDesc: 'Wading Pool', address: '750 Bloor St W', status: 'Active', lat: '43.664', lon: '-79.42' } },
    ],
    MKE_Cooling_Sites_Hosted: [
      { attributes: { Name: 'Central Library', Category: 'Public Building', Subcategor: 'Library', Address: '814 W Wisconsin Ave', City: 'Milwaukee' }, geometry: pt(-87.92, 43.039) },
      { attributes: { Name: 'Pulaski Splash Pad', Category: 'Water Recreation', Subcategor: 'Splash Pad', Address: '2677 S 16th St', City: 'Milwaukee' }, geometry: pt(-87.921, 43.04) },
    ],
    York_County_Cooling_Centers: [{ attributes: { Name: 'Crispus Attucks Association', Address: '605 South Duke Street, York', Access: 'Monday-Friday 9AM-3PM', PhoneNumbe: '7178483610', SeniorCent: 'Y' }, geometry: pt(-76.72, 39.955) }],
    Community_Response_Locations_Public_View: [
      { attributes: { Site_Type: 'Public Cooling Space', Site_Subtype: 'Library', Site_Label: 'Kelowna Library', Site_Address_Location_Desc: '1380 Ellis St, Kelowna, BC', Site_Status: 'Open', Review_Status: 'Approved', Other_Comments: 'Operating Hours: 10am-5pm' }, geometry: pt(-119.49, 49.89) },
      { attributes: { Site_Type: 'Public Cooling Space', Site_Subtype: 'Spray park', Site_Label: 'City Park', Site_Address_Location_Desc: 'Kelowna', Site_Status: 'Open', Review_Status: 'Approved' }, geometry: pt(-119.491, 49.891) },
    ],
  };
  const before = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [name, features] of Object.entries(ROWS)) if (u.includes(name)) return new Response(JSON.stringify({ features }), { status: 200 });
    return new Response(JSON.stringify({ features: [] }), { status: 200 });
  };
  cooling.configureForTest(null);
  await cooling.start();
  const names = (lat, lon) => (cooling.near(lat, lon) ?? []).map((c) => c.name);
  check('Philadelphia: the open cooling site, not the closed one or the warming-only one', names(40.03, -75.17).join() === 'Germantown House', names(40.03, -75.17).join());
  const phl = cooling.near(40.03, -75.17)[0];
  check('...its hours as they should be heard', /Its hours: Monday to Friday, 9 am to 5 pm\.$/.test(cooling.sentence(phl)), cooling.sentence(phl));
  check('San Diego: the Cool Zone library, its phone without the country code', cooling.near(32.70, -117.13)[0]?.phone === '(619) 533-3968');
  check('Maryland: the library, the 50+ centre for who it is for, and not the branch closed for renovation', names(39.294, -76.617).includes('Pratt Library') && !names(39.294, -76.617).includes('Shut Branch') && cooling.near(39.294, -76.617).find((c) => c.name === 'Senior Centre')?.openTo === 'adults 50 and over');
  check('San Antonio: open today, with today\'s hours', /open today is Central Library, .* from 10 am to 6 pm\.$/.test(cooling.sentence(cooling.near(29.43, -98.49)[0])), cooling.sentence(cooling.near(29.43, -98.49)[0]));
  check('Columbus: only what the city marks as a cooling centre', names(39.96, -82.99).join() === 'Main Library');
  check('Cleveland: a centre the county has open today, not last summer\'s', names(41.52, -81.52).join() === 'Open Now Center', names(41.52, -81.52).join());
  check('Rhode Island: open today, with today\'s hours', /from 8:30 am to 7 pm\.$/.test(cooling.sentence(cooling.near(41.82, -71.415)[0])));
  check('Toronto: the cooling centre on a 24 hour clock, and not the wading pool', names(43.646, -79.389).join() === 'Metro Hall' && /from 8 am to 8:30 pm\.$/.test(cooling.sentence(cooling.near(43.646, -79.389)[0])), names(43.646, -79.389).join());
  check('British Columbia: the library, and not the spray park', names(49.89, -119.49).join() === 'Kelowna Library' && /10am-5pm/.test(cooling.near(49.89, -119.49)[0].hours ?? ''), JSON.stringify(cooling.near(49.89, -119.49)));
  check('Milwaukee: the library, and not the splash pad beside it', names(43.039, -87.92).join() === 'Central Library', names(43.039, -87.92).join());
  const york = cooling.near(39.955, -76.72)[0];
  check('York County: a senior centre is for older adults, with its phone written to be read', york?.openTo === 'older adults' && york.phone === '717-848-3610' && /Monday to Friday 9 am to 3 pm/.test(cooling.sentence(york)), york && cooling.sentence(york));
  check('a place none of the twenty-three lists reaches is still "not covered", never "none open"', cooling.near(41.88, -87.63) === undefined && cooling.sourceNames().length === 23, String(cooling.sourceNames().length));
  globalThis.fetch = before;
  cooling.configureForTest(async () => []);
}

console.log('\nThe power out at the address, beyond California');
{
  const outages = await import('./dist/outages.js');
  check('Duke writes Eastern time with no zone: 7:25 pm on 13 October is 23:25 UTC, in daylight time', outages.easternToIso('2026-10-13 19:25:48') === '2026-10-13T23:25:48.000Z');
  check('...and 00:25 UTC the next day in January, in standard time', outages.easternToIso('2026-01-13 19:25:48') === '2026-01-14T00:25:48.000Z');
  const sq = (lat, lon, d = 0.02) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];
  const before = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const rows = u.includes('Duke_Energy')
      ? [{ attributes: { START_TIME: '2026-10-13 19:25:48', ETR: '2026-10-14 02:30:00', CAUSE: '09 Public Accident/Damage', AFFECTED_CUSTOMERS: 22 }, geometry: { rings: sq(35.23, -80.84) } }]
      : u.includes('BC_Hydro')
        ? [{ attributes: { DATE_OFF: Date.parse('2026-10-13T16:00:00Z'), ETR: Date.parse('2026-10-14T01:00:00Z'), CAUSE: 'Planned work being done on our equipment', NUMBER_OF_CUSTOMERS_AFFECTED: 195 }, geometry: { rings: sq(49.24, -123.04) } }]
        : [];
    return new Response(JSON.stringify({ features: rows }), { status: 200 });
  };
  outages.configureForTest(null);
  await outages.start();
  const charlotte = outages.at(35.23, -80.84);
  check('Charlotte, inside a Duke outage area: found, with customers and when it is back', charlotte && charlotte.utility === 'Duke Energy' && charlotte.customers === 22 && charlotte.backBy === '2026-10-14T06:30:00.000Z', JSON.stringify(charlotte));
  check('...said as Duke Energy\'s own list, in local time', charlotte && outages.sentence(charlotte, 'America/New_York') === 'Duke Energy shows the power out where you live, expected back by Wed 2:30 AM.', charlotte && outages.sentence(charlotte, 'America/New_York'));
  check('Raleigh, outside every Duke area: false, checked', outages.at(35.78, -78.64) === false);
  const van = outages.at(49.24, -123.04);
  check('Vancouver, inside a BC Hydro area: planned work, said so', van && van.planned === true && /^BC Hydro shows the power out where you live: planned work, expected back by/.test(outages.sentence(van, 'America/Vancouver')), van && outages.sentence(van, 'America/Vancouver'));
  check('California is still read, and Phoenix is still not covered', outages.at(38.58, -121.49) === false && outages.at(33.45, -112.07) === undefined);
  outages.configureForTest(async () => null);
  await outages.start();
  check('a list that could not be read is null, never "the power is on"', outages.at(35.23, -80.84) === null);

  // By county, where no list gives the streets.
  const county = (name, out, served, at = new Date().toISOString()) => ({ county: name, out, served, says: "Pennsylvania's emergency management agency", at, rings: sq(40.44, -79.99, 0.3) });
  outages.seedCountyForTest('Pennsylvania counties', [county('Allegheny County', 12400, 487400)]);
  const pgh = outages.countyAt(40.44, -79.99);
  check('Pittsburgh, with 12,400 out in the county: said as the county, never as the street', pgh && /^Pennsylvania's emergency management agency shows about 12,400 of about 487,400 customers in Allegheny County without power right now\. That is the county, not your street/.test(outages.countySentence(pgh)), pgh && outages.countySentence(pgh));
  outages.seedCountyForTest('Pennsylvania counties', [county('Allegheny County', 26, 487400)]);
  check('...and 26 out of 487,400, an ordinary day, is not said at all', outages.countyAt(40.44, -79.99) === null);
  outages.seedCountyForTest('Pennsylvania counties', [county('Allegheny County', 12400, 487400, new Date(Date.now() - 8 * 3600_000).toISOString())]);
  check('...nor is a count more than six hours old', outages.countyAt(40.44, -79.99) === null);
  outages.seedCountyForTest('Pennsylvania counties', null);
  globalThis.fetch = before;
}

console.log('\nBritish brand names, where Alexa+ launched in Europe first');
{
  const brands = await import('./dist/brands.js');
  const gb = (w) => brands.ingredientsOf(w, 'GB');
  check('Istin is amlodipine and Zestril is lisinopril, for somebody in the UK', gb('Istin')?.ingredients.join() === 'amlodipine' && gb('Zestril')?.ingredients.join() === 'lisinopril', JSON.stringify([gb('Istin'), gb('Zestril')]));
  check('Ventolin comes back under the name the medicine table uses, albuterol', gb('Ventolin')?.ingredients.join() === 'albuterol', JSON.stringify(gb('Ventolin')));
  check('a combination brand keeps both of its medicines', (gb('Aldactide')?.ingredients ?? []).length === 2, JSON.stringify(gb('Aldactide')));
  const { readFileSync } = await import('node:fs');
  const file = JSON.parse(readFileSync('./assets/brands-GB.json', 'utf8'));
  check('the list says where it came from and under what licence', /Open Government Licence/.test(file.source) && Object.keys(file.brands).length > 5000);
}

console.log('\nWhether anybody acts on it, counted without counting anybody');
{
  const impact = await import('./dist/impact.js');
  impact.resetForTest();
  attention.resetForTest();
  seedDay(110, 90, 12);
  await personIn('acct:counted', { medicine: 'metoprolol', cooling: 'none' });
  const me = await connect('acct:counted');
  await me('weather_check');
  let s = impact.summary(30).real;
  check('a home too hot to stay in is counted as one person sent away', s.sentAway === 1, JSON.stringify(s));
  await me('somewhere_to_go');
  s = impact.summary(30).real;
  check('...and looking for somewhere afterwards as acting on it', s.wentLooking === 1 && s.lookedAfterSentAway === 1, JSON.stringify(s));
  await me('somewhere_to_go');
  check('looking again without being sent away again is not counted twice', impact.summary(30).real.wentLooking === 1);
  await me('log_outing', { felt: 'unwell', minutes: 20 });
  await me('log_outing', { felt: 'fine', minutes: 45 });
  s = impact.summary(30).real;
  check('outings are counted as fine and unwell', s.outingUnwell === 1 && s.outingFine === 1, JSON.stringify(s));
  await personIn('demo:fedcba9876543210fedcba9876543210', { cooling: 'none' });
  await (await connect('demo:fedcba9876543210fedcba9876543210'))('weather_check');
  const both = impact.summary(30);
  check('a demo visitor is counted apart, so pressing buttons is not mistaken for use', both.real.sentAway === 1 && both.demo.sentAway === 1, JSON.stringify(both));
  check('every measure is there, as a number', impact.EVENTS.every((e) => typeof both.real[e] === 'number'));
  await new Promise((r) => setTimeout(r, 2200));
  const { readFileSync, existsSync } = await import('node:fs');
  const file = `${DIR}/impact.json`;
  const saved = existsSync(file) ? readFileSync(file, 'utf8') : '';
  check('what is kept on disk is days and counts, with no person or place in it', saved.length > 0 && !/acct:|demo:|Phoenix|metoprolol|33\.45/.test(saved) && /"\d{4}-\d{2}-\d{2}"/.test(saved), saved.slice(0, 160));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
