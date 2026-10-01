/**
 * The number that knows the sun is out.
 *
 * Sudor's whole question is when somebody should go *outside*, and until now it
 * has answered with the NWS heat index. The heat index is the right tool for a
 * great many things and it is the scale the public knows, but it is computed
 * from temperature and humidity alone, and the Rothfusz regression it comes from
 * assumes a person standing in the shade with a light breeze.
 *
 * Nobody in this product is standing in the shade. That is the thing they are
 * asking whether to leave.
 *
 * WBGT, the wet bulb globe temperature, is the measure that accounts for the
 * rest of it: radiant load from direct sun, and wind. On a clear afternoon the
 * two disagree by 10 to 15 degrees Fahrenheit, and they disagree in the
 * dangerous direction, because the heat index is the lower one. For somebody
 * whose medication has taken their sweating away, being told 88 when the load on
 * their body is 100 is not a rounding error.
 *
 * It also settles a standards question. OSHA, NIOSH and the ACGIH all write
 * occupational heat limits against WBGT, not the heat index. The proposed OSHA
 * heat rule triggers at a heat index of 80F *or* a WBGT at the NIOSH
 * recommended alert limit, and its high-heat trigger at 90F *or* the
 * recommended exposure limit. A product that only knows one of those two numbers
 * can only answer half of its own rule.
 *
 * ---
 *
 * How this is computed, and how much to trust it.
 *
 * True WBGT is a measurement, taken with three physical thermometers: a dry
 * bulb, a naturally ventilated wet bulb, and a black globe. Nobody has those in
 * their garden, so it has to be estimated from ordinary weather variables, and
 * every estimate is somebody's published approximation with a stated error.
 * This file uses three, and names each one, because the alternative is a number
 * whose provenance nobody can check:
 *
 *   Dry bulb and wet bulb are not estimated at all. Open-Meteo publishes the
 *   psychrometric wet bulb directly, so that term is data.
 *
 *   Globe temperature follows Hunter and Minyard (1999), the approximation used
 *   in most open implementations, from solar radiation, air temperature and
 *   humidity.
 *
 *   Natural wet bulb follows Malchaire (1976), which adjusts the psychrometric
 *   wet bulb for radiant load and wind speed.
 *
 * The authoritative method is Liljegren et al. (2008), which solves the heat
 * balance on the globe iteratively rather than fitting a line through it. This
 * is deliberately not that. It is within about 1 to 2 degrees Celsius of it in
 * ordinary outdoor conditions, which is close enough to change a decision and
 * not close enough to certify a workplace, and `approximate: true` is on every
 * result so nothing downstream can forget.
 */

export type Wbgt = {
  /** Outdoor WBGT, in sun, Fahrenheit. */
  f: number;
  /** The same in Celsius, which is the unit every standard is written in. */
  c: number;
  /** WBGT in full shade at the same temperature and humidity, Fahrenheit. */
  shadeF: number;
  /** How much the sun is adding, Fahrenheit. This is the part heat index misses. */
  sunAddsF: number;
  /** Always true. This is an estimate from weather variables, not a measurement. */
  approximate: boolean;
};

const toC = (f: number) => ((f - 32) * 5) / 9;
const toF = (c: number) => (c * 9) / 5 + 32;
/** Miles per hour to metres per second; the published formulas use m/s. */
const mphToMs = (mph: number) => mph * 0.44704;

/**
 * Black globe temperature, Celsius.
 *
 * Hunter, S. and Minyard, C. (1999), "Estimating wet bulb globe temperature
 * using standard meteorological measurements". Fitted for outdoor conditions
 * with solar radiation in W/m2.
 */
export function globeC(tempC: number, humidityPct: number, solarWm2: number): number {
  // With no radiation a black globe equilibrates to the air around it, so the
  // globe term must collapse to the dry bulb after dark. The published fit does
  // not do that on its own: it is a regression over daytime observations, and
  // evaluated at zero sun it returns something several degrees off air
  // temperature, which would make a midnight reading differ between "sun" and
  // "shade" when there is no sun to be in.
  if (solarWm2 <= 0) return tempC;
  // Under load a globe runs hotter than the air, never cooler. The fit can
  // undercut that at low sun and high humidity, so the air temperature is the
  // floor, and the two meet continuously as radiation goes to zero.
  return Math.max(tempC, 0.01498 * solarWm2 + 1.184 * tempC - 0.0789 * humidityPct - 2.739);
}

/**
 * Natural wet bulb temperature, Celsius.
 *
 * Malchaire, J. (1976). The psychrometric wet bulb is what a shaded, aspirated
 * sensor reads; the natural one sits in the sun and the wind, so it runs warmer
 * under radiation and cooler under airflow.
 */
export function naturalWetBulbC(wetBulbC: number, solarWm2: number, windMs: number): number {
  return wetBulbC + 0.0021 * solarWm2 - 0.43 * windMs + 1.93;
}

/**
 * Outdoor WBGT from what Open-Meteo already returns.
 *
 * The outdoor weighting is the standard one: 70 percent natural wet bulb, 20
 * percent globe, 10 percent dry bulb. In shade, with no radiant source, the
 * globe term takes the dry bulb's share and the weighting becomes 70/30.
 */
export function wbgt(
  tempF: number,
  humidityPct: number,
  wetBulbF: number,
  solarWm2: number,
  windMph: number,
): Wbgt | null {
  if (![tempF, humidityPct, wetBulbF, solarWm2, windMph].every(Number.isFinite)) return null;

  const ta = toC(tempF);
  const tw = toC(wetBulbF);
  const solar = Math.max(0, solarWm2);
  const windMs = Math.max(0, mphToMs(windMph));

  const tg = globeC(ta, humidityPct, solar);
  const tnw = naturalWetBulbC(tw, solar, windMs);
  const outdoor = 0.7 * tnw + 0.2 * tg + 0.1 * ta;

  // Shade means no solar term anywhere, and the globe settles to air
  // temperature, which is exactly what globeC returns at zero radiation. So the
  // shade case is the same expression with the sun removed, and the two agree
  // by construction after dark rather than by coincidence.
  const tnwShade = naturalWetBulbC(tw, 0, windMs);
  const shade = 0.7 * tnwShade + 0.2 * globeC(ta, humidityPct, 0) + 0.1 * ta;

  // The globe fit can undercut the air temperature in odd corners of its range.
  // A WBGT below the wet bulb is not physical, so it is clamped rather than
  // reported, and the clamp is here rather than at the call site so every caller
  // gets the same floor.
  const floor = Math.min(ta, tw);
  const outdoorF = toF(Math.max(floor, outdoor));
  const shadeF = toF(Math.max(floor, Math.min(shade, outdoor)));

  return {
    f: Math.round(outdoorF * 10) / 10,
    c: Math.round(toC(outdoorF) * 10) / 10,
    shadeF: Math.round(shadeF * 10) / 10,
    sunAddsF: Math.round((outdoorF - shadeF) * 10) / 10,
    approximate: true,
  };
}

/**
 * The NIOSH work-rest limits, in WBGT Celsius, for an acclimatised person doing
 * light work. These are the numbers the proposed OSHA rule points at.
 *
 * Sudor's customer is not usually a worker, and is often specifically *not*
 * acclimatised and not healthy, which is the population the limits were never
 * written for. So these are used to say "you are past the line drawn for a fit
 * adult at work", which is a statement with a source behind it, rather than to
 * prescribe a work-rest cycle nobody here is following.
 */
export const NIOSH_ALERT_C = 28;
export const NIOSH_EXPOSURE_C = 30;

/**
 * What the sun is adding, said out loud, when it changes the picture.
 *
 * One rule governs the wording here, and it is the easiest thing in this file to
 * get wrong: **a WBGT and a heat index are not the same scale and must never be
 * spoken in the same breath as if they were.** A heat index of 95 is a warm
 * afternoon. A WBGT of 95 is past every occupational limit there is. Saying
 * "wet bulb globe temperature 97, against a heat index of 118" is true, reads as
 * reassuring, and is the opposite of the truth. So the raw WBGT number is never
 * offered next to the heat index, and never offered as a temperature the
 * customer can compare to the one on their phone.
 *
 * What is safe to say is the difference between sun and shade, because that is a
 * difference within one scale, and it is also the only part of this the customer
 * can act on: stand somewhere else.
 *
 * Silent unless the gap is big enough to matter, because after dark or under
 * cloud the sun term is zero and there is nothing to add.
 */
export function explain(w: Wbgt | null): string {
  if (!w) return '';

  if (w.c >= NIOSH_EXPOSURE_C) {
    return (
      'In direct sun this is past the exposure limit NIOSH sets for a healthy adult doing light work, and that ' +
      'limit was not written for someone with your risks. Shade is worth about ' +
      `${Math.round(w.sunAddsF)} degrees of it, so the shaded side of the street is most of the difference.`
    );
  }

  if (w.c >= NIOSH_ALERT_C) {
    return (
      `Direct sun adds roughly ${Math.round(w.sunAddsF)} degrees to the load on your body, enough to put you past ` +
      'the level NIOSH flags for a healthy adult at work. Keep to shade where you can.'
    );
  }

  if (w.sunAddsF >= 8) {
    return `Out of the shade it is about ${Math.round(w.sunAddsF)} degrees harder on you than the forecast number suggests.`;
  }

  return '';
}
