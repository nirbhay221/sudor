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
  check('a visitor to the demo cannot send an invitation by email at all: it goes to the phone on the page', sent.length === 0 && /phone on this page, not to a real inbox/.test(demo.said), demo.said);
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
  check('a general question still gets the 911 advice', /If that is happening to somebody now: That can be heat stroke.*Call 911 now/.test(asked.said), asked.said);
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
  const row = (name, tty, classId) => ({ minConcept: { name, tty }, rxclassMinConceptItem: { classId } });
  const body = (...rows) => ({ rxclassDrugInfoList: { rxclassDrugInfo: rows } });
  const biso = rx.parse(body(row('bisoprolol', 'IN', 'C07AB')));
  check('bisoprolol is read as a beta blocker, with the mechanisms the table gives beta blockers', biso.drugClass === 'beta blocker' && biso.mechanisms.join() === 'electrolyte_imbalance,reduced_sweating' && biso.cold.join() === 'reduced_heat_production', JSON.stringify(biso));
  check('a combination product is not read as one drug', rx.parse(body(row('furosemide / potassium', 'MIN', 'C03CB'))) === null);
  check('...and the plain ingredient beside it is', rx.parse(body(row('furosemide / potassium', 'MIN', 'C03CB'), row('furosemide', 'IN', 'C03CA'))).drugClass === 'loop diuretic');
  check('lithium is a mood stabiliser, not an antipsychotic, though it sits under the same heading', rx.ruleFor('N05AN01').drugClass === 'mood stabiliser' && rx.ruleFor('N05AH04').drugClass === 'antipsychotic');
  check('a class that mixes different drugs is not classified at all', rx.ruleFor('N06AX') === null && rx.parse(body(row('bupropion', 'IN', 'N06AX'))) === null);
  check('a class with nothing to do with heat is not classified', rx.parse(body(row('omeprazole', 'IN', 'A02BC'))) === null);
  check('a name that resolves to two different drugs is not classified', rx.parse(body(row('atenolol', 'IN', 'C07AB'), row('chlorthalidone', 'IN', 'C03BA'))) === null);
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

await new Promise((r) => listener.close(r));
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
