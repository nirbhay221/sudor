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
const route: Fetcher = (lat, lon) => (inUS(countries.get(key(lat, lon))) ? fetchFromNws(lat, lon) : fetchFromWmo(lat, lon));
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

export function watch(lat: number, lon: number, country?: string | null): void {
  if (country) countries.set(key(lat, lon), country.toUpperCase());
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
