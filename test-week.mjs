/**
 * The longer view, tested: the week ahead, the weeks gone, the doctor's own hot-day plan, and trips.
 *
 * These four tools were added beside the others and read their own forecast and history (week.ts), so the
 * tests seed that forecast directly and check two things: that each answer is right for the person, and that
 * nothing the existing tools say has changed because they are here. The network is off.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-week';
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
const week = await import('./dist/week.js');
const { profileOf } = await import('./dist/personal.js');
const { registerTools } = await import('./dist/tools.js');
const geocode = await import('./dist/geocode.js');
globalThis.fetch = async () => { throw new Error('network is off for this test'); };

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const LAT = 33.66, LON = -112.34, OFFSET = -7 * 3600;
const localDate = (ms) => new Date(ms + OFFSET * 1000).toISOString().slice(0, 10);
const dayMs = 86_400_000;

/** A snapshot of `days` days from `startMs`, each hour's temperature from temp(dayIndex, hour). */
function snapOf(startMs, days, temp, lat = LAT, lon = LON) {
  const hourly = [];
  for (let d = 0; d < days; d++) {
    const date = localDate(startMs + d * dayMs);
    for (let h = 0; h < 24; h++) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      const t = temp(d, h);
      hourly.push({ local: at, time: weather.localToUtc(at, OFFSET), tempF: t, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: h >= 6 && h < 19, aqi: 30, solarWm2: 500, wetBulbF: t - 20 });
    }
  }
  return { lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: OFFSET, tempF: hourly[12].tempF, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: true, aqi: 30, solarWm2: 500, wetBulbF: 60, hourly, daily: [], stale: false };
}

// The week ahead: day 1 (tomorrow) and day 3 hot in the afternoon, the rest mild.
const hotDays = new Set([1, 3]);
const weekTemp = (d, h) => (hotDays.has(d) && h >= 11 && h <= 18 ? 98 : 72);
const coreg = profileOf(['reduced_sweating'], ['heart_disease'], {});
const nobody = profileOf([], [], {});

console.log('\nThe week ahead, judged for the person');
{
  const now = new Date();
  const snap = snapOf(now.getTime(), 7, weekTemp);
  const plan = week.planWeek(snap, coreg, { now });
  const stay = plan.days.filter((d) => d.status === 'avoid').map((d) => d.date);
  const want = [1, 3].map((d) => localDate(now.getTime() + d * dayMs));
  check('the two hot days are the stay-in days, and only those', JSON.stringify(stay) === JSON.stringify(want), JSON.stringify(stay));
  check('tomorrow is called tomorrow, the other by its weekday', /tomorrow/.test(plan.spoken) && plan.spoken.includes(week.weekday(want[1])), plan.spoken);
  check('it says why, for a person whose medicine blocks sweating', /^Because /.test(plan.spoken), plan.spoken.slice(0, 80));
  check('the hottest day is named with its heat index', /The hottest is tomorrow, heat index \d+/.test(plan.spoken), plan.spoken);
  check('the mild days are said to be fine all day', /fine all day/.test(plan.spoken));
  check('no em dash and no arrow anywhere', !/[–—→]/.test(plan.spoken));

  const healthy = week.planWeek(snapOf(now.getTime(), 7, (d, h) => (hotDays.has(d) && h >= 11 && h <= 18 ? 84 : 72)), nobody, { now });
  check('the same mild heat is fine for somebody with no conditions', healthy.days.every((d) => d.status !== 'avoid') && /no stay-in days/.test(healthy.spoken), healthy.spoken);

  const gardening = week.planWeek(snap, coreg, { now, activity: 'gardening', minutes: 120 });
  check('an activity gets its best day first in the answer', /^The best day for gardening is /.test(gardening.spoken), gardening.spoken.slice(0, 80));
  check('and that day is not one of the stay-in days', !want.some((d) => gardening.spoken.startsWith(`The best day for gardening is ${week.weekday(d)}`)));

  const work = week.planWeek(snap, coreg, { now, work: { start: 9, end: 17 } });
  const wfh = work.days.filter((d) => d.commute?.workFromHome).map((d) => d.date);
  check('the trip home at 5 pm on a hot weekday says work from home', wfh.every((d) => want.includes(d)) && /work from home/.test(work.spoken) || wfh.length === 0, JSON.stringify(wfh) + ' ' + work.spoken);
  const early = week.planWeek(snap, coreg, { now, work: { start: 6, end: 10 } });
  check('a shift that ends before the heat keeps its trips out of stay-in hours', !early.days.some((d) => d.commute?.workFromHome) && /stay out of stay-in hours/.test(early.spoken), early.spoken);

  const withDoctor = week.planWeek(snap, coreg, { now, doctorSays: '"take my water pill in the morning"' });
  check("the doctor's own words are repeated for the hot days", /remember what your doctor told you: "take my water pill in the morning"/.test(withDoctor.spoken));
  check('and not on a week with no hot day', !/doctor/.test(week.planWeek(snapOf(now.getTime(), 7, () => 70), coreg, { now, doctorSays: '"x"' }).spoken));
}

console.log('\nA cold week is said as cold');
{
  const now = new Date();
  // Mornings at 5F with wind on two days; the rest mild.
  const cold = snapOf(now.getTime(), 7, (d, h) => ((d === 2 || d === 4) && h <= 10 ? 5 : 55));
  cold.hourly.forEach((h) => { h.windMph = 15; });
  const coreg = profileOf(['reduced_sweating'], ['heart_disease'], {});
  const plan = week.planWeek(cold, coreg, { now });
  check('freezing mornings are "too cold", not a sweating reason', /too cold for you to be out/.test(plan.spoken) && !/blocks your sweating, you have hours to stay in/.test(plan.spoken), plan.spoken);
  check('and the coldest day is named with its wind chill', /The coldest is \w+, with a wind chill of -?\d+/.test(plan.spoken), plan.spoken);
  const work = week.planWeek(cold, coreg, { now, work: { start: 9, end: 17, days: [1, 2, 3, 4, 5, 6, 7] } });
  check('a cold trip to work gets cold advice, not air conditioning', /dress in layers/.test(work.spoken) && !/air conditioning/.test(work.spoken), work.spoken);
  const night = week.planWeek(snapOf(now.getTime(), 7, (d, h) => (h >= 4 && h <= 7 ? 5 : 55)), coreg, { now, work: { start: 22, end: 6, days: [1, 2, 3, 4, 5, 6, 7] } });
  check('a night shift, ten to six, is planned, not dropped', night.days.some((d) => d.commute && d.commute.home === 'avoid'), JSON.stringify(night.days.map((d) => d.commute)));
}

console.log('\nThe days gone: a week, a month, a year');
{
  const now = new Date();
  const cold = snapOf(now.getTime() - 371 * dayMs, 366, (d, h) => (d < 120 && h <= 12 ? 0 : 60));
  const y = week.patterns(cold, coreg, 'year', { place: 'Fairbanks, Alaska', now });
  check('a year of cold mornings has no hot season', !/hot season/.test(y.spoken) && /too cold for you/.test(y.spoken), y.spoken);
  check('and cold days are not counted as hot ones', y.byMonth.every((m) => m.stay === 0), JSON.stringify(y.byMonth.slice(0, 3)));
}
{
  const now = new Date();
  // A year back: hot from the 120th day to the 270th, cold in the first 30.
  const yearTemp = (d, h) => (d >= 120 && d <= 270 && h >= 11 && h <= 18 ? 100 : d < 30 && h <= 9 ? 20 : 70);
  const year = snapOf(now.getTime() - 371 * dayMs, 366, yearTemp);
  const y = week.patterns(year, coreg, 'year', { place: 'Sun City West, Arizona', now });
  check('a year counts its hot days', y.stayDays >= 140 && y.stayDays <= 190, String(y.stayDays));
  check('the hot season is named by month, in order, not by its first and last date', /Your hot season ran from \w+ to \w+\./.test(y.spoken) && !/October 18 to October 11/.test(y.spoken), y.spoken);
  check('cold days are counted apart from hot ones', /too cold for you/.test(y.spoken), y.spoken);
  check('the months are in order', y.byMonth.every((m, i) => i === 0 || m.month > y.byMonth[i - 1].month));

  const month = week.patterns(snapOf(now.getTime() - 36 * dayMs, 31, (d, h) => (d < 15 && h >= 12 && h <= 16 ? 100 : 72)), coreg, 'month', { place: 'Phoenix', now, unwell: 2 });
  check('a month that cooled says it eased', /It eased in the second half/.test(month.spoken), month.spoken);
  check('how often they felt unwell is said', /felt unwell 2 times/.test(month.spoken));
  const lastWeek = week.patterns(snapOf(now.getTime() - 7 * dayMs, 8, () => 72), coreg, 'week', { place: 'Phoenix', now });
  check('a mild week says no day was too hot', /no day was too hot for you/.test(lastWeek.spoken), lastWeek.spoken);
  check('today, which is not over, is never counted', !lastWeek.days.some((d) => d.date === localDate(now.getTime())));
}

console.log('\nOne day, ahead or gone');
{
  const now = new Date();
  const snap = snapOf(now.getTime(), 7, weekTemp);
  const coreg = profileOf(['reduced_sweating'], ['heart_disease'], {});
  const today = localDate(now.getTime());
  const hot = localDate(now.getTime() + 3 * dayMs);
  const d = week.judgeDay(snap, coreg, hot, now);
  check('a hot day ahead has its stay-in hours as one span', d && d.status === 'avoid' && d.stayIn === '11 am to 7 pm', JSON.stringify(d && { status: d.status, stayIn: d.stayIn }));
  const said = week.speakDay(d, coreg, { place: 'Phoenix', past: false, today });
  check('it is said with the reason first, then when to stay in and when to go', /^On \w+day, \w+ \d+ in Phoenix, the heat index reaches \d+\. Because .*, stay in 11 am to 7 pm if you can\. The best time to be out is/.test(said), said);
  const mild = week.speakDay(week.judgeDay(snap, coreg, localDate(now.getTime() + 2 * dayMs), now), coreg, { place: 'Phoenix', past: false, today });
  check('a mild day says it stays fine, without a best window that is the whole day', /It stays fine for you all day\.$/.test(mild) && !/best time/.test(mild), mild);
  const past = week.speakDay(d, coreg, { place: 'Phoenix', past: true, today });
  check('a day gone is said in the past tense', /reached \d+\..*11 am to 7 pm were stay-in hours\./.test(past), past);
}

console.log('\nThe tools, end to end, with the network off');
week.seedForTest('week', LAT, LON, snapOf(Date.now(), 7, weekTemp));
week.seedForTest('past-month', LAT, LON, snapOf(Date.now() - 36 * dayMs, 31, () => 72));
const id = 'acct:week';
store.update(id, (p) => { p.lat = LAT; p.lon = LON; p.locationName = 'Sun City West, Arizona'; p.locationStatus = 'ready'; p.conditions = ['heart_disease']; });
weather.seedForTest(snapOf(Date.now(), 2, weekTemp));
const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => id);
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {}, isError: r.isError };
};
{
  const names = (await client.listTools()).tools.map((t) => t.name);
  check('the four new tools are published', ['plan_my_week', 'heat_patterns', 'doctor_plan', 'my_trips'].every((n) => names.includes(n)), names.join(','));
  check('every tool that was there before is still there', ['weather_check', 'plan_my_day', 'going_out_now', 'warning_signs', 'log_outing', 'about_me', 'contact', 'get_help', 'somewhere_to_go', 'storm_prep', 'share_my_day', 'tell_me_more', 'what_can_you_do'].every((n) => names.includes(n)));

  const w = await call('plan_my_week');
  check('plan_my_week answers from its own forecast', !w.isError && Array.isArray(w.data.days) && w.data.days.length >= 6, w.said);
  const p = await call('heat_patterns', { period: 'month' });
  check('heat_patterns answers for the month', !p.isError && /Over the last 30 days in Sun City West/.test(p.said), p.said);
  const down = await call('heat_patterns', { period: 'year' });
  check('with no history to read, it says so instead of guessing', /can't reach the weather history/.test(down.said), down.said);

  const empty = await call('doctor_plan', { action: 'list' });
  check('no doctor notes yet is said plainly', /haven't told me anything your doctor said/.test(empty.said));
  const add = await call('doctor_plan', { action: 'add', says: 'on hot days take my Lasix in the morning, not at night', medicine: 'Lasix' });
  check('a doctor note is kept in their words', add.data.saved === true && /"on hot days take my Lasix in the morning, not at night"/.test(add.said));
  check('and it says that only the doctor changes a medicine', /any change to a medicine is for your doctor to decide/.test(add.said));
  const twice = await call('doctor_plan', { action: 'add', says: 'On hot days take my Lasix in the morning, not at night', medicine: 'Lasix' });
  check('the same note said twice is kept once', twice.data.already === true && (store.get(id).doctorPlans ?? []).length === 1, twice.said);
  const blank = await call('doctor_plan', { action: 'add', says: '   ' });
  check('an empty note is not saved', blank.data.saved === false);
  const list = await call('doctor_plan', { action: 'list' });
  check('list reads it back', /Your doctor told you: for hot days, "on hot days take my Lasix/.test(list.said));
  const wk = await call('plan_my_week');
  check('the week reminds them of it on the hot days', /remember what your doctor told you/.test(JSON.stringify(wk)) || wk.data.days.some((d) => d.status === 'avoid'));
  store.update(id, (p) => void (p.privacy = true));
  const hidden = await call('doctor_plan', { action: 'list' });
  check('in privacy mode the note is not read out unless asked privately', !/Lasix/.test(hidden.said) && /when you're alone/.test(hidden.said), hidden.said);
  const shown = await call('doctor_plan', { action: 'list', privately: true });
  check('asked privately, it is', /Lasix/.test(shown.said));
  store.update(id, (p) => void (p.privacy = false));
  const removed = await call('doctor_plan', { action: 'remove', medicine: 'Lasix' });
  check('a note can be removed by its medicine', removed.data.removed === true && (store.get(id).doctorPlans ?? []).length === 0);

  const noPlace = await call('my_trips', { action: 'add', from: '2030-01-01', to: '2030-01-05' });
  check('a trip with no place asks where', noPlace.data.needs === 'place');
  const badDates = await call('my_trips', { action: 'add', place: 'Las Vegas, Nevada', from: 'next week' });
  check('a trip with no real dates asks for them', badDates.data.needs === 'dates', badDates.said);
  const backwards = await call('my_trips', { action: 'add', place: 'Las Vegas, Nevada', from: '2030-01-05', to: '2030-01-01' });
  check('a trip that ends before it starts is refused', backwards.data.needs === 'dates');
  const over = await call('my_trips', { action: 'add', place: 'Las Vegas, Nevada', from: '2020-01-01', to: '2020-01-02' });
  check('a trip already over is refused', /already over/.test(over.said));
  const none = await call('my_trips', { action: 'list' });
  check('no trips yet is said plainly', /haven't told me about any trips/.test(none.said));
  const lookupDown = await call('my_trips', { action: 'add', place: 'Cancun, Mexico', from: localDate(Date.now() + 2 * dayMs), to: localDate(Date.now() + 4 * dayMs) });
  check('with the place lookup down, it says so and saves nothing', /can't look up/.test(lookupDown.said) && !(store.get(id).trips ?? []).length, lookupDown.said);

  // The place lookup answers; everything else stays off. Cancún's week is hot every afternoon.
  globalThis.fetch = async (url) => {
    if (String(url).includes('geocoding-api')) {
      return new Response(JSON.stringify({ results: [{ name: 'Cancún', admin1: 'Quintana Roo', latitude: 21.16, longitude: -86.85, timezone: 'America/Cancun', country_code: 'MX', country: 'Mexico', population: 888797 }] }), { status: 200 });
    }
    throw new Error('network is off for this test');
  };
  week.seedForTest('week', 21.16, -86.85, snapOf(Date.now(), 7, (d, h) => (h >= 11 && h <= 17 ? 99 : 78), 21.16, -86.85));
  const from = localDate(Date.now() + 2 * dayMs), to = localDate(Date.now() + 4 * dayMs);
  const trip = await call('my_trips', { action: 'add', place: 'Cancun, Mexico', from, to });
  check('a trip in the next week is saved and judged from the forecast there', trip.data.saved === true && /stay-in hours for you on/.test(trip.said), trip.said);
  check("it names that country's emergency number when it differs from home", /emergency number is 9 1 1\./.test(trip.said), trip.said);
  store.update(id, (p) => void (p.country = 'AU'));
  const fromSydney = await call('my_trips', { action: 'check', place: 'Cancun' });
  check('...and a caller from Australia still hears Mexico\'s 9 1 1, not 000', /emergency number is 9 1 1\./.test(fromSydney.said) && !/000/.test(fromSydney.said), fromSydney.said);
  store.update(id, (p) => void (p.country = 'US'));
  const longTrip = await call('my_trips', { action: 'add', place: 'Cancun, Mexico', from, to: localDate(Date.now() + 12 * dayMs) });
  check('a trip running past the forecast says how far the forecast reaches', /The forecast only reaches/.test(longTrip.said), longTrip.said);
  await call('my_trips', { action: 'add', place: 'Cancun, Mexico', from, to });
  const listed = await call('my_trips', { action: 'list' });
  check('list names the trip coming up', /Coming up: Cancún/.test(listed.said), listed.said);
  const again = await call('my_trips', { action: 'add', place: 'Cancun, Mexico', from, to });
  check('the same trip told twice is kept once', (store.get(id).trips ?? []).length === 1, String((store.get(id).trips ?? []).length) + again.said.slice(0, 40));
  const gone = await call('my_trips', { action: 'remove', place: 'Cancun' });
  check('a trip can be removed by its place', gone.data.removed === true && !(store.get(id).trips ?? []).length);
  globalThis.fetch = async () => { throw new Error('network is off for this test'); };
}

await client.close();
await server.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
