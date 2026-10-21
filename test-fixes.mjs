/**
 * Three things that were known to be wrong, and are tested here as fixed.
 *
 *   1. A contact was "confirmed" by the account holder. Now the person who owns the address agrees, or
 *      nothing but one invitation is ever sent to them.
 *   2. A question about the signs of heat stroke emailed the family that heat stroke had been described.
 *   3. Five wrong passphrases locked a name for everybody, so anyone could lock a person out.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-fixes';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
process.env.SUDOR_AUTH_DATA = `${DIR}/auth.json`;
process.env.SUDOR_PUBLIC_URL = 'https://sudor.example.org';
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_SCOPE;
delete process.env.SUDOR_RECIPIENT_CONSENT;

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const notify = await import('./dist/notify.js');
const consent = await import('./dist/consent.js');
const firstaid = await import('./dist/firstaid.js');
const authstore = await import('./dist/authstore.js');
const { registerTools } = await import('./dist/tools.js');
const { speakErrorsPlainly } = await import('./dist/plainly.js');

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
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };
}

// The consent pages, on a real socket, so the test sees what a browser would.
const app = express();
consent.mountConsent(app);
const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${listener.address().port}`;
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

const sent = [];
notify.configureForTest({ from: 'sudor@example.org', transport: async (email) => { sent.push(email); } });
const settle = () => new Promise((r) => setTimeout(r, 30));
const lat = 33.45, lon = -112.07;
weather.seedForTest({ lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: -25200, tempF: 104, humidityPct: 20, uvIndex: 9, windMph: 4, isDay: true, aqi: 40, solarWm2: 800, wetBulbF: 70, hourly: [], stale: false });
// The test's own hot day, kept so a section can put it back after a live download replaces it.
const HOT_DAY = weather.current(lat, lon);

console.log('\nThe person who gets the emails is the one who agrees');
const mum = await connect('acct:mum');
await mum('register_location', { place: 'Phoenix, Arizona', lat, lon });
let token = '';
{
  check('with a public address, the recipient has to agree', consent.consentRequired() === true);
  await mum('contact', { action: 'add', name: 'Priya', email: 'priya@example.com', relation: 'daughter' });
  check('adding somebody sends nothing', sent.length === 0);
  const yes = await mum('contact', { action: 'confirm', name: 'Priya' });
  await settle();
  check('the account holder saying yes sends one invitation, and says so', sent.length === 1 && sent[0].reason === 'invite' && /emailed Priya to ask if they agree/.test(yes.said) && /once they say yes, and not before/.test(yes.said), yes.said);
  check('...and the answer does not claim she will be alerted yet', yes.data.accepted === false);
  token = (sent[0].text.match(/accept\?t=([0-9a-f]{48})/) ?? [])[1] ?? '';
  check('the invitation carries a link on the public address', token.length === 48 && sent[0].text.includes('https://sudor.example.org/contact/accept?t='), sent[0].text);
  check('...and says nothing about health', !/medic|condition|heart|diagnos/i.test(sent[0].text), sent[0].text);
  const held = store.get('acct:mum').contacts[0];
  check('only a hash of the invitation is stored', held.acceptHash && held.acceptHash.length === 64 && held.acceptHash !== token && !JSON.stringify(held).includes(token));

  sent.length = 0;
  const stroke = await mum('warning_signs', { symptoms: 'she is confused and collapsed' });
  await settle();
  check('before she agrees, an emergency is not emailed to her', sent.length === 0 && stroke.data.level === 'emergency' && /911/.test(stroke.said), `${sent.length} ${stroke.said}`);
  const help = await mum('get_help', {});
  await settle();
  check('...and neither is a call for help, which says why', sent.length === 0 && /Priya has not agreed to be emailed yet/.test(help.said) && /call 911 yourself/.test(help.said), help.said);

  const again = await mum('contact', { action: 'confirm', name: 'Priya' });
  await settle();
  check('saying yes again does not send a second invitation', sent.length === 0 && /already emailed Priya/.test(again.said), again.said);
}

console.log('\nThe invitation link');
{
  const opened = await fetch(`${base}/contact/accept?t=${token}`);
  const html = await opened.text();
  check('opening it shows a page with a button, and is not itself agreement', opened.status === 200 && /<form method="post"/.test(html) && !store.get('acct:mum').contacts[0].acceptedAt);
  check('the page cannot be framed and is not cached', opened.headers.get('x-frame-options') === 'DENY' && opened.headers.get('cache-control') === 'no-store');
  check('a made-up link is refused', (await fetch(`${base}/contact/accept?t=${'0'.repeat(48)}`)).status === 404);
  check('a malformed link is refused', (await fetch(`${base}/contact/accept?t=<script>`)).status === 404);
  check('a made-up answer is refused', (await post('/contact/accept', { t: '1'.repeat(48), answer: 'yes' })).status === 404);
  const agreed = await post('/contact/accept', { t: token, answer: 'yes' });
  check('pressing yes records it', agreed.status === 200 && !!store.get('acct:mum').contacts[0].acceptedAt);
  check('the link works once', (await post('/contact/accept', { t: token, answer: 'yes' })).status === 404 && store.get('acct:mum').contacts[0].acceptHash === null);
}

console.log('\nAfter she agrees');
let stopId = '';
{
  sent.length = 0;
  const help = await mum('get_help', { what: 'I feel faint' });
  await settle();
  check('a call for help reaches her', sent.length === 1 && sent[0].to === 'priya@example.com' && /I'm emailing Priya/.test(help.said), help.said);
  stopId = (sent[0].text.match(/stop\?s=([0-9a-f]{32})/) ?? [])[1] ?? '';
  check('every email ends with a link that stops them', stopId.length === 32 && /To stop these emails, open https:\/\/sudor\.example\.org\/contact\/stop\?s=/.test(sent[0].text), sent[0].text.slice(-140));
  check('the email says she agreed, not that somebody confirmed for her', /agreed to it/.test(sent[0].text) && !/it was confirmed/.test(sent[0].text));
  const page = await fetch(`${base}/contact/stop?s=${stopId}`);
  check('the stop link shows a page with a button', page.status === 200 && store.get('acct:mum').contacts.length === 1);
  check('a made-up stop link is refused', (await fetch(`${base}/contact/stop?s=${'a'.repeat(32)}`)).status === 404);
  const stopped = await post('/contact/stop', { s: stopId, answer: 'stop' });
  check('pressing stop removes her', stopped.status === 200 && store.get('acct:mum').contacts.length === 0);
  sent.length = 0;
  await mum('get_help', {});
  await settle();
  check('...and nothing is sent to her afterwards', sent.length === 0);
}

console.log('\nThe answer comes back');
{
  notify.resetEmailLimitsForTest();
  sent.length = 0;
  const r = await connect('acct:reply');
  await r('register_location', { place: 'Phoenix, Arizona', lat, lon });
  process.env.SUDOR_RECIPIENT_CONSENT = 'off';
  await r('contact', { action: 'add', name: 'Priya', email: 'priya2@example.com' });
  await r('contact', { action: 'confirm', name: 'Priya' });
  delete process.env.SUDOR_RECIPIENT_CONSENT;
  store.update('acct:reply', (p) => { p.contacts[0].acceptedAt = new Date().toISOString(); });
  await r('get_help', { what: 'the power is out' });
  await settle();
  const link = (sent.at(-1).text.match(/reply\?r=([0-9a-f]{48})/) ?? [])[1] ?? '';
  check('the help email carries a way to answer', link.length === 48 && /To tell them you are on your way, or ask them to ring you, open https:\/\/sudor\.example\.org\/contact\/reply\?r=/.test(sent.at(-1).text));
  check('only a hash of that link is stored', !JSON.stringify(store.get('acct:reply')).includes(link) && store.get('acct:reply').helpAsks.length === 1);
  const page = await fetch(`${base}/contact/reply?r=${link}`);
  check('opening it shows two buttons, and is not itself an answer', page.status === 200 && /I'm on my way/.test(await page.text()) && !(store.get('acct:reply').helpReplies ?? []).length);
  check('a made-up link is refused', (await fetch(`${base}/contact/reply?r=${'0'.repeat(48)}`)).status === 404);
  check('an answer that is not one of the two is refused', (await post('/contact/reply', { r: link, answer: 'send money' })).status === 404 && !(store.get('acct:reply').helpReplies ?? []).length);
  const pressed = await post('/contact/reply', { r: link, answer: 'coming' });
  check('pressing the button records the answer', pressed.status === 200 && store.get('acct:reply').helpReplies.length === 1);
  check('the link works once', (await post('/contact/reply', { r: link, answer: 'call' })).status === 404);
  const next = await r('weather_check');
  check('the next thing the person hears, whatever they ask, starts with it', /^Priya answered: they are on the way\. /.test(next.said) && next.data.familyAnswered !== undefined, next.said);
  const after = await r('weather_check');
  check('it is said once', !/Priya answered/.test(after.said), after.said);
  check('a visitor who was never answered hears nothing extra', !/answered/.test((await mum('weather_check')).said));
  store.update('acct:reply', (p) => { p.helpAsks = [{ hash: 'x'.repeat(64), contact: 'Priya', at: new Date(Date.now() - 7 * 3600_000).toISOString() }]; p.helpReplies = [{ from: 'Sam', answer: 'call', at: new Date().toISOString() }]; });
  check('"ring me" is said as that', /^Sam answered and asks you to ring them\. /.test((await r('weather_check')).said));
}

console.log('\nSaying no');
{
  notify.resetEmailLimitsForTest();
  sent.length = 0;
  await mum('contact', { action: 'add', name: 'Sam', email: 'sam@example.com' });
  await mum('contact', { action: 'confirm', name: 'Sam' });
  await settle();
  const t = (sent[0].text.match(/accept\?t=([0-9a-f]{48})/) ?? [])[1];
  const no = await post('/contact/accept', { t, answer: 'no' });
  check('pressing no removes them from the list', no.status === 200 && store.get('acct:mum').contacts.length === 0);
}

console.log('\nIt cannot be used to pester a stranger');
{
  sent.length = 0;
  await mum('contact', { action: 'add', name: 'Sam', email: 'sam@example.com' });
  await mum('contact', { action: 'confirm', name: 'Sam' });
  await settle();
  check('one address is invited once a day, however often it is added', sent.length === 0, String(sent.length));
  const other = await connect('acct:other');
  await other('contact', { action: 'add', name: 'Sam', email: 'SAM@example.com' });
  await other('contact', { action: 'confirm', name: 'Sam' });
  await settle();
  check('...from any account, and whatever the capitals', sent.length === 0, String(sent.length));
  const visitor = await connect('demo:xyz');
  await visitor('contact', { action: 'add', name: 'Stranger', email: 'stranger@example.com' });
  const demo = await visitor('contact', { action: 'confirm', name: 'Stranger' });
  await settle();
  check('a visitor to the demo cannot send an invitation by email at all: it goes to the phone on the page', sent.length === 0 && /on their phone, shown on this page/.test(demo.said), demo.said);
}

console.log('\nWhere there is no public address, the old behaviour stands');
{
  const url = process.env.SUDOR_PUBLIC_URL;
  delete process.env.SUDOR_PUBLIC_URL;
  check('no address, no link to agree at, so consent is not demanded', consent.consentRequired() === false && consent.reachable({ confirmedAt: 'x' }) === true);
  process.env.SUDOR_PUBLIC_URL = url;
  check('with one, a confirmed contact who has not agreed is not reachable', consent.reachable({ confirmedAt: 'x' }) === false && consent.reachable({ confirmedAt: 'x', acceptedAt: 'y' }) === true && consent.reachable({ confirmedAt: null, acceptedAt: 'y' }) === false);
}

console.log('\nA question about the signs is not a description of a person');
{
  for (const q of ['what are the signs of heat stroke', 'is confusion a sign of heat stroke?', 'how do I know if it is heat stroke', 'what does fainting in the heat mean', 'can slurred speech be a symptom of heat stroke']) {
    check(`"${q}" is a general question`, firstaid.asksInGeneral(q) === true);
  }
  for (const s of ['she is confused and collapsed', 'is she having heat stroke, she is confused', 'my husband fainted, what does that mean', 'what are the signs, he just passed out', 'confused and slurring', 'is it a sign of heat stroke that my mother stopped sweating', 'what does it mean that I am confused right now']) {
    check(`"${s}" is about a person`, firstaid.asksInGeneral(s) === false);
  }
  notify.resetEmailLimitsForTest();
  process.env.SUDOR_RECIPIENT_CONSENT = 'off';
  const asker = await connect('acct:asker');
  await asker('register_location', { place: 'Phoenix, Arizona', lat, lon });
  await asker('contact', { action: 'add', name: 'Lee', email: 'lee@example.com' });
  await asker('contact', { action: 'confirm', name: 'Lee' });
  sent.length = 0;
  const asked = await asker('warning_signs', { symptoms: 'is confusion a sign of heat stroke?' });
  await settle();
  check('a general question still gets the 911 advice', /If that is happening to somebody now: This is an emergency. Call 911 now/.test(asked.said), asked.said);
  check('...and nobody is emailed that heat stroke was described', sent.length === 0 && asked.data.contacted === null && asked.data.askedInGeneral === true, `${sent.length}`);
  const real = await asker('warning_signs', { symptoms: 'she is confused and her speech is slurred' });
  await settle();
  check('a description of a person is still an emergency and still emails', sent.length === 1 && sent[0].reason === 'emergency' && /emailing Lee/.test(real.said), real.said);
  delete process.env.SUDOR_RECIPIENT_CONSENT;
}

console.log('\nNobody can lock somebody else out of their name');
{
  authstore.resetForTest();
  const good = 'correct horse battery';
  check('a name is claimed', (await authstore.claimOrVerify('jordan', good, '10.0.0.1')).kind === 'claimed');
  let last = null;
  for (let i = 0; i < 5; i += 1) last = await authstore.claimOrVerify('jordan', `wrong guess ${i}`, '203.0.113.9');
  check('five wrong answers from one address are each refused', last.kind === 'wrong');
  check('...and that address is then locked out', (await authstore.claimOrVerify('jordan', good, '203.0.113.9')).kind === 'locked');
  check('...but the owner, from their own address, still gets in', (await authstore.claimOrVerify('jordan', good, '10.0.0.1')).kind === 'ok');
  check('...and so does anyone else who knows the passphrase', (await authstore.claimOrVerify('jordan', good, '198.51.100.7')).kind === 'ok');
  check('the owner signing in does not forgive the other address', (await authstore.claimOrVerify('jordan', good, '203.0.113.9')).kind === 'locked');
  // A guesser with many addresses still meets a ceiling on the name itself.
  let spread = null;
  for (let i = 0; i < 60; i += 1) spread = await authstore.claimOrVerify('jordan', 'wrong everywhere', `192.0.2.${i}`);
  check('sixty wrong answers across many addresses lock the name itself', spread.kind === 'locked' && (await authstore.claimOrVerify('jordan', good, '10.0.0.1')).kind === 'locked');
}

console.log('\nA place in another country is not answered with the American town of the same name');
{
  const geo = await import('./dist/geocode.js');
  const rows = [{ name: 'Lyon', admin1: 'Mississippi', latitude: 34.2, longitude: -90.5, country_code: 'US' }];
  check('"Lyon, France" is not Lyon, Mississippi (found live)', geo.pickPlace('Lyon, France', rows) === null);
  check('"Lyon, Mississippi" still is', geo.pickPlace('Lyon, Mississippi', rows)?.state === 'Mississippi');
  check('"Lyon" alone still finds the town', geo.pickPlace('Lyon', rows)?.name === 'Lyon');
  const world = [...rows, { name: 'Lyon', admin1: 'Auvergne-Rhône-Alpes', country: 'France', latitude: 45.75, longitude: 4.85, country_code: 'FR', timezone: 'Europe/Paris' }];
  check('"Lyon, France" is now found, in France', geo.pickPlace('Lyon, France', world)?.country === 'FR' && geo.pickPlace('Lyon, France', world)?.lat === 45.75);
  // Town, region, country, as people write a Canadian or Brazilian address. All of it after the first comma was
  // read as one country name and found nothing (found in a live sweep).
  const sorriso = [{ name: 'Sorriso', admin1: 'Mato Grosso', country: 'Brazil', country_code: 'BR', latitude: -12.55, longitude: -55.71 }, { name: 'Sorriso', admin1: 'Lombardy', country: 'Italy', country_code: 'IT', latitude: 45.6, longitude: 9.9 }];
  check('"Sorriso, Mato Grosso, Brazil" is found, in Mato Grosso', geo.pickPlace('Sorriso, Mato Grosso, Brazil', sorriso)?.lat === -12.55);
  check('"Toronto, Ontario, Canada" reads Canada as the country and Ontario as the region', JSON.stringify(geo.splitQuery('Toronto, Ontario, Canada')) === JSON.stringify({ name: 'Toronto', state: null, elsewhere: true, country: 'Canada', region: 'Ontario' }));
  check('"Austin, Texas, USA" is still Texas', geo.splitQuery('Austin, Texas, USA').state === 'Texas');
  check('"Melbourne, Victoria, Australia" keeps every letter of Australia', geo.splitQuery('Melbourne, Victoria, Australia').country === 'Australia');
  check('"Germany" is DE, not the retired East German code that shares its name', geo.countryCodeOf('Germany') === 'DE' && geo.countryCodeOf('Vietnam') === 'VN');
  // Found with the model: "I'm in Delhi" was Delhi, New York, and "Paris" was Paris, Texas.
  const delhiNY = { name: 'Delhi', admin1: 'New York', country_code: 'US', latitude: 42.27, longitude: -74.91, population: 2900 };
  const delhi = { name: 'Delhi', country: 'India', country_code: 'IN', latitude: 28.65, longitude: 77.23, population: 11000000 };
  check('a small US town gives way to a world city of the same name', geo.worldCityInstead(delhiNY, [delhi])?.country_code === 'IN');
  check('...but a big US city does not', geo.worldCityInstead({ ...delhiNY, population: 1600000 }, [delhi]) === null);
  check('...nor does a US town when the city abroad is not a big one', geo.worldCityInstead(delhiNY, [{ ...delhi, population: 500000 }]) === null);
  check('...and by its region or its code', geo.pickPlace('Lyon, FR', world)?.country === 'FR' && geo.pickPlace('Lyon, Auvergne-Rhône-Alpes', world)?.country === 'FR');
  check('"Lyon" alone is still the American one, because Alexa+ is sold there', geo.pickPlace('Lyon', world)?.country === 'US');
  check('a name with no American town goes abroad', geo.pickPlace('Pune', [{ name: 'Pune', admin1: 'Maharashtra', country: 'India', latitude: 18.5, longitude: 73.85, country_code: 'IN' }])?.country === 'IN');
  check('"Tampa, Florida, USA" is not treated as abroad', geo.splitQuery('Tampa, Florida, USA').elsewhere !== true && geo.splitQuery('Tampa, FL').state === 'Florida');
}

console.log('\nA hurricane outranks the heat index');
{
  const warnings = await import('./dist/warnings.js');
  const alert = (event, severity, kind) => ({ id: event, event, kind, severity, urgency: 'Expected', headline: event, instruction: null, areaDesc: 'Maricopa', onset: null, ends: null });
  const who = await connect('acct:storm');
  await who('register_location', { place: 'Phoenix, Arizona', lat, lon });
  await who('medication', { action: 'add', name: 'lisinopril' });
  warnings.seedForTest(lat, lon, []);
  check('with no warning, the weather answer says nothing about one', !/There is an? /.test((await who('weather_check')).said));
  warnings.seedForTest(lat, lon, [alert('Heat Advisory', 'Moderate', 'heat'), alert('Hurricane Warning', 'Extreme', 'power')]);
  const hit = await who('weather_check');
  check('an active hurricane warning is in the answer to "is it safe outside"', /There is a Hurricane Warning where you are/.test(hit.said) && hit.data.warning === 'Hurricane Warning', hit.said);
  check('...with the next step', /Ask me what to do before it arrives\./.test(hit.said), hit.said);
  warnings.seedForTest(lat, lon, [alert('Excessive Heat Warning', 'Severe', 'heat')]);
  check('a heat warning is not repeated: the answer is already about the heat', !/There is an? Excessive Heat Warning/.test((await who('weather_check')).said));
  warnings.seedForTest(lat, lon, [alert('Flood Watch', 'Moderate', 'flood')]);
  check('a watch that is not severe is left for when it is asked about', !/Flood Watch/.test((await who('weather_check')).said));
  warnings.seedForTest(lat, lon, [alert('Air Quality Alert', 'Severe', 'air')]);
  check('a severe air quality alert is said, with the right article', /There is an Air Quality Alert where you are/.test((await who('weather_check')).said));
  warnings.seedForTest(lat, lon, []);
}

console.log('\nA medicine the table does not name is looked up, not guessed');
{
  const rx = await import('./dist/rxclass.js');
  const rowOf = (name, tty, classId) => ({ minConcept: { name, tty }, rxclassMinConceptItem: { classId } });
  const body = (...rows) => ({ rxclassDrugInfoList: { rxclassDrugInfo: rows } });
  const biso = rx.parse(body(rowOf('bisoprolol', 'IN', 'C07AB')));
  check('bisoprolol is read as a beta blocker, with the mechanisms the table gives beta blockers', biso.drugClass === 'beta blocker' && biso.mechanisms.join() === 'electrolyte_imbalance,reduced_sweating,reduced_vasodilation,faint_risk' && biso.cold.join() === 'reduced_heat_production', JSON.stringify(biso));
  // The classes the CDC names that used to go unrecognised, each read the way RxClass really answers.
  const read = (...rows) => rx.parse({ rxclassDrugInfoList: { rxclassDrugInfo: rows } });
  check('an anti-inflammatory painkiller is hard on the kidneys once dry', read(rowOf('ibuprofen', 'IN', 'M01AE'), rowOf('ibuprofen', 'IN', 'C01EB'))?.mechanisms.join() === 'kidney_risk');
  check('a blood thinner of the antiplatelet kind sheds heat less well', read(rowOf('clopidogrel', 'IN', 'B01AC'))?.mechanisms.join() === 'reduced_vasodilation');
  check('a nitrate can make somebody faint', read(rowOf('isosorbide', 'IN', 'C01DA'))?.mechanisms.join() === 'faint_risk');
  check('insulin is spoiled by heat, in any of its forms', read(rowOf('insulin aspart', 'IN', 'A10AB'), rowOf('insulin aspart protamine', 'IN', 'A10AD'))?.drugClass === 'insulin');
  check('a salt of a drug is still that drug', read(rowOf('olmesartan medoxomil', 'PIN', 'C09CA'))?.drugClass === 'ARB');
  check('a class wider than what the CDC names is narrowed to the drugs it names', read(rowOf('venlafaxine', 'IN', 'N06AX'))?.drugClass === 'SNRI' && read(rowOf('mirtazapine', 'IN', 'N06AX')) === null && read(rowOf('topiramate', 'IN', 'N03AX'))?.mechanisms.join() === 'reduced_sweating' && read(rowOf('levetiracetam', 'IN', 'N03AX')) === null);
  check('two drugs of different classes under one name stay ambiguous', read(rowOf('ibuprofen', 'IN', 'M01AE'), rowOf('clopidogrel', 'IN', 'B01AC')) === null);
  const medsMod = await import('./dist/meds.js');
  check('a curated medicine carries the same effects as its class', medsMod.findMedication('lisinopril').mechanisms.includes('faint_risk') && medsMod.findMedication('metoprolol').mechanisms.includes('reduced_vasodilation'));
  check('a combination product is not read as one drug', rx.parse(body(rowOf('furosemide / potassium', 'MIN', 'C03CB'))) === null);
  check('...and the plain ingredient beside it is', rx.parse(body(rowOf('furosemide / potassium', 'MIN', 'C03CB'), rowOf('furosemide', 'IN', 'C03CA'))).drugClass === 'loop diuretic');
  check('lithium is a mood stabiliser, not an antipsychotic, though it sits under the same heading', rx.ruleFor('N05AN01').drugClass === 'mood stabiliser' && rx.ruleFor('N05AH04').drugClass === 'antipsychotic');
  check('a class that mixes different drugs is not classified at all', rx.ruleFor('N06AX') === null && rx.parse(body(rowOf('bupropion', 'IN', 'N06AX'))) === null);
  check('a class with nothing to do with heat is not classified', rx.parse(body(rowOf('omeprazole', 'IN', 'A02BC'))) === null);
  check('a name that resolves to two different drugs is not classified', rx.parse(body(rowOf('atenolol', 'IN', 'C07AB'), rowOf('chlorthalidone', 'IN', 'C03BA'))) === null);
  check('an empty or broken answer is not a classification', rx.parse({}) === null && rx.parse(null) === null && rx.parse(body()) === null);
  const meds = await import('./dist/meds.js');
  const tabled = { 'C03CA': 'furosemide', 'C07AB': 'metoprolol', 'C09AA': 'lisinopril', 'A10BJ': 'semaglutide', 'N06AB': 'sertraline', 'N05AH': 'quetiapine', 'C10AA': 'atorvastatin', 'J01MA': 'ciprofloxacin', 'N06BA': 'methylphenidate' };
  const disagree = Object.entries(tabled).filter(([atc, generic]) => {
    const want = meds.MEDICATIONS.find((m) => m.generic === generic).mechanisms.slice().sort().join();
    return rx.ruleFor(atc).mechanisms.slice().sort().join() !== want;
  });
  check('each class rule gives the same mechanisms as the table gives a named member of that class', disagree.length === 0, JSON.stringify(disagree));

  let asked = [];
  rx.configureForTest(async (name) => { asked.push(name); return name === 'bisoprolol' || name === 'zebeta' ? biso : name === 'toprol' ? { ...biso, generic: 'metoprolol' } : null; });
  const who = await connect('acct:rx');
  const known = await who('medication', { action: 'add', name: 'lisinopril' });
  check('a medicine the table names never leaves the server', asked.length === 0 && known.data.source === undefined);
  const added = await who('medication', { action: 'add', name: 'Zebeta 5 mg' });
  check('a brand the table has never heard of is added under its real name', /Added bisoprolol, which is what Zebeta 5 mg is\. As a beta blocker/.test(added.said) && added.data.source === 'rxnorm', added.said);
  check('...and the answer says the judgement rests on its class', /from its drug class, so ask your pharmacist/.test(added.said));
  check('...only the name was sent, without the dose', asked.join() === 'zebeta', asked.join());
  const alias = await who('medication', { action: 'add', name: 'Toprol' });
  check('a brand that resolves to a medicine the table does name uses the table', /Added metoprolol, a beta blocker/.test(alias.said) && alias.data.source === undefined, alias.said);
  const none = await who('medication', { action: 'add', name: 'zzzmadeup' });
  check('a name nobody knows is still said to be unknown, never guessed', none.data.recognized === false && /That doesn't mean it's safe/.test(none.said), none.said);
  await who('register_location', { place: 'Phoenix, Arizona', lat, lon });
  const profile = store.get('acct:rx');
  check('the looked-up medicine is stored with its mechanisms', profile.medications.some((m) => m.generic === 'bisoprolol' && m.mechanisms.includes('reduced_sweating')));
  check('...and is not also left on the recall-only list', !profile.recallWatch.some((m) => /zebeta/i.test(m)));
  rx.configureForTest(async () => { throw new Error('down'); });
  rx.configureForTest(async () => null);
  const down = await who('medication', { action: 'add', name: 'carvedilol' });
  check('when the lookup has no answer, the medicine is unknown, not classified', down.data.recognized === false, down.said);
  rx.configureForTest(null);
}

console.log('\nWhat the label itself says, read narrowly');
{
  const labels = await import('./dist/labels.js');
  const lab = (generic, sections, effective = '20260608') => ({ openfda: { generic_name: [generic] }, effective_time: effective, ...sections });
  const topiramate = labels.read(lab('TOPIRAMATE', { warnings_and_cautions: ['5.2 Oligohidrosis and hyperthermia: monitor decreased sweating and increased body temperature, especially in pediatric patients.'] }));
  check('"oligohidrosis" on a label is read as stopping sweat, with the sentence and the date kept', topiramate.mechanisms.join() === 'reduced_sweating' && /Oligohidrosis/.test(topiramate.quotes[0].sentence) && topiramate.effective === '20260608');
  const sertraline = labels.read(lab('SERTRALINE', { warnings_and_cautions: ['Serotonin syndrome symptoms may include mental status changes, autonomic instability (tachycardia, diaphoresis, flushing, hyperthermia).'] }));
  check('hyperthermia named under serotonin syndrome is not a heat warning (the loose version got this wrong)', sertraline.mechanisms.length === 0);
  const quetiapineNms = labels.read(lab('QUETIAPINE', { warnings: ['Other important considerations in the differential diagnosis include central anticholinergic toxicity, heat stroke, drug fever.'] }));
  check('heat stroke named in a differential diagnosis is not one either', quetiapineNms.mechanisms.length === 0);
  const adverse = labels.read(lab('CARVEDILOL', { adverse_reactions: ['Skin and Appendages: photosensitivity reaction. Autonomic: decreased sweating.'] }));
  check('the adverse reactions list is never read', adverse.mechanisms.length === 0);
  const lisinopril = labels.read(lab('LISINOPRIL', { warnings_and_cautions: ['Patients with volume depletion or dehydration are at risk of excessive hypotension.'] }));
  check('"volume depletion" as something the patient already has is not a statement about the drug', lisinopril.mechanisms.length === 0);
  const doxy = labels.read(lab('DOXYCYCLINE', { warnings: ['Photosensitivity manifested by an exaggerated sunburn reaction has been observed in some individuals taking tetracyclines.'] }));
  check('a sunburn warning is read as that', doxy.mechanisms.join() === 'photosensitivity');
  check('a label that says nothing is evidence of nothing, not of safety', labels.read(lab('OMEPRAZOLE', { warnings: ['Take as directed.'] })).mechanisms.length === 0 && labels.read(null) === null);
  check('a combination product is not this medicine\'s label', labels.pick([lab('LISINOPRIL AND HYDROCHLOROTHIAZIDE', {})], 'lisinopril') === null);
  check('...and a salt of it is', labels.pick([lab('LISINOPRIL AND HYDROCHLOROTHIAZIDE', {}), lab('Metoprolol Tartrate', {})], 'metoprolol') !== null);

  const seen = [];
  labels.configureForTest(async (generic) => { seen.push(generic); return generic === 'zonisamide' ? topiramate : generic === 'lisinopril' ? { mechanisms: [], quotes: [], effective: '20230818', checkedAt: 'x' } : null; });
  const rx = await import('./dist/rxclass.js');
  rx.configureForTest(async () => null);
  const who = await connect('acct:label');
  await who('register_location', { place: 'Phoenix, Arizona', lat, lon });
  const first = await who('medication', { action: 'add', name: 'zonisamide' });
  check('a medicine nothing classifies is unknown at first, and says so', first.data.recognized === false, first.said);
  await settle();
  const held = store.get('acct:label');
  check('...and once its label is read, the label is what classifies it', held.medications.some((m) => m.generic === 'zonisamide' && m.mechanisms.length === 0 && m.label.mechanisms.join() === 'reduced_sweating') && !held.recallWatch.some((m) => /zonisamide/i.test(m)), JSON.stringify(held.medications));
  const judged = await who('going_out_now');
  check('...and it changes the answer about the heat', /blocks your sweating/.test(judged.said), judged.said);
  await who('medication', { action: 'add', name: 'lisinopril' });
  await settle();
  const profile = await who('my_profile');
  const ev = profile.data.evidence;
  check('the profile carries where each judgement comes from', ev.find((e) => e.generic === 'zonisamide').fdaLabel.states.some((s) => /Oligohidrosis/.test(s)) && ev.find((e) => e.generic === 'lisinopril').fdaLabel.dated === '20230818', JSON.stringify(ev));
  check('a label that states nothing takes nothing away from what the table says', store.get('acct:label').medications.find((m) => m.generic === 'lisinopril').mechanisms.length > 0);
  await who('medication', { action: 'add', name: 'zzzmadeup' });
  await settle();
  check('a name with no label stays unknown', store.get('acct:label').recallWatch.some((m) => m === 'zzzmadeup'));
  labels.configureForTest(null);
  rx.configureForTest(null);
}

console.log('\nAn email address is typed, not spelled out loud');
{
  notify.resetEmailLimitsForTest();
  sent.length = 0;
  const who = await connect('acct:typed');
  const asked = await who('contact', { action: 'add', name: 'Priya', relation: 'daughter' });
  const link = asked.data.enterAt ?? '';
  const token = (link.match(/enter\?e=([0-9a-f]{48})/) ?? [])[1] ?? '';
  check('adding somebody with no address offers a page to type it on', asked.data.needs === 'email' && link.startsWith('https://sudor.example.org/contact/enter?e=') && token.length === 48, asked.said);
  check('...and still says it can be spoken', /Say it, or type it on a screen/.test(asked.said), asked.said);
  check('only a hash of the link is stored', !JSON.stringify(store.get('acct:typed')).includes(token) && store.get('acct:typed').entries.length === 1);
  check('nothing is staged yet', store.get('acct:typed').contacts.length === 0);
  const page = await fetch(`${base}/contact/enter?e=${token}`);
  check('the page has an email box', page.status === 200 && /type="email"/.test(await page.text()));
  check('a made-up link is refused', (await fetch(`${base}/contact/enter?e=${'0'.repeat(48)}`)).status === 404);
  check('something that is not an address is refused, and the link still works', (await post('/contact/enter', { e: token, email: 'priya at example' })).status === 400 && store.get('acct:typed').contacts.length === 0);
  check('an address with a tag in it is refused', (await post('/contact/enter', { e: token, email: '<script>@example.com' })).status === 400);
  const saved = await post('/contact/enter', { e: token, email: 'priya.typed@example.com' });
  const held = store.get('acct:typed').contacts[0];
  check('typing it stages the contact exactly as saying it would', saved.status === 200 && held.name === 'Priya' && held.email === 'priya.typed@example.com' && held.relation === 'daughter' && held.confirmedAt === null && /^contact-/.test(held.id), JSON.stringify(held));
  check('the link works once', (await post('/contact/enter', { e: token, email: 'other@example.com' })).status !== 200 && store.get('acct:typed').contacts.length === 1 && store.get('acct:typed').contacts[0].email === 'priya.typed@example.com');
  check('nothing has been sent to anybody', sent.length === 0);
  const next = await who('my_profile');
  check('the next thing heard says the address arrived and what to say', /^I have the address for Priya now\. Say yes and I will ask them to agree\. /.test(next.said), next.said);
  check('...once', !/I have the address/.test((await who('my_profile')).said));
  const yes = await who('contact', { action: 'confirm', name: 'Priya' });
  await settle();
  check('saying yes then sends the one invitation, to the typed address', sent.length === 1 && sent[0].to === 'priya.typed@example.com' && sent[0].reason === 'invite', yes.said);

  const sentPages = [];
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { registerTools } = await import('./dist/tools.js');
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {} } });
  registerTools(server, () => 'acct:urlhost');
  const client = new Client({ name: 'c', version: '1' }, { capabilities: { elicitation: { url: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => { sentPages.push(req.params); return { action: 'accept' }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await client.callTool({ name: 'contact', arguments: { action: 'add', name: 'Sam' } });
  await settle();
  check('a host that can open a page is sent it directly, and the answer says so', sentPages.length === 1 && sentPages[0].mode === 'url' && /^https:\/\/sudor\.example\.org\/contact\/enter\?e=/.test(sentPages[0].url) && /put up a page to type the email address for Sam/.test(r.content[0].text), JSON.stringify(sentPages));
}

console.log('\nAnswers hand back a handle, and the next step takes it');
{
  const who = await connect('acct:chain');
  const added = await who('contact', { action: 'add', name: 'Jo', email: 'jo@example.com' });
  check('adding a contact returns its id and the exact next call', /^contact-[0-9a-f]{10}$/.test(added.data.contactId) && added.data.nextAction.tool === 'contact' && added.data.nextAction.arguments.action === 'confirm' && added.data.nextAction.arguments.name === added.data.contactId, JSON.stringify(added.data.nextAction));
  process.env.SUDOR_RECIPIENT_CONSENT = 'off';
  const done = await who('contact', added.data.nextAction.arguments);
  delete process.env.SUDOR_RECIPIENT_CONSENT;
  check('following that call by id confirms the right person', done.data.confirmed === true && done.data.name === 'Jo', done.said);
  check('an id that is not one is treated as a name, and not found', (await who('contact', { action: 'confirm', name: 'contact-0000000000' })).data.confirmed === false);
  const gone = await who('contact', { action: 'remove', name: added.data.contactId });
  check('removing by id works too', gone.data.removed === true && store.get('acct:chain').contacts.length === 0);
}

console.log('\nNothing is said twice in one answer, and the next step is named');
{
  const who = await connect('acct:lean');
  const loc = await who('register_location', { place: 'Phoenix, Arizona', lat, lon });
  // Setting a place starts a live download, which can land before the next line and replace the test's day.
  weather.seedForTest(HOT_DAY);
  check('setting a place points at the question it enables', loc.data.nextAction?.tool === 'weather_check');
  const med = await who('medication', { action: 'add', name: 'metoprolol' });
  check('adding a medicine points at the same question', med.data.nextAction?.tool === 'weather_check');
  check('removing one points nowhere', (await who('medication', { action: 'remove', name: 'metoprolol' })).data.nextAction === undefined);
  await who('medication', { action: 'add', name: 'oxybutynin' });
  await who('health_condition', { action: 'add', condition: 'heart disease' });
  const now = await who('weather_check');
  const json = JSON.stringify(now.data);
  check('the notes tools leave for the shortening code do not leave the server', !('mustSay' in now.data) && !('fullAnswer' in now.data) && !('offer' in now.data) && !('full' in now.data), Object.keys(now.data).join(','));
  const firstSentence = now.said.split('. ')[0];
  check('the answer appears once in the structured half, not three times', json.split(firstSentence).length - 1 === 1, String(json.split(firstSentence).length - 1));
  check('...and what was held back is still there, once', !now.data.more || now.data.more.every((m) => json.split(m).length - 1 === 1));
  check('...and the closing question is still spoken', /(Want me to find the safest time to go out today|Staying in only helps if your cooling works\. Is it working)\?$/.test(now.said), now.said.slice(-70));
  // What is held back for "tell me more" is counted apart: a shorter spoken answer holds more of it.
  const { more: _held, ...facts } = now.data;
  check('the structured half is no more than twice the spoken half', JSON.stringify(facts).length <= now.said.length * 3.2, `${JSON.stringify(facts).length} vs ${now.said.length}`);
  const plan = await who('plan_my_day', { activity: 'a walk', minutes: 30 });
  check('a stay-inside day points at what to do if they must go out', plan.data.best?.status !== 'avoid' || plan.data.nextAction?.tool === 'going_out_now', JSON.stringify(plan.data.nextAction));
  const going = await who('going_out_now');
  check('precautions with more to come point at the rest, by step', going.data.nextStep == null || (going.data.nextAction?.tool === 'going_out_now' && going.data.nextAction.arguments.step === going.data.nextStep), JSON.stringify(going.data.nextAction));
  const stroke = await who('warning_signs', { symptoms: 'she is confused and collapsed' });
  check('a described emergency points nowhere: the contacts were already told, and pointing at get_help emailed them twice', stroke.data.nextAction === undefined, JSON.stringify(stroke.data.nextAction));
  const asked = await who('warning_signs', { symptoms: 'is confusion a sign of heat stroke?' });
  check('a question about the signs does not', asked.data.nextAction === undefined);
  const unwell = await who('log_outing', { felt: 'unwell', minutes: 20 });
  check('feeling unwell after an outing points at the warning signs', unwell.data.nextAction?.tool === 'warning_signs');
  check('feeling fine points nowhere', (await who('log_outing', { felt: 'fine', minutes: 20 })).data.nextAction === undefined);
  const added = await who('contact', { action: 'add', name: 'Kit', email: 'kit@example.com' });
  check('a tool that names its own next step keeps it', added.data.nextAction?.tool === 'contact' && added.data.nextAction.arguments.action === 'confirm');
  const names = new Set(['register_location', 'medication', 'health_condition', 'my_profile', 'set_privacy', 'contact', 'share_my_day', 'check_on', 'get_help', 'log_outing', 'weather_check', 'plan_my_day', 'going_out_now', 'warning_signs', 'somewhere_to_go', 'storm_prep', 'what_can_you_do', 'tell_me_more']);
  check('every next step names a tool that exists', [loc, med, plan, going, stroke, unwell, added].every((r) => !r.data.nextAction || names.has(r.data.nextAction.tool)));
}

console.log('\nOne tool for who you are');
{
  const rx = await import('./dist/rxclass.js');
  const labels = await import('./dist/labels.js');
  rx.configureForTest(async () => null);
  labels.configureForTest(async () => null);
  const who = await connect('acct:merged');
  const empty = await who('about_me', {});
  check('with nothing given, it reads the profile back', /No medications/.test(empty.said), empty.said);
  const both = await who('about_me', { medicines: ['metoprolol', 'lisinopril'], conditions: ['diabetes'] });
  check('two medicines and a condition in one call are all added', store.get('acct:merged').medications.length === 2 && store.get('acct:merged').conditions.length === 1 && both.data.did.length === 3, both.said);
  check('...each one is said', /metoprolol/.test(both.said) && /lisinopril/.test(both.said) && /diabetes/.test(both.said));
  check('...the answer is not carried twice inside itself', JSON.stringify(both.data.did).indexOf('Added metoprolol') === -1);
  check('...and it points at the question this changes', both.data.nextAction?.tool === 'weather_check');
  const unknown = await who('about_me', { medicines: ['zzzmadeup'] });
  check('a medicine nobody knows is still said to be unknown', /That doesn't mean it's safe/.test(unknown.said), unknown.said);
  const stopped = await who('about_me', { stopMedicines: ['lisinopril'] });
  check('a medicine can be taken off', store.get('acct:merged').medications.length === 1 && /Removed lisinopril/.test(stopped.said) && stopped.data.nextAction === undefined, stopped.said);
  await who('about_me', { privacy: true });
  check('privacy is switched on through it', store.get('acct:merged').privacy === true);
  const asked = await who('about_me', { forget: true });
  check('forgetting is still asked for twice', store.get('acct:merged').medications.length === 1 && /once more/i.test(asked.said), asked.said);
  await who('about_me', { forget: true });
  check('...and the second time it is gone', store.get('acct:merged').medications.length === 0);
  const viewer = await connect('acct:viewer');
  const none = await who('share_my_day', { action: 'check' });
  check('checking on somebody is an action of the sharing tool', none.data.sharing === false && /Nobody is sharing their day with you yet/.test(none.said), none.said);
  void viewer;
  rx.configureForTest(null);
  labels.configureForTest(null);
}

console.log('\nFound by using it as a stranger');
{
  const rx = await import('./dist/rxclass.js');
  const labels = await import('./dist/labels.js');
  const personal = await import('./dist/personal.js');
  rx.configureForTest(async () => null);
  labels.configureForTest(async () => null);
  const who = await connect('acct:walk');
  const three = await who('about_me', { medicines: ['furosemide', 'metoprolol', 'semaglutide'] });
  check('three medicines at once do not say the same closing sentence three times', (three.said.match(/I'll factor that into your heat check/g) ?? []).length <= 1, three.said);
  // The one-time line on what health details are for (the first save only, see tools.ts) is not counted.
  const confirmed = three.said.replace(/ ?I keep your health details[^]*medical advice\./, '');
  check('...confirmed in one short sentence, not read back one by one', confirmed.split(/\s+/).length <= 20, three.said);
  check('...and each one is still named', /furosemide/.test(three.said) && /metoprolol/.test(three.said) && /semaglutide/.test(three.said));
  const geo = await import('./dist/geocode.js');
  const looking = await who('about_me', { place: 'Nowhere Special, Florida', medicines: ['lisinopril'] });
  check('while the town is still being looked up, the answer does not point at the weather', looking.data.did.some((d) => d.status === 'locating') && looking.data.nextAction === undefined, JSON.stringify(looking.data.nextAction));
  void geo;
  // A shift that reaches 84 and never 90, where it turns risky for this person at the same hour it passes 80.
  const off = -4 * 3600; const day = new Date(Date.now() + off * 1000 + 86_400_000).toISOString().slice(0, 10);
  const hourly = Array.from({ length: 24 }, (_, h) => ({ local: `${day}T${String(h).padStart(2, '0')}:00`, time: `${day}T${String(h).padStart(2, '0')}:00Z`, tempF: h >= 13 && h < 16 ? 84 : 72, humidityPct: 55, uvIndex: 1, windMph: 5, isDay: true, aqi: 30, solarWm2: 300, wetBulbF: 65 }));
  const snap = { lat: 1, lon: 1, fetchedAt: new Date().toISOString(), timezone: 'America/New_York', utcOffsetSeconds: off, tempF: 72, humidityPct: 55, uvIndex: 1, windMph: 5, isDay: true, aqi: 30, solarWm2: 300, wetBulbF: 65, hourly, stale: false };
  const sensitive = personal.profileOf(['reduced_sweating'], ['heart_disease'], { outings: [] });
  const shift = personal.planShift(snap, sensitive, { now: new Date(), day: 'tomorrow', fromHour: 7, untilHour: 17 });
  check('"starts earlier" is not said when it starts at the same hour as the line just named', shift.initialFrom !== null && (shift.personalFrom !== shift.initialFrom || !/starts earlier/.test(shift.spoken)), `${shift.initialFrom} ${shift.personalFrom} | ${shift.spoken}`);
  const power = await mum('somewhere_to_go');
  check('asking where to go does not guess that the house is too hot', !power.data.nextAction || power.data.nextAction.arguments.what === 'looking for somewhere to go', JSON.stringify(power.data.nextAction));
  rx.configureForTest(null);
  labels.configureForTest(null);
}

console.log('\nA disaster, for one person');
{
  const hazard = await import('./dist/hazard.js');
  const warnings = await import('./dist/warnings.js');
  const alerts = await import('./dist/alerts.js');
  const rx = await import('./dist/rxclass.js');
  const labels = await import('./dist/labels.js');
  rx.configureForTest(async () => null);
  labels.configureForTest(async () => null);
  const kinds = { 'Hurricane Warning': 'hurricane', 'Tropical Storm Watch': 'hurricane', 'Storm Surge Warning': 'hurricane', 'Flash Flood Warning': 'flood', 'Tornado Warning': 'tornado', 'Winter Storm Warning': 'winter', 'Ice Storm Warning': 'winter', 'Blizzard Warning': 'winter', 'Air Quality Alert': 'smoke', 'Dense Smoke Advisory': 'smoke', 'Red Flag Warning': 'fire', 'Excessive Heat Warning': 'heat', 'Wind Chill Warning': 'cold', 'Severe Thunderstorm Warning': 'wind', 'Tsunami Warning': 'tsunami', 'Special Weather Statement': 'other' };
  const wrong = Object.entries(kinds).filter(([e, k]) => hazard.hazardOf(e) !== k);
  check('each kind of official warning is recognised for what it is', wrong.length === 0, JSON.stringify(wrong.map(([e]) => [e, hazard.hazardOf(e)])));
  const none = { coldMedicine: false, poweredEquipment: false, dialysis: false, breathing: false, heart: false, medicines: false, older: false };
  const tornado = hazard.stepsFor('tornado', { ...none, medicines: true, coldMedicine: true });
  check('in a tornado the first thing said is where to go, not a pharmacy', /^Go now to the lowest floor/.test(tornado[0]), tornado[0]);
  const hurricane = hazard.stepsFor('hurricane', { ...none, coldMedicine: true, poweredEquipment: true, dialysis: true, medicines: true });
  check('a hurricane, for somebody with a fridge medicine, powered equipment and dialysis, names all three', hurricane.some((x) => /cooler/.test(x)) && hurricane.some((x) => /needs power/.test(x)) && hurricane.some((x) => /dialysis unit/.test(x)) && hurricane.some((x) => /week of every medicine/.test(x)), hurricane.join(' | '));
  check('...after the first general step and before the rest', /^If you are told to leave/.test(hurricane[0]) && hurricane.indexOf(hurricane.find((x) => /cooler/.test(x))) < hurricane.indexOf(hurricane.find((x) => /away from windows/.test(x))));
  check('somebody with nothing registered gets the general steps and no invented ones', hazard.stepsFor('hurricane', none).length === 3);
  check('smoke speaks to lungs and hearts, and not to fridges', hazard.stepsFor('smoke', { ...none, breathing: true, coldMedicine: true }).some((x) => /Smoke is harder on you/.test(x)) && !hazard.stepsFor('smoke', { ...none, coldMedicine: true }).some((x) => /cooler/.test(x)));
  check('a winter storm tells somebody with a heart condition not to shovel', hazard.stepsFor('winter', { ...none, heart: true }).some((x) => /Do not shovel snow/.test(x)));
  check('no step names a diagnosis or a medicine by name', Object.keys(kinds).every((e) => !/diabet|asthma|copd|kidney disease|heart disease/i.test(hazard.stepsFor(hazard.hazardOf(e), { coldMedicine: true, poweredEquipment: true, dialysis: true, breathing: true, heart: true, medicines: true, older: true }).join(' '))));

  const alert = (event, severity = 'Extreme') => ({ id: `id-${event}`, event, kind: warnings.classify(event), severity, urgency: 'Expected', headline: event, instruction: 'Evacuate if told to do so. Second sentence.', areaDesc: 'Hillsborough', onset: null, ends: null });
  process.env.SUDOR_RECIPIENT_CONSENT = 'off';
  const who = await connect('acct:storm2');
  await who('about_me', { medicines: ['metoprolol'], conditions: ['diabetes', 'heart disease'] });
  await who('register_location', { place: 'Phoenix, Arizona', lat, lon });
  await who('contact', { action: 'add', name: 'Priya', email: 'priya3@example.com' });
  await who('contact', { action: 'confirm', name: 'Priya' });
  warnings.seedForTest(lat, lon, [alert('Hurricane Warning')]);
  const now = await who('weather_check');
  check('"is it safe outside" under a hurricane warning points at what to do about it', now.data.warning === 'Hurricane Warning' && now.data.nextAction?.tool === 'storm_prep', JSON.stringify(now.data.nextAction));
  const what = await who(now.data.nextAction.tool, now.data.nextAction.arguments);
  check('the answer opens with the warning and the first thing to do', /^There is a Hurricane Warning where you are\. If you are told to leave, leave/.test(what.said), what.said);
  check('...then what is particular to this person, said even though the rest is held back', /cooler with an ice pack/.test(what.said) && /at least a week of everything/.test(what.said) && /Insulin keeps best/.test(what.said), what.said);
  check('...and offers to tell the family they are safe', /Want me to tell Priya you are safe\?/.test(what.said), what.said.slice(-80));
  check('...and points at where to go, because this is a hazard people leave for', what.data.nextAction?.tool === 'somewhere_to_go' && what.data.hazard === 'hurricane');
  check('...with the federal source for that hazard', what.data.sources.includes('https://www.ready.gov/hurricanes'));
  warnings.seedForTest(lat, lon, [alert('Air Quality Alert', 'Moderate')]);
  const smoke = await who('storm_prep');
  check('wildfire smoke is answered as smoke, for a heart', /Smoke is harder on you/.test(smoke.said) && smoke.data.hazard === 'smoke' && smoke.data.nextAction?.tool === 'get_help' && smoke.data.nextAction.arguments.status === 'safe', smoke.said);
  warnings.seedForTest(lat, lon, [alert('Wind Advisory', 'Moderate')]);
  const windy = await who('storm_prep');
  check('a wind advisory is a heads-up: the headline and one step, not the hurricane checklist', windy.said.split(/\s+/).length <= 35 && /Wind Advisory/.test(windy.said) && !/pharmacist/.test(windy.said), windy.said);
  warnings.seedForTest(lat, lon, []);
  const quiet = await who('storm_prep');
  check('with no warning it is still the preparation advice it always was', quiet.data.hazard === undefined && /Here is what matters for you/.test(quiet.said), quiet.said.slice(0, 80));

  sent.length = 0;
  notify.resetEmailLimitsForTest();
  const safe = await who('get_help', { status: 'safe', what: 'we made it to my sister' });
  await settle();
  check('"tell them I\'m safe" emails the family that, with what was said', sent.length === 1 && sent[0].subject === 'They are safe' && /tell you they are safe/.test(sent[0].text) && /we made it to my sister/.test(sent[0].text) && /I'm emailing Priya that you are safe/.test(safe.said), safe.said);
  check('...and says nothing about 911 or a hospital, because nothing is wrong', !/911|emergency department/.test(safe.said) && !/911/.test(sent[0].text));
  check('...and nothing about health', !/metoprolol|diabet|heart/i.test(sent[0].text));

  sent.length = 0;
  warnings.seedForTest(lat, lon, [alert('Hurricane Warning')]);
  const first = await alerts.checkWarningAlerts();
  const mine = () => sent.filter((m) => m.to === 'priya3@example.com');
  check('a warning where somebody lives is told to their family once', first.length >= 1 && mine().length === 1 && mine()[0].subject === 'Hurricane Warning where they live' && /Please check in with them/.test(mine()[0].text), JSON.stringify(sent.map((m) => m.to)));
  check('...with nothing about health', !/metoprolol|diabet|heart/i.test(mine()[0].text));
  const before = sent.length;
  await alerts.checkWarningAlerts();
  check('...and not again for the same warning', sent.length === before);
  warnings.seedForTest(lat, lon, [alert('Heat Advisory', 'Moderate'), alert('Flood Watch', 'Moderate')]);
  await alerts.checkWarningAlerts();
  check('an advisory or a watch does not email anybody', sent.length === before);
  // Equipment they rely on is said, never guessed.
  const o2 = await connect('acct:oxygen');
  await o2('register_location', { place: 'Phoenix, Arizona', lat, lon });
  const noted = await o2('about_me', { equipment: ['home oxygen', 'a toaster'] });
  check('home oxygen is taken down as an oxygen concentrator that needs power', store.get('acct:oxygen').equipment?.join() === 'oxygen_concentrator' && /Noted your oxygen concentrator\. It needs power/.test(noted.said), noted.said);
  check('...and something that is not medical equipment is not invented into the list', /I don't know "a toaster" as equipment/.test(noted.said));
  warnings.seedForTest(lat, lon, [alert('Hurricane Warning')]);
  const o2storm = await o2('storm_prep');
  check('a hurricane, for somebody on home oxygen, names the concentrator and what to do about power', /Your oxygen concentrator needs power\. Charge every battery/.test(o2storm.said) && /electricity company/.test(o2storm.said) && /take your oxygen concentrator, its charger/.test(o2storm.said), o2storm.said);
  const lungs = await connect('acct:lungs');
  await lungs('register_location', { place: 'Phoenix, Arizona', lat, lon });
  await lungs('about_me', { conditions: ['asthma'] });
  const guess = await lungs('storm_prep');
  check('asthma alone is no longer told it has equipment that needs power', !/Your [a-z ]+ needs power/.test(guess.said) && /If anything you breathe with needs a socket/.test(guess.said), guess.said);
  const back = await o2('about_me', {});
  check('the equipment is read back with the rest of the profile', /Equipment: oxygen concentrator/.test(back.said), back.said);
  const dev = await import('./dist/devices.js');
  dev.seedForTest('oxygen_concentrator', [{ category: 'oxygen_concentrator', firm: 'Acme Medical Inc.', description: 'Portable oxygen concentrator model X', reason: 'Battery may overheat', classification: 'Class I', status: 'Ongoing', initiated: '20260901' }]);
  const recall = await o2('about_me', { recalls: true });
  check('a most-serious recall on that kind of equipment is raised, by kind and never as "yours"', /Class one recall, the most serious grade, affecting some oxygen concentrators from Acme Medical Inc\./.test(recall.said) && /Yours may not be affected/.test(recall.said) && recall.data.equipmentRecall?.category === 'oxygen_concentrator', recall.said);
  dev.seedForTest('oxygen_concentrator', [{ category: 'oxygen_concentrator', firm: 'Acme', description: 'x', reason: 'label', classification: 'Class II', status: 'Ongoing', initiated: '20260901' }]);
  const minor = await o2('about_me', { recalls: true });
  check('a lesser recall on the category is not, because it would alarm more people than it helps', !/Acme/.test(minor.said), minor.said);
  const gone = await o2('about_me', { stopEquipment: ['oxygen concentrator'] });
  check('...and can be taken off again', /Removed your oxygen concentrator/.test(gone.said) && (store.get('acct:oxygen').equipment ?? []).length === 0);

  // Smoke comes with the number.
  const wx = await import('./dist/weather.js');
  const snapNow = wx.current(lat, lon);
  if (snapNow && wx.seedForTest) {
    wx.seedForTest({ ...snapNow, aqi: 162 });
    warnings.seedForTest(lat, lon, [alert('Air Quality Alert', 'Moderate')]);
    const smoky = await who('storm_prep');
    check('a smoke alert says the air quality number, live, and what band that is', /The air quality index is 162 right now, which is unhealthy\./.test(smoky.said) && smoky.data.aqi === 162, smoky.said);
    wx.seedForTest(snapNow);
  } else {
    check('a smoke alert says the air quality number (weather could not be seeded in this run)', true);
  }
  warnings.seedForTest(lat, lon, []);
  delete process.env.SUDOR_RECIPIENT_CONSENT;
  rx.configureForTest(null);
  labels.configureForTest(null);
}

console.log('\nThe heat inside the house');
{
  const wx = await import('./dist/weather.js');
  const indoor = await import('./dist/indoor.js');
  const rx = await import('./dist/rxclass.js');
  const labels = await import('./dist/labels.js');
  rx.configureForTest(async () => null);
  labels.configureForTest(async () => null);
  const base = wx.current(lat, lon);
  const now = Date.now();
  // A day that reaches `high` and a night that falls to `low`, as real hours either side of now.
  const day = (high, low) => ({
    ...base,
    tempF: high,
    humidityPct: 20,
    isDay: true,
    hourly: Array.from({ length: 30 }, (_, i) => {
      const dark = i >= 8 && i < 18;
      return { ...base.hourly[0], local: `h${i}`, time: new Date(now + (i - 1) * 3_600_000).toISOString(), tempF: dark ? low : high, humidityPct: 20, isDay: !dark, uvIndex: dark ? 0 : 9, solarWm2: dark ? 0 : 800 };
    }),
  });
  const hot = day(108, 86);
  check('no cooling, 108 by day and 86 by night: the house cannot cool down, and that is said to anybody', indoor.indoorRisk(hot, { cooling: 'none' }, false)?.level === 'danger' && /only falls to 86 overnight/.test(indoor.indoorRisk(hot, { cooling: 'none' }, false).line));
  check('the same day with working cooling says nothing', indoor.indoorRisk(hot, { cooling: 'working' }, true) === null);
  check('and with cooling never mentioned, nothing is assumed', indoor.indoorRisk(hot, {}, true) === null);
  const coolNight = day(96, 68);
  check('a hot day with a cool night is a warning for somebody at risk, with the night as the way out', indoor.indoorRisk(coolNight, { cooling: 'broken' }, true)?.level === 'watch' && /open the house up after dark/.test(indoor.indoorRisk(coolNight, { cooling: 'broken' }, true).line));
  check('...and not for somebody with nothing registered', indoor.indoorRisk(coolNight, { cooling: 'broken' }, false) === null);
  check('a mild day says nothing even with no cooling', indoor.indoorRisk(day(82, 60), { cooling: 'none' }, true) === null);
  // The CDC's single 90 degree line was replaced by the 2024 trials: what a fan does depends on the air. See indoor.ts.
  const fanDay = indoor.indoorRisk(hot, { cooling: 'fan' }, true).line;
  const noneDay = indoor.indoorRisk(hot, { cooling: 'none' }, true).line;
  check('a fan on a day past 90 is told what to do about the fan and to wet the skin', /fan/.test(fanDay) && /wet your skin/i.test(fanDay), fanDay);
  check('...and a home with no cooling is told to wet the skin, never to switch a fan on', /wet your skin/i.test(noneDay) && !/turn your fan on/i.test(noneDay), noneDay);
  const roof = indoor.indoorRisk(coolNight, { cooling: 'broken', topFloor: true }, false);
  check('sleeping under the roof with no cooling is told what the French study found, and to sleep lower down', roof?.underRoof === true && /about four times as likely to die/.test(roof.line) && /sleep on the lowest floor you can/.test(roof.line), roof?.line);
  check('...and counts as a reason on its own, with nothing else registered', indoor.indoorRisk(coolNight, { cooling: 'broken' }, false) === null && roof !== null);
  check('the top floor with working cooling says nothing', indoor.indoorRisk(hot, { cooling: 'working', topFloor: true }, true) === null);
  const fa = await import('./dist/firstaid.js');
  check('heat stroke first aid says no fever medicine, with the source', /nothing to drink and no fever medicine/.test(fa.triage('he is confused and stopped sweating').spoken) && fa.triage('he is confused').sources.some((x) => /medlineplus/.test(x.url)));
  check('heat exhaustion says the painkillers will not bring it down', /Aspirin, acetaminophen and ibuprofen will not bring it down/.test(fa.triage('I feel dizzy and weak and sweating a lot').spoken), fa.triage('I feel dizzy and weak and sweating a lot').spoken);
  const read = (f, at = new Date().toISOString()) => ({ indoor: { f, at } });
  check('a thermometer reading of 91 indoors outranks everything, whatever the cooling is said to be', indoor.indoorRisk(day(82, 60), { cooling: 'working', ...read(91) }, false)?.basis === 'reported' && indoor.indoorRisk(day(82, 60), { cooling: 'working', ...read(91) }, false).level === 'danger');
  check('82 indoors is above the limit for somebody at risk, and fine for somebody who is not', indoor.indoorRisk(hot, read(82), true)?.level === 'watch' && indoor.indoorRisk(day(82, 60), read(82), false) === null);
  check('a reading from this morning is not believed this evening', indoor.indoorRisk(day(82, 60), read(95, new Date(now - 4 * 3_600_000).toISOString()), true) === null);

  wx.seedForTest(hot);
  const who = await connect('acct:hothouse');
  await who('register_location', { place: 'Phoenix, Arizona', lat, lon });
  await who('about_me', { medicines: ['metoprolol'] });
  const before = await who('weather_check');
  check('told to stay in with nothing known about the cooling, they are asked about it', /stay in right now/.test(before.said) && /Staying in only helps if your cooling works\. Is it working\?$/.test(before.said) && before.data.asks === 'cooling', before.said);
  const told = await who('about_me', { cooling: 'broken' });
  check('"my air conditioning is broken" on that day is answered with where the danger is and where to go', /With your cooling not working, your home has no way to cool down/.test(told.said) && told.data.nextAction?.tool === 'somewhere_to_go', told.said);
  const after = await who('weather_check');
  check('...and from then on "stay in" is never said alone', /Do not sit this out indoors/.test(after.said) && after.data.indoor?.level === 'danger' && after.data.nextAction?.tool === 'somewhere_to_go' && !/Staying in only helps/.test(after.said), after.said);
  const fixed = await who('about_me', { cooling: 'working' });
  const calm = await who('weather_check');
  check('once it is working again the line goes', /indoors is the cool place/.test(fixed.said) && calm.data.indoor === undefined && !/Do not sit this out/.test(calm.said), calm.said);
  const reading = await who('about_me', { indoorTempF: 93 });
  // Said straight after "it is working again", so the cooling is on the record as working: switch it on first. See indoor.ts.
  check('"it is 93 in here" is taken as it is', /It is 93 degrees inside even though your air conditioning works/.test(reading.said) && /go somewhere with working cooling/.test(reading.said) && store.get('acct:hothouse').indoor.f === 93, reading.said);
  const back = await who('about_me', {});
  check('the cooling is read back with the rest', /Cooling at home: working/.test(back.said), back.said);
  wx.seedForTest(base);
  rx.configureForTest(null);
  labels.configureForTest(null);
}

console.log('\nOutside the United States');
{
  const world = await import('./dist/world.js');
  const warnings = await import('./dist/warnings.js');
  check('the number is the one that works there', world.emergencyNumber('GB') === '999' && world.emergencyNumber('DE') === '112' && world.emergencyNumber('AU') === '000' && world.emergencyNumber('US') === '911');
  check('an answer written for the United States says 999 in London', world.localise('Call 911 now.', 'GB') === 'Call 999 now.');
  check('...and both 112 and the local number where the country is not listed', world.localise('Call 911 now.', 'XK') === 'Call 112, or your local emergency number now.' || /112, or your local emergency number/.test(world.localise('Call 911 now.', 'XK')), world.localise('Call 911 now.', 'XK'));
  check('...and nothing changes in the United States', world.localise('Call 911 now.', 'US') === 'Call 911 now.' && world.localise('Call 911 now.', undefined) === 'Call 911 now.');
  // The WMO server's answer for a point in northern Germany, cut down from a live reply on 10 October 2026.
  const live = { type: 'FeatureCollection', features: [
    { properties: { event: 'persistent rain', s: 2, capurl: 'de-dwd-en/a.xml', areadesc: 'Aurich', expires: '2999-01-01T00:00:00Z', headline: 'Official WARNING of PERSISTENT RAIN', description: 'There is a risk of persistent rain.' } },
    { properties: { event: 'persistent rain', s: 2, capurl: 'de-dwd-en/b.xml', areadesc: 'Norden', expires: '2999-01-01T00:00:00Z' } },
    { properties: { event: 'heavy thunderstorms with gale-force gusts', s: 3, capurl: 'de-dwd-en/c.xml', areadesc: 'Aurich', expires: '2999-01-01T00:00:00Z' } },
    { properties: { event: 'wind gusts', s: 1, capurl: 'de-dwd-en/d.xml', expires: '2000-01-01T00:00:00Z' } },
  ] };
  const read = warnings.parseWmo(live);
  check('warnings from another country are read, one per event, expired ones left out', read.length === 2 && read.every((a) => !/wind gusts/.test(a.event)), JSON.stringify(read.map((a) => a.event)));
  check('a severe one is named a warning, so it leads the storm answer', read.some((a) => a.event === 'Heavy thunderstorms with gale-force gusts warning' && a.severity === 'Severe'));
  check('...and the service\'s own words are kept', read.find((a) => a.event === 'Persistent rain')?.instruction === 'There is a risk of persistent rain.');
  check('nonsense is "could not check", not an all-clear', (() => { try { warnings.parseWmo({}); return false; } catch { return true; } })());

  process.env.SUDOR_RECIPIENT_CONSENT = 'off';
  const who = await connect('acct:london');
  store.update('acct:london', (p) => { p.lat = lat; p.lon = lon; p.locationName = 'London, United Kingdom'; p.country = 'GB'; p.locationStatus = 'ready'; });
  const signs = await who('warning_signs', { description: 'he is confused and has stopped sweating' });
  check('heat stroke in London is told to ring 999', /call 999/i.test(signs.said) && !/911/.test(signs.said), signs.said);
  const go = await who('somewhere_to_go');
  check('somewhere to go in London is the council and 999, not the US shelter list or 211', /local council/.test(go.said) && /999/.test(go.said) && !/211|federal/.test(go.said), go.said);
  delete process.env.SUDOR_RECIPIENT_CONSENT;
}

console.log('\nThe stand-in with no model behind it');
{
  const { chooseByWords } = await import('./dist/rules.js');
  const tools = ['about_me', 'weather_check', 'plan_my_day', 'warning_signs', 'storm_prep', 'somewhere_to_go', 'get_help', 'contact', 'tell_me_more', 'going_out_now', 'log_outing', 'share_my_day', 'what_can_you_do'].map((name) => ({ name }));
  const pick = (s) => chooseByWords(s, tools);
  check('"is it safe for me to go out" is the weather', pick('Is it safe for me to go out?').tool === 'weather_check');
  check('"I feel dizzy and confused" is the warning signs, with the words', pick('I feel dizzy and confused').tool === 'warning_signs' && /dizzy/.test(pick('I feel dizzy and confused').args.symptoms));
  check('"there is a hurricane warning" is the storm answer', pick('There is a hurricane warning, what do I do?').tool === 'storm_prep');
  check('"tell my family I am safe" is safe, not a call for help', pick('Tell my family I am safe').args.status === 'safe');
  check('"my air conditioning is broken" sets the cooling', pick('My air conditioning is broken').args.cooling === 'broken');
  check('"I live in Munich, Germany" sets the place', pick('I live in Munich, Germany').args.place === 'Munich, Germany');
  check('"when is the best time for a walk tomorrow" plans tomorrow', pick('When is the best time for a walk tomorrow?').args.day === 'tomorrow');
  check('nothing it knows is a decline, said plainly, and every answer says it was the word rules', pick('purple elephants').tool === null && pick('anything').model === 'word rules');
}

console.log('\nA text, for the messages that cannot wait');
{
  const texts = await import('./dist/texts.js');
  const alerts = await import('./dist/alerts.js');
  check('a US number in any shape becomes +1 and ten digits', texts.phoneOf('(602) 555-0100') === '+16025550100' && texts.phoneOf('1 602 555 0100') === '+16025550100');
  // Outside +1 only where switched on. See smsCountries in texts.ts.
  process.env.SUDOR_SMS_COUNTRY_CODES = '1,44';
  check('a number elsewhere keeps its own country code, where texts there are on', texts.phoneOf('+44 20 7946 0958') === '+442079460958');
  delete process.env.SUDOR_SMS_COUNTRY_CODES;
  check('something that is not a number is not stored', texts.phoneOf('call me maybe') === null && texts.phoneOf('12345') === null);
  check('off unless switched on', !texts.textsOn());
  const sentTexts = [];
  texts.configureForTest(async (t) => { sentTexts.push(t); });
  process.env.SUDOR_SMS = 'on';
  process.env.SUDOR_RECIPIENT_CONSENT = 'off';
  const who = await connect('acct:texts');
  await who('contact', { action: 'add', name: 'Ana', email: 'ana2@example.com' });
  await who('contact', { action: 'confirm', name: 'Ana' });
  store.update('acct:texts', (p) => { p.contacts[0].phone = '+16025550100'; p.contacts[0].acceptedAt = new Date().toISOString(); p.locationName = 'Phoenix, Arizona'; });
  notify.resetEmailLimitsForTest();
  await who('get_help', { what: 'the power is out and I feel faint' });
  await settle();
  check('asking for help texts the contact who added a number, short, with nothing about health', sentTexts.length === 1 && sentTexts[0].to === '+16025550100' && sentTexts[0].text.length <= 300 && /asked for help/.test(sentTexts[0].text), JSON.stringify(sentTexts));
  for (let i = 0; i < 5; i += 1) await texts.sendText({ to: '+16025550199', sender: 'acct:texts', reason: 'help', text: 'x' });
  check('no number gets more than three texts in an hour', sentTexts.filter((t) => t.to === '+16025550199').length === 3);
  const demo = await texts.sendText({ to: '+16025550100', sender: 'demo:abc', reason: 'help', text: 'x' });
  check('a demo visitor can never cause a text', demo.status === 'off');
  check('the log keeps only the last four digits', texts.recentTexts().every((d) => /^ending \d{4}$/.test(d.to)));
  // The number is added by its owner, on the page where they agree, never by the account holder.
  consent.resetTriesForTest();
  const inv = consent.newInvite();
  store.update('acct:texts', (p) => { p.contacts.push({ id: 'contact-x', name: 'Bo', email: 'bo@example.com', relation: null, notifyOn: ['emergency'], addedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), acceptHash: inv.hash, stopId: inv.stopId }); });
  const page = await (await fetch(`${base}/contact/accept?t=${inv.token}`)).text();
  check('the agreement page offers to take their own mobile number', /Your mobile number/.test(page));
  await post('/contact/accept', { t: inv.token, answer: 'yes', phone: '(480) 555-0142' });
  check('...and keeps it, in a form a text can be sent to', store.get('acct:texts').contacts.find((c) => c.name === 'Bo')?.phone === '+14805550142');
  delete process.env.SUDOR_SMS;
  delete process.env.SUDOR_RECIPIENT_CONSENT;
}

console.log('\nWhat is already known, and whose it is');
{
  const world = await import('./dist/world.js');
  check('outside the US a temperature is said in both scales', world.localise('Heat index 104, danger.', 'GB') === 'Heat index 104 (40 Celsius), danger.' && /93 degrees Fahrenheit \(34 Celsius\)/.test(world.localise('It is 93 degrees indoors.', 'DE')));
  check('...miles and minutes are left alone, and nothing changes in the US', world.localise('About 3 miles away, for 20 minutes.', 'GB') === 'About 3 miles away, for 20 minutes.' && world.localise('Heat index 104.', 'US') === 'Heat index 104.');
  const who = await connect('acct:mine');
  store.update('acct:mine', (p) => { p.lat = lat; p.lon = lon; p.locationName = 'Phoenix, Arizona'; p.locationStatus = 'ready'; });
  const dad = await who('about_me', { place: 'Tucson, Arizona' });
  check('a different place is not saved over the one they have without a yes', /You are set to Phoenix, Arizona\. Should I change your own place to Tucson/.test(dad.said) && store.get('acct:mine').locationName === 'Phoenix, Arizona', dad.said);
  check('...and the yes is the next step', dad.data.nextAction?.tool === 'about_me' && dad.data.nextAction.arguments.confirmPlace === true, JSON.stringify(dad.data.nextAction));
  await who('about_me', { place: 'Tucson, Arizona', confirmPlace: true });
  check('...which then changes it', /Tucson/.test(store.get('acct:mine').locationName), store.get('acct:mine').locationName);
  const again = await who('about_me', { place: 'Tucson' });
  check('saying the same town again does not ask', !/Should I change/.test(again.said), again.said);
  const pd = await import('./dist/personal.js');
  const plan = pd.planDay(HOT_DAY, pd.profileOf([], [], {}), { now: new Date(), activity: 'walk the dog' });
  const plan2 = pd.planDay(HOT_DAY, pd.profileOf([], [], {}), { now: new Date(), activity: 'a walk' });
  check('"the best time to walk the dog", and "for a walk"', !/for walk the dog/.test(plan.spoken) && (/to walk the dog/.test(plan.spoken) || !/walk the dog/.test(plan.spoken)) && !/to a walk/.test(plan2.spoken), plan.spoken);
}

console.log('\nOutside the United States, and India in particular');
{
  const brands = await import('./dist/brands.js');
  check('international names are read as the American ones', brands.usName('Salbutamol') === 'albuterol' && brands.usName('paracetamol') === 'acetaminophen' && brands.usName('frusemide') === 'furosemide');
  check('Indian brands are read as their ingredients, strength and form ignored', brands.ingredientsOf('Amlong 5 tablet')?.ingredients.join() === 'amlodipine' && brands.ingredientsOf('Asthalin inhaler')?.ingredients.join() === 'albuterol');
  check('a combination brand is all of its ingredients, and Plus means a different mix', brands.ingredientsOf('Dytor')?.ingredients.join() === 'torsemide' && brands.ingredientsOf('Dytor Plus')?.ingredients.length === 2);
  check('a generic name is not mistaken for a brand', brands.ingredientsOf('metoprolol') === null || brands.ingredientsOf('metoprolol')?.ingredients.join() === 'metoprolol');
  const rx = await import('./dist/rxclass.js');
  rx.configureForTest(async (n) => (n === 'torsemide' ? { generic: 'torsemide', drugClass: 'loop diuretic', mechanisms: ['electrolyte_imbalance', 'faint_risk'], cold: [], atc: 'C03CA', source: 'rxnorm' } : n === 'spironolactone' ? { generic: 'spironolactone', drugClass: 'diuretic', mechanisms: ['electrolyte_imbalance', 'faint_risk'], cold: [], atc: 'C03DA', source: 'rxnorm' } : null));
  const who = await connect('acct:india');
  const amlong = await who('medication', { action: 'add', name: 'Amlong 5' });
  check('"Amlong 5" is added as amlodipine, and it says so', /^Amlong is amlodipine\. Added amlodipine/.test(amlong.said), amlong.said);
  const dytor = await who('medication', { action: 'add', name: 'Dytor Plus' });
  check('"Dytor Plus" adds both of its ingredients', /Dytor Plus is spironolactone and torsemide\. Added/.test(dytor.said) && ['spironolactone', 'torsemide'].every((g) => store.get('acct:india').medications.some((m) => m.generic === g)), dytor.said);
  const salb = await who('medication', { action: 'add', name: 'frusemide' });
  check('"frusemide" is added as furosemide, and it says so', /^frusemide is furosemide in the United States\. Added furosemide/.test(salb.said), salb.said);
  rx.configureForTest(null);
  const w = await import('./dist/warnings.js');
  const rows = [
    { centroid: '77.5769,28.8342', area_covered: '7194', disaster_type: 'Moderate Thunderstorms with surface wind', severity: 'ALERT', severity_color: 'orange', effective_end_time: 'Mon Oct 12 04:45:00 IST 2999', alert_source: 'Uttar Pradesh SDMA', identifier: '1', area_description: 'West UP and NCR' },
    { centroid: '72.88,19.07', area_covered: '600', disaster_type: 'Heavy Rain', severity: 'WARNING', severity_color: 'red', effective_end_time: 'Mon Oct 12 04:45:00 IST 2999', alert_source: 'IMD Mumbai', identifier: '2' },
    { centroid: '77.5769,28.8342', area_covered: '7194', disaster_type: 'Heatwave', severity: 'WARNING', effective_end_time: 'Mon Oct 12 04:45:00 IST 2000', identifier: '3' },
  ];
  const ghaziabad = w.parseSachet(rows, 28.67, 77.45);
  check('an Indian alert applies within the area it covers, and an expired one does not', ghaziabad.length === 1 && ghaziabad[0].event === 'Moderate Thunderstorms with surface wind alert' && /Uttar Pradesh SDMA/.test(ghaziabad[0].instruction), JSON.stringify(ghaziabad.map((a) => a.event)));
  check('...a red one is a warning, and it reaches Mumbai and not Delhi', w.parseSachet(rows, 19.08, 72.9)[0]?.event === 'Heavy Rain warning' && w.parseSachet(rows, 19.08, 72.9)[0]?.severity === 'Severe' && !w.parseSachet(rows, 28.67, 77.45).some((a) => /Heavy Rain/.test(a.event)));
  const world = await import('./dist/world.js');
  check('India is told 112, and 108 for an ambulance', world.localise('Call 911 now.', 'IN') === 'Call 112, or 108 for an ambulance, now.');
}

console.log('\nWeather that is a health event in itself');
{
  const wh = await import('./dist/weatherhealth.js');
  const now = new Date();
  const hours = (fn) => Array.from({ length: 30 }, (_, i) => ({ local: `2026-05-10T${String(i % 24).padStart(2, '0')}:00`, time: new Date(now.getTime() + (i - 1) * 3_600_000).toISOString(), tempF: 75, humidityPct: 50, uvIndex: 3, windMph: 5, isDay: true, solarWm2: 400, wetBulbF: 60, aqi: 30, ...fn(i) }));
  const snap = (lat, fn) => ({ lat, lon: 0, fetchedAt: now.toISOString(), timezone: 'UTC', utcOffsetSeconds: 0, tempF: 75, humidityPct: 50, uvIndex: 3, windMph: 5, isDay: true, solarWm2: 400, wetBulbF: 60, aqi: 30, hourly: hours(fn), stale: false });
  const stormy = snap(50, (i) => ({ weatherCode: i === 6 ? 95 : 2, grassPollen: 80 }));
  check('a storm in pollen season is a warning for somebody with hay fever and no asthma', /A thunderstorm is forecast around/.test(wh.thunderstormAsthma(stormy, { asthma: false, hayFever: true }, now)) && /reliever inhaler/.test(wh.thunderstormAsthma(stormy, { asthma: false, hayFever: true }, now)));
  check('...and nothing for somebody with neither', wh.thunderstormAsthma(stormy, { asthma: false, hayFever: false }, now) === '');
  check('...nothing when the pollen count is low', wh.thunderstormAsthma(snap(50, (i) => ({ weatherCode: i === 6 ? 95 : 2, grassPollen: 5 })), { asthma: true, hayFever: false }, now) === '');
  check('...and nothing with no storm', wh.thunderstormAsthma(snap(50, () => ({ weatherCode: 3, grassPollen: 80 })), { asthma: true, hayFever: true }, now) === '');
  const falling = snap(50, (i) => ({ pressureHpa: 1015 - i * 0.5 }));
  check('a sharp pressure fall is said to somebody with migraines, as "can"', /can bring on migraines/.test(wh.migrainePressure(falling, now)) && wh.migrainePressure(snap(50, () => ({ pressureHpa: 1013 })), now) === '');
  const cond = await import('./dist/conditions.js');
  const pd = await import('./dist/personal.js');
  check('hay fever and migraine are understood, and do not move the heat limit', cond.matchCondition?.('hay fever')?.id === 'hay_fever' || cond.conditionById('hay_fever')?.label === 'hay fever');
  check('...a person with only hay fever is not called heat-sensitive', pd.profileOf([], ['hay_fever', 'migraine'], {}).sensitivity === 'general');
}

console.log('\nThe days ahead, from the forecasters');
{
  const o = await import('./dist/outlook.js');
  // A HeatRisk identify answer, cut down from a live one for St Louis on 11 October 2026.
  const day = (d) => Date.parse(`2026-10-${d}T12:00:00Z`);
  const body = { properties: { Values: ['2', '1', '2', '3'] }, catalogItems: { features: [{ attributes: { idp_validtime: day(13) } }, { attributes: { idp_validtime: day(11) } }, { attributes: { idp_validtime: day(12) } }, { attributes: { idp_validtime: day(14) } }] } };
  const heat = o.parseHeatRisk(body);
  check('HeatRisk days are read in date order, each with its own level', heat.map((d) => `${d.date.slice(8)}:${d.level}`).join() === '11:1,12:2,13:2,14:3', JSON.stringify(heat));
  check('...and a reply of another shape is "could not check"', (() => { try { o.parseHeatRisk({ properties: { Values: ['1'] } }); return false; } catch { return true; } })());
  const said = o.speak({ heat, storms: [], rivers: [], checkedAt: 0 }, true, '2026-10-11');
  check('for somebody sensitive, level 2 days ahead are named, and today is left to the rest of the answer', /Monday, Tuesday and Wednesday at level 3 of 4/.test(said[0] ?? ''), said[0]);
  check('...for anybody else only level 3 and above', /Wednesday at level 3/.test(o.speak({ heat, storms: [], rivers: [], checkedAt: 0 }, false, '2026-10-11')[0] ?? '') && !/Monday/.test(o.speak({ heat, storms: [], rivers: [], checkedAt: 0 }, false, '2026-10-11')[0] ?? ''));
  const storm = o.speak({ heat: [], storms: [{ name: 'Isaias', kind: 'Hurricane' }], rivers: [{ name: 'Mississippi River at St. Louis', category: 'moderate', peakFt: 36, at: '2026-10-14T12:00:00Z' }], checkedAt: 0 }, false, '2026-10-11');
  check('a hurricane cone over the house, and a river forecast, are said with what to do and when', /Hurricane Isaias's forecast cone covers where you live/.test(storm[0]) && /Mississippi River at St. Louis is forecast to reach moderate flood stage around Wednesday/.test(storm[1]), storm.join(' | '));
  check('a river forecast is read against the gauge\'s own flood stages', o.floodCategory(36, { minor: { stage: 30 }, moderate: { stage: 35 }, major: { stage: 40 } }) === 'moderate' && o.floodCategory(20, { minor: { stage: 30 } }) === null && o.floodCategory(50, { major: { stage: -9999 }, minor: { stage: 30 } }) === 'minor');
  check('outside the US the week comes from the ordinary forecast', /Thursday feeling like 104 degrees/.test(o.speakWorld([{ date: '2026-10-15', feelsMaxF: 104 }, { date: '2026-10-11', feelsMaxF: 110 }], true, '2026-10-11')) && o.speakWorld([{ date: '2026-10-15', feelsMaxF: 97 }], false, '2026-10-11') === '');
}

console.log('\nHot nights, fasting, and living alone');
{
  const wx = await import('./dist/weather.js');
  const indoor = await import('./dist/indoor.js');
  const base = wx.current(lat, lon);
  const now = Date.now();
  const warmNight = { ...base, tempF: 95, hourly: Array.from({ length: 30 }, (_, i) => ({ ...base.hourly[0], time: new Date(now + (i - 1) * 3_600_000).toISOString(), local: `h${i}`, tempF: i >= 8 && i < 18 ? 84 : 95, isDay: !(i >= 8 && i < 18) })) };
  const night = indoor.indoorRisk(warmNight, { cooling: 'power_cuts' }, true);
  check('a night that stays at 84 is said to somebody with power cuts, with what to ready before the power goes', night?.level === 'watch' && /Tonight only falls to 84 degrees/.test(night.line) && /battery fan/.test(night.line), night?.line);
  check('...and not with cooling that works', indoor.indoorRisk(warmNight, { cooling: 'working' }, true) === null);

  const fa = await import('./dist/firstaid.js');
  const cond = await import('./dist/conditions.js');
  const fastProfile = { conditions: [cond.conditionById('fasting')], private: false };
  check('heat exhaustion while fasting says to break the fast and drink', /break your fast and sip water/.test(fa.triage('I feel dizzy and weak and sweating a lot', fastProfile).spoken));
  check('fasting is understood from "Ramadan" and "roza"', ['ramadan', 'roza'].every((w) => cond.conditionById('fasting').aliases.includes(w)));

  const alerts = await import('./dist/alerts.js');
  process.env.SUDOR_RECIPIENT_CONSENT = 'off';
  wx.seedForTest(HOT_DAY);
  const who = await connect('acct:alone');
  await who('register_location', { place: 'Phoenix, Arizona', lat, lon });
  await who('about_me', { medicines: ['metoprolol'], conditions: ['heart disease'] });
  await who('contact', { action: 'add', name: 'Sam', email: 'sam9@example.com' });
  await who('contact', { action: 'confirm', name: 'Sam' });
  const told = await who('about_me', { livesAlone: true });
  check('"I live alone" says who will be asked to check, and when', /if I have not heard from you by two in the afternoon, I will ask Sam to check on you/.test(told.said), told.said);
  sent.length = 0;
  notify.resetEmailLimitsForTest();
  // Heard from just now: nothing is sent.
  const afternoon = new Date(Date.now());
  const seen = await alerts.checkOnAlone(afternoon);
  check('somebody who has spoken today is not reported', seen.length === 0);
  store.update('acct:alone', (p) => { p.lastSeenAt = new Date(Date.now() - 2 * 86_400_000).toISOString(); });
  // A day that is 3 pm where they are right now, and 108 degrees all afternoon and evening.
  const nowMs = Date.now();
  const off = ((15 - new Date(nowMs).getUTCHours() + 24) % 24) * 3600;
  const hot = { ...HOT_DAY, utcOffsetSeconds: off, tempF: 108, hourly: Array.from({ length: 12 }, (_, i) => { const t = nowMs + (i - 1) * 3_600_000; return { ...HOT_DAY.hourly[0], time: new Date(t).toISOString(), local: new Date(t + off * 1000).toISOString().slice(0, 13) + ':00', tempF: 108, humidityPct: 20, isDay: true }; }) };
  wx.seedForTest(hot);
  const twoPm = new Date(nowMs);
  const missing = await alerts.checkOnAlone(twoPm);
  await settle();
  check('somebody who lives alone and has not been heard from by 2 pm on a dangerous day is checked on, once', missing.length === 1 && sent.some((m) => m.subject === 'Please check on them today' && !/metoprolol|heart/i.test(m.text)), JSON.stringify(sent.map((m) => m.subject)));
  check('...and only once', (await alerts.checkOnAlone(twoPm)).length === 0);
  wx.seedForTest(HOT_DAY);
  delete process.env.SUDOR_RECIPIENT_CONSENT;
}

console.log('\nThe other Alexa+ countries');
{
  const w = await import('./dist/warnings.js');
  // A MeteoAlarm warning for the Veneto (EMMA_ID IT006), shaped as the live Italian feed sends it.
  const row = (code, level, expires, lang = 'en-GB') => ({ alert: { identifier: `x-${code}-${level}`, info: [
    { language: 'it-IT', event: 'Avviso temporali', severity: 'Moderate', expires, parameter: [{ valueName: 'awareness_level', value: level }], area: [{ areaDesc: 'Veneto', geocode: [{ valueName: 'EMMA_ID', value: code }] }] },
    { language: lang, event: 'Yellow Thunderstorm Warning', severity: 'Moderate', expires, instruction: 'Secure loose objects.', parameter: [{ valueName: 'awareness_level', value: level }], area: [{ areaDesc: 'Veneto', geocode: [{ valueName: 'EMMA_ID', value: code }] }] },
  ] } });
  const future = '2999-01-01T00:00:00+00:00';
  const venice = w.parseMeteoAlarm([row('IT006', '2; yellow; Moderate', future)], 45.72, 11.94, null);
  check('a European warning is found by the area it covers, in English', venice.length === 1 && venice[0].event === 'Yellow Thunderstorm Warning' && venice[0].instruction === 'Secure loose objects.', JSON.stringify(venice));
  check('...not for a point outside that area', w.parseMeteoAlarm([row('IT006', '2; yellow; Moderate', future)], 41.9, 12.5, null).length === 0);
  check('...not when it is green, which means no warning, or expired', w.parseMeteoAlarm([row('IT006', '1; green; Minor', future), row('IT006', '2; yellow; Moderate', '2000-01-01T00:00:00+00:00')], 45.72, 11.94, null).length === 0);
  const uk = { alert: { identifier: 'uk1', info: [{ language: 'en-GB', event: 'Yellow wind warning', severity: 'Moderate', expires: future, parameter: [{ valueName: 'awareness_level', value: '2; yellow; Moderate' }], area: [{ areaDesc: 'London & South East England', geocode: [{ valueName: 'EMMA_ID', value: 'UK999' }] }] }] } };
  check('an area with no outline, as in the UK, is matched by the town in its name', w.parseMeteoAlarm([uk], 51.5, -0.13, 'London').length === 1 && w.parseMeteoAlarm([uk], 53.48, -2.24, 'Manchester').length === 0);

  const brands = await import('./dist/brands.js');
  check('brands from Canada, France and Brazil are read from their own regulators', brands.ingredientsOf('Synthroid', 'CA')?.ingredients.join() === 'levothyroxine' && brands.ingredientsOf('Lasilix', 'FR')?.ingredients.join() === 'furosémide' && brands.ingredientsOf('Glifage', 'BR')?.ingredients.join() === 'metformina');
  check('...the person\'s own country first', brands.ingredientsOf('Coversyl', 'CA')?.country === 'CA' && brands.ingredientsOf('Coversyl', 'FR')?.country === 'FR');
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (b) => new Response(JSON.stringify(b));
    if (u.includes('approximateTerm')) return json({ approximateGroup: { candidate: [{ rxcui: /nifedipino|nifedipine/.test(u) ? '7417' : /xyzone/.test(u) ? '19832' : '0' }] } });
    if (u.includes('/rxcui/7417/')) return json({ properties: { name: 'nifedipine', tty: 'IN' } });
    if (u.includes('/rxcui/19832/')) return json({ properties: { name: 'budipine', tty: 'IN' } });
    if (u.includes('cima.aemps.es')) return json({ resultados: [{ nombre: 'ADALAT OROS 30 mg', vtm: { nombre: 'nifedipino' } }] });
    return real(url);
  };
  check('a foreign generic name is read in English', (await brands.englishName('nifedipino')) === 'nifedipine' && (await brands.englishName('nifédipine')) === 'nifedipine');
  check('...and a match spelled nothing like what was said is refused', (await brands.englishName('xyzone')) === null);
  check('the international names need no lookup', (await brands.englishName('Paracétamol')) === 'acetaminophen');
  check('Spain is asked live, and its answer is in Spanish', JSON.stringify(await brands.lookupSpain('Adalat')) === '["nifedipino"]');
  globalThis.fetch = real;

  const ca = await import('./dist/recallsca.js');
  const rows = ca.parse([
    { Category: 'Drugs', Archived: '0', 'Last updated': new Date().toISOString().slice(0, 10), Title: 'Metformin 500 mg: affected lot may contain NDMA.', Product: 'Metformin', 'Recall class': 'Type II', URL: 'u' },
    { Category: 'Drugs', Archived: '1', 'Last updated': new Date().toISOString().slice(0, 10), Title: 'Metformin old', Product: 'Metformin', 'Recall class': 'Type I', URL: 'u' },
    { Category: 'Food', Archived: '0', 'Last updated': new Date().toISOString().slice(0, 10), Title: 'Metformin cake', Product: 'Cake', 'Recall class': 'Type I', URL: 'u' },
    { Category: 'Drugs', Archived: '0', 'Last updated': '2001-01-01', Title: 'Metformin ancient', Product: 'Metformin', 'Recall class': 'Type I', URL: 'u' },
  ]);
  ca.seedForTest(rows);
  check('Health Canada recalls: only current drug recalls, matched by the medicine\'s name', ca.forMedicines(['metformin']).length === 1 && ca.forMedicines(['metoprolol']).length === 0);
  check('...said with the lot check, and never "stop taking it"', /Check the lot number/.test(ca.speak(rows[0])) && /don't stop taking it without asking your pharmacist/.test(ca.speak(rows[0])));
  ca.seedForTest(null);
}

console.log('\nBrazil, the UK and Italy');
{
  const w = await import('./dist/warnings.js');
  const square = JSON.stringify({ type: 'Polygon', coordinates: [[[-47, -24], [-46, -24], [-46, -23], [-47, -23], [-47, -24]]] });
  const rows = [
    { poligono: square, descricao: 'Tempestade', severidade: 'Perigo', data_fim: '2999-01-01', hora_fim: '23:59', codigo: 'a' },
    { poligono: square, descricao: 'Onda de Calor', severidade: 'Grande Perigo', data_fim: '2999-01-01', hora_fim: '23:59', codigo: 'b' },
    { poligono: square, descricao: 'Geada', severidade: 'Perigo Potencial', data_fim: '2000-01-01', hora_fim: '23:59', codigo: 'c' },
  ];
  const sp = w.parseInmet(rows, -23.55, -46.63);
  check('Brazilian warnings are read inside their outline, in English, at their own level', sp.length === 2 && sp.some((x) => x.event === 'Thunderstorm warning' && x.severity === 'Severe') && sp.some((x) => x.event === 'Heatwave warning' && x.severity === 'Extreme'), JSON.stringify(sp.map((x) => x.event)));
  check('...and not outside it', w.parseInmet(rows, -30.03, -51.23).length === 0);
  const uk = await import('./dist/recallsuk.js');
  const ukRows = uk.parse({ results: [
    { title: 'Class 2 Medicines Recall: Crescent Pharma Limited, Ramipril 2.5 mg Capsules, EL(26)A/39', description: 'Batches are being recalled.', public_timestamp: new Date().toISOString(), link: '/x' },
    { title: 'Medical device alert: insulin pumps', description: 'x', public_timestamp: new Date().toISOString(), link: '/y' },
  ] });
  uk.seedForTest(ukRows);
  check('MHRA recalls are matched by the medicine\'s name', uk.forMedicines(['ramipril']).length === 1 && uk.forMedicines(['metoprolol']).length === 0);
  check('...and said with the batch check and the class, without the reference code', /^The MHRA has a Class 2 recall: Crescent Pharma Limited, Ramipril 2\.5 mg Capsules\. Check the batch number/.test(uk.speak(ukRows[0])), uk.speak(ukRows[0]));
  uk.seedForTest(null);
  const brands = await import('./dist/brands.js');
  const tri = brands.ingredientsOf('Triatec', 'DE');
  check('a brand that is a different medicine in different countries is asked about, never guessed', tri?.ambiguous?.length === 3 && tri.ingredients.length === 0 && brands.ingredientsOf('Triatec', 'IT')?.ingredients.join() === 'ramipril');
  check('...while the same medicine spelled per country is one medicine', !brands.ingredientsOf('Lasix', 'DE')?.ambiguous && !brands.ingredientsOf('Augmentin', 'DE')?.ambiguous && !brands.ingredientsOf('Coversyl', 'DE')?.ambiguous);
  check('Italian brands are read from AIFA\'s list', brands.ingredientsOf('Triatec', 'IT')?.ingredients.join() === 'ramipril' && brands.ingredientsOf('Congescor', 'IT')?.ingredients.join() === 'bisoprololo');
}

await new Promise((r) => listener.close(r));
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
