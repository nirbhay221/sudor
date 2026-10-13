/**
 * Hot days in a row.
 *
 * Every other heat answer here is about an hour or a day. A run of hot days is its own risk: the body and the
 * house both carry heat over from one day into the next, and a second hot day starts warmer than the first did.
 * A study of older adults in New York City (JAMA Network Open, March 2026) found the risk of heat stroke and
 * death rising sharply once the daily heat index reached 90 for two days in a row, five degrees below the 95 for
 * two days at which the city declares a heat emergency. So a run of two or more days at a heat index of 90 or
 * more is named in advance for the people it was found in, older adults, and for anyone whose medicines or
 * conditions make heat riskier, before the city's own alert would.
 *
 * Today and tomorrow are judged from the hourly forecast's heat index. Later days have only the daily forecast's
 * "feels like" high, which is Open-Meteo's apparent temperature: close to the heat index in dry heat, and the
 * nearest thing the week ahead has.
 *
 * Source: https://www.usnews.com/news/health-news/articles/2026-03-23/heat-advisories-might-not-trigger-soon-enough-for-some-seniors-study-finds
 */

import { heatIndexF } from './domain.js';
import type { LocationSnapshot } from './weather.js';

export const STREAK_F = 90;

export type Run = { start: string; days: number; peakF: number };

/** Each day's highest heat index, today first, as far ahead as the forecast reaches. */
export function dailyHighs(snap: LocationSnapshot, today: string): { date: string; highF: number }[] {
  const byDay = new Map<string, number>();
  for (const h of snap.hourly) {
    const date = String(h.local ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < today || !Number.isFinite(h.tempF)) continue;
    const hi = heatIndexF(h.tempF, h.humidityPct);
    byDay.set(date, Math.max(byDay.get(date) ?? -Infinity, hi));
  }
  for (const d of snap.daily ?? []) {
    if (d.date < today || byDay.has(d.date) || !Number.isFinite(d.feelsMaxF)) continue;
    byDay.set(d.date, d.feelsMaxF);
  }
  return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, highF]) => ({ date, highF }));
}

/** The first run of two or more days in a row at a heat index of 90 or more, starting today or later. */
export function hotRun(snap: LocationSnapshot, today: string): Run | null {
  const days = dailyHighs(snap, today);
  for (let i = 0; i < days.length; i += 1) {
    if (days[i].highF < STREAK_F) continue;
    let j = i;
    while (j + 1 < days.length && days[j + 1].highF >= STREAK_F && nextDay(days[j].date) === days[j + 1].date) j += 1;
    if (j > i) return { start: days[i].date, days: j - i + 1, peakF: Math.round(Math.max(...days.slice(i, j + 1).map((d) => d.highF))) };
    i = j;
  }
  return null;
}

const nextDay = (date: string): string => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string): string => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

/**
 * One or two sentences, or an empty string when there is no run in the next few days or this person is not one
 * the finding is about. `older` is somebody 65 or over; `sensitive` is somebody whose medicines or conditions
 * make heat riskier.
 */
export function line(run: Run | null, today: string, who: { older: boolean; sensitive: boolean }): string {
  if (!run || (!who.older && !who.sensitive)) return '';
  // Only the next few days: a run a week out is a forecast to watch, not something to act on today.
  const ahead = Math.round((Date.parse(`${run.start}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (ahead > 3) return '';
  const when = ahead === 0 ? 'Today starts' : ahead === 1 ? 'Tomorrow starts' : `${weekday(run.start)} starts`;
  const why = who.older
    ? 'For people over 65 the risk climbs on the second hot day, below the level cities warn at, so keep cool and keep drinking through all of them, not only the first.'
    : 'Heat builds up over days in a row, in the house and in you, so keep cool and keep drinking through all of them, not only the first.';
  return `${when} ${run.days} days in a row that feel like ${STREAK_F} or more, up to ${run.peakF}. ${why}`;
}
