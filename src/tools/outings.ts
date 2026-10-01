/**
 * The record of what they actually did.
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
  clean,
  justNow,
  profileFor,
  say,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * Learning from how it actually went.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'log_outing',
    {
      title: 'How did it go outside',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Record how the customer felt after being out in the heat, fine or unwell. Feeling unwell sets a personal heat ' +
        'limit that future plans respect. Call this when they say they just got back, felt fine, or felt dizzy, ' +
        'faint, sick or overheated while out. If they feel unwell right now, also use warning_signs. It records something ' +
        'that already happened; it does not plan an outing (use plan_my_day).',
      inputSchema: {
        felt: z.enum(['fine', 'unwell']).describe('fine if they were ok, unwell if they felt dizzy, faint, sick or overheated'),
        minutes: z.number().int().min(1).max(720).optional().describe('How long they were out'),
        note: z.string().optional().describe('Anything they said about it'),
      },
    },
    async ({ felt, minutes, note }) => {
      const id = personOf();
      const person = store.get(id);
      const snap = person.lat != null && person.lon != null ? weather.current(person.lat, person.lon) : null;
      const hi = snap && !Number.isNaN(snap.tempF) ? Math.round(heatIndexF(snap.tempF, snap.humidityPct)) : null;
      // Telling me twice was one afternoon. It matters here: an unwell outing
      // sets the personal heat limit, so a duplicate would weigh one bad
      // afternoon twice.
      const repeat = person.outings.find(
        (o) => o.felt === felt && (o.minutes ?? null) === (minutes ?? null) && justNow(o.at),
      );
      if (!repeat) {
        store.update(id, (p) =>
          void p.outings.push({ at: new Date().toISOString(), felt, heatIndexF: hi, minutes: minutes ?? null, note: note ? clean(note, 200) : null }),
        );
      }
      const updated = profileFor(store.get(id));
      if (felt === 'fine') {
        return say("Noted, I'm glad it went well.", { logged: true, heatIndexF: hi });
      }
      return say(
        hi != null
          ? `Noted. You felt unwell at heat index ${hi}, so from now on I'll treat ${updated.learnedLimitF} and above as ` +
              'stay-inside heat for you. If you still feel unwell, ask me about the warning signs.'
          : "Noted. I couldn't read the heat just now, so I can't set a limit from this one. If you still feel unwell, ask me about the warning signs.",
        { logged: true, heatIndexF: hi, learnedLimitF: updated.learnedLimitF },
      );
    },
  );

}
