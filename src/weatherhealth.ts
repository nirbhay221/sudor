/**
 * Weather that is a health event in itself, for the people it is one for.
 *
 * Thunderstorm asthma. A thunderstorm in grass pollen season can break pollen grains into pieces small enough
 * to reach deep into the lungs, and the gust front ahead of it sweeps them down to street level. In Melbourne
 * on 21 November 2016 that sent 476 extra people to hospital with asthma in thirty hours and ten people died;
 * 87 percent of those surveyed had hay fever and only 28 percent had diagnosed asthma. Victoria now forecasts
 * the risk every pollen season. Here, the trigger is the one this server can see anywhere: a thunderstorm in
 * the forecast for the next day, for somebody with asthma or hay fever. Where a grass pollen count exists
 * (Europe), a count under 20 grains per cubic metre stands it down; elsewhere it is said only in the months of
 * grass pollen season for that hemisphere, and said as a possibility, never as a forecast of an attack.
 *
 * Migraine and falling pressure. Studies find more headaches with low and falling barometric pressure, higher
 * humidity and rain, and the effect is modest and varies from person to person. So it is only ever said as
 * "can", to somebody who said they have migraines, when the forecast pressure falls by 6 hPa or more in a day.
 *
 * Sources:
 *   https://www.health.vic.gov.au/environmental-health/epidemic-thunderstorm-asthma-risk-forecast
 *   https://pmc.ncbi.nlm.nih.gov/articles/PMC9669468/
 */

import type { LocationSnapshot } from './weather.js';

const STORM = (code: number | undefined): boolean => code != null && code >= 95 && code <= 99;

const hourLabel = (local: string): string => {
  const h = Number(local.slice(11, 13));
  return h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`;
};

/** Grass pollen season, by hemisphere, where no count is published. */
function grassSeason(lat: number, month: number): boolean {
  return lat >= 0 ? month >= 4 && month <= 8 : month >= 10 || month <= 1;
}

export function thunderstormAsthma(snap: LocationSnapshot, who: { asthma: boolean; hayFever: boolean }, now = new Date()): string {
  if (!who.asthma && !who.hayFever) return '';
  const t = now.getTime();
  const next = snap.hourly.filter((h) => {
    const at = new Date(h.time).getTime();
    return at >= t - 3_600_000 && at <= t + 24 * 3_600_000;
  });
  const storm = next.find((h) => STORM(h.weatherCode));
  if (!storm) return '';
  const counts = next.map((h) => h.grassPollen).filter((x): x is number => typeof x === 'number');
  if (counts.length) {
    if (Math.max(...counts) < 20) return '';
  } else if (!grassSeason(snap.lat, Number(storm.local.slice(5, 7)))) {
    return '';
  }
  const when = new Date(storm.time).getTime() - t < 2 * 3_600_000 ? 'soon' : `around ${hourLabel(storm.local)}`;
  return (
    `A thunderstorm is forecast ${when}. In pollen season a storm can set off a sudden, severe asthma attack, even in ` +
    `people with hay fever and no asthma before. Be indoors with the windows shut before it arrives and while it passes, ` +
    `and keep your reliever inhaler with you.`
  );
}

export function migrainePressure(snap: LocationSnapshot, now = new Date()): string {
  const t = now.getTime();
  const next = snap.hourly.filter((h) => {
    const at = new Date(h.time).getTime();
    return at >= t && at <= t + 24 * 3_600_000 && typeof h.pressureHpa === 'number';
  });
  if (next.length < 6) return '';
  const first = next[0].pressureHpa as number;
  const lowest = Math.min(...next.map((h) => h.pressureHpa as number));
  if (first - lowest < 6) return '';
  return 'The air pressure is forecast to drop sharply in the next day, which can bring on migraines for some people. Keep your migraine medicine with you and drink steadily.';
}
