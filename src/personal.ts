/**
 * One person's day: when to go out, what to avoid, and what to do if they
 * have to go anyway.
 *
 * A heat advisory is written for everyone, and "everyone" is the wrong
 * threshold for most of the people this is for. The NWS and CDC HeatRisk scale
 * says it plainly: heat that is "tolerated by most" already carries risk for
 * "extremely heat-sensitive" people, and the next level up affects people who
 * are "sensitive to heat". This applies that same one level offset to the NWS
 * heat index categories, which is an approximation and is said to be one, but
 * it is the approximation the official scale itself makes.
 *
 *   everyone else     caution from extreme caution (90F), avoid from danger (103F)
 *   sensitive         caution from caution (80F),         avoid from extreme caution (90F)
 *   extremely         avoid from caution (80F)
 *
 * On top of heat: UV for anyone whose medication makes them burn faster, using
 * the EPA's own line of UV 3 for "protection needed", and air quality for heart
 * and lung conditions, using AirNow's line of AQI 101 for sensitive groups and
 * 151 for everyone.
 */

import { heatIndexF, heatCategory, GUIDANCE, type HeatCategory } from './domain.js';
import { MECHANISM_LABEL, type Mechanism } from './meds.js';
import { conditionById, type Condition } from './conditions.js';
import type { Hour, LocationSnapshot } from './weather.js';
import { windChillF, coldCategory } from './cold.js';
import { pastOlderLimit } from './physiology.js';

export type Sensitivity = 'general' | 'sensitive' | 'extreme';
export type Status = 'good' | 'caution' | 'avoid';

export type Profile = {
  sensitivity: Sensitivity;
  /** Why, in words that follow a comma: "with multiple sclerosis". Null for everyone else. */
  because: string | null;
  conditions: Condition[];
  mechanisms: Mechanism[];
  photosensitive: boolean;
  airQuality: boolean;
  noIce: boolean;
  insulin: boolean;
  fluidLimit: boolean;
  /** Privacy mode: spoken answers do not name medications or conditions. */
  private: boolean;
  /** A condition or a medicine makes cold harder on this person, so "cold" is already a reason for care. */
  coldSensitive: boolean;
  /**
   * The lowest heat index at which this person has said they felt unwell. It
   * only ever tightens the limit; feeling fine on a hot day never loosens it,
   * because one good afternoon is not evidence that the next one is safe.
   */
  learnedLimitF: number | null;
  /**
   * Whose limit the older adult chamber measurement speaks to (physiology.ts): 'older' for someone 65 or over,
   * 'blocked' for someone whose medicine blocks sweating, whose limit is lower still. Null for everyone else.
   */
  olderLimit: 'older' | 'blocked' | null;
};

/** The reason an hour carries when it is past that measured limit. */
export const OLDER_LIMIT_REASON = 'past the limit measured for older adults';

const SEVERITY: Record<Mechanism, number> = {
  reduced_sweating: 5,
  increased_heat_production: 4,
  reduced_thirst_or_sedation: 3,
  hyponatremia_risk: 4,
  electrolyte_imbalance: 3,
  increased_sweating: 2,
  // Between electrolyte trouble and sweating more. It is a real fluid deficit the
  // person is unaware of, and it compounds with heat rather than being caused by
  // it, but it does not take the cooling system away, so it does not sit with
  // reduced sweating.
  fluid_loss: 3,
  // Less heat leaves through the skin: a real loss of cooling, short of losing sweat.
  reduced_vasodilation: 3,
  // These two do not change how hot the body gets. They change what a hot day costs: a fall, or a kidney.
  faint_risk: 2,
  kidney_risk: 2,
  liver_risk: 2,
  // About the medicine, not the person, so it never moves anybody's limit.
  heat_damaged: 0,
  photosensitivity: 0,
};

/** The lowest heat index at which feeling unwell is taken as being about the heat: the start of "caution". */
export const LEARN_FROM_F = 80;

export function profileOf(
  mechanisms: Mechanism[],
  conditionIds: string[],
  extras: { outings?: { felt: 'fine' | 'unwell'; heatIndexF: number | null }[]; private?: boolean; coldSensitive?: boolean } = {},
): Profile {
  const conditions = conditionIds.map(conditionById).filter((c): c is Condition => !!c);
  const heat = [...new Set(mechanisms.filter((m) => m !== 'photosensitivity'))].sort((a, b) => SEVERITY[b] - SEVERITY[a]);
  const extremeCondition = conditions.find((c) => c.sensitivity === 'extreme');
  // Blocked sweating and extra heat production remove the body's own margin,
  // so those two put a person in the extremely sensitive group on their own.
  const extremeMedication = heat.find((m) => m === 'reduced_sweating' || m === 'increased_heat_production');

  let sensitivity: Sensitivity = 'general';
  let because: string | null = null;
  if (extremeCondition) {
    sensitivity = 'extreme';
    because = `with ${extremeCondition.label}`;
  } else if (extremeMedication) {
    sensitivity = 'extreme';
    because = `because your medication ${MECHANISM_LABEL[extremeMedication]}`;
  } else if (conditions.some((c) => c.sensitivity !== 'general')) {
    // Hay fever and migraine change some advice and do not move anybody's heat limit.
    sensitivity = 'sensitive';
    because = `with ${conditions.find((c) => c.sensitivity !== 'general')!.label}`;
  } else if (heat.length) {
    sensitivity = 'sensitive';
    because = `because your medication ${MECHANISM_LABEL[heat[0]]}`;
  }

  const isPrivate = extras.private === true;
  if (isPrivate && because) because = 'because of your health profile';
  // Only an outing in real heat teaches a heat limit. Feeling dizzy on a 62 degree day is worth knowing
  // about, but it used to set the limit to 62, after which every hour of every day was "stay inside" for
  // good, with no way to undo it short of deleting the whole profile.
  const unwell = (extras.outings ?? [])
    .filter((o) => o.felt === 'unwell' && typeof o.heatIndexF === 'number' && (o.heatIndexF as number) >= LEARN_FROM_F)
    .map((o) => Math.round(o.heatIndexF as number));

  return {
    sensitivity,
    because,
    conditions,
    mechanisms,
    photosensitive: mechanisms.includes('photosensitivity'),
    airQuality: conditions.some((c) => c.airQuality),
    noIce: conditions.some((c) => c.noIce),
    insulin: conditions.some((c) => c.insulin),
    fluidLimit: conditions.some((c) => c.fluidLimit),
    private: isPrivate,
    coldSensitive: extras.coldSensitive === true || conditions.some((c) => !!c.cold),
    learnedLimitF: unwell.length ? Math.min(...unwell) : null,
    olderLimit: conditions.some((c) => c.id === 'older_adult') ? 'older' : heat.includes('reduced_sweating') ? 'blocked' : null,
  };
}

const CATEGORY_RANK: Record<HeatCategory, number> = { none: 0, caution: 1, extreme_caution: 2, danger: 3, extreme_danger: 4 };
const LIMIT: Record<Sensitivity, { caution: number; avoid: number }> = {
  general: { caution: 2, avoid: 3 },
  sensitive: { caution: 1, avoid: 2 },
  extreme: { caution: 1, avoid: 1 },
};
const STATUS_RANK: Record<Status, number> = { good: 0, caution: 1, avoid: 2 };
const worse = (a: Status, b: Status): Status => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a);

export type Judged = {
  local: string;
  time: string;
  heatIndexF: number;
  category: HeatCategory;
  status: Status;
  reasons: string[];
  isDay: boolean;
  uvIndex: number;
  aqi: number | null;
  /** What it feels like: the wind chill when it is cold, the heat index otherwise. */
  feelsF: number;
};

export function judgeHour(h: Hour, p: Profile): Judged {
  const hi = heatIndexF(h.tempF, h.humidityPct);
  const category = heatCategory(hi);
  const rank = CATEGORY_RANK[category];
  const limit = LIMIT[p.sensitivity];
  let status: Status = rank >= limit.avoid ? 'avoid' : rank >= limit.caution ? 'caution' : 'good';
  const reasons: string[] = status === 'good' ? [] : [`heat index ${Math.round(hi)}`];

  if (p.learnedLimitF != null && hi >= p.learnedLimitF) {
    if (status === 'good') reasons.push(`heat index ${Math.round(hi)}`);
    status = 'avoid';
    reasons.push('felt unwell at this heat before');
  }

  // Past the limit measured in healthy older adults doing light everyday things: whatever the category says,
  // their body cannot keep up there. See physiology.ts.
  if (p.olderLimit && pastOlderLimit(h.tempF, h.humidityPct, 'light')) {
    if (status === 'good') reasons.push(`heat index ${Math.round(hi)}`);
    status = 'avoid';
    reasons.push(OLDER_LIMIT_REASON);
  }

  // The cold half. Without it the planner only knew about heat, so on a winter day it judged every hour
  // "good" and then recommended the coolest one, which is six in the morning at five degrees.
  const chill = windChillF(h.tempF, Number.isFinite(h.windMph) ? h.windMph : 0);
  const band = coldCategory(chill);
  if (band === 'dangerous' || (band === 'very_cold' && p.coldSensitive)) {
    status = 'avoid';
    reasons.push(`wind chill ${Math.round(chill)}`);
  } else if (band === 'very_cold' || (band === 'cold' && p.coldSensitive)) {
    status = worse(status, 'caution');
    reasons.push(`wind chill ${Math.round(chill)}`);
  }

  if (p.photosensitive && h.isDay && h.uvIndex >= 3) {
    status = worse(status, 'caution');
    reasons.push(`UV ${Math.round(h.uvIndex)}`);
  }
  if (p.airQuality && h.aqi != null && h.aqi > 100) {
    status = worse(status, h.aqi > 150 ? 'avoid' : 'caution');
    reasons.push(`air quality ${h.aqi}`);
  }
  const feelsF = band === 'none' ? hi : chill;
  return { local: h.local, time: h.time, heatIndexF: hi, category, status, reasons, isDay: h.isDay, uvIndex: h.uvIndex, aqi: h.aqi, feelsF };
}

const hourOf = (local: string) => Number(local.slice(11, 13));
const clock = (h: number) => ({ n: h % 12 === 0 ? 12 : h % 12, half: h % 24 < 12 ? 'am' : 'pm' });

/** "6 to 9 am", "11 am to 7 pm", "9 pm to 12 am". */
export function spanLabel(startLocal: string, hours: number): string {
  const s = hourOf(startLocal);
  const a = clock(s);
  const b = clock((s + hours) % 24);
  return a.half === b.half && s + hours < 24 ? `${a.n} to ${b.n} ${b.half}` : `${a.n} ${a.half} to ${b.n} ${b.half}`;
}
export const hourLabel = (local: string) => {
  const c = clock(hourOf(local));
  return `${c.n} ${c.half}`;
};

export type Span = {
  startLocal: string;
  hours: number;
  label: string;
  peakHeatIndexF: number;
  /** The coldest it feels in the span. Fifty or below means this is a cold stretch, not a hot one. */
  coldestFeelsF: number;
  reasons: string[];
};

function runs(hours: Judged[], status: Status): Judged[][] {
  const out: Judged[][] = [];
  let run: Judged[] = [];
  for (const h of hours) {
    const continues = run.length > 0 && hourOf(h.local) === hourOf(run[run.length - 1].local) + 1;
    if (h.status === status && (run.length === 0 || continues)) run.push(h);
    else {
      if (run.length) out.push(run);
      run = h.status === status ? [h] : [];
    }
  }
  if (run.length) out.push(run);
  return out;
}

const toSpan = (run: Judged[]): Span => ({
  startLocal: run[0].local,
  hours: run.length,
  label: spanLabel(run[0].local, run.length),
  peakHeatIndexF: Math.round(Math.max(...run.map((h) => h.heatIndexF))),
  coldestFeelsF: Math.round(Math.min(...run.map((h) => h.feelsF))),
  reasons: [...new Set(run.flatMap((h) => h.reasons.map((r) => r.replace(/-?\d+$/, '').trim())))],
});

/** People plan errands for waking hours, so the planner looks at 6 am to 10 pm local. */
const FIRST_HOUR = 6;
const LAST_HOUR = 21;

export type DayPlan = {
  day: 'today' | 'tomorrow';
  date: string;
  hours: Judged[];
  /**
   * The least risky stretch long enough for the activity. Present whenever any
   * hours remain, because "no time is safe" leaves a person with nothing to
   * plan around, while "6 am is the least risky, and here is how" does not.
   */
  best: (Span & { status: Status }) | null;
  /** A second comfortable stretch that does not overlap the first, such as the evening. */
  alsoGood: Span | null;
  /** The longest stretch to stay in, only when it does not overlap the best one. */
  worst: Span | null;
  spoken: string;
};

const worstStatusOf = (run: Judged[]): Status => run.reduce<Status>((s, h) => worse(s, h.status), 'good');
const consecutive = (run: Judged[]) => run.every((h, i) => i === 0 || hourOf(h.local) === hourOf(run[i - 1].local) + 1);
/** How far from comfortable the worst hour is. Between two equally safe stretches, the milder one wins. */
const COMFORTABLE_F = 68;
const discomfort = (run: Judged[]) => Math.max(...run.map((h) => Math.abs(h.feelsF - COMFORTABLE_F)));
const isCold = (s: { coldestFeelsF: number }) => s.coldestFeelsF <= 50;
const feels = (s: Span) => (isCold(s) ? `wind chill about ${s.coldestFeelsF}` : `heat index about ${s.peakHeatIndexF}`);

export function planDay(
  snap: LocationSnapshot,
  p: Profile,
  opts: { now: Date; day?: 'today' | 'tomorrow'; minutes?: number; activity?: string },
): DayPlan {
  const day = opts.day ?? 'today';
  const offsetMs = snap.utcOffsetSeconds * 1000;
  const localNow = new Date(opts.now.getTime() + offsetMs).toISOString();
  const date = day === 'today' ? localNow.slice(0, 10) : new Date(opts.now.getTime() + offsetMs + 86_400_000).toISOString().slice(0, 10);
  const fromHour = day === 'today' ? localNow.slice(0, 13) : '';

  const hours = snap.hourly
    .filter((h) => h.local.startsWith(date) && h.local.slice(0, 13) >= fromHour)
    .filter((h) => hourOf(h.local) >= FIRST_HOUR && hourOf(h.local) <= LAST_HOUR)
    .map((h) => judgeHour(h, p));

  const need = Math.max(1, Math.ceil((opts.minutes ?? 60) / 60));

  // Every stretch long enough for the activity, scored by its worst hour and then its hottest.
  let pick: Judged[] | null = null;
  for (let i = 0; i + need <= hours.length; i++) {
    const w = hours.slice(i, i + need);
    if (!consecutive(w)) continue;
    if (!pick) {
      pick = w;
      continue;
    }
    const a = STATUS_RANK[worstStatusOf(w)];
    const b = STATUS_RANK[worstStatusOf(pick)];
    if (a < b || (a === b && discomfort(w) < discomfort(pick))) pick = w;
  }

  // A comfortable pick is widened to the whole comfortable stretch around it.
  const chosen = pick && worstStatusOf(pick) === 'good' ? runs(hours, 'good').find((r) => r.includes(pick![0])) ?? pick : pick;
  const best = chosen ? { ...toSpan(chosen), status: worstStatusOf(chosen) } : null;
  const overlaps = (run: Judged[]) => !!chosen && run.some((h) => chosen.includes(h));
  const alsoRun = best?.status === 'good' ? runs(hours, 'good').find((r) => r.length >= need && !overlaps(r)) : undefined;
  const alsoGood = alsoRun ? toSpan(alsoRun) : null;
  const avoidRuns = runs(hours, 'avoid').filter((r) => !overlaps(r));
  const longestAvoid = avoidRuns.length ? avoidRuns.reduce((a, b) => (b.length > a.length ? b : a)) : null;
  const worst = longestAvoid && longestAvoid.length >= 2 ? toSpan(longestAvoid) : null;

  const when = day === 'tomorrow' ? 'tomorrow' : 'today';
  // "a walk" and "gardening" take "for"; "walk the dog" and "mow the lawn" are things to do, and take "to".
  const verb = /^(walk|go|do|mow|run|jog|cycle|bike|ride|swim|play|work|garden|shop|fetch|get|take|wash|cut|water|clean|hike|fish|visit|pick|drive|paint|dig|plant|fix)\b/i;
  const what = opts.activity ? (verb.test(opts.activity) ? `to ${opts.activity}` : `for ${opts.activity}`) : 'to be outside';
  const because = p.sensitivity === 'general' ? '' : `, ${p.because}`;
  const cap = (x: string) => `${x.charAt(0).toUpperCase()}${x.slice(1)}`;
  const parts: string[] = [];

  if (!hours.length) {
    parts.push(day === 'today' ? "Today's daytime hours are over. Ask me about tomorrow." : "I don't have tomorrow's forecast yet.");
  } else if (!best) {
    parts.push(`There isn't a long enough stretch left ${when} ${what}.`);
  } else if (best.status === 'good') {
    parts.push(`The best time ${what} ${when}${because ? `${because},` : ''} is ${best.label}, ${feels(best)}.`);
    if (alsoGood) parts.push(`${cap(alsoGood.label)} works too.`);
  } else if (best.status === 'caution') {
    parts.push(`The best time ${what} ${when} is ${best.label}, ${feels(best)}. Take care even then${because}.`);
  } else {
    parts.push(
      `It stays ${isCold(best) ? 'too cold' : 'hot'} for you all ${when === 'today' ? 'day' : 'of tomorrow'}${because}. If you need to go, ${best.label} is the least risky, ` +
        `${feels(best)}, and ask me what precautions to take.`,
    );
  }
  if (p.learnedLimitF != null && hours.some((h) => h.heatIndexF >= (p.learnedLimitF as number))) {
    parts.push(`You felt unwell near heat index ${p.learnedLimitF} before, so I'm treating that as your limit.`);
  }
  if (worst) {
    const why = worst.reasons.filter((r) => r !== 'heat index' && r !== 'wind chill' && r !== 'felt unwell at this heat before' && r !== OLDER_LIMIT_REASON);
    parts.push(
      `Avoid ${worst.label} if you can, when the ${isCold(worst) ? `wind chill drops to ${worst.coldestFeelsF}` : `heat index reaches ${worst.peakHeatIndexF}`}` +
        `${why.length ? ` and ${why.join(' and ')} is a problem` : ''}.`,
    );
  }

  return { day, date, hours, best, alsoGood, worst, spoken: parts.join(' ') };
}

/**
 * A shift, which is a day somebody cannot move.
 *
 * Everything above assumes the person can choose when to go out. Somebody who works outside cannot: the
 * shift is seven to three whatever the forecast says, and what they can change is when they stop, where,
 * and who is watching. So this does not look for a window. It walks the hours of the shift and says when
 * each line is crossed.
 *
 * The two lines are the ones in the workplace heat rule OSHA proposed in 2024: a heat index of 80, where
 * water and a shaded break area are owed, and 90, where a fifteen minute rest break at least every two hours
 * and watching each other for symptoms are. They are written for a healthy acclimatised worker. The third
 * line is this person's own: the first hour that is an "avoid" for them, given what they take and what they
 * have, which is often earlier, and is the reason this lives here and not on a poster in the yard.
 */
/**
 * Getting used to the heat.
 *
 * Of outdoor workers who died of heat between 2011 and 2016, 79 percent were in their first two weeks on the
 * job or just back from more than a week away. A body adapts to heat over days, and loses it in about a week.
 * The schedule NIOSH recommends, and OSHA publishes on its page for protecting new workers, is the one used
 * here: somebody new works 20 percent of a usual day in the heat on the first day and adds 20 percent a day;
 * somebody returning does 50, 60, 80 and then a full day.
 * https://www.osha.gov/heat-exposure/protecting-new-workers
 */
export type Acclimatization = { kind: 'new' | 'returning'; day: number; fraction: number };

export function acclimatization(work: { kind: 'new' | 'returning'; since: string } | null | undefined, localDate: string, workDay?: number): Acclimatization | null {
  if (!work) return null;
  // The day of the build-up: counted in working days when the week plan knows which days they work, otherwise in
  // calendar days from the day they started.
  const day = workDay ?? Math.round((Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${work.since}T00:00:00Z`)) / 86_400_000) + 1;
  if (!Number.isFinite(day) || day < 1) return null;
  const fraction = work.kind === 'new' ? Math.min(1, 0.2 * day) : [0.5, 0.6, 0.8, 1][Math.min(3, day - 1)];
  return fraction >= 1 ? null : { kind: work.kind, day, fraction };
}

/**
 * The time in the heat allowed today while getting used to it, and when to take it.
 *
 * It is not a time to go home. NIOSH has the rest of the shift spent away from the heat, in a cooler place or
 * on work out of the sun, and OSHA's page for new workers asks for shorter spells in the heat. So the hours
 * go where the shift is coolest, and the answer says what to do for the rest. Asked after that stretch, it
 * cannot know whether they were out in it, so it says both: the rest out of the heat if they were, and the
 * coolest stretch left if they were not.
 * https://www.cdc.gov/niosh/heat-stress/recommendations/acclimatization.html
 */
export type HeatTime = {
  kind: 'new' | 'returning';
  day: number;
  heatHoursAllowed: number;
  /** The coolest stretch of the shift for it, "7 am" to "9 am". */
  from: string;
  doneBy: string;
  /** Asked today, after that stretch. */
  passed: boolean;
  /** The coolest stretch still to come, when it has passed and one is left. */
  coolestLeft: { from: string; doneBy: string } | null;
  /** Whether every hour of the shift is in the heat, or only some of it. */
  restOf: 'shift' | 'hot hours';
};

/** "spend the rest of the shift in the shade or inside", and the same for the hot hours only. */
export const restOut = (restOf: HeatTime['restOf']) => `spend the rest of ${restOf === 'shift' ? 'the shift' : 'the hot hours'} in the shade or inside`;

/** What to say about the time in the heat, for a person ("you") or about somebody ("they"). */
export function heatTimeSaid(a: HeatTime, who: 'you' | 'they' = 'you'): string {
  const n = `${a.heatHoursAllowed} ${a.heatHoursAllowed === 1 ? 'hour' : 'hours'}`;
  const had = who === 'you' ? "you've" : "they've";
  const rest = who === 'you' ? restOut(a.restOf) : `they should ${restOut(a.restOf)}`;
  if (!a.passed) return `${n} out in the heat at most, ${a.from} to ${a.doneBy}, while it's coolest, and ${rest}.`;
  return (
    `${n} out in the heat at most. The coolest stretch for it, ${a.from} to ${a.doneBy}, has passed, so if ${had} had ${who === 'you' ? 'your' : 'their'} ${n}, ${rest}` +
    `${a.coolestLeft ? `; if not, ${a.coolestLeft.from} to ${a.coolestLeft.doneBy} is the coolest left` : ''}.`
  );
}

export const WORK_INITIAL_F = 80;
export const WORK_HIGH_F = 90;

export type ShiftPlan = {
  day: 'today' | 'tomorrow';
  date: string;
  label: string;
  hours: Judged[];
  peakHeatIndexF: number | null;
  peakAt: string | null;
  /** First hour at or past each line, as "11 am", or null when the shift never gets there. */
  initialFrom: string | null;
  highFrom: string | null;
  personalFrom: string | null;
  /** When to stop for fifteen minutes, once the high line is crossed. */
  breaks: string[];
  /** Set while somebody is still getting used to the heat and the shift reaches 80: how much of it they do today. */
  acclimatization?: HeatTime | null;
  spoken: string;
};

export function planShift(
  snap: LocationSnapshot,
  p: Profile,
  opts: { now: Date; day?: 'today' | 'tomorrow'; fromHour: number; untilHour: number; heatWork?: { kind: 'new' | 'returning'; since: string } | null; date?: string; workDay?: number },
): ShiftPlan {
  const day = opts.day ?? 'today';
  const offsetMs = snap.utcOffsetSeconds * 1000;
  const date = opts.date ?? new Date(opts.now.getTime() + offsetMs + (day === 'tomorrow' ? 86_400_000 : 0)).toISOString().slice(0, 10);
  const from = Math.max(0, Math.min(23, Math.floor(opts.fromHour)));
  const until = Math.max(from + 1, Math.min(24, Math.floor(opts.untilHour)));
  const hours = snap.hourly
    .filter((h) => h.local.startsWith(date) && hourOf(h.local) >= from && hourOf(h.local) < until)
    .map((h) => judgeHour(h, p));
  const label = spanLabel(`${date}T${String(from).padStart(2, '0')}:00`, until - from);
  const when = day === 'tomorrow' ? 'tomorrow' : 'today';
  const empty = { day, date, label, hours, peakHeatIndexF: null, peakAt: null, initialFrom: null, highFrom: null, personalFrom: null, breaks: [] };
  if (!hours.length) return { ...empty, spoken: `I don't have the forecast for ${label} ${when}, so I can't plan that shift.` };

  const peak = hours.reduce((a, b) => (b.heatIndexF > a.heatIndexF ? b : a));
  const peakF = Math.round(peak.heatIndexF);
  const firstAt = (test: (h: Judged) => boolean) => hours.find(test) ?? null;
  const initial = firstAt((h) => h.heatIndexF >= WORK_INITIAL_F);
  const high = firstAt((h) => h.heatIndexF >= WORK_HIGH_F);
  const personal = firstAt((h) => h.status === 'avoid');
  // A break at least every two hours from the hour the high line is crossed, and not in the last hour.
  const breaks: string[] = [];
  if (high) for (let h = hourOf(high.local) + 2; h < until; h += 2) breaks.push(hourLabel(`${date}T${String(h).padStart(2, '0')}:00`));

  const parts: string[] = [];
  const coldest = Math.min(...hours.map((h) => h.feelsF));
  if (coldest <= 32 && peakF < WORK_INITIAL_F) {
    parts.push(`Your shift, ${label} ${when}, is a cold one: it feels like ${Math.round(coldest)} at the coldest.`);
    parts.push('Dress in layers, keep hands and face covered, and come in to warm up if you start shivering hard.');
  } else if (!initial) {
    parts.push(`Your shift, ${label} ${when}, peaks at heat index ${peakF} at ${hourLabel(peak.local)}, which is below where workplace heat rules start.`);
  } else if (!high) {
    parts.push(`Your shift, ${label} ${when}, peaks at heat index ${peakF} at ${hourLabel(peak.local)}.`);
    parts.push(`From ${hourLabel(initial.local)} it is past 80, where the workplace heat rule OSHA proposed calls for water within reach and a shaded place to rest.`);
  } else {
    parts.push(`Your shift, ${label} ${when}, peaks at heat index ${peakF} at ${hourLabel(peak.local)}.`);
    parts.push(
      `From ${hourLabel(high.local)} it is past 90, where the workplace heat rule OSHA proposed calls for a 15 minute shade break every two hours` +
        `${breaks.length ? `, so stop at ${breaks.length === 1 ? breaks[0] : `${breaks.slice(0, -1).join(', ')} and ${breaks[breaks.length - 1]}`}` : ''}.`,
    );
  }
  // This person's own line, said only when it differs from the general one or there was no general one.
  // Earlier than the line just named: the 90 line when the shift reaches it, the 80 line when it only reaches that.
  const named = high ?? initial;
  if (personal && (!named || hourOf(personal.local) < hourOf(named.local)) && coldest > 32) {
    parts.push(
      `For you${p.sensitivity === 'general' ? '' : `, ${p.because}`}, the risky part starts earlier, at ${hourLabel(personal.local)}: take the breaks from then, and tell whoever you work with.`,
    );
  }
  // Still getting used to the heat. Only when the shift reaches 80 at all, because below that there is no
  // heat to ration. The hours allowed are counted from the first hour at or past 80.
  const used = acclimatization(opts.heatWork, date, opts.workDay);
  const hot = hours.filter((h) => h.heatIndexF >= WORK_INITIAL_F);
  let limited: ShiftPlan['acclimatization'] = null;
  if (used && hot.length) {
    const allowed = Math.max(1, Math.round((until - from) * used.fraction));
    if (allowed < hot.length) {
      // The unbroken run of hot hours whose hottest hour is the least hot, the earliest when two tie.
      const at = (h: number) => hourLabel(`${date}T${String(h).padStart(2, '0')}:00`);
      const coolest = (fromIndex: number) => {
        let best: { start: number; worst: number } | null = null;
        for (let i = fromIndex; i + allowed <= hot.length; i++) {
          const run = hot.slice(i, i + allowed);
          if (hourOf(run[run.length - 1].local) - hourOf(run[0].local) !== allowed - 1) continue;
          const worst = Math.max(...run.map((h) => h.heatIndexF));
          if (!best || worst < best.worst) best = { start: hourOf(run[0].local), worst };
        }
        return best ? { from: at(best.start), doneBy: at(best.start + allowed), start: best.start } : null;
      };
      const pick = coolest(0) ?? { from: at(hourOf(hot[0].local)), doneBy: at(hourOf(hot[0].local) + allowed), start: hourOf(hot[0].local) };
      const local = new Date(opts.now.getTime() + offsetMs);
      const nowHour = local.toISOString().slice(0, 10) === date ? local.getUTCHours() : -1;
      const passed = nowHour >= pick.start + allowed;
      const still = hot.findIndex((h) => hourOf(h.local) >= nowHour);
      const left = passed && still >= 0 ? coolest(still) : null;
      limited = {
        kind: used.kind,
        day: used.day,
        heatHoursAllowed: allowed,
        from: pick.from,
        doneBy: pick.doneBy,
        passed,
        coolestLeft: left ? { from: left.from, doneBy: left.doneBy } : null,
        restOf: hot.length === hours.length ? 'shift' : 'hot hours',
      };
      parts.push(`This is day ${used.day} of ${used.kind === 'new' ? 'getting used to the heat' : 'being back in the heat'}, so ${when}: ${heatTimeSaid(limited)}`);
    }
  }
  if (initial) parts.push('Drink a cup of water every fifteen to twenty minutes, before you feel thirsty.');
  if (high) parts.push('Work in pairs: confusion or stumbling is heat stroke, and it means call 911.');

  return {
    day,
    date,
    label,
    hours,
    peakHeatIndexF: peakF,
    peakAt: hourLabel(peak.local),
    initialFrom: initial ? hourLabel(initial.local) : null,
    highFrom: high ? hourLabel(high.local) : null,
    personalFrom: personal ? hourLabel(personal.local) : null,
    breaks,
    acclimatization: limited,
    spoken: parts.join(' '),
  };
}

/**
 * Where the work is. The forecast is for outside, so it only plans an outside shift.
 *
 * OSHA's proposed heat rule leaves out air conditioned workplaces kept below a heat index of 80, and sedentary
 * indoor work; hot indoor work (kitchens, laundries, warehouses, foundries) gets the same 80 and 90 lines, read
 * from a thermometer there, not from the forecast. Getting used to the heat applies indoors and out.
 */
export type Workplace = 'outside' | 'hot_inside' | 'cool_inside';

export const INDOOR_HEAT =
  "The forecast outside doesn't tell me how hot it is where you work. If a thermometer there reads a heat index of 80 or more, " +
  'keep water within reach and a cooler place to rest; at 90 or more, take a 15 minute break at least every two hours.';

/** A hot workplace inside: only the build-up, which does not need the forecast. */
export function indoorAllowance(heatWork: { kind: 'new' | 'returning'; since: string } | null | undefined, date: string, fromHour: number, untilHour: number, workDay?: number): { day: number; kind: 'new' | 'returning'; heatHoursAllowed: number; doneBy: string } | null {
  const used = acclimatization(heatWork, date, workDay);
  if (!used) return null;
  const allowed = Math.max(1, Math.round((untilHour - fromHour) * used.fraction));
  return { day: used.day, kind: used.kind, heatHoursAllowed: allowed, doneBy: hourLabel(`${date}T${String(Math.min(23, fromHour + allowed)).padStart(2, '0')}:00`) };
}

/**
 * The working week where they are, when they have not said theirs. Most of the world works Monday to Friday.
 * Saudi Arabia, Qatar, Kuwait, Bahrain, Oman, Jordan, Egypt, Iraq, Yemen, Algeria, Libya, Sudan, Syria and
 * Israel keep a Friday and Saturday weekend, so Sunday to Thursday; Iran works Saturday to Thursday. The
 * United Arab Emirates moved to Monday to Friday in 2022.
 */
const SUN_THU = ['SA', 'QA', 'KW', 'BH', 'OM', 'JO', 'EG', 'IQ', 'YE', 'DZ', 'LY', 'SD', 'SY', 'IL'];
export function usualWorkDays(country: string | null | undefined): { days: number[]; said: string } {
  const c = (country ?? 'US').toUpperCase();
  if (SUN_THU.includes(c)) return { days: [7, 1, 2, 3, 4], said: 'Sunday to Thursday' };
  if (c === 'IR') return { days: [6, 7, 1, 2, 3, 4], said: 'Saturday to Thursday' };
  return { days: [1, 2, 3, 4, 5], said: 'Monday to Friday' };
}

export type ShiftDay = {
  date: string;
  name: string;
  off: boolean;
  workDay: number | null;
  peakHeatIndexF: number | null;
  highFrom: string | null;
  initialFrom: string | null;
  breaks: string[];
  heatHoursAllowed: number | null;
  doneBy: string | null;
  /** Where the time in the heat starts, and whether the rest is the whole shift or only its hot hours. */
  heatFrom?: string | null;
  restOf?: HeatTime['restOf'] | null;
  line: string;
};

/**
 * The shifts of the week ahead, for somebody who works fixed hours in the heat: each day's limit while they
 * are still getting used to it, and each day's breaks.
 *
 * The build-up is counted in working days, not calendar days: NIOSH's schedule is days of work in the heat.
 * Days off in between do not undo it. A NIOSH funded study found acclimatization takes about six weeks away
 * to lose completely, and NIOSH treats somebody away for a week or more as returning; the proposed OSHA rule
 * uses fourteen days. So a weekend keeps the count where it was.
 */
export function planShiftWeek(
  snap: LocationSnapshot,
  p: Profile,
  opts: { now: Date; fromHour: number; untilHour: number; workDays?: number[]; assumedDays?: string | null; heatWork?: { kind: 'new' | 'returning'; since: string } | null; workplace: Exclude<Workplace, 'cool_inside'> },
): { days: ShiftDay[]; spoken: string } {
  const offsetMs = snap.utcOffsetSeconds * 1000;
  const local = new Date(opts.now.getTime() + offsetMs);
  const today = local.toISOString().slice(0, 10);
  const hourThere = local.getUTCHours();
  const works = opts.workDays?.length ? opts.workDays : [1, 2, 3, 4, 5];
  const isoDay = (date: string) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const name = (date: string) => (date === today ? 'Today' : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }));
  const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  // Working days from the day they started up to and including this one.
  const workDayOf = (date: string): number | null => {
    if (!opts.heatWork) return null;
    let n = 0;
    for (let d = opts.heatWork.since; d <= date; d = addDays(d, 1)) if (works.includes(isoDay(d)) || d === opts.heatWork.since) n++;
    return n;
  };
  const first = hourThere >= opts.untilHour ? 1 : 0;
  const days: ShiftDay[] = [];
  for (let i = first; i < first + 7; i++) {
    const date = addDays(today, i);
    const base = { date, name: name(date), workDay: null, peakHeatIndexF: null, highFrom: null, initialFrom: null, breaks: [], heatHoursAllowed: null, doneBy: null };
    if (!works.includes(isoDay(date))) {
      days.push({ ...base, off: true, line: '' });
      continue;
    }
    const workDay = workDayOf(date);
    if (opts.workplace === 'hot_inside') {
      const a = indoorAllowance(opts.heatWork, date, opts.fromHour, opts.untilHour, workDay ?? undefined);
      days.push({
        ...base,
        off: false,
        workDay,
        heatHoursAllowed: a?.heatHoursAllowed ?? null,
        doneBy: a?.doneBy ?? null,
        line: a ? `${base.name}, day ${a.day}: ${a.heatHoursAllowed} ${a.heatHoursAllowed === 1 ? 'hour' : 'hours'} in the heat at most, in short spells.` : `${base.name}: the full shift.`,
      });
      continue;
    }
    const s = planShift(snap, p, { now: opts.now, fromHour: opts.fromHour, untilHour: opts.untilHour, heatWork: opts.heatWork, date, workDay: workDay ?? undefined });
    if (!s.hours.length) break; // past the end of the forecast
    const a = s.acclimatization;
    const when = s.highFrom
      ? `15 minute breaks${s.breaks.length ? ` at ${s.breaks.length === 1 ? s.breaks[0] : `${s.breaks.slice(0, -1).join(', ')} and ${s.breaks[s.breaks.length - 1]}`}` : ` from ${s.highFrom}`}`
      : s.initialFrom
        ? `water and shade from ${s.initialFrom}`
        : `below the workplace heat lines`;
    const line = a
      ? a.passed
        ? `${base.name}, day ${a.day}: ${a.heatHoursAllowed} ${a.heatHoursAllowed === 1 ? 'hour' : 'hours'} in the heat at most. The coolest stretch, ${a.from} to ${a.doneBy}, has passed, so if you've had them, stay in the shade or inside${a.coolestLeft ? `; if not, ${a.coolestLeft.from} to ${a.coolestLeft.doneBy} is the coolest left` : ''}.`
        : `${base.name}, day ${a.day}: ${a.heatHoursAllowed} ${a.heatHoursAllowed === 1 ? 'hour' : 'hours'} in the heat at most, ${a.from} to ${a.doneBy}.`
      : `${base.name}${workDay != null && opts.heatWork ? (acclimatization(opts.heatWork, date, workDay) ? `, day ${workDay}` : `, day ${workDay}, the full shift`) : ''}: ${when}.`;
    days.push({ ...base, off: false, workDay, peakHeatIndexF: s.peakHeatIndexF, highFrom: s.highFrom, initialFrom: s.initialFrom, breaks: s.breaks, heatHoursAllowed: a?.heatHoursAllowed ?? null, doneBy: a?.doneBy ?? null, heatFrom: a?.from ?? null, restOf: a?.restOf ?? null, line });
  }
  const working = days.filter((d) => !d.off && d.line);
  const off = days.filter((d) => d.off).map((d) => d.name);
  const parts: string[] = [];
  const label = spanLabel(`${today}T${String(opts.fromHour).padStart(2, '0')}:00`, opts.untilHour - opts.fromHour);
  if (opts.workplace === 'hot_inside') parts.push(INDOOR_HEAT);
  const breaksOn = working.some((d) => d.highFrom);
  // Not "Your ...": the agent puts back any "Your" sentence a reply leaves out (keepReason), and this one is the whole list.
  parts.push(`This week's ${label} shifts${breaksOn && opts.workplace === 'outside' ? ', with the breaks the proposed OSHA heat rule calls for past a heat index of 90' : ''}:`);
  parts.push(...working.map((d) => d.line));
  // The limit is time in the heat, not time at work. See HeatTime.
  if (working.some((d) => d.heatHoursAllowed)) {
    const rest = working.some((d) => d.restOf === 'hot hours') ? 'the hot hours' : 'the shift';
    parts.push(
      opts.workplace === 'hot_inside'
        ? "On the days with a limit, spend the rest of the shift somewhere cooler: it's still a working day, just out of the heat."
        : `On the days with a limit, spend the rest of ${rest} in the shade or inside: it's still a working day, just out of the sun.`,
    );
  }
  if (opts.assumedDays) parts.push(`I've taken your working days as ${opts.assumedDays}; tell me if yours are different.`);
  if (off.length && opts.heatWork) parts.push(`${off.length === 1 ? off[0] : `${off.slice(0, -1).join(', ')} and ${off[off.length - 1]}`} off: a few days off does not undo getting used to it, but a week or more away does.`);
  if (working.some((d) => d.initialFrom || d.heatHoursAllowed)) parts.push('Drink a cup of water every fifteen to twenty minutes, before you feel thirsty, and work in pairs.');
  return { days, spoken: parts.join(' ') };
}

export type Precautions = { steps: string[]; spoken: string; nextStep: number | null };

/**
 * Going out anyway. The heat stroke line is always spoken, whatever else is
 * cut for length, because it is the one sentence that must never be dropped.
 */
export function precautions(now: Judged, p: Profile, step = 0, opts: { includePrivate?: boolean } = {}): Precautions {
  const steps: string[] = [];
  // In privacy mode anything that would reveal a condition or medication to the
  // room is held back and offered separately, rather than silently dropped.
  const hide = p.private && !opts.includePrivate;
  let withheld = 0;
  const personal = (line: string) => {
    if (hide) withheld++;
    else steps.push(line);
  };
  if (now.status === 'avoid') steps.push('Keep it as short as you can, and stay in shade or air conditioning on the way.');
  for (const c of p.conditions) personal(c.goingOut[0]);

  const med = p.mechanisms.filter((m) => m !== 'photosensitivity').sort((a, b) => SEVERITY[b] - SEVERITY[a])[0];
  if (med) personal(`Your medication ${MECHANISM_LABEL[med]}, so ${GUIDANCE[med]}`);

  if (!p.fluidLimit) {
    steps.push(
      p.mechanisms.includes('reduced_thirst_or_sedation')
        ? 'Take water and sip it on a schedule, not when you feel thirsty.'
        : 'Take water with you and sip it regularly.',
    );
  }
  if (p.photosensitive && now.isDay && now.uvIndex >= 3) {
    personal('Cover up, wear a wide brimmed hat and use a broad spectrum sunscreen of SPF 15 or higher, because your medication makes you burn faster.');
  }
  for (const c of p.conditions) for (const line of c.goingOut.slice(1)) personal(line);
  if (withheld) {
    steps.push(`I have ${withheld} more that mention your health, so ask me for your private precautions when you're alone.`);
  }

  const STROKE = 'If you or anyone with you becomes confused, slurs their words or faints, that can be heat stroke: call 911.';
  const from = Math.max(0, Math.floor(step));
  // Two at a time. Three precautions, an opening and the 911 line was more than anybody holds in their head.
  // On a day that is fine and under 80, one precaution is enough; the rest are there if asked for.
  const calm = now.status === 'good' && now.heatIndexF < LEARN_FROM_F;
  const read = steps.slice(from, from + (calm ? 1 : 2));
  const left = steps.length - (from + read.length);
  const intro =
    from > 0 ? '' : now.status === 'good' ? 'Conditions are fine for you right now.' : `It feels like ${Math.round(now.heatIndexF)} degrees right now.`;

  // Below a heat index of 80 the heat itself is not the danger, and a heat stroke warning on a 71 degree day
  // is the sentence that teaches somebody to stop listening. It stays in the list of steps, unspoken.
  const mild = now.heatIndexF < LEARN_FROM_F;
  const spoken = [
    intro,
    ...read,
    mild ? '' : STROKE,
    left > 0 ? `I have ${left} more, if you want them.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Asked for the rest when there is none left, on a mild day where the heat stroke line is not said: an
  // empty answer is silence on a speaker, which the live demo page caught.
  return { steps: [...steps, STROKE], spoken: spoken || 'That was all of them.', nextStep: left > 0 ? from + read.length : null };
}
