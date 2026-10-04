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
          ? ' To start, tell me your city or zip code.'
          : '';
      // Three sentences. It used to be 116 words, which nobody asking "what can you do" is waiting for.
      return say(
        'I tell you whether the heat or the cold outside is a problem for you, given the medicines you take and the ' +
          'conditions you have. Ask me is it safe outside, when is the best time to go out, or tell me how you feel. ' +
          "I'm not a doctor, and this isn't medical advice." +
          setup,
        { fullAnswer: true, medicationsKnown: MEDICATIONS.length, conditionsKnown: CONDITIONS.length },
      );
    },
  );
}
