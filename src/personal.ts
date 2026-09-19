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
  /**
   * The lowest heat index at which this person has said they felt unwell. It
   * only ever tightens the limit; feeling fine on a hot day never loosens it,
   * because one good afternoon is not evidence that the next one is safe.
   */
  learnedLimitF: number | null;
};

const SEVERITY: Record<Mechanism, number> = {
  reduced_sweating: 5,
  increased_heat_production: 4,
  reduced_thirst_or_sedation: 3,
  hyponatremia_risk: 4,
  electrolyte_imbalance: 3,
  increased_sweating: 2,
  photosensitivity: 0,
};

export function profileOf(
  mechanisms: Mechanism[],
  conditionIds: string[],
  extras: { outings?: { felt: 'fine' | 'unwell'; heatIndexF: number | null }[]; private?: boolean } = {},
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
  } else if (conditions.length) {
    sensitivity = 'sensitive';
    because = `with ${conditions[0].label}`;
  } else if (heat.length) {
    sensitivity = 'sensitive';
    because = `because your medication ${MECHANISM_LABEL[heat[0]]}`;
  }

  const isPrivate = extras.private === true;
  if (isPrivate && because) because = 'because of your health profile';
  const unwell = (extras.outings ?? [])
    .filter((o) => o.felt === 'unwell' && typeof o.heatIndexF === 'number')
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
    learnedLimitF: unwell.length ? Math.min(...unwell) : null,
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

  if (p.photosensitive && h.isDay && h.uvIndex >= 3) {
    status = worse(status, 'caution');
    reasons.push(`UV ${Math.round(h.uvIndex)}`);
  }
  if (p.airQuality && h.aqi != null && h.aqi > 100) {
    status = worse(status, h.aqi > 150 ? 'avoid' : 'caution');
    reasons.push(`air quality ${h.aqi}`);
  }
  return { local: h.local, time: h.time, heatIndexF: hi, category, status, reasons, isDay: h.isDay, uvIndex: h.uvIndex, aqi: h.aqi };
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

export type Span = { startLocal: string; hours: number; label: string; peakHeatIndexF: number; reasons: string[] };

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
  reasons: [...new Set(run.flatMap((h) => h.reasons.map((r) => r.replace(/\d+$/, '').trim())))],
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
const hottest = (run: Judged[]) => Math.max(...run.map((h) => h.heatIndexF));

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
    if (a < b || (a === b && hottest(w) < hottest(pick))) pick = w;
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
  const what = opts.activity ? `for ${opts.activity}` : 'to be outside';
  const because = p.sensitivity === 'general' ? '' : `, ${p.because}`;
  const cap = (x: string) => `${x.charAt(0).toUpperCase()}${x.slice(1)}`;
  const parts: string[] = [];

  if (!hours.length) {
    parts.push(day === 'today' ? "Today's daytime hours are over. Ask me about tomorrow." : "I don't have tomorrow's forecast yet.");
  } else if (!best) {
    parts.push(`There isn't a long enough stretch left ${when} ${what}.`);
  } else if (best.status === 'good') {
    parts.push(`The best time ${what} ${when}${because ? `${because},` : ''} is ${best.label}, heat index about ${best.peakHeatIndexF}.`);
    if (alsoGood) parts.push(`${cap(alsoGood.label)} works too.`);
  } else if (best.status === 'caution') {
    parts.push(`The best time ${what} ${when} is ${best.label}, heat index about ${best.peakHeatIndexF}. Take care even then${because}.`);
  } else {
    parts.push(
      `It stays hot for you all ${when === 'today' ? 'day' : 'of tomorrow'}${because}. If you need to go, ${best.label} is the least risky, ` +
        `heat index about ${best.peakHeatIndexF}, and ask me what precautions to take.`,
    );
  }
  if (p.learnedLimitF != null && hours.some((h) => h.heatIndexF >= (p.learnedLimitF as number))) {
    parts.push(`You felt unwell near heat index ${p.learnedLimitF} before, so I'm treating that as your limit.`);
  }
  if (worst) {
    const why = worst.reasons.filter((r) => r !== 'heat index' && r !== 'felt unwell at this heat before');
    parts.push(
      `Avoid ${worst.label} if you can, when the heat index reaches ${worst.peakHeatIndexF}` +
        `${why.length ? ` and ${why.join(' and ')} is a problem` : ''}.`,
    );
  }

  return { day, date, hours, best, alsoGood, worst, spoken: parts.join(' ') };
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
  const read = steps.slice(from, from + 3);
  const left = steps.length - (from + read.length);
  const intro =
    from > 0 ? '' : now.status === 'good' ? 'Conditions are fine for you right now.' : `It is heat index ${Math.round(now.heatIndexF)} right now.`;

  const spoken = [
    intro,
    ...read,
    left > 0 ? `I have ${left} more, ask me for the rest.` : '',
    STROKE,
  ]
    .filter(Boolean)
    .join(' ');

  return { steps: [...steps, STROKE], spoken, nextStep: left > 0 ? from + read.length : null };
}
