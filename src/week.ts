/**
 * Days beyond tomorrow, and days already gone.
 *
 * plan_my_day plans today or tomorrow from the forecast every other tool shares, which holds 48 hours. A week, a
 * trip next Saturday, or "how has this month been for me" needs more than that, so this module reads its own
 * forecast and its own history and leaves the shared one exactly as it was.
 *
 *   The week ahead: Open-Meteo's hourly forecast for seven days, judged hour by hour for this person with the same
 *   judgeHour and planDay every other answer uses, so a "stay in" here means what it means everywhere else.
 *   https://open-meteo.com/en/docs
 *
 *   The days gone: the last week from the same forecast service (past_days), and the last month or year from
 *   Open-Meteo's historical archive, which is the ERA5 reanalysis and runs about five days behind.
 *   https://open-meteo.com/en/docs/historical-weather-api
 *
 * The judging is this person's own. A day is "stay in" when any waking hour, 6 am to 10 pm, is an avoid for them,
 * given their medicines and conditions; "take care" when the worst hour is a caution; "fine" otherwise.
 */

import { parseForecast, type LocationSnapshot } from './weather.js';
import { planDay, judgeHour, spanLabel, type Profile, type Status, type Span, type Judged } from './personal.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const HOURLY = 'temperature_2m,relative_humidity_2m,uv_index,is_day,wind_speed_10m,shortwave_radiation,wet_bulb_temperature_2m,weather_code';
const UNITS = '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto';
const FIRST_HOUR = 6;
const LAST_HOUR = 21;

async function fetchJson(url: string, timeoutMs = 9000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** The archive answers carry no "current" block, and parseForecast reads one. The last hour stands in for it. */
function withCurrent(body: any): any {
  const h = body?.hourly ?? {};
  const last = Math.max(0, (h.time?.length ?? 1) - 1);
  return { ...body, current: { temperature_2m: h.temperature_2m?.[last] ?? NaN, relative_humidity_2m: h.relative_humidity_2m?.[last] ?? NaN } };
}

const cache = new Map<string, { at: number; value: LocationSnapshot }>();
const cacheKey = (kind: string, lat: number, lon: number) => `${kind}:${lat.toFixed(2)},${lon.toFixed(2)}`;
const WEEK_TTL = 30 * 60_000;
const PAST_TTL = 6 * 3_600_000;

async function cached(kind: string, lat: number, lon: number, ttl: number, load: () => Promise<LocationSnapshot>): Promise<LocationSnapshot> {
  const k = cacheKey(kind, lat, lon);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  cache.set(k, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return value;
}

/** For tests: put a snapshot where the next read finds it. */
export function seedForTest(kind: 'week' | 'past-week' | 'past-month' | 'past-year', lat: number, lon: number, snap: LocationSnapshot): void {
  cache.set(cacheKey(kind, lat, lon), { at: Date.now(), value: snap });
}

/** Seven days of hours ahead, with the air quality for the five days it is forecast. */
export function weekAhead(lat: number, lon: number): Promise<LocationSnapshot> {
  return cached('week', lat, lon, WEEK_TTL, async () => {
    const [w, a] = await Promise.allSettled([
      fetchJson(`${FORECAST}?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m&hourly=${HOURLY}&forecast_days=7${UNITS}`),
      fetchJson(`${AIR}?latitude=${lat}&longitude=${lon}&hourly=us_aqi&forecast_days=5&timezone=auto`),
    ]);
    if (w.status === 'rejected') throw w.reason;
    return parseForecast(lat, lon, w.value, a.status === 'fulfilled' ? a.value : null);
  });
}

export type Period = 'week' | 'month' | 'year';
const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, year: 365 };
/** The archive is about five days behind, so a month or a year ends six days ago. */
export const ARCHIVE_LAG_DAYS = 6;

/** The hours already gone: the last week from the forecast service, a month or a year from the archive. */
export function pastHours(lat: number, lon: number, period: Period, now = new Date()): Promise<LocationSnapshot> {
  return cached(`past-${period}`, lat, lon, PAST_TTL, async () => {
    if (period === 'week') {
      const body = await fetchJson(`${FORECAST}?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m&hourly=${HOURLY}&past_days=7&forecast_days=1${UNITS}`);
      return parseForecast(lat, lon, body, null);
    }
    const end = new Date(now.getTime() - ARCHIVE_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);
    const start = new Date(now.getTime() - (ARCHIVE_LAG_DAYS + PERIOD_DAYS[period]) * 86_400_000).toISOString().slice(0, 10);
    const body = await fetchJson(
      `${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,is_day,shortwave_radiation${UNITS}`,
      15_000,
    );
    return parseForecast(lat, lon, withCurrent(body), null);
  });
}

/** The same dates a year earlier, for a trip whose forecast is not out yet. */
export function lastYear(lat: number, lon: number, from: string, to: string): Promise<LocationSnapshot> {
  const back = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  return cached(`last-year:${from}:${to}`, lat, lon, PAST_TTL, async () => {
    const body = await fetchJson(
      `${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${back(from)}&end_date=${back(to)}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,is_day,shortwave_radiation${UNITS}`,
      12_000,
    );
    return parseForecast(lat, lon, withCurrent(body), null);
  });
}

/* ------------------------------------------------------------------ the days, judged */

export type JudgedDay = {
  date: string;
  status: Status;
  /** The hottest heat index of the waking hours, and the coldest feels-like. */
  peakHeatIndexF: number;
  coldestFeelsF: number;
  /** The least risky stretch, and the longest stay-in stretch, for an activity of the given length. */
  best: (Span & { status: Status }) | null;
  worst: Span | null;
  /** From the first stay-in hour to the last, said as "11 am to 7 pm". Null on a day with none. */
  stayIn: string | null;
};

/**
 * The first stay-in hour to the last, as one span. On a day hot all afternoon the planner's "worst" can be empty,
 * because the least risky stretch sits inside it, and "there were hours to stay in" said nothing about when.
 */
function stayInOf(hours: Judged[]): string | null {
  const av = hours.filter((x) => x.status === 'avoid');
  if (!av.length) return null;
  return spanLabel(av[0].local, hourOf(av[av.length - 1].local) - hourOf(av[0].local) + 1);
}

const RANK: Record<Status, number> = { good: 0, caution: 1, avoid: 2 };
const worse = (a: Status, b: Status): Status => (RANK[b] > RANK[a] ? b : a);
const hourOf = (local: string) => Number(local.slice(11, 13));

/** Every date in the snapshot, in the place's own calendar, in order. */
const datesOf = (snap: LocationSnapshot): string[] => [...new Set(snap.hourly.map((h) => h.local.slice(0, 10)))].sort();

/**
 * One date judged with planDay, which is written for "today" and "tomorrow". Asked about the day after a moment
 * just before it, "tomorrow" is that date, so the planner every other answer uses is reused unchanged.
 */
function judgeDate(snap: LocationSnapshot, p: Profile, date: string, today: string, now: Date, minutes?: number, activity?: string): JudgedDay | null {
  const plan =
    date === today
      ? planDay(snap, p, { now, day: 'today', minutes, activity })
      : planDay(snap, p, { now: new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000 - snap.utcOffsetSeconds * 1000), day: 'tomorrow', minutes, activity });
  if (!plan.hours.length) return null;
  return {
    date,
    status: plan.hours.reduce<Status>((s, h) => worse(s, h.status), 'good'),
    peakHeatIndexF: Math.round(Math.max(...plan.hours.map((h) => h.heatIndexF))),
    coldestFeelsF: Math.round(Math.min(...plan.hours.map((h) => h.feelsF))),
    best: plan.best,
    worst: plan.worst,
    stayIn: stayInOf(plan.hours),
  };
}

/** Every waking hour of a past date, judged. Quicker than planDay, and enough for counting days. */
function judgePast(snap: LocationSnapshot, p: Profile, date: string): JudgedDay | null {
  const hours = snap.hourly.filter((h) => h.local.startsWith(date) && hourOf(h.local) >= FIRST_HOUR && hourOf(h.local) <= LAST_HOUR).map((h) => judgeHour(h, p));
  if (!hours.length) return null;
  return {
    date,
    status: hours.reduce<Status>((s, h) => worse(s, h.status), 'good'),
    peakHeatIndexF: Math.round(Math.max(...hours.map((h) => h.heatIndexF))),
    coldestFeelsF: Math.round(Math.min(...hours.map((h) => h.feelsF))),
    best: null,
    worst: null,
    stayIn: stayInOf(hours),
  };
}

export const weekday = (date: string): string => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
export const monthDay = (date: string): string => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const monthName = (ym: string): string => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
const andList = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isColdDay = (d: JudgedDay) => d.coldestFeelsF <= 50 && d.peakHeatIndexF < 80;
const feelsWords = (d: JudgedDay) => (isColdDay(d) ? `wind chill down to ${d.coldestFeelsF}` : `heat index up to ${d.peakHeatIndexF}`);

/* ------------------------------------------------------------------ the week ahead */

export type WorkHours = { start: number; end: number; days?: number[] };

export type WeekDay = JudgedDay & {
  name: string;
  /** How the trip to work and the trip home look for this person, when work hours were given. */
  commute?: { going: Status | null; home: Status | null; workFromHome: boolean; cold?: boolean };
};

export type WeekPlan = { days: WeekDay[]; spoken: string; hotDays: string[] };

/** Monday is 1 and Sunday 7, as people count a working week. */
const isoDay = (date: string) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

export function planWeek(
  snap: LocationSnapshot,
  p: Profile,
  opts: { now: Date; minutes?: number; activity?: string; work?: WorkHours | null; doctorSays?: string | null },
): WeekPlan {
  const today = new Date(opts.now.getTime() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const named = (d: string) => (d === today ? 'today' : d === tomorrow ? 'tomorrow' : weekday(d));

  const days: WeekDay[] = [];
  for (const date of datesOf(snap).filter((d) => d >= today).slice(0, 7)) {
    const j = judgeDate(snap, p, date, today, opts.now, opts.minutes, opts.activity);
    if (!j) continue;
    const day: WeekDay = { ...j, name: named(date) };
    const w = opts.work;
    if (w && (w.days ?? [1, 2, 3, 4, 5]).includes(isoDay(date))) {
      // A trip already made today is not one to plan around.
      const nowLocal = new Date(opts.now.getTime() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 13);
      const at = (onDate: string, hour: number) => {
        const h = snap.hourly.find((x) => x.local.startsWith(onDate) && hourOf(x.local) === hour);
        if (!h || h.local.slice(0, 13) < nowLocal) return null;
        return judgeHour(h, p);
      };
      // The trip there is the hour before work starts; the trip home is the hour work ends. A night shift, ten
      // to six, ends the next morning, and used to be dropped without a word because the end was before the start.
      const nextDate = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const going = at(date, Math.max(0, w.start - 1));
      const home = w.end > w.start ? at(date, Math.min(23, w.end)) : at(nextDate, w.end % 24);
      const cold = [going, home].some((x) => x?.status === 'avoid' && x.feelsF <= 50);
      day.commute = { going: going?.status ?? null, home: home?.status ?? null, workFromHome: going?.status === 'avoid' || home?.status === 'avoid', ...(cold ? { cold: true } : {}) };
    }
    days.push(day);
  }

  const because = p.sensitivity !== 'general' && !p.private && p.because ? p.because : '';
  const parts: string[] = [];
  const stay = days.filter((d) => d.status === 'avoid');
  const hotStay = stay.filter((d) => !isColdDay(d));
  const coldStay = stay.filter(isColdDay);
  const care = days.filter((d) => d.status === 'caution');
  const fine = days.filter((d) => d.status === 'good');

  if (!days.length) {
    parts.push("I don't have the week's forecast yet.");
  } else {
    // What was asked for comes first: the answer is shortened for voice, and the day list is the long part.
    if (opts.activity) {
      const ranked = [...days].filter((d) => d.best).sort((a, b) => RANK[a.best!.status] - RANK[b.best!.status] || Math.abs(a.best!.peakHeatIndexF - 70) - Math.abs(b.best!.peakHeatIndexF - 70));
      const top = ranked[0];
      if (top?.best) parts.push(`The best day for ${opts.activity} is ${top.name}, ${top.best.label}.`);
    }
    const home = days.filter((d) => d.commute?.workFromHome);
    if (home.length) {
      // Cold or heat decides what to say about going in anyway: water and air conditioning mean nothing at minus ten.
      const coldTrip = home.some((d) => d.commute?.cold);
      parts.push(
        `Your trip to or from work falls in stay-in hours ${andList(home.map((d) => d.name))}, so work from home ${home.length === 1 ? 'that day' : 'those days'} if you can. ` +
          (coldTrip
            ? 'If you have to go in, dress in layers with a hat and gloves, cover your skin, and keep the time outside short.'
            : 'If you have to go in, keep water with you and go straight from air conditioning to air conditioning.'),
      );
    } else if (opts.work && days.some((d) => d.commute)) {
      parts.push('Your trips to and from work stay out of stay-in hours all week.');
    }

    // The reason heard with a hot day is the heat reason, and a cold day is said as cold. "Because your medication
    // blocks your sweating, you have hours to stay in" was said about a week of freezing mornings in Fairbanks.
    if (hotStay.length) {
      const hottest = [...hotStay].sort((a, b) => b.peakHeatIndexF - a.peakHeatIndexF)[0];
      parts.push(
        `${because ? `${cap(because)}, you` : 'You'} have hours to stay in out of the heat ${andList(hotStay.map((d) => (d.worst ? `${d.name} ${d.worst.label}` : d.name)))}.` +
          ` The hottest is ${hottest.name}, heat index ${hottest.peakHeatIndexF}.`,
      );
    }
    if (coldStay.length) {
      const coldest = [...coldStay].sort((a, b) => a.coldestFeelsF - b.coldestFeelsF)[0];
      parts.push(
        `It is too cold for you to be out ${andList(coldStay.map((d) => (d.worst ? `${d.name} ${d.worst.label}` : d.name)))}.` +
          ` The coldest is ${coldest.name}, with a wind chill of ${coldest.coldestFeelsF}.`,
      );
    }
    if (!stay.length) parts.push(`This week has no stay-in days for you${because ? `, ${because}` : ''}.`);
    if (care.length) parts.push(`Take care ${andList(care.map((d) => d.name))}.`);
    if (fine.length === days.length) parts.push('Every day is fine all day.');
    else if (fine.length) parts.push(`${cap(andList(fine.map((d) => d.name)))} ${fine.length === 1 ? 'is' : 'are'} fine all day.`);
  }

  const hotDays = [...stay, ...care].filter((d) => !isColdDay(d)).map((d) => d.name);
  if (opts.doctorSays && hotDays.length) parts.push(`On those days, remember what your doctor told you: ${opts.doctorSays}`);

  return { days, spoken: parts.join(' '), hotDays };
}

/* ------------------------------------------------------------------ the days gone */

export type Patterns = {
  period: Period;
  from: string;
  to: string;
  days: JudgedDay[];
  stayDays: number;
  careDays: number;
  fineDays: number;
  coldDays: number;
  byMonth: { month: string; stay: number; care: number; cold: number }[];
  spoken: string;
};

export function patterns(snap: LocationSnapshot, p: Profile, period: Period, opts: { place: string; unwell?: number; now: Date }): Patterns {
  const today = new Date(opts.now.getTime() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
  // Whole days only, and never today, which is not over.
  const dates = datesOf(snap).filter((d) => d < today).slice(-PERIOD_DAYS[period]);
  const days = dates.map((d) => judgePast(snap, p, d)).filter((d): d is JudgedDay => !!d);
  const stay = days.filter((d) => d.status === 'avoid');
  const care = days.filter((d) => d.status === 'caution');
  const cold = days.filter((d) => d.status !== 'good' && isColdDay(d));
  const months = new Map<string, { stay: number; care: number; cold: number }>();
  for (const d of days) {
    const m = months.get(d.date.slice(0, 7)) ?? { stay: 0, care: 0, cold: 0 };
    // Stay and care count the heat only; the cold is counted on its own, so Fairbanks winters are not a hot season.
    if (d.status === 'avoid' && !isColdDay(d)) m.stay += 1;
    if (d.status === 'caution' && !isColdDay(d)) m.care += 1;
    if (d.status !== 'good' && isColdDay(d)) m.cold += 1;
    months.set(d.date.slice(0, 7), m);
  }
  const byMonth = [...months.entries()].map(([month, v]) => ({ month, ...v }));

  const span = period === 'week' ? 'the last 7 days' : period === 'month' ? 'the last 30 days' : 'the last year';
  const lag = period === 'week' ? '' : `, up to ${monthDay(dates[dates.length - 1] ?? today)}`;
  const parts: string[] = [];
  if (!days.length) {
    parts.push(`I couldn't get the weather history for ${opts.place}.`);
  } else {
    const hotStay = stay.filter((d) => !isColdDay(d));
    const coldStay = stay.filter(isColdDay);
    parts.push(
      `Over ${span} in ${opts.place}${lag}, ${hotStay.length ? `${hotStay.length} of ${days.length} days had hours too hot for you to be out` : `no day was too hot for you to be out`}` +
        `${care.filter((d) => !isColdDay(d)).length ? `, and ${care.filter((d) => !isColdDay(d)).length} more needed care in the heat` : ''}.`,
    );
    if (coldStay.length) parts.push(`${coldStay.length} ${coldStay.length === 1 ? 'day was' : 'days were'} too cold for you.`);
    const worst = [...days].sort((a, b) => b.peakHeatIndexF - a.peakHeatIndexF)[0];
    if (worst && worst.peakHeatIndexF >= 80) parts.push(`The hottest was ${period === 'week' ? weekday(worst.date) : monthDay(worst.date)}, heat index ${worst.peakHeatIndexF}.`);
    if (period === 'year' && hotStay.length) {
      // The season is the longest run of months, in the order they came, with a stay-in day most weeks. Taken from
      // the first and last stay-in day instead, a year that starts and ends in the hot season read "October 18 to
      // October 11".
      let run: string[] = [];
      let longest: string[] = [];
      for (const m of byMonth) {
        run = m.stay >= 8 ? [...run, m.month] : [];
        if (run.length > longest.length) longest = run;
      }
      if (longest.length >= 2 && longest.length < byMonth.length) parts.push(`Your hot season ran from ${monthName(longest[0])} to ${monthName(longest[longest.length - 1])}.`);
      else if (longest.length >= byMonth.length - 1) parts.push('It was hot for you most of the year.');
      const peak = [...byMonth].sort((a, b) => b.stay - a.stay)[0];
      if (peak && peak.stay) parts.push(`${monthName(peak.month)} was the worst month, with ${peak.stay} stay-in days.`);
      const none = byMonth.filter((m) => m.stay === 0 && m.care === 0 && m.cold === 0).map((m) => monthName(m.month));
      if (none.length && none.length < 12) parts.push(`${andList(none)} ${none.length === 1 ? 'was' : 'were'} clear all month.`);
    }
    if (period === 'month' && hotStay.length) {
      const half = days.length / 2;
      const early = hotStay.filter((d) => days.indexOf(d) < half).length;
      const late = hotStay.length - early;
      if (early !== late) parts.push(late < early ? 'It eased in the second half.' : 'It got worse in the second half.');
    }
  }
  if (opts.unwell) parts.push(`You told me you felt unwell ${opts.unwell === 1 ? 'once' : `${opts.unwell} times`} in that time.`);

  return {
    period,
    from: dates[0] ?? today,
    to: dates[dates.length - 1] ?? today,
    days,
    stayDays: stay.length,
    careDays: care.length,
    fineDays: days.length - stay.length - care.length,
    coldDays: cold.length,
    byMonth,
    spoken: parts.join(' '),
  };
}

/** The dates of a trip, judged: from the forecast when they are in it, otherwise null. */
export function judgeTrip(snap: LocationSnapshot, p: Profile, from: string, to: string, now: Date): JudgedDay[] {
  const today = new Date(now.getTime() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
  return datesOf(snap)
    .filter((d) => d >= from && d <= to && d >= today)
    .map((d) => judgeDate(snap, p, d, today, now))
    .filter((d): d is JudgedDay => !!d);
}

/** The same dates last year, judged hour by hour. */
export function judgeLastYear(snap: LocationSnapshot, p: Profile): JudgedDay[] {
  return datesOf(snap).map((d) => judgePast(snap, p, d)).filter((d): d is JudgedDay => !!d);
}

/* ------------------------------------------------------------------ one day, any day */

/** The weather record the archive holds starts in 1940. */
export const EARLIEST_DAY = '1940-01-01';

/**
 * The hours of one day, past or ahead. Open-Meteo's forecast service answers for about three months back and two
 * weeks ahead; anything older comes from the archive (ERA5), which runs about five days behind, so the two overlap.
 */
export function dayHours(lat: number, lon: number, date: string, now = new Date()): Promise<LocationSnapshot> {
  const daysBack = (now.getTime() - Date.parse(`${date}T12:00:00Z`)) / 86_400_000;
  const recent = daysBack < 80;
  return cached(`day:${date}`, lat, lon, recent ? WEEK_TTL : PAST_TTL, async () => {
    const base = recent ? FORECAST : ARCHIVE;
    const vars = recent ? HOURLY : 'temperature_2m,relative_humidity_2m,wind_speed_10m,is_day,shortwave_radiation';
    const body = await fetchJson(`${base}?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=${vars}${UNITS}`, 12_000);
    return parseForecast(lat, lon, withCurrent(body), null);
  });
}

/** One date judged for this person, with the hours to avoid and the easiest stretch, from the same planner. */
export function judgeDay(snap: LocationSnapshot, p: Profile, date: string, now: Date, minutes?: number, activity?: string): JudgedDay | null {
  const today = new Date(now.getTime() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
  return judgeDate(snap, p, date, today, now, minutes, activity);
}

const longDate = (date: string, withYear: boolean) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });

/** One day said aloud: what it was or will be like, for this person, and when to be out or in. */
export function speakDay(d: JudgedDay, p: Profile, opts: { place: string; past: boolean; today: string; activity?: string }): string {
  const withYear = d.date.slice(0, 4) !== opts.today.slice(0, 4);
  const when = d.date === opts.today ? 'Today' : `On ${longDate(d.date, withYear)}`;
  const cold = isColdDay(d);
  // "Because your medication blocks your sweating", said first, so the sentence reads straight.
  const lead = p.sensitivity !== 'general' && !p.private && p.because ? `${cap(p.because)}, ` : '';
  const parts: string[] = [];
  if (opts.past) {
    parts.push(`${when} in ${opts.place}, ${cold ? `the wind chill dropped to ${d.coldestFeelsF}` : `the heat index reached ${d.peakHeatIndexF}`}.`);
    if (d.status === 'avoid') {
      const span = d.stayIn ?? 'some hours';
      parts.push(`${lead ? `${lead}for you` : 'For you,'} ${span} ${/ to /.test(span) || span === 'some hours' ? 'were' : 'was'} ${cold ? 'too cold to be out' : 'stay-in hours'}.`);
    } else if (d.status === 'caution') parts.push(`${lead ? `${lead}for you` : 'For you,'} it was a day for care rather than staying in.`);
    else parts.push('For you, it was fine to be out all day.');
  } else {
    parts.push(`${when} in ${opts.place}, ${cold ? `the wind chill drops to ${d.coldestFeelsF}` : `the heat index reaches ${d.peakHeatIndexF}`}.`);
    const what = opts.activity ? `for ${opts.activity}` : 'to be out';
    if (d.status === 'good') parts.push(`It stays fine for you all day${opts.activity ? `, so any time works ${what}` : ''}.`);
    else {
      if (d.stayIn) parts.push(`${lead}${lead ? 'stay' : 'Stay'} in ${d.stayIn} if you can.`);
      if (d.best && d.best.status !== 'avoid') parts.push(`The best time ${what} is ${d.best.label}.`);
      else if (d.best) parts.push(`If you have to go, ${d.best.label} is the least risky.`);
    }
  }
  return parts.join(' ');
}
