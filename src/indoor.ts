/**
 * The heat inside the house.
 *
 * Everything else in Sudor answers "should I go out?", and on the worst days its answer is "stay in". That
 * is only good advice if in is cooler than out. Maricopa County's 2025 report on heat deaths found an air
 * conditioner present in 94 percent of the homes where somebody died indoors, and not working in 72 percent
 * of those; nine in ten of the people were over fifty. So the question is not whether somebody has cooling.
 * It is whether it is working today, and Sudor did not ask.
 *
 * What is used here, and where each number comes from:
 *
 *   79 F (26 C)  Health Canada's upper indoor temperature limit to protect older adults, from trials in
 *                which strain did not rise over eight hours at 26 C and rose steadily above it.
 *   88 F (31 C)  The same guidance: sustained exposure at or above 31 C "should be avoided for
 *                heat-susceptible populations whenever possible".
 *   90 F         The CDC: use a fan only when the room is below 90, because above it a fan can raise body
 *                temperature. A 2025 trial found fans still helped older adults at 100 F in humid air and
 *                hurt in very hot dry air, so this is said as the CDC's line, not as a law of nature.
 *
 * Sudor cannot measure a room. It uses two real things and says which. If the person says what the
 * thermometer in the house reads, that number is used as it is. Otherwise the live forecast is: a home with
 * no working cooling ends the day about as hot as outside and holds that heat after dark, so the forecast
 * high and, above all, the overnight low say whether the house can cool down at all. That is a statement
 * about the weather, not a model of anybody's house, and it is worded that way.
 *
 *   Under the roof  In the 2003 French heat wave, among older people living at home, a bedroom directly
 *                under the roof went with about four times the odds of dying (odds ratio 4.05, 95 percent
 *                interval 1.50 to 10.90; Vandentorren and others, European Journal of Public Health, 2006).
 *                It is said as what that study found, with the one thing to do about it: sleep lower down.
 *
 * Sources:
 *   https://academic.oup.com/eurpub/article/16/6/583/587693
 *   https://www.canada.ca/en/health-canada/services/publications/healthy-living/guidance-upper-indoor-temperature-limits-protecting-older-adults.html
 *   https://www.maricopa.gov/ArchiveCenter/ViewFile/Item/6510
 *   https://www.cdc.gov/heat-health/about/index.html
 */

import type { LocationSnapshot } from './weather.js';

export type Cooling = 'working' | 'broken' | 'none' | 'fan';

export const LIMIT_F = 79;
export const AVOID_F = 88;
export const FAN_F = 90;
/** How long a temperature somebody read out is believed for. */
const READING_MS = 3 * 60 * 60 * 1000;

export type Indoor = {
  level: 'watch' | 'danger';
  line: string;
  /** What the judgement rests on: a number they gave, or the forecast. */
  basis: 'reported' | 'forecast';
  indoorF?: number;
  highF?: number;
  overnightLowF?: number;
  underRoof?: boolean;
};

export const SOURCES = [
  'https://www.canada.ca/en/health-canada/services/publications/healthy-living/guidance-upper-indoor-temperature-limits-protecting-older-adults.html',
  'https://www.cdc.gov/heat-health/about/index.html',
];

const fanLine = (cooling: Cooling | undefined, f: number): string =>
  cooling === 'fan' && f >= FAN_F ? ' The CDC says a fan stops helping once the room is above 90, so do not rely on it.' : '';

/**
 * What the heat indoors means for this person, or null when there is nothing to say.
 *
 * `vulnerable` is anybody the heat is harder on: older, or with a medicine or condition that counts. The
 * lower limit is theirs. The upper one is said to everybody.
 */
const UNDER_ROOF =
  ' You sleep right under the roof. In the 2003 heat wave in France, older people whose bedroom was there were about four times as likely to die, so sleep on the lowest floor you can until this passes.';

export function indoorRisk(
  snap: LocationSnapshot,
  home: { cooling?: Cooling; indoor?: { f: number; at: string } | null; topFloor?: boolean },
  vulnerable: boolean,
  now = new Date(),
): Indoor | null {
  // Sleeping under the roof is itself a reason to be counted among the people the heat is harder on.
  const found = judge(snap, home, vulnerable || home.topFloor === true, now);
  return found && home.topFloor ? { ...found, line: found.line + UNDER_ROOF, underRoof: true } : found;
}

function judge(
  snap: LocationSnapshot,
  home: { cooling?: Cooling; indoor?: { f: number; at: string } | null; topFloor?: boolean },
  vulnerable: boolean,
  now = new Date(),
): Indoor | null {
  const reading = home.indoor && now.getTime() - new Date(home.indoor.at).getTime() < READING_MS ? home.indoor.f : null;

  if (reading != null) {
    const f = Math.round(reading);
    if (f >= AVOID_F) {
      return {
        level: 'danger',
        basis: 'reported',
        indoorF: f,
        line: `At ${f} degrees indoors you are past the 88 that Health Canada says to avoid for anybody the heat is hard on. Do not stay in it: go somewhere with working cooling now.${fanLine(home.cooling, f)}`,
      };
    }
    if (f >= LIMIT_F && vulnerable) {
      return {
        level: 'watch',
        basis: 'reported',
        indoorF: f,
        line: `At ${f} degrees indoors you are above the 79 that Health Canada gives as the indoor limit for older adults. Cool one room if you can, and spend the hottest hours somewhere with working cooling.`,
      };
    }
    return null;
  }

  if (!home.cooling || home.cooling === 'working') return null;
  const t = now.getTime();
  const ahead = snap.hourly.filter((h) => {
    const at = new Date(h.time).getTime();
    return at >= t - 3_600_000 && at <= t + 24 * 3_600_000 && Number.isFinite(h.tempF);
  });
  if (ahead.length < 6) return null;
  const high = Math.round(Math.max(snap.tempF, ...ahead.map((h) => h.tempF)));
  const nights = ahead.filter((h) => !h.isDay);
  const low = Math.round(Math.min(...(nights.length ? nights : ahead).map((h) => h.tempF)));
  const without = home.cooling === 'fan' ? 'With only a fan' : home.cooling === 'broken' ? 'With your cooling not working' : 'With no cooling';

  if (high >= AVOID_F && low >= LIMIT_F) {
    return {
      level: 'danger',
      basis: 'forecast',
      highF: high,
      overnightLowF: low,
      line: `${without}, your home has no way to cool down: it reaches ${high} outside and only falls to ${low} overnight. Do not sit this out indoors. Go somewhere with working cooling.${fanLine(home.cooling, high)}`,
    };
  }
  if (high >= AVOID_F && vulnerable) {
    return {
      level: 'watch',
      basis: 'forecast',
      highF: high,
      overnightLowF: low,
      line: `${without}, staying in is not the same as staying cool: it reaches ${high} outside, and a home without cooling ends the day about that hot. It falls to ${low} overnight, so open the house up after dark, keep it shut and shaded by day, and spend the afternoon somewhere with working cooling.${fanLine(home.cooling, high)}`,
    };
  }
  return null;
}
