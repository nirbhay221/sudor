/**
 * Whether anybody acts on what they are told, counted without counting anybody.
 *
 * Reviews of heat warning systems keep finding the same gap: most say whether a warning went out, few say
 * whether anyone did anything, and almost none follow it as far as health. Quebec's public health institute
 * sets out the chain to measure (knowledge, intention, behaviour, then health), and the Australian trial of a
 * home warning system for older adults found preparedness rising without the use of cooling rising with it.
 *
 * So Sudor counts, per day, the links in that chain it can actually see, and nothing else:
 *
 *   warned          an answer said today is a stay-inside day, or the home is too hot to stay in
 *   sentAway        an answer told somebody to leave a home that is too hot
 *   followedUp      the question afterwards was asked ("are you still there?")
 *   wentLooking     somebody looked for somewhere to go after being sent away (behaviour)
 *   familyTold      a family member was emailed that the home is too hot
 *   carerSteps      a family member checking in was given things to do today
 *   outingFine      somebody said an outing went fine
 *   outingUnwell    somebody said they felt unwell after one (health)
 *
 * Counts only: no person, no place, no time finer than the day, and a day's counts never leave the server except
 * as totals at /impact. Demo visitors are counted apart, so a judge pressing buttons is not mistaken for use.
 *
 * Sources:
 *   https://www.inspq.qc.ca/en/publications/1794
 *   https://www.preventionweb.net/quick/99463
 *   https://pmc.ncbi.nlm.nih.gov/articles/PMC11840092/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { table, tableOn } from './table.js';

export const EVENTS = ['warned', 'sentAway', 'followedUp', 'wentLooking', 'familyTold', 'carerSteps', 'outingFine', 'outingUnwell'] as const;
export type Event = (typeof EVENTS)[number];
type Day = Partial<Record<Event, number>>;
type Book = { real: Record<string, Day>; demo: Record<string, Day> };

const PATH = () => resolve(process.env.SUDOR_IMPACT ?? `${dirname(resolve(process.env.SUDOR_DATA ?? './data/people.json'))}/impact.json`);
const KEEP_DAYS = 400;
let book: Book | null = null;

function load(): Book {
  if (book) return book;
  try {
    book = existsSync(PATH()) ? (JSON.parse(readFileSync(PATH(), 'utf8')) as Book) : { real: {}, demo: {} };
  } catch {
    book = { real: {}, demo: {} };
  }
  book.real ??= {};
  book.demo ??= {};
  return book;
}

let pending: NodeJS.Timeout | null = null;
function save(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    try {
      mkdirSync(dirname(PATH()), { recursive: true });
      writeFileSync(PATH(), JSON.stringify(load()));
    } catch (err) {
      console.error('[impact] could not save:', err instanceof Error ? err.message : err);
    }
  }, 2000);
  pending.unref?.();
}

/*
 * The scheduled alert check runs in Lambda, whose files are gone when it stops, so a family told from there
 * would never reach /impact. There the counts go onto the people table instead, one item per side and day
 * (`impact:real:2026-10-17`) with a number per measure, and the server adds them to its own when asked.
 * Those items have no record in them, so the store never mistakes one for a person.
 */
let onTable = false;
const inFlight: Promise<void>[] = [];
const itemFor = (side: 'real' | 'demo', day: string) => `impact:${side}:${day}`;

/** For the Lambda: count onto the table rather than into a file that will not outlive the run. */
export function countOnTable(on: boolean): void {
  onTable = on;
}

/** Wait for counts on their way to the table. A count that fails is logged, never a failed check. */
export async function flush(): Promise<void> {
  await Promise.allSettled(inFlight.splice(0));
}

/** One more of this, today. `who` is used only to tell a demo visitor from an account, and is not kept. */
export function count(event: Event, who: string, now = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  if (onTable) {
    const ttl = Math.floor(now.getTime() / 1000) + KEEP_DAYS * 86_400;
    inFlight.push(table().add(itemFor(who.startsWith('demo:') ? 'demo' : 'real', day), event, ttl).catch((err) => console.error('[impact] could not count on the table:', err instanceof Error ? err.message : err)));
    return;
  }
  const b = load();
  const side = who.startsWith('demo:') ? b.demo : b.real;
  side[day] = { ...side[day], [event]: (side[day]?.[event] ?? 0) + 1 };
  const days = Object.keys(side).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete side[old];
  save();
}

/** Totals over the last `days` days, and the share of people sent away who then looked for somewhere to go. */
export function summary(days = 30, now = new Date()): Record<'real' | 'demo', Record<Event, number> & { lookedAfterSentAway: number | null }> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const total = (side: Record<string, Day>) => {
    const t = Object.fromEntries(EVENTS.map((e) => [e, 0])) as Record<Event, number>;
    for (const [day, counts] of Object.entries(side)) if (day >= since) for (const e of EVENTS) t[e] += counts[e] ?? 0;
    return { ...t, lookedAfterSentAway: t.sentAway ? Math.round((t.wentLooking / t.sentAway) * 100) / 100 : null };
  };
  const b = load();
  return { real: total(b.real), demo: total(b.demo) };
}

/**
 * What the table said, kept for a few minutes.
 *
 * /impact is public and answers without a token, and a year of days is eight hundred items read per request.
 * Read on every request, a script asking in a loop is a DynamoDB bill; kept for five minutes, it is one read
 * per distinct question in that time, and the counts only move when an alert goes out.
 */
const READ_CACHE_MS = 5 * 60_000;
const readCache = new Map<string, { at: number; held: Record<string, Record<string, number>> }>();

/** summary(), with what the scheduled check counted on the table added in. The file's alone when the table is off or cannot be read. */
export async function summaryWithTable(days = 30, now = new Date()): Promise<ReturnType<typeof summary>> {
  const local = summary(days, now);
  if (!tableOn()) return local;
  const dates = Array.from({ length: days + 1 }, (_, i) => new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  let held: Record<string, Record<string, number>>;
  const k = `${days}|${dates[0]}`;
  const cached = readCache.get(k);
  try {
    if (cached && Date.now() - cached.at < READ_CACHE_MS) held = cached.held;
    else {
      held = await table().counters(dates.flatMap((d) => [itemFor('real', d), itemFor('demo', d)]));
      readCache.set(k, { at: Date.now(), held });
      if (readCache.size > 50) readCache.delete(readCache.keys().next().value as string);
    }
  } catch (err) {
    console.error('[impact] could not read the counts on the table:', err instanceof Error ? err.message : err);
    return local;
  }
  for (const side of ['real', 'demo'] as const) {
    const t = local[side];
    for (const d of dates) for (const e of EVENTS) t[e] += held[itemFor(side, d)]?.[e] ?? 0;
    t.lookedAfterSentAway = t.sentAway ? Math.round((t.wentLooking / t.sentAway) * 100) / 100 : null;
  }
  return local;
}

export function resetForTest(): void {
  book = { real: {}, demo: {} };
  readCache.clear();
}
