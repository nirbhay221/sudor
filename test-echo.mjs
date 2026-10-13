/**
 * The Echo-style demo page, and the phone beside it.
 *
 * The page promises two things and both are checked here. Every line on it is a real tool with real
 * arguments. And the phone shows what a contact would have been sent, with the real links behind its
 * buttons: agreeing there is agreeing, answering there is answering, and nothing is ever emailed.
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const DIR = './data/test-echo';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_SCOPE;
delete process.env.SUDOR_PUBLIC_URL;

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const care = await import('./dist/care.js');
const notify = await import('./dist/notify.js');
const consent = await import('./dist/consent.js');
const rx = await import('./dist/rxclass.js');
const labels = await import('./dist/labels.js');
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
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {}, isError: r.isError };
  };
  return { call, names: async () => (await client.listTools()).tools.map((t) => t.name) };
}

const app = express();
consent.mountConsent(app);
const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${listener.address().port}`;
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

const sent = [];
notify.configureForTest({ from: 'sudor@example.org', transport: async (email) => { sent.push(email); } });
rx.configureForTest(async (name) => (name === 'coreg' ? { generic: 'carvedilol', drugClass: 'beta blocker', mechanisms: ['electrolyte_imbalance', 'reduced_sweating'], cold: ['reduced_heat_production'], atc: 'C07AG', source: 'rxnorm' } : name === 'lasix' ? { generic: 'furosemide', drugClass: 'loop diuretic', mechanisms: ['electrolyte_imbalance'], cold: [], atc: 'C03CA', source: 'rxnorm' } : null));
labels.configureForTest(async () => null);

// The test's hot day is set to be around midday wherever the clock is, so a run late at night still has a day
// to plan: with Phoenix's own offset, a run after sunset there found the day's daytime hours already over.
const middayShift = (() => { let h = 12 - new Date().getUTCHours(); if (h > 14) h -= 24; if (h < -11) h += 24; return h; })();
const lat = 33.45, lon = -112.07, off = middayShift * 3600;
const local = (ms) => new Date(ms + off * 1000).toISOString();
const hourly = [];
for (const date of [local(Date.now()).slice(0, 10), local(Date.now() + 86_400_000).slice(0, 10)]) {
  for (let h = 0; h < 24; h += 1) {
    const at = `${date}T${String(h).padStart(2, '0')}:00`;
    hourly.push({ local: at, time: weather.localToUtc(at, off), tempF: 104, humidityPct: 25, uvIndex: 8, windMph: 5, isDay: h >= 6 && h < 19, aqi: 40, solarWm2: 700, wetBulbF: 70 });
  }
}
weather.seedForTest({ lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: off, tempF: 104, humidityPct: 25, uvIndex: 8, windMph: 5, isDay: true, aqi: 40, solarWm2: 700, wetBulbF: 70, hourly, stale: false });
// No live weather in these tests: a download landing mid-test replaced the hot day with the real one.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (/open-meteo\.com/.test(String(url)) ? new Response('{}', { status: 503 }) : realFetch(url, init));
}
// The test's own hot day, put back wherever setting a place starts a live download that could replace it.
const HOT_DAY = weather.current(lat, lon);
care.configureForTest(null);
care.seedForTest(lat, lon, [{ name: 'Banner University Medical Center Phoenix', address: '1012 E Willetta St', city: 'Phoenix', phone: '602-839-2000', lat: 33.464, lon: -112.06, emergency: true }]);

console.log('\nEvery line on the page is a real tool with real arguments');
const scenes = JSON.parse(readFileSync('./web/echo-scenes.json', 'utf8'));
const visitor = await connect('demo:0123456789abcdef0123456789abcdef');
const ID = 'demo:0123456789abcdef0123456789abcdef';
{
  const names = await visitor.names();
  const lines = scenes.groups.flatMap((g) => g.lines);
  check('the page has lines to say', lines.length >= 12, String(lines.length));
  check('every line names a tool a customer gets by default', lines.every((l) => names.includes(l.tool)), lines.filter((l) => !names.includes(l.tool)).map((l) => l.tool).join(','));
  const html = readFileSync('./web/echo.html', 'utf8');
  check('the page says it is a stand-in and that no assistant model runs on it', /stand-in for an Echo Show/.test(html) && /No assistant model runs on this page/.test(html));
  check('the phone says the demo never sends email', /never sends email/.test(html));
  check('the answer is announced to a screen reader', /id="answer" aria-live="polite"/.test(html));
}

console.log('\nThe story the page tells, start to finish, through the same calls');
{
  const said = {};
  for (const group of scenes.groups.slice(0, 1)) for (const line of group.lines) said[line.say] = await visitor.call(line.tool, line.args);
  check('none of the setup lines is refused', Object.values(said).every((r) => !r.isError && r.said.length > 10), JSON.stringify(Object.fromEntries(Object.entries(said).map(([k, v]) => [k, v.said.slice(0, 40)]))));
  check('a brand name is resolved to the real medicine', /Coreg is carvedilol/.test(said["I'm in Phoenix, Arizona, and I take Lasix and Coreg."].said), said["I'm in Phoenix, Arizona, and I take Lasix and Coreg."].said);
  check('...and a place and two medicines given in one breath are all taken in one call', /Phoenix, Arizona/.test(said["I'm in Phoenix, Arizona, and I take Lasix and Coreg."].said) && /furosemide/.test(said["I'm in Phoenix, Arizona, and I take Lasix and Coreg."].said) && store.get(ID).medications.length === 2 && store.get(ID).locationName === 'Phoenix, Arizona', said["I'm in Phoenix, Arizona, and I take Lasix and Coreg."].said);
  check('..."what do you know about me" reads it back', /Medications: furosemide, carvedilol/.test(said['What do you know about me?'].said), said['What do you know about me?'].said);
  // On the page the town is looked up in the background. Here it is pinned, through the older tool that
  // is no longer listed and still answers, so the rest of the story has a place without touching the network.
  check('a tool folded into another one still answers when called by its old name', !(await visitor.call('register_location', { place: 'Phoenix, Arizona', lat, lon })).isError && store.get(ID).lat === lat);
  const invite = notify.demoPhone(ID);
  check('confirming Priya puts an invitation on the phone, and emails nobody', invite.length === 1 && invite[0].reason === 'invite' && /^[0-9a-f]{48}$/.test(invite[0].accept) && sent.length === 0, JSON.stringify(invite));
  check('...and the answer says where it went', /goes to the phone on this page, not to a real inbox/.test(said['Yes, add her.'].said), said['Yes, add her.'].said);
  check('the invitation says nothing about health', !/medic|condition|heart|carvedilol|furosemide/i.test(invite[0].text), invite[0].text);

  const early = await visitor.call('get_help', { what: 'the power is out' });
  check('before she agrees, asking for help reaches nobody', /Priya has not agreed to be emailed yet/.test(early.said) && notify.demoPhone(ID).length === 1, early.said);

  const agreed = await post('/contact/accept', { t: invite[0].accept, answer: 'yes' });
  check('pressing yes on the phone is the real agreement', agreed.status === 200 && !!store.get(ID).contacts[0].acceptedAt);

  const help = await visitor.call('get_help', { what: 'the power is out' });
  const phone = notify.demoPhone(ID);
  const msg = phone.at(-1);
  check('asking for help now puts the real message on the phone', phone.length === 2 && msg.reason === 'help' && /What they said: "the power is out"/.test(msg.text) && /Banner University Medical Center Phoenix/.test(msg.text), msg.text);
  check('...and still says 911 is theirs to call', /I cannot phone anyone or reach 911 for you/.test(help.said) && /phone on this page/.test(help.said), help.said);
  check('...with nothing about a medicine or a condition', !/carvedilol|furosemide|lasix|coreg|heart disease|medication|medicine|beta blocker|diuretic/i.test(msg.text), msg.text);
  check('...and nothing emailed', sent.length === 0);

  const answered = await post('/contact/reply', { r: msg.reply, answer: 'coming' });
  check('pressing "I\'m on my way" on the phone is the real answer', answered.status === 200 && store.get(ID).helpReplies.length === 1);
  const next = await visitor.call('weather_check');
  check('and the next thing heard on the Echo starts with it', /^Priya answered: they are on the way\. /.test(next.said), next.said);

  const stroke = await visitor.call('warning_signs', { symptoms: 'my husband is confused and has stopped sweating' });
  check('an emergency reaches the phone too, after the 911 line', /Call 911 now/.test(stroke.said) && notify.demoPhone(ID).at(-1).reason === 'emergency', stroke.said);
  const question = await visitor.call('warning_signs', { symptoms: 'is confusion a sign of heat stroke?' });
  check('a question about the signs does not', notify.demoPhone(ID).at(-1).reason === 'emergency' && notify.demoPhone(ID).length === 3 && /If that is happening to somebody now/.test(question.said));

  for (const group of scenes.groups.slice(1)) {
    for (const line of group.lines) {
      const r = await visitor.call(line.tool, line.args);
      check(`"${line.say}" is answered`, !r.isError && r.said.length > 10, r.said.slice(0, 80));
    }
  }
}

console.log('\nAsked the same thing twice');
{
  const attention = await import('./dist/attention.js');
  attention.resetForTest();
  const who = await connect('acct:twice');
  await who.call('register_location', { place: 'Phoenix, Arizona', lat, lon });
  weather.seedForTest(HOT_DAY);
  await who.call('medication', { action: 'add', name: 'metoprolol' });
  // The cooling is known, so nothing is asked about it and the two answers are the same answer.
  await who.call('about_me', { cooling: 'working' });
  const one = await who.call('weather_check');
  const two = await who.call('weather_check');
  check('the second time, the verdict alone and what to ask next', two.data.repeated === true && /^In short: /.test(two.said) && /Ask me why, or what to do about it\.$/.test(two.said) && two.said.length < one.said.length, two.said);
  check('...and it is the same verdict', two.said.includes(one.said.split('. ')[0]), `${one.said} | ${two.said}`);
  check('...and the long answer is not sent again alongside it', two.data.full === undefined);
  const three = await who.call('plan_my_day', { activity: 'a walk', minutes: 30 });
  check('a different question is answered normally', three.data.repeated === undefined);
  const e1 = await who.call('warning_signs', {});
  const e2 = await who.call('warning_signs', {});
  check('an answer that mentions 911 is said in full however often it is asked', /911/.test(e1.said) && e2.said === e1.said && e2.data.repeated === undefined, e2.said);
  const w1 = await who.call('contact', { action: 'add', name: 'Lee', email: 'lee\example.com' });
  const w2 = await who.call('contact', { action: 'add', name: 'Lee', email: 'lee\example.com' });
  check('a tool that writes is never shortened for being repeated', w2.data.repeated === undefined && w2.said === w1.said);
  const abc = () => ({ content: [{ type: 'text', text: 'A. B. C.' }] });
  check('a repeat after a minute and a half is a new question', attention.onRepeat('x', 'weather_check', {}, abc(), true, 1000).structuredContent?.repeated === undefined && attention.onRepeat('x', 'weather_check', {}, abc(), true, 1000 + 91_000).structuredContent?.repeated === undefined && attention.onRepeat('x', 'weather_check', {}, abc(), true, 1000 + 92_000).structuredContent?.repeated === true);
  const only = () => ({ content: [{ type: 'text', text: 'Only this.' }] });
  check('a one sentence answer has nothing shorter to give', attention.onRepeat('y', 't', {}, only(), true, 1).structuredContent === undefined && attention.onRepeat('y', 't', {}, only(), true, 2).structuredContent?.repeated === undefined);
}

console.log('\nA stay-inside day is mentioned until it is heard');
{
  const attention = await import('./dist/attention.js');
  attention.resetForTest();
  const who = await connect('acct:reminder');
  await who.call('register_location', { place: 'Phoenix, Arizona', lat, lon });
  weather.seedForTest(HOT_DAY);
  await who.call('medication', { action: 'add', name: 'oxybutynin' });
  await who.call('health_condition', { action: 'add', condition: 'heart disease' });
  const before = await who.call('my_profile');
  check('nothing is said before a day has been planned', !/stay-inside day/.test(before.said));
  const plan = await who.call('plan_my_day', { activity: 'a walk', minutes: 30 });
  check('the day is a stay-inside day for this person', plan.data.best?.status === 'avoid', JSON.stringify(plan.data.best));
  check('the plan itself does not remind about itself', !/Remember, today/.test(plan.said));
  const next = await who.call('my_profile');
  check('the next answer, whatever it is about, starts with the reminder and how to stop it', /^Remember, today is a stay-inside day for you\. Say got it and I will stop reminding you\. /.test(next.said) && next.data.reminded === true, next.said);
  const again = await who.call('storm_prep');
  check('the one after that says it more briefly', /^Today is still a stay-inside day for you\. /.test(again.said), again.said.slice(0, 80));
  await who.call('share_my_day', { action: 'leave' });
  const fourth = await who.call('my_profile');
  check('after three times it stops on its own', !/stay-inside day/.test(fourth.said), fourth.said);

  attention.resetForTest();
  await who.call('plan_my_day', { activity: 'a walk', minutes: 30 });
  const emergency = await who.call('warning_signs', { symptoms: 'she is confused and collapsed' });
  check('an emergency is never preceded by a reminder', /^That can be heat stroke/.test(emergency.said), emergency.said.slice(0, 60));
  const got = await who.call('weather_check', { heard: true });
  check('"got it" stops it, and says so', /I won't mention it again today/.test(got.said), got.said);
  const after = await who.call('my_profile');
  check('...and nothing more is said about it', !/stay-inside day/.test(after.said), after.said);
  check('"got it" with nothing to stop is just okay', (await who.call('weather_check', { heard: true })).said === 'Okay.');
  attention.remember('acct:reminder', '1999-01-01');
  check('a reminder from another day is not said today', !/stay-inside day/.test((await who.call('my_profile')).said));
  attention.resetForTest();
}

console.log('\nThe phone belongs to one visitor');
{
  check('another visitor sees nothing of it', notify.demoPhone('demo:ffffffffffffffffffffffffffffffff').length === 0);
  notify.toDemoPhone('acct:real', { to: 'x', subject: 's', text: 't', reason: 'help' });
  check('a linked account never gets a demo phone: its messages are real email', notify.demoPhone('acct:real').length === 0);
  for (let i = 0; i < 40; i += 1) notify.toDemoPhone(ID, { to: 'Priya', subject: 's', text: 't', reason: 'help' });
  check('the phone holds a bounded number of messages', notify.demoPhone(ID).length === 30);
  check('a message cannot be made enormous', (notify.toDemoPhone(ID, { to: 'P', subject: 's', text: 'x'.repeat(9000), reason: 'help' }), notify.demoPhone(ID).at(-1).text.length === 4000));
}

await new Promise((r) => listener.close(r));
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
