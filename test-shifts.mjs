/**
 * Shifts in the heat, tested: where the work is, and the week of getting used to it.
 *
 * Roofing is planned from the forecast. A hot kitchen inside is not, because the forecast is for outside.
 * An air conditioned office only has the trip there and back. And somebody new gets each day of their first
 * week, counted in working days, so a weekend does not undo it. The network is off.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-shifts';
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
const { registerTools } = await import('./dist/tools.js');
globalThis.fetch = async () => { throw new Error('network is off for this test'); };

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const LAT = 33.66, LON = -112.34, OFFSET = -7 * 3600;
const localDate = (ms) => new Date(ms + OFFSET * 1000).toISOString().slice(0, 10);
const dayMs = 86_400_000;
function snapOf(startMs, days, temp, now = 80) {
  const hourly = [];
  for (let d = 0; d < days; d++) {
    const date = localDate(startMs + d * dayMs);
    for (let h = 0; h < 24; h++) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      const t = temp(d, h);
      hourly.push({ local: at, time: weather.localToUtc(at, OFFSET), tempF: t, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: h >= 6 && h < 19, aqi: 30, solarWm2: 500, wetBulbF: t - 20 });
    }
  }
  return { lat: LAT, lon: LON, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: OFFSET, tempF: now, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: true, aqi: 30, solarWm2: 500, wetBulbF: 60, hourly, daily: [], stale: false };
}
// Hot from 10 am to 5 pm every day.
const hot = (d, h) => (h >= 10 && h <= 17 ? 98 : 75);
const start = Date.now() - dayMs; // a day back, so today is in it
weather.seedForTest(snapOf(start, 3, hot));
week.seedForTest('week', LAT, LON, snapOf(start, 9, hot));

const id = 'acct:shifts';
store.update(id, (p) => { p.lat = LAT; p.lon = LON; p.locationName = 'Sun City West, Arizona'; p.locationStatus = 'ready'; });
const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => id);
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
};

console.log('\nOne shift, by where the work is');
{
  const roof = await call('plan_my_day', { shiftStart: 6, shiftEnd: 23, startedWork: 'new', workplace: 'outside' });
  check('outside, new: the forecast shift with day 1 of the build-up', /day 1 of getting used to the heat/.test(roof.said), roof.said);
  check('...and it offers the whole week', /Want the whole week planned, day by day\?/.test(roof.said) && roof.data.nextAction?.tool === 'plan_my_week', roof.said);
  const kitchen = await call('plan_my_day', { shiftStart: 6, shiftEnd: 23, workplace: 'hot_inside' });
  check('a hot kitchen inside is not planned from the outside forecast', /doesn't tell me how hot it is where you work/.test(kitchen.said) && !/peaks at heat index/.test(kitchen.said), kitchen.said);
  check('...but the build-up still applies', /day 1 of getting used to the heat/.test(kitchen.said), kitchen.said);
  const office = await call('plan_my_day', { shiftStart: 9, shiftEnd: 17, workplace: 'cool_inside' });
  check('a cooled office: only the trip there and back', /somewhere cooled, so the heat only matters getting there and back/.test(office.said) && !/getting used to the heat/.test(office.said), office.said);
  const plain = await call('plan_my_day', { shiftStart: 6, shiftEnd: 23 });
  check('no workplace said: the outside shift, as before', /peaks at heat index/.test(plain.said), plain.said);
}

console.log('\nThe week');
{
  const w = await call('plan_my_week', { workStart: 6, workEnd: 23, workplace: 'outside', workDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] });
  const lines = w.data.shifts ?? [];
  const on = lines.filter((d) => !d.off);
  check('each working day of the week is planned', on.length >= 4, w.said);
  const allowed = on.map((d) => d.heatHoursAllowed);
  check('the hours in the heat grow day by day while new', on.slice(0, 3).every((d, i, xs) => i === 0 || (d.heatHoursAllowed ?? 99) > (xs[i - 1].heatHoursAllowed ?? 0)), JSON.stringify(allowed));
  const offDays = lines.filter((d) => d.off).map((d) => d.date);
  if (offDays.length) {
    const after = on.find((d) => d.date > offDays[offDays.length - 1]);
    const before = [...on].reverse().find((d) => d.date < offDays[0]);
    check('a weekend does not count as a day of getting used to it', !before || !after || after.workDay === before.workDay + 1, JSON.stringify({ before, after }));
    check('...and it says days off do not undo it', /a few days off does not undo getting used to it/.test(w.said), w.said);
  }
  check('each day says its breaks', /15 minute breaks at/.test(w.said), w.said);
  const inside = await call('plan_my_week', { workStart: 6, workEnd: 23, workplace: 'hot_inside' });
  check('a hot workplace inside: the build-up by day, and the thermometer line', /day \d+: \d+ hours in the heat at most/.test(inside.said) && /doesn't tell me how hot it is where you work/.test(inside.said), inside.said);
  const office = await call('plan_my_week', { workStart: 9, workEnd: 17 });
  check('without a workplace, the week is the usual one', !w.data.shifts || !office.data.shifts, office.said);
  check('the heading does not start with "Your", which the agent would put back twice', !/^Your /.test(w.said), w.said.slice(0, 40));
  store.update(id, (p) => { p.country = 'QA'; });
  const qa = await call('plan_my_week', { workStart: 7, workEnd: 17, workplace: 'outside' });
  const qOff = (qa.data.shifts ?? []).filter((d) => d.off).map((d) => new Date(d.date + 'T12:00:00Z').getUTCDay());
  check('in Qatar the weekend is Friday and Saturday, and it says so', qOff.length > 0 && qOff.every((x) => x === 5 || x === 6) && /Sunday to Thursday; tell me if yours are different/.test(qa.said), qa.said);
  store.update(id, (p) => { p.country = 'US'; });
  console.log('\n  ' + w.said);
}

console.log('\nWhen the time in the heat goes');
{
  const personal = await import('./dist/personal.js');
  const p = personal.profileOf([], [], { outings: [] });
  const date = localDate(Date.now());
  const at = (h) => new Date(Date.parse(`${date}T${String(h).padStart(2, '0')}:00:00Z`) - OFFSET * 1000);
  const work = { kind: 'new', since: date };
  // Hot all day, hotter as it goes: the morning is the coolest.
  const rising = snapOf(Date.now() - dayMs, 3, (d, h) => 88 + 2 * Math.max(0, h - 7));
  const early = personal.planShift(rising, p, { now: at(5), date, fromHour: 7, untilHour: 17, heatWork: work });
  check('day 1 of a 7 to 5 shift: 2 hours, at the coolest, 7 to 9 am', early.acclimatization?.from === '7 am' && early.acclimatization?.doneBy === '9 am', JSON.stringify(early.acclimatization));
  check("...and it says it's still a working day, out of the heat, not a time to leave", /7 am to 9 am, while it's coolest, and spend the rest of the shift in the shade or inside/.test(early.spoken), early.spoken);
  const late = personal.planShift(rising, p, { now: at(11), date, fromHour: 7, untilHour: 17, heatWork: work });
  check('asked at 11 am, it says the coolest stretch has passed and gives the coolest left', late.acclimatization?.passed && /has passed, so if you've had your 2 hours, spend the rest of the shift in the shade or inside; if not, 11 am to 1 pm is the coolest left/.test(late.spoken), late.spoken);
  // An afternoon shift that cools into the evening: the coolest stretch is at the end.
  const evening = snapOf(Date.now() - dayMs, 3, (d, h) => (h <= 15 ? 100 + 4 * (h - 14) : 106 - 3 * (h - 15)));
  const pm = personal.planShift(evening, p, { now: at(5), date, fromHour: 14, untilHour: 22, heatWork: work });
  check('an evening shift that cools off: the heat time goes at the end', pm.acclimatization?.from === '8 pm' && pm.acclimatization?.doneBy === '10 pm', JSON.stringify(pm.acclimatization));
  // Only some hours past 80: the rest is the hot hours, not the whole shift.
  const some = personal.planShift(snapOf(Date.now() - dayMs, 3, hot), p, { now: at(5), date, fromHour: 6, untilHour: 23, heatWork: work });
  check('when only part of the shift is hot, the rest out of the heat is the hot hours', /rest of the hot hours in the shade or inside/.test(some.spoken), some.spoken);
  const wk = personal.planShiftWeek(rising, p, { now: at(5), fromHour: 7, untilHour: 17, heatWork: work, workplace: 'outside' });
  check('the week says the limited days are still working days', /On the days with a limit, spend the rest of the shift in the shade or inside: it's still a working day, just out of the sun/.test(wk.spoken) && /day 1: 2 hours in the heat at most, 7 am to 9 am/.test(wk.spoken), wk.spoken);
  const kitchen = await call('plan_my_day', { shiftStart: 7, shiftEnd: 17, startedWork: 'new', workplace: 'hot_inside' });
  check('a hot kitchen: short spells, and the rest of the shift somewhere cooler', /in short spells, and the rest of the shift somewhere cooler/.test(kitchen.said), kitchen.said);
}

await client.close();
await server.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
