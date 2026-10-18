/**
 * The scheduled alert check, on its own, for AWS Lambda.
 *
 * The emails a family gets without asking (a warning where somebody lives, somebody
 * living alone not heard from on a dangerous day, a home too hot to stay in, a
 * stay-inside day tomorrow) used to be checked by a timer inside the web server.
 * That timer only ran while the server did: a crash, a stuck deploy or a second copy
 * meant no email at all, or two. The check that most needs to happen is the one
 * nobody is there to notice failing.
 *
 * So EventBridge Scheduler runs this every ten minutes (infra/), on its own, reading
 * the same DynamoDB table the server writes. It reads the forecast and the warnings
 * for each place that has somebody to tell, runs the same four checks in alerts.ts,
 * and writes back what it sent before it sends it. The server stops running those
 * checks itself when SUDOR_ALERTS=scheduler.
 *
 * Only accounts are read for: the public demo never sends email, so a sandbox
 * record costs this nothing.
 */

import * as store from './store.js';
import * as weather from './weather.js';
import * as warnings from './warnings.js';
import * as impact from './impact.js';
import { canEmailFor, type Delivery } from './notify.js';
import { reachable } from './consent.js';
import { checkWarningAlerts, checkOnAlone, checkHotHome, checkColdHome, checkHotDayAlerts } from './alerts.js';

/** Places read at once. Open-Meteo and the weather services are free, and polite use keeps them that way. */
const AT_ONCE = 6;

export type SweepResult = {
  people: number;
  places: number;
  sent: Record<'warning' | 'alone' | 'hotHome' | 'coldHome' | 'hotDay', number>;
  failed: number;
  /** Refused by the SES sandbox because the address is not verified. Logged, never a failure. */
  unverified: number;
};

const sentOf = (d: Delivery[]) => d.filter((x) => x.status === 'sent').length;

export async function sweep(now = new Date()): Promise<SweepResult> {
  await store.init();
  const people = store
    .allEntries()
    .filter(([id, p]) => canEmailFor(id) && p.lat != null && p.lon != null && p.contacts.some(reachable));

  const places = new Map<string, { lat: number; lon: number; country?: string; town: string | null }>();
  for (const [, p] of people) places.set(`${p.lat!.toFixed(3)},${p.lon!.toFixed(3)}`, { lat: p.lat!, lon: p.lon!, country: p.country, town: p.locationName });
  const queue = [...places.values()];
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
      for (let q = queue.shift(); q; q = queue.shift()) {
        await Promise.allSettled([weather.readNow(q.lat, q.lon), warnings.readNow(q.lat, q.lon, q.country, q.town)]);
      }
    }),
  );

  // One after another, as the server ran them, so two checks never mark the same person at once.
  const warning = await checkWarningAlerts();
  const alone = await checkOnAlone(now);
  const hotHome = await checkHotHome(now);
  const coldHome = await checkColdHome(now);
  const hotDay = await checkHotDayAlerts(now);
  await store.flush();
  await impact.flush();
  const all = [...warning, ...alone, ...hotHome, ...coldHome, ...hotDay];
  return {
    people: people.length,
    places: places.size,
    sent: { warning: sentOf(warning), alone: sentOf(alone), hotHome: sentOf(hotHome), coldHome: sentOf(coldHome), hotDay: sentOf(hotDay) },
    failed: all.filter((d) => d.status === 'failed').length,
    unverified: all.filter((d) => d.status === 'unverified').length,
  };
}
