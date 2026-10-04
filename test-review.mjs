// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Defects found by reading the whole codebase, each pinned by a test.
 *
 * Every block here is a bug that shipped: the code was wrong, the existing tests passed, and somebody would
 * have been told something untrue about their own safety. The worst of them cut both ways. A number from the
 * weather forecast was read as a fever and answered with "call 911" and an email to the family, and on a five
 * degree morning somebody about to go out was told "conditions are fine for you right now".
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const DIR = './data/test-review';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_AUTH_DATA = `${DIR}/auth.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.SUDOR_DATA_KEY;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const warnings = await import('./dist/warnings.js');
const shelters = await import('./dist/shelters.js');
const spaceweather = await import('./dist/spaceweather.js');
const notify = await import('./dist/notify.js');
const domain = await import('./dist/domain.js');
const meds = await import('./dist/meds.js');
const personal = await import('./dist/personal.js');
const { triage } = await import('./dist/firstaid.js');
const { matchColdFirstAid } = await import('./dist/cold.js');
const { checkHotDayAlerts } = await import('./dist/alerts.js');
const { registerTools } = await import('./dist/tools.js');
const { speakErrorsPlainly } = await import('./dist/plainly.js');

// No network: anything that reaches for it fails fast, as it would on a bad day.
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
    const said = (r.content ?? []).map((c) => c.text ?? '').join(' ');
    // `text` is the whole answer: what is spoken first plus what is held for "tell me more". `spoken` is the short part.
    return { text: r.structuredContent?.full ?? said, spoken: said, data: r.structuredContent ?? {}, isError: r.isError };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

/** A two day forecast at a place, the same shape the real one is parsed into. */
function seed(lat, lon, temp, opts = {}) {
  const offset = opts.offset ?? -6 * 3600;
  const local = (ms) => new Date(ms + offset * 1000).toISOString();
  const today = local(Date.now()).slice(0, 10);
  const tomorrow = local(Date.now() + 86_400_000).slice(0, 10);
  const hourly = [];
  for (const date of [today, tomorrow]) {
    for (let h = 0; h < 24; h += 1) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      hourly.push({
        local: at, time: weather.localToUtc(at, offset), tempF: temp(h), humidityPct: opts.humidity ?? 40, uvIndex: 3,
        windMph: opts.wind ?? 10, isDay: h >= 7 && h < 18, aqi: 30, solarWm2: 200, wetBulbF: temp(h) - 5,
      });
    }
  }
  const nowHour = Number(local(Date.now()).slice(11, 13));
  weather.seedForTest({
    lat, lon, fetchedAt: opts.fetchedAt ?? new Date().toISOString(), timezone: 'America/Chicago', utcOffsetSeconds: offset,
    tempF: temp(nowHour), humidityPct: opts.humidity ?? 40, uvIndex: 3, windMph: opts.wind ?? 10, isDay: true, aqi: 30,
    solarWm2: 200, wetBulbF: temp(nowHour) - 5, hourly, stale: false,
  });
}
const place = (id, lat, lon, name) => store.update(id, (p) => { p.lat = lat; p.lon = lon; p.locationName = name; p.locationStatus = 'ready'; });

console.log('\nThe heat index follows the published method');
{
  check('79 degrees at 80 percent is 79.7, not 80.4', domain.heatIndexF(79, 80) === 79.7, String(domain.heatIndexF(79, 80)));
  check('...so it is not a "caution" day', domain.heatCategory(domain.heatIndexF(79, 80)) === 'none');
  check('the regression still takes over once it is hot', domain.heatIndexF(96, 50) > 105, String(domain.heatIndexF(96, 50)));
  // Found by breaking the code on purpose: nothing checked the band just above 80, where the full equation
  // has to take over from the simple one. These are the weather service's own chart values.
  check('86 degrees at 60 percent is 91, as the NWS chart has it', Math.round(domain.heatIndexF(86, 60)) === 91, String(domain.heatIndexF(86, 60)));
  check('84 degrees at 70 percent is 90, to within a degree', Math.abs(domain.heatIndexF(84, 70) - 90) <= 1, String(domain.heatIndexF(84, 70)));
  check('90 degrees at 70 percent is 105 or 106', [105, 106].includes(Math.round(domain.heatIndexF(90, 70))), String(domain.heatIndexF(90, 70)));
}

console.log('\nEvery sentence built from a medicine reads as a sentence');
{
  for (const [mechanism, guidance] of Object.entries(domain.GUIDANCE)) {
    const said = `Your medication ${meds.MECHANISM_LABEL[mechanism]}, so ${guidance}`;
    check(`${mechanism}`, !/, so (so|on top of the day\.|which)\b/.test(said) && /, so (you|your|heavy|drinking)\b/.test(said), said.slice(0, 110));
  }
}

console.log('\nA number in the weather is not a fever');
{
  const hot = triage("it's 108 out and I feel weak");
  check('"it\'s 108 out and I feel weak" is heat exhaustion, not a 911 call', hot.level === 'self_care', `${hot.level}: ${hot.matched.join(',')}`);
  check('the heat index said aloud is not a temperature', triage('the heat index is 110 and I have a headache').level === 'self_care');
  check('"the temperature outside is 105 and I am dizzy" is about outside', triage('the temperature outside is 105 and I am dizzy').level === 'self_care');
  const fever = triage('my temperature is 104');
  check('"my temperature is 104" is an emergency', fever.level === 'emergency' && fever.matched.includes('a temperature above 103'), fever.level);
  check('"she has a fever of 105" is an emergency', triage('she has a fever of 105').level === 'emergency');
}

console.log('\nA sign that is ruled out is not a sign');
{
  check('"I\'m not confused, just dizzy" is not heat stroke', triage("I'm not confused, just dizzy").level === 'self_care', triage("I'm not confused, just dizzy").level);
  check('"no fainting but I feel sick to my stomach" is not heat stroke', triage('no fainting but I feel sick to my stomach').level === 'self_care');
  check('"he hasn\'t passed out" is not heat stroke', triage("he hasn't passed out, he is just tired").level === 'self_care');
  check('a real sign after a ruled-out one still counts', triage("I'm not confused but I've stopped sweating").level === 'emergency');
  check('"confused and slurring" is still an emergency', triage('she is confused and slurring her words').level === 'emergency');
  check('"he fainted" is still an emergency', triage('he fainted in the garden').level === 'emergency');
  check('"not vomiting" is not vomiting', triage('dizzy, not vomiting').level === 'self_care');
}

console.log('\nIn the cold, tired is not hypothermia');
{
  const tired = matchColdFirstAid("I'm exhausted from shovelling");
  check('"exhausted from shovelling" is told to warm up, not to call 911', tired?.id === 'hypothermia_watch' && tired.emergency === false, JSON.stringify(tired && { id: tired.id, emergency: tired.emergency }));
  check('...and is told what would make it an emergency', /call 911/.test(tired?.say ?? ''));
  check('"a stiff neck" does not email the family', matchColdFirstAid('I have a stiff neck')?.emergency !== true);
  check('"he is not confused" matches nothing', matchColdFirstAid('he is not confused') === null);
  check('confusion is still an emergency', matchColdFirstAid('he is confused and slurring his words')?.emergency === true);
  check('shivering that has stopped is still an emergency', matchColdFirstAid('she has stopped shivering')?.id === 'hypothermia');
  check('numb fingers are still frostbite', matchColdFirstAid('my fingers are numb and look white')?.id === 'frostbite');
}

console.log('\nOnly real heat teaches a heat limit');
{
  const mild = personal.profileOf([], [], { outings: [{ felt: 'unwell', heatIndexF: 62 }] });
  check('feeling unwell at heat index 62 sets no limit (it used to make every day a stay-inside day)', mild.learnedLimitF === null, String(mild.learnedLimitF));
  check('feeling unwell at 95 does', personal.profileOf([], [], { outings: [{ felt: 'unwell', heatIndexF: 95 }] }).learnedLimitF === 95);
  const who = await connect('acct:mild');
  place('acct:mild', 44.98, -93.27, 'Minneapolis, Minnesota');
  seed(44.98, -93.27, () => 62);
  const r = await who.call('log_outing', { felt: 'unwell' });
  check('and the answer says why', /was not hot/.test(r.text) && r.data.learnedLimitF === null, r.text);
  await who.close();
}

console.log('\nA winter day');
{
  const lat = 46.88, lon = -96.79;
  // Five degrees at dawn, thirty by early afternoon, ten miles an hour of wind all day.
  const winter = (h) => (h < 8 ? 5 : h < 12 ? 15 : h < 16 ? 30 : 12);
  seed(lat, lon, winter);
  const snap = weather.current(lat, lon);
  const profile = personal.profileOf([], [], {});
  const now = new Date(`${snap.hourly[30].local.slice(0, 10)}T05:00:00Z`); // before dawn on the second day
  const plan = personal.planDay(snap, profile, { now: new Date(Date.now()), day: 'tomorrow', minutes: 60 });
  check('the best hour is the warmest part of the day, not dawn', /^(12|1|2|3) /.test(plan.best.label), `${plan.best.label} | ${plan.spoken}`);
  check('...and it is described by wind chill, not by a heat index of 20', /wind chill about/.test(plan.spoken) && !/heat index/.test(plan.spoken), plan.spoken);
  void now;

  seed(lat, lon, () => -25, { wind: 20 });
  const bitter = personal.planDay(weather.current(lat, lon), profile, { now: new Date(), day: 'tomorrow' });
  check('a day of dangerous wind chill is a stay-inside day', bitter.best.status === 'avoid' && /too cold/.test(bitter.spoken), bitter.spoken);

  const who = await connect('acct:winter');
  place('acct:winter', lat, lon, 'Fargo, North Dakota');
  await who.call('health_condition', { action: 'add', condition: 'heart disease' });
  seed(lat, lon, () => 5);
  const out = await who.call('going_out_now');
  check('going out at five degrees is not "conditions are fine"', !/Conditions are fine/.test(out.text) && out.data.season === 'cold', out.text);
  check('...it opens with the cold', /Wind chill -?\d+|degrees/.test(out.text), out.text.slice(0, 80));
  check('...and ends on what hypothermia looks like', out.data.steps.some((s) => /hypothermia: call 911/.test(s)));
  check('...and is never told to take water for the heat', !/sip it regularly/.test(out.text));
  await who.call('set_privacy', { on: true });
  const priv = await who.call('going_out_now');
  check('in privacy mode the cold advice holds the personal lines back', !/heart/i.test(priv.text) && priv.data.steps.some((s) => /private precautions/.test(s)), priv.text);
  await who.close();
}

console.log('\nAn email to a contact does not carry a diagnosis');
{
  const sent = [];
  notify.configureForTest({ from: 'sudor@example.com', transport: async (email) => void sent.push(email) });
  notify.resetEmailLimitsForTest();
  const id = 'acct:ms';
  const who = await connect(id);
  place(id, 33.45, -112.07, 'Phoenix, Arizona');
  seed(33.45, -112.07, () => 108, { offset: -7 * 3600 });
  await who.call('health_condition', { action: 'add', condition: 'multiple sclerosis' });
  await who.call('medication', { action: 'add', name: 'metoprolol' });
  await who.call('contact', { action: 'add', name: 'Priya', email: 'priya@example.com', when: 'hot_day' });
  await who.call('contact', { action: 'confirm', name: 'Priya' });
  // Evening where they are, whatever the time is here.
  const localMidnight = Date.parse(`${new Date(Date.now() - 7 * 3_600_000).toISOString().slice(0, 10)}T00:00:00Z`) + 7 * 3_600_000;
  await checkHotDayAlerts(new Date(localMidnight + 19 * 3_600_000));
  const mail = sent.find((m) => m.to === 'priya@example.com');
  check('the stay-inside email is sent', !!mail, JSON.stringify(sent.map((m) => m.subject)));
  check('it does not name the condition', mail && !/multiple sclerosis|\bMS\b/i.test(mail.text), mail?.text);
  check('it does not describe the medicine either', mail && !/sweating|medication/i.test(mail.text), mail?.text);
  check('it still says what the day is like', mail && /stay|hot|risky/i.test(mail.text));

  notify.resetEmailLimitsForTest();
  await who.call('contact', { action: 'add', name: 'Sam', email: 'sam@example.com', when: 'emergency' });
  await who.call('contact', { action: 'confirm', name: 'Sam' });
  sent.length = 0;
  for (let i = 0; i < 8; i += 1) await who.call('warning_signs', { symptoms: 'he is confused and has fainted' });
  await new Promise((r) => setTimeout(r, 50));
  const alarms = sent.filter((m) => m.to === 'sam@example.com').length;
  check('repeating an emergency cannot bury the contact in email', alarms === 3, String(alarms));
  const out = readFileSync(`${DIR}/outbox.jsonl`, 'utf8');
  check('the outbox holds no address and no subject', !/example\.com/.test(out) && !/stay-inside|Heat emergency/.test(out), out.slice(0, 140));
  await who.close();
}

console.log('\nOld data is not "right now"');
{
  const id = 'acct:stale';
  const who = await connect(id);
  place(id, 30.27, -97.74, 'Austin, Texas');
  seed(30.27, -97.74, () => 99, { fetchedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() });
  const r = await who.call('weather_check');
  check('a reading five hours old is not spoken as the heat right now', r.data.unavailable === true && /can't reach the weather service/.test(r.text), r.text);
  seed(30.27, -97.74, () => 99);
  check('a fresh one is', /Heat index/.test((await who.call('weather_check')).text));

  const heat = { id: 'a', event: 'Heat Advisory', kind: 'heat', severity: 'Moderate', urgency: 'Expected', headline: '', instruction: null, areaDesc: 'Travis', onset: null, ends: null };
  warnings.seedForTest(30.27, -97.74, [], Date.now() - 2 * 3_600_000);
  const old = await who.call('weather_warnings');
  check('"no warnings" from two hours ago is not repeated as "no warnings"', old.data.checked === false && /last reached the weather service/.test(old.text), old.text);
  warnings.seedForTest(30.27, -97.74, [heat]);
  await who.call('medication', { action: 'add', name: 'metoprolol' });
  const live = await who.call('weather_warnings');
  check('the sentence about the person is a sentence', !/Being because|Being with/.test(live.text) && /makes heat harder on you/.test(live.text), live.text);
  check('an event with "notice" or "service" in it is not an ice storm', warnings.classify('Special Weather Service Notice') === 'other' && warnings.classify('Ice Storm Warning') !== 'other');
  await who.close();
}

console.log('\nThe list of medicines');
{
  const id = 'acct:list';
  const who = await connect(id);
  const add = await who.call('medication', { action: 'add', name: 'insulin glargine' });
  check('a medicine it does not know is kept for recall watching', add.data.recallWatch === true, add.text);
  const profile = await who.call('my_profile');
  check('...and is read back, instead of "No medications"', /insulin glargine/.test(profile.text) && !/No medications/.test(profile.text), profile.text);
  const prep = await who.call('storm_prep');
  check('insulin named as a medicine gets the fridge advice (it needed the word diabetes before)', /Insulin keeps best between 36 and 46/.test(prep.text), prep.text.slice(0, 200));
  const gone = await who.call('medication', { action: 'remove', name: 'insulin glargine' });
  check('it can be taken off again (it could not be)', gone.data.removed === true && store.get(id).recallWatch.length === 0, gone.text);
  await who.call('medication', { action: 'add', name: 'Ozempic' });
  check('a pen that lives in the fridge is mentioned before a power cut', /semaglutide pen is meant to be kept in the fridge/.test((await who.call('storm_prep')).text));
  await who.close();
}

console.log('\nSomewhere to go, said so it can be found');
{
  const id = 'acct:shelter';
  const who = await connect(id);
  place(id, 29.76, -95.37, 'Houston, Texas');
  seed(29.76, -95.37, () => 40);
  shelters.seedForTest([{ name: 'Lincoln High School', address: '1200 Main Street', city: 'Houston', state: 'TX', lat: 29.77, lon: -95.36, generator: true, accessible: true, pets: null }]);
  const r = await who.call('somewhere_to_go');
  check('the address is spoken, not only shown', /Lincoln High School, at 1200 Main Street in Houston/.test(r.text), r.text);
  await who.close();
}

console.log('\nA place nobody is at is no longer followed');
{
  const id = 'acct:mover';
  const who = await connect(id);
  const before = weather.watched().accounts + weather.watched().sandbox;
  for (let i = 0; i < 6; i += 1) await who.call('register_location', { place: `Town ${i}`, lat: 35 + i, lon: -100 });
  const after = weather.watched().accounts + weather.watched().sandbox;
  check('moving six times leaves one place being polled, not six', after - before === 1, `${before} -> ${after}`);
  await who.call('my_profile', { action: 'forget' });
  await who.call('my_profile', { action: 'forget' });
  check('and forgetting the person stops that one too', weather.watched().accounts + weather.watched().sandbox === before, JSON.stringify(weather.watched()));
  check('forgetting deletes the record', !store.allEntries().some(([k]) => k === id));
  const blank = await who.call('register_location', { place: '<>' });
  check('a place with no name is asked for again', blank.data.status === 'needs_place', blank.text);
  await who.close();
  weather.stopAll();
}

console.log('\nSpace weather, said as a day');
{
  const said = spaceweather.speak({ g: 4, when: '2026-10-06', peakKp: 8, fetchedAt: Date.now() });
  check('a date is a day of the week, not 2026-10-06', /on Tuesday, October 6/.test(said) && !/2026-10-06/.test(said), said.slice(0, 120));
  check('today is still today', /forecast today/.test(spaceweather.speak({ g: 4, when: 'today', peakKp: 8, fetchedAt: Date.now() })));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
