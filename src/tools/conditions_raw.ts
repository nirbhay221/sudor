/**
 * The raw conditions, before any judgement is applied.
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
        'how cold it is for them. Read the answer aloud in full; it names what is driving the risk and what to do. It is the ' +
        'answer for right now. To choose a time of day use plan_my_day, for official warnings use weather_warnings, and for ' +
        'someone who already feels unwell use warning_signs.',
      inputSchema: {},
      _meta: { ui: { resourceUri: UI }, 'openai/outputTemplate': UI },
    },
    async () => {
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

        return say(parts.join(' '), {
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
      parts.push(
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

      return say(parts.join(' '), {
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
