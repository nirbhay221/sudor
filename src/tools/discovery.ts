/**
 * What this add-on can do.
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
  say,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  server.registerTool(
    'what_can_you_do',
    {
      title: 'What can this do',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Explain what this add-on is for. Call this when the customer asks what you can do, what this is, or opens with ' +
        'something too vague to route. It changes nothing and needs no setup. Do not use it when they have asked a specific ' +
        'question, even a short one; use the tool for that.',
      inputSchema: {},
    },
    async () => {
      const person = store.get(personOf());
      const setup =
        person.lat == null
          ? ' First tell me your city or zip code, and any medications or health conditions you have.'
          : '';
      return say(
        'I help you plan around the heat for your own body, not just the forecast. Some medicines, like water pills and ' +
          'some antidepressants, and conditions like MS, erythromelalgia, heart disease and diabetes change how you ' +
          'handle heat. Ask me when is the best time to go out today, what to do if you have to go out now, or what ' +
          'the warning signs of heat illness are. I can also email a family member in an emergency or before a ' +
          'dangerous day, once you confirm them. I also watch the FDA recall list for the medicines you take, and tell you if one of them is recalled. ' +
          "I'm not a doctor, and this isn't medical advice." +
          setup,
        { medicationsKnown: MEDICATIONS.length, conditionsKnown: CONDITIONS.length },
      );
    },
  );
}
