/**
 * The judgement: when to go out, what to do now, the warning signs.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assess, heatIndexF, photoRisk, type HeatCategory } from '../domain.js';
import { findMedication as classifyMedication, nearMatches, MEDICATIONS, articleFor, COLD_MECHANISM_SAY, type ColdMechanism } from '../meds.js';
import { chooseOne, canAsk } from '../elicit.js';
import { CONDITIONS, findCondition } from '../conditions.js';
import { windChillF, coldCategory, coldMeaning, COLD_WORDS, matchColdFirstAid } from '../cold.js';
import { profileOf, judgeHour, planDay, planShift, precautions } from '../personal.js';
import * as wbgt from '../wbgt.js';
import { triage, asksInGeneral } from '../firstaid.js';
import { geocode } from '../geocode.js';
import { alertEmergency } from '../alerts.js';
import { emailConfigured, DEMO_PHONE } from '../notify.js';
import * as weather from '../weather.js';
import * as store from '../store.js';
import * as recalls from '../recalls.js';
import * as warnings from '../warnings.js';
import * as spaceweather from '../spaceweather.js';
import * as shelters from '../shelters.js';
import * as care from '../care.js';
import { reachable } from '../consent.js';
import {
  CARD,
  coldConditionsOf,
  coldMechanismsOf,
  coldOpening,
  UI,
  count,
  nowHour,
  profileFor,
  say,
  snapshotFor,
  settle,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  server.registerTool(
    'plan_my_day',
    {
      title: 'When is the best time to go out',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Plan a day around the heat or the cold for this customer: the best window for going out and the hours to avoid, ' +
        'from the hourly forecast, their medications and conditions. Call this when someone asks when to go out, walk ' +
        'the dog, run errands, exercise or garden, when it cools down, or to plan today or tomorrow. For somebody who ' +
        'works outside fixed hours, pass shiftStart and shiftEnd and it plans the shift and its breaks, and pass ' +
        'startedWork when they say they are new to the job or just back. For one trip that cannot wait use ' +
        'going_out_now, and for whether it is safe this moment use weather_check.',
      inputSchema: {
        activity: z.string().optional().describe('What they want to do, e.g. "a walk", "groceries", "gardening"'),
        minutes: z.number().int().min(10).max(600).optional().describe('How long it takes, in minutes, default 60'),
        day: z.enum(['today', 'tomorrow']).optional().describe('today unless they say tomorrow'),
        shiftStart: z.number().int().min(0).max(23).optional().describe('Hour an outdoor work shift starts, 0 to 23, only when they say they work fixed hours outside'),
        shiftEnd: z.number().int().min(1).max(24).optional().describe('Hour that shift ends, 1 to 24'),
        startedWork: z
          .enum(['new', 'returning', 'settled'])
          .optional()
          .describe('Only when they say it: new if they have just started working outdoors, returning if they are back after a week or more away, settled if they have been at it for weeks'),
      },
      _meta: { ui: { resourceUri: UI } },
    },
    async ({ activity, minutes, day, shiftStart, shiftEnd, startedWork }) => {
      await settle(personOf());
      const person = store.get(personOf());
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say(snap, { unavailable: true });
      const profile = profileFor(person);
      // "I started on Monday" is remembered, dated to today where they are, so tomorrow is day two without
      // being told again. See acclimatization in personal.ts.
      if (startedWork) {
        const today = new Date(Date.now() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
        store.update(personOf(), (p) => void (p.heatWork = startedWork === 'settled' ? null : { kind: startedWork, since: today }));
      }
      // Somebody who works outside is not choosing a window. See planShift.
      if (shiftStart != null && shiftEnd != null) {
        if (shiftEnd <= shiftStart) {
          return say('I can only plan a shift that starts and ends on the same day. Tell me the start and the end, like 7 in the morning to 3 in the afternoon.', { planned: false, reason: 'overnight' });
        }
        const shift = planShift(snap, profile, { now: new Date(), day, fromHour: shiftStart, untilHour: shiftEnd, heatWork: store.get(personOf()).heatWork });
        // Without the hours, and without the sentence, which is already the answer itself.
        const { hours: _hours, spoken: _spoken, ...summary } = shift;
        return say(shift.spoken, { shift: summary, place: person.locationName, timezone: snap.timezone, sources: ['https://www.osha.gov/heat-exposure/rulemaking'] });
      }
      const plan = planDay(snap, profile, { now: new Date(), day, minutes, activity });
      // A stay-inside day with nobody set to hear about it: offer the one thing that would help.
      const told = person.contacts.some((c) => reachable(c) && c.notifyOn.includes('hot_day'));
      // No good hour to be out, and a home known to have no working cooling: staying in is not the answer either,
      // so the next step is somewhere cool to go. Otherwise, somebody to be told before days like this.
      const noCooling = plan.best?.status === 'avoid' && !!person.cooling && person.cooling !== 'working';
      const offer = noCooling
        ? 'Want me to find somewhere cool you can go?'
        : plan.best?.status === 'avoid' && !told
          ? 'Want a family member told before days like this? Tell me who.'
          : '';
      return say(plan.spoken, {
        ...(offer ? { offer } : {}),
        ...(noCooling ? { nextAction: { tool: 'somewhere_to_go', arguments: {} } } : {}),
        ...plan,
        sensitivity: profile.sensitivity,
        because: profile.because,
        place: person.locationName,
        timezone: snap.timezone,
      });
    },
  );

  server.registerTool(
    'going_out_now',
    {
      title: 'I have to go out now, what should I do',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Precautions for going out right now when it cannot wait, in the heat or in the cold, tailored to this customer: their ' +
        'conditions, medications, UV and water. Call this when someone says they have to go out, have an appointment, ' +
        'must run an urgent errand, or asks what precautions to take. Pass step to hear the rest, and ' +
        'privatePrecautions when they ask for their private precautions. Use plan_my_day instead when they can choose ' +
        'when to go.',
      inputSchema: {
        step: z.number().int().min(0).optional().describe('Where to continue from; use nextStep from the last answer'),
        privatePrecautions: z.boolean().optional().describe('true when they ask for their private precautions'),
      },
    },
    async ({ step, privatePrecautions }) => {
      await settle(personOf());
      const person = store.get(personOf());
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say(snap, { unavailable: true });
      const profile = profileFor(person);

      // The cold half. This tool only knew about heat, so at five degrees it opened with "Conditions are fine
      // for you right now" and told somebody to take water. Below fifty, what matters is the wind chill, what
      // their own conditions and medicines do in the cold, and how long skin lasts.
      const chill = windChillF(snap.tempF, Number.isFinite(snap.windMph) ? snap.windMph : 0);
      const band = coldCategory(chill);
      if (band !== 'none') {
        const drugs = coldMechanismsOf(person);
        const conditions = coldConditionsOf(person);
        const show = !person.privacy || privatePrecautions === true;
        const steps: string[] = [];
        if (band === 'dangerous' || band === 'very_cold') steps.push('Keep it as short as you can, and cover every bit of skin, face and hands included.');
        const frostbite = coldMeaning(chill);
        if (frostbite) steps.push(frostbite);
        let withheld = 0;
        const personal = (line: string) => {
          if (show) steps.push(line);
          else withheld += 1;
        };
        for (const c of conditions) for (const line of c.cold?.goingOut ?? []) personal(line);
        for (const { mechanism, drugs: names } of drugs.slice(0, 2)) personal(`Your ${names.join(' and ')} matters here: ${COLD_MECHANISM_SAY[mechanism]}.`);
        steps.push('Dress in layers with a hat and gloves, and tell someone where you are going and when you will be back.');
        steps.push('Come back in if you start shivering hard. Shivering that stops on its own, confusion or slurred speech is hypothermia: call 911.');
        if (withheld) steps.push(`I have ${withheld} more that mention your health, so ask me for your private precautions when you're alone.`);

        const from = Math.max(0, Math.floor(step ?? 0));
        const read = steps.slice(from, from + 3);
        const left = steps.length - (from + read.length);
        const spoken = [
          from > 0 ? '' : coldOpening(snap.tempF, chill),
          ...read,
          left > 0 ? `I have ${left} more, ask me for the rest.` : '',
        ].filter(Boolean).join(' ');
        return say(spoken, {
          season: 'cold',
          steps,
          nextStep: left > 0 ? from + read.length : null,
          windChillF: Math.round(chill),
          category: band,
        });
      }

      const judged = judgeHour(nowHour(snap), profile);
      const result = precautions(judged, profile, step ?? 0, { includePrivate: privatePrecautions === true });
      // This is the one tool where the customer has already decided to be
      // outdoors, which is exactly the case the heat index is not written for.
      // The sun's contribution is added only on the first step, so it does not
      // repeat through the precaution list.
      const load = wbgt.wbgt(snap.tempF, snap.humidityPct, snap.wetBulbF, snap.solarWm2, snap.windMph);
      // The sun note is the last thing said, after the precautions, not squeezed in with the first two.
      const sun = result.nextStep == null ? wbgt.explain(load) : '';
      return say(sun ? `${result.spoken} ${sun}` : result.spoken, {
        ...result,
        status: judged.status,
        heatIndexF: judged.heatIndexF,
        ...(load ? { wbgt: { f: load.f, c: load.c, shadeF: load.shadeF, sunAddsF: load.sunAddsF, approximate: true } } : {}),
      });
    },
  );

  server.registerTool(
    'warning_signs',
    {
      title: 'Heat illness warning signs',
      _meta: { ui: { resourceUri: CARD } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'What to do when someone feels unwell in the heat or the cold: heat stroke and heat exhaustion in warm ' +
        'weather, hypothermia and frostbite in cold. Which one it answers follows the weather where the person is. ' +
        'Call it straight away, before asking anything, whenever someone says they feel unwell: dizzy, a headache, ' +
        'sick, weak, faint, cramps, or too hot or too cold. Pass what they describe. If it describes confusion, slurred speech, fainting or collapse, the answer tells them ' +
        'to call 911 and emails any confirmed emergency contacts: read it immediately and in full. It is for someone who ' +
        'feels unwell or asks about the signs; to record how an outing went afterwards use log_outing.',
      inputSchema: {
        symptoms: z.string().optional().describe('What the person describes, in their words'),
        lastedMinutes: z.number().int().min(0).optional().describe('How long symptoms have lasted, if said'),
      },
    },
    async ({ symptoms, lastedMinutes }) => {
      const id = personOf();
      const person = store.get(id);
      const profile = profileFor(person);

      /*
       * Which first aid, decided by the weather rather than by the words.
       *
       * "Confused" is a sign of both heat stroke and hypothermia, and the two
       * have opposite first aid. Guessing from the word alone would eventually
       * tell someone to cool down a person who is freezing. So when it is cold
       * where they are, cold first aid answers.
       */
      const snap = person.lat != null && person.lon != null ? weather.current(person.lat, person.lon) : null;
      const isCold =
        snap && !Number.isNaN(snap.tempF) && coldCategory(windChillF(snap.tempF, snap.windMph)) !== 'none';

      if (isCold) {
        const matched = matchColdFirstAid(symptoms ?? '');
        if (!matched) {
          return say(
            'In the cold, the signs to watch for are shivering that turns to confusion, slurred or mumbled speech, ' +
              'fumbling hands, or drowsiness, and skin that has gone white, grey or waxy and numb. Shivering that ' +
              'stops on its own is a bad sign, not a good one. If any of that starts, tell me what you see and I will ' +
              'say what to do.',
            { season: 'cold', level: 'information' },
          );
        }
        let spoken = matched.say;
        // Where to go, straight after what to do. Never in place of 911, which the first aid already said.
        const hospital = care.sentence(person.lat, person.lon);
        if (hospital) spoken += ` ${hospital}`;
        let contacted: { trying: string[]; configured: boolean; demo?: boolean } | null = null;
        // A question about the signs gets the same advice, and nobody is emailed that it happened. See firstaid.ts.
        const general = asksInGeneral(symptoms ?? '');
        if (matched.emergency && general) spoken = `If that is happening to somebody now: ${spoken}`;
        if (matched.emergency && !general) {
          contacted = alertEmergency(id, symptoms ?? '');
          const names = contacted.trying.join(' and ');
          if (contacted.trying.length) {
            spoken += contacted.demo
              ? ` I'm telling ${names}. ${DEMO_PHONE}`
              : contacted.configured
                ? ` I'm emailing ${names} now.`
                : ` I can't email ${names}, because email isn't set up on this server yet.`;
          }
        }
        return say(spoken, {
          season: 'cold',
          condition: matched.id,
          level: matched.emergency ? 'emergency' : 'care',
          source: matched.source,
          spoken,
          contacted,
        });
      }

      const result = triage(symptoms ?? '', profile, lastedMinutes);
      let spoken = result.spoken;
      // For the two answers that say to get medical help, say where. Cramps and general questions do not need it.
      const hospital = result.level === 'emergency' || result.level === 'urgent' ? care.sentence(person.lat, person.lon) : '';
      if (hospital) spoken += ` ${hospital}`;
      let contacted: { trying: string[]; configured: boolean; demo?: boolean } | null = null;
      // A question about the signs gets the same advice, and nobody is emailed that it happened. See firstaid.ts.
      const general = asksInGeneral(symptoms ?? '');
      if (result.level === 'emergency' && general) spoken = `If that is happening to somebody now: ${spoken}`;
      if (result.level === 'emergency' && !general) {
        contacted = alertEmergency(id, symptoms ?? '');
        const names = contacted.trying.join(' and ');
        if (contacted.trying.length) {
          spoken += contacted.demo
            ? ` I'm telling ${names}. ${DEMO_PHONE}`
            : contacted.configured
              ? ` I'm emailing ${names} now.`
              : ` I can't email ${names}, because email isn't set up on this server yet.`;
        }
      }
      return say(spoken, {
        ...result,
        spoken,
        contacted,
        ...(general ? { askedInGeneral: true } : {}),
        // The one card that has to be readable from across the room.
        ...(result.level === 'emergency'
          ? { card: { kind: 'card', title: 'Call 911 now', status: { label: 'emergency', tone: 'bad' }, lines: ['Move them somewhere cool.', 'Cool them with wet cloths or a cool bath.', 'Give them nothing to drink.'], foot: contacted?.trying.length && contacted.configured ? `Emailing ${contacted.trying.join(' and ')}.` : '' } }
          : {}),
      });
    },
  );

  /*
   * The one winter question with a body count attached.
   *
   * Ten minutes of shovelling takes a heart to about 97 percent of its maximum
   * rate, and the American Heart Association puts snow removal among the
   * activities that trigger heart attacks and sudden cardiac arrest, especially
   * in people who do not know they have coronary disease. Cold makes it worse:
   * it raises blood pressure and narrows the arteries while the work is going on.
   */
}
