/** Person state: medications, conditions, location, contacts and outings. Memory-resident, flushed to disk on write. */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Mechanism } from './meds.js';
import * as vault from './vault.js';

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
  /**
   * When this record was last written, as an ISO string on the record itself.
   *
   * It lived in a Map in memory first, which meant a restart forgot every one
   * of them, and since a deploy restarts the process the seven day expiry never
   * fired on anything that had been loaded from disk. A promise about deleting
   * data is worth nothing if a redeploy quietly resets the clock.
   */
  touchedAt?: string;
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

/** Binds this file to its purpose, so a different sealed file cannot be swapped in. */
const PURPOSE = 'sudor:people:v1';

/**
 * Set a damaged file aside instead of overwriting it.
 *
 * The loader used to end `catch { cache = {} }`. A file that would not parse became
 * an empty database, and the next ordinary write replaced the unreadable file with
 * the empty one, so corruption quietly deleted every person's record and nothing
 * anywhere said so.
 *
 * A rename keeps every byte. The server carries on with nothing, because a health
 * add-on that will not start is its own kind of failure, and says loudly what
 * happened and where the evidence is.
 */
function quarantine(why: string): void {
  const aside = `${DATA_PATH}.corrupt-${Date.now()}`;
  try {
    renameSync(DATA_PATH, aside);
    console.error(`[store] ${why} The file was set aside at ${aside} and this process is starting empty.`);
  } catch (err) {
    // If it cannot even be moved, refusing to go on is safer than a write that
    // would replace it.
    throw new Error(`[store] ${why} It could not be set aside either: ${String(err)}`);
  }
}

function load(): Record<string, Person> {
  if (cache) return cache;
  if (!existsSync(DATA_PATH)) {
    cache = {};
    return cache;
  }

  const raw = readFileSync(DATA_PATH, 'utf8');
  try {
    const opened = vault.open(raw, PURPOSE);
    cache = JSON.parse(opened.plain) as Record<string, Person>;

    // A key was configured after this file was written in the clear, or the file
    // was sealed under a key that has since been rotated out. Either way the next
    // thing on disk should be sealed under the current key, and waiting for an
    // unrelated write would leave the plaintext there indefinitely.
    if (vault.encryptionOn() && (!opened.wasSealed || !vault.isCurrentKey(opened.keyId))) {
      persist();
      console.error(
        opened.wasSealed
          ? '[store] re-sealed the people file under the current key.'
          : '[store] the people file was plaintext and is now sealed.',
      );
    }
    return cache;
  } catch (err) {
    if (err instanceof vault.VaultError) {
      // A wrong or missing key is a configuration mistake and the file is fine.
      // Touching it would turn a typo in an environment variable into data loss.
      if (err.code === 'no_key' || err.code === 'unknown_key') throw err;
      quarantine(`The people file failed verification (${err.code}).`);
    } else {
      quarantine('The people file could not be parsed.');
    }
    cache = {};
    return cache;
  }
}

function persist(): void {
  if (!cache) return;
  mkdirSync(dirname(DATA_PATH), { recursive: true, mode: 0o700 });
  // Written beside the file and renamed over it, which is atomic on one
  // filesystem. A crash partway through a direct write leaves a truncated file,
  // and half a record is worse than none: it still parses, so nothing complains.
  //
  // Compact JSON when sealed: the indentation was for a human reading the file,
  // and a human is exactly who should no longer be able to.
  const text = vault.encryptionOn() ? JSON.stringify(cache) : JSON.stringify(cache, null, 2);
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, vault.sealIfConfigured(text, PURPOSE), { mode: 0o600 });
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

/**
 * The sandbox has its own, much smaller, ceiling.
 *
 * Every record with a place in it is polled: weather on a twenty minute timer and
 * the National Weather Service for warnings every ten minutes. So the number of demo
 * records is, through a side door, the number of requests this server makes to a
 * free public API on behalf of strangers. At 5,000 that is about eight a second,
 * sustained, from a single address, which is how a server gets blocked, and the
 * block takes every real customer's alerts down with it.
 *
 * Three hundred is far more than anyone clicking through a demo reaches, and when it
 * is full the least recently touched sandbox goes, so a newcomer is never refused.
 */
const MAX_DEMO_RECORDS = Number(process.env.SUDOR_MAX_DEMO_RECORDS ?? 300);
const touched = new Map<string, number>();

const isDemo = (id: string) => id.startsWith('demo:');

function evictOldestDemo(all: Record<string, Person>): boolean {
  const demo = Object.keys(all).filter(isDemo);
  if (!demo.length) return false;
  const oldest = demo.reduce((a, b) => ((touched.get(a) ?? 0) <= (touched.get(b) ?? 0) ? a : b));
  delete all[oldest];
  touched.delete(oldest);
  return true;
}

function makeRoom(forId: string): void {
  const all = load();
  if (isDemo(forId)) {
    while (Object.keys(all).filter(isDemo).length >= MAX_DEMO_RECORDS) if (!evictOldestDemo(all)) break;
    return;
  }
  // A linked account is never refused and never evicted. If the total is full the
  // sandbox pays for it.
  if (Object.keys(all).length >= MAX_RECORDS) evictOldestDemo(all);
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

/**
 * Drop the in-memory cache and read the file again, the way a restart does.
 * Exported for tests: the expiry clock has to live in the file, and the only
 * honest way to check that is to throw away everything memory is holding.
 */
export function reloadForTest(): void {
  cache = null;
  touched.clear();
}

export function expireDemoRecords(now = Date.now()): number {
  const all = load();
  let gone = 0;
  for (const id of Object.keys(all)) {
    if (!id.startsWith('demo:')) continue;
    // The record's own timestamp first, because that one survives a restart.
    // The in-memory map is only a faster answer for records touched since boot.
    const written = all[id]?.touchedAt ? Date.parse(String(all[id].touchedAt)) : null;
    const last = touched.get(id) ?? (Number.isFinite(written) ? (written as number) : null);
    if (last != null && now - last <= DEMO_TTL_MS) continue;
    // Written before this field existed: give it one TTL from first sight, then
    // it goes. Stamping it here means the clock starts rather than never runs.
    if (last == null) {
      all[id].touchedAt = new Date(now).toISOString();
      continue;
    }
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

/**
 * What one person can hold.
 *
 * persist() rewrites the whole file, synchronously, on every update. So a single
 * record with a hundred thousand medicines in it does not just sit there: it makes
 * every write for every other user slow, and on a single threaded server slow means
 * stopped. Nothing bounded these, and an anonymous caller could add to all of them.
 *
 * The limits are generous against any real person, who takes at most a couple of
 * dozen medicines and has a handful of people to tell. The tools refuse politely
 * before these are reached, and this is the backstop that guarantees a bound.
 */
export const LIMITS = { medications: 40, recallWatch: 40, contacts: 10, conditions: 20 } as const;

function prune(p: Person): void {
  if (p.medications.length > LIMITS.medications) p.medications = p.medications.slice(-LIMITS.medications);
  if (p.recallWatch.length > LIMITS.recallWatch) p.recallWatch = p.recallWatch.slice(-LIMITS.recallWatch);
  if (p.contacts.length > LIMITS.contacts) p.contacts = p.contacts.slice(-LIMITS.contacts);
  if (p.conditions.length > LIMITS.conditions) p.conditions = p.conditions.slice(-LIMITS.conditions);
  if (p.outings.length > MAX_OUTINGS) p.outings = p.outings.slice(-MAX_OUTINGS);
  if (p.alertsSent.length > MAX_ALERTS_REMEMBERED) p.alertsSent = p.alertsSent.slice(-MAX_ALERTS_REMEMBERED);
}

export function update(id: string, fn: (p: Person) => void): Person {
  const all = load();
  if (!all[id]) makeRoom(id);
  all[id] = { ...empty(), ...(all[id] ?? {}) };
  touched.set(id, Date.now());
  const person = all[id];
  person.touchedAt = new Date().toISOString();
  fn(person);
  prune(person);
  persist();
  return person;
}
