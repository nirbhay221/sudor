// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The things Sudor now does, not just says: removing what no longer applies,
 * keeping health details out of the room, learning from how an outing went,
 * and telling a family member, only once they have been confirmed.
 *
 * Emails go through a fake transport here, so nothing reaches SES.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

mkdirSync('./data', { recursive: true });
rmSync('./data/test-actions.json', { force: true });
rmSync('./data/test-outbox.jsonl', { force: true });
process.env.SUDOR_DATA = './data/test-actions.json';
process.env.SUDOR_OUTBOX = './data/test-outbox.jsonl';

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const notify = await import('./dist/notify.js');
const { checkHotDayAlerts } = await import('./dist/alerts.js');
const { profileOf, judgeHour } = await import('./dist/personal.js');
const { localToUtc } = await import('./dist/weather.js');
const { registerTools } = await import('./dist/tools.js');

const mails = [];
notify.configureForTest({ from: 'sudor@example.com', transport: async (email) => { mails.push(email); } });

const tools = {};
let who = 'tester';
registerTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => who);
const text = (r) => r.content[0].text;

// Phoenix: today mild in the morning, tomorrow hot all day.
//
// The dates come from the real clock. They used to be written in by hand, which
// meant the whole fixture quietly went stale at midnight and a passing suite
// started failing on a date nobody had changed.
const offset = -25200;
const localDate = (daysAhead) =>
  new Date(Date.now() + offset * 1000 + daysAhead * 86_400_000).toISOString().slice(0, 10);
const TODAY = localDate(0);
const TOMORROW = localDate(1);
const hourly = [];
for (const [date, temp] of [[TODAY, (h) => (h < 9 ? 76 : 100)], [TOMORROW, () => 104]]) {
  for (let h = 0; h < 24; h++) {
    const local = `${date}T${String(h).padStart(2, '0')}:00`;
    hourly.push({ local, time: localToUtc(local, offset), tempF: temp(h), humidityPct: 30, uvIndex: 7, isDay: h >= 6 && h < 19, aqi: 40 });
  }
}
const lat = 33.45, lon = -112.07;
weather.seedForTest({
  lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: offset,
  tempF: 100, humidityPct: 30, uvIndex: 7, isDay: true, aqi: 40, hourly, stale: false,
});
store.update(who, (p) => { p.lat = lat; p.lon = lon; p.locationName = 'Phoenix, Arizona'; p.locationStatus = 'ready'; });

console.log('\nTaking things back out');
await tools.medication({ action: 'add', name: 'metoprolol' });
await tools.medication({ action: 'add', name: 'lisinopril' });
await tools.health_condition({ action: 'add', condition: 'I have MS' });
const removedMed = await tools.medication({ action: 'remove', name: 'Lopressor' });
check('removing by brand name takes the generic off the list', /Removed metoprolol/.test(text(removedMed)) &&
  !store.get(who).medications.some((m) => m.generic === 'metoprolol'), text(removedMed));
check('removing something not on the list says so', /isn't on your list/.test(text(await tools.medication({ action: 'remove', name: 'zoloft' }))));
check('removing a condition works the way it is said', /Removed multiple sclerosis/.test(text(await tools.health_condition({ action: 'remove', condition: 'MS' }))) &&
  store.get(who).conditions.length === 0);
await tools.health_condition({ action: 'add', condition: 'multiple sclerosis' });
check('what do you know about me reads back the list', /lisinopril/.test(text(await tools.my_profile({}))) &&
  /multiple sclerosis/.test(text(await tools.my_profile({}))));

console.log('\nPrivacy mode keeps health details out of the room');
await tools.set_privacy({ on: true });
const privateCheck = text(await tools.weather_check({}));
check('the heat check names neither the condition nor a medication', !/sclerosis|MS\b|medication|lisinopril/i.test(privateCheck), privateCheck);
check('...but still says this person is at more risk', /health profile/.test(privateCheck), privateCheck);
const privateOut = text(await tools.going_out_now({}));
// Two steps are read at a time, so the line about the private ones may be on a later page: it is checked in the whole list.
const privateSteps = (await tools.going_out_now({})).structuredContent.steps.join(' ');
check('precautions hold back the personal ones and say how to hear them', /private precautions/.test(privateSteps) && !/cooling vest/.test(privateSteps) && !/cooling vest/.test(privateOut), privateSteps);
check('...and the heat stroke line is never held back', /call 911/.test(privateOut));
const allOut = await tools.going_out_now({ privatePrecautions: true });
check('asking for private precautions reads them', /cooling vest|Cool down before you go/.test(JSON.stringify(allOut.structuredContent.steps)));
check('privacy mode masks an email address read back', /p\*\*\*@example\.com/.test(text(await tools.contact({ action: 'add', name: 'Priya', email: 'priya@example.com', relation: 'daughter' }))));
await tools.set_privacy({ on: false });

console.log('\nLearning from how it went');
await tools.log_outing({ felt: 'fine' });
check('feeling fine never loosens anything', profileOf([], [], { outings: store.get(who).outings }).learnedLimitF === null);
const unwell = text(await tools.log_outing({ felt: 'unwell', minutes: 20 }));
const limit = store.get(who).outings.at(-1).heatIndexF;
check('feeling unwell records the heat index at the time', typeof limit === 'number', JSON.stringify(store.get(who).outings));
check('...and says it will treat that heat as the limit', new RegExp(`${limit}`).test(unwell), unwell);
const learned = profileOf([], [], { outings: store.get(who).outings });
check('a person with nothing else registered now avoids that heat',
  judgeHour({ local: '', time: '', tempF: 100, humidityPct: 30, uvIndex: 0, isDay: true, aqi: null }, learned).status === 'avoid');
check('...and the plan says why, whatever time of day the test runs',
  /felt unwell near heat index/.test(text(await tools.plan_my_day({ day: 'tomorrow' }))),
  text(await tools.plan_my_day({ day: 'tomorrow' })));

console.log('\nSaying it twice');
const beforeOutings = store.get(who).outings.length;
await tools.log_outing({ felt: 'unwell', minutes: 20 });
check('the same outing reported twice is recorded once', store.get(who).outings.length === beforeOutings,
  JSON.stringify(store.get(who).outings));
await tools.log_outing({ felt: 'unwell', minutes: 45 });
check('a different outing is still its own', store.get(who).outings.length === beforeOutings + 1);
store.update(who, (p) => { for (const o of p.outings) o.at = new Date(Date.now() - 10 * 60e3).toISOString(); });
await tools.log_outing({ felt: 'unwell', minutes: 20 });
check('ten minutes on it is a second afternoon, not a repeat', store.get(who).outings.length === beforeOutings + 2);

console.log('\nNobody is told anything until they are confirmed');
mails.length = 0;
const staged = text(await tools.contact({ action: 'add', name: 'Priya', email: 'priya@example.com', relation: 'daughter' }));
check('adding a contact only stages it, and asks', /Nothing is sent until you confirm/.test(staged) && store.get(who).contacts[0].confirmedAt === null, staged);
const early = await tools.warning_signs({ symptoms: 'he is confused and not sweating' });
await tick();
check('an emergency before confirmation emails nobody', mails.length === 0 && !/emailing/.test(text(early)), text(early));
check('...and still says call 911 first', /^This is an emergency. Call 911 now/.test(text(early)));
check('confirming the contact says so', /Done\. Priya will get an email/.test(text(await tools.contact({ action: 'confirm', name: 'priya' }))));
const emergency = await tools.warning_signs({ symptoms: 'he is confused and not sweating' });
await tick();
check('now an emergency emails the confirmed contact', mails.length === 1 && mails[0].to === 'priya@example.com', JSON.stringify(mails));
check('...and the answer says it is emailing her, after the 911 line', /Call 911 now[\s\S]*I'm emailing Priya now\./.test(text(emergency)), text(emergency));
check('heat exhaustion does not email anyone', (await tools.warning_signs({ symptoms: 'a bit dizzy' }), await tick(), mails.length === 1));

notify.configureForTest({ from: undefined });
const unconfigured = text(await tools.warning_signs({ symptoms: 'she fainted' }));
check('without email set up, it says it cannot email rather than pretending', /can't email Priya/.test(unconfigured), unconfigured);
notify.configureForTest({ from: 'sudor@example.com' });

console.log('\nStay-inside day, the evening before');
mails.length = 0;
const morning = await checkHotDayAlerts(new Date(localToUtc(`${TODAY}T10:00`, offset))); // 10 am in Phoenix
check('nothing goes out in the morning', morning.length === 0);
const evening = await checkHotDayAlerts(new Date(localToUtc(`${TODAY}T18:00`, offset))); // 6 pm in Phoenix, tomorrow hot all day
check('in the evening, a hot tomorrow emails the confirmed contact once', evening.length === 1 && mails.length === 1 &&
  /stay-inside day/.test(mails[0].subject), JSON.stringify(evening));
const again = await checkHotDayAlerts(new Date(localToUtc(`${TODAY}T19:00`, offset)));
check('...and never twice for the same day', again.length === 0 && mails.length === 1);

who = 'other';
store.update('other', (p) => {
  p.lat = lat; p.lon = lon; p.locationStatus = 'ready';
  p.conditions = ['multiple_sclerosis'];
  p.contacts = [{ name: 'Sam', email: 'sam@example.com', relation: null, notifyOn: ['hot_day'], addedAt: new Date().toISOString(), confirmedAt: null }];
});
mails.length = 0;
await checkHotDayAlerts(new Date(localToUtc(`${TODAY}T18:00`, offset)));
check('an unconfirmed contact is never emailed about a hot day', mails.length === 0);

who = 'tester';
check('removing a contact stops it', /Removed Priya/.test(text(await tools.contact({ action: 'remove', name: 'Priya' }))) && store.get('tester').contacts.length === 0);

rmSync('./data/test-actions.json', { force: true });
console.log('\nForgetting someone, asked for twice');
const before = store.get(who);
check('there is something to forget in the first place', before.medications.length > 0 || !!before.locationName);
const ask = text(await tools.my_profile({ action: 'forget' }));
check('asking to be forgotten says what would go, and does not do it yet',
  /can't undo it/.test(ask) && store.get(who).medications.length === before.medications.length, ask);
check('...and never reads the medicines out to do it', !/lisinopril|hydrochlorothiazide/i.test(ask), ask);
const done = text(await tools.my_profile({ action: 'forget' }));
const nothing = store.get(who);
check('asking again deletes the profile', /Done\./.test(done) &&
  !nothing.medications.length && !nothing.conditions.length && !nothing.contacts.length && !nothing.outings.length &&
  !nothing.locationName && !nothing.recallWatch.length && nothing.privacy === false,
  `${done} // ${JSON.stringify(nothing).slice(0, 160)}`);
check('...and an empty profile says there is nothing to forget',
  /nothing to forget/.test(text(await tools.my_profile({ action: 'forget' }))));

console.log('\nWhat the store will and will not hold');
const recordsBefore = Object.keys(JSON.parse(readFileSync('./data/test-actions.json', 'utf8') || '{}')).length;
store.get('demo:someone-who-never-writes');
store.get('demo:another-passer-by');
const afterReads = Object.keys(JSON.parse(readFileSync('./data/test-actions.json', 'utf8') || '{}')).length;
check('reading an id nobody has used does not create a record', afterReads === recordsBefore,
  `${recordsBefore} before, ${afterReads} after`);
check('...and still answers with an empty profile rather than throwing',
  store.get('demo:someone-who-never-writes').medications.length === 0);
store.update('demo:someone-who-writes', (p) => void (p.privacy = true));
const written = JSON.parse(readFileSync('./data/test-actions.json', 'utf8'));
check('writing does create one, and the file on disk is valid JSON afterwards',
  written['demo:someone-who-writes']?.privacy === true, Object.keys(written).join(', '));

console.log('\nWhat the store lets go of');
store.update('demo:pruning-test', (p) => {
  for (let i = 0; i < 1100; i++) p.outings.push({ at: new Date().toISOString(), felt: 'fine', heatIndexF: 90, minutes: 20, note: null });
  for (let i = 0; i < 500; i++) p.alertsSent.push(`hot_day:2026-01-${i}`);
});
const pruned = store.get('demo:pruning-test');
check('outings stop growing at the cap, oldest first', pruned.outings.length === 1000, String(pruned.outings.length));
check('...and the list of alerts already sent is capped too', pruned.alertsSent.length === 400);

store.update('acct:someone-real', (p) => void (p.privacy = true));
const expired = store.expireDemoRecords(Date.now() + 8 * 24 * 60 * 60 * 1000);
check('a demo profile untouched for a week is deleted, because it holds health details',
  expired >= 1 && store.get('demo:pruning-test').outings.length === 0, `${expired} expired`);
check('...and a linked account is never swept', store.get('acct:someone-real').privacy === true);
/*
 * The expiry clock used to live in a Map in memory, so a restart forgot every
 * timestamp and the seven day promise never fired on anything loaded from disk.
 * Since a deploy restarts the process, that made it decorative. This reloads
 * the store from the file the way a restart does, and checks the clock survived.
 */
store.update('demo:survives-restart', (p) => void (p.privacy = true));
const onDisk = JSON.parse(readFileSync('./data/test-actions.json', 'utf8'));
check('the touch timestamp is written into the record, not just remembered',
  typeof onDisk['demo:survives-restart'].touchedAt === 'string', JSON.stringify(Object.keys(onDisk['demo:survives-restart'])).slice(0, 120));
check('...so a record older than a week is expired even after a restart forgot it',
  (store.reloadForTest(),
    store.expireDemoRecords(Date.parse(onDisk['demo:survives-restart'].touchedAt) + 8 * 24 * 60 * 60 * 1000) >= 1));

check('...and a profile touched today survives',
  (store.update('demo:still-here', (p) => void (p.privacy = true)),
    store.expireDemoRecords(),
    store.get('demo:still-here').privacy === true));

console.log('\nWhatever the model hands over');
const markup = text(await tools.medication({ action: 'add', name: '<script>alert(1)</script>' }));
check('markup in a medication name never reaches the answer', !markup.includes('<'), markup);
const hugeCondition = text(await tools.health_condition({ action: 'add', condition: 'y'.repeat(5000) }));
check('a five thousand character condition is cut to something speakable', hugeCondition.length < 260, String(hugeCondition.length));
const spacedPlace = text(await tools.register_location({ place: '  Phoenix,   Arizona  ', lat, lon }));
check('ragged whitespace in a place is tidied', spacedPlace.includes('for Phoenix, Arizona.'), spacedPlace);

rmSync('./data/test-outbox.jsonl', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
