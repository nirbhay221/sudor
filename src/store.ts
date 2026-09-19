/** Person state: medications, conditions, location, contacts and outings. Memory-resident, flushed to disk on write. */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Mechanism } from './meds.js';

export type RegisteredMedication = { spoken: string; generic: string; drugClass: string; mechanisms: Mechanism[] };
export type LocationStatus = 'ready' | 'locating' | 'not_found';
export type NotifyReason = 'emergency' | 'hot_day';

export type Contact = {
  name: string;
  email: string;
  relation: string | null;
  notifyOn: NotifyReason[];
  addedAt: string;
  /** Null until the person says to go ahead. Nothing is ever sent to an unconfirmed contact. */
  confirmedAt: string | null;
};

export type Outing = {
  at: string;
  felt: 'fine' | 'unwell';
  /** The heat index when it was logged, if the weather was known then. */
  heatIndexF: number | null;
  minutes: number | null;
  note: string | null;
};

export type Person = {
  medications: RegisteredMedication[];
  /**
   * Medicines we do not recognise for heat, kept by name anyway so the FDA
   * recall list can still be watched for them. Heat advice needs a known
   * mechanism; a recall only needs the name on the bottle.
   */
  recallWatch: string[];
  /** Condition ids from conditions.ts. */
  conditions: string[];
  lat: number | null;
  lon: number | null;
  locationName: string | null;
  /**
   * A spoken place is looked up in the background, because geocoding takes
   * longer than Alexa+ allows for a whole turn. This says where that lookup got to.
   */
  locationStatus: LocationStatus | null;
  contacts: Contact[];
  outings: Outing[];
  /** When on, spoken answers do not name medications or conditions unless asked. */
  privacy: boolean;
  /** Alerts already sent, as "hot_day:2026-09-15", so nobody is emailed twice for one day. */
  alertsSent: string[];
  /** When a fresh start was last asked for, so the second ask is the confirmation. */
  forgetAskedAt?: string | null;
};

const DATA_PATH = resolve(process.env.SUDOR_DATA ?? './data/people.json');
const empty = (): Person => ({
  medications: [],
  recallWatch: [],
  conditions: [],
  lat: null,
  lon: null,
  locationName: null,
  locationStatus: null,
  contacts: [],
  outings: [],
  privacy: false,
  alertsSent: [],
});

let cache: Record<string, Person> | null = null;

function load(): Record<string, Person> {
  if (cache) return cache;
  if (existsSync(DATA_PATH)) {
    try {
      cache = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as Record<string, Person>;
      return cache;
    } catch {
      cache = {};
      return cache;
    }
  }
  cache = {};
  return cache;
}

function persist(): void {
  if (!cache) return;
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  // Written beside the file and renamed over it, which is atomic on one
  // filesystem. A crash partway through a direct write leaves a truncated file,
  // and half a record is worse than none: it still parses, so nothing complains.
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, DATA_PATH);
}

/** Every registered person, so a restart can resume weather, lookups and alerts. */
export function allEntries(): [string, Person][] {
  return Object.keys(load()).map((id) => [id, get(id)]);
}


/**
 * How many records this process will hold, and which ones it gives up first.
 *
 * Any string can arrive as a demo id, so a read that creates a record is a tap
 * a stranger can leave running. Reads no longer create anything, and when the
 * cap is reached the least recently touched demo record goes. A record belonging
 * to a linked account is never evicted: that one was asked for.
 */
const MAX_RECORDS = Number(process.env.SUDOR_MAX_RECORDS ?? 5000);
const touched = new Map<string, number>();
const startedAt = Date.now();

function makeRoom(): void {
  const all = load();
  const ids = Object.keys(all);
  if (ids.length < MAX_RECORDS) return;
  const demo = ids.filter((id) => id.startsWith('demo:'));
  if (!demo.length) return;
  const oldest = demo.reduce((a, b) => ((touched.get(a) ?? 0) <= (touched.get(b) ?? 0) ? a : b));
  delete all[oldest];
  touched.delete(oldest);
}

/** What we hold for this person, or an empty profile. Reading never creates a record. */

/**
 * Demo records do not live forever.
 *
 * A profile made by a stranger on the demo page holds medicines, conditions and how somebody felt on a hot afternoon, and there is no
 * reason to keep it once they have gone. Anything with a demo id and no write
 * for seven days is deleted on the next sweep. A record belonging to a linked
 * account is left alone: that one was asked for, and the customer can clear it
 * themselves whenever they like.
 */
const DEMO_TTL_MS = Number(process.env.SUDOR_DEMO_TTL_DAYS ?? 7) * 24 * 60 * 60 * 1000;

export function expireDemoRecords(now = Date.now()): number {
  const all = load();
  let gone = 0;
  for (const id of Object.keys(all)) {
    if (!id.startsWith('demo:')) continue;
    const last = touched.get(id);
    // Nothing touched since this process started, and nothing written since:
    // treat the file's own age as the clock rather than keeping it forever.
    if (last != null && now - last <= DEMO_TTL_MS) continue;
    if (last == null && now - startedAt <= DEMO_TTL_MS) continue;
    delete all[id];
    touched.delete(id);
    gone += 1;
  }
  if (gone) persist();
  return gone;
}

export function get(id: string): Person {
  const all = load();
  const held = all[id];
  if (!held) return empty();
  // Records written before these fields existed get them filled in.
  all[id] = { ...empty(), ...held };
  touched.set(id, Date.now());
  return all[id];
}

/**
 * Everything, gone.
 *
 * The record is replaced rather than emptied one list at a time, so nothing
 * survives a fresh start because a field was added later and nobody remembered
 * to clear it here.
 */
export function forget(id: string): void {
  const all = load();
  all[id] = empty();
  persist();
}

/**
 * Lists that would otherwise grow for as long as the process lives.
 *
 * Outings are what the learned heat limit is built from, and the limit only
 * ever tightens, so old entries still matter and the cap is generous. It exists
 * so that a repeated call cannot grow one record without limit. alertsSent only
 * needs to remember far enough back not to email twice about the same day.
 */
const MAX_OUTINGS = Number(process.env.SUDOR_MAX_OUTINGS ?? 1000);
const MAX_ALERTS_REMEMBERED = 400;

function prune(p: Person): void {
  if (p.outings.length > MAX_OUTINGS) p.outings = p.outings.slice(-MAX_OUTINGS);
  if (p.alertsSent.length > MAX_ALERTS_REMEMBERED) p.alertsSent = p.alertsSent.slice(-MAX_ALERTS_REMEMBERED);
}

export function update(id: string, fn: (p: Person) => void): Person {
  const all = load();
  if (!all[id]) makeRoom();
  all[id] = { ...empty(), ...(all[id] ?? {}) };
  touched.set(id, Date.now());
  const person = all[id];
  fn(person);
  prune(person);
  persist();
  return person;
}
