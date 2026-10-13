/**
 * Cooling centres: a named, open, cool building near the person, in place of "call 211".
 *
 * The federal shelter list (shelters.ts) is built for disasters, and on an ordinary hot day it holds a handful of
 * shelters for the whole country. The places people actually go on a hot afternoon, the library, the senior
 * centre, the respite centre, are run by cities and counties, and the larger ones publish them as open map
 * layers with no key. Each list below is read whole on a timer, like the shelter list, so no person's location
 * goes anywhere: the distance arithmetic is done here.
 *
 *   Maricopa County, Arizona: the Heat Relief Network, kept by the Maricopa Association of Governments. Cooling
 *     centres, respite centres and hydration stations, with each day's opening hours and the season's dates.
 *   New York City: NYC Emergency Management's cooling centre finder, each centre marked open or closed.
 *   New York State: the Department of Health's 2026 cooling centres, county by county.
 *   Washington, DC: HSEMA's cooling centres, with who each one is open to.
 *   Harris County, Texas (Houston): the county emergency office's cooling centres, marked open or closed.
 *   Riverside County, California: the county's Cool Centers, marked open or closed.
 *   City of Los Angeles: centres the city has activated, a list that is empty until a heat event opens them.
 *
 * Places a list marks closed, inactive or out of season are dropped. A failed read is "I could not check", never
 * "there is none", as everywhere else here.
 */

import { backoff } from './backoff.js';
import { milesBetween } from './shelters.js';

export type CoolingCentre = {
  name: string;
  address: string;
  /** "cooling centre", "respite centre", "library" and so on, as the list puts it. */
  kind: string;
  lat: number;
  lon: number;
  /** Hours as the list writes them, cleaned; null when it does not say. */
  hours: string | null;
  /** Today's opening and closing, "9 am" and "9 pm", when the list gives them day by day. */
  today?: { open: string; close: string } | null;
  phone: string | null;
  /** Who it is for when the list restricts it, "Men" or "Seniors"; null when anyone can go. */
  openTo: string | null;
  accessible: boolean | null;
  pets: boolean | null;
  source: string;
  milesAway?: number;
};

type Attrs = Record<string, unknown>;
type Source = {
  name: string;
  url: string;
  /** Turns one row into a centre, or null when the row is closed, inactive or not a place to stay. */
  read: (a: Attrs, geometry: { x?: number; y?: number } | undefined, today: Today) => CoolingCentre | null;
};
/** Today's date and weekday, where the lists are (all of them keep US Eastern to Pacific time). */
type Today = { date: string; weekday: string };

const text = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
// Some lists carry their dashes double-encoded ("Mon â€“ Fri"), which a speech engine reads letter by letter.
const tidy = (v: unknown): string => text(v).replace(/â€“|â€”|–|—/g, '-').replace(/Ã³/g, 'ó');
const yes = (v: unknown): boolean => /^(y|yes|true|1)$/i.test(text(v));
const pointOf = (g: { x?: number; y?: number } | undefined, a: Attrs, latKey?: string, lonKey?: string) => {
  const lat = latKey ? Number(a[latKey]) : Number(g?.y);
  const lon = lonKey ? Number(a[lonKey]) : Number(g?.x);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 ? { lat, lon } : null;
};
/** "9:00 AM" to "9 am", "4:30 PM" to "4:30 pm". */
const clock = (v: unknown): string | null => {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(text(v));
  if (!m) return null;
  return `${Number(m[1])}${m[2] && m[2] !== '00' ? `:${m[2]}` : ''} ${m[3].toLowerCase()}m`;
};

const SOURCES: Source[] = [
  {
    name: 'Maricopa County Heat Relief Network',
    url: 'https://services1.arcgis.com/MdyCMZnX1raZ7TS3/arcgis/rest/services/HRN_Public_view/FeatureServer/0',
    read: (a, g, today) => {
      if (!yes(a.Active) || !yes(a.HeatRelief)) return null;
      // A hydration station is water, not somewhere to sit out the afternoon.
      const kind = text(a.HeatRelief_Type);
      if (!/cooling|respite/i.test(kind)) return null;
      if (text(a.Start_Date) && text(a.Start_Date) > today.date) return null;
      if (text(a.End_Date) && text(a.End_Date) < today.date) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const open = clock(a[`${today.weekday}Open`]);
      const close = clock(a[`${today.weekday}Close`]);
      // Hours kept day by day and none for today: closed today, so not somewhere to send anyone.
      const dayByDay = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].some((d) => clock(a[`${d}Open`]));
      if (dayByDay && !(open && close)) return null;
      return {
        name: text(a.Location) || text(a.Organization), address: text(a.Address), kind: kind.toLowerCase(), ...p,
        hours: tidy(a.Hours) || null, today: open && close ? { open, close } : null,
        phone: text(a.PrimaryPhone) || null, openTo: null,
        accessible: a.ADA_accessible == null ? null : yes(a.ADA_accessible), pets: a.Pets == null ? null : yes(a.Pets),
        source: 'Maricopa County Heat Relief Network',
      };
    },
  },
  {
    name: 'NYC Emergency Management cooling centers',
    url: 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/CoolingCenters_PROD_view/FeatureServer/0',
    read: (a, g, today) => {
      if (text(a.Finder_status).toUpperCase() !== 'OPEN') return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const d = today.weekday.slice(0, 3).toLowerCase();
      const open = clock(a[`cc_${d}_open1`]);
      const close = clock(a[`cc_${d}_close1`]);
      const dayByDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].some((x) => clock(a[`cc_${x}_open1`]));
      if (dayByDay && !(open && close)) return null;
      return {
        name: text(a.Facility_name), address: [text(a.Address), text(a.Borough_name)].filter(Boolean).join(', '),
        kind: text(a.Facility_type) && !/other/i.test(text(a.Facility_type)) ? text(a.Facility_type).toLowerCase() : 'cooling centre', ...p,
        hours: tidy(a[today.weekday]) || null, today: open && close ? { open, close } : null,
        phone: text(a.Phone) || null, openTo: null,
        accessible: a.Accessible == null ? null : yes(a.Accessible), pets: a.Pet_friendly == null ? null : yes(a.Pet_friendly),
        source: 'NYC Emergency Management',
      };
    },
  },
  {
    name: 'New York State Department of Health cooling centers 2026',
    url: 'https://services8.arcgis.com/k1v79LrnPTwysMSs/arcgis/rest/services/NYS_Cooling_Centers_2026_/FeatureServer/0',
    read: (a, g) => {
      if (!yes(a.Active) || (text(a.Cooling_Centers) && !yes(a.Cooling_Centers))) return null;
      const p = pointOf(g, a, 'Lat', 'Long') ?? pointOf(g, a);
      if (!p) return null;
      const heatOnly = yes(a.Only_During_Heat_Waves_);
      return {
        name: text(a.Facility), address: text(a.Street_Address), kind: 'cooling centre', ...p,
        hours: [tidy(a.Hours_of_Operation), heatOnly ? 'open during heat waves only' : ''].filter(Boolean).join(', ') || null,
        phone: text(a.Contact_Number) || null, openTo: null, accessible: null, pets: null,
        source: 'New York State Department of Health',
      };
    },
  },
  {
    name: 'DC HSEMA cooling centers',
    url: 'https://services.arcgis.com/neT9SoYxizqTHZPH/arcgis/rest/services/DC_Cooling_Centers_View/FeatureServer/1',
    read: (a, g) => {
      if (!/^open/i.test(text(a.USER_Status))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const to = text(a.USER_Open_To);
      return {
        name: text(a.USER_Name), address: `${text(a.USER_Address)}, Washington`, kind: text(a.USER_Type).toLowerCase().replace(/s$/, '') || 'cooling centre', ...p,
        hours: tidy(a.USER_Hours) || null, phone: text(a.USER_Phone) || null,
        openTo: to && !/^(all|everyone|public|general public)$/i.test(to) ? to : null, accessible: null, pets: null,
        source: 'DC Homeland Security and Emergency Management Agency',
      };
    },
  },
  {
    name: 'Harris County cooling centers',
    url: 'https://services7.arcgis.com/S4q5OFlKdQkzQMZw/arcgis/rest/services/Cooling_Centers_(public_view)/FeatureServer/7',
    read: (a, g) => {
      if (!/^open$/i.test(text(a.OpenClosed))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Location), address: text(a.Address), kind: 'cooling centre', ...p,
        hours: tidy(a.OperationalHours) || null, phone: null, openTo: null, accessible: null, pets: null,
        source: 'Harris County Office of Homeland Security and Emergency Management',
      };
    },
  },
  {
    name: 'Riverside County Cool Centers',
    url: 'https://services1.arcgis.com/pWmBUdSlVpXStHU6/arcgis/rest/services/CAP_CoolCenters_0719_PublicView/FeatureServer/0',
    read: (a, g) => {
      if (!/^open$/i.test(text(a.Status))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Name), address: [text(a.Address), text(a.City)].filter(Boolean).join(', '), kind: text(a.Type).toLowerCase() || 'cooling centre', ...p,
        hours: tidy(a.Hours_of_Operation).replace(/\s*\(.*$/, '') || null, phone: text(a.Phone_Number) || null, openTo: null, accessible: null, pets: null,
        source: 'Riverside County',
      };
    },
  },
  {
    name: 'City of Los Angeles activated cooling centers',
    url: 'https://services7.arcgis.com/DSSF7DFVxfZsz379/arcgis/rest/services/Activated_Cooling_Heating_Centers_City_of_Los_Angeles/FeatureServer/0',
    read: (a, g) => {
      const p = pointOf(g, a);
      if (!p) return null;
      const name = text(a.Name ?? a.NAME ?? a.Facility ?? a.FACILITY ?? a.Site_Name ?? a.SITE_NAME);
      if (!name) return null;
      return {
        name, address: text(a.Address ?? a.ADDRESS), kind: 'cooling centre', ...p,
        hours: tidy(a.Hours ?? a.HOURS) || null, phone: text(a.Phone ?? a.PHONE) || null, openTo: null, accessible: null, pets: null,
        source: 'City of Los Angeles Emergency Management',
      };
    },
  },
];

const EVERY_MS = 30 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** Each list's centres, held separately, so one list failing does not empty the others. */
const held = new Map<string, { centres: CoolingCentre[]; checkedAt: number }>();

function todayEastern(): Today {
  // The lists are all in US time zones; a weekday a few hours off at midnight does not move an opening hour much.
  const now = new Date(Date.now() - 6 * 3_600_000);
  return { date: now.toISOString().slice(0, 10), weekday: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) };
}

async function readSource(src: Source): Promise<CoolingCentre[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const q = new URLSearchParams({ where: '1=1', outFields: '*', outSR: '4326', returnGeometry: 'true', resultRecordCount: '2000', f: 'json' });
    const res = await fetch(`${src.url}/query?${q}`, { signal: ctrl.signal, headers: { 'User-Agent': 'sudor/0.1 (Alexa+ add-on; heat and cold safety)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { features?: { attributes?: Attrs; geometry?: { x?: number; y?: number } }[]; error?: { message?: string } };
    if (body.error || !Array.isArray(body.features)) throw new Error(body.error?.message ?? 'no features');
    const today = todayEastern();
    return body.features
      .map((f) => src.read(f.attributes ?? {}, f.geometry, today))
      .filter((c): c is CoolingCentre => !!c && !!c.name)
      // A spray pad, a pool or a beach is cooling, and it is outdoors in the sun: not what someone on a water pill
      // with a heart condition is being sent to.
      .filter((c) => !/spray|splash|pool|beach|fountain|park\b/i.test(c.name))
      // Hours that are only the word "closed", or "temporarily closed", is a centre not open at all.
      .filter((c) => !/^(temporarily\s+)?closed\b/i.test(c.hours ?? ''))
      .map((c) => {
        const only = /[-(,\s]*\b(older adults|seniors?|adults 60\+?|60\+)\s*only\b\)?/i.exec(c.name);
        return only ? { ...c, name: c.name.replace(only[0], '').trim(), openTo: c.openTo ?? 'older adults' } : c;
      });
  } catch (err) {
    console.error(`[cooling] could not read ${src.name}:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let readOne: (src: Source) => Promise<CoolingCentre[] | null> = readSource;
const gates = new Map(SOURCES.map((s) => [s.name, backoff()]));

async function poll(): Promise<void> {
  await Promise.all(
    SOURCES.map(async (src) => {
      const gate = gates.get(src.name)!;
      if (!gate.ready()) return;
      const fresh = await readOne(src);
      if (fresh) {
        gate.ok();
        held.set(src.name, { centres: fresh, checkedAt: Date.now() });
      } else {
        gate.fail();
        const was = held.get(src.name);
        if (was && Date.now() - was.checkedAt > STALE_MS) held.delete(src.name);
      }
    }),
  );
}

export async function start(): Promise<void> {
  await poll();
  const timer = setInterval(() => void poll(), EVERY_MS);
  timer.unref?.();
}

/** Where the lists reach: a person outside every one of them is told nothing about cooling centres from here. */
const COVERS: { name: string; lat: [number, number]; lon: [number, number] }[] = [
  { name: 'Maricopa County Heat Relief Network', lat: [32.4, 34.1], lon: [-113.4, -111.0] },
  { name: 'NYC Emergency Management cooling centers', lat: [40.45, 40.95], lon: [-74.3, -73.65] },
  { name: 'New York State Department of Health cooling centers 2026', lat: [40.45, 45.1], lon: [-79.8, -71.8] },
  { name: 'DC HSEMA cooling centers', lat: [38.79, 39.0], lon: [-77.12, -76.9] },
  { name: 'Harris County cooling centers', lat: [29.45, 30.2], lon: [-95.97, -94.9] },
  { name: 'Riverside County Cool Centers', lat: [33.4, 34.1], lon: [-117.7, -114.4] },
  { name: 'City of Los Angeles activated cooling centers', lat: [33.7, 34.35], lon: [-118.7, -118.1] },
];

/**
 * Open centres within reach, nearest first. Null when this place is covered by a list that could not be read
 * (say "I could not check"); undefined when no list here covers it at all (say nothing, and fall back to 211).
 */
export function near(lat: number, lon: number, withinMiles = 10): CoolingCentre[] | null | undefined {
  const covering = COVERS.filter((c) => lat >= c.lat[0] && lat <= c.lat[1] && lon >= c.lon[0] && lon <= c.lon[1]);
  if (!covering.length) return undefined;
  const lists = covering.map((c) => held.get(c.name)).filter((h) => h && Date.now() - h.checkedAt <= STALE_MS);
  if (!lists.length) return null;
  const seen = new Set<string>();
  return lists
    .flatMap((h) => h!.centres)
    .map((c) => ({ ...c, milesAway: milesBetween(lat, lon, c.lat, c.lon) }))
    .filter((c) => (c.milesAway ?? Infinity) <= withinMiles)
    .sort((a, b) => (a.milesAway ?? 0) - (b.milesAway ?? 0))
    // The city and the state list the same library; the nearer copy is kept.
    .filter((c) => {
      const key = `${c.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** One spoken sentence about the nearest, or an empty string. */
export function sentence(c: CoolingCentre): string {
  const miles = c.milesAway ?? 0;
  const away = miles < 1 ? 'less than a mile away' : `about ${Math.round(miles)} ${Math.round(miles) === 1 ? 'mile' : 'miles'} away`;
  const kind = /respite/.test(c.kind) ? 'respite centre' : 'cooling centre';
  const where = `${c.name.replace(/\s+$/, '')}${c.address ? `, at ${c.address}` : ''}, ${away}`;
  // "Open" only when the list says today's hours; otherwise its hours are read out, so a closed day is heard.
  if (c.today) return `The nearest ${kind} open today is ${where}, from ${c.today.open} to ${c.today.close}.`;
  const hours = c.hours && c.hours.length <= 60 ? ` Its hours: ${c.hours.replace(/\s*-\s*/g, ' to ').replace(/:\s*/g, ' ')}.` : '';
  return `The nearest ${kind} is ${where}.${hours}`;
}

export const counts = (): Record<string, number> => Object.fromEntries([...held].map(([k, v]) => [k, v.centres.length]));

export function seedForTest(name: string, centres: CoolingCentre[] | null, checkedAt = Date.now()): void {
  if (centres) held.set(name, { centres, checkedAt });
  else held.delete(name);
}
export function configureForTest(fake: ((src: { name: string }) => Promise<CoolingCentre[] | null>) | null): void {
  readOne = fake ?? readSource;
  held.clear();
}
export const sourceNames = (): string[] => SOURCES.map((s) => s.name);
