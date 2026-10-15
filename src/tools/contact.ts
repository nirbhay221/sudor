/**
 * Who to tell when it matters.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assess, heatIndexF, photoRisk, type HeatCategory } from '../domain.js';
import { findMedication as classifyMedication, nearMatches, MEDICATIONS, articleFor, COLD_MECHANISM_SAY, type ColdMechanism } from '../meds.js';
import { chooseOne, canAsk } from '../elicit.js';
import { CONDITIONS, findCondition } from '../conditions.js';
import { windChillF, coldCategory, coldMeaning, COLD_WORDS, matchColdFirstAid } from '../cold.js';
import { profileOf, judgeHour, planDay, planShift, precautions } from '../personal.js';
import * as wbgt from '../wbgt.js';
import { triage } from '../firstaid.js';
import { geocode } from '../geocode.js';
import { alertEmergency, alertHelp, alertSafe } from '../alerts.js';
import * as care from '../care.js';
import { emailConfigured, sendEmail, canEmailFor, toDemoPhone, DEMO_PHONE } from '../notify.js';
import { consentRequired, reachable, awaiting, newInvite, invitation, alwaysAsk, newEntry } from '../consent.js';
import * as weather from '../weather.js';
import { indoorRisk } from '../indoor.js';
import * as impact from '../impact.js';
import { perCaller } from '../budget.js';
import * as store from '../store.js';
import * as recalls from '../recalls.js';
import * as warnings from '../warnings.js';
import * as spaceweather from '../spaceweather.js';
import * as shelters from '../shelters.js';
import {
  CARD,
  andList,
  count,
  snapshotFor,
  clean,
  describeWhen,
  maskEmail,
  sameName,
  say,
} from './shared.js';

/** Guessing codes is the only way in without one, so tries are counted per account. */
const joins = perCaller(5, 5 / 60);
/**
 * A crew arrives through another server, and that server is one caller however many farms are behind it. On the
 * family limiter above, every farm in the world would have shared five tries an hour, and the twenty minute
 * refresh for each crew member would have used them up. So joining as a crew has its own, wider allowance, and
 * asking about a day is counted per link: the link is the secret, and a wrong one is simply refused.
 */
const crewJoins = perCaller(30, 2);
const crewAsks = perCaller(12, 1);

export function register(server: McpServer, personOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * Telling someone else, only once the person has said yes.
   * ---------------------------------------------------------------- */
  /*
   * One door for the people who get told.
   *
   * Adding, confirming and removing are one conversation, and the confirm step
   * is the safety property: nothing is ever emailed to anyone who has not been
   * confirmed, whichever door it came through.
   */
  server.registerTool(
    'contact',
    {
      title: 'Who to tell',
      _meta: { ui: { resourceUri: CARD } },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Manage the family members or caregivers who get emailed when it matters: if signs of heat stroke are ' +
        'described, the evening before a day that stays too hot, or both. action add stages someone and nothing is ' +
        'sent until action confirm, which the customer must say yes to first. action remove stops emailing them. Call ' +
        'this when someone says to tell, add, confirm or stop telling a family member or carer.',
      inputSchema: {
        action: z.enum(['add', 'confirm', 'remove']).describe(
          'add to stage someone, confirm after the customer says yes, remove to stop emailing them',
        ),
        name: z.string().describe('Who, e.g. "Priya", or the contactId from an earlier answer'),
        email: z.string().email().optional().describe('Their email address, required when adding'),
        relation: z.string().optional().describe('e.g. "daughter", "neighbour", "care aide"'),
        when: z
          .enum(['emergency', 'hot_day', 'both'])
          .optional()
          .describe('emergency for heat stroke signs, hot_day for stay-inside days, both by default'),
      },
    },
    async ({ action, name, email, relation, when }) => {
      const id = personOf();
      name = clean(name, 60);
      // The id an earlier answer handed back stands for the name it was given with.
      const byId = store.get(id).contacts.find((c) => c.id && c.id === name);
      if (byId) name = byId.name;

      if (action === 'add') {
        relation = relation ? clean(relation, 60) : undefined;
        if (!email) {
          // An address is the thing a microphone gets wrong most, so it is typed. See the typed entry in consent.ts.
          const reasons: store.NotifyReason[] = when === 'emergency' ? ['emergency'] : when === 'hot_day' ? ['hot_day'] : ['emergency', 'hot_day'];
          const url = newEntry(id, name, relation ?? null, reasons);
          const inner = (server as unknown as { server?: { getClientCapabilities?: () => { elicitation?: { url?: unknown } } | undefined; elicitInput?: (p: unknown) => Promise<unknown> } }).server;
          const canSendPage = /^https:/.test(url) && inner?.getClientCapabilities?.()?.elicitation?.url != null && typeof inner.elicitInput === 'function';
          if (canSendPage) {
            // Not awaited: the answer does not wait on somebody typing.
            void inner!.elicitInput!({ mode: 'url', message: `Type the email address for ${name}.`, url, elicitationId: `entry-${randomBytes(6).toString('hex')}` }).catch(() => {});
            return say(`I've put up a page to type the email address for ${name}. Tell me when it's done.`, { staged: false, needs: 'email', enterAt: url, sentPage: true });
          }
          return say(`I need an email address for ${name}. Say it, or type it on a screen if you have one.`, {
            staged: false,
            needs: 'email',
            enterAt: url,
            card: { kind: 'card', title: `Email address for ${name}`, status: { label: 'needed', tone: 'neutral' }, lines: ['Type it here, where every letter can be checked:', url] },
          });
        }
        const notifyOn: store.NotifyReason[] =
          when === 'emergency' ? ['emergency'] : when === 'hot_day' ? ['hot_day'] : ['emergency', 'hot_day'];
        const person = store.get(id);
        // Replacing somebody already on the list is not an addition.
        const replacing = person.contacts.some((c) => sameName(c.name, name) || c.email.toLowerCase() === email.toLowerCase());
        if (!replacing && person.contacts.length >= store.LIMITS.contacts) {
          return say(
            'That is as many people as I can keep on the list. Take somebody off first if you need to add another.',
            { staged: false, reason: 'limit' },
          );
        }
        const contactId = `contact-${randomBytes(5).toString('hex')}`;
        store.update(id, (p) => {
          p.contacts = p.contacts.filter((c) => !sameName(c.name, name) && c.email.toLowerCase() !== email.toLowerCase());
          p.contacts.push({
            id: contactId,
            name,
            email,
            relation: relation ?? null,
            notifyOn,
            addedAt: new Date().toISOString(),
            confirmedAt: null,
          });
        });
        const spokenEmail = person.privacy ? maskEmail(email) : email;
        return say(
          `I'll email ${name}${relation ? `, your ${relation},` : ''} at ${spokenEmail} ${describeWhen(notifyOn)}. ` +
            `Nothing is sent until you confirm. Should I add ${name}?`,
          {
            staged: true,
            name,
            contactId,
            // The step that finishes this, with the handle to do it by.
            nextAction: { tool: 'contact', arguments: { action: 'confirm', name: contactId } },
            notifyOn,
            // A commit screen: everything that saying yes will do, in full, before it is done.
            card: {
              kind: 'card',
              title: `Add ${name}?`,
              status: { label: 'not confirmed', tone: 'neutral' },
              lines: [spokenEmail, relation ?? '', `Emailed ${describeWhen(notifyOn)}.`].filter(Boolean),
              confirm: `Say yes to add ${name}. Nothing is sent until you do.`,
            },
          },
        );
      }

      if (action === 'confirm') {
        const contact = store.get(id).contacts.find((c) => sameName(c.name, name));
        if (!contact) return say(`I don't have anyone called ${name} waiting to be added. Tell me who to add first.`, { confirmed: false });
        store.update(id, (p) => {
          const c = p.contacts.find((x) => sameName(x.name, name));
          if (c && !c.confirmedAt) c.confirmedAt = new Date().toISOString();
        });
        // The account holder has said yes. Now the person who owns the address is asked, once, and nothing
        // else goes to them until they agree. See consent.ts.
        if ((consentRequired() || alwaysAsk(id)) && !contact.acceptedAt) {
          if (!canEmailFor(id)) {
            // The public demo sends no email. The invitation goes to the phone on the demo page, with the real
            // link behind its buttons, so agreeing there is the same act as agreeing from an inbox.
            const invite = newInvite();
            store.update(id, (p) => {
              const c = p.contacts.find((x) => sameName(x.name, name));
              if (c) {
                c.acceptHash = invite.hash;
                c.stopId = invite.stopId;
                c.invitedAt = new Date().toISOString();
              }
            });
            const text = invitation(contact.name, describeWhen(contact.notifyOn), invite.token).text.split('\n\n')[0];
            toDemoPhone(id, { to: contact.name, reason: 'invite', subject: 'Do you agree to get these alerts?', text, accept: invite.token });
            return say(`I've asked ${contact.name} to agree. ${DEMO_PHONE} Nothing more is sent until they say yes.`, { confirmed: true, name: contact.name, accepted: false, demo: true });
          }
          if (!emailConfigured()) {
            return say(`Noted. Email isn't switched on for this server yet, so I can't ask ${contact.name} to agree, and nothing will be sent until it is.`, { confirmed: true, name: contact.name, accepted: false, emailConfigured: false });
          }
          const askedRecently = !!contact.invitedAt && Date.now() - new Date(contact.invitedAt).getTime() < 60 * 60 * 1000;
          if (!askedRecently) {
            const invite = newInvite();
            store.update(id, (p) => {
              const c = p.contacts.find((x) => sameName(x.name, name));
              if (c) {
                c.acceptHash = invite.hash;
                c.stopId = invite.stopId;
                c.invitedAt = new Date().toISOString();
              }
            });
            void sendEmail({ to: contact.email, sender: id, reason: 'invite', ...invitation(contact.name, describeWhen(contact.notifyOn), invite.token) });
          }
          return say(
            `${askedRecently ? `I have already emailed ${contact.name} to ask if they agree.` : `Done. I've emailed ${contact.name} to ask if they agree.`} ` +
              `They will get an email ${describeWhen(contact.notifyOn)} once they say yes, and not before.`,
            { confirmed: true, name: contact.name, accepted: false, invited: true, emailConfigured: true },
          );
        }
        return say(
          `Done. ${contact.name} will get an email ${describeWhen(contact.notifyOn)}.` +
            (emailConfigured() ? '' : " Email isn't switched on for this server yet, so nothing can actually be sent until it is."),
          { confirmed: true, name: contact.name, emailConfigured: emailConfigured() },
        );
      }

      if (!store.get(id).contacts.some((c) => sameName(c.name, name))) {
        return say(`${name} isn't one of your contacts.`, { removed: false });
      }
      store.update(id, (p) => void (p.contacts = p.contacts.filter((c) => !sameName(c.name, name))));
      return say(`Removed ${name}. They won't be emailed.`, { removed: true });
    },
  );

  /* ---------------------------------------------------------------- *
   * A second person who can ask for themselves. See store.ts.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'share_my_day',
    {
      title: 'Let somebody check on your day',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Let a family member or carer ask how this person's day is looking, from their own account, without ever " +
        'hearing a medicine or a condition. Call this when someone says let my daughter check on me (invite, which ' +
        'gives a one-time code), I have a code (join), how is Mum doing today or should I check on Dad (check), or ' +
        'stop sharing (leave for the other person, stop to end it for everybody). It is not for adding somebody to be ' +
        'emailed; that is contact.',
      inputSchema: {
        action: z.enum(['invite', 'join', 'check', 'leave', 'stop']).describe('invite for the person, join with a code, check to ask how their day is looking once joined, leave to stop checking, stop to end all sharing'),
        crewLink: z.string().optional().describe('Only with check, and only for a crew service: the link it was given when it joined'),
        shiftStart: z.number().int().min(0).max(23).optional().describe('Only with check and a crew link: hour the working day starts'),
        shiftEnd: z.number().int().min(1).max(24).optional().describe('Only with check and a crew link: hour the working day ends'),
        code: z.string().optional().describe('The eight digit code, as spoken, only when joining'),
        as: z.enum(['family', 'crew']).optional().describe('crew only when another service is joining on behalf of a work crew; family otherwise'),
      },
      _meta: { ui: { resourceUri: CARD } },
    },
    async ({ action, code, as }) => {
      const id = personOf();
      if (action === 'invite') {
        if (store.get(id).lat == null) return say('Tell me where you are first, so there is a day to share.', { shared: false });
        const made = store.createInvite(id);
        const read = `${made.slice(0, 4).split('').join(' ')}, ${made.slice(4).split('').join(' ')}`;
        return say(
          `The code is ${read}. It works once and lasts a day. They link their own account, then say join with that code. ` +
            'They will hear how your day is looking, and nothing about your health.',
          {
            shared: false,
            code: made,
            card: {
              kind: 'card',
              title: 'Share your day',
              status: { label: 'code ready', tone: 'neutral' },
              lines: [`${made.slice(0, 4)} ${made.slice(4)}`, 'Works once. Lasts a day. They hear how the day is, and nothing about your health.'],
            },
          },
        );
      }
      if (action === 'join') {
        if (!(as === 'crew' ? crewJoins : joins).allow(id)) return say('Too many codes tried. Wait a while and try again.', { joined: false, reason: 'limit' });
        // A crew is another server asking for a foreman. It gets a link to keep, not an account. See store.ts.
        if (as === 'crew') {
          const linked = store.joinAsCrew(code ?? '');
          if (!linked.ok) {
            return say(linked.why === 'full' ? 'That person is already sharing with as many crews as they can.' : 'That code did not work. Codes are eight digits, work once and last a day, so ask for a new one.', { joined: false, reason: linked.why });
          }
          return say('Done. This crew can now ask how their working day looks, and nothing about their health.', { joined: true, crewLink: linked.token });
        }
        const r = store.joinWithCode(id, code ?? '');
        if (!r.ok) {
          return say(
            r.why === 'own'
              ? 'That is your own code. Read it to the person you want to share with.'
              : r.why === 'full'
                ? 'That person is already sharing with as many people as they can.'
                : 'That code did not work. Codes are eight digits, work once and last a day, so ask for a new one.',
            { joined: false, reason: r.why },
          );
        }
        return say('Done. Ask me how their day is looking, whenever you want to know.', { joined: true });
      }
      if (action === 'leave') {
        return say(store.leave(id) ? 'Done. You are no longer checking on anybody.' : 'You were not checking on anybody.', { left: true });
      }
      const n = store.stopSharing(id);
      return say(n ? `Done. ${count(n, 'person', 'people')} can no longer check on your day.` : 'Nobody else had access.', { stopped: n });
    },
  );

  server.registerTool(
    'check_on',
    {
      title: 'How is their day looking',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'For a family member or carer who has joined with a code: how the day is looking for the person they check on. ' +
        'Says whether it is a fine day, a day to take care or a day to stay in, and the best time to be out. It never ' +
        'names a medicine or a condition. Call this when someone asks how is Mum doing today, how is her day looking, ' +
        'or should I check on Dad. It is not for the customer\'s own day; that is weather_check or plan_my_day.',
      inputSchema: {
        crewLink: z.string().optional().describe('Only for a crew service: the link it was given when it joined'),
        shiftStart: z.number().int().min(0).max(23).optional().describe('Hour the working day starts, with a crew link'),
        shiftEnd: z.number().int().min(1).max(24).optional().describe('Hour the working day ends, with a crew link'),
      },
      _meta: { ui: { resourceUri: CARD } },
    },
    async ({ crewLink, shiftStart, shiftEnd }) => {
      /*
       * A crew asking. What comes back is what a foreman needs to plan the day and nothing else: how hot the
       * shift gets, when the breaks are, when it turns risky for this person, and how much of the heat they
       * should do if they are still getting used to it. Never a medicine, a condition or a reason.
       */
      if (crewLink) {
        if (!crewAsks.allow(`link:${crewLink.slice(0, 16)}`)) return say('Too many tries. Wait a while and try again.', { sharing: true, unavailable: true, reason: 'limit' });
        const who = store.personByCrewLink(crewLink);
        if (!who) return say('That crew link is not valid, or they have stopped sharing.', { sharing: false });
        const worker = store.get(who);
        const s = snapshotFor(worker);
        if (typeof s === 'string') return say("I can't see the weather where they are right now. Try again in a few minutes.", { sharing: true, unavailable: true });
        const from = shiftStart ?? 7;
        const until = shiftEnd != null && shiftEnd > from ? shiftEnd : Math.min(24, from + 10);
        const hidden = profileOf(worker.medications.flatMap((m) => [...m.mechanisms, ...(m.label?.mechanisms ?? [])]), worker.conditions, { outings: worker.outings, private: true });
        const shift = planShift(s, hidden, { now: new Date(), fromHour: from, untilHour: until, heatWork: worker.heatWork });
        const general = planShift(s, profileOf([], [], { outings: [] }), { now: new Date(), fromHour: from, untilHour: until });
        // "Earlier for them" only when it really is earlier than for anybody, and said without the reason.
        const earlier = shift.personalFrom && shift.personalFrom !== general.personalFrom ? shift.personalFrom : null;
        const parts: string[] = [];
        if (shift.peakHeatIndexF == null) parts.push('No forecast for that shift.');
        else if (!shift.initialFrom) parts.push(`Their shift peaks at heat index ${shift.peakHeatIndexF}, which is fine.`);
        else parts.push(`Their shift peaks at heat index ${shift.peakHeatIndexF} at ${shift.peakAt}.`);
        if (shift.acclimatization) parts.push(`They are on day ${shift.acclimatization.day} in the heat: ${shift.acclimatization.heatHoursAllowed} ${shift.acclimatization.heatHoursAllowed === 1 ? 'hour' : 'hours'} of it today, done by ${shift.acclimatization.doneBy}.`);
        if (earlier) parts.push(`For them the risky part starts at ${earlier}.`);
        return say(parts.join(' '), {
          sharing: true,
          crew: {
            label: shift.label,
            peakHeatIndexF: shift.peakHeatIndexF,
            peakAt: shift.peakAt,
            highFrom: shift.highFrom,
            riskyFrom: earlier,
            acclimatization: shift.acclimatization ?? null,
            timezone: s.timezone,
          },
        });
      }
      const target = store.viewedBy(personOf());
      if (!target) {
        return say('Nobody is sharing their day with you yet. They ask me for a code and read it to you, and then you join with it.', { sharing: false });
      }
      const person = store.get(target);
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say("I can't see the weather where they are right now. Try again in a few minutes.", { unavailable: true });
      // Judged with everything known about them, and described with none of it.
      const profile = profileOf(person.medications.flatMap((m) => [...m.mechanisms, ...(m.label?.mechanisms ?? [])]), person.conditions, { outings: person.outings, private: true });
      const now = judgeHour(
        { local: '', time: snap.fetchedAt, tempF: snap.tempF, humidityPct: snap.humidityPct, uvIndex: snap.uvIndex, windMph: snap.windMph, isDay: snap.isDay, aqi: snap.aqi, solarWm2: snap.solarWm2, wetBulbF: snap.wetBulbF },
        profile,
      );
      const plan = planDay(snap, profile, { now: new Date() });
      const word = now.status === 'good' ? 'a fine time for them to be outside' : now.status === 'caution' ? 'a time for them to take care outside' : 'a time for them to stay in';
      const where = person.locationName ? ` in ${person.locationName}` : '';
      const best = plan.best && plan.best.status !== 'avoid' ? ` The best time for them to be out today is ${plan.best.label}.` : plan.hours.length ? ' There is no good time for them to be out today.' : '';
      const cold = now.feelsF <= 50;
      /*
       * What the person looking after them can do today. Austrian research with family carers and live-in care
       * workers found they rarely linked the heat to their own caring that day, so a risky day is said to them
       * as things to do, not only as a status. Nothing here names a medicine or a condition: the home and the
       * day are about where they live, not their health, and a private profile keeps even the home out of it.
       *   https://www.imc.ac.at/en/about-us/media-press/news/detail/heatwaves-in-family-care-rising-temperatures-rising-challenges/
       */
      const risky = now.status !== 'good' || plan.best?.status === 'avoid';
      const vulnerable = person.medications.length > 0 || person.conditions.length > 0;
      const home = !person.privacy ? indoorRisk(snap, person, vulnerable) : null;
      const morning = new Date(Date.now() + snap.utcOffsetSeconds * 1000);
      morning.setUTCHours(6, 0, 0, 0);
      const quiet = person.livesAlone && (!person.lastSeenAt || Date.parse(person.lastSeenAt) < morning.getTime() - snap.utcOffsetSeconds * 1000);
      const carer = risky && !cold
        ? [
            home?.level === 'danger' ? 'Their home is too hot to stay in today: help them get somewhere with working cooling.' : '',
            quiet ? 'They have not spoken to me since this morning, so ring them or call round.' : 'Ring them or call round this afternoon, in the hottest part of the day.',
            'Check the room they spend the day in: above 79 degrees is past the indoor limit Health Canada gives for older adults.',
            'Make sure they drink regularly, even if they are not thirsty.',
            'If they are confused, slur their words or faint, that can be heat stroke: call 911.',
          ].filter(Boolean)
        : [];
      if (carer.length) impact.count('carerSteps', personOf());
      return say(`Right now${where} it is ${word}, feeling like ${Math.round(cold ? now.feelsF : now.heatIndexF)}.${best}${carer.length ? ` ${carer.join(' ')}` : ''}`, {
        sharing: true,
        status: now.status,
        ...(carer.length ? { forCarer: carer, ...(home?.level === 'danger' ? { homeTooHot: true } : {}) } : {}),
        best: plan.best ? { label: plan.best.label, status: plan.best.status } : null,
        card: {
          kind: 'card',
          title: person.locationName ?? 'Their day',
          status: { label: now.status === 'good' ? 'fine' : now.status === 'caution' ? 'take care' : 'stay in', tone: now.status === 'good' ? 'good' : now.status === 'avoid' ? 'bad' : 'neutral' },
          lines: [cold ? `Feels like ${Math.round(now.feelsF)}.` : `Feels like ${Math.round(now.heatIndexF)}.`, plan.best && plan.best.status !== 'avoid' ? `Best time out: ${plan.best.label}.` : 'No good time to be out today.'],
        },
      });
    },
  );

  /* ---------------------------------------------------------------- *
   * Asking for help, said out loud.
   * ---------------------------------------------------------------- */
  /*
   * Somebody whose house is at fifty degrees and who is deciding whether to drive to a shelter is alone with
   * that decision unless they stop and write to someone. This is the stopping and writing, done for them:
   * one sentence, and everybody they have confirmed knows what was said, roughly where, and where the
   * nearest shelter and emergency department are.
   *
   * What it cannot do is said every time. An add-on cannot place a phone call and cannot reach 911, and a
   * person who believes help has been called when an email has been sent is worse off than one who was told
   * nothing. So the answer leads with what was done, says plainly that 911 is theirs to call, and gives the
   * nearest emergency department so there is somewhere to go if nobody answers.
   */
  server.registerTool(
    'get_help',
    {
      title: 'Tell my family I need help',
      _meta: { ui: { resourceUri: CARD } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Tell the customer's confirmed contacts, by email and straight away, that they need help, or with status safe that they are all right: what they said, " +
        'roughly where they are, and the nearest open shelter and emergency department. Call this when someone says ' +
        'get help, call for help, tell my daughter I need help, let my family know, or asks for somebody to come, ' +
        'including while they are looking for somewhere to go. It cannot phone anyone and cannot reach 911, and the ' +
        'answer says so: read it in full. It is not for describing symptoms (use warning_signs, which also alerts ' +
        'contacts when it hears an emergency), and not for adding or removing a contact (use contact).',
      inputSchema: {
        what: z.string().optional().describe('What is wrong, in their words, e.g. "the power is out and I am cold"'),
        status: z.enum(['need_help', 'safe']).optional().describe('safe when they say tell my family I am safe, I am okay, or we made it; need_help otherwise, which is the default'),
      },
    },
    async ({ what, status }) => {
      const id = personOf();
      const person = store.get(id);
      const said = clean(what ?? '', 200);
      // The other message that matters in a disaster: I'm all right. Same people, opposite news.
      if (status === 'safe') {
        const to = person.contacts.filter(reachable);
        if (!to.length) return say('There is nobody I can tell yet. Tell me who to add, and next time I can let them know you are safe.', { told: [], reason: 'no_contacts' });
        const result = alertSafe(id, said);
        const who = andList(result.trying.length ? result.trying : to.map((c) => c.name));
        return say(
          result.demo
            ? `I'm telling ${who} you are safe. ${DEMO_PHONE}`
            : !result.configured
              ? `I can't email ${who}, because email isn't set up on this server yet.`
              : result.trying.length
                ? `I'm emailing ${who} that you are safe.`
                : `I have already emailed ${andList(result.limited)} several times this hour, so I have not sent another.`,
          { told: result.configured && !result.demo ? result.trying : [], status: 'safe', ...(result.demo ? { demo: true } : {}) },
        );
      }
      const hospital = care.sentence(person.lat, person.lon);
      const yours = 'I cannot phone anyone or reach 911 for you. If you are in danger, call 911 yourself now.';
      const confirmed = person.contacts.filter(reachable);

      if (!confirmed.length) {
        const waiting = person.contacts.filter((c) => !c.confirmedAt).map((c) => c.name);
        const asked = person.contacts.filter(awaiting).map((c) => c.name);
        const why = waiting.length
          ? `: ${andList(waiting)} ${waiting.length === 1 ? 'has' : 'have'} not been confirmed`
          : asked.length
            ? `: ${andList(asked)} ${asked.length === 1 ? 'has' : 'have'} not agreed to be emailed yet`
            : '';
        return say(
          `There is nobody I can tell yet${why}. ${yours} ` +
            `${hospital ? `${hospital} ` : ''}For somewhere warm or cool to go, call 211. ` +
            'To have somebody told next time, tell me who to add.',
          { told: [], reason: 'no_contacts', referral: { emergency: '911', local: '211' } },
        );
      }

      const sent = alertHelp(id, said);
      const names = andList(sent.trying);
      const first = sent.demo
        ? `I'm telling ${names || 'your contacts'} that you need help. ${DEMO_PHONE}`
        : !sent.configured
          ? `I can't email ${names}, because email isn't set up on this server yet.`
          : sent.trying.length
            ? `I'm emailing ${names} now that you need help${person.locationName ? ', with where you are' : ''}.`
            : `I have already emailed ${andList(sent.limited)} several times this hour, so I have not sent another.`;
      const told = sent.configured && !sent.demo ? sent.trying : [];
      // Email can sit unread for an hour. The host may be able to place a call, and this add-on cannot.
      const ring = `Email can sit unread, so ring ${confirmed[0].name} as well if you can.`;
      return say(`${first} ${yours} ${ring}${hospital ? ` ${hospital}` : ''} For somewhere warm or cool to go, call 211.`, {
        told,
        notTold: sent.limited,
        emailConfigured: sent.configured,
        ...(sent.demo ? { demo: true } : {}),
        referral: { emergency: '911', local: '211' },
        nearestEmergency: care.named(person.lat, person.lon),
        card: {
          kind: 'card',
          title: told.length ? `Told ${names}` : 'Nobody told yet',
          status: { label: told.length ? 'email sent' : 'not sent', tone: told.length ? 'neutral' : 'bad' },
          lines: ['In danger: call 911 yourself.', hospital, 'Somewhere warm or cool: call 211.'].filter(Boolean),
        },
      });
    },
  );

}
