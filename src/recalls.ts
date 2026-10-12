/**
 * Open FDA recalls on the medicines a person actually takes.
 *
 * Sudor already holds the one thing a recall notice needs to be useful: the
 * list. A recall is published against a drug name and a set of lot numbers, and
 * the person who needs to hear it is the one with that bottle in the cupboard.
 * Nobody's assistant is watching that list for them.
 *
 * Two rules shape this file:
 *
 * 1. Never inside a tool call. One openFDA query measured about 450 ms, which
 *    is the whole voice turn. Recalls are fetched on a background timer and
 *    every answer is served from memory, the same as the weather.
 *
 * 2. Never tell anyone to stop taking anything. A recall usually affects
 *    specific lots, and stopping a blood pressure tablet because of a recall on
 *    a batch you do not have is its own harm. The answer says to check the lot
 *    number and ring the pharmacy.
 *
 * Source: openFDA drug enforcement reports, https://open.fda.gov/apis/drug/enforcement/
 */

const API = 'https://api.fda.gov/drug/enforcement.json';

/** Older than this and it is history, not news, even when the FDA still lists it as ongoing. */
const MAX_AGE_DAYS = 730;
/** The feed updates about weekly, so twice a day is already generous. */
const TTL_MS = 12 * 60 * 60 * 1000;

export type Recall = {
  generic: string;
  /** "Class I", "Class II" or "Class III", the FDA's own severity. */
  classification: string;
  /** ISO date the recall started. */
  started: string;
  reason: string;
  product: string;
  /** Lot numbers and expiry dates, the part that decides whether it is your bottle. */
  lots: string | null;
  firm: string;
};

type Entry = { checkedAt: number; recalls: Recall[] };
const cache = new Map<string, Entry>();

/** Oldest out first. Keyed by whatever a caller typed, so it must not grow without limit. */
const MAX_CACHED = 2000;
const remember = (k: string, e: Entry): void => {
  cache.set(k, e);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
};

/** Test seam, so tests never touch the FDA. */
type Fetcher = (generic: string) => Promise<Recall[]>;
let fetcher: Fetcher = fetchFromFda;
export function configureForTest(fn: Fetcher | null): void {
  fetcher = fn ?? fetchFromFda;
  cache.clear();
}
export function seedForTest(generic: string, recalls: Recall[]): void {
  remember(generic.toLowerCase(), { checkedAt: Date.now(), recalls });
}

const isoDate = (yyyymmdd: string): string =>
  /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}` : yyyymmdd;

const daysSince = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 86_400_000;

async function fetchFromFda(generic: string): Promise<Recall[]> {
  const url =
    `${API}?search=openfda.generic_name:%22${encodeURIComponent(generic)}%22+AND+status:%22Ongoing%22` +
    '&sort=recall_initiation_date:desc&limit=5';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    // openFDA answers 404 with "No matches found", which is an answer, not a fault.
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`openFDA ${res.status}`);
    const body = (await res.json()) as { results?: Record<string, unknown>[] };
    return (body.results ?? [])
      .map((r) => ({
        generic,
        classification: String(r.classification ?? 'unclassified'),
        started: isoDate(String(r.recall_initiation_date ?? '')),
        reason: String(r.reason_for_recall ?? '').trim(),
        product: String(r.product_description ?? '').trim(),
        lots: r.code_info ? String(r.code_info).trim() : null,
        firm: String(r.recalling_firm ?? '').trim(),
      }))
      .filter((r) => r.started && daysSince(r.started) <= MAX_AGE_DAYS);
  } finally {
    clearTimeout(timer);
  }
}

/** What is already known, without going anywhere. Null means never checked. */
export function known(generic: string): Recall[] | null {
  return cache.get(generic.toLowerCase())?.recalls ?? null;
}

export function checkedAt(generic: string): number | null {
  return cache.get(generic.toLowerCase())?.checkedAt ?? null;
}

/** Refresh one medicine in the background. Failures leave the last known answer in place. */
export async function refresh(generic: string, force = false): Promise<void> {
  const key = generic.toLowerCase();
  const held = cache.get(key);
  if (!force && held && Date.now() - held.checkedAt < TTL_MS) return;
  try {
    const recalls = await fetcher(generic);
    remember(key, { checkedAt: Date.now(), recalls });
  } catch {
    // Keep whatever was known, and when nothing was known, keep knowing nothing.
    //
    // The first version cached an empty list on failure, which turned "I could
    // not reach the FDA" into "no recalls on your medicine". A false all clear
    // about a recalled medicine is the worst answer this file could give, so a
    // failed check leaves the medicine unchecked and the tool says so.
  }
}

/** Start a refresh without waiting for it. */
export function watch(generic: string): void {
  void refresh(generic);
}

/**
 * The FDA's own definitions, said in a way a person can act on.
 * https://www.fda.gov/safety/industry-guidance-recalls/recalls-background-and-definitions
 */
export function severityOf(classification: string): { rank: number; say: string; short: string } {
  if (/class i\b/i.test(classification)) {
    return {
      rank: 3,
      say: 'The FDA calls this a class one recall, their most serious, which means it could cause real harm',
      short: 'class one, their most serious',
    };
  }
  if (/class ii\b/i.test(classification)) {
    return {
      rank: 2,
      say: 'It is class two, so any harm would usually be temporary',
      short: 'class two',
    };
  }
  if (/class iii\b/i.test(classification)) {
    return {
      rank: 1,
      say: 'It is class three, unlikely to cause harm',
      short: 'class three, the mildest',
    };
  }
  return { rank: 0, say: 'The FDA has not classified it yet', short: 'unclassified' };
}

/** Newest and most serious first, because that is the order a person needs them in. */
export function rank(recalls: Recall[]): Recall[] {
  return [...recalls].sort(
    (a, b) => severityOf(b.classification).rank - severityOf(a.classification).rank || b.started.localeCompare(a.started),
  );
}

const shorten = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max)}...`;
};

const monthName = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Trailing punctuation from the feed, which would otherwise be spoken as a stutter. */
const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '');
const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * One recall, spoken. Never an instruction to stop taking anything.
 *
 * Brief form exists because two full notices read back to back is a paragraph,
 * and nobody holds a paragraph in their head off a speaker.
 */
export function speak(recall: Recall, brief = false): string {
  const severity = severityOf(recall.classification);
  const name = capitalise(recall.generic);
  if (brief) {
    return `Another for ${recall.generic}, from ${monthName(recall.started)}, ${severity.short}.`;
  }
  const urgency = severity.rank === 3 ? 'Ring your pharmacy today.' : 'Ask your pharmacist next time you are there.';
  return (
    `${name} has an open recall, started ${monthName(recall.started)} by ${tidy(recall.firm)}, for ${shorten(tidy(recall.reason), 90).replace(/^./, (c) => c.toLowerCase())}. ` +
    `${severity.say}. ` +
    `It covers particular batches, so check the lot number on your bottle. ${urgency} Don't stop taking it on your own.`
  );
}
