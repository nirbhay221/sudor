/**
 * Official warnings, and what a storm means for a medicine cabinet.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import * as outlook from '../outlook.js';
import { inUS } from '../world.js';
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
import * as outages from '../outages.js';
import * as spaceweather from '../spaceweather.js';
import * as shelters from '../shelters.js';
import { hazardOf, stepsFor, type Needs, mayHaveToLeave, mayLosePower, SOURCES } from '../hazard.js';
import { OWN, NEEDS_POWER } from '../devices.js';

const andWords = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** The EPA's own names for the bands of its air quality index. */
const aqiWord = (aqi: number): string =>
  aqi <= 50 ? 'good' : aqi <= 100 ? 'moderate' : aqi <= 150 ? 'unhealthy for sensitive groups' : aqi <= 200 ? 'unhealthy' : aqi <= 300 ? 'very unhealthy' : 'hazardous';
import { reachable } from '../consent.js';
import {
  fridgeMedicines,
  NO_LOCATION,
  coldConditionsOf,
  coldMechanismsOf,
  profileFor,
  say,
} from './shared.js';

/** The days ahead for this person: the US forecasters' products, or the week's forecast elsewhere. */
function outlookLines(person: store.Person): string[] {
  const sensitive = person.medications.length > 0 || person.conditions.some((c) => c !== 'hay_fever' && c !== 'migraine');
  const snap = weather.current(person.lat as number, person.lon as number);
  const today = snap ? new Date(Date.now() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  if (!inUS(person.country)) {
    const w = outlook.speakWorld(snap?.daily, sensitive, today);
    // A hurricane cone reaches Mexico and the Caribbean too; the heat and river products are American only.
    const o = outlook.current(person.lat as number, person.lon as number);
    const cones = o ? outlook.speak({ heat: [], rivers: [], storms: o.storms, checkedAt: o.checkedAt }, sensitive, today) : [];
    return [...cones, ...(w ? [w] : [])];
  }
  return outlook.speak(outlook.current(person.lat as number, person.lon as number), sensitive, today);
}

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
            'Ask me again in a few minutes, and check your national weather service if you need to know now.',
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
        'What this customer should do about a hurricane, flood, tornado, winter storm, wildfire smoke, power cut or ' +
        'any other official warning where they live, fitted to their medicines and conditions: what to do first, ' +
        'medicines that need a fridge, equipment that needs power, dialysis, and whether to leave. Also a forecast ' +
        'geomagnetic storm. Call this when someone asks what to do about a ' +
        'warning or a disaster, how to prepare, mentions losing power, or asks whether the power is out where they live. It needs no arguments: it reads the warnings ' +
        'in force where they live itself, so do not ask which warning. It is advice on what to do, not somewhere ' +
        'to go once the power is already out (use somewhere_to_go).',
      inputSchema: {},
    },
    async () => {
      const person = store.get(personOf());
      const alerts = person.lat != null && person.lon != null ? warnings.current(person.lat, person.lon) ?? [] : [];
      const coming = warnings.rank(alerts).find((a) => warnings.cutsPower(a));
      // Whatever is active where they live, of any kind, worst first: a warning before a watch before an
      // advisory. This is what the answer is about when there is one. See hazard.ts.
      const active = warnings
        .rank(alerts)
        .sort((a, b) => Number(/warning|emergency/i.test(b.event)) - Number(/warning|emergency/i.test(a.event)))[0] ?? null;
      // The weather service forecasts wind and ice. It does not forecast the
      // sun, and a severe geomagnetic storm is the other way a grid gets into
      // trouble, so that half comes from NOAA's space weather feed. Silence when there is
      // nothing to say, and silence when it cannot be reached.
      // Said at the end, not the start. A geomagnetic storm is the least likely
      // of the things on this list to actually cut someone's power, and leading
      // with it would put the rarest risk in front of the insulin.
      const solar = spaceweather.outlook();
      const lead = coming ? `${coming.event} is up for your area. ` : '';
      // In California, whether the power is already out at their address, and when it should be back. See outages.ts.
      const out = person.lat != null && person.lon != null ? outages.at(person.lat, person.lon) : undefined;
      const inCounty = !out && person.lat != null && person.lon != null ? outages.countyAt(person.lat, person.lon) : null;
      const outLine = out
        ? outages.sentence(out, (person.lat != null && person.lon != null ? weather.current(person.lat, person.lon)?.timezone : null) ?? 'America/Los_Angeles')
        : inCounty
          ? outages.countySentence(inCounty)
          : '';
      const outLead = outLine ? `${outLine} ` : '';

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
      // Equipment they have said they rely on. This is the line that matters most in a power cut, so it is
      // built from what they told us and names the thing. It used to be guessed from a lung condition.
      const powered = (person.equipment ?? []).filter((k) => NEEDS_POWER.includes(k));
      const poweredNames = andWords(powered.map((k) => OWN[k]));
      if (powered.length) {
        steps.push(
          `Your ${poweredNames} needs power. Charge every battery it has now, ask whoever supplies it what they do ` +
            'in an outage, and tell your electricity company there is medical equipment in the house: many keep ' +
            'a list of homes to restore first. Decide today where you would go that has power if yours stays off.',
        );
      }
      if (person.conditions.includes('asthma_copd') && !powered.some((k) => k === 'oxygen_concentrator' || k === 'cpap')) {
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

      if (active) {
        const hazard = hazardOf(active.event);
        const needs = {
          coldMedicine: cold.insulin || cold.injectables.length > 0 || person.conditions.includes('diabetes') || (person.equipment ?? []).includes('insulin_pump'),
          poweredEquipment: powered.length > 0,
          ...(powered.length ? { poweredNames } : {}),
          dialysis: person.conditions.includes('kidney_disease') || (person.equipment ?? []).includes('dialysis'),
          breathing: person.conditions.includes('asthma_copd'),
          heart: person.conditions.includes('heart_disease'),
          medicines: person.medications.length > 0 || person.recallWatch.length > 0,
          older: person.conditions.includes('older_adult'),
          heating: person.heating,
          livesAlone: person.livesAlone === true,
          youngChild: person.conditions.includes('young_child'),
          dementia: person.conditions.includes('dementia'),
          oxygen: (person.equipment ?? []).includes('oxygen_concentrator'),
          mobility: (person.equipment ?? []).includes('wheelchair') || person.conditions.includes('older_adult'),
          heatSensitive: person.medications.length > 0 || person.conditions.some((c) => c !== 'older_adult'),
          state: /\bFlorida\b|, FL\b/.test(person.locationName ?? '') ? ('FL' as const) : /\bTexas\b|, TX\b/.test(person.locationName ?? '') ? ('TX' as const) : null,
          us: (person.country ?? 'US').toUpperCase() === 'US',
          country: person.country ?? 'US',
          conditions: person.conditions,
          // Dispensed day by day at a clinic, which a disaster can close for days. See hazard.ts.
          dailyClinic: [...person.medications.map((m) => m.generic), ...person.recallWatch].some((n) => /methadone/i.test(n)),
        };
        const all = stepsFor(hazard, needs, steps);
        // A warning or an emergency, or anything the service rates severe, is a real threat; an advisory or a
        // statement is a heads-up, answered in a sentence or two with the rest there to be asked for.
        const serious = /warning|emergency/i.test(active.event) || active.severity === 'Severe' || active.severity === 'Extreme' || hazard === 'tornado' || hazard === 'tsunami';
        // For a heads-up, getting ready for a long power cut (a week of medicines, a cooler, charging) waits
        // behind what this hazard does to this person now, like smoke on a heart.
        const general = stepsFor(hazard, {} as Needs);
        const getReady = (t: string) => !general.includes(t) && /pharmacist|week of|cooler|charge|dialysis unit|power/i.test(t);
        const todo = serious ? all : [all[0], ...all.slice(1).filter((t) => !getReady(t)), ...all.slice(1).filter(getReady)].filter(Boolean);
        const sayNow = serious ? todo.slice(0, Math.min(todo.length, 3)) : [todo[0], ...todo.filter((t) => !general.includes(t) && !getReady(t))].filter(Boolean);
        const zone = (person.lat != null && person.lon != null ? weather.current(person.lat, person.lon)?.timezone : null) ?? 'UTC';
        const head = `There is ${/^[aeiou]/i.test(active.event) ? 'an' : 'a'} ${active.event} where you are${warnings.until(active, zone)}.`;
        // Smoke is the one hazard with a number a person can act on, and it is read live for where they are.
        const aqi = hazard === 'smoke' && person.lat != null && person.lon != null ? weather.current(person.lat, person.lon)?.aqi ?? null : null;
        const air = aqi == null ? '' : ` The air quality index is ${Math.round(aqi)} right now, which is ${aqiWord(aqi)}.`;
        const officialRaw = active.instruction ? ` The weather service says: ${warnings.brief(active.instruction, 1, 200)}` : '';
        const official = serious && !officialRaw.toLowerCase().includes(active.event.toLowerCase()) ? officialRaw : '';
        const family = person.contacts.filter(reachable).map((c) => c.name);
        const leave = mayHaveToLeave(hazard);
        const ahead = person.lat != null && person.lon != null ? outlookLines(person) : [];
        return say(`${outLead}${head}${air} ${todo.join(' ')}${official}${ahead.length ? ` ${ahead.join(' ')}` : ''}${solar ? ` ${spaceweather.speak(solar)}` : ''}`, {
          // With a hazard that can cut the power or empty the house, every line is something to do now, so it
          // is heard whole. For the others the first steps are heard and the rest is there to be asked for.
          // Heard whole only for a real warning: a wind advisory does not need the hurricane checklist read out.
          fullAnswer: serious && (mayLosePower(hazard) || leave),
          // For a heads-up, the first step and what the hazard does to this person now; the rest waits.
          mustSay: [outLine, ...sayNow].filter(Boolean),
          ...(serious ? {} : { sayFirst: 2 }),
          ...(family.length ? { offer: `Want me to tell ${family.join(' and ')} you are safe? Say tell them I'm safe.` } : {}),
          alert: active.event,
          ...(aqi != null ? { aqi: Math.round(aqi), aqiCategory: aqiWord(aqi) } : {}),
          ...(powered.length ? { equipment: powered } : {}),
          hazard,
          ...(out ? { powerOut: out } : {}),
          steps: todo.length,
          // Leaving home is the next question for a hazard that makes people leave; otherwise telling somebody.
          nextAction: leave || mayLosePower(hazard) ? { tool: 'somewhere_to_go', arguments: {} } : family.length ? { tool: 'get_help', arguments: { status: 'safe' } } : null,
          spaceWeather: solar ? { g: solar.g, when: solar.when } : null,
          sources: [SOURCES[hazard], 'https://www.weather.gov/alerts'],
        });
      }

      const opening = person.medications.length || person.conditions.length || cold.insulin
        ? 'Here is what matters for you.'
        : "I don't know your medicines or conditions yet, so this is the general version. Tell me what you take and I can be specific.";

      // The days ahead: a hurricane cone, a river forecast, a heat week. Said before the checklist, because it is
      // why the checklist matters now. See outlook.ts.
      const coming2 = person.lat != null && person.lon != null ? outlookLines(person) : [];
      const tail = solar ? ` ${spaceweather.speak(solar)}` : '';
      return say(`${outLead}${lead}${coming2.length ? `${coming2.join(' ')} ` : ''}${opening} ${steps.join(' ')}${tail}`, {
        ...(out ? { powerOut: out, offer: 'Want me to find somewhere with power you can go?', nextAction: { tool: 'somewhere_to_go', arguments: {} } } : {}),
        ...(coming2.length ? { ahead: coming2 } : {}),
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
