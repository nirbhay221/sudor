/**
 * Somewhere to go when home is the problem.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import * as world from '../world.js';
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
import * as care from '../care.js';
import { reachable } from '../consent.js';
import {
  andList,
  say,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  server.registerTool(
    'somewhere_to_go',
    {
      title: 'Somewhere warm, or somewhere cool',
      description:
        'Find somewhere the customer can go when their home is too cold or too hot to stay in, usually after a power ' +
        'cut: open shelters from the federal shelter system near their address, whether each has a generator, step-free ' +
        'access or takes pets, and the 211 line for local warming and cooling centres. Call this when they say they have ' +
        'no heat, no power, no air conditioning, that the house is freezing or boiling, or ask where they can go. It is for ' +
        'finding a place; for advice on getting ready before a power cut use storm_prep.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const person = store.get(personOf());
      if (person.lat == null || person.lon == null) {
        return say(
          "I don't know where you are yet, so I can't look for anywhere near you. Tell me your city and state and " +
            'I will. Wherever you are, 211 is the number for this: call 211, or text your zip code to 898-211, and ' +
            'they will know what is open locally.',
          { unavailable: true, referral: '211' },
        );
      }

      const snap = weather.current(person.lat, person.lon);
      const feels = snap && !Number.isNaN(snap.tempF) ? windChillF(snap.tempF, snap.windMph) : null;
      const cold = feels != null ? feels <= 50 : false;
      const word = cold ? 'warm' : 'cool';

      const found = shelters.near(person.lat, person.lon, 60);
      const older = person.conditions.includes('older_adult');
      const powered = person.conditions.includes('asthma_copd') || person.conditions.includes('kidney_disease');

      const parts: string[] = [];

      // The CDC's own first answer, and it is a better one than any list.
      parts.push(`If you can get to a relative or a friend who has power, do that first.`);

      if (!world.inUS(person.country)) {
        // The federal shelter list and the 211 line are American. Elsewhere, the people who know what is open
        // are the local authority and the emergency services, and the nearest hospital is always somewhere.
        const hospital = care.sentence(person.lat, person.lon);
        parts.push(
          `Ring your local council or town hall, which is who opens ${cold ? 'warming' : 'cooling'} places outside the United States. ` +
            `In danger, ring ${world.known(person.country) ? world.emergencyNumber(person.country) : '112, or your local emergency number'}.` +
            (hospital ? ` ${hospital}` : ''),
        );
      } else if (found === null) {
        parts.push(
          "I could not reach the federal shelter list just now, so I can't tell you what is open. " +
            'Call 211, or text your zip code to 898-211: they keep the local list.',
        );
      } else if (!found.length) {
        parts.push(
          `Nothing is open near you in the federal shelter list, which mostly fills up during a declared disaster. ` +
            `For a ${word} place today, call 211, or text your zip code to 898-211. They know which libraries and ` +
            'community centres are open.',
        );
      } else {
        const nearest = found.slice(0, 3);
        const first = nearest[0];
        // "About 0 miles away" is what rounding says and not what anyone means.
        const away = (miles: number): string =>
          miles < 1 ? 'less than a mile away' : `about ${Math.round(miles)} ${Math.round(miles) === 1 ? 'mile' : 'miles'} away`;
        // The address was only in the structured result, so somebody listening heard that a shelter existed
        // and not where it was.
        const at = first.address ? `, at ${first.address}` : '';
        parts.push(`The nearest open shelter is ${first.name}${at} in ${first.city}, ${away(first.milesAway ?? 0)}.`);
        // Only the details that decide whether this person can actually use it.
        const notes: string[] = [];
        if (powered && first.generator) notes.push('it has a generator, so equipment that needs power can run');
        // A blank in the feed is not a no, and for someone whose equipment needs
        // a socket the difference is the whole question. Say what we do not know.
        if (powered && !first.generator) notes.push('the list does not say whether it has a generator, so ask when you ring');
        if (older && first.accessible) notes.push('it is step-free');
        if (first.pets) notes.push(`pets: ${first.pets.toLowerCase()}`);
        // Joined notes start a sentence, so the first letter has to look like it.
        if (notes.length) {
          const note = notes.join(', ');
          parts.push(`${note.charAt(0).toUpperCase()}${note.slice(1)}.`);
        }
        if (nearest.length > 1) parts.push(`There ${nearest.length === 2 ? 'is' : 'are'} ${nearest.length - 1} more within an hour's drive.`);
        parts.push('Ring 211 before you set off if you can, to check it is still open.');
      }

      if (cold) {
        if (older) {
          parts.push(
            'Do not wait for it to feel dangerous. A house at 60 to 65 degrees is cold enough to bring on hypothermia ' +
              'in an older adult, and it will not feel like an emergency while it happens.',
          );
        }
        // The one warning that cannot wait. Closing off rooms and wearing a hat is good advice and is in the
        // structured answer; said aloud it pushed this past a hundred words.
        parts.push(
          'Never heat the house with an oven, a grill or a generator indoors or in the garage: that is carbon ' +
            'monoxide, and it kills people after storms who came through the storm fine.',
        );
      }

      // Leaving the house is the moment somebody else should know. Offered, never done unasked.
      const family = person.contacts.filter(reachable).map((c) => c.name);
      const offer = family.length ? `Want me to tell ${andList(family)} you need help? Say get help.` : '';

      return say(parts.join(' '), {
        // Where to go, and how not to die of carbon monoxide on the way to deciding. Heard whole.
        fullAnswer: true,
        ...(offer ? { offer, nextAction: { tool: 'get_help', arguments: { what: 'looking for somewhere to go' } } } : {}),
        nearestEmergency: care.named(person.lat, person.lon),
        cold,
        ...(cold ? { whileAtHome: 'Close off the rooms you are not using and wear a hat indoors.' } : {}),
        shelters:
          found === null
            ? null
            : found.slice(0, 3).map((s) => ({
                name: s.name,
                address: `${s.address}, ${s.city}, ${s.state}`,
                milesAway: Math.round((s.milesAway ?? 0) * 10) / 10,
                generator: s.generator,
                accessible: s.accessible,
                pets: s.pets,
              })),
        referral: { call: '211', text: '898-211' },
        sources: [
          'https://gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/MapServer',
          'https://www.cdc.gov/winter-weather/prevention/index.html',
          'https://www.nia.nih.gov/health/safety/cold-weather-safety-older-adults',
          'https://www.cdc.gov/carbon-monoxide/about/index.html',
        ],
      });
    },
  );

}
