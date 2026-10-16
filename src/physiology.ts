/**
 * Where an older body stops keeping up, measured rather than assumed.
 *
 * The rest of Sudor grades people the way HeatRisk does, one heat index category apart, which its own limitations
 * call an approximation. There is now a measurement to put beside it. Wolf, Cottle, Fisher, Vecellio and Kenney
 * (Communications Earth & Environment 4:486, 2023) took 49 healthy adults aged 71 on average into a chamber and
 * raised the heat until their core temperature could no longer settle: the critical environmental limit, past
 * which heat balance cannot be kept however long they stay. They measured it at rest and during the light
 * activity of daily living, at fixed temperatures with rising humidity (warm and humid) and at fixed humidity with
 * rising temperature (hot and dry). Their table, as published:
 *
 *   Warm and humid, the humidity at which the limit is reached
 *     dry bulb   light activity   at rest
 *     34 C       62.1 %           66.5 %
 *     36 C       53.5 %           59.1 %
 *     38 C       46.1 %           53.4 %
 *     40 C       34.0 %           38.8 %
 *
 *   Hot and dry, the temperature at which it is reached, by water vapour pressure
 *     16 mmHg    40.3 C           44.1 C
 *     12 mmHg    42.9 C           46.1 C
 *
 * Between the rows this interpolates; below 34 C, where they did not test, it says nothing; drier than 12 mmHg it
 * holds the 12 mmHg temperature, which errs toward the warning. The people tested were healthy, so for someone
 * whose medicine blocks sweating the limit is lower still, and that is said, not computed.
 *   https://doi.org/10.1038/s43247-023-01159-9
 */

export type Activity = 'rest' | 'light';

const HUMID: { c: number; light: number; rest: number }[] = [
  { c: 34, light: 62.1, rest: 66.5 },
  { c: 36, light: 53.5, rest: 59.1 },
  { c: 38, light: 46.1, rest: 53.4 },
  { c: 40, light: 34.0, rest: 38.8 },
];
const DRY: { mmHg: number; light: number; rest: number }[] = [
  { mmHg: 16, light: 40.3, rest: 44.1 },
  { mmHg: 12, light: 42.9, rest: 46.1 },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Water vapour pressure in mmHg, from air temperature in Celsius and relative humidity. Magnus formula. */
export function vapourPressureMmHg(tempC: number, rhPct: number): number {
  const saturationHpa = 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
  return (Math.max(0, Math.min(100, rhPct)) / 100) * saturationHpa * 0.750062;
}

/** The humidity at which the limit is reached at this temperature, for 34 to 40 C. */
function humidLimit(tempC: number, activity: Activity): number | null {
  if (tempC < HUMID[0].c || tempC > HUMID[HUMID.length - 1].c) return null;
  for (let i = 0; i < HUMID.length - 1; i += 1) {
    const a = HUMID[i], b = HUMID[i + 1];
    if (tempC >= a.c && tempC <= b.c) return lerp(a[activity], b[activity], (tempC - a.c) / (b.c - a.c));
  }
  return null;
}

/** The temperature at which the limit is reached at this vapour pressure, in hot dry air. */
function dryLimit(mmHg: number, activity: Activity): number {
  if (mmHg >= DRY[0].mmHg) return DRY[0][activity];
  if (mmHg <= DRY[1].mmHg) return DRY[1][activity];
  return lerp(DRY[1][activity], DRY[0][activity], (mmHg - DRY[1].mmHg) / (DRY[0].mmHg - DRY[1].mmHg));
}

/** Whether this air is past the limit measured for healthy older adults, at rest or doing light everyday things. */
export function pastOlderLimit(tempF: number, rhPct: number, activity: Activity): boolean {
  const c = ((tempF - 32) * 5) / 9;
  if (c < HUMID[0].c) return false;
  const humid = humidLimit(c, activity);
  if (humid != null && rhPct >= humid) return true;
  return c >= dryLimit(vapourPressureMmHg(c, rhPct), activity);
}

/** The sentence, said once, for whoever it applies to. */
export function sayOlderLimit(where: 'outside' | 'indoors' | 'at_home', lowerStill: boolean): string {
  const place = where === 'indoors' ? 'sitting at rest' : 'doing light everyday things';
  return (
    `This is past the heat in which healthy people in their seventies, ${place} in a lab, could no longer keep their ` +
    `body temperature from climbing${lowerStill ? ', and your medicine makes your limit lower still' : ''}.`
  );
}
