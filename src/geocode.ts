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
export function splitQuery(query: string): { name: string; state: string | null; elsewhere?: boolean; country?: string } {
  const q = query.trim().replace(/\s+/g, ' ');
  if (/^\d{5}$/.test(q)) return { name: q, state: null };
  if (q.includes(',')) {
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

/** Pick the right result: the named state if one was said, otherwise the first (most prominent) US match. */
export function pickPlace(query: string, results: GeoResult[]): Place | null {
  const { state, elsewhere, country } = splitQuery(query);
  const of = (hit: GeoResult): Place => ({
    name: hit.name,
    state: (hit.country_code ?? 'US') === 'US' ? hit.admin1 ?? null : null,
    lat: hit.latitude,
    lon: hit.longitude,
    timezone: hit.timezone ?? null,
    country: hit.country_code ?? 'US',
    countryName: hit.country ?? null,
  });
  if (elsewhere) {
    // "Lyon, France", "Munich, Bavaria", "Pune, IN": the country, the region, or its two letter code.
    const want = (country ?? '').toLowerCase().replace(/^the /, '');
    const hit = results.find((r) => [r.country, r.admin1, r.country_code].some((v) => (v ?? '').toLowerCase() === want)) ??
      results.find((r) => [r.country, r.admin1].some((v) => !!v && v.toLowerCase().includes(want)));
    return hit ? of(hit) : null;
  }
  const us = results.filter((r) => !r.country_code || r.country_code === 'US');
  const hit = state ? us.find((r) => (r.admin1 ?? '').toLowerCase() === state.toLowerCase()) : us[0];
  if (hit) return of(hit);
  // Nothing in the United States by that name, and nothing else said: the most prominent place anywhere.
  return !state && results[0] ? of(results[0]) : null;
}

export async function geocode(query: string, timeoutMs = 8000): Promise<Place | null> {
  const { name, elsewhere, state } = splitQuery(query);
  if (!name) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const search = async (us: boolean): Promise<GeoResult[]> => {
    const url =
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}` +
      `&count=10&language=en&format=json${us ? '&countryCode=US' : ''}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    return ((await res.json()) as { results?: GeoResult[] }).results ?? [];
  };
  try {
    if (elsewhere) return pickPlace(query, await search(false));
    const inUS = pickPlace(query, await search(true));
    if (inUS || state) return inUS;
    return pickPlace(query, await search(false));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
