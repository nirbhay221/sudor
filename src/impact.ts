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

/** One more of this, today. `who` is used only to tell a demo visitor from an account, and is not kept. */
export function count(event: Event, who: string, now = new Date()): void {
  const b = load();
  const side = who.startsWith('demo:') ? b.demo : b.real;
  const day = now.toISOString().slice(0, 10);
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

export function resetForTest(): void {
  book = { real: {}, demo: {} };
}
