/**
 * The days ahead, from the forecasters' own products.
 *
 * The official alerts read in warnings.ts are what is happening, or what a forecast office has already
 * flagged as likely in the next day or two. The decisions that matter most for somebody on insulin, oxygen or
 * dialysis are made earlier than that: when to fill a prescription, charge a battery, ring a dialysis unit.
 * Three official US forecasts reach further, and each is asked about this person's own point:
 *
 *   NWS HeatRisk. The Weather Service's experimental heat forecast, 0 to 4 for each of the next seven days,
 *   built for exactly this: how unusual the heat is for the place, how long it lasts, whether nights cool
 *   off, and who is sensitive to it. Level 2 affects most people who are sensitive to heat; 3 and 4 affect
 *   anybody without cooling.
 *   https://www.wpc.ncep.noaa.gov/heatrisk/
 *
 *   The National Hurricane Center's forecast cone, for every active storm. Inside the cone means the centre
 *   could pass here within five days. It is not where the damage stops, and the answer says so.
 *   https://www.nhc.noaa.gov/aboutcone.shtml
 *
 *   The National Water Prediction Service's river forecasts, for gauges within 15 km. A forecast peak above
 *   the gauge's own minor, moderate or major flood stage is said with the river's name and when.
 *   https://water.noaa.gov/about/api
 *
 * Everything is fetched in the background once an hour for places somebody lives, and read from memory in an
 * answer. A product that cannot be reached is "unknown", never "nothing coming".
 */

const HEATRISK = 'https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/identify';
const STORMS = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const CONES = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const NWPS = 'https://api.water.noaa.gov/nwps/v1';
const EVERY_MS = 60 * 60 * 1000;
const AGENT = 'sudor-mcp (github.com/nirbhay221/sudor)';

/** The cone layer for each NHC storm slot ("AT4"), from the map service's own layer list. */
const CONE_LAYER: Record<string, number> = {
  AT1: 8, AT2: 34, AT3: 60, AT4: 86, AT5: 112, EP1: 138, EP2: 164, EP3: 190, EP4: 216, EP5: 242, CP1: 268, CP2: 294, CP3: 320, CP4: 346, CP5: 372,
};

export type HeatDay = { date: string; level: number };
export type Storm = { name: string; kind: string };
export type River = { name: string; category: 'minor' | 'moderate' | 'major'; peakFt: number; at: string };
export type Outlook = { heat: HeatDay[] | null; storms: Storm[] | null; rivers: River[] | null; checkedAt: number };

const held = new Map<string, Outlook>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const key = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': AGENT, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** The identify answer: one value per catalog item, in the same order, each item a day by its valid time. */
export function parseHeatRisk(body: unknown): HeatDay[] {
  const b = body as { properties?: { Values?: unknown[] }; catalogItems?: { features?: { attributes?: { idp_validtime?: number } }[] } };
  const values = b?.properties?.Values;
  const items = b?.catalogItems?.features;
  if (!Array.isArray(values) || !Array.isArray(items) || values.length !== items.length) throw new Error('heatrisk: shape');
  return items
    .map((f, i) => ({ at: Number(f.attributes?.idp_validtime), level: Number(values[i]) }))
    .filter((x) => Number.isFinite(x.at) && Number.isFinite(x.level) && x.level >= 0 && x.level <= 4)
    .sort((a, b) => a.at - b.at)
    .map((x) => ({ date: new Date(x.at).toISOString().slice(0, 10), level: x.level }));
}

async function heatRisk(lat: number, lon: number): Promise<HeatDay[]> {
  const q = new URLSearchParams({
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    returnCatalogItems: 'true',
    returnGeometry: 'false',
    f: 'json',
  });
  return parseHeatRisk(await getJson(`${HEATRISK}?${q}`));
}

let stormList: { at: number; storms: { bin: string; name: string; kind: string }[] } | null = null;
async function activeStorms(): Promise<{ bin: string; name: string; kind: string }[]> {
  if (stormList && Date.now() - stormList.at < EVERY_MS / 2) return stormList.storms;
  const body = (await getJson(STORMS)) as { activeStorms?: { binNumber?: string; name?: string; classification?: string }[] };
  const KIND: Record<string, string> = { HU: 'Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression', PTC: 'Potential Tropical Cyclone', STS: 'Subtropical Storm', STD: 'Subtropical Depression' };
  const storms = (body.activeStorms ?? [])
    .filter((s) => s.binNumber && CONE_LAYER[s.binNumber] != null)
    .map((s) => ({ bin: s.binNumber as string, name: String(s.name ?? 'an unnamed storm'), kind: KIND[String(s.classification)] ?? 'Storm' }));
  stormList = { at: Date.now(), storms };
  return storms;
}

async function stormsHere(lat: number, lon: number): Promise<Storm[]> {
  const out: Storm[] = [];
  for (const s of await activeStorms()) {
    const q = new URLSearchParams({
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      returnCountOnly: 'true',
      f: 'json',
    });
    const body = (await getJson(`${CONES}/${CONE_LAYER[s.bin]}/query?${q}`)) as { count?: number };
    if ((body.count ?? 0) > 0) out.push({ name: s.name, kind: s.kind });
  }
  return out;
}

const kmBetween = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const r = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/** The worst flood category a forecast reaches, against the gauge's own flood stages. */
export function floodCategory(peakFt: number, cats: Record<string, { stage?: number }> | undefined): River['category'] | null {
  const at = (k: string) => {
    const v = cats?.[k]?.stage;
    return typeof v === 'number' && v > 0 ? v : null;
  };
  const major = at('major');
  const moderate = at('moderate');
  const minor = at('minor');
  if (major != null && peakFt >= major) return 'major';
  if (moderate != null && peakFt >= moderate) return 'moderate';
  if (minor != null && peakFt >= minor) return 'minor';
  return null;
}

async function riversHere(lat: number, lon: number): Promise<River[]> {
  const d = 0.15;
  const q = new URLSearchParams({ 'bbox.xmin': String(lon - d), 'bbox.ymin': String(lat - d), 'bbox.xmax': String(lon + d), 'bbox.ymax': String(lat + d), srid: 'EPSG_4326' });
  const list = ((await getJson(`${NWPS}/gauges?${q}`)) as { gauges?: { lid: string; name: string; latitude: number; longitude: number }[] }).gauges ?? [];
  const out: River[] = [];
  for (const g of list.filter((x) => kmBetween(lat, lon, x.latitude, x.longitude) <= 15).slice(0, 4)) {
    const [detail, flow] = await Promise.all([
      getJson(`${NWPS}/gauges/${g.lid}`) as Promise<{ flood?: { categories?: Record<string, { stage?: number }> } }>,
      getJson(`${NWPS}/gauges/${g.lid}/stageflow/forecast`) as Promise<{ data?: { validTime: string; primary: number }[] }>,
    ]);
    const points = (flow.data ?? []).filter((p) => Number.isFinite(p.primary));
    if (!points.length) continue;
    const peak = points.reduce((a, b) => (b.primary > a.primary ? b : a));
    const category = floodCategory(peak.primary, detail.flood?.categories);
    if (category) out.push({ name: g.name, category, peakFt: peak.primary, at: peak.validTime });
  }
  return out;
}

export async function refresh(lat: number, lon: number): Promise<void> {
  const [heat, storms, rivers] = await Promise.allSettled([heatRisk(lat, lon), stormsHere(lat, lon), riversHere(lat, lon)]);
  const prior = held.get(key(lat, lon));
  held.set(key(lat, lon), {
    heat: heat.status === 'fulfilled' ? heat.value : prior?.heat ?? null,
    storms: storms.status === 'fulfilled' ? storms.value : prior?.storms ?? null,
    rivers: rivers.status === 'fulfilled' ? rivers.value : prior?.rivers ?? null,
    checkedAt: Date.now(),
  });
}

/** Follow a place in the United States. Called when somebody's place is set. */
export function watch(lat: number, lon: number): void {
  const k = key(lat, lon);
  if (timers.has(k)) return;
  void refresh(lat, lon).catch(() => {});
  const t = setInterval(() => void refresh(lat, lon).catch(() => {}), EVERY_MS);
  t.unref?.();
  timers.set(k, t);
  if (timers.size > 2000) {
    const [first, timer] = timers.entries().next().value as [string, ReturnType<typeof setInterval>];
    clearInterval(timer);
    timers.delete(first);
    held.delete(first);
  }
}

export const current = (lat: number, lon: number): Outlook | null => held.get(key(lat, lon)) ?? null;

const WEEKDAY = (date: string): string => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

/**
 * The days ahead, said for this person, or nothing. `sensitive` is anybody the heat is harder on: for them the
 * Weather Service's level 2 is the line, for everybody else level 3. Today is left to the rest of the answer.
 */
export function speak(o: Outlook | null, sensitive: boolean, today: string): string[] {
  if (!o) return [];
  const lines: string[] = [];
  const line = sensitive ? 2 : 3;
  const ahead = (o.heat ?? []).filter((d) => d.date > today && d.level >= line);
  if (ahead.length) {
    const worst = ahead.reduce((a, b) => (b.level > a.level ? b : a));
    const days = ahead.slice(0, 3).map((d) => WEEKDAY(d.date));
    lines.push(
      `Looking ahead, the Weather Service's HeatRisk forecast puts ${days.length === 1 ? days[0] : `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`} at level ${worst.level} of 4` +
        `${sensitive ? ', which is high enough to affect you' : ''}. Make sure your medicines and cooling are sorted before then.`,
    );
  }
  for (const s of o.storms ?? []) {
    lines.push(
      `${s.kind} ${s.name}'s forecast cone covers where you live, so its centre could pass within five days. That is the time to fill prescriptions, charge equipment and decide where you would go.`,
    );
  }
  for (const r of (o.rivers ?? []).slice(0, 2)) {
    lines.push(`The ${r.name} is forecast to reach ${r.category} flood stage around ${WEEKDAY(r.at.slice(0, 10))}.`);
  }
  return lines;
}

/**
 * Outside the United States there is no HeatRisk, so the week ahead comes from the ordinary forecast: a day
 * whose feels-like high reaches 95F for somebody sensitive, or 103F (the Weather Service's "danger" line on its
 * heat index) for anybody else, is named. Said as the forecast, not as an official product.
 */
export function speakWorld(days: { date: string; feelsMaxF: number }[] | undefined, sensitive: boolean, today: string): string {
  const line = sensitive ? 95 : 103;
  const hot = (days ?? []).filter((d) => d.date > today && d.feelsMaxF >= line);
  if (!hot.length) return '';
  const worst = hot.reduce((a, b) => (b.feelsMaxF > a.feelsMaxF ? b : a));
  return `Looking ahead, the forecast has ${WEEKDAY(worst.date)} feeling like ${Math.round(worst.feelsMaxF)} degrees${hot.length > 1 ? `, and ${hot.length - 1} more hot day${hot.length > 2 ? 's' : ''} this week` : ''}. Make sure your medicines and cooling are sorted before then.`;
}
