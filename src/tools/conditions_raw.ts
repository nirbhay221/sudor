/**
 * The raw conditions, before any judgement is applied.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import { MECHANISM_LABEL } from '../meds.js';
import * as streak from '../streak.js';
import { GUIDANCE } from '../domain.js';
import { sentences } from '../brief.js';
import { thunderstormAsthma, migrainePressure } from '../weatherhealth.js';
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

/** The first half of each medicine's heat advice, for the spoken answer. The rest is in GUIDANCE, for "tell me more". */
const GUIDANCE_SHORT = {
  reduced_sweating: 'you may not feel overheating until it is serious',
  increased_heat_production: 'treat outdoor effort as if it were several degrees hotter',
  reduced_thirst_or_sedation: 'drink on a schedule, not on thirst',
  electrolyte_imbalance: 'have an electrolyte drink as well as water',
  fluid_loss: 'sip steadily through the day',
  hyponatremia_risk: 'sip through the day rather than drinking a lot at once',
  increased_sweating: 'drink before you feel thirsty',
  faint_risk: 'get up slowly and sit down if you feel light-headed',
  kidney_risk: 'do not let yourself run dry',
  reduced_vasodilation: 'take shade and rest earlier than you think you need to',
  heat_damaged: 'keep it out of a hot car and the sun',
} as const;

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

      // Weather that is a health event in itself, for the people it is one for. See weatherhealth.ts.
      const stormLine = thunderstormAsthma(snap, { asthma: person.conditions.includes('asthma_copd'), hayFever: person.conditions.includes('hay_fever') });
      const migraineLine = person.conditions.includes('migraine') ? migrainePressure(snap) : '';
        if (stormLine) parts.push(stormLine);
        if (migraineLine) parts.push(migraineLine);
        const official = officialWarning(person, snap.timezone);
        if (official) parts.push(official.line);
        return say(parts.join(' '), {
          ...(official || stormLine ? { mustSay: [official?.line ?? '', stormLine].filter(Boolean) } : {}),
          ...(official ? { warning: official.event } : {}),
          ...(stormLine ? { thunderstormAsthma: true } : {}),
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
      /*
       * How it feels, in the words people use: "it feels like 82 out". The heat index is what "feels like" means,
       * and older listeners understand the phrase without the term (Amazon's one-breath rule, and the review of
       * heat warnings for older adults, both say plain words). The official band is added only when it is
       * itself a warning, so "stay in" is never followed by "caution".
       */
      const hiNow = Math.round(verdict.heatIndexF);
      const band = verdict.category === 'danger' || verdict.category === 'extreme_danger' ? `, which the weather service calls ${CATEGORY_WORDS[verdict.category]}` : '';
      const opening = `It feels like ${hiNow} degrees out${band}.`;

      const parts: string[] = [];
      if (person.privacy) {
        parts.push(opening);
        if (profile.sensitivity !== 'general' && verdict.category !== 'none') {
          parts.push('Something in your health profile makes this heat riskier for you.');
        }
      } else {
        parts.push(opening);
        if (verdict.binding) {
          // The medicine by its name, and only the first half of what it means: the rest is there to be asked for.
          const named = person.medications.find((m) => m.mechanisms.includes(verdict.binding!))?.generic ?? 'medication';
          const consequence = GUIDANCE_SHORT[verdict.binding as keyof typeof GUIDANCE_SHORT] ?? '';
          parts.push(`Your ${named} ${MECHANISM_LABEL[verdict.binding]}${consequence ? `, so ${consequence}` : ''}.`);
          parts.push(MEDICATION_CAUTION);
          // What to do about it, held for "tell me more" by the brevity layer.
          const howTo = sentences(GUIDANCE[verdict.binding as keyof typeof GUIDANCE] ?? '').slice(1).join(' ');
          if (howTo) parts.push(howTo);
        }
        const condition = profile.conditions.find((c) => c.sensitivity !== 'general');
        if (condition && verdict.category !== 'none') parts.push(condition.plan);
      }

      const extra = judged.reasons.filter((r) => !r.startsWith('heat index'));
      const plainReason = (r: string) =>
        r === 'felt unwell at this heat before' ? 'how you felt at this heat before'
          : /^UV/.test(r) ? 'the strong sun'
            : /^air quality/.test(r) ? 'the air quality'
              : r;
      const because = extra.length ? `, because of ${extra.map(plainReason).join(' and ')}` : '';
      // The answer to the question that was asked comes first. It used to come last, after the heat index,
      // the medicine and the condition, which is the order it was worked out in and not the order to say it.
      parts.unshift(
        (judged.status === 'good'
          ? 'For you, right now is a fine time to be outside.'
          : judged.status === 'caution'
            ? `For you, take care if you go out now${because}.`
            : `For you, it is better to stay in right now if you can${because}.`),
      );
      // Hot days in a row, named in advance for the people the risk was found in. See streak.ts.
      const localToday = new Date(Date.now() + (Number(snap.utcOffsetSeconds) || 0) * 1000).toISOString().slice(0, 10);
      const run = person.privacy ? null : streak.hotRun(snap, localToday);
      const runLine = streak.line(run, localToday, { older: person.conditions.includes('older_adult'), sensitive: profile.sensitivity !== 'general' });
      if (runLine) parts.push(runLine);
      if (!person.medications.length && !person.conditions.length) {
        parts.push('Tell me your medications or health conditions and I can answer for you specifically.');
      }
      const age = weather.ageMinutes(snap.lat, snap.lon);
      if (snap.stale && age != null && age > 60) parts.push(`My weather data is ${age} minutes old.`);

      // Weather that is a health event in itself, for the people it is one for. See weatherhealth.ts.
      const stormLine = thunderstormAsthma(snap, { asthma: person.conditions.includes('asthma_copd'), hayFever: person.conditions.includes('hay_fever') });
      const migraineLine = person.conditions.includes('migraine') ? migrainePressure(snap) : '';
      if (stormLine) parts.push(stormLine);
      if (migraineLine) parts.push(migraineLine);
      // Fasting on top of a water pill, an SGLT2 drug, kidney disease or diabetes is the group the Ramadan
      // diabetes guidelines (IDF-DAR) advise to check with their doctor before fasting at all, more so in heat.
      const fastingRisk =
        person.conditions.includes('fasting') && verdict.category !== 'none' &&
        (person.conditions.some((c) => c === 'kidney_disease' || c === 'diabetes') ||
          person.medications.some((m) => m.mechanisms.some((x) => x === 'fluid_loss' || x === 'electrolyte_imbalance')));
      const fastLine = fastingRisk ? 'Fasting in this heat with your medicines or conditions is the combination doctors most want to hear about first, so ask yours before you keep the fast on hot days.' : '';
      if (fastLine) parts.push(fastLine);
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
      const offer = askCooling ? 'Staying in only helps if your cooling works. Is it working?' : judged.status === 'good' || officialWarning(person, snap.timezone) ? '' : 'Want me to find the safest time to go out today?';
      // The line about not stopping a medicine is said whatever else is held back.
      // So is the line about not stopping a medicine: it is the one sentence here that prevents a harm.
      // A run that starts today is already covered by today's answer; one that starts tomorrow or the day after is
      // the warning nobody else gives yet, so it is said.
      const runAhead = run && run.start > localToday ? runLine : '';
      const mustSay = [parts.includes(MEDICATION_CAUTION) ? MEDICATION_CAUTION : '', inside ? inside.line : '', stormLine, runAhead].filter(Boolean);
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
        ...(stormLine ? { thunderstormAsthma: true } : {}),
        ...(runLine && run ? { hotRun: run } : {}),
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
