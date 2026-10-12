/**
 * The design of the conversation, tested.
 *
 * The rest of the suite checks that answers are right. This checks that they can be listened to and acted on:
 * short, with the rest held for when it is asked for; ending in a next step; shown on a card that fits the
 * task; and open to the second person, the family member, who hears how the day is and nothing about health.
 * It runs with the DEFAULT scope, the tools a customer actually gets.
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const DIR = './data/test-design';
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
const brief = await import('./dist/brief.js');
const { registerTools, SECONDARY_TOOLS, MERGED_AWAY } = await import('./dist/tools.js');
const { speakErrorsPlainly } = await import('./dist/plainly.js');
globalThis.fetch = async () => { throw new Error('network is off for this test'); };

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const words = (s) => s.split(/\s+/).filter(Boolean).length;

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
  return { call, tools: async () => (await client.listTools()).tools, close: async () => { await client.close(); await server.close(); } };
}

function seed(lat, lon, temp) {
  const offset = -7 * 3600;
  const local = (ms) => new Date(ms + offset * 1000).toISOString();
  const hourly = [];
  for (const date of [local(Date.now()).slice(0, 10), local(Date.now() + 86_400_000).slice(0, 10)]) {
    for (let h = 0; h < 24; h += 1) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      hourly.push({ local: at, time: weather.localToUtc(at, offset), tempF: temp(h), humidityPct: 30, uvIndex: 7, windMph: 5, isDay: h >= 6 && h < 19, aqi: 40, solarWm2: 600, wetBulbF: temp(h) - 20 });
    }
  }
  const h = Number(local(Date.now()).slice(11, 13));
  weather.seedForTest({ lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: offset, tempF: temp(h), humidityPct: 30, uvIndex: 7, windMph: 5, isDay: true, aqi: 40, solarWm2: 600, wetBulbF: temp(h) - 20, hourly, stale: false });
}

console.log('\nOne story: the tools a customer gets by default');
const mum = await connect('acct:mum');
{
  const names = (await mum.tools()).map((t) => t.name);
  check('shovelling, warnings, sunburn and recalls are not published by default', SECONDARY_TOOLS.every((n) => !names.includes(n)), names.join(','));
  check('the heat and cold story is all there', ['weather_check', 'plan_my_day', 'going_out_now', 'warning_signs', 'log_outing', 'about_me', 'contact'].every((n) => names.includes(n)));
  process.env.SUDOR_SCOPE = 'all';
  const all = await connect('acct:all');
  const allNames = (await all.tools()).map((t) => t.name);
  check('with the scope set to all, they are published', SECONDARY_TOOLS.every((n) => allNames.includes(n)) && MERGED_AWAY.every((n) => allNames.includes(n) && !names.includes(n)) && !allNames.includes('about_me') && names.length === 13, `${names.length} ${names.join(',')}`);
  await all.close();
  delete process.env.SUDOR_SCOPE;
}

console.log('\nAnswers are short, and the rest is kept for when it is asked for');
{
  store.update('acct:mum', (p) => { p.lat = 33.45; p.lon = -112.07; p.locationName = 'Phoenix, Arizona'; p.locationStatus = 'ready'; });
  seed(33.45, -112.07, () => 108);
  await mum.call('medication', { action: 'add', name: 'metoprolol' });
  await mum.call('medication', { action: 'add', name: 'Lasix' });
  await mum.call('health_condition', { action: 'add', condition: 'multiple sclerosis' });
  const r = await mum.call('weather_check');
  check('the spoken answer is at most seventy five words, next step included', words(r.said) <= 75, `${words(r.said)}: ${r.said}`);
  check('it leads with the answer for this person', /^For you, it is better to stay in/.test(r.said), r.said.slice(0, 60));
  check('then how it feels, in plain words', /It feels like \d+ degrees/.test(brief.sentences(r.said)[1]), r.said);
  check('the line about not stopping a medicine is said too', /Keep taking it unless your doctor says otherwise/.test(r.said), r.said);
  check('the rest of the answer is still returned, once, and the whole of it is not repeated', Array.isArray(r.data.more) && r.data.more.length > 0 && r.data.full === undefined);
  check('told to stay in, with nothing known about the cooling, it ends on that one question', /Staying in only helps if your cooling works\. Is it working\?$/.test(r.said) && r.data.asks === 'cooling', r.said.slice(-70));
  const again = await mum.call('weather_check');
  check('asked once: after that it ends on the next step', /Want me to find the safest time to go out today\?$/.test(again.said) && again.data.nextAction?.tool === 'plan_my_day', again.said.slice(-70));
  const more = await mum.call('tell_me_more');
  check('"tell me more" continues', more.said.length > 20 && !/nothing more/.test(more.said), more.said);

  const out = await mum.call('going_out_now');
  check('precautions are read two at a time', out.data.nextStep === 2, String(out.data.nextStep));
  check('...and always end on what heat stroke looks like', /call 911/.test(out.said));
  const rest = await mum.call('going_out_now', { step: out.data.nextStep });
  check('asking for the rest reads the next two', rest.said.length > 20 && !rest.said.startsWith('It is heat index'));

  const signs = await mum.call('warning_signs', { symptoms: 'she is confused and has fainted' });
  check('an emergency is never shortened', /Call 911 now/.test(signs.said) && /Give them nothing to drink and no fever medicine/.test(signs.said) && !signs.data.more, signs.said);
  check('...and comes with the one card that has to be read from across the room', signs.data.card?.title === 'Call 911 now' && signs.data.card.status.tone === 'bad');
  check('"what can you do" is under sixty words (it was 116)', words((await mum.call('what_can_you_do')).said) <= 60);

  // Found by breaking the code on purpose: nothing here checked the rule itself.
  const long = (text, extra = {}) => ({ content: [{ type: 'text', text }], structuredContent: extra });
  check('a read-only answer that mentions 911 is never cut', brief.shorten(long('One. Two. Three. Four. If they collapse call 911. Six.'), 'x', { readOnly: true }).content[0].text === 'One. Two. Three. Four. If they collapse call 911. Six.');
  check('control: the same answer without it is cut', brief.shorten(long('One. Two. Three. Four. Five. Six.'), 'x', { readOnly: true }).content[0].text !== 'One. Two. Three. Four. Five. Six.');
  check('a checklist marked to be heard whole is never cut', brief.shorten(long('One. Two. Three. Four. Five. Six.', { fullAnswer: true }), 'x', { readOnly: true }).content[0].text === 'One. Two. Three. Four. Five. Six.');

  const plan = await mum.call('plan_my_day');
  check('a stay-inside day with nobody set to hear about it offers to tell somebody', /Want a family member told before days like this\?/.test(plan.said), plan.said);
}

console.log('\nA card that fits the task');
{
  const stage = await mum.call('contact', { action: 'add', name: 'Priya', email: 'priya@example.com', relation: 'daughter' });
  check('adding somebody returns a commit card saying what yes will do', /Say yes to add Priya/.test(stage.data.card?.confirm ?? '') && stage.data.card.lines.includes('priya@example.com'));
  const profile = await mum.call('my_profile');
  check('the profile is a list', profile.data.card?.kind === 'list' && profile.data.card.items.length === 4);
  check('...that shows how many medicines and conditions, not which, on a screen others can see', !/metoprolol|sclerosis|furosemide/i.test(JSON.stringify(profile.data.card)));
  const tools = await mum.tools();
  const ui = (n) => tools.find((t) => t.name === n)?._meta?.ui?.resourceUri;
  check('the day strip is still the view for the weather', ui('weather_check') === 'ui://sudor/window.html');
  check('the profile, the emergency and sharing use the card view', ['about_me', 'warning_signs', 'share_my_day'].every((n) => ui(n) === 'ui://sudor/card.html'), ['about_me', 'warning_signs', 'share_my_day'].map(ui).join(','));

  const sent = [];
  const view = new JSDOM(readFileSync('ui/card.html', 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) { Object.defineProperty(window, 'parent', { value: { postMessage: (m) => sent.push(m) } }); },
  });
  await new Promise((r) => setTimeout(r, 20));
  const init = sent.find((m) => m.method === 'ui/initialize');
  check('the view sends ui/initialize before anything else', !!init && init.params.protocolVersion === '2026-01-26');
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { jsonrpc: '2.0', id: init.id, result: {} } }));
  await new Promise((r) => setTimeout(r, 20));
  check('it confirms with initialized', sent.some((m) => m.method === 'ui/notifications/initialized'));
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { card: { kind: 'card', title: 'Call 911 now', status: { label: 'emergency', tone: 'bad' }, lines: ['Move them somewhere <b>cool</b>.'] } } } } }));
  await new Promise((r) => setTimeout(r, 20));
  const doc = view.window.document;
  check('it draws the card it is sent', doc.getElementById('title').textContent === 'Call 911 now' && doc.querySelectorAll('#lines p').length === 1);
  check('markup in a line is shown as text, never run', doc.querySelector('#lines b') === null);
  check('the status is a word with a mark, not a colour alone', /× emergency/.test(doc.getElementById('chip').textContent));
  view.window.close();
}

console.log('\nA family member can ask for themselves, and hears nothing about health');
{
  const priya = await connect('acct:priya');
  check('before joining, there is nobody to check on', (await priya.call('check_on')).data.sharing === false);
  const invite = await mum.call('share_my_day', { action: 'invite' });
  const code = invite.data.code;
  check('the person gets an eight digit code, read out in two groups', /^\d{8}$/.test(code) && invite.said.includes(code.slice(0, 4).split('').join(' ')));
  check('the code is not stored, only its hash', !readFileSync(`${DIR}/people.json`, 'utf8').includes(code));
  check('a wrong code does not work', (await priya.call('share_my_day', { action: 'join', code: '00000000' })).data.joined === false);
  check('the right code does', (await priya.call('share_my_day', { action: 'join', code })).data.joined === true);
  const mallory = await connect('acct:mallory');
  check('the code works once', (await mallory.call('share_my_day', { action: 'join', code })).data.joined === false);
  await mallory.close();

  const day = await priya.call('check_on');
  check('she hears how the day is, where they are', /Phoenix, Arizona/.test(day.said) && /stay in|take care|fine time/.test(day.said), day.said);
  check('judged with everything known: 108 degrees with these medicines is a stay-in day', day.data.status === 'avoid', day.data.status);
  const everything = JSON.stringify(day);
  check('she hears no medicine, no condition and no reason', !/metoprolol|lasix|furosemide|sclerosis|\bMS\b|medication|sweating|health profile|condition/i.test(everything), everything.slice(0, 300));
  check('her own tools still answer about her, not about her mother', /don't know where you are yet/.test((await priya.call('weather_check')).said));
  check('she cannot read the profile', !/metoprolol/i.test(JSON.stringify(await priya.call('my_profile'))));
  await priya.call('medication', { action: 'add', name: 'lisinopril' });
  check('what she writes goes to her own record', !store.get('acct:mum').medications.some((m) => m.generic === 'lisinopril'));

  check('the person can end it', (await mum.call('share_my_day', { action: 'stop' })).data.stopped === 1);
  check('and it ends at once', (await priya.call('check_on')).data.sharing === false);
  let refused = 0;
  for (let i = 0; i < 9; i += 1) if ((await priya.call('share_my_day', { action: 'join', code: String(10000000 + i) })).data.reason === 'limit') refused += 1;
  check('guessing codes is cut off', refused >= 3, String(refused));
  await priya.close();
}

await mum.close();
weather.stopAll();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
