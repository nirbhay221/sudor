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
 *   Hot nights  Nights that stay warm stop the body recovering from the day, and in India they are warming
 *                fastest in the cities, where power cuts take out the fan and the air conditioner just when they
 *                are needed. A night that does not fall below 82F (28C) is said to anybody the heat is hard on
 *                whose cooling is not reliable, with what to do before the power goes.
 *
 * Sources:
 *   https://india.mongabay.com/2026/06/science-confirms-what-indians-experience-nights-are-now-warmer/
 *   https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11367509/ (hot nights and hospital admissions, Hong Kong)
 *   https://academic.oup.com/eurpub/article/16/6/583/587693
 *   https://www.canada.ca/en/health-canada/services/publications/healthy-living/guidance-upper-indoor-temperature-limits-protecting-older-adults.html
 *   https://www.maricopa.gov/ArchiveCenter/ViewFile/Item/6510
 *   https://www.cdc.gov/heat-health/about/index.html
 */

import type { LocationSnapshot } from './weather.js';

export type Cooling = 'working' | 'broken' | 'none' | 'fan' | 'power_cuts';

export const LIMIT_F = 79;
export const AVOID_F = 88;
export const FAN_F = 90;
/** A night that does not fall below this gives the body no recovery. 28C. */
export const HOT_NIGHT_F = 82;
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
  /** What to switch on, for a host that controls the home's devices. See COOLING_ON. */
  control?: HomeControl;
};

/**
 * Switching the cooling on.
 *
 * Japan's 2026 pilot for people over 65 turns the air conditioner on by itself when the home gets too hot. An
 * add-on cannot switch anything: Alexa controls the devices, and only when the customer asks it to. So when a
 * home whose cooling works reads 79 or more inside, the answer says to turn it on and set it below 79, gives the
 * exact words that make Alexa do it, and carries the same request as data, `control`, for a host that can offer
 * to do it there and then. It is never done on the person's behalf.
 *   https://english.adnkronos.com/2026/08/13/japan-testing-new-tech-to-prevent-heatstroke-among-elderly/
 */
export type HomeControl = { device: 'air conditioner' | 'fan'; action: 'turn_on'; setBelowF?: number; say: string };
const COOLING_ON: Record<'air conditioner' | 'fan', HomeControl> = {
  'air conditioner': { device: 'air conditioner', action: 'turn_on', setBelowF: LIMIT_F, say: 'Alexa, turn on the air conditioner' },
  fan: { device: 'fan', action: 'turn_on', say: 'Alexa, turn on the fan' },
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
    // Cooling that works, and a hot room: it is off or set too high. Switch it on first. See COOLING_ON.
    const switchable = home.cooling === 'working' ? 'air conditioner' : home.cooling === 'fan' && f < FAN_F ? 'fan' : null;
    if (switchable && f >= LIMIT_F && (vulnerable || f >= AVOID_F)) {
      const control = COOLING_ON[switchable];
      return {
        level: f >= AVOID_F ? 'danger' : 'watch',
        basis: 'reported',
        indoorF: f,
        control,
        line:
          switchable === 'air conditioner'
            ? `It is ${f} degrees inside even though your air conditioning works, so it may be off or set too high. Turn it on now and set it below 79, the indoor limit Health Canada gives for older adults. If it is connected to Alexa, say: ${control.say}.` +
              (f >= AVOID_F ? ' If the room is not cooler within the hour, go somewhere with working cooling.' : '')
            : `It is ${f} degrees inside. Turn your fan on now, and sit in the coolest room. If it is on a smart plug, say: ${control.say}.` +
              (f >= AVOID_F ? ' At this heat a fan may not be enough, so if you do not feel cooler soon, go somewhere with working cooling.' : ''),
      };
    }
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
  const without = home.cooling === 'fan' ? 'With only a fan' : home.cooling === 'broken' ? 'With your cooling not working' : home.cooling === 'power_cuts' ? 'When the power cuts out' : 'With no cooling';

  // With power cuts the cooling comes and goes, so "no way to cool down" would overstate it: the night is the risk.
  if (high >= AVOID_F && low >= LIMIT_F && home.cooling !== 'power_cuts') {
    return {
      level: 'danger',
      basis: 'forecast',
      highF: high,
      overnightLowF: low,
      line: `${without}, your home has no way to cool down: it reaches ${high} outside and only falls to ${low} overnight. Do not sit this out indoors. Go somewhere with working cooling.${fanLine(home.cooling, high)}`,
    };
  }
  // A night that stays hot, for somebody whose cooling cannot be relied on through it.
  if (low >= HOT_NIGHT_F && vulnerable) {
    return {
      level: 'watch',
      basis: 'forecast',
      highF: high,
      overnightLowF: low,
      line:
        `Tonight only falls to ${low} degrees, so your body gets no chance to recover overnight. Sleep in the coolest room, ` +
        `with water and a damp cloth by the bed${home.cooling === 'power_cuts' ? ', and charge a battery fan or keep a wet sheet ready for when the power goes' : ''}. ` +
        'If you wake up confused or very weak, that is a reason to get help, not to wait for morning.',
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
