/**
 * The two moments a family member should hear something without asking.
 *
 * Emergency: someone describes signs of heat stroke. They are told to call 911
 * first, and confirmed emergency contacts are emailed straight after.
 *
 * Stay-inside day: in the evening where the person lives, if tomorrow stays in
 * the risky range for them all day, confirmed contacts are told once, so there
 * is a night to plan around it rather than a surprise at noon.
 */

import * as store from './store.js';
import * as weather from './weather.js';
import { profileOf, planDay } from './personal.js';
import { sendEmail, emailConfigured, canEmailFor, type Delivery } from './notify.js';

const recipients = (p: store.Person, reason: store.NotifyReason) =>
  p.contacts.filter((c) => c.confirmedAt && c.notifyOn.includes(reason));

/** Starts the emails and returns straight away, because a tool must answer inside the turn budget. */
export function alertEmergency(personId: string, description: string): { trying: string[]; configured: boolean; demo?: boolean } {
  const p = store.get(personId);
  const to = recipients(p, 'emergency');
  // The emergency advice itself, which is to call 911, is never withheld from a
  // sandbox. Only the email is.
  if (!canEmailFor(personId)) return { trying: to.map((c) => c.name), configured: false, demo: true };
  const where = p.locationName ? ` near ${p.locationName}` : '';
  for (const c of to) {
    void sendEmail({
      to: c.email,
      reason: 'emergency',
      subject: 'Heat emergency: signs of heat stroke were described',
      text:
        `Sudor heard signs of heat stroke described${where} at ${new Date().toUTCString()}: ` +
        `"${description.slice(0, 200)}". They were told to call 911 straight away. Please check on them now.\n\n` +
        'You are getting this because you were added as an emergency contact and it was confirmed.',
    });
  }
  return { trying: to.map((c) => c.name), configured: emailConfigured() };
}

const EVENING_HOUR = 17;

/** Checked on the same cadence as the weather. Returns what it attempted, for logs and tests. */
export async function checkHotDayAlerts(now = new Date()): Promise<Delivery[]> {
  const attempted: Delivery[] = [];
  for (const [id, p] of store.allEntries()) {
    if (!canEmailFor(id)) continue;
    const to = recipients(p, 'hot_day');
    if (!to.length || p.lat == null || p.lon == null) continue;
    const snap = weather.current(p.lat, p.lon);
    if (!snap || !snap.hourly.length || Number.isNaN(snap.tempF)) continue;

    const localHour = new Date(now.getTime() + snap.utcOffsetSeconds * 1000).getUTCHours();
    if (localHour < EVENING_HOUR) continue;

    const profile = profileOf(p.medications.flatMap((m) => m.mechanisms), p.conditions, { outings: p.outings });
    const plan = planDay(snap, profile, { now, day: 'tomorrow' });
    if (!plan.best || plan.best.status !== 'avoid') continue;

    const key = `hot_day:${plan.date}`;
    if (p.alertsSent.includes(key)) continue;
    // Marked before sending, so a slow or failing send can never turn into repeated emails.
    store.update(id, (x) => void (x.alertsSent = [...x.alertsSent.slice(-29), key]));

    for (const c of to) {
      attempted.push(
        await sendEmail({
          to: c.email,
          reason: 'hot_day',
          subject: `Tomorrow is a stay-inside day (${plan.date})`,
          text:
            `Tomorrow's heat stays in the risky range all day for the person you look after${p.locationName ? `, near ${p.locationName}` : ''}. ` +
            `Here is what Sudor will tell them: ${plan.spoken}\n\n` +
            'You are getting this because you were added as a contact for stay-inside days and it was confirmed.',
        }),
      );
    }
  }
  return attempted;
}
