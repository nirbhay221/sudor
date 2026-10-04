/**
 * Official warnings, and what a storm means for a medicine cabinet.
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
  fridgeMedicines,
  NO_LOCATION,
  coldConditionsOf,
  coldMechanismsOf,
  profileFor,
  say,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  server.registerTool(
    'weather_warnings',
    {
      title: 'Are there any weather warnings for me',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Official National Weather Service watches, warnings and advisories for this customer\'s location, read with ' +
        'their medications and conditions in mind. Call this when someone asks about warnings, alerts, whether a ' +
        'storm is coming, or whether it is safe to travel. Read the answer aloud in full. These are official alerts only; for ' +
        'how to get ready use storm_prep, and for how the temperature affects them right now use weather_check.',
      inputSchema: {},
    },
    async () => {
      const person = store.get(personOf());
      if (person.lat == null || person.lon == null) return say(NO_LOCATION, { unavailable: true });

      const held = warnings.current(person.lat, person.lon);
      if (held === null) {
        return say(
          "I haven't managed to reach the weather service yet. Ask me again in a few minutes, and check weather.gov " +
            'if you need to know now.',
          { checked: false },
        );
      }
      const place = person.locationName ?? 'your area';
      // A list that could not be refreshed keeps its last answer. "No warnings" from two hours ago is not
      // "no warnings", and an old warning may have ended, so past an hour this says it does not know.
      const checked = warnings.ageMinutes(person.lat, person.lon);
      if (checked != null && checked > 60) {
        return say(
          `I last reached the weather service ${checked} minutes ago, so I can't tell you what is in force for ${place} right now. ` +
            'Ask me again in a few minutes, and check weather.gov if you need to know now.',
          { checked: false, checkedMinutesAgo: checked },
        );
      }
      if (!held.length) {
        return say(`No weather warnings for ${place} right now. I check every ten minutes.`, {
          alerts: 0,
          place,
          checkedMinutesAgo: warnings.ageMinutes(person.lat, person.lon),
        });
      }

      const snap = weather.current(person.lat, person.lon);
      const zone = snap?.timezone ?? 'UTC';
      const ranked = warnings.rank(held);
      const top = ranked[0];
      const profile = profileFor(person);
      const parts = [`${top.event} for ${top.areaDesc.split(';')[0].trim()}${warnings.until(top, zone)}.`];

      if (top.instruction) parts.push(`The weather service says: ${warnings.brief(top.instruction)}`);

      // The personal half. In privacy mode it still says the risk is raised,
      // just not why.
      // This used to be built by putting "Being" in front of a clause, which read "Being because your
      // medication blocks your sweating makes heat harder on you".
      const named = person.privacy
        ? 'Something in your health profile'
        : profile.conditions[0]
          ? `Living with ${profile.conditions[0].label}`
          : person.medications.length
            ? 'What you take'
            : null;
      if (top.kind === 'heat' && (profile.sensitivity !== 'general' || person.medications.length)) {
        parts.push(`${named ?? 'Your profile'} makes heat harder on you than on most people. Ask me when to go out today.`);
      } else if (top.kind === 'cold' && (coldMechanismsOf(person).length || coldConditionsOf(person).length)) {
        parts.push(`${named ?? 'Your profile'} makes cold harder on you than on most people. Ask me what precautions to take.`);
      } else if (top.kind === 'air' && person.conditions.some((c) => c === 'asthma_copd' || c === 'heart_disease')) {
        parts.push('With your breathing and heart in mind, treat this as a day to stay in if you can.');
      }
      if (warnings.cutsPower(top) && (person.medications.length || person.conditions.length)) {
        parts.push('If this one takes the power out, ask me what to do about your medicines before it does.');
      } else if (top.kind === 'flood' && person.medications.length) {
        // Leaving in a hurry is the part people get wrong: the medicines stay
        // on the shelf, and a week later that is the emergency, not the water.
        parts.push('If you are told to leave, take your medicines and a written list of them with you.');
      }
      if (ranked.length > 1) parts.push(`There ${ranked.length === 2 ? 'is 1 other alert' : `are ${ranked.length - 1} other alerts`} as well.`);

      return say(parts.join(' '), {
        fullAnswer: true,
        place,
        alerts: ranked.length,
        top: { event: top.event, kind: top.kind, severity: top.severity, ends: top.ends, areaDesc: top.areaDesc },
        events: ranked.map((a) => a.event),
        checkedMinutesAgo: warnings.ageMinutes(person.lat, person.lon),
      });
    },
  );

  /*
   * What a storm means for a medicine cabinet.
   *
   * The generic advice is a torch and bottled water. The advice that actually
   * decides an outcome is specific to the person: insulin needs a fridge,
   * dialysis needs a clinic that is open, an oxygen concentrator needs a socket.
   * Sudor is holding the list that says which of those apply.
   */
  server.registerTool(
    'storm_prep',
    {
      title: 'Getting ready for a storm or power cut',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'What this customer should do before a storm, a power cut or a freeze, based on the medicines and conditions ' +
        'they have registered: refrigerated medicines, dialysis, oxygen, and keeping enough of everything. Also covers ' +
        'severe space weather, which can strain the power grid, when a geomagnetic storm is forecast. Call this ' +
        'when someone asks how to prepare, what to do about their medicines before a storm or a solar storm, or ' +
        'mentions losing power. It is advice on preparing, not the alerts themselves (use weather_warnings) and not somewhere ' +
        'to go once the power is already out (use somewhere_to_go).',
      inputSchema: {},
    },
    async () => {
      const person = store.get(personOf());
      const alerts = person.lat != null && person.lon != null ? warnings.current(person.lat, person.lon) ?? [] : [];
      const coming = warnings.rank(alerts).find((a) => warnings.cutsPower(a));
      // The weather service forecasts wind and ice. It does not forecast the
      // sun, and a severe geomagnetic storm is the other way a grid gets into
      // trouble, so that half comes from Orbita over MCP. Silence when there is
      // nothing to say, and silence when it cannot be reached.
      // Said at the end, not the start. A geomagnetic storm is the least likely
      // of the things on this list to actually cut someone's power, and leading
      // with it would put the rarest risk in front of the insulin.
      const solar = spaceweather.outlook();
      const lead = coming ? `${coming.event} is up for your area. ` : '';

      const steps: string[] = [];
      const cold = fridgeMedicines(person);
      if (person.conditions.includes('diabetes') || cold.insulin) {
        steps.push(
          'Insulin keeps best between 36 and 46 degrees. If the power goes, keep it as cool as you can without ' +
            'freezing it, because frozen insulin is finished. The FDA says insulin kept warmer than it should be can ' +
            'still be used in an emergency when there is nothing else, so do not go without: ring your pharmacist ' +
            'about replacing it once the power is back.',
        );
      }
      if (cold.injectables.length) {
        steps.push(
          `Your ${cold.injectables.join(' and ')} pen is meant to be kept in the fridge. Do not let it freeze, and ask your ` +
            'pharmacist how long it is good for at room temperature, because that differs from one pen to another.',
        );
      }
      if (person.conditions.includes('kidney_disease')) {
        steps.push(
          'Ring your dialysis unit today and ask what happens if they lose power or you cannot get there. If you do ' +
            'miss a treatment, the National Kidney Foundation has a three day emergency diet for exactly that, and ' +
            'starting it early is better than starting it late.',
        );
      }
      if (person.conditions.includes('asthma_copd')) {
        steps.push(
          'If anything you breathe with needs a socket, check its battery now and ask your supplier what they do in ' +
            'an outage. Keep an inhaler that needs no power where you can find it in the dark.',
        );
      }
      if (person.medications.length) {
        steps.push(
          'Ask your pharmacist for at least a week of everything you take, and write down the names and doses on ' +
            'paper, because a phone with a flat battery cannot tell a paramedic anything.',
        );
      }
      steps.push('Charge your phone and anything else that holds a charge now, while you still have power.');
      if (coming && warnings.classify(coming.event) === 'cold') {
        steps.push(
          'If the heating goes, warm one room rather than the whole house, and never run a generator, grill or ' +
            'camping stove indoors or in the garage: that is how people die of carbon monoxide after a storm.',
        );
      }

      const opening = person.medications.length || person.conditions.length || cold.insulin
        ? 'Here is what matters for you.'
        : "I don't know your medicines or conditions yet, so this is the general version. Tell me what you take and I can be specific.";

      const tail = solar ? ` ${spaceweather.speak(solar)}` : '';
      return say(`${lead}${opening} ${steps.join(' ')}${tail}`, {
        // A checklist for before the power goes. With a storm on the way every line is a thing to do now, so it
        // is heard whole. With nothing coming it is advice, and is given a few sentences at a time.
        fullAnswer: !!coming || !!solar,
        alert: coming ? coming.event : null,
        spaceWeather: solar ? { g: solar.g, when: solar.when } : null,
        steps: steps.length,
        sources: [
          'https://www.fda.gov/drugs/emergency-preparedness-drugs/information-regarding-insulin-storage-and-switching-between-products-emergency',
          'https://www.cdc.gov/diabetes/articles/managing-insulin-in-emergency.html',
          'https://www.kidney.org/kidney-topics/planning-emergencies-guide-people-kidney-disease',
          'https://www.cdc.gov/carbon-monoxide/about/index.html',
          ...(solar
            ? ['https://www.swpc.noaa.gov/noaa-scales-explanation', 'https://www.spaceweather.gc.ca/tech/se-chr-en.php']
            : []),
        ],
      });
    },
  );

}
