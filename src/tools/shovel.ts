/**
 * The other end of the thermometer.
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
    'should_i_shovel',
    {
      title: 'Should I shovel the snow',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Whether this customer should shovel snow, clear a drive, push a snow blower or do other heavy work in the ' +
        'cold, judged against their own heart risk and age. Call this whenever someone mentions shovelling, clearing ' +
        'snow, or heavy outdoor work in winter. Read the answer aloud in full.',
      inputSchema: {},
    },
    async () => {
      const person = store.get(personOf());
      const heart = person.conditions.includes('heart_disease');
      const older = person.conditions.includes('older_adult');
      const snap = person.lat != null && person.lon != null ? weather.current(person.lat, person.lon) : null;
      const feels = snap && !Number.isNaN(snap.tempF) ? windChillF(snap.tempF, snap.windMph) : null;
      const cold = feels != null ? `Out there it feels like ${Math.round(feels)}. ` : '';

      const evidence =
        'Ten minutes of shovelling puts most people near their maximum heart rate, and cold raises blood pressure at ' +
        'the same time.';

      if (heart || older) {
        const who = person.privacy
          ? 'Something in your health profile'
          : heart && older
            ? 'Your heart condition, and being over 65,'
            : heart
              ? 'Your heart condition'
              : 'Being over 65';
        return say(
          `${cold}I would not. ${who} puts you in the group the American Heart Association warns about. ${evidence} ` +
            'Ask someone else, or pay someone. If it truly cannot wait, push the snow rather than lifting it, do ten ' +
            'minutes at a time, and stop at once for chest pain, pain in the arm, neck or jaw, breathlessness, or ' +
            'feeling sick or light headed. That is 911, not a rest.',
          { advise: 'no', heart, older, windChillF: feels == null ? null : Math.round(feels) },
        );
      }

      return say(
        `${cold}Take it steadily. ${evidence} Warm up first, push rather than lift, take breaks, and skip the ` +
          'caffeine and the cigarette beforehand. Stop at once for chest pain, pain spreading to the arm, neck or ' +
          'jaw, breathlessness or feeling light headed, and call 911 rather than waiting to see.',
        { advise: 'carefully', heart, older, windChillF: feels == null ? null : Math.round(feels) },
      );
    },
  );

  /*
   * The official warnings, and the weather service's own instructions.
   *
   * Sudor does not write safety advice for a flood. The forecast office that
   * issued the alert already did, and their text is better. What this adds is
   * the part they cannot know: whose medicines and conditions make this alert
   * worse than it looks.
   */

  /*
   * Where to go when the house itself is the problem.
   *
   * The CDC puts the indoor floor at 68F and says 60 to 65F indoors can bring on
   * hypothermia in an older adult, which is a temperature most people would call
   * chilly rather than dangerous. Their first answer is to stay with a relative
   * or a friend. This tool exists for the person who has nobody to ask.
   *
   * Two sources, because neither is enough alone. FEMA and the Red Cross publish
   * the shelters that are open right now, which is authoritative and national and
   * says whether there is a generator. A city that opens its library for a cold
   * snap is usually not in that system at all, and 211 is the line that knows
   * about the library. So every answer carries both.
   */
}
