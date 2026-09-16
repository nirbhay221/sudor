/**
 * Turning today's heat and a person's own medications into a plain answer:
 * is it dangerous for you specifically, and what should you actually watch for.
 *
 * The whole product is this file, the same way Orbita's whole product is its
 * domain.ts. NOAA and the CDC both publish their half of this; nobody joins
 * "heat index 104" to "you take metoprolol and hydrochlorothiazide" and says
 * what that combination actually means for your afternoon.
 */

import type { Mechanism } from './meds.js';
import { MECHANISM_LABEL, MECHANISM_BASE } from './meds.js';

/**
 * NWS heat index, Rothfusz regression (1990), the formula behind the official
 * chart at weather.gov/safety/heat-index. Not Open-Meteo's "apparent
 * temperature": that is a different formula (the Australian AT), and mixing
 * it with NWS category thresholds would silently misclassify days near a
 * boundary. This computes the one the thresholds below were built for.
 */
export function heatIndexF(tempF: number, humidityPct: number): number {
  const T = tempF;
  const R = Math.min(100, Math.max(0, humidityPct));

  const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + R * 0.094);
  if ((simple + T) / 2 < 80) return Number(simple.toFixed(1));

  let hi =
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R;

  if (R < 13 && T >= 80 && T <= 112) {
    hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  } else if (R > 85 && T >= 80 && T <= 87) {
    hi += ((R - 85) / 10) * ((87 - T) / 5);
  }
  return Number(hi.toFixed(1));
}

export type HeatCategory = 'none' | 'caution' | 'extreme_caution' | 'danger' | 'extreme_danger';

/** NWS thresholds in Fahrenheit, from the official heat index chart. */
export function heatCategory(hi: number): HeatCategory {
  if (hi < 80) return 'none';
  if (hi < 90) return 'caution';
  if (hi < 103) return 'extreme_caution';
  if (hi < 125) return 'danger';
  return 'extreme_danger';
}

const CATEGORY_LABEL: Record<HeatCategory, string> = {
  none: 'not a heat concern',
  caution: 'caution',
  extreme_caution: 'extreme caution',
  danger: 'danger',
  extreme_danger: 'extreme danger',
};

/**
 * How much each category degree matters, so mechanisms can be ranked by how
 * much a given day actually activates them. A day of plain "caution" barely
 * moves any of these; "danger" moves all of them hard.
 */
const CATEGORY_WEIGHT: Record<HeatCategory, number> = {
  none: 0,
  caution: 1,
  extreme_caution: 2,
  danger: 3,
  extreme_danger: 4,
};

/**
 * How dangerous each mechanism is, independent of the weather, because it
 * decides which one gets named first when several apply. Reduced sweating
 * sits alone at the top: it removes the body's cooling system entirely and
 * removes the warning sign (you stop sweating before you stop feeling fine),
 * so heat stroke can arrive with no notice. Every other mechanism still lets
 * the body attempt to cool itself, or only affects awareness, not capacity.
 */
const MECHANISM_SEVERITY: Record<Mechanism, number> = {
  reduced_sweating: 5,
  increased_heat_production: 4,
  reduced_thirst_or_sedation: 3,
  electrolyte_imbalance: 3,
  increased_sweating: 2,
  photosensitivity: 0, // tracked, but this is a UV question, never a heat-index one
};

// Each entry is the CONSEQUENCE and the ACTION only. The mechanism itself is
// already stated once, by MECHANISM_LABEL, in the sentence these are spliced
// into ("your medication blocks your sweating, so ..."); repeating it here
// would say the same fact twice in one breath, which is exactly the kind of
// thing that reads fine on a screen and sounds wrong out loud.
export const GUIDANCE: Record<Exclude<Mechanism, 'photosensitivity'>, string> = {
  reduced_sweating:
    "you may not get the usual warning signs of overheating before it is serious. Don't wait to feel hot: set a timer for water and shade instead of trusting how you feel.",
  increased_heat_production:
    "on top of the day. Treat outdoor exertion like it is several degrees hotter than the forecast.",
  reduced_thirst_or_sedation:
    "you can be behind on fluids well before you feel it. Drink on a schedule, not on thirst.",
  electrolyte_imbalance:
    "and heavy sweating pushes it further in the same direction. Plain water alone is not enough today; an electrolyte drink is worth having.",
  increased_sweating:
    "which is a faster route to dehydration even though your cooling itself is working fine.",
};

export type Verdict = {
  heatIndexF: number;
  category: HeatCategory;
  /** The mechanism judged most dangerous today, or null if none of the person's
   *  medications carry a heat mechanism and today is not itself a concern. */
  binding: Mechanism | null;
  /** Every heat mechanism present across the person's medications, most severe first. */
  active: Mechanism[];
  /** True when two mechanisms compound: cannot feel thirsty AND losing fluid fast. */
  compounding: boolean;
  reason: string;
};

/**
 * Assess today's heat against one person's actual medication mechanisms.
 * `mechanisms` should already be de-duplicated across every medication they
 * take; classifying which drug produces which mechanism lives in meds.ts.
 */
export function assess(tempF: number, humidityPct: number, mechanisms: Mechanism[]): Verdict {
  const hi = heatIndexF(tempF, humidityPct);
  const category = heatCategory(hi);
  const weight = CATEGORY_WEIGHT[category];

  // Photosensitivity is a UV question, not a heat-index one; excluded here on
  // purpose so it never silently drives a heat verdict it has no bearing on.
  const active = mechanisms
    .filter((m): m is Exclude<Mechanism, 'photosensitivity'> => m !== 'photosensitivity')
    .filter((m, i, arr) => arr.indexOf(m) === i)
    .sort((a, b) => MECHANISM_SEVERITY[b] - MECHANISM_SEVERITY[a]);

  const compounding =
    active.includes('reduced_thirst_or_sedation') &&
    (active.includes('electrolyte_imbalance') || active.includes('increased_sweating'));

  if (weight === 0) {
    return {
      heatIndexF: hi,
      category,
      binding: null,
      active,
      compounding: false,
      reason: `Heat index ${hi.toFixed(0)}, ${CATEGORY_LABEL[category]}. Not hot enough today for your medications to be the deciding factor.`,
    };
  }

  if (active.length === 0) {
    return {
      heatIndexF: hi,
      category,
      binding: null,
      active,
      compounding: false,
      reason: `Heat index ${hi.toFixed(0)}, ${CATEGORY_LABEL[category]}. None of your registered medications change how you handle heat, so ordinary heat precautions apply.`,
    };
  }

  const binding = active[0];
  const others = active.slice(1);
  const compoundNote = compounding
    ? " On top of that, you won't feel thirsty while you're losing fluid, which is the combination that catches people out."
    : '';
  const othersNote =
    others.length > 0 ? ` Your medications can also ${others.map((m) => MECHANISM_BASE[m]).join(' and ')}.` : '';

  return {
    heatIndexF: hi,
    category,
    binding,
    active,
    compounding,
    reason:
      `Heat index ${hi.toFixed(0)}, ${CATEGORY_LABEL[category]}. Your medication ${MECHANISM_LABEL[binding]}, so ${GUIDANCE[binding]}${compoundNote}${othersNote}`,
  };
}

/**
 * The photosensitivity question, kept entirely separate because it answers
 * "will I burn faster", not "am I at risk of heat illness". Driven by UV
 * index, not heat index; a cool, high-UV day is exactly the case that a
 * heat-only assessment would miss.
 */
export function photoRisk(uvIndex: number, hasPhotosensitiser: boolean): { atRisk: boolean; reason: string } {
  if (!hasPhotosensitiser) {
    return { atRisk: false, reason: 'None of your medications are known to increase sun sensitivity.' };
  }
  if (uvIndex < 3) {
    return {
      atRisk: false,
      reason: `UV index ${uvIndex.toFixed(0)} is low today. Your medication can still increase sun sensitivity, but today's UV is not the concern.`,
    };
  }
  return {
    atRisk: true,
    reason: `UV index ${uvIndex.toFixed(0)}. One of your medications increases sun sensitivity, so you can burn faster and worse than usual at this UV level. Sunscreen, shade, and covering up matter more today than the temperature does.`,
  };
}
