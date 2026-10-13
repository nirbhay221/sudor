/**
 * Is the power out where this person lives, right now?
 *
 * California's Office of Emergency Services publishes every active power outage area in the state, planned or not,
 * with the utility, the cause and when power is expected back: the Statewide Power Outages layer, open, with no
 * key. Its areas come from PG&E, which serves most of northern and central California and is the utility that
 * runs the largest Public Safety Power Shutoffs, when it cuts lines on purpose ahead of fire weather.
 *
 * For somebody on oxygen or with insulin in the fridge, "the power is out at your address, PG&E expects it back
 * at 6 tomorrow evening" decides whether to stay or go. The whole list is read on a timer, about 150 areas,
 * and matched here, so nobody's address is sent anywhere. A failed read is "I could not check", never "the
 * power is on".
 *
 * Source: https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Power_Outages_(View)/FeatureServer
 */

import { backoff } from './backoff.js';

export type Outage = {
  utility: string;
  planned: boolean;
  cause: string | null;
  startedAt: string | null;
  backBy: string | null;
  customers: number | null;
};
type Area = Outage & { rings: number[][][]; box: [number, number, number, number] };

const URL_ =
  'https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Power_Outages_(View)/FeatureServer/1/query' +
  "?where=OutageStatus%3D%27Active%27&outFields=UtilityCompany,StartDate,EstimatedRestoreDate,Cause,OutageType,ImpactedCustomers" +
  '&outSR=4326&geometryPrecision=5&f=json';
const EVERY_MS = 10 * 60 * 1000;
const STALE_MS = 45 * 60 * 1000;
/** California, roughly: outside it this list says nothing either way. */
const CA = { lat: [32.4, 42.1], lon: [-124.6, -114.0] };

let held: { areas: Area[]; checkedAt: number } | null = null;
const gate = backoff();

const UTILITY: Record<string, string> = { PGE: 'PG&E', SCE: 'Southern California Edison', SDGE: 'SDG&E', SMUD: 'SMUD', LADWP: 'LADWP' };

async function read(): Promise<Area[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(URL_, { signal: ctrl.signal, headers: { 'User-Agent': 'sudor/0.1 (Alexa+ add-on; heat and cold safety)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { features?: { attributes?: Record<string, unknown>; geometry?: { rings?: number[][][] } }[]; error?: { message?: string } };
    if (body.error || !Array.isArray(body.features)) throw new Error(body.error?.message ?? 'no features');
    return body.features
      .filter((f) => f.geometry?.rings?.length)
      .map((f) => {
        const a = f.attributes ?? {};
        const rings = f.geometry!.rings!;
        const xs = rings.flat().map((p) => p[0]);
        const ys = rings.flat().map((p) => p[1]);
        const when = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v).toISOString() : null);
        const code = String(a.UtilityCompany ?? '').trim();
        return {
          utility: UTILITY[code] ?? code,
          planned: /^planned$/i.test(String(a.OutageType ?? '')),
          cause: String(a.Cause ?? '').trim() || null,
          startedAt: when(a.StartDate),
          backBy: when(a.EstimatedRestoreDate),
          customers: typeof a.ImpactedCustomers === 'number' ? a.ImpactedCustomers : null,
          rings,
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number],
        };
      });
  } catch (err) {
    console.error('[outages] could not read the California outage list:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let fetchAreas: () => Promise<Area[] | null> = read;

async function poll(): Promise<void> {
  if (!gate.ready()) return;
  const fresh = await fetchAreas();
  if (fresh) {
    gate.ok();
    held = { areas: fresh, checkedAt: Date.now() };
  } else {
    gate.fail();
    if (held && Date.now() - held.checkedAt > STALE_MS) held = null;
  }
}

export async function start(): Promise<void> {
  await poll();
  const timer = setInterval(() => void poll(), EVERY_MS);
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

/**
 * The outage covering this point. Undefined outside California, where this list says nothing; null when the list
 * could not be read; false when it was read and no outage covers the point.
 */
export function at(lat: number, lon: number): Outage | false | null | undefined {
  if (lat < CA.lat[0] || lat > CA.lat[1] || lon < CA.lon[0] || lon > CA.lon[1]) return undefined;
  if (!held || Date.now() - held.checkedAt > STALE_MS) return null;
  const hit = held.areas.find((a) => lon >= a.box[0] && lon <= a.box[2] && lat >= a.box[1] && lat <= a.box[3] && inside(lon, lat, a.rings));
  if (!hit) return false;
  const { rings: _r, box: _b, ...outage } = hit;
  return outage;
}

/** "California's emergency office shows the power out where you live: PG&E, planned work, back by Tue 6 PM." */
export function sentence(o: Outage, timeZone: string): string {
  const when = o.backBy
    ? new Date(o.backBy).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone }).replace(':00', '')
    : null;
  const why = o.planned ? ', planned work' : /safety/i.test(o.cause ?? '') ? ', a safety shutoff' : '';
  return `California's emergency office shows the power out where you live: ${o.utility}${why}${when ? `, expected back by ${when}` : ', with no time given for it to come back'}.`;
}

export const areasHeld = (): number | null => (held ? held.areas.length : null);

export function seedForTest(areas: (Outage & { rings: number[][][] })[] | null, checkedAt = Date.now()): void {
  held = areas
    ? {
        areas: areas.map((a) => {
          const xs = a.rings.flat().map((p) => p[0]);
          const ys = a.rings.flat().map((p) => p[1]);
          return { ...a, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number] };
        }),
        checkedAt,
      }
    : null;
}
export function configureForTest(fake: (() => Promise<Area[] | null>) | null): void {
  fetchAreas = fake ?? read;
  held = null;
}
