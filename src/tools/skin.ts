/**
 * The sun on skin, and recalls on what they take.
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
  asked,
  say,
  snapshotFor,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  server.registerTool(
    'sun_check',
    {
      title: 'Will I burn faster today',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Whether today's UV plus the customer's medications raise their sunburn risk. Call this when asked about sun " +
        'exposure, sunburn, going to the beach or pool, or whether they need extra sunscreen today. It is about UV and skin ' +
        'only; for heat illness or whether it is too hot to be outside use weather_check.',
      inputSchema: {},
      _meta: { ui: { resourceUri: UI } },
    },
    async () => {
      const person = store.get(personOf());
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say(snap, { unavailable: true });
      const hasPhoto = person.medications.some((m) => m.mechanisms.includes('photosensitivity'));
      const result = photoRisk(snap.uvIndex, hasPhoto);
      return say(result.reason, { ...result, uvIndex: snap.uvIndex });
    },
  );

  server.registerTool(
    'medicine_recalls',
    {
      title: 'Has any of my medicine been recalled',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Open FDA recalls on the medications this customer takes, matched against their own list. Call this when they ' +
        'ask about recalls, whether their medicine is safe, whether something was pulled, or mention hearing about a ' +
        'recall. Read the answer aloud in full: it says to check the lot number and to ask a pharmacist, and it never ' +
        'tells anyone to stop taking anything. Pass from to continue when they ask for the rest.',
      inputSchema: {
        from: z.number().int().min(0).optional().describe('Where to continue from; use nextFrom from the last answer'),
      },
    },
    async ({ from }) => {
      const person = store.get(personOf());
      // Everything with a name, whether or not the heat table knows it.
      const watched = [...person.medications.map((m) => m.generic), ...person.recallWatch];
      if (!watched.length) {
        return say(
          "I don't know what you take yet. Tell me your medications and I'll watch the FDA recall list for them.",
          { medications: 0 },
        );
      }

      const checked = watched.filter((generic) => recalls.known(generic) !== null);
      const found = recalls.rank(watched.flatMap((generic) => recalls.known(generic) ?? []));
      const affected = new Set(found.map((r) => r.generic.toLowerCase()));

      if (!checked.length) {
        return say(
          "I haven't managed to check the FDA list yet. Ask me again in a few minutes, and ask your pharmacist if you " +
            'heard about a recall in the meantime.',
          { checked: 0, recalls: 0 },
        );
      }

      if (!found.length) {
        const how = checked.length === 1 ? 'your medicine' : `all ${checked.length} of your medicines`;
        return say(`No open FDA recalls on ${how}. I check that list twice a day.`, {
          checked: checked.length,
          recalls: 0,
        });
      }

      // Privacy mode exists because a home is not a private room, and a recall
      // names the medicine. So it says there is one, and holds the name.
      if (person.privacy) {
        const how =
          affected.size === 1
            ? 'One of your medicines has an open FDA recall.'
            : `${affected.size} of your medicines have open FDA recalls.`;
        return say(
          `${how} Ask me again when you're alone and I'll name them, or ask your pharmacist to ` +
            'check the lot numbers on your bottles.',
          { private: true, medicinesAffected: affected.size },
        );
      }

      // Count medicines, not notices. One medicine can carry several notices, and
      // saying "four of your medicines" when the person takes two is a lie that
      // would be noticed immediately.
      //
      // Two at a time, because a spoken answer that runs past about four
      // sentences stops being heard. The rest are there for the asking, the same
      // way the precautions are.
      const start = Math.min(Math.max(from ?? 0, 0), Math.max(found.length - 1, 0));
      const page = found.slice(start, start + 2);
      const lead = start > 0 ? '' : affected.size > 1 ? `${affected.size} of your medicines have open recalls. ` : '';
      const spoken = [recalls.speak(page[0]), ...page.slice(1).map((r) => recalls.speak(r, true))];
      const left = found.length - (start + page.length);
      const more = left > 0 ? ` There ${left === 1 ? 'is 1 more notice' : `are ${left} more notices`}, ask me for the rest.` : '';
      return say(lead + spoken.join(' ') + more, {
        checked: checked.length,
        medicinesAffected: affected.size,
        recalls: found.length,
        nextFrom: left > 0 ? start + page.length : null,
        items: found.slice(0, 5).map((r) => ({
          generic: r.generic,
          classification: r.classification,
          started: r.started,
          reason: r.reason,
          lots: r.lots,
          firm: r.firm,
        })),
      });
    },
  );

}
