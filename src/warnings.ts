import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inUS } from './world.js';
/**
 * The official warnings for one address, and what the weather service itself
 * says to do about them.
 *
 * Sudor does not need to invent safety advice for a flood or an ice storm. The
 * National Weather Service publishes an instruction with most alerts, written
 * by the forecast office that issued it, and that text is better than anything
 * this project could write. What Sudor adds is the half the weather service
 * cannot know: which of these matters more because of the person's medicines
 * and conditions.
 *
 * Two rules, the same as everywhere else here:
 *
 * 1. Never inside a tool call. The alerts endpoint answered in about 900 ms in
 *    testing, which is twice the whole voice budget. Alerts are polled per
 *    registered location and every answer is served from memory.
 * 2. Silence is not safety. If the poll has never succeeded for a location, the
 *    tool says it has not been able to check, rather than "no warnings".
 *
 * Source: api.weather.gov, which requires a User-Agent identifying the caller.
 * https://www.weather.gov/documentation/services-web-api
 */

const API = 'https://api.weather.gov/alerts/active';
const AGENT = 'sudor-mcp (github.com/nirbhay221/sudor)';
const TTL_MS = 10 * 60 * 1000;

/** What an alert means for a body, which is the only reason this file exists. */
export type AlertKind = 'heat' | 'cold' | 'air' | 'power' | 'flood' | 'other';

export type Alert = {
  id: string;
  event: string;
  kind: AlertKind;
  severity: string;
  urgency: string;
  headline: string;
  /** The weather service's own words on what to do. Often the most useful part. */
  instruction: string | null;
  areaDesc: string;
  onset: string | null;
  ends: string | null;
};

type Entry = { checkedAt: number; alerts: Alert[] };
const cache = new Map<string, Entry>();

/** Oldest out first. Keyed by whatever a caller typed, so it must not grow without limit. */
const MAX_CACHED = 2000;
const remember = (k: string, e: Entry): void => {
  cache.set(k, e);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
};
const key = (lat: number, lon: number) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

type Fetcher = (lat: number, lon: number) => Promise<Alert[]>;
/** The country each watched place is in. The weather service only covers the United States. */
const countries = new Map<string, string>();
const route: Fetcher = (lat, lon) => {
  const c = countries.get(key(lat, lon));
  if (inUS(c)) return fetchFromNws(lat, lon);
  if (c === 'IN') return fetchFromSachet(lat, lon);
  if (c && METEOALARM[c]) return fetchFromMeteoAlarm(lat, lon, c);
  if (c === 'BR') return fetchFromInmet(lat, lon);
  return fetchFromWmo(lat, lon);
};
let fetcher: Fetcher = route;
export function configureForTest(fn: Fetcher | null): void {
  fetcher = fn ?? route;
  cache.clear();
}

/*
 * Official warnings anywhere else.
 *
 * The World Meteorological Organization's Severe Weather Information Centre gathers the official warnings
 * of more than 130 national weather services, in the Common Alerting Protocol, with the area each one
 * covers. The map on its site asks its own feature server which warnings cover a point, and this asks the
 * same question the same way. It is the server behind the WMO's public page, not a published API, so it is
 * asked at most once per place every ten minutes and a failure is treated as "could not check", never as
 * an all-clear. Many services publish in English; where a service does not, the event is said as given.
 *
 * Source: https://severeweather.wmo.int/
 */
const WMO = 'https://severeweather.wmo.int/f/wfs';
const SEVERITY = ['Unknown', 'Minor', 'Moderate', 'Severe', 'Extreme'];

export function parseWmo(body: unknown, now = Date.now()): Alert[] {
  const features = (body as { features?: { properties?: Record<string, unknown> }[] } | null)?.features;
  if (!Array.isArray(features)) throw new Error('wmo: no features');
  const byEvent = new Map<string, Alert>();
  for (const f of features) {
    const p = f.properties ?? {};
    const expires = p.expires ? Date.parse(String(p.expires)) : NaN;
    if (Number.isFinite(expires) && expires < now) continue;
    const raw = String(p.event ?? '').trim();
    if (!raw) continue;
    const s = Math.max(0, Math.min(4, Number(p.s ?? 0) || 0));
    // "persistent rain" from one service and "Wind Advisory" from another. A severe one with no level in
    // its name is called a warning, which is what the issuing service calls it.
    const named = raw.charAt(0).toUpperCase() + raw.slice(1);
    const event = s >= 3 && !/warning|watch|advisory|statement|alert/i.test(named) ? `${named} warning` : named;
    const id = String(p.capurl ?? `${event}|${p.sent ?? ''}`);
    const held = byEvent.get(event);
    if (held && SEVERITY.indexOf(held.severity) >= s) continue;
    const said = String(p.description ?? p.headline ?? '').replace(/\s+/g, ' ').trim();
    byEvent.set(event, {
      id,
      event,
      kind: classify(event),
      severity: SEVERITY[s],
      urgency: 'Unknown',
      headline: String(p.headline ?? event),
      instruction: said ? said.slice(0, 400) : null,
      areaDesc: String(p.areadesc ?? '').slice(0, 300),
      onset: p.onset ? String(p.onset) : null,
      ends: p.expires ? String(p.expires) : null,
    });
  }
  return [...byEvent.values()];
}

/*
 * India.
 *
 * India's official alerts, from the India Meteorological Department, the Central Water Commission and each
 * state's disaster management authority, are published together by the National Disaster Management
 * Authority's SACHET platform, in the Common Alerting Protocol. Its public list gives each alert a centre and
 * the area it covers, not the outline, so an alert is taken to apply within the circle of that area around its
 * centre, with a quarter again as margin. That is an approximation of the official area and it is said as the
 * state authority's alert, never as a statement about this street. The list is fetched once for all of India
 * and shared, at most every ten minutes.
 *
 * Source: https://sachet.ndma.gov.in/
 */
const SACHET = 'https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails';
let sachetHeld: { at: number; rows: Record<string, unknown>[] } | null = null;

const kmBetween = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const r = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

export function parseSachet(rows: unknown, lat: number, lon: number, now = Date.now()): Alert[] {
  if (!Array.isArray(rows)) throw new Error('sachet: not a list');
  const out = new Map<string, Alert>();
  for (const r of rows as Record<string, unknown>[]) {
    const [cLon, cLat] = String(r.centroid ?? '').split(',').map(Number);
    const area = Number(r.area_covered);
    if (!Number.isFinite(cLat) || !Number.isFinite(cLon) || !Number.isFinite(area)) continue;
    const reach = Math.sqrt(area / Math.PI) * 1.25 + 5;
    if (kmBetween(lat, lon, cLat, cLon) > reach) continue;
    const ends = Date.parse(String(r.effective_end_time ?? '').replace(' IST ', ' GMT+0530 '));
    if (Number.isFinite(ends) && ends < now) continue;
    const type = String(r.disaster_type ?? '').trim();
    if (!type) continue;
    // ALERT and WARNING are the authority's own words for its two higher levels; orange and red its colours.
    const level = String(r.severity ?? '').toUpperCase();
    const colour = String(r.severity_color ?? '').toLowerCase();
    const severity = level === 'WARNING' || colour === 'red' ? 'Severe' : level === 'ALERT' || colour === 'orange' ? 'Moderate' : 'Minor';
    const event = severity === 'Severe' ? `${type} warning` : `${type} alert`;
    const source = String(r.alert_source ?? 'the state disaster management authority');
    const prior = out.get(event);
    if (prior && RANK[prior.severity] >= RANK[severity]) continue;
    out.set(event, {
      id: `sachet:${String(r.identifier ?? event)}`,
      event,
      kind: classify(type),
      severity,
      urgency: 'Unknown',
      headline: `${event} from ${source}`,
      instruction: `Issued by ${source}. Follow the State Disaster Management Authority's instructions.`,
      areaDesc: String(r.area_description ?? '').slice(0, 200),
      onset: null,
      ends: Number.isFinite(ends) ? new Date(ends).toISOString() : null,
    });
  }
  return [...out.values()];
}

async function fetchFromSachet(lat: number, lon: number): Promise<Alert[]> {
  if (!sachetHeld || Date.now() - sachetHeld.at > TTL_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(SACHET, { signal: ctrl.signal, headers: { 'User-Agent': AGENT } });
      if (!res.ok) throw new Error(`sachet ${res.status}`);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (!Array.isArray(rows)) throw new Error('sachet: not a list');
      sachetHeld = { at: Date.now(), rows };
    } finally {
      clearTimeout(timer);
    }
  }
  return parseSachet(sachetHeld.rows, lat, lon);
}

/*
 * Europe.
 *
 * MeteoAlarm is the official warning service of Europe's national weather services, one feed per country,
 * in the Common Alerting Protocol, free under CC BY 4.0. It is what the UK, France and Austria are read from,
 * which the WMO's centre does not carry, and the rest of Europe with it. Its warnings name the areas they
 * cover by code (EMMA_ID, or NUTS3 in France), so assets/meteoalarm-areas.json holds those outlines (built by
 * scripts/build-meteoalarm-areas.py) and a point is looked up in them. Where an area has no outline, as for
 * the UK's, the warning is matched by the town's name in the area description. Green, "no warning", is left
 * out; the English text is used where the service gives one.
 *
 * Source: https://feeds.meteoalarm.org/ (CC BY 4.0)
 */
const METEOALARM: Record<string, string> = {
  GB: 'united-kingdom', FR: 'france', AT: 'austria', DE: 'germany', ES: 'spain', IT: 'italy', IE: 'ireland', PT: 'portugal',
  NL: 'netherlands', BE: 'belgium', LU: 'luxembourg', CH: 'switzerland', DK: 'denmark', NO: 'norway', SE: 'sweden', FI: 'finland',
  PL: 'poland', CZ: 'czechia', SK: 'slovakia', HU: 'hungary', SI: 'slovenia', HR: 'croatia', GR: 'greece', CY: 'cyprus',
  MT: 'malta', RO: 'romania', BG: 'bulgaria', EE: 'estonia', LV: 'latvia', LT: 'lithuania', IS: 'iceland', RS: 'serbia',
};
const maHeld = new Map<string, { at: number; rows: unknown[] }>();
type Ring = number[][];
type Shape = { type: string; coordinates: unknown };
let areaShapes: Record<string, Shape> | null = null;
function areas(): Record<string, Shape> {
  if (areaShapes) return areaShapes;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    areaShapes = (JSON.parse(readFileSync(resolve(here, '..', 'assets', 'meteoalarm-areas.json'), 'utf8')) as { areas?: Record<string, Shape> }).areas ?? {};
  } catch {
    areaShapes = {};
  }
  return areaShapes;
}
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inShape(lon: number, lat: number, s: Shape): boolean {
  const polys = (s.type === 'Polygon' ? [s.coordinates] : s.type === 'MultiPolygon' ? s.coordinates : []) as Ring[][];
  return polys.some((rings) => rings.length > 0 && inRing(lon, lat, rings[0]) && !rings.slice(1).some((hole) => inRing(lon, lat, hole)));
}

export function parseMeteoAlarm(rows: unknown, lat: number, lon: number, town: string | null, now = Date.now()): Alert[] {
  if (!Array.isArray(rows)) throw new Error('meteoalarm: not a list');
  const shapes = areas();
  const out = new Map<string, Alert>();
  for (const row of rows as { alert?: { identifier?: string; info?: Record<string, unknown>[] } }[]) {
    const infos = row.alert?.info ?? [];
    const info = infos.find((i) => /^en/i.test(String(i.language ?? ''))) ?? infos[0];
    if (!info) continue;
    const ends = Date.parse(String(info.expires ?? ''));
    if (Number.isFinite(ends) && ends < now) continue;
    const level = ((info.parameter as { valueName?: string; value?: string }[] | undefined) ?? []).find((p) => p.valueName === 'awareness_level')?.value ?? '';
    if (/^1;|green/i.test(level)) continue;
    const covered = ((info.area as { areaDesc?: string; geocode?: { valueName?: string; value?: string }[] }[] | undefined) ?? []).some((a) => {
      const coded = (a.geocode ?? []).map((g) => shapes[`${g.valueName}:${g.value}`]).filter(Boolean);
      if (coded.length) return coded.some((s) => inShape(lon, lat, s));
      return !!town && town.length >= 3 && String(a.areaDesc ?? '').toLowerCase().includes(town.toLowerCase());
    });
    if (!covered) continue;
    const raw = String(info.event ?? '').trim();
    if (!raw) continue;
    const severity = ['Extreme', 'Severe', 'Moderate', 'Minor'].includes(String(info.severity)) ? String(info.severity) : 'Moderate';
    const named = raw.charAt(0).toUpperCase() + raw.slice(1);
    const event = /warning|watch|advisory|alert/i.test(raw) ? named : `${named} warning`;
    const prior = out.get(event);
    if (prior && RANK[prior.severity] >= RANK[severity]) continue;
    const said = String(info.instruction ?? info.description ?? '').replace(/\s+/g, ' ').trim();
    out.set(event, {
      id: `meteoalarm:${row.alert?.identifier ?? event}`,
      event,
      kind: classify(event),
      severity,
      urgency: String(info.urgency ?? 'Unknown'),
      headline: String(info.headline ?? event),
      instruction: said ? said.slice(0, 400) : null,
      areaDesc: '',
      onset: info.onset ? String(info.onset) : null,
      ends: Number.isFinite(ends) ? new Date(ends).toISOString() : null,
    });
  }
  return [...out.values()];
}

async function fetchFromMeteoAlarm(lat: number, lon: number, country: string): Promise<Alert[]> {
  const held = maHeld.get(country);
  let rows = held && Date.now() - held.at < TTL_MS ? held.rows : null;
  if (!rows) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(`https://feeds.meteoalarm.org/api/v1/warnings/feeds-${METEOALARM[country]}`, { signal: ctrl.signal, headers: { 'User-Agent': AGENT } });
      if (!res.ok) throw new Error(`meteoalarm ${res.status}`);
      const body = (await res.json()) as { warnings?: unknown[] };
      if (!Array.isArray(body.warnings)) throw new Error('meteoalarm: no warnings list');
      rows = body.warnings;
      maHeld.set(country, { at: Date.now(), rows });
    } finally {
      clearTimeout(timer);
    }
  }
  return parseMeteoAlarm(rows, lat, lon, towns.get(key(lat, lon)) ?? null);
}

/*
 * Brazil.
 *
 * INMET, Brazil's national weather institute, publishes its warnings in the Common Alerting Protocol with the
 * outline of each warning area, free and without a key. The event names are Portuguese; the common ones are
 * said in English and the rest as INMET wrote them. Its three levels, Perigo Potencial, Perigo and Grande
 * Perigo, are the CAP Moderate, Severe and Extreme.
 *
 * Source: https://apiprevmet3.inmet.gov.br/avisos/ativos (reuse permitted with the source cited)
 */
const INMET_EVENT: Record<string, string> = {
  tempestade: 'Thunderstorm', 'chuvas intensas': 'Heavy rain', 'acumulado de chuva': 'Heavy rain', vendaval: 'Gale',
  'onda de calor': 'Heatwave', 'baixa umidade': 'Low humidity', 'declínio de temperatura': 'Temperature drop',
  geada: 'Frost', 'ventos costeiros': 'Coastal winds', 'ressaca': 'Storm surge', 'nevoeiro': 'Fog', 'granizo': 'Hail',
};
const INMET_LEVEL: Record<string, string> = { 'perigo potencial': 'Moderate', perigo: 'Severe', 'grande perigo': 'Extreme' };
let inmetHeld: { at: number; rows: Record<string, unknown>[] } | null = null;

export function parseInmet(rows: unknown, lat: number, lon: number, now = Date.now()): Alert[] {
  if (!Array.isArray(rows)) throw new Error('inmet: not a list');
  const out = new Map<string, Alert>();
  for (const r of rows as Record<string, unknown>[]) {
    let shape: Shape | null = null;
    try {
      shape = typeof r.poligono === 'string' ? (JSON.parse(r.poligono) as Shape) : (r.poligono as Shape);
    } catch {
      shape = null;
    }
    if (!shape || !inShape(lon, lat, shape)) continue;
    const ends = Date.parse(`${String(r.data_fim ?? '').slice(0, 10)}T${String(r.hora_fim ?? '23:59')}:00-03:00`);
    if (Number.isFinite(ends) && ends < now) continue;
    const pt = String(r.descricao ?? '').trim();
    if (!pt) continue;
    const severity = INMET_LEVEL[String(r.severidade ?? '').toLowerCase()] ?? 'Moderate';
    const event = `${INMET_EVENT[pt.toLowerCase()] ?? pt} warning`;
    const prior = out.get(event);
    if (prior && RANK[prior.severity] >= RANK[severity]) continue;
    out.set(event, {
      id: `inmet:${String(r.codigo ?? r.id ?? event)}`,
      event,
      kind: classify(event),
      severity,
      urgency: 'Unknown',
      headline: `${event} from INMET`,
      instruction: 'Issued by INMET, Brazil\'s national weather institute. Follow Civil Defence (Defesa Civil) instructions.',
      areaDesc: '',
      onset: null,
      ends: Number.isFinite(ends) ? new Date(ends).toISOString() : null,
    });
  }
  return [...out.values()];
}

async function fetchFromInmet(lat: number, lon: number): Promise<Alert[]> {
  if (!inmetHeld || Date.now() - inmetHeld.at > TTL_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch('https://apiprevmet3.inmet.gov.br/avisos/ativos', { signal: ctrl.signal, headers: { 'User-Agent': AGENT } });
      if (!res.ok) throw new Error(`inmet ${res.status}`);
      const body = (await res.json()) as { hoje?: Record<string, unknown>[]; futuro?: Record<string, unknown>[] };
      if (!Array.isArray(body.hoje)) throw new Error('inmet: no list');
      inmetHeld = { at: Date.now(), rows: [...body.hoje, ...(body.futuro ?? [])] };
    } finally {
      clearTimeout(timer);
    }
  }
  return parseInmet(inmetHeld.rows, lat, lon);
}

async function fetchFromWmo(lat: number, lon: number): Promise<Alert[]> {
  const q = new URLSearchParams({
    request: 'GetFeature',
    version: '1.1.0',
    typeName: 'local_postgis:postgis_geojsons',
    outputFormat: 'json',
    propertyName: 'event,headline,description,areadesc,sent,onset,expires,capurl,s',
    // Latitude first: the server reads this point in that order.
    cql_filter: `row_type<>'POINT' AND INTERSECTS(wkb_geometry,POINT(${lat.toFixed(4)} ${lon.toFixed(4)}))`,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${WMO}?${q.toString()}`, { signal: ctrl.signal, headers: { 'User-Agent': AGENT } });
    if (!res.ok) throw new Error(`wmo ${res.status}`);
    return parseWmo(await res.json());
  } finally {
    clearTimeout(timer);
  }
}
export function seedForTest(lat: number, lon: number, alerts: Alert[], checkedAt = Date.now()): void {
  remember(key(lat, lon), { checkedAt, alerts });
}

/**
 * Which part of the body an alert speaks to.
 *
 * Deliberately generous on `power`: an ice storm, a hurricane and a blizzard are
 * different weather and the same problem for someone whose insulin needs a
 * fridge or whose oxygen needs a socket.
 */
export function classify(event: string): AlertKind {
  const e = event.toLowerCase();
  if (/heat/.test(e)) return 'heat';
  if (/cold|freeze|frost|wind chill|blizzard|winter|ice storm|snow/.test(e)) return 'cold';
  if (/air quality|smoke|dust|ozone/.test(e)) return 'air';
  if (/flood|tsunami|storm surge/.test(e)) return 'flood';
  if (/hurricane|tropical|tornado|thunderstorm|high wind|wind advisory|\bice\b|power/.test(e)) return 'power';
  return 'other';
}

/** Alerts that can take the power or the roads out, whatever else they are. */
export function cutsPower(alert: Alert): boolean {
  return alert.kind === 'power' || /ice storm|blizzard|winter storm|hurricane|tropical/i.test(alert.event);
}

async function fetchFromNws(lat: number, lon: number): Promise<Alert[]> {
  const url = `${API}?point=${lat.toFixed(4)},${lon.toFixed(4)}&status=actual`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': AGENT, Accept: 'application/geo+json' },
    });
    if (!res.ok) throw new Error(`weather.gov ${res.status}`);
    const body = (await res.json()) as { features?: { properties?: Record<string, unknown> }[] };
    return (body.features ?? []).map((f) => {
      const p = f.properties ?? {};
      const event = String(p.event ?? 'Weather alert');
      return {
        id: String(p.id ?? event),
        event,
        kind: classify(event),
        severity: String(p.severity ?? 'Unknown'),
        urgency: String(p.urgency ?? 'Unknown'),
        headline: String(p.headline ?? ''),
        instruction: p.instruction ? String(p.instruction).replace(/\s+/g, ' ').trim() : null,
        areaDesc: String(p.areaDesc ?? ''),
        onset: p.onset ? String(p.onset) : null,
        ends: p.ends ? String(p.ends) : (p.expires ? String(p.expires) : null),
      };
    });
  } finally {
    clearTimeout(timer);
  }
}

/** What is known for this place, without going anywhere. Null means never checked. */
export function current(lat: number, lon: number): Alert[] | null {
  return cache.get(key(lat, lon))?.alerts ?? null;
}

export function ageMinutes(lat: number, lon: number): number | null {
  const at = cache.get(key(lat, lon))?.checkedAt;
  return at ? Math.round((Date.now() - at) / 60000) : null;
}

export async function refresh(lat: number, lon: number, force = false): Promise<void> {
  const k = key(lat, lon);
  const held = cache.get(k);
  if (!force && held && Date.now() - held.checkedAt < TTL_MS) return;
  try {
    remember(k, { checkedAt: Date.now(), alerts: await fetcher(lat, lon) });
  } catch {
    // Keep the last good answer. A failed check is not an all clear, and with
    // nothing held the tool says it has not managed to look.
  }
}

/** The town's own name, for warnings that name areas rather than drawing them. */
const towns = new Map<string, string>();

export function watch(lat: number, lon: number, country?: string | null, town?: string | null): void {
  if (country) countries.set(key(lat, lon), country.toUpperCase());
  if (town) towns.set(key(lat, lon), town);
  void refresh(lat, lon);
}

/** Worst first: a warning outranks a watch, and sooner outranks later. */
const RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
export function rank(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0));
}

/**
 * The first sentence or two of the weather service's instruction.
 *
 * Cutting at a character count read aloud as "report flooding to local
 * enforcemen", so this cuts at sentence ends instead and says plainly when
 * there is more.
 */
export function brief(instruction: string, maxSentences = 2, maxChars = 300): string {
  const sentences = instruction.match(/[^.!?]+[.!?]+/g) ?? [instruction];
  const kept: string[] = [];
  for (const sentence of sentences.slice(0, maxSentences)) {
    if (kept.join(' ').length + sentence.length > maxChars) break;
    kept.push(sentence.trim());
  }
  if (!kept.length) kept.push(sentences[0].slice(0, maxChars).trim());
  const said = kept.join(' ');
  return sentences.length > kept.length ? `${said} There is more to it than that.` : said;
}

/** "until 8 pm" in the person's own clock, or nothing when the feed gives no end. */
export function until(alert: Alert, timeZone: string): string {
  if (!alert.ends) return '';
  const when = new Date(alert.ends);
  if (Number.isNaN(when.getTime())) return '';
  const said = when.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone });
  return ` until ${said.replace(':00', '')}`;
}
