/**
 * Turning "Phoenix, Arizona" or a zip code into coordinates.
 *
 * The first version asked Alexa+ for latitude and longitude, while telling the
 * customer to "say your city or zip". Nobody knows their coordinates, and
 * nothing turned a city into a number, so a spoken location could never work.
 *
 * Open-Meteo's geocoding API is free and needs no key, but a lookup measured
 * 740 to 1000 ms, twice Alexa+'s whole round trip budget. So the tool that
 * sets a location answers at once and this runs in the background; the next
 * question finds the place already resolved.
 *
 * The United States first, because that is where Alexa+ is sold: an unrestricted search for "Lyon" would
 * otherwise answer for France when the speaker meant Lyon, Mississippi. When a country is said ("Lyon,
 * France"), the search is worldwide and the country is matched. When nothing in the United States has that
 * name, the most prominent place elsewhere is used.
 */

export type Place = { name: string; state: string | null; lat: number; lon: number; timezone: string | null; country: string; countryName: string | null };
export type GeoResult = {
  name: string;
  admin1?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country_code?: string;
  country?: string;
  population?: number;
};

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};
const STATE_NAMES = Object.values(STATES).map((s) => s.toLowerCase());

/** "Minnesota" or "MN" to "MN". */
export function stateCode(word: string): string | null {
  const w = word.trim().toLowerCase();
  for (const [code, name] of Object.entries(STATES)) if (code.toLowerCase() === w || name.toLowerCase() === w) return code;
  return null;
}

function stateFrom(word: string): string | null {
  const w = word.trim();
  if (/^[A-Za-z]{2}$/.test(w) && STATES[w.toUpperCase()]) return STATES[w.toUpperCase()];
  const i = STATE_NAMES.indexOf(w.toLowerCase());
  return i >= 0 ? Object.values(STATES)[i] : null;
}

/** "Phoenix, AZ", "Phoenix Arizona", "Kansas City, Missouri", "85004". */
export function splitQuery(query: string): { name: string; state: string | null; elsewhere?: boolean; country?: string; region?: string } {
  const q = query.trim().replace(/\s+/g, ' ');
  if (/^\d{5}$/.test(q)) return { name: q, state: null };
  if (q.includes(',')) {
    // Town, region, country: "Toronto, Ontario, Canada", "Sorriso, Mato Grosso, Brazil". Read the last part as
    // the country and the middle as the region; all of it together named no country, so nothing was found.
    const parts = q.split(',').map((x) => x.replace(/\b(usa|us|u\.s\.a?\.?|united states( of america)?)\b/gi, '').trim()).filter(Boolean);
    if (parts.length >= 3) {
      const st = stateFrom(parts[1]) ?? stateFrom(parts[parts.length - 1]);
      if (st) return { name: parts[0], state: st };
      if (countryCodeOf(parts[parts.length - 1])) return { name: parts[0], state: null, elsewhere: true, country: parts[parts.length - 1], region: parts[1] };
    }
    const [name, ...rest] = q.split(',');
    const said = rest.join(' ').replace(/\b(usa|us|u\.s\.a?\.?|united states( of america)?)\b/gi, '').trim();
    // Something was said after the comma and it is not a state: "Lyon, France". This is a different place,
    // and must not be answered with the American town of the same name.
    return { name: name.trim(), state: stateFrom(said), ...(said && !stateFrom(said) ? { elsewhere: true, country: said } : {}) };
  }
  const words = q.split(' ');
  // Two word states first ("New York", "North Carolina"), then one word, then an
  // abbreviation. Never strip the whole query: "Washington" alone is a place name.
  for (const n of [2, 1]) {
    if (words.length > n) {
      const state = stateFrom(words.slice(-n).join(' '));
      if (state) return { name: words.slice(0, -n).join(' '), state };
    }
  }
  return { name: q, state: null };
}

/**
 * A country as people say it, to the two letter code the geocoder carries.
 *
 * Only the geocoder's own country name was matched, so "London, UK" found nothing (it says "United Kingdom"),
 * and "San Juan, Puerto Rico" found nothing because the geocoder gives Puerto Rico a code and no name.
 */
const COUNTRY_SAID: Record<string, string> = {
  uk: 'GB', britain: 'GB', 'great britain': 'GB', uae: 'AE', america: 'US',
};
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const countryName = (code?: string | null): string | null => {
  if (!code) return null;
  try {
    const n = regionNames.of(code.toUpperCase());
    return n && n !== code.toUpperCase() ? n : null;
  } catch {
    return null;
  }
};
// Retired codes share a name with today's: DD reads "Germany" and comes before DE, so "Hannover, Germany" was
// searched in East Germany and found nothing. The same for Serbia, Vietnam, Yemen, Myanmar and a few more.
const RETIRED = new Set(['AN', 'BU', 'CS', 'DD', 'DY', 'FX', 'HV', 'NH', 'RH', 'SU', 'TP', 'UK', 'VD', 'YD', 'YU', 'ZR']);
let byName: Map<string, string> | null = null;
/** "France", "Puerto Rico", "UK", "IN" to a country code, or null when it is not a country. */
export function countryCodeOf(said: string): string | null {
  const w = said.trim().toLowerCase().replace(/\./g, '').replace(/^the /, '');
  if (COUNTRY_SAID[w]) return COUNTRY_SAID[w];
  if (/^[a-z]{2}$/.test(w)) return countryName(w) ? w.toUpperCase() : null;
  if (!byName) {
    byName = new Map();
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A) for (const b of A) {
      const n = countryName(a + b);
      // The first code for a name: FX ("Metropolitan France") also reads "France".
      if (n && !RETIRED.has(a + b) && !/unknown/i.test(n) && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), a + b);
    }
  }
  return byName.get(w) ?? null;
}

/**
 * A small American town does not beat a world city of the same name. "I'm in Paris" was Paris, Texas, and "I'm in
 * Delhi" was Delhi, New York (found with the model). A US match under 100,000 people gives way to a city of a million
 * or more elsewhere, twenty times its size. Phoenix and Springfield stay American; "Lyon" stays Lyon, Mississippi,
 * because Lyon, France is under a million and "Lyon, France" finds it.
 */
export function worldCityInstead(us: GeoResult | undefined, world: GeoResult[]): GeoResult | null {
  const usPop = us?.population ?? 0;
  if (usPop >= 100_000) return null;
  const top = world.find((r) => r.country_code && r.country_code !== 'US');
  const pop = top?.population ?? 0;
  return top && pop >= 1_000_000 && pop > 20 * usPop ? top : null;
}

/** Pick the right result: the named state if one was said, otherwise the first (most prominent) US match. */
export function pickPlace(query: string, results: GeoResult[]): Place | null {
  const { state, elsewhere, country, region } = splitQuery(query);
  const of = (hit: GeoResult): Place => ({
    name: hit.name,
    state: (hit.country_code ?? 'US') === 'US' ? hit.admin1 ?? null : null,
    lat: hit.latitude,
    lon: hit.longitude,
    timezone: hit.timezone ?? null,
    country: hit.country_code ?? 'US',
    countryName: hit.country ?? countryName(hit.country_code),
  });
  if (elsewhere) {
    // "Lyon, France", "Munich, Bavaria", "Pune, IN": the country, the region, or its two letter code.
    const want = (country ?? '').toLowerCase().replace(/^the /, '');
    const code = countryCodeOf(want);
    const inRegion = region ? results.find((r) => (!code || r.country_code === code) && (r.admin1 ?? '').toLowerCase() === region.toLowerCase()) : undefined;
    const hit = inRegion ?? (code ? results.find((r) => r.country_code === code) : undefined) ??
      results.find((r) => [r.country, r.admin1, r.country_code].some((v) => (v ?? '').toLowerCase() === want)) ??
      results.find((r) => [r.country, r.admin1].some((v) => !!v && v.toLowerCase().includes(want)));
    return hit ? of(hit) : null;
  }
  const us = results.filter((r) => !r.country_code || r.country_code === 'US');
  const hit = state ? us.find((r) => (r.admin1 ?? '').toLowerCase() === state.toLowerCase()) : us[0];
  if (hit) return of(hit);
  // Nothing in the United States by that name, and nothing else said: the most prominent place anywhere.
  return !state && results[0] ? of(results[0]) : null;
}

/** The geocoder did not answer. Not the same as a place it does not know, which is null. */
export class GeocoderDown extends Error {}

/**
 * The place, or null when there is no such place. Throws GeocoderDown when the service did not answer, so a
 * timeout is never told to the person as "I couldn't find Phoenix".
 */
/*
 * A place said the way people say it, found the way the lookup below expects it. Found on 22 October 2026 by
 * saying places to the live geocoder: "near Tucson", "north of Phoenix" and "20 miles from Tucson" were not found
 * at all; "Phoenix, AZ 85004" and a street address were not found; "Minnesota" was Minnesota, Georgia and
 * "Arizona" a village in Louisiana, so somebody in Minnesota would have been judged against Georgia's heat;
 * "USA" was Concord, North Carolina; and "Wagga Wagga NSW" and "Ludhiana Punjab" were not found.
 */
const LEAD = /^(just |right |a bit |a little )?(near|by|outside( of)?|around|close to|next to|in|at|(about |some )?\d+(\.\d+)? ?(miles?|mi|km|kilometres?|kilometers?) (from|outside( of)?|out of|(north|south|east|west|northeast|northwest|southeast|southwest) of)|(north|south|east|west|northeast|northwest|southeast|southwest) of)\s+/i;
const POSTAL = /\b\d{5}(?:-\d{4})?\b|\b\d{6}\b|\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/i;
// A street word ends an English address part ("Central Ave") and starts most others ("Avenida Blumenau"); at the
// start in English it is a town ("St. Paul").
const STREET_END = /\b(rd|road|st|street|ave|avenue|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|ct|court|pl|sq|square|strasse|straße)\.?$/i;
const STREET_START = /^(avenida|av\.|rua|calle|carrer|via|rue|chemin)\s/i;
const streetLike = (part: string): boolean => /\d/.test(part) || STREET_END.test(part) || STREET_START.test(part);

/** The town and what narrows it, without the street, the postal code or "near"; and the postal code apart. */
export function simplify(query: string): { query: string; postal: string | null } {
  const q = query.trim().replace(/\s+/g, ' ').replace(LEAD, '');
  if (/^\d{5}$/.test(q)) return { query: q, postal: null };
  const postal = POSTAL.exec(q)?.[0] ?? null;
  let parts = q.split(',').map((p) => p.replace(POSTAL, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  while (parts.length > 1 && streetLike(parts[0])) parts = parts.slice(1);
  return { query: parts.join(', '), postal };
}

const PROVINCES: Record<string, string> = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB', 'newfoundland and labrador': 'NL', 'nova scotia': 'NS',
  ontario: 'ON', 'prince edward island': 'PE', quebec: 'QC', saskatchewan: 'SK',
};
/** The middle of each state and province, for somebody who names only that. A storm and a heat wave span hundreds of kilometres. */
const CENTRES: Record<string, [number, number]> = {
  AL: [32.8, -86.8], AK: [61.2, -149.9], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.5], CO: [39.0, -105.5], CT: [41.6, -72.7],
  DE: [39.0, -75.5], FL: [28.6, -82.4], GA: [32.7, -83.4], HI: [20.8, -156.3], ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3],
  IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8], MA: [42.3, -71.8],
  MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7], MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6],
  NH: [43.7, -71.6], NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8],
  OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9], SD: [44.4, -100.2], TN: [35.9, -86.4],
  TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6], WI: [44.6, -89.9],
  WY: [43.0, -107.6], DC: [38.9, -77.0],
  AB: [53.9, -116.6], BC: [50.5, -122.5], MB: [50.5, -98.0], NB: [46.6, -66.5], NL: [48.5, -56.0], NS: [45.0, -63.0], ON: [44.5, -79.5],
  PE: [46.5, -63.4], QC: [46.8, -71.5], SK: [51.5, -106.0],
};
/** A query that is only a state or a province, as its middle; null otherwise. Two letters alone are never read as a state. */
export function stateOnly(query: string): Place | null {
  const q = query.trim().replace(/\.$/, '');
  // "New York" is the city people mean, and "Washington" alone is as often the capital: both are looked up as places.
  if (q.includes(',') || /^[a-z]{2}$/i.test(q) || /^(new york|washington)$/i.test(q)) return null;
  const us = stateCode(q);
  const ca = PROVINCES[q.toLowerCase()];
  const code = us ?? ca;
  const at = code ? CENTRES[code] : undefined;
  if (!code || !at) return null;
  const name = us ? STATES[us] : Object.keys(PROVINCES).find((k) => PROVINCES[k] === ca)!.replace(/\b\w/g, (c) => c.toUpperCase());
  return { name: `central ${name}`, state: us ? STATES[us] : null, lat: at[0], lon: at[1], timezone: null, country: us ? 'US' : 'CA', countryName: us ? 'United States' : 'Canada' };
}
/** A query that is only a country: too big to judge from its middle, so the person is asked for a town. */
export function countryOnly(query: string): boolean {
  const q = query.trim().replace(/\.$/, '');
  return !q.includes(',') && !stateCode(q) && !PROVINCES[q.toLowerCase()] && (!!countryCodeOf(q) || /^(usa|u\.?s\.?a?\.?|united states( of america)?)$/i.test(q));
}
const ABROAD_SHORT: Record<string, string> = {
  NSW: 'New South Wales, Australia', QLD: 'Queensland, Australia', VIC: 'Victoria, Australia', SA: 'South Australia, Australia',
  WA: 'Western Australia, Australia', TAS: 'Tasmania, Australia', NT: 'Northern Territory, Australia',
  MT: 'Mato Grosso, Brazil', MS: 'Mato Grosso do Sul, Brazil', GO: 'Goiás, Brazil', PR: 'Paraná, Brazil', RS: 'Rio Grande do Sul, Brazil',
  MG: 'Minas Gerais, Brazil', BA: 'Bahia, Brazil', SP: 'São Paulo, Brazil', RJ: 'Rio de Janeiro, Brazil', PE: 'Pernambuco, Brazil',
};
export function abroadReading(query: string): string | null {
  const m = /^(.+?)[,\s]+([A-Za-z]{2,3})\.?$/.exec(query.trim());
  const full = m ? ABROAD_SHORT[m[2].toUpperCase()] : undefined;
  return m && full ? `${m[1].replace(/,\s*$/, '')}, ${full}` : null;
}

export async function geocode(query: string, timeoutMs = 8000): Promise<Place | null> {
  const { query: q, postal } = simplify(query);
  if (!q && postal) return geocodeOnce(postal, timeoutMs);
  if (!q) return null;
  const middle = stateOnly(q);
  if (middle) return middle;
  if (countryOnly(q)) return postal ? geocodeOnce(postal, timeoutMs) : null;
  const found = await geocodeOnce(q, timeoutMs);
  if (found) return found;
  const abroad = abroadReading(q);
  if (abroad) {
    const hit = await geocodeOnce(abroad, timeoutMs);
    if (hit) return hit;
  }
  // A region said with no comma, "Ludhiana Punjab": the last word or two as the region.
  if (!q.includes(',')) {
    const words = q.split(' ');
    for (const n of [1, 2]) {
      if (words.length <= n) continue;
      const hit = await geocodeOnce(`${words.slice(0, -n).join(' ')}, ${words.slice(-n).join(' ')}`, timeoutMs);
      if (hit) return hit;
    }
  }
  return postal ? geocodeOnce(postal, timeoutMs) : null;
}

async function geocodeOnce(query: string, timeoutMs = 8000): Promise<Place | null> {
  const { name, elsewhere, state, country } = splitQuery(query);
  if (!name) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const search = async (within: string | null): Promise<GeoResult[]> => {
    const url =
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}` +
      `&count=10&language=en&format=json${within ? `&countryCode=${within}` : ''}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch (err) {
      throw new GeocoderDown(String(err));
    }
    if (!res.ok) throw new GeocoderDown(`HTTP ${res.status}`);
    return ((await res.json()) as { results?: GeoResult[] }).results ?? [];
  };
  try {
    if (elsewhere) {
      // Within the country that was named: ten answers worldwide for "San Juan" need not hold the one meant.
      const code = countryCodeOf(country ?? '');
      return pickPlace(query, await search(code)) ?? (code ? pickPlace(query, await search(null)) : null);
    }
    const usRows = await search('US');
    const inUS = pickPlace(query, usRows);
    if (state) return inUS;
    const world = await search(null);
    if (inUS) {
      const usRow = usRows.find((r) => r.latitude === inUS.lat && r.longitude === inUS.lon);
      const instead = worldCityInstead(usRow, world);
      return instead ? pickPlace(`${instead.name}, ${instead.country ?? countryName(instead.country_code) ?? instead.country_code}`, [instead]) : inUS;
    }
    return pickPlace(query, world);
  } finally {
    clearTimeout(timer);
  }
}
