/**
 * The nearest place that can treat somebody.
 *
 * "Call 911" is the right first sentence for heat stroke, and for most other answers here it is the only
 * place named. But somebody who has been told to get medical help now, and is not at the point of an
 * ambulance, needs to know where: which hospital has an emergency department, how far, and the number to
 * ring. A family member who has just been told their mother needs help wants the same thing.
 *
 * Two sources, because neither is enough alone.
 *
 * Amazon Location Service knows where hospitals are. Its Places search returns every hospital around a
 * point with a position, an address, a phone number and the distance, and it is called with the role this
 * server already runs under, so there is no key to keep and no second supplier. Results are asked for with
 * the storage option, because they are held for a week.
 *
 * Medicare's Hospital General Information list knows which hospitals have emergency services: every
 * Medicare hospital in the United States, with a yes or no that is reported and not guessed, an address and
 * a phone number. It carries no coordinates, so it cannot say which is nearest, only which are in the town.
 *
 * So the map is asked for the nearest, the federal list is asked for the town, a mapped hospital that the
 * federal list also names is marked as having an emergency department, and the sentence says "nearest" only
 * when a distance was actually measured. Where the map cannot be reached, which includes a laptop with no
 * AWS credentials, a hospital in the same town is still named from the federal list.
 *
 * Fetched once when a place is set and refreshed weekly, never inside a tool call: a lookup takes two or
 * three seconds, which is the whole turn. Hospitals do not move, so a week-old list is a good list.
 *
 * What it is not: a guarantee that the department is open or the right one for the problem. The spoken
 * answer says "nearest", gives the number, and never replaces 911.
 */

import { GeoPlacesClient, SearchNearbyCommand } from '@aws-sdk/client-geo-places';
import { backoff } from './backoff.js';
import { stateCode } from './geocode.js';

export type Place = {
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  lat: number;
  lon: number;
  /** Has an emergency department, as far as the map says. Null when the map does not say. */
  emergency: boolean | null;
  milesAway?: number;
};

const RETRY_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const RADIUS_M = 40_000;
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PLACES = 2000;

/** A hospital the federal list says has emergency services, in the person's own town. No position, so no distance. */
export type Listed = { name: string; address: string | null; city: string; phone: string | null };

type Entry = { places: Place[]; listed: Listed[]; checkedAt: number };
const CMS = 'https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0';
/**
 * General hospitals only.
 *
 * The first live check in Anchorage named North Star Hospital as the nearest emergency department. It is a
 * psychiatric hospital, and Medicare's list records it as having emergency services, which is true of it and
 * useless to somebody with heat stroke. So only the hospital types that take anybody through the door are
 * kept: acute care, critical access and rural emergency hospitals. Psychiatric, children's, veterans' and
 * military hospitals are left out, and a mapped hospital whose own name says it is one is never offered.
 */
const GENERAL = /^(acute care hospitals|critical access hospitals|rural emergency hospitals?)$/i;
const NOT_FOR_EVERYONE = /psychiatr|behaviou?ral|mental health|rehab|detox|recovery|hospice|long.?term|veterans?|\bva\b|children|pediatric|surgical|surgery|specialty|women'?s|eye|orthop|cancer|dialysis|animal|veterinar/i;

const title = (s: string) => s.toLowerCase().replace(/(^|[ -])([a-z])/g, (_m, a: string, b: string) => `${a}${b.toUpperCase()}`);

/** Rows from the federal list into hospitals, general ones first, and only the ones that said yes. */
export function parseListed(rows: unknown): Listed[] {
  if (!Array.isArray(rows)) return [];
  const out: (Listed & { general: boolean })[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const name = typeof r.facility_name === 'string' ? r.facility_name.trim() : '';
    const city = typeof r.citytown === 'string' ? r.citytown.trim() : '';
    if (!name || !city || r.emergency_services !== 'Yes') continue;
    if (!GENERAL.test(String(r.hospital_type ?? ''))) continue;
    out.push({
      name: title(name).slice(0, 80),
      address: typeof r.address === 'string' && r.address.trim() ? title(r.address.trim()) : null,
      city: title(city),
      phone: typeof r.telephone_number === 'string' && r.telephone_number.trim() ? r.telephone_number.trim() : null,
      general: true,
    });
  }
  return out.sort((x, y) => Number(y.general) - Number(x.general)).map(({ general: _general, ...rest }) => rest);
}

/** "Minneapolis, Minnesota" to the town and the state code the federal list is keyed by, or null. */
export function townOf(placeName: string | null | undefined): { city: string; state: string } | null {
  const parts = String(placeName ?? '').split(',').map((x) => x.trim());
  if (parts.length < 2 || !parts[0]) return null;
  const state = stateCode(parts[parts.length - 1]);
  return state ? { city: parts[0].toUpperCase(), state } : null;
}

async function fetchFromCms(city: string, state: string): Promise<Listed[]> {
  const q = new URLSearchParams();
  [['citytown', city], ['state', state], ['emergency_services', 'Yes']].forEach(([property, value], i) => {
    q.set(`conditions[${i}][property]`, property);
    q.set(`conditions[${i}][value]`, value);
  });
  q.set('limit', '50');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${CMS}?${q.toString()}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`cms ${res.status}`);
    return parseListed(((await res.json()) as { results?: unknown }).results);
  } finally {
    clearTimeout(timer);
  }
}

type Lister = (city: string, state: string) => Promise<Listed[]>;
let lister: Lister = fetchFromCms;
const names = new Map<string, string>();
const cache = new Map<string, Entry>();
const pending = new Set<string>();
const key = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

type Fetcher = (lat: number, lon: number) => Promise<Place[]>;
let fetcher: Fetcher = (lat, lon) => fetchFromAmazon(lat, lon);

/** Amazon Location results into places. A category that names an emergency room is taken as a yes; anything else is left unknown. */
export function parseAmazon(body: unknown): Place[] {
  const items = (body as { ResultItems?: unknown } | null)?.ResultItems;
  if (!Array.isArray(items)) return [];
  const out: Place[] = [];
  for (const r of items as {
    Title?: unknown;
    Position?: unknown;
    Address?: { AddressNumber?: unknown; Street?: unknown; Locality?: unknown };
    Contacts?: { Phones?: { Value?: unknown }[] };
    Categories?: { Id?: unknown; Name?: unknown }[];
  }[]) {
    const name = typeof r.Title === 'string' ? r.Title.trim() : '';
    // Longitude first, which is the opposite of how everything else here holds a position.
    const pos = Array.isArray(r.Position) ? r.Position : [];
    const lon = pos[0];
    const lat = pos[1];
    if (!name || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const street = [r.Address?.AddressNumber, r.Address?.Street].filter((x) => typeof x === 'string' && x).join(' ');
    const phone = (r.Contacts?.Phones ?? []).map((x) => x.Value).find((v) => typeof v === 'string' && v.trim());
    const emergency = (r.Categories ?? []).some((c) => /emergency/i.test(`${String(c.Id ?? '')} ${String(c.Name ?? '')}`));
    out.push({
      name: name.slice(0, 80),
      address: street || null,
      city: typeof r.Address?.Locality === 'string' && r.Address.Locality ? r.Address.Locality : null,
      phone: typeof phone === 'string' ? phone.trim() : null,
      lat,
      lon,
      emergency: emergency ? true : null,
    });
  }
  return out;
}

let places: GeoPlacesClient | null = null;

async function fetchFromAmazon(lat: number, lon: number): Promise<Place[]> {
  places ??= new GeoPlacesClient({ region: process.env.SUDOR_PLACES_REGION ?? process.env.AWS_REGION ?? 'us-east-1' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await places.send(
      new SearchNearbyCommand({
        QueryPosition: [lon, lat],
        QueryRadius: RADIUS_M,
        MaxResults: 50,
        Filter: { IncludeCategories: ['hospital'] },
        AdditionalFeatures: ['Contact'],
        // Held for a week, so asked for as stored, which is what the terms require.
        IntendedUse: 'Storage',
      }),
      { abortSignal: ctrl.signal },
    );
    return parseAmazon(res);
  } finally {
    clearTimeout(timer);
  }
}

const plain = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|hospital|medical|center|centre|health|of|and)\b/g, ' ').replace(/\s+/g, ' ').trim();
const door = (s: string | null) => (s ?? '').toLowerCase().match(/^(\d+)\s+(?:(?:north|south|east|west|n|s|e|w)\.?\s+)?([a-z0-9]+)/);

/**
 * Mark the mapped hospitals the federal list says have emergency services.
 *
 * Matched on the name with the filler words taken out, or on the street number and street. Only ever turns
 * "not said" into "yes": a hospital the map itself marks as having no emergency department stays that way,
 * and one the list does not name is left unknown, not marked no.
 */
export function confirm(places: Place[], listed: Listed[]): Place[] {
  if (!listed.length) return places.map((p) => (p.emergency !== false && NOT_FOR_EVERYONE.test(p.name) ? { ...p, emergency: false } : p));
  const known = listed.map((l) => ({ name: plain(l.name), door: door(l.address), phone: l.phone }));
  return places.map((p) => {
    if (p.emergency === false) return p;
    if (NOT_FOR_EVERYONE.test(p.name)) return { ...p, emergency: false };
    const name = plain(p.name);
    const at = door(p.address);
    const hit = known.find(
      (k) =>
        (name.length >= 4 && k.name.length >= 4 && (k.name === name || k.name.includes(name) || name.includes(k.name))) ||
        (!!at && !!k.door && at[1] === k.door[1] && at[2] === k.door[2]),
    );
    // The number the hospital reported to Medicare is its main line. The first live check got a map number
    // for Banner in Phoenix that was not the switchboard, so the reported one wins when there is one.
    return hit ? { ...p, emergency: true, phone: hit.phone ?? p.phone } : p;
  });
}

const gate = backoff();
const tries = new Map<string, number>();

export async function refresh(lat: number, lon: number, placeName?: string | null): Promise<void> {
  const k = key(lat, lon);
  if (placeName) names.set(k, placeName);
  const held = cache.get(k);
  if (held && Date.now() - held.checkedAt < REFRESH_MS) return;
  if (pending.has(k) || !gate.ready()) return;
  pending.add(k);
  try {
    const town = townOf(names.get(k));
    // Both are asked, and either one alone is an answer worth holding.
    const [mapped, listed] = await Promise.allSettled([fetcher(lat, lon), town ? lister(town.city, town.state) : Promise.resolve([] as Listed[])]);
    const places = mapped.status === 'fulfilled' ? mapped.value : null;
    const inTown = listed.status === 'fulfilled' ? listed.value : [];
    if (places || inTown.length) {
      // A week for a full answer. A partial one is asked again sooner, by the retry below.
      cache.set(k, { places: confirm(places ?? [], inTown), listed: inTown, checkedAt: places ? Date.now() : Date.now() - REFRESH_MS + RETRY_MS });
      if (cache.size > MAX_PLACES) cache.delete(cache.keys().next().value as string);
    }
    if (places) {
      tries.delete(k);
      gate.ok();
      return;
    }
    // Keep whatever was known. An answer without a hospital in it is still an answer.
    gate.fail();
    // Asked again later, a few times. Without this a place whose one lookup failed had no hospital until
    // the server restarted.
    const n = (tries.get(k) ?? 0) + 1;
    tries.set(k, n);
    if (n < MAX_TRIES) {
      const t = setTimeout(() => watch(lat, lon), RETRY_MS);
      t.unref?.();
    }
  } finally {
    pending.delete(k);
  }
}

/**
 * Start following a place. Never awaited by a tool.
 *
 * One lookup at a time, a little apart, so a burst of new places is not a burst of requests.
 */
const queue: [number, number][] = [];
let draining = false;
const MAX_QUEUE = 200;
const SPACING_MS = 2000;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const [lat, lon] = queue.shift() as [number, number];
      await refresh(lat, lon);
      await new Promise<void>((done) => {
        const t = setTimeout(done, SPACING_MS);
        t.unref?.();
      });
    }
  } finally {
    draining = false;
  }
}

export function watch(lat: number, lon: number, placeName?: string | null): void {
  const k = key(lat, lon);
  if (placeName) names.set(k, placeName);
  if (names.size > MAX_PLACES) names.delete(names.keys().next().value as string);
  const held = cache.get(k);
  if (held && Date.now() - held.checkedAt < REFRESH_MS) return;
  if (queue.length >= MAX_QUEUE || queue.some(([a, b]) => key(a, b) === k)) return;
  queue.push([lat, lon]);
  const t = setTimeout(() => void drain(), SPACING_MS);
  t.unref?.();
}

function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The nearest hospital with an emergency department, or null when none is known.
 *
 * The ones the map says have one come first. A rehabilitation hospital two miles away is not where to send
 * somebody who has been told to get help now, so a hospital the map marks as having no emergency department
 * is never returned. Where nothing nearby is marked as having one, the nearest unmarked hospital is returned
 * and `emergency` stays null, so the sentence can say "hospital" and not promise a department.
 */
export function nearestEmergency(lat: number | null, lon: number | null): Place | null {
  if (lat == null || lon == null) return null;
  const held = cache.get(key(lat, lon));
  if (!held) return null;
  const ranked = held.places
    .filter((p) => p.emergency !== false)
    .map((p) => ({ ...p, milesAway: milesBetween(lat, lon, p.lat, p.lon) }))
    .sort((x, y) => x.milesAway - y.milesAway);
  return ranked.find((p) => p.emergency === true) ?? ranked[0] ?? null;
}

/** A phone number said so it can be dialled: digit by digit, in groups. */
export function spokenPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  // Outside North America: the digits read out in threes, after the country code, rather than "+448451555000".
  if (digits.length !== 10) {
    if (!phone.trim().startsWith('+') || digits.length < 8) return phone;
    return `plus ${(digits.match(/\d{1,3}/g) ?? []).map((g) => g.split('').join(' ')).join(', ')}`;
  }
  const spaced = (s: string) => s.split('').join(' ');
  return `${spaced(digits.slice(0, 3))}, ${spaced(digits.slice(3, 6))}, ${spaced(digits.slice(6))}`;
}

/** A link that opens directions on a phone, for the email a family member reads. */
export const mapLink = (lat: number, lon: number): string => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`;

/**
 * The hospital to name, from whichever source can stand behind it.
 *
 * `measured` is true only when a distance was worked out. `certain` is true when a source said outright that
 * there is an emergency department: the map's own tag, or the federal list.
 */
export type Named = { name: string; address: string | null; city: string | null; phone: string | null; milesAway: number | null; link: string | null; measured: boolean; certain: boolean };

export function named(lat: number | null, lon: number | null): Named | null {
  if (lat == null || lon == null) return null;
  const p = nearestEmergency(lat, lon);
  const listed = cache.get(key(lat, lon))?.listed ?? [];
  if (p && (p.emergency === true || !listed.length)) {
    // The federal list has the number more often than the map does.
    const same = listed.find((l) => l.name.toLowerCase() === p.name.toLowerCase());
    return { name: p.name, address: p.address, city: p.city, phone: p.phone ?? same?.phone ?? null, milesAway: p.milesAway ?? null, link: mapLink(p.lat, p.lon), measured: true, certain: p.emergency === true };
  }
  if (listed.length) {
    const l = listed[0];
    return { name: l.name, address: l.address, city: l.city, phone: l.phone, milesAway: null, link: null, measured: false, certain: true };
  }
  return null;
}

/** One sentence naming where to go, or an empty string. "Nearest" is said only when a distance was measured. */
export function sentence(lat: number | null, lon: number | null): string {
  const p = named(lat, lon);
  if (!p) return '';
  const ring = p.phone ? ` Their number is ${spokenPhone(p.phone)}.` : '';
  if (!p.measured) {
    return `A hospital with an emergency department in ${p.city} is ${p.name}${p.address ? `, at ${p.address}` : ''}.${ring}`;
  }
  const miles = p.milesAway ?? 0;
  const away = miles < 1 ? 'less than a mile away' : `about ${Math.round(miles)} ${Math.round(miles) === 1 ? 'mile' : 'miles'} away`;
  const where = [p.address ? `at ${p.address}` : '', p.city ? `in ${p.city}` : ''].filter(Boolean).join(' ');
  const what = p.certain ? 'emergency department' : 'hospital';
  return `The nearest ${what} is ${p.name}${where ? `, ${where}` : ''}, ${away}.${ring}`;
}

export function status(): { places: number; source: string } {
  return { places: cache.size, source: 'amazon-location + cms' };
}

export function configureForTest(fn: Fetcher | null, list: Lister | null = null): void {
  fetcher = fn ?? fetchFromAmazon;
  lister = list ?? fetchFromCms;
  names.clear();
  cache.clear();
  pending.clear();
  queue.length = 0;
  tries.clear();
  gate.reset();
}

export function seedForTest(lat: number, lon: number, places: Place[], listed: Listed[] = []): void {
  cache.set(key(lat, lon), { places, listed, checkedAt: Date.now() });
}
