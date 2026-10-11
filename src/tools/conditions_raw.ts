/**
 * The raw conditions, before any judgement is applied.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import { indoorRisk, LIMIT_F } from '../indoor.js';
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
import * as attention from '../attention.js';
import {
  CATEGORY_WORDS,
  MEDICATION_CAUTION,
  UI,
  asked,
  coldConditionsOf,
  coldMechanismsOf,
  coldOpening,
  mechanismsOf,
  nowHour,
  profileFor,
  say,
  snapshotFor,
  officialWarning,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * The answers.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'weather_check',
    {
      title: 'Is it safe for me outside right now',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Whether the weather right now, hot or cold, is a problem for this customer's own medications and conditions. " +
        'Call this when someone asks if it is safe to be outside, to garden, to work outdoors, how bad the heat is, or ' +
        'how cold it is for them. It needs no arguments: it uses the place and medicines already saved. Read the answer aloud in full; it names what is driving the risk and what to do. It is the ' +
        'answer for right now. To choose a time of day use plan_my_day, and for ' +
        'someone who already feels unwell use warning_signs. Pass heard when they say got it after a reminder.',
      inputSchema: {
        heard: z.boolean().optional().describe('true only when they say got it, okay, I heard you or stop reminding me, straight after a reminder about a stay-inside day'),
      },
      _meta: { ui: { resourceUri: UI }, 'openai/outputTemplate': UI },
    },
    async ({ heard }) => {
      // "Got it." The reminder about a stay-inside day stops. See attention.ts.
      if (heard) {
        const had = attention.heard(personOf());
        return say(had ? "Okay. I won't mention it again today." : 'Okay.', { heard: true });
      }
      const person = store.get(personOf());
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say(snap, { unavailable: true });

      const mechanisms = mechanismsOf(person);
      const profile = profileFor(person);

      // Winter is the same question asked from the other end. Below about 50
      // degrees the heat index stops meaning anything, so the cold answer
      // replaces the heat one rather than being bolted onto it.
      const feelsCold = windChillF(snap.tempF, snap.windMph);
      const coldBand = coldCategory(feelsCold);
      if (coldBand !== 'none') {
        const drugs = coldMechanismsOf(person);
        const conditions = coldConditionsOf(person);
        const parts = [coldOpening(snap.tempF, feelsCold)];

        if (person.privacy) {
          if (drugs.length || conditions.length) parts.push('Something in your health profile makes this cold riskier for you.');
        } else {
          for (const { mechanism, drugs: names } of drugs.slice(0, 2)) {
            parts.push(`Your ${names.join(' and ')} matters here: ${COLD_MECHANISM_SAY[mechanism]}.`);
          }
          if (conditions[0]?.cold) parts.push(conditions[0].cold.plan);
        }

        const frostbite = coldMeaning(feelsCold);
        if (frostbite) parts.push(frostbite);
        parts.push(
          coldBand === 'dangerous' || coldBand === 'very_cold'
            ? 'Keep any time outside short, cover every bit of skin, and come in if you start shivering hard.'
            : drugs.length || conditions.length
              ? 'Dress for colder than it looks, and ask me what precautions to take before you go.'
              : 'Ordinary cold precautions are enough for you today.',
        );
        if (!person.medications.length && !person.conditions.length) {
          parts.push('Tell me your medications or health conditions and I can answer for you specifically.');
        }

        const official = officialWarning(person, snap.timezone);
        if (official) parts.push(official.line);
        return say(parts.join(' '), {
          ...(official ? { mustSay: [official.line], warning: official.event } : {}),
          season: 'cold',
          tempF: snap.tempF,
          windChillF: Math.round(feelsCold),
          windMph: snap.windMph,
          category: coldBand,
          place: person.locationName,
          dataAgeMinutes: weather.ageMinutes(snap.lat, snap.lon),
          ...(person.privacy
            ? { private: true }
            : {
                coldMechanisms: drugs.map((d) => d.mechanism),
                medications: drugs.flatMap((d) => d.drugs),
                conditions: conditions.map((c) => c.label),
              }),
        });
      }

      const verdict = assess(snap.tempF, snap.humidityPct, mechanisms);
      const judged = judgeHour(nowHour(snap), profile);
      const opening = `Heat index ${Math.round(verdict.heatIndexF)}, ${CATEGORY_WORDS[verdict.category]}.`;

      const parts: string[] = [];
      if (person.privacy) {
        parts.push(opening);
        if (profile.sensitivity !== 'general' && verdict.category !== 'none') {
          parts.push('Something in your health profile makes this heat riskier for you.');
        }
      } else {
        parts.push(person.medications.length ? verdict.reason : opening);
        if (verdict.binding) parts.push(MEDICATION_CAUTION);
        const condition = profile.conditions[0];
        if (condition && verdict.category !== 'none') {
          // A medication explanation is already a lot to hear, so the condition
          // gets one short line then, and its full planning sentence otherwise.
          parts.push(verdict.binding ? `With ${condition.label}, that matters even more.` : condition.plan);
        }
      }

      const extra = judged.reasons.filter((r) => !r.startsWith('heat index'));
      const because = extra.length ? `, because of ${extra.join(' and ').replace('felt unwell at this heat before', 'how you felt at this heat before')}` : '';
      // The answer to the question that was asked comes first. It used to come last, after the heat index,
      // the medicine and the condition, which is the order it was worked out in and not the order to say it.
      parts.unshift(
        judged.status === 'good'
          ? 'For you, right now is a fine time to be outside.'
          : judged.status === 'caution'
            ? `For you, take care if you go out now${because}.`
            : `For you, it is better to stay in right now if you can${because}.`,
      );
      if (!person.medications.length && !person.conditions.length) {
        parts.push('Tell me your medications or health conditions and I can answer for you specifically.');
      }
      const age = weather.ageMinutes(snap.lat, snap.lon);
      if (snap.stale && age != null && age > 60) parts.push(`My weather data is ${age} minutes old.`);

      // "Stay in" is only good advice when in is cooler than out. See indoor.ts.
      const vulnerable = person.medications.length > 0 || person.conditions.length > 0;
      const inside = indoorRisk(snap, person, vulnerable);
      if (inside) parts.push(inside.line);
      // Nobody has said whether the cooling works, and they have just been told to stay in.
      // Asked once a day at most, and it is the closing question when it is asked.
      const today = new Date().toISOString().slice(0, 10);
      const askCooling = !inside && !person.cooling && person.coolingAskedOn !== today && judged.status === 'avoid' && snap.tempF >= LIMIT_F;
      if (askCooling) store.update(personOf(), (p) => void (p.coolingAskedOn = today));

      // The step that finishes the thought, put as one question.
      // One question at a time: when the cooling is being asked about, that is the question.
      const offer = askCooling ? 'That only holds if your cooling is working. Is it?' : judged.status === 'good' || officialWarning(person, snap.timezone) ? '' : 'Want me to find the safest time to go out today?';
      // The line about not stopping a medicine is said whatever else is held back.
      // So is the line about not stopping a medicine: it is the one sentence here that prevents a harm.
      const mustSay = [parts.includes(MEDICATION_CAUTION) ? MEDICATION_CAUTION : '', inside ? inside.line : ''].filter(Boolean);
      // A hurricane, a tornado or a flood outranks the heat index, and is said whatever else is held back.
      const official = officialWarning(person, snap.timezone);
      if (official) {
        parts.push(official.line);
        mustSay.push(official.line);
      }
      return say(parts.join(' '), {
        ...(official ? { warning: official.event } : {}),
        ...(inside?.level === 'danger' ? { nextAction: { tool: 'somewhere_to_go', arguments: {} } } : askCooling ? { offer } : offer ? { offer, nextAction: { tool: 'plan_my_day', arguments: {} } } : {}),
        ...(inside ? { indoor: { level: inside.level, basis: inside.basis, indoorF: inside.indoorF ?? null, highF: inside.highF ?? null, overnightLowF: inside.overnightLowF ?? null } } : {}),
        ...(askCooling ? { asks: 'cooling' } : {}),
        mustSay,
        heatIndexF: verdict.heatIndexF,
        category: verdict.category,
        status: judged.status,
        sensitivity: profile.sensitivity,
        because: profile.because,
        place: person.locationName,
        uvIndex: snap.uvIndex,
        aqi: snap.aqi,
        learnedLimitF: profile.learnedLimitF,
        dataAgeMinutes: age,
        ...(person.privacy
          ? { private: true }
          : {
              binding: verdict.binding,
              active: verdict.active,
              tempF: snap.tempF,
              humidityPct: snap.humidityPct,
              medications: person.medications.map((m) => m.generic),
              conditions: profile.conditions.map((c) => c.label),
            }),
      });
    },
  );

}
