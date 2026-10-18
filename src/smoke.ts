/**
 * Smoke, from the forecast rather than only from a warning.
 *
 * A Smoke or Air Quality Alert is issued for some places and some days. The air quality forecast is there for
 * every place, every hour, on the call already being made (Open-Meteo's US AQI), so a smoky day is said to the
 * people it is dangerous for whether or not anybody issued a warning.
 *
 * Who it is harder on: the state health guidance for wildfire smoke names all children, adults 65 and over,
 * pregnant people, and people with diabetes, heart or lung conditions. For them the line is AirNow's "unhealthy
 * for sensitive groups", an AQI above 100; for everybody it is "unhealthy", above 150.
 *
 * What to do, in the order that matters: stay in with the windows shut and the air conditioning on recirculate,
 * and make one room clean with a HEPA purifier or a box fan with a filter on it. A four-filter box fan cleaner
 * (the Corsi-Rosenthal box) measured about 400 cubic feet a minute against simulated wildfire smoke in a
 * chamber test, and MERV 13 filters cleaned about 71 percent better than MERV 8. Outdoors only a well fitted N95
 * helps.
 *
 * The conflict nobody else resolves: shutting the house against smoke on a hot day is how a home without
 * cooling becomes too hot to stay in. King County's guidance is to keep the windows shut unless it gets too
 * hot, and then to open them or go to a cooled building. So for somebody without working cooling, on a hot
 * day, the heat is named as the bigger danger.
 *
 * Sources:
 *   https://www.health.mn.gov/communities/environment/emergency/docs/staysafesmoke.pdf
 *   https://kingcounty.gov/so-so/dept/dph/health-safety/safety-injury-prevention/emergency-preparedness/personal-preparedness/wildfire-smoke
 *   https://www.airnow.gov/aqi/aqi-basics/
 *   https://extension.psu.edu/box-fan-filters-provide-cleaner-indoor-air-during-smoke-events
 */

import type { LocationSnapshot } from './weather.js';

export const SENSITIVE_AQI = 101;
export const EVERYONE_AQI = 151;

/*
 * In Europe people are told the European Air Quality Index, not the American one, so a number said in Lyon has to
 * be the one on the French forecast. Open-Meteo returns it on the same call: 0 to 20 good, 20 to 40 fair, 40 to 60
 * moderate, 60 to 80 poor, 80 to 100 very poor, above 100 extremely poor. The EEA's health messages ask sensitive
 * groups (adults and children with breathing problems, adults with heart conditions) to cut down outdoors at poor,
 * and everybody at very poor, so those are the two lines here, in the same place on the scale as AirNow's 101 and 151.
 *   https://open-meteo.com/en/docs/air-quality-api
 *   https://www.eea.europa.eu/en/about/contact-us/faqs/what-do-the-air-quality-index-values-mean
 */
export const EU_SENSITIVE = 60;
export const EU_EVERYONE = 80;
const EUROPE = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB', 'NO', 'CH', 'IS', 'LI']);
export const inEurope = (country: string | null | undefined): boolean => EUROPE.has((country ?? '').toUpperCase());
/** Hot enough that a shut house without cooling becomes the danger: this project's line, the same 88 as indoor.ts. */
const HOT_SHUT_F = 88;

const SENSITIVE_CONDITIONS = ['older_adult', 'young_child', 'pregnancy', 'diabetes', 'heart_disease', 'asthma_copd'];

export const sensitiveToSmoke = (conditions: string[]): boolean => conditions.some((c) => SENSITIVE_CONDITIONS.includes(c));

export type SmokeDay = { level: 'watch' | 'danger'; peakAqi: number; at: string; line: string };

const word = (aqi: number): string => (aqi > 300 ? 'hazardous' : aqi > 200 ? 'very unhealthy' : aqi > 150 ? 'unhealthy' : 'unhealthy for sensitive groups');
const euWord = (v: number): string => (v > 100 ? 'extremely poor' : v >= 80 ? 'very poor' : 'poor');

/** An hour as it is said, from the location's own wall clock: "4 pm". The same as weatherhealth.ts. */
const hourLabel = (local: string): string => {
  const h = Number(local.slice(11, 13));
  return h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`;
};

/** What the air over the next twelve hours means for this person, or null when it is fine for them. */
export function smokeDay(snap: LocationSnapshot, person: { conditions: string[]; cooling?: string; privacy?: boolean; country?: string }, now = new Date()): SmokeDay | null {
  const eu = inEurope(person.country);
  // In Europe, the European index, when the call carried it; the American one otherwise.
  const pick = (h: { aqi: number | null; eaqi?: number | null }): number | null => (eu && h.eaqi != null ? h.eaqi : eu ? null : h.aqi);
  const t = now.getTime();
  const ahead = snap.hourly.filter((h) => {
    const at = new Date(h.time).getTime();
    const v = pick(h);
    return at >= t - 3_600_000 && at <= t + 12 * 3_600_000 && v != null && Number.isFinite(v);
  });
  const nowV = pick(snap);
  const readings = [...(nowV != null ? [{ aqi: nowV, local: 'now', tempF: snap.tempF }] : []), ...ahead.map((h) => ({ aqi: pick(h) as number, local: h.local, tempF: h.tempF }))];
  if (!readings.length) return null;
  const peak = readings.reduce((a, r) => (r.aqi > a.aqi ? r : a), readings[0]);
  const sensitive = sensitiveToSmoke(person.conditions);
  const everyone = eu ? EU_EVERYONE : EVERYONE_AQI;
  const line = sensitive ? (eu ? EU_SENSITIVE : SENSITIVE_AQI) : everyone;
  if (peak.aqi < line) return null;

  const when = peak.local === 'now' ? 'right now' : `around ${hourLabel(peak.local)}`;
  const forYou = sensitive && peak.aqi < everyone ? (person.privacy ? ', which is unhealthy for you' : ', which is unhealthy for you, though not yet for everybody') : '';
  const parts = [
    eu
      ? `The European air quality index reaches ${Math.round(peak.aqi)} ${when}, which is ${euWord(peak.aqi)}${forYou}.`
      : `The air quality index reaches ${Math.round(peak.aqi)} ${when}, ${word(peak.aqi)}${forYou}.`,
    'Stay in with the windows shut, and run the air conditioning on recirculate if you have it.',
    'Keep one room clean: a HEPA air purifier, or a box fan with a MERV 13 furnace filter taped to the back, cleans smoke well.',
    'If you have to go out, only a well fitted N95 mask helps. A cloth or surgical mask does not.',
  ];
  const hot = Math.max(snap.tempF, ...ahead.map((h) => h.tempF).filter(Number.isFinite));
  const cooled = person.cooling === 'working';
  if (!cooled && person.cooling && hot >= HOT_SHUT_F) {
    parts.push(`It also reaches ${Math.round(hot)} degrees today, and without working cooling a shut house gets dangerously hot. If the room gets too hot, the heat is the bigger danger: open the windows, or go somewhere cooled with clean air, like a library.`);
  }
  if (!person.privacy && person.conditions.includes('asthma_copd')) parts.push('Keep your reliever inhaler with you, follow your action plan, and call your doctor if your breathing gets worse.');
  if (!person.privacy && person.conditions.includes('heart_disease')) parts.push('Chest pain, a racing heart or sudden breathlessness in smoke is a reason to call 911.');
  return { level: peak.aqi >= everyone ? 'danger' : 'watch', peakAqi: Math.round(peak.aqi), at: peak.local, line: parts.join(' ') };
}
