/**
 * When the house is the cold place.
 *
 * indoor.ts asks whether a home can cool down. This asks the winter question: whether it can stay warm. In
 * Winter Storm Uri, Texas counted 246 deaths and 158 of them were hypothermia, many indoors in homes that had
 * lost power or heat (Texas DSHS, January 2022). Hypothermia indoors happens slowly, at temperatures most
 * people would call chilly rather than dangerous, which is why it is missed.
 *
 *   68 F   The National Institute on Aging: keep rooms an older adult uses at 68 to 70 or above.
 *   64 F   The WHO Housing and Health Guidelines (2018): 18 C as the safe minimum indoors in cold seasons,
 *          a strong recommendation. Excess winter deaths from cold housing: about 38,200 a year in 11
 *          European countries.
 *   60-65  The NIA: indoor temperatures of 60 to 65 can put older adults at risk of hypothermia.
 *   55 F   This project's line for anybody: a home that cold is no longer a place to sit out the night.
 *
 * Who it is harder on, in the cold: older adults, a baby or young child, dementia, heart disease, diabetes,
 * Raynaud's and sickle cell (conditions.ts), and medicines that blunt shivering or awareness of the cold
 * (cold mechanisms in meds.ts). Antipsychotic hypothermia is most likely in the first week after starting or
 * raising a dose, with advanced age and cold exposure (systematic review, Zonnenberg and others, 2017).
 *
 * Space heaters keep a lot of people warm and start a lot of fires: about 1,700 fires and 80 deaths a year by
 * the CPSC's estimate, and more than half of home heating fire deaths begin with heating equipment too close
 * to something that burns (NFPA). Portable generators account for most non-fire carbon monoxide deaths from
 * engine tools (CPSC). So whenever heat comes from something other than the house's own system, the answer
 * carries the three rules that matter: three feet clear, plugged straight into the wall, off when asleep.
 *
 * Sources:
 *   https://www.texastribune.org/2022/01/02/texas-winter-storm-final-death-toll-246
 *   https://www.ncbi.nlm.nih.gov/books/NBK535294/ (WHO Housing and Health Guidelines, low indoor temperatures)
 *   https://www.nih.gov/news-events/news-releases/hypothermia-cold-weather-hazard-seniors
 *   https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5594062/ (hypothermia due to antipsychotic medication)
 *   https://www.cpsc.gov/content/winter-warning-portable-generators-hold-top-spot-in-cpsc-report-on-carbon-monoxide-deaths
 *   https://neada.org/wp-content/uploads/2013/05/survey2004-executive_summary.pdf (LIHEAP recipients and cold homes)
 */

import type { LocationSnapshot } from './weather.js';
import { MEDICATIONS } from './meds.js';
import { coldByClass } from './rxclass.js';
import { billHelp, warmPlace } from './aid.js';

/**
 * The heating at home, as they said it. 'space_heater' is heat that comes only from a portable heater, which
 * works and carries a fire risk of its own; 'cost' is heating that works and is kept off for the bill. In a
 * survey of LIHEAP recipients, 54 percent said they would have kept their home at an unsafe temperature
 * without the help, and 21 percent became sick because it was too cold.
 */
export type Heating = 'working' | 'broken' | 'none' | 'cost' | 'power_cuts' | 'space_heater';

export const WARM_F = 68;
export const WHO_F = 64;
export const ANYBODY_F = 55;
/** A night this cold outside takes an unheated house into the danger range for anybody the cold is hard on. */
export const FREEZING_F = 32;
/** A night this cold takes an unheated house there for anybody, and freezes pipes. */
export const HARD_FREEZE_F = 20;
/** Below this outside, an unheated house drifts under 68 overnight: worth saying to somebody at risk. */
export const CHILLY_NIGHT_F = 45;
const READING_MS = 3 * 60 * 60 * 1000;

const COLD_CONDITIONS = ['older_adult', 'young_child', 'dementia', 'heart_disease', 'diabetes', 'raynauds', 'sickle_cell'];

export type ColdHome = {
  level: 'watch' | 'danger';
  line: string;
  basis: 'reported' | 'forecast';
  indoorF?: number;
  lowF?: number;
};

type Home = {
  heating?: Heating;
  indoor?: { f: number; at: string } | null;
  conditions?: string[];
  medications?: { generic: string; drugClass: string }[];
  country?: string;
};

/** Whether the cold is harder on this person than on most: by age, condition or a medicine that blunts shivering. */
export function coldVulnerable(home: Home): boolean {
  return (home.conditions ?? []).some((c) => COLD_CONDITIONS.includes(c)) || (home.medications ?? []).some((m) => (MEDICATIONS.find((x) => x.generic === m.generic)?.cold ?? coldByClass(m.drugClass)).length > 0);
}

/** What to do in a cold house, most important first, said to anybody whose heat is not coming from the house. */
const STAY_WARM =
  ' If you have to stay: one room, door shut and curtains closed, layers including a hat and socks, blankets, and warm drinks and food through the day.';
const NEVER_INDOORS = ' Never heat the house with the oven, a grill, a camp stove or a generator indoors or in the garage: that is carbon monoxide.';
export const SPACE_HEATER =
  ' With a space heater: keep it three feet from anything that can burn, plug it straight into the wall, not an extension lead, and switch it off when you sleep or leave the room. A fuel heater needs a carbon monoxide alarm.';

/** Where help with a heating bill is, in the United States. Kept for callers; the country's own line is in aid.ts. */
export const HEATING_BILL_HELP = billHelp('US', 'heating');

const without = (h: Heating | undefined): string =>
  h === 'cost' ? 'With the heating off' : h === 'broken' ? 'With your heating not working' : h === 'power_cuts' ? 'When the power cuts out' : 'With no heating';

/**
 * What the cold indoors means for this person, or null when there is nothing to say.
 *
 * A temperature they read out is believed for three hours. Otherwise, for somebody whose heating cannot be
 * relied on, the overnight low decides: an unheated house loses its warmth toward the outside through the night.
 */
export function coldHomeRisk(snap: LocationSnapshot, home: Home, now = new Date()): ColdHome | null {
  const vulnerable = coldVulnerable(home);
  const reading = home.indoor && now.getTime() - new Date(home.indoor.at).getTime() < READING_MS ? Math.round(home.indoor.f) : null;
  const heater = home.heating === 'space_heater' ? SPACE_HEATER : '';
  const bill = home.heating === 'cost' ? billHelp(home.country, 'heating') : '';
  const go = warmPlace(home.country);

  if (reading != null) {
    if (reading <= ANYBODY_F || (vulnerable && reading <= WHO_F)) {
      return {
        level: 'danger',
        basis: 'reported',
        indoorF: reading,
        line:
          `At ${reading} degrees indoors your home is too cold to stay in${vulnerable ? ' for you: hypothermia can start in an older body from 60 to 65 degrees, without you feeling it' : ''}. ` +
          `Go to a relative or friend with heat, or ${go}, today.${STAY_WARM}${NEVER_INDOORS}${heater}${bill}`,
      };
    }
    if (vulnerable && reading < WARM_F) {
      return {
        level: 'watch',
        basis: 'reported',
        indoorF: reading,
        line: `At ${reading} degrees indoors you are below the 68 degrees the National Institute on Aging advises for older adults. Warm the room you are in to 68 or more, and keep moving and eating.${heater}${bill}`,
      };
    }
    return null;
  }

  if (!home.heating || home.heating === 'working') return null;
  const t = now.getTime();
  const ahead = snap.hourly.filter((h) => {
    const at = new Date(h.time).getTime();
    return at >= t - 3_600_000 && at <= t + 24 * 3_600_000 && Number.isFinite(h.tempF);
  });
  if (ahead.length < 6) return null;
  const low = Math.round(Math.min(snap.tempF, ...ahead.map((h) => h.tempF)));

  // A space heater is heat, so the house is not judged as unheated: the fire rules are what it needs.
  if (home.heating === 'space_heater') {
    return low <= FREEZING_F ? { level: 'watch', basis: 'forecast', lowF: low, line: `It goes down to ${low} degrees tonight.${SPACE_HEATER}` } : null;
  }
  if (low <= HARD_FREEZE_F || (vulnerable && low <= FREEZING_F)) {
    return {
      level: 'danger',
      basis: 'forecast',
      lowF: low,
      line:
        `${without(home.heating)}, and ${low} degrees outside tonight, your home will get colder than is safe${vulnerable ? ' for you, past the 60 to 65 degrees where hypothermia can start in an older body' : ''}. ` +
        `Go to a relative or friend with heat, or ${go}, before dark.${STAY_WARM}${NEVER_INDOORS}` +
        (low <= HARD_FREEZE_F ? ' Let a tap drip so the pipes do not freeze.' : '') +
        bill,
    };
  }
  if (vulnerable && low <= CHILLY_NIGHT_F) {
    return {
      level: 'watch',
      basis: 'forecast',
      lowF: low,
      line: `${without(home.heating)}, the house will drop below 68 degrees overnight with ${low} degrees outside. Sleep in the warmest room with extra blankets and a hat, and have somewhere warm you can go if it gets colder.${NEVER_INDOORS}${bill}`,
    };
  }
  return null;
}

/**
 * The other half of the answer, for somebody whose heating is out on a night that is not cold. "Is it safe to
 * stay home tonight?" from an 80 year old in Minneapolis with no heating was answered with a line about going
 * outside, because coldHomeRisk had nothing to warn about and said nothing. Nothing to warn about is an answer.
 */
export function coldHomeFine(snap: LocationSnapshot, home: Home, now = new Date()): string | null {
  if (home.heating !== 'broken' && home.heating !== 'none') return null;
  if (coldHomeRisk(snap, home, now)) return null;
  const t = now.getTime();
  const ahead = snap.hourly.filter((h) => {
    const at = new Date(h.time).getTime();
    return at >= t - 3_600_000 && at <= t + 24 * 3_600_000 && Number.isFinite(h.tempF);
  });
  if (ahead.length < 6) return null;
  const low = Math.round(Math.min(snap.tempF, ...ahead.map((h) => h.tempF)));
  return (
    `${home.heating === 'broken' ? 'Your heating is not working' : 'You have no heating'}, but tonight only goes down to ${low} degrees outside, which is not cold enough to make your home unsafe by morning. ` +
    `If it feels cold indoors, tell me how warm it is inside and I will tell you what to do, and get the heating fixed before colder nights.`
  );
}

export const SOURCES = [
  'https://www.nih.gov/news-events/news-releases/hypothermia-cold-weather-hazard-seniors',
  'https://www.ncbi.nlm.nih.gov/books/NBK535294/',
];
