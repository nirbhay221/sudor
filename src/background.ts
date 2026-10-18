/**
 * Everything the server keeps doing between requests: following the weather, warnings and hospitals for
 * every place somebody lives, the feeds every answer leans on, recalls, and the alert checks when this
 * server is the one sending them. Started once, after the store has been read.
 */

import * as store from './store.js';
import * as weather from './weather.js';
import * as warnings from './warnings.js';
import * as care from './care.js';
import * as spaceweather from './spaceweather.js';
import * as shelters from './shelters.js';
import * as cooling from './cooling.js';
import * as outages from './outages.js';
import * as recalls from './recalls.js';
import * as recallsca from './recallsca.js';
import * as recallsuk from './recallsuk.js';
import * as devices from './devices.js';
import * as outlook from './outlook.js';
import { inUS } from './world.js';
import { resolveLocation } from './tools.js';
import { checkHotDayAlerts, checkWarningAlerts, checkOnAlone, checkHotHome, checkColdHome } from './alerts.js';

export function startBackground(): void {
  // Resume watching every location a restart would otherwise have forgotten, and
  // finish any spoken place lookup the restart cut off.
  for (const [id, person] of store.allEntries()) {
    if (person.lat != null && person.lon != null) {
      weather.watch(person.lat, person.lon, !id.startsWith('demo:'));
      warnings.watch(person.lat, person.lon);
      care.watch(person.lat, person.lon, person.locationName);
    }
    else if (person.locationStatus === 'locating' && person.locationName) resolveLocation(id, person.locationName);
  }

  // Official warnings, checked every ten minutes for every place anyone has
  // registered. Alerts change faster than the forecast does, and the endpoint
  // answered in about 900 ms in testing, which is twice a whole voice turn.
  const watchWarnings = () => {
    for (const [, person] of store.allEntries()) {
      if (person.lat != null && person.lon != null) warnings.watch(person.lat, person.lon);
    }
  };
  void spaceweather.start();
  void shelters.start();
  void cooling.start();
  void outages.start();

  /*
   * Who sends the emails nobody asked for in that moment. "server", the default, is these
   * timers, which only run while this process does. "scheduler" leaves them to the Lambda
   * that EventBridge Scheduler starts every ten minutes (sweep.ts, infra/), which runs
   * whether or not this server is up, and needs the DynamoDB store to see the same people.
   */
  const ALERTS_HERE = (process.env.SUDOR_ALERTS ?? 'server').toLowerCase() !== 'scheduler';
  if (!ALERTS_HERE && process.env.SUDOR_STORE?.toLowerCase() !== 'dynamodb') {
    console.error('[alerts] SUDOR_ALERTS=scheduler needs SUDOR_STORE=dynamodb, or the scheduled check cannot see anybody. Nobody will be alerted.');
  }

  const warningTimer = setInterval(() => {
    watchWarnings();
    if (!ALERTS_HERE) return;
    // And tell the family, once, when a warning starts where somebody lives. See alerts.ts.
    checkWarningAlerts().catch((err) => console.error('[alerts]', err));
    // And somebody who lives alone and has not been heard from on a dangerous day. See alerts.ts.
    checkOnAlone().catch((err) => console.error('[alerts]', err));
    // And a home too hot to stay in, whoever lives there. See alerts.ts.
    checkHotHome().catch((err) => console.error('[alerts]', err));
    // And a home too cold to stay in. See indoorcold.ts.
    checkColdHome().catch((err) => console.error('[alerts]', err));
  }, 10 * 60 * 1000);
  warningTimer.unref?.();

  // The FDA recall list, checked in the background for every medicine anyone has
  // registered. The feed updates about weekly, so six hours is already generous,
  // and it means the recall tool never waits on a network call.
  const watchRecalls = () => {
    const generics = new Set<string>();
    for (const [, person] of store.allEntries()) for (const m of person.medications) generics.add(m.generic);
    for (const generic of generics) recalls.watch(generic);
    // The same for the kinds of medical equipment people have said they rely on. See devices.ts.
    const kinds = new Set<string>();
    for (const [, person] of store.allEntries()) for (const k of person.equipment ?? []) kinds.add(k);
    for (const k of kinds) devices.watch(k);
    // Health Canada's recall list, once anybody lives in Canada. See recallsca.ts.
    if (store.allEntries().some(([, p]) => p.country === 'CA')) recallsca.start();
    if (store.allEntries().some(([, p]) => p.country === 'GB')) recallsuk.start();
    // The days ahead, for every US place somebody lives. See outlook.ts.
    for (const [, person] of store.allEntries()) if (person.lat != null && person.lon != null && (inUS(person.country) || person.country === 'MX')) outlook.watch(person.lat, person.lon);
  };
  watchRecalls();
  const recallTimer = setInterval(watchRecalls, 6 * 60 * 60 * 1000);
  recallTimer.unref?.();

  // Stay-inside day emails to confirmed contacts, checked on the same cadence as the weather.
  const alertTimer = setInterval(() => {
    if (ALERTS_HERE) checkHotDayAlerts().catch((err) => console.error('[alerts]', err));
  }, 20 * 60 * 1000);
  alertTimer.unref?.();

  /*
   * Demo records are swept once a day. A profile made by a stranger on the demo
   * page has no reason to outlive their visit, and this one holds health details.
   */
  const sweepTimer = setInterval(() => {
    const gone = store.expireDemoRecords();
    if (gone) console.log(`[store] expired ${gone} demo record${gone === 1 ? '' : 's'}`);
  }, 24 * 60 * 60 * 1000);
  sweepTimer.unref?.();
  store.expireDemoRecords();
}
