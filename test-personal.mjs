/**
 * A person's day around the heat: conditions, planning, going out anyway,
 * warning signs, places and timezones.
 *
 * The dangerous failures here are specific. Telling someone with
 * erythromelalgia to use ice. Telling someone on dialysis to drink more.
 * Telling a confused, overheated person to sip water. Saying 11 am when it is
 * 6 am where they live. Each has a test.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { CONDITIONS, findCondition } from './dist/conditions.js';
import { profileOf, judgeHour, planDay, precautions, spanLabel } from './dist/personal.js';
import { triage } from './dist/firstaid.js';
import { splitQuery, pickPlace } from './dist/geocode.js';
import { localToUtc, parseForecast } from './dist/weather.js';
import { heatIndexF } from './dist/domain.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const hour = (tempF, humidityPct, extra = {}) => ({ local: '2026-09-14T12:00', time: '2026-09-14T19:00:00.000Z', tempF, humidityPct, uvIndex: 0, isDay: true, aqi: null, ...extra });

console.log('\nConditions are recognised the way people say them');
check('"I have MS" is multiple sclerosis', findCondition('I have MS')?.id === 'multiple_sclerosis');
check('"my husband is on dialysis" is kidney disease', findCondition('my husband is on dialysis')?.id === 'kidney_disease');
check('"type 2 diabetes" is diabetes', findCondition('type 2 diabetes')?.id === 'diabetes');
check('"erythromelalgia" is recognised', findCondition('Erythromelalgia')?.id === 'erythromelalgia');
check('"arms" does not match MS', findCondition('I hurt my arms') === null);
check('something unknown is not guessed', findCondition('a sore thumb') === null);

/*
 * The aliases were all categories, "older adult", "senior", "over 65", and
 * nobody describes themselves that way. A shelter test written in a real
 * sentence, "I am 80 years old", matched nothing at all, which meant the whole
 * indoor-hypothermia half of the cold advice never reached the people it was
 * written for. Sixty-five is where the CDC and the NIA draw the line, and "is"
 * is in the pattern because a daughter setting this up says "my mother is 88".
 */
for (const said of ['I am 80 years old', "I'm 78", 'aged 91', '65 years old', 'my mother is 88', 'she is 91'])
  check(`"${said}" is heard as age 65 or over`, findCondition(said)?.id === 'older_adult', String(findCondition(said)?.id));
for (const said of ['I am 40', '64 years old', 'I take 80 mg of something', 'I am 7'])
  check(`"${said}" is not`, findCondition(said)?.id !== 'older_adult', String(findCondition(said)?.id));
check('every condition names an https source',
  CONDITIONS.every((c) => c.sources.length && c.sources.every((s) => /^https:\/\//.test(s.url))));
check('no em dashes in condition advice', !/[\u2013\u2014]/.test(JSON.stringify(CONDITIONS)));

console.log('\nSensitivity follows the HeatRisk groups');
check('nothing registered is the general public', profileOf([], []).sensitivity === 'general');
check('a medication that blunts thirst makes you sensitive', profileOf(['reduced_thirst_or_sedation'], []).sensitivity === 'sensitive');
check('a medication that blocks sweating makes you extremely sensitive', profileOf(['reduced_sweating'], []).sensitivity === 'extreme');
check('MS makes you extremely sensitive, and says why',
  profileOf([], ['multiple_sclerosis']).sensitivity === 'extreme' && /multiple sclerosis/.test(profileOf([], ['multiple_sclerosis']).because));
check('asthma is sensitive and brings air quality into it',
  profileOf([], ['asthma_copd']).sensitivity === 'sensitive' && profileOf([], ['asthma_copd']).airQuality);
check('photosensitivity alone does not change heat sensitivity', profileOf(['photosensitivity'], []).sensitivity === 'general');

console.log('\nThe same hour is judged differently for different people');
const mild = hour(84, 40);
check(`heat index ${Math.round(heatIndexF(84, 40))} is fine for most people`, judgeHour(mild, profileOf([], [])).status === 'good');
check('...a time for care if you are sensitive', judgeHour(mild, profileOf([], ['diabetes'])).status === 'caution');
check('...and better spent inside with MS', judgeHour(mild, profileOf([], ['multiple_sclerosis'])).status === 'avoid');
const hot = hour(95, 40);
check(`heat index ${Math.round(heatIndexF(95, 40))} is care for most people`, judgeHour(hot, profileOf([], [])).status === 'caution');
check('...and stay in if you are sensitive', judgeHour(hot, profileOf([], ['pregnancy'])).status === 'avoid');
check('danger is stay in for everyone', judgeHour(hour(105, 35), profileOf([], [])).status === 'avoid');
check('high UV raises care for a photosensitive medication in daylight',
  judgeHour(hour(70, 40, { uvIndex: 8 }), profileOf(['photosensitivity'], [])).status === 'caution');
check('...but not at night', judgeHour(hour(70, 40, { uvIndex: 8, isDay: false }), profileOf(['photosensitivity'], [])).status === 'good');
check('AQI 120 is care for asthma', judgeHour(hour(70, 40, { aqi: 120 }), profileOf([], ['asthma_copd'])).status === 'caution');
check('AQI 160 is stay in for asthma', judgeHour(hour(70, 40, { aqi: 160 }), profileOf([], ['asthma_copd'])).status === 'avoid');
check('AQI does not touch someone without a heart or lung condition', judgeHour(hour(70, 40, { aqi: 160 }), profileOf([], [])).status === 'good');

console.log('\nTimes are said where the person lives');
check('3 pm in Phoenix is 10 pm UTC', localToUtc('2026-09-12T15:00', -25200) === '2026-09-12T22:00:00.000Z');
const parsed = parseForecast(33.45, -112.07, {
  timezone: 'America/Phoenix', utc_offset_seconds: -25200,
  current: { temperature_2m: 98, relative_humidity_2m: 30, uv_index: 1, is_day: 1 },
  hourly: { time: ['2026-09-12T06:00', '2026-09-12T07:00'], temperature_2m: [80, 82], relative_humidity_2m: [40, 38], uv_index: [0, 1], is_day: [1, 1] },
}, { current: { us_aqi: 44 }, hourly: { time: ['2026-09-12T07:00', '2026-09-12T06:00'], us_aqi: [50, 40] } });
check('forecast hours keep the local wall clock and a true UTC time',
  parsed.hourly[0].local === '2026-09-12T06:00' && parsed.hourly[0].time === '2026-09-12T13:00:00.000Z');
check('air quality is joined by the hour it belongs to, not by position', parsed.hourly[0].aqi === 40 && parsed.hourly[1].aqi === 50);
check('a missing air quality answer is unknown, not zero',
  parseForecast(0, 0, { utc_offset_seconds: 0, current: { temperature_2m: 70, relative_humidity_2m: 40 }, hourly: { time: ['2026-09-12T06:00'], temperature_2m: [70], relative_humidity_2m: [40] } }, null).hourly[0].aqi === null);
check('spans are said the way people say them',
  spanLabel('2026-09-12T06:00', 3) === '6 to 9 am' && spanLabel('2026-09-12T11:00', 8) === '11 am to 7 pm' && spanLabel('2026-09-12T21:00', 3) === '9 pm to 12 am',
  `${spanLabel('2026-09-12T06:00', 3)} | ${spanLabel('2026-09-12T11:00', 8)} | ${spanLabel('2026-09-12T21:00', 3)}`);

console.log('\nPlanning a day');
const temps = { 6: 76, 7: 78, 8: 79, 9: 86, 10: 92, 11: 97, 12: 101, 13: 104, 14: 106, 15: 107, 16: 106, 17: 103, 18: 98, 19: 92, 20: 86, 21: 82 };
const phoenix = {
  lat: 33.45, lon: -112.07, fetchedAt: '2026-09-14T12:00:00.000Z', timezone: 'America/Phoenix', utcOffsetSeconds: -25200,
  tempF: 76, humidityPct: 30, uvIndex: 0, isDay: false, aqi: 40, stale: false,
  hourly: ['2026-09-14', '2026-09-15'].flatMap((date) => Array.from({ length: 24 }, (_, h) => {
    const local = `${date}T${String(h).padStart(2, '0')}:00`;
    return { local, time: localToUtc(local, -25200), tempF: temps[h] ?? 74, humidityPct: 25, uvIndex: h > 8 && h < 17 ? 8 : 0, isDay: h >= 6 && h < 19, aqi: 40 };
  })),
};
const at5am = new Date('2026-09-14T12:00:00Z'); // 5 am in Phoenix
const ms = profileOf([], ['multiple_sclerosis']);
const plan = planDay(phoenix, ms, { now: at5am, activity: 'a walk', minutes: 60 });
check('with MS the best time for a walk is early morning', /6 to 9 am/.test(plan.spoken), plan.spoken);
check('...it names the hours to avoid', plan.worst && /Avoid/.test(plan.spoken), plan.spoken);
check('...and says why it is judged that way', /multiple sclerosis/.test(plan.spoken), plan.spoken);
check('the plan uses Phoenix hours, not this machine\'s', plan.hours[0].local === '2026-09-14T06:00', plan.hours[0]?.local);
const general = planDay(phoenix, profileOf([], []), { now: at5am, minutes: 60 });
check('the same day has a longer good stretch for most people', general.best.hours > plan.best.hours, `${general.best?.label} vs ${plan.best?.label}`);
const tooLong = planDay(phoenix, ms, { now: at5am, minutes: 300 });
check('a five hour errand with no comfortable stretch still gets the least risky time, and precautions',
  tooLong.best && tooLong.best.status !== 'good' && /least risky/.test(tooLong.spoken) && /precautions/.test(tooLong.spoken),
  tooLong.spoken);
check('...and never tells someone to avoid the very hours it just recommended',
  !plan.worst || !plan.hours.some((h) => h.local === plan.best.startLocal && plan.worst.startLocal <= h.local &&
    h.local < plan.worst.startLocal.slice(0, 11) + String(Number(plan.worst.startLocal.slice(11, 13)) + plan.worst.hours).padStart(2, '0') + ':00'));
const hotDay = planDay(phoenix, ms, { now: at5am, day: 'tomorrow', minutes: 60, activity: 'groceries' });
check('a plan always names a time while any daytime hours remain', hotDay.best !== null && /groceries/.test(hotDay.spoken), hotDay.spoken);
const tomorrow = planDay(phoenix, ms, { now: at5am, day: 'tomorrow' });
check('tomorrow plans the next local date', tomorrow.date === '2026-09-15' && tomorrow.hours[0].local.startsWith('2026-09-15'), tomorrow.date);
const late = planDay(phoenix, ms, { now: new Date('2026-09-15T06:00:00Z') }); // 11 pm local
check('late at night it says the day is over and offers tomorrow', /Ask me about tomorrow/.test(late.spoken), late.spoken);

console.log('\nGoing out anyway');
const inHeat = judgeHour(hour(104, 30, { uvIndex: 9 }), profileOf([], []));
const em = precautions(inHeat, profileOf([], ['erythromelalgia']));
check('erythromelalgia is told cool water, never ice', em.steps.some((s) => /never ice/.test(s)) && !em.steps.some((s) => /ice pack|ice bath/i.test(s)));
const kidney = precautions(inHeat, profileOf([], ['kidney_disease']));
check('kidney disease is never told to just drink more', !kidney.steps.some((s) => /Take water/.test(s)) && kidney.steps.some((s) => /fluid plan/.test(s)));
const thirsty = precautions(inHeat, profileOf(['reduced_thirst_or_sedation'], []));
check('a medication that blunts thirst means sipping on a schedule', thirsty.steps.some((s) => /on a schedule/.test(s)));
const photo = precautions(judgeHour(hour(80, 30, { uvIndex: 9 }), profileOf(['photosensitivity'], [])), profileOf(['photosensitivity'], []));
check('a photosensitive medication in high UV gets the EPA sun advice', photo.steps.some((s) => /SPF 15/.test(s)));
const insulin = precautions(inHeat, profileOf([], ['diabetes']));
check('insulin is kept below 86 degrees', insulin.steps.some((s) => /86 degrees/.test(s)));
const many = precautions(inHeat, profileOf(['reduced_sweating'], ['multiple_sclerosis', 'diabetes']));
check('never more than three precautions read at once, with the rest offered', many.nextStep === 3 && /ask me for the rest/.test(many.spoken), many.spoken);
check('the heat stroke line is always spoken, however long the list', [em, kidney, thirsty, photo, insulin, many].every((p) => /call 911/.test(p.spoken)));
const rest = precautions(inHeat, profileOf(['reduced_sweating'], ['multiple_sclerosis', 'diabetes']), many.nextStep);
check('asking for the rest reads the next ones and still ends on 911', /call 911/.test(rest.spoken) && !rest.spoken.startsWith('It is heat index'), rest.spoken);

console.log('\nWarning signs, the part that must never be wrong');
const confused = triage('she seems confused and she stopped sweating');
check('confusion is an emergency: call 911', confused.level === 'emergency' && /Call 911 now/.test(confused.spoken));
check('...and nothing to drink', /Do not give them anything to drink/.test(confused.spoken));
check('fainting is treated as an emergency, erring toward the call', triage('he fainted in the garden').level === 'emergency');
const dizzy = triage('I feel dizzy and I am sweating a lot');
check('dizziness and heavy sweating is heat exhaustion with the one hour rule', dizzy.level === 'self_care' && /longer than an hour/.test(dizzy.spoken), dizzy.spoken);
check('...but past an hour it is urgent', triage('dizzy and weak', undefined, 90).level === 'urgent');
check('vomiting is urgent and no sips of water are suggested', triage('I threw up').level === 'urgent' && !/sip water/.test(triage('I threw up').spoken));
check('cramps get the cramp advice', triage('cramps in my legs').level === 'cramps');
check('erythromelalgia cooling says not icy', /not icy/.test(triage('dizzy', profileOf([], ['erythromelalgia'])).spoken));
check('kidney disease sipping stays within the fluid plan', /within your fluid plan/.test(triage('dizzy', profileOf([], ['kidney_disease'])).spoken));
check('no symptoms given still teaches both sets of signs, with 911', triage('').level === 'info' && /call 911/.test(triage('').spoken));

console.log('\nPlaces, spoken the way people say them');
check('"Phoenix, AZ"', JSON.stringify(splitQuery('Phoenix, AZ')) === JSON.stringify({ name: 'Phoenix', state: 'Arizona' }));
check('"Kansas City Missouri"', JSON.stringify(splitQuery('Kansas City Missouri')) === JSON.stringify({ name: 'Kansas City', state: 'Missouri' }));
check('"Albany New York" takes the two word state', JSON.stringify(splitQuery('Albany New York')) === JSON.stringify({ name: 'Albany', state: 'New York' }));
check('"Washington" alone stays a place name', JSON.stringify(splitQuery('Washington')) === JSON.stringify({ name: 'Washington', state: null }));
check('a zip code passes straight through', splitQuery('85004').name === '85004');
const springfields = [
  { name: 'Springfield', admin1: 'Illinois', latitude: 39.8, longitude: -89.6, timezone: 'America/Chicago', country_code: 'US' },
  { name: 'Springfield', admin1: 'Missouri', latitude: 37.2, longitude: -93.3, timezone: 'America/Chicago', country_code: 'US' },
];
check('the named state picks the right Springfield', pickPlace('Springfield, Missouri', springfields)?.state === 'Missouri');
check('no state picks the most prominent', pickPlace('Springfield', springfields)?.state === 'Illinois');
check('a state with no match is not replaced by a wrong one', pickPlace('Springfield, Alaska', springfields) === null);

console.log('\nThe tools, end to end, with seeded data and no network');
mkdirSync('./data', { recursive: true });
rmSync('./data/test-tools.json', { force: true });
process.env.SUDOR_DATA = './data/test-tools.json';
const store = await import('./dist/store.js');
const weatherMod = await import('./dist/weather.js');
const { registerTools } = await import('./dist/tools.js');
const handlers = {};
const configs = {};
registerTools({ registerTool: (name, config, handler) => { handlers[name] = handler; configs[name] = config; } }, () => 'tester');
weatherMod.seedForTest({ ...phoenix, tempF: 104, humidityPct: 30, isDay: true, uvIndex: 9 });
store.update('tester', (p) => {
  p.lat = 33.45; p.lon = -112.07; p.locationName = 'Phoenix, Arizona'; p.locationStatus = 'ready';
  p.medications.push({ spoken: 'metoprolol', generic: 'metoprolol', drugClass: 'beta blocker', mechanisms: ['electrolyte_imbalance', 'reduced_sweating'] });
});
const heat = await handlers.weather_check({});
check('a heat check that names a medication warns not to stop it', /doctor or pharmacist/.test(heat.content[0].text), heat.content[0].text);
check('...and tells this person to stay in', /better to stay in/.test(heat.content[0].text));
const cond = await handlers.health_condition({ action: 'add', condition: 'I have MS' });
check('registering MS reads back its plan', /Added multiple sclerosis/.test(cond.content[0].text), cond.content[0].text);
const signs = await handlers.warning_signs({ symptoms: 'he is slurring his words' });
check('the warning signs tool answers an emergency with 911', /Call 911/.test(signs.content[0].text));
store.update('tester', (p) => { p.locationStatus = 'locating'; p.locationName = 'Tucson, AZ'; p.lat = null; p.lon = null; });
const waiting = await handlers.plan_my_day({});
check('while a place is still being looked up, it says so rather than failing', /still looking up Tucson/.test(waiting.content[0].text), waiting.content[0].text);
store.update('tester', (p) => { p.locationStatus = 'not_found'; });
check('a place that could not be found asks for city and state or zip', /city and state, or a zip code/.test((await handlers.weather_check({})).content[0].text));
const help = await handlers.what_can_you_do({});
check('what can you do says plainly it is not medical advice', /isn't medical advice/.test(help.content[0].text));
check('every tool that links a panel uses the nested _meta.ui.resourceUri',
  Object.values(configs).filter((c) => c._meta).every((c) => c._meta.ui?.resourceUri === 'ui://sudor/window.html' && !('ui.resourceUri' in c._meta)));
rmSync('./data/test-tools.json', { force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
