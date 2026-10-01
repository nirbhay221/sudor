/**
 * Somewhere to go when the house is not survivable.
 *
 * A power cut in winter is not an inconvenience for everyone. The CDC puts the
 * indoor floor at 68F and says a home sitting at 60 to 65F can bring on
 * hypothermia in an older adult, which is a temperature most people would call
 * chilly rather than dangerous. Their first line of advice is to go and stay
 * with a relative or a friend. When there is nobody, the question becomes where
 * else, and that is a question this add-on could not answer at all.
 *
 * FEMA and the Red Cross run the National Shelter System together, and its open
 * shelters are published as a plain query service with no key:
 * https://gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/MapServer  Layer 0 is
 * the shelters open right now, which on an ordinary day is a handful for the
 * whole country and during a disaster is hundreds. It carries the three things
 * that decide whether a building is any use to a particular person: whether
 * there is a generator, whether it is step-free, and whether a pet can come.
 * Someone who will not leave a dog behind is someone who stays in a cold house.
 *
 * The whole national list is small enough to hold in memory, so it is polled on
 * a timer like everything else here and the distance arithmetic happens locally.
 * No per-person query goes anywhere.
 *
 * What this is not: a warming centre directory. A city hall that opens its
 * library for a cold snap is usually not in the National Shelter System, which
 * is built for disaster sheltering. That gap is why every answer also carries
 * 211, the nationwide referral line that does know about the library.
 */

import { backoff } from './backoff.js';

export type Shelter = {
  name: string;
  address: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  generator: boolean;
  accessible: boolean;
  pets: string | null;
  /** Miles from the person, filled in when the list is searched. */
  milesAway?: number;
};

const OPEN_SHELTERS =
  'https://gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/MapServer/0/query' +
  '?where=1%3D1&outFields=shelter_name,address_1,city,state,zip,generator_onsite,' +
  'ada_compliant,wheelchair_accessible,pet_accommodations_desc,latitude,longitude' +
  '&returnGeometry=false&f=json';

const EVERY_MS = 15 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;
const TIMEOUT_MS = 6000;

let held: { shelters: Shelter[]; checkedAt: number } | null = null;
let fetchOpen: () => Promise<Shelter[] | null> = fetchFromFema;

/** A yes in this feed is written several ways, and a blank is not a no. */
const yes = (value: unknown): boolean => /^(y|yes|true|1)$/i.test(String(value ?? '').trim());

async function fetchFromFema(): Promise<Shelter[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OPEN_SHELTERS, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'sudor/0.1 (Alexa+ add-on; heat and cold safety)' },
    });
    if (!res.ok) {
      console.error(`[shelters] the shelter list answered ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { features?: { attributes?: Record<string, unknown> }[] };
    if (!Array.isArray(body.features)) return null;
    return body.features
      .map((f) => f.attributes ?? {})
      .map((a) => ({
        name: String(a.shelter_name ?? '').trim(),
        address: String(a.address_1 ?? '').trim(),
        city: String(a.city ?? '').trim(),
        state: String(a.state ?? '').trim(),
        lat: Number(a.latitude),
        lon: Number(a.longitude),
        generator: yes(a.generator_onsite),
        accessible: yes(a.ada_compliant) || yes(a.wheelchair_accessible),
        pets: String(a.pet_accommodations_desc ?? '').trim() || null,
      }))
      .filter((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  } catch (err) {
    // Silence here cost an evening: the first poll on a fresh box failed, the
    // feature stayed dark for fifteen minutes, and nothing anywhere said so.
    console.error('[shelters] could not read the open shelter list:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** After a run of failures, stop asking a list that is not answering. See backoff.ts. */
const gate = backoff();

async function poll(): Promise<void> {
  if (!gate.ready()) return;
  const fresh = await fetchOpen();
  if (fresh) gate.ok();
  else gate.fail();
  // A failed check never becomes "no shelters are open". That sentence would
  // send someone back to a cold house on the strength of a timeout.
  if (fresh) held = { shelters: fresh, checkedAt: Date.now() };
  else if (held && Date.now() - held.checkedAt > STALE_MS) held = null;
}

export async function start(): Promise<void> {
  await poll();
  /*
   * A boot that misses costs fifteen minutes of "I could not find out" to
   * anyone who asks in the meantime, so a first failure is retried in a minute
   * rather than waiting for the ordinary cycle. Once something has landed, the
   * ordinary cycle is enough.
   */
  if (!held) {
    const retry = setTimeout(() => void poll(), 60 * 1000);
    retry.unref?.();
  }
  const timer = setInterval(() => void poll(), EVERY_MS);
  timer.unref?.();
}

/** Great-circle distance in miles. */
export function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Open shelters within reach, nearest first, or null when we have not managed
 * to check. Null and an empty list mean different things and are said
 * differently: one is "I could not find out", the other is "there are none".
 */
export function near(lat: number, lon: number, withinMiles = 60): Shelter[] | null {
  if (!held) return null;
  if (Date.now() - held.checkedAt > STALE_MS) return null;
  return held.shelters
    .map((s) => ({ ...s, milesAway: milesBetween(lat, lon, s.lat, s.lon) }))
    .filter((s) => (s.milesAway ?? Infinity) <= withinMiles)
    .sort((a, b) => (a.milesAway ?? 0) - (b.milesAway ?? 0));
}

/** How many are open nationally, for /health. Null when unchecked. */
export const openNationally = (): number | null => (held ? held.shelters.length : null);

export function configureForTest(fake: (() => Promise<Shelter[] | null>) | null): void {
  fetchOpen = fake ?? fetchFromFema;
  held = null;
}

export function seedForTest(shelters: Shelter[] | null, checkedAt = Date.now()): void {
  held = shelters ? { shelters, checkedAt } : null;
}
