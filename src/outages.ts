/**
 * Is the power out where this person lives, right now?
 *
 * Three outage lists are published openly, with no key, each as the areas that are dark right now:
 *
 *   California: the Office of Emergency Services' Statewide Power Outages layer, every active outage area in the
 *     state, planned or not, with the utility, the cause and when power is expected back. Its areas come from
 *     PG&E, which serves most of northern and central California and runs the largest Public Safety Power
 *     Shutoffs, when it cuts lines on purpose ahead of fire weather.
 *   Duke Energy: the utility's own public outage areas, across the Carolinas, Florida, Indiana, Ohio and
 *     Kentucky, with how many customers are out and when the crew expects power back.
 *   British Columbia: BC Hydro's public outage areas, planned and unplanned, with the cause and when power is
 *     expected back.
 *
 * For somebody on oxygen or with insulin in the fridge, "the power is out at your address, expected back at 6
 * tomorrow evening" decides whether to stay or go. Each list is read whole on a timer and matched here, so
 * nobody's address is sent anywhere. A failed read is "I could not check", never "the power is on", and a list
 * that shows nothing at an address is only ever said to show nothing there: another utility may serve it.
 *
 * Where no list says which streets are dark, four more say how many customers are out in each county: Maryland's
 * emergency management agency, Pennsylvania's (PEMA), Ohio's (from the Department of Energy's EAGLE-I), and
 * Alliant Energy's for its customers in Iowa and Wisconsin. A county count is said as exactly that, "about 1,200 of
 * 10,800 customers in your county are without power", never as the power being out at the address, and only when it
 * is an outage worth knowing about: one customer in a hundred, or a thousand or more. A count older than six hours is
 * not said.
 *
 * Sources:
 *   https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Power_Outages_(View)/FeatureServer
 *   https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services/PowerOutage_CountiesGeneralDEV_Join/FeatureServer
 *   https://gis.penndot.gov/arcgis/rest/services/poweroutages/papoweroutages/FeatureServer
 *   https://services6.arcgis.com/zxOMWqh0yAD6mMsJ/arcgis/rest/services/Join_Eagle_I_outages_to_county/FeatureServer
 *   https://services3.arcgis.com/sqVn1QnQEPnGQy9r/arcgis/rest/services/AEOutagesByCounty/FeatureServer
 *   https://services3.arcgis.com/oX5r75R7mapdoI2F/arcgis/rest/services/Duke_Energy_Distribution_Outages_Public/FeatureServer
 *   https://services9.arcgis.com/Mste3G8wHy9zBnhq/arcgis/rest/services/BC_Hydro_Power_Outages/FeatureServer
 */

import { backoff } from './backoff.js';

export type Outage = {
  utility: string;
  planned: boolean;
  cause: string | null;
  startedAt: string | null;
  backBy: string | null;
  customers: number | null;
  /** Who publishes the list, as it is said: "California's emergency office", "Duke Energy". */
  says?: string;
};
type Area = Outage & { rings: number[][][]; box: [number, number, number, number] };
type Attrs = Record<string, unknown>;
type Box = { lat: [number, number]; lon: [number, number] };

type Feed = {
  name: string;
  says: string;
  /** Where the list reaches. Outside every box it says nothing either way. */
  covers: Box[];
  url: string;
  read: (a: Attrs) => Outage | null;
};

const EVERY_MS = 10 * 60 * 1000;
const STALE_MS = 45 * 60 * 1000;

const UTILITY: Record<string, string> = { PGE: 'PG&E', SCE: 'Southern California Edison', SDGE: 'SDG&E', SMUD: 'SMUD', LADWP: 'LADWP' };
const when = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v).toISOString() : null);
const num = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** "2026-10-13 19:25:48", which Duke writes in Eastern time with no zone, as an instant. */
export function easternToIso(v: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  // The Eastern offset on that day, from the time zone database rather than a guess about daylight saving.
  const shown = new Date(asUtc).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const s = /(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})/.exec(shown);
  if (!s) return null;
  const offset = Date.UTC(+s[3], +s[1] - 1, +s[2], +s[4] % 24, +s[5], +s[6]) - asUtc;
  return new Date(asUtc - offset).toISOString();
}

const FEEDS: Feed[] = [
  {
    name: 'California',
    says: "California's emergency office",
    covers: [{ lat: [32.4, 42.1], lon: [-124.6, -114.0] }],
    url:
      'https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Power_Outages_(View)/FeatureServer/1/query' +
      "?where=OutageStatus%3D%27Active%27&outFields=UtilityCompany,StartDate,EstimatedRestoreDate,Cause,OutageType,ImpactedCustomers" +
      '&outSR=4326&geometryPrecision=5&f=json',
    read: (a) => {
      const code = String(a.UtilityCompany ?? '').trim();
      return {
        utility: UTILITY[code] ?? code,
        planned: /^planned$/i.test(String(a.OutageType ?? '')),
        cause: String(a.Cause ?? '').trim() || null,
        startedAt: when(a.StartDate),
        backBy: when(a.EstimatedRestoreDate),
        customers: typeof a.ImpactedCustomers === 'number' ? a.ImpactedCustomers : null,
      };
    },
  },
  {
    name: 'Duke Energy',
    says: 'Duke Energy',
    covers: [
      { lat: [33.6, 36.7], lon: [-84.4, -75.4] }, // the Carolinas
      { lat: [27.0, 30.8], lon: [-85.1, -80.5] }, // Florida
      { lat: [37.7, 41.8], lon: [-88.1, -84.7] }, // Indiana
      { lat: [38.4, 39.6], lon: [-85.1, -83.6] }, // Cincinnati and northern Kentucky
    ],
    url:
      'https://services3.arcgis.com/oX5r75R7mapdoI2F/arcgis/rest/services/Duke_Energy_Distribution_Outages_Public/FeatureServer/2/query' +
      '?where=1%3D1&outFields=START_TIME,ETR,CAUSE,AFFECTED_CUSTOMERS&outSR=4326&geometryPrecision=5&f=json',
    read: (a) => {
      const cause = String(a.CAUSE ?? '').replace(/^\d+\s+/, '').trim();
      return {
        utility: 'Duke Energy',
        planned: /planned|scheduled/i.test(cause),
        cause: cause || null,
        startedAt: easternToIso(a.START_TIME),
        backBy: easternToIso(a.ETR),
        customers: num(a.AFFECTED_CUSTOMERS),
      };
    },
  },
  {
    name: 'BC Hydro',
    says: 'BC Hydro',
    covers: [{ lat: [48.2, 60.0], lon: [-139.1, -114.0] }],
    url:
      'https://services9.arcgis.com/Mste3G8wHy9zBnhq/arcgis/rest/services/BC_Hydro_Power_Outages/FeatureServer/1/query' +
      '?where=1%3D1&outFields=DATE_OFF,ETR,CAUSE,NUMBER_OF_CUSTOMERS_AFFECTED&outSR=4326&geometryPrecision=5&f=json',
    read: (a) => {
      const cause = String(a.CAUSE ?? '').trim();
      return {
        utility: 'BC Hydro',
        planned: /planned/i.test(cause),
        cause: cause || null,
        startedAt: when(a.DATE_OFF),
        backBy: when(a.ETR),
        customers: num(a.NUMBER_OF_CUSTOMERS_AFFECTED),
      };
    },
  },
];

const held = new Map<string, { areas: Area[]; checkedAt: number }>();
const gates = new Map(FEEDS.map((f) => [f.name, backoff()]));

async function readFeed(feed: Feed): Promise<Area[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(feed.url, { signal: ctrl.signal, headers: { 'User-Agent': 'sudor/0.1 (Alexa+ add-on; heat and cold safety)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { features?: { attributes?: Attrs; geometry?: { rings?: number[][][] } }[]; error?: { message?: string } };
    if (body.error || !Array.isArray(body.features)) throw new Error(body.error?.message ?? 'no features');
    return body.features
      .filter((f) => f.geometry?.rings?.length)
      .map((f) => {
        const outage = feed.read(f.attributes ?? {});
        return outage ? withBox({ ...outage, says: feed.says, rings: f.geometry!.rings! }) : null;
      })
      .filter((a): a is Area => !!a);
  } catch (err) {
    console.error(`[outages] could not read the ${feed.name} outage list:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function withBox(a: Outage & { rings: number[][][] }): Area {
  const xs = a.rings.flat().map((p) => p[0]);
  const ys = a.rings.flat().map((p) => p[1]);
  return { ...a, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

let fetchFeed: (feed: Feed) => Promise<Area[] | null> = readFeed;

/** One list at a time, for the same reason as the cooling lists: no answer waits on more than one parse. */
async function poll(): Promise<void> {
  for (const feed of FEEDS) {
    const gate = gates.get(feed.name)!;
    if (!gate.ready()) continue;
    const fresh = await fetchFeed(feed);
    if (fresh) {
      gate.ok();
      held.set(feed.name, { areas: fresh, checkedAt: Date.now() });
    } else {
      gate.fail();
      const was = held.get(feed.name);
      if (was && Date.now() - was.checkedAt > STALE_MS) held.delete(feed.name);
    }
    await new Promise((r) => setImmediate(r));
  }
}

export async function start(): Promise<void> {
  await poll();
  await pollCounties();
  const timer = setInterval(() => void poll().then(pollCounties), EVERY_MS);
  timer.unref?.();
}

/** Ray casting, with holes: inside an odd number of rings. */
function inside(lon: number, lat: number, rings: number[][][]): boolean {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

const within = (lat: number, lon: number, b: Box) => lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1];

/**
 * The outage covering this point. Undefined where no list reaches, null when the lists that reach it could not
 * be read, false when they were read and none shows an outage at the point.
 */
export function at(lat: number, lon: number): Outage | false | null | undefined {
  const feeds = FEEDS.filter((f) => f.covers.some((b) => within(lat, lon, b)));
  if (!feeds.length) return undefined;
  const lists = feeds.map((f) => held.get(f.name)).filter((h) => h && Date.now() - h.checkedAt <= STALE_MS);
  if (!lists.length) return null;
  for (const list of lists) {
    const hit = list!.areas.find((a) => lon >= a.box[0] && lon <= a.box[2] && lat >= a.box[1] && lat <= a.box[3] && inside(lon, lat, a.rings));
    if (hit) {
      const { rings: _r, box: _b, ...outage } = hit;
      return outage;
    }
  }
  return false;
}

/** "Duke Energy shows the power out where you live: expected back by Tue 2 AM." */
export function sentence(o: Outage, timeZone: string): string {
  const back = o.backBy
    ? new Date(o.backBy).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone }).replace(':00', '')
    : null;
  const why = o.planned ? ', planned work' : /safety/i.test(o.cause ?? '') ? ', a safety shutoff' : '';
  const says = o.says ?? "California's emergency office";
  // The utility is named when the list is not the utility's own.
  const who = says === o.utility ? '' : `${o.utility}`;
  const detail = `${who}${why}`.replace(/^, /, '');
  return `${says} shows the power out where you live${detail ? `: ${detail}` : ''}${back ? `, expected back by ${back}` : ', with no time given for it to come back'}.`;
}

export const areasHeld = (): number | null => (held.size ? [...held.values()].reduce((n, h) => n + h.areas.length, 0) : null);
export const feedNames = (): string[] => FEEDS.map((f) => f.name);

/** Seeds one list; California unless another is named, as the tests written before there were three expect. */
export function seedForTest(areas: (Outage & { rings: number[][][] })[] | null, checkedAt = Date.now(), feed = 'California'): void {
  const says = FEEDS.find((f) => f.name === feed)?.says;
  if (areas) held.set(feed, { areas: areas.map((a) => withBox({ says, ...a })), checkedAt });
  else held.delete(feed);
}
export function configureForTest(fake: ((feed: { name: string }) => Promise<Area[] | null>) | null): void {
  fetchFeed = fake ?? readFeed;
  held.clear();
}

/* ----------------------------------------------------------------- *
 * By county, where no list gives the streets.
 * ----------------------------------------------------------------- */

export type CountyOutage = { county: string; out: number; served: number | null; says: string; at: string | null };
type CountyArea = CountyOutage & { rings: number[][][]; box: [number, number, number, number] };
type CountyFeed = { name: string; says: string; url: string; read: (a: Attrs) => Omit<CountyOutage, 'says'> | null };

const FRESH_MS = 6 * 60 * 60 * 1000;
const COUNTY_FEEDS: CountyFeed[] = [
  {
    name: 'Maryland counties',
    says: "Maryland's emergency management agency",
    url: 'https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services/PowerOutage_CountiesGeneralDEV_Join/FeatureServer/0/query?where=1%3D1&outFields=area,outages,customers,dt_stamp&outSR=4326&geometryPrecision=4&f=json',
    read: (a) => ({ county: `${String(a.area ?? '').trim()}${/city$/i.test(String(a.area ?? '')) ? '' : ' County'}`, out: num(a.outages) ?? 0, served: num(a.customers), at: when(a.dt_stamp) }),
  },
  {
    name: 'Pennsylvania counties',
    says: "Pennsylvania's emergency management agency",
    url: 'https://gis.penndot.gov/arcgis/rest/services/poweroutages/papoweroutages/FeatureServer/1/query?where=1%3D1&outFields=NAME,CUSTOMERS_OUT,EST_CUST_SERVED,UPDATE_DATE&outSR=4326&geometryPrecision=4&f=json',
    read: (a) => ({ county: `${String(a.NAME ?? '').trim()} County`, out: num(a.CUSTOMERS_OUT) ?? 0, served: num(a.EST_CUST_SERVED), at: when(a.UPDATE_DATE) }),
  },
  {
    name: 'Ohio counties',
    says: "Ohio's emergency management agency",
    url: 'https://services6.arcgis.com/zxOMWqh0yAD6mMsJ/arcgis/rest/services/Join_Eagle_I_outages_to_county/FeatureServer/0/query?where=1%3D1&outFields=countyName,currentOutage,coveredCustomers,currentOutageRunStartTime&outSR=4326&geometryPrecision=4&f=json',
    read: (a) => ({ county: `${String(a.countyName ?? '').trim()} County`, out: num(a.currentOutage) ?? 0, served: num(a.coveredCustomers), at: when(a.currentOutageRunStartTime) }),
  },
  {
    name: 'Alliant Energy counties',
    says: 'Alliant Energy',
    url: 'https://services3.arcgis.com/sqVn1QnQEPnGQy9r/arcgis/rest/services/AEOutagesByCounty/FeatureServer/0/query?where=1%3D1&outFields=COUNTY,CUST_OUT,CUSTOMERS&outSR=4326&geometryPrecision=4&f=json',
    // No time on the rows: the utility's own live layer, read every ten minutes.
    read: (a) => ({ county: `${String(a.COUNTY ?? '').trim()} County`, out: num(a.CUST_OUT) ?? 0, served: num(a.CUSTOMERS), at: null }),
  },
];
const counties = new Map<string, { areas: CountyArea[]; checkedAt: number }>();
let fetchCounty: (feed: CountyFeed) => Promise<CountyArea[] | null> = readCountyFeed;

async function readCountyFeed(feed: CountyFeed): Promise<CountyArea[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(feed.url, { signal: ctrl.signal, headers: { 'User-Agent': 'sudor/0.1 (Alexa+ add-on; heat and cold safety)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { features?: { attributes?: Attrs; geometry?: { rings?: number[][][] } }[]; error?: { message?: string } };
    if (body.error || !Array.isArray(body.features)) throw new Error(body.error?.message ?? 'no features');
    return body.features
      .filter((f) => f.geometry?.rings?.length)
      .map((f) => {
        const row = feed.read(f.attributes ?? {});
        return row ? (withBox({ ...row, says: feed.says, rings: f.geometry!.rings! } as unknown as Outage & { rings: number[][][] }) as unknown as CountyArea) : null;
      })
      .filter((a): a is CountyArea => !!a);
  } catch (err) {
    console.error(`[outages] could not read the ${feed.name} outage counts:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pollCounties(): Promise<void> {
  for (const feed of COUNTY_FEEDS) {
    const fresh = await fetchCounty(feed);
    if (fresh) counties.set(feed.name, { areas: fresh, checkedAt: Date.now() });
    else {
      const was = counties.get(feed.name);
      if (was && Date.now() - was.checkedAt > STALE_MS) counties.delete(feed.name);
    }
    await new Promise((r) => setImmediate(r));
  }
}

/** The county count covering this point, when somebody there is out and the count is fresh; otherwise null. */
export function countyAt(lat: number, lon: number, now = Date.now()): CountyOutage | null {
  for (const list of counties.values()) {
    if (now - list.checkedAt > STALE_MS) continue;
    const hit = list.areas.find((a) => lon >= a.box[0] && lon <= a.box[2] && lat >= a.box[1] && lat <= a.box[3] && inside(lon, lat, a.rings));
    if (!hit) continue;
    if (hit.at && now - Date.parse(hit.at) > FRESH_MS) return null;
    // A handful out in a county of hundreds of thousands is any ordinary day. Said when it is an outage worth knowing about.
    const share = hit.served ? hit.out / hit.served : 0;
    if (hit.out < 1000 && share < 0.01) return null;
    const { rings: _r, box: _b, ...row } = hit;
    return row;
  }
  return null;
}

const many = (n: number): string => (n >= 1000 ? `about ${Math.round(n / 100) * 100}`.replace(/(\d)(?=(\d{3})+$)/, '$1,') : String(n));

/** "Pennsylvania's emergency management agency shows about 1,200 of 10,800 customers in Wyoming County without power." */
export function countySentence(c: CountyOutage): string {
  const of = c.served ? ` of ${many(c.served)}` : '';
  return `${c.says} shows ${many(c.out)}${of} customers in ${c.county} without power right now. That is the county, not your street, so check your own lights and your utility.`;
}

export function seedCountyForTest(feed: string, areas: (CountyOutage & { rings: number[][][] })[] | null, checkedAt = Date.now()): void {
  if (areas) counties.set(feed, { areas: areas.map((a) => withBox(a as unknown as Outage & { rings: number[][][] }) as unknown as CountyArea), checkedAt });
  else counties.delete(feed);
}
export function configureCountyForTest(fake: ((feed: { name: string }) => Promise<CountyArea[] | null>) | null): void {
  fetchCounty = fake ?? readCountyFeed;
  counties.clear();
}
