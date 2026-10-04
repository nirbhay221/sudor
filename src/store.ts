/** Person state: medications, conditions, location, contacts and outings. Memory-resident, flushed to disk on write. */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Mechanism } from './meds.js';
import * as vault from './vault.js';
import { createHash, randomInt, randomBytes } from 'node:crypto';

export type RegisteredMedication = {
  spoken: string;
  generic: string;
  drugClass: string;
  mechanisms: Mechanism[];
  /** What the current FDA label for it states about heat, in the label's words. See labels.ts. */
  label?: { mechanisms: Mechanism[]; quotes: { mechanism: Mechanism; sentence: string }[]; effective: string | null; checkedAt: string };
};
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
  /** When the person who owns the address agreed to be emailed. See consent.ts. */
  acceptedAt?: string | null;
  /** A hash of the invitation they were sent. Cleared once it is used. */
  acceptHash?: string | null;
  /** What the stop link in every email carries. */
  stopId?: string | null;
  invitedAt?: string | null;
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
   * Getting used to the heat. Set when somebody says they have started outdoor work, or come back to it.
   * Most outdoor workers who die of heat are in their first two weeks. See acclimatization in personal.ts.
   */
  heatWork?: { kind: 'new' | 'returning'; since: string } | null;
  /** Crews this person shares their working day with. Only a hash of each link is kept. */
  crewLinks?: { hash: string; at: string }[];
  /** Calls for help a contact can still answer: a hash of the link they were sent, and who it went to. */
  helpAsks?: { hash: string; contact: string; at: string }[];
  /** What a contact answered, kept until it has been said aloud once. */
  helpReplies?: { from: string; answer: 'coming' | 'call'; at: string }[];
  /** Accounts invited to check on this person's day. They hear how the day is, and nothing about health. */
  sharedWith?: string[];
  /** A one-time code somebody can join with, kept as a hash, with the time it stops working. */
  invite?: { hash: string; expires: string } | null;
  /** The person this account was invited to check on, if any. Checked against that person's own list. */
  viewing?: string | null;
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
  // After a restart nothing has been touched in memory yet, so fall back to the time of the last write.
  const last = (id: string) => touched.get(id) ?? (Date.parse(String(all[id]?.touchedAt ?? '')) || 0);
  const oldest = demo.reduce((a, b) => (last(a) <= last(b) ? a : b));
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
  // Deleted, not blanked: an empty record with an id is still a record of somebody having been here.
  delete all[id];
  touched.delete(id);
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

/* ------------------------------------------------------------------ *
 * A second person.
 *
 * A family member used to be somebody who received an email and nothing more. The question they actually
 * have is "how is Mum's day looking", and they should be able to ask it. The person asks for a code and reads
 * it to them; they join with it from their own account. After that they can ask how the day is, and hear
 * whether it is a fine day, a day to take care or a day to stay in, and the best hour. They never hear a
 * medicine or a condition, and they cannot change anything.
 *
 * A code is eight digits, works once, lasts a day and is stored as a hash. The link is held on both sides and
 * checked on the person's own, so it ends the moment they remove it.
 * ------------------------------------------------------------------ */
const INVITE_MS = 24 * 60 * 60 * 1000;
const MAX_SHARED = 10;
const hashCode = (code: string) => createHash('sha256').update(`sudor-invite:${code}`).digest('hex');
export const normaliseCode = (spoken: string): string => String(spoken ?? '').replace(/\D/g, '');

export function createInvite(id: string, now = Date.now()): string {
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  update(id, (p) => void (p.invite = { hash: hashCode(code), expires: new Date(now + INVITE_MS).toISOString() }));
  return code;
}

export type Joined = { ok: true; personId: string } | { ok: false; why: 'unknown' | 'own' | 'full' };

export function joinWithCode(memberId: string, spoken: string, now = Date.now()): Joined {
  const code = normaliseCode(spoken);
  if (code.length !== 8) return { ok: false, why: 'unknown' };
  const hash = hashCode(code);
  const all = load();
  const personId = Object.keys(all).find((id) => all[id].invite?.hash === hash && Date.parse(all[id].invite!.expires) > now);
  if (!personId) return { ok: false, why: 'unknown' };
  if (personId === memberId) return { ok: false, why: 'own' };
  if ((all[personId].sharedWith ?? []).length >= MAX_SHARED) return { ok: false, why: 'full' };
  update(personId, (p) => {
    p.invite = null; // one use
    p.sharedWith = [...new Set([...(p.sharedWith ?? []), memberId])];
  });
  update(memberId, (p) => void (p.viewing = personId));
  return { ok: true, personId };
}

const MAX_CREW_LINKS = 5;
const hashLink = (token: string) => createHash('sha256').update(`sudor-crew:${token}`).digest('hex');

/**
 * Join as a crew, with the same one-time code, and get a link back.
 *
 * A family member joins from their own account. A crew is another server asking on a foreman's behalf, and
 * it has no account here. So the code is exchanged for a long random link that server keeps, which lets it
 * ask one thing: how the working day looks for this person. Only a hash is stored on this side.
 */
export function joinAsCrew(spoken: string, now = Date.now()): { ok: true; token: string } | { ok: false; why: 'unknown' | 'full' } {
  const code = normaliseCode(spoken);
  if (code.length !== 8) return { ok: false, why: 'unknown' };
  const hash = hashCode(code);
  const all = load();
  const personId = Object.keys(all).find((id) => all[id].invite?.hash === hash && Date.parse(all[id].invite!.expires) > now);
  if (!personId) return { ok: false, why: 'unknown' };
  if ((all[personId].crewLinks ?? []).length >= MAX_CREW_LINKS) return { ok: false, why: 'full' };
  const token = randomBytes(24).toString('hex');
  update(personId, (p) => {
    p.invite = null; // one use
    p.crewLinks = [...(p.crewLinks ?? []), { hash: hashLink(token), at: new Date(now).toISOString() }];
  });
  return { ok: true, token };
}

/** The person a crew link is for, or null. Stops working the moment they stop sharing. */
export function personByCrewLink(token: string): string | null {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const hash = hashLink(token);
  const all = load();
  return Object.keys(all).find((id) => (all[id].crewLinks ?? []).some((l) => l.hash === hash)) ?? null;
}

/** The person this account may check on, or null. True only while that person still lists them. */
export function viewedBy(memberId: string): string | null {
  const all = load();
  const personId = all[memberId]?.viewing;
  if (!personId || !all[personId]) return null;
  return (all[personId].sharedWith ?? []).includes(memberId) ? personId : null;
}

export function leave(memberId: string): boolean {
  const personId = load()[memberId]?.viewing;
  if (!personId) return false;
  update(memberId, (p) => void (p.viewing = null));
  if (load()[personId]) update(personId, (p) => void (p.sharedWith = (p.sharedWith ?? []).filter((m) => m !== memberId)));
  return true;
}

export function stopSharing(id: string): number {
  const n = (load()[id]?.sharedWith ?? []).length + (load()[id]?.crewLinks ?? []).length;
  if (load()[id]) update(id, (p) => { p.sharedWith = []; p.crewLinks = []; p.invite = null; });
  return n;
}
