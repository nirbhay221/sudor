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
import { profileOf, judgeHour, planDay, precautions } from '../personal.js';
import * as wbgt from '../wbgt.js';
import { triage } from '../firstaid.js';
import { geocode } from '../geocode.js';
import { alertEmergency } from '../alerts.js';
import { emailConfigured } from '../notify.js';
import * as weather from '../weather.js';
import * as store from '../store.js';
import * as recalls from '../recalls.js';
import * as warnings from '../warnings.js';
import * as spaceweather from '../spaceweather.js';
import * as shelters from '../shelters.js';
import {
  UI,
  count,
  nowHour,
  profileFor,
  say,
  snapshotFor,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  server.registerTool(
    'plan_my_day',
    {
      title: 'When is the best time to go out',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Plan a day around the heat for this customer: the best window for going out and the hours to avoid, using the ' +
        'hourly forecast for their location, their medications and conditions, UV, air quality and how they felt ' +
        'before. Call this when someone asks when to go out, walk the dog, run errands, exercise or garden, when it ' +
        'cools down, or to plan today or tomorrow. It plans a whole day. For a single trip that cannot wait use going_out_now, ' +
        'and for whether it is safe to be outside at this moment use weather_check.',
      inputSchema: {
        activity: z.string().optional().describe('What they want to do, e.g. "a walk", "groceries", "gardening"'),
        minutes: z.number().int().min(10).max(600).optional().describe('How long it takes, in minutes, default 60'),
        day: z.enum(['today', 'tomorrow']).optional().describe('today unless they say tomorrow'),
      },
      _meta: { ui: { resourceUri: UI } },
    },
    async ({ activity, minutes, day }) => {
      const person = store.get(personOf());
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say(snap, { unavailable: true });
      const profile = profileFor(person);
      const plan = planDay(snap, profile, { now: new Date(), day, minutes, activity });
      return say(plan.spoken, {
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
        'Precautions for going out in the heat right now when it cannot wait, tailored to this customer: their ' +
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
      const person = store.get(personOf());
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say(snap, { unavailable: true });
      const profile = profileFor(person);
      const judged = judgeHour(nowHour(snap), profile);
      const result = precautions(judged, profile, step ?? 0, { includePrivate: privatePrecautions === true });
      // This is the one tool where the customer has already decided to be
      // outdoors, which is exactly the case the heat index is not written for.
      // The sun's contribution is added only on the first step, so it does not
      // repeat through the precaution list.
      const load = wbgt.wbgt(snap.tempF, snap.humidityPct, snap.wetBulbF, snap.solarWm2, snap.windMph);
      const sun = (step ?? 0) === 0 ? wbgt.explain(load) : '';
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'What to do when someone feels unwell in the heat or the cold: heat stroke and heat exhaustion in warm ' +
        'weather, hypothermia and frostbite in cold. Which one it answers follows the weather where the person is. ' +
        'Pass what they describe. If it describes confusion, slurred speech, fainting or collapse, the answer tells them ' +
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
        let contacted: { trying: string[]; configured: boolean; demo?: boolean } | null = null;
        if (matched.emergency) {
          contacted = alertEmergency(id, symptoms ?? '');
          const names = contacted.trying.join(' and ');
          if (contacted.trying.length) {
            spoken += contacted.demo
              ? ' Email is turned off in the public demo, so I have not emailed anyone.'
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
      let contacted: { trying: string[]; configured: boolean; demo?: boolean } | null = null;
      if (result.level === 'emergency') {
        contacted = alertEmergency(id, symptoms ?? '');
        const names = contacted.trying.join(' and ');
        if (contacted.trying.length) {
          spoken += contacted.demo
            ? ' Email is turned off in the public demo, so I have not emailed anyone.'
            : contacted.configured
              ? ` I'm emailing ${names} now.`
              : ` I can't email ${names}, because email isn't set up on this server yet.`;
        }
      }
      return say(spoken, { ...result, spoken, contacted });
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
