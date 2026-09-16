/**
 * The other half of the year.
 *
 * Cold kills about twice as many people in the United States as heat does: of
 * roughly 2,000 weather deaths a year, the CDC attributes 63 percent to cold
 * and 31 percent to heat. The same profile Sudor already holds, medicines and
 * conditions, decides cold risk too, and often through the same body systems
 * running the other way. A beta blocker that blunts the heart's response to
 * heat also blunts the heat the body makes in the cold. An antipsychotic that
 * stops sweating also blunts shivering.
 *
 * So this is not a second product. It is the same question, pointed at winter.
 *
 * Sources, in the code because a wrong number here sends someone outside:
 *   NWS wind chill chart and formula   https://www.weather.gov/safety/cold-wind-chill-chart
 *   CDC hypothermia and frostbite      https://www.cdc.gov/winter-weather/about/index.html
 *   CDC weather deaths, heat and cold  https://www.cdc.gov/nchs/data/nhsr/nhsr076.pdf
 */

export type ColdCategory = 'none' | 'chilly' | 'cold' | 'very_cold' | 'dangerous';

/**
 * The National Weather Service wind chill formula, 2001 revision.
 *
 * Only defined at 50F or below with wind above 3 mph, and it is not a "feels
 * like" guess: it is the temperature at which still air would take heat from
 * bare skin at the same rate, which is why frostbite times hang off it.
 */
export function windChillF(tempF: number, windMph: number): number {
  if (tempF > 50 || windMph <= 3) return tempF;
  const v = Math.pow(windMph, 0.16);
  // Returned unrounded on purpose. Rounding here and again where it is spoken
  // turned 36.47 into 37, one degree off the published chart, which is exactly
  // the kind of quiet drift that makes a table look wrong to the person who
  // checks it.
  return 35.74 + 0.6215 * tempF - 35.75 * v + 0.4275 * tempF * v;
}

/**
 * How long exposed skin has before frostbite, from the NWS chart's own bands.
 * Null means the chart does not give a time, which is not the same as safe.
 */
export function frostbiteMinutes(windChill: number): number | null {
  if (windChill <= -48) return 5;
  if (windChill <= -32) return 10;
  if (windChill <= -18) return 30;
  return null;
}

/**
 * Bands for a person, not for a forecast page.
 *
 * The top band starts at 50F rather than freezing, because the people this
 * add-on is for feel it long before ice appears: cold air tightens airways in
 * asthma and COPD, and in sickle cell disease the vessels narrow and a pain
 * crisis can follow, neither of which waits for 32 degrees.
 */
export function coldCategory(feelsLikeF: number): ColdCategory {
  if (feelsLikeF > 50) return 'none';
  if (feelsLikeF > 32) return 'chilly';
  if (feelsLikeF > 15) return 'cold';
  if (feelsLikeF > -18) return 'very_cold';
  return 'dangerous';
}

export const COLD_WORDS: Record<ColdCategory, string> = {
  none: 'not a cold concern',
  chilly: 'chilly',
  cold: 'cold',
  very_cold: 'very cold',
  dangerous: 'dangerously cold',
};

/** What the number means out loud, with the frostbite time when the chart gives one. */
export function coldMeaning(feelsLikeF: number): string {
  const minutes = frostbiteMinutes(feelsLikeF);
  if (minutes) return `Frostbite on bare skin in about ${minutes} minutes at this wind chill.`;
  const category = coldCategory(feelsLikeF);
  if (category === 'cold') return 'Cold enough that exposed skin needs covering.';
  if (category === 'chilly') return 'Mild for most people, but enough to matter for some conditions.';
  return '';
}

export type ColdFirstAid = {
  id: 'hypothermia' | 'frostbite';
  /** Words a person actually uses, matched against what they describe. */
  signs: string[];
  emergency: boolean;
  say: string;
  source: string;
};

/**
 * Hypothermia first, always, for the same reason heat stroke comes first in the
 * summer half: it is the one where minutes matter and where the person
 * themselves stops being able to judge. Confusion and slurred speech in the
 * cold are not tiredness.
 */
export const COLD_FIRST_AID: ColdFirstAid[] = [
  {
    id: 'hypothermia',
    signs: [
      'confused', 'confusion', 'slurred', 'slurring', 'mumbling', 'drowsy', 'sleepy', 'exhausted',
      'stopped shivering', 'not shivering', 'fumbling', 'clumsy', 'memory', 'stiff', 'unconscious',
      'passed out', 'collapsed', 'bright red skin', 'very low energy',
    ],
    emergency: true,
    say:
      'Call 911 now. Confusion, slurred speech, fumbling hands or shivering that has stopped are signs of ' +
      'hypothermia, and the person cannot judge it themselves. While you wait: get them somewhere warm, take off ' +
      'any wet clothes, and warm the chest, neck, head and groin first with blankets or skin to skin contact. ' +
      'Warm drinks are fine if they are fully awake, never alcohol, and do not rub the arms and legs.',
    source: 'https://www.cdc.gov/winter-weather/about/index.html',
  },
  {
    id: 'frostbite',
    signs: [
      'numb', 'numbness', 'white skin', 'grey skin', 'greyish', 'waxy', 'hard skin', 'firm skin',
      'no feeling', 'fingers white', 'toes white', 'nose white', 'ears white',
    ],
    emergency: false,
    say:
      'That sounds like frostbite. Get indoors and out of wet clothes. Warm the area in warm water, not hot, ' +
      'around body temperature, and never with a fire, radiator or heating pad, because numb skin burns without ' +
      'feeling it. Do not rub it. If the skin stays white or numb after warming, or blisters, get medical help.',
    source: 'https://www.cdc.gov/winter-weather/about/index.html',
  },
];

/** Which first aid a description matches, hypothermia winning when both do. */
export function matchColdFirstAid(described: string): ColdFirstAid | null {
  const text = described.toLowerCase();
  for (const entry of COLD_FIRST_AID) {
    if (entry.signs.some((sign) => text.includes(sign))) return entry;
  }
  return null;
}
