/**
 * The longer view: the week ahead, the weeks gone, the doctor's own hot-day plan, and trips away.
 *
 * Four tools added beside the rest, not in place of any of them. plan_my_day still plans today and tomorrow from
 * the shared forecast; these read their own forecast and history (week.ts), so nothing another tool says changes.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as store from '../store.js';
import * as weather from '../weather.js';
import { planDay } from '../personal.js';
import { geocode, GeocoderDown } from '../geocode.js';
import { emergencyNumber } from '../world.js';
import { weekAhead, pastHours, lastYear, planWeek, patterns, judgeTrip, judgeLastYear, monthDay, weekday, dayHours, judgeDay, speakDay, EARLIEST_DAY, type JudgedDay } from '../week.js';
import { say, settle, locate, profileFor, count } from './shared.js';
import { householdOf, memberProfile, whoIs, type Member } from '../household.js';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
/** Accents dropped and lower case, so "Cancun" finds "Cancún". */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const andList = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const FORECAST_DOWN = "I can't reach the forecast for the week right now, so I won't guess. Ask me again in a few minutes.";

/** Today's date where this person is, from the shared forecast when it is in, otherwise from UTC. */
function todayFor(person: store.Person): string {
  const snap = person.lat != null && person.lon != null ? weather.current(person.lat, person.lon) : null;
  return new Date(Date.now() + (snap?.utcOffsetSeconds ?? 0) * 1000).toISOString().slice(0, 10);
}

/** The doctor's hot-day words, said as one sentence, or a pointer to them when names are kept private. */
function doctorWords(person: store.Person, when: 'hot_days' | 'cold_days'): string | null {
  const plans = (person.doctorPlans ?? []).filter((d) => d.when === when || d.when === 'always');
  if (!plans.length) return null;
  if (person.privacy) return `you have ${count(plans.length, 'note')} from your doctor for these days; ask me for them when you're alone.`;
  return plans.map((d) => `"${d.says}"`).join(', and ');
}

const summarise = (days: JudgedDay[]) => {
  const stay = days.filter((d) => d.status === 'avoid');
  const peak = days.length ? Math.max(...days.map((d) => d.peakHeatIndexF)) : 0;
  return { stay, peak, worst: stay.length ? 'avoid' as const : days.some((d) => d.status === 'caution') ? 'caution' as const : 'good' as const };
};

export function register(server: McpServer, personOf: () => string): void {
  server.registerTool(
    'plan_my_week',
    {
      title: 'Plan my week around the weather',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'The seven days ahead for this customer, judged against their own medicines and conditions: which days have hours ' +
        'to stay in, which need care, which are fine, and the best day for something they want to do. Pass workStart and ' +
        'workEnd when they say their working hours, and it says which days their trip to or from work falls in stay-in ' +
        'hours, so they can work from home that day. Call this for this week, the next few days, a weekday by name past ' +
        'tomorrow, or working from home. For today or tomorrow alone use plan_my_day.',
      inputSchema: {
        activity: z.string().optional().describe('Something they want to fit into the week, e.g. "gardening", "a long walk"'),
        minutes: z.number().int().min(10).max(600).optional().describe('How long it takes, in minutes'),
        workStart: z.number().int().min(0).max(23).optional().describe('Hour their working day starts, 0 to 23, when they say it'),
        workEnd: z.number().int().min(1).max(24).optional().describe('Hour their working day ends, 1 to 24'),
        workDays: z.array(z.enum(WEEKDAYS)).optional().describe('The days they work, when they say; Monday to Friday otherwise'),
        date: z.string().optional().describe('One particular day they ask about, up to six days ahead, as YYYY-MM-DD: "Thursday", "October 24". Leave it out for the whole week'),
      },
    },
    async ({ activity, minutes, workStart, workEnd, workDays, date }) => {
      const id = personOf();
      await settle(id);
      const person = store.get(id);
      const where = locate(person);
      if (typeof where === 'string') return say(where, { unavailable: true });
      let snap;
      try {
        snap = await weekAhead(where.lat, where.lon);
      } catch {
        return say(FORECAST_DOWN, { unavailable: true });
      }
      // One day asked about by its date: that day alone, from the same forecast.
      if (date) {
        const today = new Date(Date.now() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
        const last = new Date(Date.parse(`${today}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
        if (!DATE.test(date) || Number.isNaN(Date.parse(date))) return say('Which day? Tell me a weekday or a date in the next week.', { needs: 'date' });
        if (date < today) return say(`${monthDay(date)} has already gone. Ask me how that day was, and I'll look it up.`, { needs: 'past', nextAction: { tool: 'heat_patterns', arguments: { date } } });
        if (date > last) return say(`The forecast only reaches ${monthDay(last)}. Ask me about ${monthDay(date)} closer to the day.`, { beyondForecast: true });
        const profile = profileFor(person);
        const one = judgeDay(snap, profile, date, new Date(), minutes, activity);
        if (!one) return say(`I don't have the hours for ${monthDay(date)} yet.`, { unavailable: true });
        return say(speakDay(one, profile, { place: person.locationName ?? 'your area', past: false, today, activity }), { date, status: one.status, peakHeatIndexF: one.peakHeatIndexF, best: one.best?.label ?? null, avoid: one.worst?.label ?? null, place: person.locationName });
      }
      const work = workStart != null && workEnd != null && workEnd % 24 !== workStart
        ? { start: workStart, end: workEnd, days: workDays?.length ? workDays.map((d) => WEEKDAYS.indexOf(d) + 1) : undefined }
        : null;
      const week = planWeek(snap, profileFor(person), { now: new Date(), minutes, activity, work, doctorSays: doctorWords(person, 'hot_days') });
      return say(week.spoken, {
        place: person.locationName,
        timezone: snap.timezone,
        days: week.days.map((d) => ({ date: d.date, name: d.name, status: d.status, peakHeatIndexF: d.peakHeatIndexF, coldestFeelsF: d.coldestFeelsF, best: d.best?.label ?? null, avoid: d.worst?.label ?? null, ...(d.commute ? { commute: d.commute } : {}) })),
        source: 'https://open-meteo.com/en/docs',
      });
    },
  );

  server.registerTool(
    'heat_patterns',
    {
      title: 'How the last week, month or year has been for me',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Looks back over the last week, month or year where this customer lives and counts the days that were too hot, or ' +
        'too cold, for them to be out, given their own medicines and conditions: how many, the worst day, when the hot ' +
        'season started and ended, the worst month, and how often they told us they felt unwell. Call this for how the ' +
        'last week or month has been, how many hot days there were, when the hot season usually starts, or patterns over ' +
        'the year. It looks back; for days ahead use plan_my_week.',
      inputSchema: {
        period: z.enum(['week', 'month', 'year']).optional().describe('How far back: week, month or year; month unless they say'),
        date: z.string().optional().describe('One particular past day they ask about, as YYYY-MM-DD: "how hot was it on July 4", "what was last Tuesday like". Any day back to 1940'),
      },
    },
    async ({ period, date }) => {
      const id = personOf();
      await settle(id);
      const person = store.get(id);
      const where = locate(person);
      if (typeof where === 'string') return say(where, { unavailable: true });
      if (date) {
        const today = todayFor(person);
        if (!DATE.test(date) || Number.isNaN(Date.parse(date))) return say('Which day? Tell me the date, like July 4 or last Tuesday.', { needs: 'date' });
        if (date < EARLIEST_DAY) return say('The weather record I read starts in 1940. Pick a day after that.', { needs: 'date' });
        if (date >= today) return say('That day has not gone yet. Ask me to plan it instead.', { needs: 'future', nextAction: { tool: date === today ? 'plan_my_day' : 'plan_my_week', arguments: date === today ? {} : { date } } });
        let snap;
        try {
          snap = await dayHours(where.lat, where.lon, date);
        } catch {
          return say("I can't reach the weather history right now. Ask me again in a few minutes.", { unavailable: true });
        }
        const profile = profileFor(person);
        const one = judgeDay(snap, profile, date, new Date());
        if (!one) return say(`I don't have the hours for ${monthDay(date)}.`, { unavailable: true });
        return say(speakDay(one, profile, { place: person.locationName ?? 'your area', past: true, today }), { date, status: one.status, peakHeatIndexF: one.peakHeatIndexF, avoid: one.worst?.label ?? null, place: person.locationName, source: 'https://open-meteo.com/en/docs/historical-weather-api' });
      }
      const p = period ?? 'month';
      let snap;
      try {
        snap = await pastHours(where.lat, where.lon, p);
      } catch {
        return say("I can't reach the weather history right now. Ask me again in a few minutes.", { unavailable: true });
      }
      const back = { week: 7, month: 30, year: 365 }[p] * 86_400_000;
      const unwell = person.outings.filter((o) => o.felt === 'unwell' && Date.now() - Date.parse(o.at) <= back).length;
      const result = patterns(snap, profileFor(person), p, { place: person.locationName ?? 'your area', unwell, now: new Date() });
      const { days: _days, ...rest } = result;
      return say(result.spoken, { ...rest, source: p === 'week' ? 'https://open-meteo.com/en/docs' : 'https://open-meteo.com/en/docs/historical-weather-api' });
    },
  );

  server.registerTool(
    'doctor_plan',
    {
      title: "What my doctor told me to do on hot days",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Keeps what this customer's own doctor or pharmacist told them to do on hot or cold days, in their words, such as " +
        '"on hot days take my water pill in the morning" or "drink an extra litre when it is over 90", and repeats it on ' +
        'those days. action add saves one, list reads them back, today says whether today is a day it applies, remove ' +
        'deletes one. It never suggests changing, skipping or stopping a medicine itself: only the clinician decides that. ' +
        'Call this when they say what their doctor told them for hot or cold weather, or ask what it was.',
      inputSchema: {
        action: z.enum(['add', 'list', 'today', 'remove']).describe('add, list, today or remove'),
        says: z.string().optional().describe("What the doctor told them, in the customer's own words, when adding"),
        medicine: z.string().optional().describe('The medicine it is about, if they named one'),
        when: z.enum(['hot_days', 'cold_days', 'always']).optional().describe('When it applies; hot_days unless they say cold or every day'),
        privately: z.boolean().optional().describe('true when they ask to hear it privately or say they are alone'),
      },
    },
    async ({ action, says, medicine, when, privately }) => {
      const id = personOf();
      const person = store.get(id);
      const plans = person.doctorPlans ?? [];
      const hidden = person.privacy && !privately;

      if (action === 'add') {
        const words = clean(says ?? '', 200);
        if (!words) return say('Tell me what your doctor said to do on hot days, in your own words, and I will keep it.', { saved: false, needs: 'says' });
        // The same note said twice is kept once, so a repeated request changes nothing.
        if (plans.some((d) => d.says.toLowerCase() === words.toLowerCase())) return say(`I already have that from your doctor${hidden ? '' : `: "${words}"`}.`, { saved: true, already: true, count: plans.length });
        if (plans.length >= 10) return say('I already keep ten notes from your doctor. Remove one first.', { saved: false, reason: 'full' });
        const entry = { says: words, medicine: medicine ? clean(medicine, 60) : null, when: when ?? 'hot_days', at: new Date().toISOString() };
        store.update(id, (p) => void (p.doctorPlans = [...(p.doctorPlans ?? []), entry]));
        const day = entry.when === 'cold_days' ? 'cold days' : entry.when === 'always' ? 'every day' : 'hot days';
        return say(
          `Saved what your doctor told you for ${day}${hidden ? '' : `: "${words}"`}. I'll remind you when I plan your week and on days that are ` +
            `${entry.when === 'cold_days' ? 'cold' : 'hot'} for you. I'm only repeating your doctor's words; any change to a medicine is for your doctor to decide.`,
          { saved: true, when: entry.when, count: plans.length + 1 },
        );
      }

      if (action === 'remove') {
        if (!plans.length) return say("There's nothing from your doctor saved.", { removed: false });
        const named = clean(medicine ?? says ?? '', 60).toLowerCase();
        const idx = named ? plans.findIndex((d) => (d.medicine ?? '').toLowerCase().includes(named) || d.says.toLowerCase().includes(named)) : plans.length - 1;
        if (idx < 0) return say(`I don't have a note about ${named}. Ask me to list them.`, { removed: false });
        store.update(id, (p) => void (p.doctorPlans = (p.doctorPlans ?? []).filter((_, i) => i !== idx)));
        return say('Removed that note from your doctor.', { removed: true, count: plans.length - 1 });
      }

      if (!plans.length) return say("You haven't told me anything your doctor said for hot or cold days. Tell me and I'll keep it.", { count: 0 });
      if (hidden) return say(`You have ${count(plans.length, 'note')} from your doctor. Ask me for them when you're alone.`, { count: plans.length, private: true });

      if (action === 'list') {
        const lines = plans.map((d) => `for ${d.when === 'cold_days' ? 'cold days' : d.when === 'always' ? 'every day' : 'hot days'}, "${d.says}"`);
        return say(`Your doctor told you: ${andList(lines)}.`, { count: plans.length, plans: plans.map(({ says: s, when: w, medicine: m }) => ({ says: s, when: w, medicine: m })) });
      }

      // today: does today count as a hot or a cold day for this person?
      await settle(id);
      const where = locate(person);
      const snap = typeof where === 'string' ? null : weather.current(where.lat, where.lon);
      if (!snap || Number.isNaN(snap.tempF)) return say(`Your doctor told you: ${plans.map((d) => `"${d.says}"`).join(', and ')}. I don't have today's weather yet to say whether it applies.`, { count: plans.length });
      const plan = planDay(snap, profileFor(person), { now: new Date(), day: 'today' });
      const hours = plan.hours;
      const hot = hours.some((h) => h.status !== 'good' && h.feelsF > 50);
      const cold = hours.some((h) => h.status !== 'good' && h.feelsF <= 50);
      const applies = plans.filter((d) => d.when === 'always' || (d.when === 'hot_days' && hot) || (d.when === 'cold_days' && cold));
      if (!applies.length) return say(`Today isn't ${plans.some((d) => d.when === 'cold_days') ? 'a hot or a cold' : 'a hot'} day for you, so your doctor's note for those days doesn't apply today.`, { applies: false });
      return say(`Today ${hot ? 'is hot' : 'is cold'} for you, so remember what your doctor told you: ${applies.map((d) => `"${d.says}"`).join(', and ')}.`, { applies: true, count: applies.length });
    },
  );

  server.registerTool(
    'my_trips',
    {
      title: 'Trips and holidays',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Trips and holidays this customer tells us about: where and which dates. action add saves one and checks it, check ' +
        'judges the days of a trip against their own medicines (from the forecast once it reaches the dates, otherwise ' +
        'from the same dates last year), list reads upcoming and past trips with how the past ones went, remove deletes one. ' +
        'Call this when they say they are going away, on holiday or travelling, or ask whether a trip will be too hot or cold.',
      inputSchema: {
        action: z.enum(['add', 'check', 'list', 'remove']).describe('add, check, list or remove'),
        place: z.string().optional().describe('Where they are going: city and state, or city and country'),
        from: z.string().optional().describe('First day of the trip, YYYY-MM-DD'),
        to: z.string().optional().describe('Last day of the trip, YYYY-MM-DD; the same as from for a day trip'),
        travellers: z.array(z.string()).max(10).optional().describe('Who from home is going too, as said: "Mum", "the kids", "everyone". Leave it out when they go alone'),
      },
    },
    async ({ action, place, from, to, travellers }) => {
      const id = personOf();
      const person = store.get(id);
      const trips = person.trips ?? [];
      const today = todayFor(person);
      const profile = profileFor(person);
      const home = person.country ?? 'US';

      const describe = async (t: NonNullable<store.Person['trips']>[number]) => {
        const label = `${t.place}, ${monthDay(t.from)}${t.to !== t.from ? ` to ${monthDay(t.to)}` : ''}`;
        // Digits apart, as phone numbers are said: every answer has 911 swapped for the home country's number on the
        // way out (world.localise), and "the emergency number there is 911" reached a Sydney caller as 000.
        const sos = t.country !== home ? ` There, the emergency number is ${emergencyNumber(t.country).split('').join(' ')}.` : '';
        if (t.to < today) {
          return { spoken: t.seen ? `Your trip to ${label} is over. ${t.seen.stayDays ? `${count(t.seen.stayDays, 'day')} had stay-in hours for you, heat index up to ${t.seen.peakHeatIndexF}.` : 'None of it was too hot for you.'}` : `Your trip to ${label} is over.`, days: [] as JudgedDay[] };
        }
        const reach = new Date(Date.parse(`${today}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
        if (t.from <= reach) {
          const snap = await weekAhead(t.lat, t.lon);
          const days = judgeTrip(snap, profile, t.from, t.to, new Date());
          const s = summarise(days);
          const goingToo = (t.with ?? []).map((w) => householdOf(person).find((m) => m.id === w)).filter((m): m is Member => !!m);
          const others = goingToo.map((m) => {
            const theirs = judgeTrip(snap, memberProfile(m, person.privacy), t.from, t.to, new Date()).filter((d) => d.status === 'avoid').map((d) => (d.date === today ? 'today' : weekday(d.date)));
            return theirs.length ? `${m.called} has stay-in hours on ${andList(theirs)}` : `${m.called} is fine every day`;
          });
          const stayNames = s.stay.map((d) => (d.date === today ? 'today' : weekday(d.date)));
          const fine = days.filter((d) => d.status === 'good').map((d) => weekday(d.date));
          store.update(id, (p) => void (p.trips = (p.trips ?? []).map((x) => (x.from === t.from && x.place === t.place ? { ...x, seen: { worst: s.worst, peakHeatIndexF: s.peak, stayDays: s.stay.length } } : x))));
          const text = days.length
            ? `For your trip to ${label}: ${s.stay.length ? `stay-in hours for you on ${andList(stayNames)}, heat index up to ${s.peak}.` : 'no day is too hot for you.'}` +
              `${fine.length && s.stay.length ? ` ${andList(fine)} ${fine.length === 1 ? 'is' : 'are'} fine.` : ''}${t.to > reach ? ` The forecast only reaches ${monthDay(reach)}, so ask me again for the days after.` : ''}${others.length ? ` For the others going: ${others.join('; ')}.` : ''}${sos}`
            : `For your trip to ${label}, I don't have the forecast for those days yet.${sos}`;
          return { spoken: text, days };
        }
        try {
          const past = judgeLastYear(await lastYear(t.lat, t.lon, t.from, t.to), profile);
          const s = summarise(past);
          return {
            spoken:
              `The forecast for ${t.place} reaches ${monthDay(t.from)} around ${monthDay(new Date(Date.parse(`${t.from}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10))}; ask me then. ` +
              `On the same dates last year, ${s.stay.length ? `${s.stay.length} of ${past.length} days had stay-in hours for you, heat index up to ${s.peak}` : `no day was too hot for you there`}.${sos}`,
            days: [] as JudgedDay[],
          };
        } catch {
          return { spoken: `The forecast for ${t.place} doesn't reach ${monthDay(t.from)} yet; ask me closer to the time.${sos}`, days: [] as JudgedDay[] };
        }
      };

      if (action === 'add') {
        const where = clean(place ?? '', 80);
        const start = clean(from ?? '', 10);
        const end = clean(to ?? from ?? '', 10);
        if (!where) return say('Where are you going? Tell me the city and the state or country, and the dates.', { saved: false, needs: 'place' });
        if (!DATE.test(start) || !DATE.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return say(`Which dates are you in ${where}? Tell me the first and last day.`, { saved: false, needs: 'dates' });
        if (end < start) return say('The trip ends before it starts. Tell me the first and last day again.', { saved: false, needs: 'dates' });
        if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > 60) return say('I can keep trips of up to two months. Tell me the dates again.', { saved: false, needs: 'dates' });
        if (end < today) return say('Those dates are already over. Tell me a trip that is still coming up.', { saved: false, needs: 'dates' });
        if (trips.length >= 20) return say('I already keep twenty trips. Remove an old one first.', { saved: false, reason: 'full' });
        let found;
        try {
          found = await geocode(where, 6000);
        } catch (err) {
          if (err instanceof GeocoderDown) return say(`I can't look up ${where} right now. Try again in a minute.`, { saved: false, reason: 'geocoder_down' });
          throw err;
        }
        if (!found) return say(`I couldn't find ${where}. Tell me the city and the state, or the city and the country.`, { saved: false, reason: 'not_found' });
        const name = [found.name, found.state ?? found.countryName].filter(Boolean).join(', ');
        const going = travellers?.length ? whoIs(householdOf(person), travellers.map((x) => clean(x, 40))).map((m) => m.id) : [];
        const trip = { place: name, lat: found.lat, lon: found.lon, country: found.country, from: start, to: end, at: new Date().toISOString(), ...(going.length ? { with: going } : {}) };
        store.update(id, (p) => void (p.trips = [...(p.trips ?? []).filter((x) => !(x.place === name && x.from === start)), trip]));
        let checked;
        try {
          checked = await describe(trip);
        } catch {
          checked = { spoken: `I'll check the weather there closer to the time.`, days: [] };
        }
        return say(`Saved your trip to ${name}, ${monthDay(start)}${end !== start ? ` to ${monthDay(end)}` : ''}. ${checked.spoken}`, { saved: true, trip: { place: name, from: start, to: end, country: found.country, ...(going.length ? { with: going.length } : {}) } });
      }

      if (!trips.length) return say("You haven't told me about any trips. Tell me where you're going and the dates.", { count: 0 });

      if (action === 'remove') {
        const named = clean(place ?? '', 80).toLowerCase();
        const target = named ? trips.find((t) => fold(t.place).includes(fold(named.split(',')[0]).trim())) : trips.find((t) => t.to >= today);
        if (!target) return say(`I don't have a trip to ${named}. Ask me to list them.`, { removed: false });
        store.update(id, (p) => void (p.trips = (p.trips ?? []).filter((t) => t !== target && !(t.place === target.place && t.from === target.from))));
        return say(`Removed your trip to ${target.place}.`, { removed: true });
      }

      if (action === 'list') {
        const coming = trips.filter((t) => t.to >= today).sort((a, b) => a.from.localeCompare(b.from));
        const gone = trips.filter((t) => t.to < today).sort((a, b) => b.from.localeCompare(a.from));
        const parts: string[] = [];
        if (coming.length) parts.push(`Coming up: ${coming.map((t) => `${t.place}, ${t.to !== t.from ? `from ${monthDay(t.from)} to ${monthDay(t.to)}` : `on ${monthDay(t.from)}`}`).join('; ')}.`);
        if (gone.length) {
          parts.push(`Before that: ${andList(gone.slice(0, 3).map((t) => `${t.place} in ${new Date(`${t.from}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}${t.seen ? `, where ${t.seen.stayDays ? `${count(t.seen.stayDays, 'day')} had stay-in hours for you` : 'no day was too hot for you'}` : ''}`))}.`);
        }
        return say(parts.join(' ') || "You don't have any trips saved.", { coming: coming.length, past: gone.length });
      }

      // check: the trip named, or the next one coming up.
      const named = clean(place ?? '', 80).toLowerCase();
      const target = (named ? trips.find((t) => fold(t.place).includes(fold(named.split(',')[0]).trim())) : null) ?? trips.filter((t) => t.to >= today).sort((a, b) => a.from.localeCompare(b.from))[0] ?? trips[trips.length - 1];
      if (!target) return say(`I don't have a trip to ${named}. Ask me to list them.`, { checked: false });
      try {
        const r = await describe(target);
        return say(r.spoken, { checked: true, place: target.place, from: target.from, to: target.to, days: r.days.map((d) => ({ date: d.date, status: d.status, peakHeatIndexF: d.peakHeatIndexF })) });
      } catch {
        return say(FORECAST_DOWN, { checked: false, unavailable: true });
      }
    },
  );
}
