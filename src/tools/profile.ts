/**
 * Who this person is: location, medicines, conditions, privacy.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import * as outlook from '../outlook.js';
import { usName, ingredientsOf, englishName, lookupSpain, plain } from '../brands.js';
import { OWN } from '../devices.js';
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
import { reachable, awaiting } from '../consent.js';
import * as rxclass from '../rxclass.js';
import {
  CARD,
  andList,
  asked,
  clean,
  count,
  profileFor,
  releasePlace,
  resolveLocation,
  sameName,
  say,
  checkLabel,
} from './shared.js';

/** "telma am" to "Telma AM": each word capitalised, short all-letter suffixes upper case. */
const spokenBrand = (b: string): string => b.split(' ').map((w, i) => (i > 0 && w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

export function register(server: McpServer, personOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * Setup, and taking things back out again.
   * ---------------------------------------------------------------- */
  /*
   * What each tool does to the world, declared rather than left to be guessed.
   *
   * The specification carries four hints, and a host uses them to decide what it
   * may call speculatively and what it must confirm first. readOnly means nothing
   * in the store changes. destructive means it can remove something the customer
   * would miss. idempotent means saying it twice leaves the same state, which is
   * true here because repeats are folded rather than appended. openWorld means
   * the answer depends on something outside this process: NOAA, a weather
   * service, openFDA, a geocoder, or an email leaving the building.
   */
  server.registerTool(
    'register_location',
    {
      title: 'Set your location',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Set where to check the heat, by the place the customer names: a city and state such as "Phoenix, Arizona", ' +
        'a city and country such as "Munich, Germany", or a US zip code. Pass lat and lon only if they are already known exactly. Call this when they say where they live ' +
        'or ask to check somewhere else. It only sets the place; it does not report the weather (use weather_check).',
      inputSchema: {
        place: z.string().describe('The place as spoken: city and state, city and country, or a zip code'),
        confirm: z.boolean().optional().describe('true only after the customer said yes to replacing the place they already have saved'),
        lat: z.number().min(-90).max(90).optional().describe('Latitude in decimal degrees, only if known exactly'),
        lon: z.number().min(-180).max(180).optional().describe('Longitude in decimal degrees, west negative, only if known exactly'),
      },
    },
    async ({ place, lat, lon, confirm }) => {
      place = clean(place, 80);
      const id = personOf();
      /*
       * A place already saved is not replaced on a single mention. "My dad is in Tucson" is about somebody
       * else, and a host once tried to save it as the customer's own home. The answer is the same yes-first
       * step every other change to who gets told goes through: say what is saved, and ask.
       */
      const saved = store.get(id);
      const same = (a: string | null) => (a ?? '').toLowerCase().split(',')[0].trim() === place.toLowerCase().split(',')[0].trim();
      if (!confirm && saved.locationName && saved.locationStatus === 'ready' && !same(saved.locationName)) {
        return say(
          `You are set to ${saved.locationName}. Should I change your own place to ${place}? I only keep your details, not other people's.`,
          { status: 'confirm', saved: saved.locationName, place, nextAction: { tool: 'about_me', arguments: { place, confirmPlace: true } } },
        );
      }
      if (!/[a-z0-9]/i.test(place)) {
        return say('Tell me the city and state, or a zip code, and I will look it up.', { status: 'needs_place' });
      }
      const before = store.get(id);
      const was = { lat: before.lat, lon: before.lon };
      if (lat != null && lon != null) {
        store.update(id, (p) => {
          p.lat = lat;
          p.lon = lon;
          p.locationName = place;
          p.locationStatus = 'ready';
        });
        weather.watch(lat, lon, !id.startsWith('demo:'));
        warnings.watch(lat, lon);
        outlook.watch(lat, lon);
        care.watch(lat, lon, place);
        if (was.lat !== lat || was.lon !== lon) releasePlace(was.lat, was.lon);
        return say(`Got it, I'll check the weather for ${place}.`, { place, lat, lon, status: 'ready' });
      }
      store.update(id, (p) => {
        p.lat = null;
        p.lon = null;
        p.locationName = place;
        p.locationStatus = 'locating';
      });
      releasePlace(was.lat, was.lon);
      resolveLocation(id, place);
      return say(`Looking up ${place} now. Ask me about the heat in a moment.`, { place, status: 'locating' });
    },
  );

  /*
   * One door for the medicine list.
   *
   * Starting and stopping a medicine are the same conversation about the same
   * list, and two tools spent two of a budget that starts costing selection
   * accuracy past about twenty.
   */
  server.registerTool(
    'medication',
    {
      title: 'The medicines you take',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Keep the customer\'s medication list. action add registers one by generic or brand name, e.g. lisinopril, ' +
        'Lasix, Zoloft or metoprolol. action remove takes one off. Call this whenever they mention starting, taking, ' +
        'being prescribed, stopping or finishing something. It only keeps the list. It is not for asking what to do about ' +
        'medicines they already take, such as keeping insulin cold in a power cut (use storm_prep), or whether a medicine ' +
        'was recalled (use medicine_recalls).',
      inputSchema: {
        action: z.enum(['add', 'remove']).describe('add when they start or mention taking it, remove when they stop'),
        name: z.string().describe('The medication as spoken, generic or brand name, dosage optional'),
      },
    },
    async ({ action, name }) => {
      const id = personOf();
      name = clean(name, 80);

      if (action === 'remove') {
        const person = store.get(id);
        const generic = classifyMedication(name)?.generic;
        const match = person.medications.find(
          (m) => m.generic === generic || sameName(m.spoken, name) || sameName(m.generic, name),
        );
        // A medicine this add-on did not recognise is kept on the recall watch list, not the medication list,
        // and used to be impossible to take off again short of deleting the whole profile.
        const watching = person.recallWatch.find((m) => sameName(m, name));
        if (!match && watching) {
          store.update(id, (p) => void (p.recallWatch = p.recallWatch.filter((m) => !sameName(m, name))));
          return say(`Removed ${watching}. I won't watch the recall list for it any more.`, { removed: true, recallWatch: false });
        }
        if (!match) {
          const list = [...person.medications.map((m) => m.generic), ...person.recallWatch];
          return say(
            `${name} isn't on your list, so there's nothing to remove.` +
              (list.length && !person.privacy ? ` You have ${list.join(', ')}.` : ''),
            { removed: false },
          );
        }
        store.update(id, (p) => void (p.medications = p.medications.filter((m) => m.generic !== match.generic)));
        return say(`Removed ${match.generic}. I won't factor it into your heat checks any more.`, {
          removed: true,
          generic: match.generic,
        });
      }

      // Before anything else that costs work: a person who is already holding as many
      // medicines as anybody takes is refused once, politely, rather than having the
      // oldest quietly dropped by the store's backstop. Re-adding one already on the
      // list is not an addition and is let through.
      const held = store.get(id);
      const already = held.medications.some((m) => sameName(m.spoken, name) || sameName(m.generic, name));
      if (!already && held.medications.length + held.recallWatch.length >= store.LIMITS.medications) {
        return say(
          "That is as many medicines as I can keep track of. Take one off the list first if you need to add another.",
          { added: false, reason: 'limit' },
        );
      }

      // A name from outside the United States: an international spelling, or an Indian brand. See brands.ts.
      // What it was read as is always said, so a wrong reading is heard rather than silently kept.
      let readAs = '';
      // The drug database is asked once per name, whichever step asks first.
      let asked: { name: string; found: Awaited<ReturnType<typeof rxclass.classify>> } | null = null;
      if (!classifyMedication(name)) {
        const country = store.get(id).country ?? null;
        const intl = usName(name);
        let brand = intl === name.toLowerCase().trim() ? ingredientsOf(name, country) : null;
        // Spain has no brand download; its regulator's search is asked live. See brands.ts.
        if (!brand && intl === name.toLowerCase().trim() && country === 'ES') {
          const es = await lookupSpain(name);
          if (es) brand = { brand: name.toLowerCase().trim(), ingredients: es, country: 'ES' };
        }
        // The same brand name is a different medicine in different countries. Asked, never guessed.
        if (brand?.ambiguous?.length) {
          const COUNTRY: Record<string, string> = { IN: 'India', CA: 'Canada', FR: 'France', BR: 'Brazil', IT: 'Italy', ES: 'Spain' };
          // Countries that mean the same thing by it are said together: "ramipril in France and Italy".
          const groups = new Map<string, string[]>();
          for (const a of brand.ambiguous) {
            const k = andList(a.ingredients);
            groups.set(k, [...(groups.get(k) ?? []), COUNTRY[a.country] ?? a.country]);
          }
          const options = [...groups].map(([what, where]) => `${what} in ${andList(where)}`);
          return say(
            `${spokenBrand(brand.brand)} is a different medicine in different countries: ${options.join('; ')}. ` +
              'Tell me the medicine name printed under the brand on your pack, and I will add that.',
            { recognized: false, ambiguous: brand.ambiguous, needs: 'generic_name' },
          );
        }
        // Each ingredient in the drug database's own English name: "furosémide", "nifedipino".
        if (brand) {
          const named: string[] = [];
          for (const ing of brand.ingredients) named.push(classifyMedication(ing) ? ing : (await englishName(ing)) ?? ing);
          brand = { ...brand, ingredients: [...new Set(named)] };
        }
        // A generic name said in another language, with no brand behind it: "furosemida".
        if (!brand && intl === name.toLowerCase().trim()) asked = { name, found: await rxclass.classify(name) };
        if (!brand && asked && !asked.found) {
          const en = await englishName(name);
          if (en && en !== plain(name)) {
            readAs = `${name} is ${en} in English. `;
            name = en;
          }
        }
        if (intl !== name.toLowerCase().trim()) {
          readAs = `${name} is ${intl} in the United States. `;
          name = intl;
        } else if (brand && brand.ingredients.length === 1) {
          readAs = `${spokenBrand(brand.brand)} is ${brand.ingredients[0]}. `;
          name = brand.ingredients[0];
        } else if (brand) {
          // A combination: each ingredient is looked up and kept on its own, because each acts on its own.
          const added: string[] = [];
          const unknown: string[] = [];
          for (const ing of brand.ingredients) {
            const tabled = classifyMedication(ing);
            const found = tabled ? null : await rxclass.classify(ing);
            const med = tabled
              ? { spoken: name, generic: tabled.generic, drugClass: tabled.drugClass, mechanisms: tabled.mechanisms }
              : found
                ? { spoken: name, generic: found.generic, drugClass: found.drugClass, mechanisms: found.mechanisms }
                : null;
            if (!med) { unknown.push(ing); continue; }
            store.update(id, (p) => {
              if (!p.medications.some((m) => m.generic === med.generic)) p.medications.push(med);
            });
            recalls.watch(med.generic);
            added.push(med.generic);
          }
          const what = `${spokenBrand(brand.brand)} is ${andList(brand.ingredients)}.`;
          return say(
            added.length
              ? `${what} Added ${andList(added)}, and I'll factor ${added.length === 1 ? 'it' : 'them'} into your heat check.` +
                  (unknown.length ? ` ${andList(unknown)} I can't judge for heat, so ask your pharmacist about ${unknown.length === 1 ? 'it' : 'them'}.` : '')
              : `${what} None of those is one I know a heat effect for. That doesn't mean they're safe, only that I don't know.`,
            { recognized: added.length > 0, brand: brand.brand, ingredients: brand.ingredients, added, source: 'india-brands' },
          );
        }
      }

      let known = classifyMedication(name);

      // Not an exact match, but close to something in the table. Drug names are
      // the hardest thing a microphone has to get right, and "I don't have that"
      // is the wrong answer when the drug is known under a name that arrived one
      // letter wrong. Ask; never assume. Which drug somebody takes is not this
      // server's call to make on an edit distance.
      if (!known) {
        const near = nearMatches(name);
        if (near.length && canAsk(server)) {
          const answer = await chooseOne(server, {
            message: `I don't have "${name}". Did you mean one of these?`,
            label: 'Medication',
            values: [...near.map((m) => m.generic), 'none of these'],
          });
          if (answer.kind === 'chosen' && answer.value !== 'none of these') {
            known = classifyMedication(answer.value);
            if (known) name = known.generic;
          }
        }
      }

      // Not one of the medicines the table names. Ask the National Library of Medicine what it is and which
      // class it belongs to, and read that class against the same guidance. See rxclass.ts.
      if (!known) {
        const found = asked && asked.name === name ? asked.found : await rxclass.classify(name);
        if (found) {
          // The lookup may hand back a generic the table does know: a brand name it had no alias for.
          const tabled = classifyMedication(found.generic);
          if (tabled) {
            known = tabled;
          } else {
            store.update(id, (p) => {
              if (!p.medications.some((m) => m.generic === found.generic)) {
                p.medications.push({ spoken: name, generic: found.generic, drugClass: found.drugClass, mechanisms: found.mechanisms });
              }
              p.recallWatch = p.recallWatch.filter((m) => m.toLowerCase() !== name.toLowerCase());
            });
            recalls.watch(found.generic);
            checkLabel(id, found.generic, name);
            const called = found.generic === name.toLowerCase() ? found.generic : `${found.generic}, which is what ${name} is`;
            return say(
              `${readAs}Added ${called}. As ${articleFor(found.drugClass)} ${found.drugClass} I'll factor it into your heat check. ` +
                'That is from its drug class, so ask your pharmacist if you want it confirmed.',
              { recognized: true, generic: found.generic, drugClass: found.drugClass, mechanisms: found.mechanisms, source: 'rxnorm', atc: found.atc },
            );
          }
        }
      }

      if (!known) {
        // Not in the heat table, so no heat advice. The name is still worth
        // keeping: a recall is published against a name, not a mechanism.
        const watchable = /^[a-z0-9 ,.'-]{3,60}$/i.test(name);
        if (watchable) {
          store.update(id, (p) => {
            if (!p.recallWatch.some((m) => m.toLowerCase() === name.toLowerCase())) p.recallWatch.push(name);
          });
          recalls.watch(name);
          // Nothing here classifies it. Its own label may still state a heat risk outright. See labels.ts.
          checkLabel(id, name.toLowerCase(), name);
        }
        return say(
          `I don't have "${name}" in my list yet, so I can't say whether it changes how you handle heat. ` +
            "That doesn't mean it's safe, only that I don't know. Ask your pharmacist if you're not sure." +
            (watchable ? " I'll still watch the FDA recall list for it." : ''),
          { recognized: false, recallWatch: watchable },
        );
      }
      store.update(id, (p) => {
        if (!p.medications.some((m) => m.generic === known.generic)) {
          p.medications.push({ spoken: name, generic: known.generic, drugClass: known.drugClass, mechanisms: known.mechanisms });
        }
      });
      // The FDA list is checked in the background from here on, so asking about
      // recalls later costs nothing. One query measured about 450 ms, which is
      // the whole voice turn.
      recalls.watch(known.generic);
      checkLabel(id, known.generic, name);
      return say(
        `${readAs}Added ${known.generic}, ${articleFor(known.drugClass)} ${known.drugClass}. ${
          known.mechanisms.length ? "I'll factor that into your heat check." : 'That one has no known heat interaction.'
        }`,
        { recognized: true, generic: known.generic, drugClass: known.drugClass, mechanisms: known.mechanisms },
      );
    },
  );

  server.registerTool(
    'health_condition',
    {
      title: 'Your health conditions',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Keep the conditions that change how this customer copes with heat or cold: multiple sclerosis or MS, ' +
        'erythromelalgia, a spinal cord injury, POTS or dysautonomia, heart disease, asthma or COPD, kidney disease ' +
        'or dialysis, diabetes, sickle cell, Raynaud\'s, pregnancy, or being 65 or older. action add registers one, ' +
        'action remove takes one off. Call this whenever a condition is mentioned or said to no longer apply.',
      inputSchema: {
        action: z.enum(['add', 'remove']).describe('add when they mention having it, remove when it no longer applies'),
        condition: z.string().describe('The condition as spoken'),
      },
    },
    async ({ action, condition }) => {
      const id = personOf();
      condition = clean(condition, 80);
      const found = findCondition(condition);

      if (action === 'remove') {
        const person = store.get(id);
        if (!found || !person.conditions.includes(found.id)) {
          return say(`That isn't on your list, so there's nothing to remove.`, { removed: false });
        }
        store.update(id, (p) => void (p.conditions = p.conditions.filter((c) => c !== found.id)));
        return say(`Removed ${found.label}. I won't adjust for it any more.`, { removed: true, id: found.id });
      }

      if (!found) {
        return say(
          `I don't have "${condition}" in my list, so I can't adjust for it. The general heat advice still applies, ` +
            'and your doctor is the right person to ask how it affects you in the heat.',
          { recognized: false },
        );
      }
      store.update(id, (p) => {
        if (!p.conditions.includes(found.id)) p.conditions.push(found.id);
      });
      return say(`Added ${found.label}. ${found.plan}`, { recognized: true, id: found.id, sensitivity: found.sensitivity });
    },
  );

  server.registerTool(
    'my_profile',
    {
      title: 'What do you know about me',
      _meta: { ui: { resourceUri: CARD } },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Read back what the customer has told this add-on: location, medications, conditions, contacts, privacy mode ' +
        'and any heat limit learned from how they felt. Call this when they ask what you know, what is on their list, ' +
        'or who you will contact. action forget deletes all of it instead: use forget when they say forget everything, ' +
        'start over, start fresh, delete my data or delete my profile. Forgetting is asked for twice before anything goes.',
      inputSchema: {
        action: z.enum(['show', 'forget']).optional().describe('show, the default, reads it back. forget deletes all of it.'),
      },
    },
    async ({ action }) => {
      const id = personOf();
      const p = store.get(id);

      if (action === 'forget') {
        // Counts, not names: a person asking to be forgotten should not have
        // their medicines read out to whoever else is in the room first.
        const held = [
          p.locationName ? 'your place' : '',
          p.medications.length + p.recallWatch.length ? count(p.medications.length + p.recallWatch.length, 'medicine') : '',
          p.conditions.length ? count(p.conditions.length, 'health condition') : '',
          p.contacts.length ? count(p.contacts.length, 'contact') : '',
          p.outings.length ? count(p.outings.length, 'outing you told me about') : '',
        ].filter(Boolean);
        if (!held.length) return say("I don't know anything about you yet, so there's nothing to forget.", { forgotten: false });
        if (!asked(p.forgetAskedAt)) {
          store.update(id, (x) => void (x.forgetAskedAt = new Date().toISOString()));
          return say(`That deletes ${andList(held)}, and I can't undo it. Ask me once more and it's gone.`, {
            forgotten: false,
            confirmNeeded: true,
            holds: held,
          });
        }
        store.forget(id);
        releasePlace(p.lat, p.lon);
        return say(`Done. I've deleted ${andList(held)}. I don't know anything about you now.`, { forgotten: true, deleted: held });
      }

      const profile = profileFor(p);
      const lines = [
        p.locationName ? `Location: ${p.locationName}.` : 'No location yet.',
        p.medications.length ? `Medications: ${p.medications.map((m) => m.generic).join(', ')}.` : p.recallWatch.length ? '' : 'No medications.',
        // Named but not recognised, so there is no heat advice for them, but they are still on record here.
        p.recallWatch.length ? `Watching the recall list only for: ${p.recallWatch.join(', ')}.` : '',
        profile.conditions.length ? `Conditions: ${profile.conditions.map((c) => c.label).join(', ')}.` : 'No conditions.',
        p.cooling ? `Cooling at home: ${p.cooling === 'working' ? 'working' : p.cooling === 'fan' ? 'a fan only' : p.cooling === 'broken' ? 'not working' : p.cooling === 'cost' ? 'working, but too costly to run' : p.cooling === 'power_cuts' ? 'working, with power cuts' : 'none'}.` : '',
        p.topFloor ? 'You sleep on the top floor.' : '',
        p.livesAlone ? (p.contacts.length ? 'You live alone, so on a dangerous day your contacts are asked to check on you if I have not heard from you by 2 pm.' : 'You live alone. Add somebody who can check on you on dangerous days.') : '',
        (p.equipment ?? []).length ? `Equipment: ${(p.equipment ?? []).map((k) => OWN[k] ?? k).join(', ')}.` : '',
        p.contacts.length
          ? `Contacts: ${p.contacts.map((c) => `${c.name}${!c.confirmedAt ? ', not confirmed yet' : awaiting(c) ? ', waiting for them to agree' : ''}`).join('; ')}.`
          : 'No contacts.',
        `Privacy mode is ${p.privacy ? 'on' : 'off'}.`,
        profile.learnedLimitF != null ? `You felt unwell near heat index ${profile.learnedLimitF}, so that is your limit.` : '',
      ].filter(Boolean);
      return say(lines.join(' '), {
        card: {
          kind: 'list',
          title: 'What I know about you',
          status: { label: p.privacy ? 'privacy on' : 'privacy off', tone: 'neutral' },
          items: [
            { title: 'Location', note: p.locationName ?? 'not set' },
            // Counts, not names, on a screen somebody else in the room can read.
            { title: 'Medicines', note: String(p.medications.length + p.recallWatch.length) },
            { title: 'Conditions', note: String(profile.conditions.length) },
            { title: 'Contacts', note: p.contacts.length ? p.contacts.map((c) => c.name).join(', ') : 'none' },
          ],
        },
        location: p.locationName,
        medications: p.medications.map((m) => m.generic),
        // Where each judgement comes from, so it can be traced: the table or class, and the label's own words.
        evidence: p.privacy
          ? undefined
          : p.medications.map((m) => ({
              generic: m.generic,
              drugClass: m.drugClass,
              mechanisms: [...new Set([...m.mechanisms, ...(m.label?.mechanisms ?? [])])],
              fdaLabel: m.label ? { dated: m.label.effective, states: m.label.quotes.map((q) => q.sentence) } : null,
            })),
        recallWatchOnly: p.recallWatch,
        conditions: profile.conditions.map((c) => c.label),
        contacts: p.contacts.map((c) => ({ name: c.name, relation: c.relation, confirmed: !!c.confirmedAt, agreed: reachable(c), notifyOn: c.notifyOn })),
        privacy: p.privacy,
        learnedLimitF: profile.learnedLimitF,
        outingsLogged: p.outings.length,
      });
    },
  );

  server.registerTool(
    'set_privacy',
    {
      title: 'Privacy mode',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Turn privacy mode on or off. When on, answers do not name the customer\'s medications or conditions out loud, ' +
        'and personal precautions are held back until they ask for them. Call this when they say others can hear, ' +
        'an aide or visitor is in the room, or they want their health kept private.',
      inputSchema: {
        on: z.boolean().describe('true to keep health details private, false to speak openly again'),
      },
    },
    async ({ on }) => {
      store.update(personOf(), (p) => void (p.privacy = on));
      return say(
        on
          ? "Privacy mode is on. I won't name your medications or conditions out loud unless you ask."
          : 'Privacy mode is off.',
        { privacy: on },
      );
    },
  );

}
