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

import { sendText } from './texts.js';
import { emergencyNumber } from './world.js';
import * as store from './store.js';
import * as weather from './weather.js';
import { profileOf, planDay } from './personal.js';
import { sendEmail, emailConfigured, canEmailFor, withinEmailLimits, toDemoPhone, type Delivery } from './notify.js';
import * as care from './care.js';
import { reachable, stopFooter, newReplyLink } from './consent.js';
import * as warnings from './warnings.js';
import { hazardOf, forFamily } from './hazard.js';
import * as shelters from './shelters.js';

const recipients = (p: store.Person, reason: store.NotifyReason) =>
  p.contacts.filter((c) => reachable(c) && c.notifyOn.includes(reason));

/** Starts the emails and returns straight away, because a tool must answer inside the turn budget. */
export function alertEmergency(personId: string, description: string): { trying: string[]; configured: boolean; demo?: boolean } {
  const p = store.get(personId);
  const to = recipients(p, 'emergency');
  // The emergency advice itself, which is to call 911, is never withheld from a
  // sandbox. Only the email is.
  if (!canEmailFor(personId)) {
    // The public demo sends no email. The same words go to the phone on the demo page. See notify.ts.
    for (const c of to) {
      toDemoPhone(personId, {
        to: c.name,
        reason: 'emergency',
        subject: 'Heat emergency: signs of heat stroke were described',
        text: `Sudor heard signs of heat stroke described${p.locationName ? ` near ${p.locationName}` : ''}: "${description.slice(0, 200)}". They were told to call ${emergencyNumber(p.country)} straight away. Please check on them now.`,
        stop: c.stopId ?? undefined,
      });
    }
    return { trying: to.map((c) => c.name), configured: false, demo: true };
  }
  const where = p.locationName ? ` near ${p.locationName}` : '';
  for (const c of to) {
    // And a text, to anybody who added their own number. See texts.ts.
    if (c.phone) void sendText({ to: c.phone, sender: personId, reason: 'emergency', text: `Sudor: signs of heat stroke were described${where}. They were told to call ${emergencyNumber(p.country)}. Please check on them now.` });
    void sendEmail({
      to: c.email,
      sender: personId,
      reason: 'emergency',
      subject: 'Heat emergency: signs of heat stroke were described',
      text:
        `Sudor heard signs of heat stroke described${where} at ${new Date().toUTCString()}: ` +
        `"${description.slice(0, 200)}". They were told to call ${emergencyNumber(p.country)} straight away. Please check on them now.\n\n` +
        'You are getting this because you were added as an emergency contact and agreed to it.' +
        stopFooter(c),
    });
  }
  return { trying: to.map((c) => c.name), configured: emailConfigured() };
}

/**
 * The person asked for help themselves.
 *
 * Different from the emergency alert in who decides: there, the words somebody used set it off; here, they
 * said "get help" and meant it. So it goes to everybody they have confirmed, whatever each was added for,
 * and it carries what a relative needs to act without ringing back first: what was said, roughly where, the
 * nearest open shelter and the nearest emergency department, each with a link that opens directions.
 *
 * Nothing about medicines or conditions goes in it. And it is email, which is the only thing this server can
 * send: it does not ring anybody and it does not reach 911, and the spoken answer says so.
 */
export function alertHelp(personId: string, said: string): { trying: string[]; limited: string[]; configured: boolean; demo?: boolean } {
  const p = store.get(personId);
  const to = p.contacts.filter(reachable);
  const lines: string[] = [];
  lines.push(`Somebody you look after asked Sudor to get help at ${new Date().toUTCString()}${p.locationName ? `, near ${p.locationName}` : ''}.`);
  if (said) lines.push(`What they said: "${said.slice(0, 200)}".`);
  lines.push(`Please ring them now. If you cannot reach them and think they are in danger, call ${emergencyNumber(p.country)} and give their address.`);
  if (p.lat != null && p.lon != null) {
    const hospital = care.named(p.lat, p.lon);
    if (hospital) {
      const what = !hospital.measured ? 'A hospital with an emergency department in their town' : hospital.certain ? 'Nearest emergency department' : 'Nearest hospital';
      lines.push(
        `${what}: ${hospital.name}` +
          `${hospital.address ? `, ${hospital.address}` : ''}${hospital.city ? `, ${hospital.city}` : ''}` +
          `${hospital.phone ? `, ${hospital.phone}` : ''}.${hospital.link ? ` ${hospital.link}` : ''}`,
      );
    }
    const open = shelters.near(p.lat, p.lon, 60);
    if (open && open.length) {
      const s = open[0];
      lines.push(`Nearest open shelter: ${s.name}, ${s.address}, ${s.city}, ${s.state}. ${care.mapLink(s.lat, s.lon)}`);
    }
  }
  lines.push('For a warming or cooling centre near them, call 211.');
  lines.push('You are getting this because you were added as a contact and agreed to it.');
  if (!canEmailFor(personId)) {
    // The public demo sends no email. The same words, and a real link to answer with, go to the phone on the demo page.
    for (const c of to) {
      const reply = newReplyLink(personId, c.name, true);
      toDemoPhone(personId, { to: c.name, reason: 'help', subject: 'They asked for help', text: lines.join('\n\n'), reply: reply.split('r=')[1], stop: c.stopId ?? undefined });
    }
    return { trying: to.map((c) => c.name), limited: [], configured: false, demo: true };
  }
  const trying: string[] = [];
  const limited: string[] = [];
  for (const c of to) {
    // Checked here as well as in the send, so the spoken answer can say who was not told.
    if (emailConfigured() && !withinEmailLimits({ to: c.email, reason: 'help', sender: personId })) {
      limited.push(c.name);
      continue;
    }
    trying.push(c.name);
    // A way to answer, which is said to the person the next time they speak. See consent.ts.
    const reply = emailConfigured() ? newReplyLink(personId, c.name) : '';
    const answer = reply ? `\n\nTo tell them you are on your way, or ask them to ring you, open ${reply}` : '';
    if (c.phone) void sendText({ to: c.phone, sender: personId, reason: 'help', text: `Sudor: they asked for help${p.locationName ? ` near ${p.locationName}` : ''}${said ? `: "${said.slice(0, 120)}"` : ''}. Please ring them. Details are in your email.` });
    void sendEmail({ to: c.email, sender: personId, reason: 'help', subject: 'They asked for help', text: lines.join('\n\n') + answer + stopFooter(c) });
  }
  return { trying, limited, configured: emailConfigured() };
}

/** "I'm safe." The same people as a call for help, and the opposite news. Urgent, so it is never held behind ordinary mail. */
export function alertSafe(personId: string, said: string): { trying: string[]; limited: string[]; configured: boolean; demo?: boolean } {
  const p = store.get(personId);
  const to = p.contacts.filter(reachable);
  const text =
    `Somebody you look after asked Sudor to tell you they are safe, at ${new Date().toUTCString()}${p.locationName ? `, near ${p.locationName}` : ''}.` +
    (said ? `\n\nWhat they said: "${said.slice(0, 200)}".` : '') +
    '\n\nYou are getting this because you were added as a contact and agreed to it.';
  if (!canEmailFor(personId)) {
    for (const c of to) toDemoPhone(personId, { to: c.name, reason: 'safe', subject: 'They are safe', text, stop: c.stopId ?? undefined });
    return { trying: to.map((c) => c.name), limited: [], configured: false, demo: true };
  }
  const trying: string[] = [];
  const limited: string[] = [];
  for (const c of to) {
    if (emailConfigured() && !withinEmailLimits({ to: c.email, reason: 'help', sender: personId })) { limited.push(c.name); continue; }
    trying.push(c.name);
    if (c.phone) void sendText({ to: c.phone, sender: personId, reason: 'safe', text: `Sudor: they asked us to tell you they are safe${said ? `: "${said.slice(0, 120)}"` : ''}.` });
    void sendEmail({ to: c.email, sender: personId, reason: 'help', subject: 'They are safe', text: text + stopFooter(c) });
  }
  return { trying, limited, configured: emailConfigured() };
}

/**
 * A warning where somebody lives, told to their family once.
 *
 * The family of somebody under a hurricane warning usually finds out from the news, and then cannot tell
 * whether it covers their mother's street. This tells the contacts who agreed to hear about bad days, once
 * per warning, that one is in effect where she lives. Only a Warning, and only the kinds that put a person
 * in danger at home; a heat warning is already covered by the evening-before email. Nothing about health.
 */
export async function checkWarningAlerts(): Promise<Delivery[]> {
  const attempted: Delivery[] = [];
  for (const [id, p] of store.allEntries()) {
    if (!canEmailFor(id) || p.lat == null || p.lon == null) continue;
    const to = recipients(p, 'hot_day');
    if (!to.length) continue;
    const top = warnings.rank(warnings.current(p.lat, p.lon) ?? []).find((a) => /warning|emergency/i.test(a.event) && ['hurricane', 'flood', 'tornado', 'winter', 'tsunami', 'fire'].includes(hazardOf(a.event)));
    if (!top) continue;
    const key = `warning:${top.id}`.slice(0, 120);
    if (p.alertsSent.includes(key)) continue;
    store.update(id, (x) => void (x.alertsSent = [...x.alertsSent.slice(-29), key]));
    for (const c of to) {
      if (c.phone) void sendText({ to: c.phone, sender: id, reason: 'warning', text: `Sudor: ${forFamily(top, p.locationName)}` });
      attempted.push(
        await sendEmail({
          to: c.email,
          sender: id,
          reason: 'warning',
          subject: `${top.event} where they live`,
          text: `${forFamily(top, p.locationName)}\n\nSudor has told them what to do first. You are getting this because you were added as a contact and agreed to it.${stopFooter(c)}`,
        }),
      );
    }
  }
  return attempted;
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

    // Private, always. The plan's own words go into the email, and they name the reason: "with multiple
    // sclerosis", "because your medication blocks your sweating". A contact agreed to hear that tomorrow is a
    // stay-inside day. Nobody agreed to have a diagnosis sent to them.
    const profile = profileOf(p.medications.flatMap((m) => [...m.mechanisms, ...(m.label?.mechanisms ?? [])]), p.conditions, { outings: p.outings, private: true });
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
          sender: id,
          reason: 'hot_day',
          subject: `Tomorrow is a stay-inside day (${plan.date})`,
          text:
            `${plan.best.coldestFeelsF <= 50 ? 'Tomorrow stays dangerously cold' : "Tomorrow's heat stays in the risky range"} all day for the person you look after${p.locationName ? `, near ${p.locationName}` : ''}. ` +
            `Here is what Sudor will tell them: ${plan.spoken}\n\n` +
            (!p.privacy && p.cooling && p.cooling !== 'working' ? `${p.cooling === 'fan' ? 'They have told Sudor that a fan is the only cooling they have' : 'They have told Sudor the cooling at home is not working'}, so staying in may not keep them cool.\n\n` : '') +
            'You are getting this because you were added as a contact for stay-inside days and agreed to it.' +
            stopFooter(c),
        }),
      );
    }
  }
  return attempted;
}
