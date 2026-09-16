/** Person state: medications, conditions, location, contacts and outings. Memory-resident, flushed to disk on write. */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  writeFileSync(DATA_PATH, JSON.stringify(cache, null, 2));
}

/** Every registered person, so a restart can resume weather, lookups and alerts. */
export function allEntries(): [string, Person][] {
  return Object.keys(load()).map((id) => [id, get(id)]);
}

export function get(id: string): Person {
  const all = load();
  // Records written before these fields existed get them filled in.
  all[id] = { ...empty(), ...(all[id] ?? {}) };
  return all[id];
}

export function update(id: string, fn: (p: Person) => void): Person {
  const person = get(id);
  fn(person);
  persist();
  return person;
}
