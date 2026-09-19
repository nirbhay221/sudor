import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assess, heatIndexF, photoRisk, type HeatCategory } from './domain.js';
import { findMedication as classifyMedication, MEDICATIONS, articleFor, COLD_MECHANISM_SAY, type ColdMechanism } from './meds.js';
import { CONDITIONS, findCondition } from './conditions.js';
import { windChillF, coldCategory, coldMeaning, COLD_WORDS, matchColdFirstAid } from './cold.js';
import { profileOf, judgeHour, planDay, precautions } from './personal.js';
import { triage } from './firstaid.js';
import { geocode } from './geocode.js';
import { alertEmergency } from './alerts.js';
import { emailConfigured } from './notify.js';
import * as weather from './weather.js';
import * as store from './store.js';
import * as recalls from './recalls.js';
import * as warnings from './warnings.js';
import * as spaceweather from './spaceweather.js';
import * as shelters from './shelters.js';

const UI = 'ui://sudor/window.html';

const say = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
});

const NO_LOCATION =
  "I don't know where you are yet. Tell me your city and state, or a zip code, so I can check the heat where you are.";
/** Certification requires an actionable next step on every error, not a bare failure. */
const WEATHER_DOWN =
  "I can't reach the weather service right now, so I won't guess at today's heat. It refreshes every twenty minutes, " +
  'so ask again shortly, or check weather.gov if you need an answer now.';
/**
 * Said whenever a medication is named as the risk. Stopping a heart or blood
 * pressure medicine because of a hot day can do more harm than the heat.
 */
const MEDICATION_CAUTION = "Don't stop or change a medication because of the heat without asking your doctor or pharmacist.";

const CATEGORY_WORDS: Record<HeatCategory, string> = {
  none: 'not a heat concern',
  caution: 'caution',
  extreme_caution: 'extreme caution',
  danger: 'danger',
  extreme_danger: 'extreme danger',
};

/**
 * A spoken place is looked up in the background, because a geocoding call
 * measured 740 to 1000 ms against a 500 ms budget for the whole turn.
 * Exported so a server restart can finish a lookup that was cut off.
 */
export function resolveLocation(personId: string, place: string): void {
  void geocode(place).then((found) => {
    store.update(personId, (p) => {
      // Someone may have set a different place while this one was being looked up.
      if (p.locationName !== place || p.locationStatus !== 'locating') return;
      if (found) {
        p.lat = found.lat;
        p.lon = found.lon;
        p.locationName = found.state ? `${found.name}, ${found.state}` : found.name;
        p.locationStatus = 'ready';
      } else {
        p.locationStatus = 'not_found';
      }
    });
    if (found) weather.watch(found.lat, found.lon);
  });
}

function locate(person: store.Person): { lat: number; lon: number } | string {
  if (person.locationStatus === 'locating') return `I'm still looking up ${person.locationName}. Ask me again in a moment.`;
  if (person.locationStatus === 'not_found') {
    return `I couldn't find ${person.locationName}. Tell me the city and state, or a zip code.`;
  }
  if (person.lat == null || person.lon == null) return NO_LOCATION;
  return { lat: person.lat, lon: person.lon };
}

function snapshotFor(person: store.Person): weather.LocationSnapshot | string {
  const where = locate(person);
  if (typeof where === 'string') return where;
  const snap = weather.current(where.lat, where.lon);
  if (!snap) {
    weather.watch(where.lat, where.lon);
    return `I'm pulling the weather for ${person.locationName ?? 'you'} now. Ask me again in a moment.`;
  }
  if (Number.isNaN(snap.tempF)) return WEATHER_DOWN;
  return snap;
}

const nowHour = (snap: weather.LocationSnapshot): weather.Hour => ({
  local: '',
  time: snap.fetchedAt,
  tempF: snap.tempF,
  humidityPct: snap.humidityPct,
  windMph: snap.windMph,
  uvIndex: snap.uvIndex,
  isDay: snap.isDay,
  aqi: snap.aqi,
});

const mechanismsOf = (person: store.Person) => person.medications.flatMap((m) => m.mechanisms);
const profileFor = (person: store.Person) =>
  profileOf(mechanismsOf(person), person.conditions, { outings: person.outings, private: person.privacy });

/**
 * The cold side of the same list.
 *
 * Medications carry their heat mechanisms in the person's record, but the cold
 * ones are looked up fresh from the table, so a medicine added before winter
 * existed still gets a winter answer.
 */
const coldMechanismsOf = (person: store.Person): { mechanism: ColdMechanism; drugs: string[] }[] => {
  const byMechanism = new Map<ColdMechanism, string[]>();
  for (const taken of person.medications) {
    const known = MEDICATIONS.find((m) => m.generic === taken.generic);
    for (const mechanism of known?.cold ?? []) {
      byMechanism.set(mechanism, [...(byMechanism.get(mechanism) ?? []), taken.generic]);
    }
  }
  return [...byMechanism].map(([mechanism, drugs]) => ({ mechanism, drugs }));
};

const coldConditionsOf = (person: store.Person) =>
  CONDITIONS.filter((c) => person.conditions.includes(c.id) && c.cold);

/** "Wind chill 18" when the wind is doing the work, "It is 41 degrees" when it is not. */
const coldOpening = (tempF: number, feelsF: number): string =>
  feelsF < tempF - 1
    ? `Wind chill ${Math.round(feelsF)}, ${COLD_WORDS[coldCategory(feelsF)]}.`
    : `It's ${Math.round(tempF)} degrees, ${COLD_WORDS[coldCategory(feelsF)]}.`;

/** "a***@example.com", for reading an address back when others may be listening. */
const maskEmail = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, '$1***$2');
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A fresh start is asked for twice.
 *
 * The Alexa+ functional requirements ask for two things that pull against each
 * other: clear all accumulated context when the customer explicitly requires a
 * fresh start, and require explicit confirmation before any high-consequence
 * action. A speaker mishearing one sentence should not wipe everything, so the
 * first ask says exactly what would go and the second one does it.
 */
const CONFIRM_WINDOW_MS = 5 * 60 * 1000;
const asked = (at?: string | null): boolean => !!at && Date.now() - new Date(at).getTime() < CONFIRM_WINDOW_MS;
const andList = (parts: string[]): string =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
const count = (n: number, one: string, many = `${one}s`): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

function describeWhen(reasons: store.NotifyReason[]): string {
  const parts: string[] = [];
  if (reasons.includes('emergency')) parts.push('if signs of heat stroke are described');
  if (reasons.includes('hot_day')) parts.push('the evening before a day that stays too hot for you');
  return parts.join(', and ');
}

/**
 * Text a person said, as the model hands it over: control characters and angle
 * brackets removed, whitespace collapsed, and capped.
 *
 * Without this, whatever arrives is spoken back and then stored forever. A probe
 * registered a five thousand character field name and heard all five thousand
 * characters read back, and a name containing a script tag came back verbatim.
 * Neither is dangerous on a speaker, both are wrong.
 */
const clean = (value: unknown, max = 80): string =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Whether the same request has just arrived twice.
 *
 * A host retries a call it believes failed, and people repeat themselves. A
 * probe sent one job log twice and got two entries, and registered one field
 * twice and got two fields with the same name, which is exactly the duplicate
 * that Amazon's certification notes call out. Two minutes is the window: a
 * retry lands within seconds, and nobody does the same work twice that fast.
 */
const REPEAT_WINDOW_MS = 2 * 60 * 1000;
const justNow = (iso: string): boolean => Math.abs(Date.now() - new Date(iso).getTime()) < REPEAT_WINDOW_MS;

export function registerTools(server: McpServer, personOf: () => string): void {
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
        'or a US zip code. Pass lat and lon only if they are already known exactly.',
      inputSchema: {
        place: z.string().describe('The place as spoken, city and state or a zip code'),
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
      },
    },
    async ({ place, lat, lon }) => {
      place = clean(place, 80);
      const id = personOf();
      if (lat != null && lon != null) {
        store.update(id, (p) => {
          p.lat = lat;
          p.lon = lon;
          p.locationName = place;
          p.locationStatus = 'ready';
        });
        weather.watch(lat, lon);
        warnings.watch(lat, lon);
        return say(`Got it, I'll check the weather for ${place}.`, { place, lat, lon, status: 'ready' });
      }
      store.update(id, (p) => {
        p.lat = null;
        p.lon = null;
        p.locationName = place;
        p.locationStatus = 'locating';
      });
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
        'being prescribed, stopping or finishing something.',
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
        if (!match) {
          const list = person.medications.map((m) => m.generic);
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

      const known = classifyMedication(name);
      if (!known) {
        // Not in the heat table, so no heat advice. The name is still worth
        // keeping: a recall is published against a name, not a mechanism.
        const watchable = /^[a-z0-9 ,.'-]{3,60}$/i.test(name);
        if (watchable) {
          store.update(id, (p) => {
            if (!p.recallWatch.some((m) => m.toLowerCase() === name.toLowerCase())) p.recallWatch.push(name);
          });
          recalls.watch(name);
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
      return say(
        `Added ${known.generic}, ${articleFor(known.drugClass)} ${known.drugClass}. ${
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
        return say(`Done. I've deleted ${andList(held)}. I don't know anything about you now.`, { forgotten: true, deleted: held });
      }

      const profile = profileFor(p);
      const lines = [
        p.locationName ? `Location: ${p.locationName}.` : 'No location yet.',
        p.medications.length ? `Medications: ${p.medications.map((m) => m.generic).join(', ')}.` : 'No medications.',
        profile.conditions.length ? `Conditions: ${profile.conditions.map((c) => c.label).join(', ')}.` : 'No conditions.',
        p.contacts.length
          ? `Contacts: ${p.contacts.map((c) => `${c.name}${c.confirmedAt ? '' : ', not confirmed yet'}`).join('; ')}.`
          : 'No contacts.',
        `Privacy mode is ${p.privacy ? 'on' : 'off'}.`,
        profile.learnedLimitF != null ? `You felt unwell near heat index ${profile.learnedLimitF}, so that is your limit.` : '',
      ].filter(Boolean);
      return say(lines.join(' '), {
        location: p.locationName,
        medications: p.medications.map((m) => m.generic),
        conditions: profile.conditions.map((c) => c.label),
        contacts: p.contacts.map((c) => ({ name: c.name, relation: c.relation, confirmed: !!c.confirmedAt, notifyOn: c.notifyOn })),
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
        on: z.boolean(),
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

  /* ---------------------------------------------------------------- *
   * Telling someone else, only once the person has said yes.
   * ---------------------------------------------------------------- */
  /*
   * One door for the people who get told.
   *
   * Adding, confirming and removing are one conversation, and the confirm step
   * is the safety property: nothing is ever emailed to anyone who has not been
   * confirmed, whichever door it came through.
   */
  server.registerTool(
    'contact',
    {
      title: 'Who to tell',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Manage the family members or caregivers who get emailed when it matters: if signs of heat stroke are ' +
        'described, the evening before a day that stays too hot, or both. action add stages someone and nothing is ' +
        'sent until action confirm, which the customer must say yes to first. action remove stops emailing them. Call ' +
        'this when someone says to tell, add, confirm or stop telling a family member or carer.',
      inputSchema: {
        action: z.enum(['add', 'confirm', 'remove']).describe(
          'add to stage someone, confirm after the customer says yes, remove to stop emailing them',
        ),
        name: z.string().describe('Who, e.g. "Priya"'),
        email: z.string().email().optional().describe('Their email address, required when adding'),
        relation: z.string().optional().describe('e.g. "daughter", "neighbour", "care aide"'),
        when: z
          .enum(['emergency', 'hot_day', 'both'])
          .optional()
          .describe('emergency for heat stroke signs, hot_day for stay-inside days, both by default'),
      },
    },
    async ({ action, name, email, relation, when }) => {
      const id = personOf();
      name = clean(name, 60);

      if (action === 'add') {
        if (!email) return say(`I need an email address for ${name} before I can add them.`, { staged: false, needs: 'email' });
        relation = relation ? clean(relation, 60) : undefined;
        const notifyOn: store.NotifyReason[] =
          when === 'emergency' ? ['emergency'] : when === 'hot_day' ? ['hot_day'] : ['emergency', 'hot_day'];
        const person = store.get(id);
        store.update(id, (p) => {
          p.contacts = p.contacts.filter((c) => !sameName(c.name, name) && c.email.toLowerCase() !== email.toLowerCase());
          p.contacts.push({
            name,
            email,
            relation: relation ?? null,
            notifyOn,
            addedAt: new Date().toISOString(),
            confirmedAt: null,
          });
        });
        const spokenEmail = person.privacy ? maskEmail(email) : email;
        return say(
          `I'll email ${name}${relation ? `, your ${relation},` : ''} at ${spokenEmail} ${describeWhen(notifyOn)}. ` +
            `Nothing is sent until you confirm. Should I add ${name}?`,
          { staged: true, name, notifyOn },
        );
      }

      if (action === 'confirm') {
        const contact = store.get(id).contacts.find((c) => sameName(c.name, name));
        if (!contact) return say(`I don't have anyone called ${name} waiting to be added. Tell me who to add first.`, { confirmed: false });
        store.update(id, (p) => {
          const c = p.contacts.find((x) => sameName(x.name, name));
          if (c && !c.confirmedAt) c.confirmedAt = new Date().toISOString();
        });
        return say(
          `Done. ${contact.name} will get an email ${describeWhen(contact.notifyOn)}.` +
            (emailConfigured() ? '' : " Email isn't switched on for this server yet, so nothing can actually be sent until it is."),
          { confirmed: true, name: contact.name, emailConfigured: emailConfigured() },
        );
      }

      if (!store.get(id).contacts.some((c) => sameName(c.name, name))) {
        return say(`${name} isn't one of your contacts.`, { removed: false });
      }
      store.update(id, (p) => void (p.contacts = p.contacts.filter((c) => !sameName(c.name, name))));
      return say(`Removed ${name}. They won't be emailed.`, { removed: true });
    },
  );

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
        'faint, sick or overheated while out. If they feel unwell right now, also use heat_warning_signs.',
      inputSchema: {
        felt: z.enum(['fine', 'unwell']),
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
        'how cold it is for them. Read the answer aloud in full; it names what is driving the risk and what to do.',
      inputSchema: {},
      _meta: { ui: { resourceUri: UI }, 'openai/outputTemplate': UI },
    },
    async () => {
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

        return say(parts.join(' '), {
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
      const opening = `Heat index ${Math.round(verdict.heatIndexF)}, ${CATEGORY_WORDS[verdict.category]}.`;

      const parts: string[] = [];
      if (person.privacy) {
        parts.push(opening);
        if (profile.sensitivity !== 'general' && verdict.category !== 'none') {
          parts.push('Something in your health profile makes this heat riskier for you.');
        }
      } else {
        parts.push(person.medications.length ? verdict.reason : opening);
        if (verdict.binding) parts.push(MEDICATION_CAUTION);
        const condition = profile.conditions[0];
        if (condition && verdict.category !== 'none') {
          // A medication explanation is already a lot to hear, so the condition
          // gets one short line then, and its full planning sentence otherwise.
          parts.push(verdict.binding ? `With ${condition.label}, that matters even more.` : condition.plan);
        }
      }

      const extra = judged.reasons.filter((r) => !r.startsWith('heat index'));
      const because = extra.length ? `, because of ${extra.join(' and ').replace('felt unwell at this heat before', 'how you felt at this heat before')}` : '';
      parts.push(
        judged.status === 'good'
          ? 'For you, right now is a fine time to be outside.'
          : judged.status === 'caution'
            ? `For you, take care if you go out now${because}.`
            : `For you, it is better to stay in right now if you can${because}.`,
      );
      if (!person.medications.length && !person.conditions.length) {
        parts.push('Tell me your medications or health conditions and I can answer for you specifically.');
      }
      const age = weather.ageMinutes(snap.lat, snap.lon);
      if (snap.stale && age != null && age > 60) parts.push(`My weather data is ${age} minutes old.`);

      return say(parts.join(' '), {
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

  server.registerTool(
    'plan_my_day',
    {
      title: 'When is the best time to go out',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Plan a day around the heat for this customer: the best window for going out and the hours to avoid, using the ' +
        'hourly forecast for their location, their medications and conditions, UV, air quality and how they felt ' +
        'before. Call this when someone asks when to go out, walk the dog, run errands, exercise or garden, when it ' +
        'cools down, or to plan today or tomorrow.',
      inputSchema: {
        activity: z.string().optional().describe('What they want to do, e.g. "a walk", "groceries", "gardening"'),
        minutes: z.number().int().min(10).max(600).optional().describe('How long it takes, in minutes, default 60'),
        day: z.enum(['today', 'tomorrow']).optional().describe('today unless they say tomorrow'),
      },
      _meta: { ui: { resourceUri: UI } },
    },
    async ({ activity, minutes, day }) => {
      const person = store.get(personOf());
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say(snap, { unavailable: true });
      const profile = profileFor(person);
      const plan = planDay(snap, profile, { now: new Date(), day, minutes, activity });
      return say(plan.spoken, {
        ...plan,
        sensitivity: profile.sensitivity,
        because: profile.because,
        place: person.locationName,
        timezone: snap.timezone,
      });
    },
  );

  server.registerTool(
    'going_out_now',
    {
      title: 'I have to go out now, what should I do',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Precautions for going out in the heat right now when it cannot wait, tailored to this customer: their ' +
        'conditions, medications, UV and water. Call this when someone says they have to go out, have an appointment, ' +
        'must run an urgent errand, or asks what precautions to take. Pass step to hear the rest, and ' +
        'privatePrecautions when they ask for their private precautions.',
      inputSchema: {
        step: z.number().int().min(0).optional().describe('Where to continue from; use nextStep from the last answer'),
        privatePrecautions: z.boolean().optional().describe('true when they ask for their private precautions'),
      },
    },
    async ({ step, privatePrecautions }) => {
      const person = store.get(personOf());
      const snap = snapshotFor(person);
      if (typeof snap === 'string') return say(snap, { unavailable: true });
      const profile = profileFor(person);
      const judged = judgeHour(nowHour(snap), profile);
      const result = precautions(judged, profile, step ?? 0, { includePrivate: privatePrecautions === true });
      return say(result.spoken, { ...result, status: judged.status, heatIndexF: judged.heatIndexF });
    },
  );

  server.registerTool(
    'warning_signs',
    {
      title: 'Heat illness warning signs',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'What to do when someone feels unwell in the heat or the cold: heat stroke and heat exhaustion in warm ' +
        'weather, hypothermia and frostbite in cold. Which one it answers follows the weather where the person is. ' +
        'Pass what they describe. If it describes confusion, slurred speech, fainting or collapse, the answer tells them ' +
        'to call 911 and emails any confirmed emergency contacts: read it immediately and in full.',
      inputSchema: {
        symptoms: z.string().optional().describe('What the person describes, in their words'),
        lastedMinutes: z.number().int().min(0).optional().describe('How long symptoms have lasted, if said'),
      },
    },
    async ({ symptoms, lastedMinutes }) => {
      const id = personOf();
      const person = store.get(id);
      const profile = profileFor(person);

      /*
       * Which first aid, decided by the weather rather than by the words.
       *
       * "Confused" is a sign of both heat stroke and hypothermia, and the two
       * have opposite first aid. Guessing from the word alone would eventually
       * tell someone to cool down a person who is freezing. So when it is cold
       * where they are, cold first aid answers.
       */
      const snap = person.lat != null && person.lon != null ? weather.current(person.lat, person.lon) : null;
      const isCold =
        snap && !Number.isNaN(snap.tempF) && coldCategory(windChillF(snap.tempF, snap.windMph)) !== 'none';

      if (isCold) {
        const matched = matchColdFirstAid(symptoms ?? '');
        if (!matched) {
          return say(
            'In the cold, the signs to watch for are shivering that turns to confusion, slurred or mumbled speech, ' +
              'fumbling hands, or drowsiness, and skin that has gone white, grey or waxy and numb. Shivering that ' +
              'stops on its own is a bad sign, not a good one. If any of that starts, tell me what you see and I will ' +
              'say what to do.',
            { season: 'cold', level: 'information' },
          );
        }
        let spoken = matched.say;
        let contacted: { trying: string[]; configured: boolean } | null = null;
        if (matched.emergency) {
          contacted = alertEmergency(id, symptoms ?? '');
          const names = contacted.trying.join(' and ');
          if (contacted.trying.length) {
            spoken += contacted.configured
              ? ` I'm emailing ${names} now.`
              : ` I can't email ${names}, because email isn't set up on this server yet.`;
          }
        }
        return say(spoken, {
          season: 'cold',
          condition: matched.id,
          level: matched.emergency ? 'emergency' : 'care',
          source: matched.source,
          spoken,
          contacted,
        });
      }

      const result = triage(symptoms ?? '', profile, lastedMinutes);
      let spoken = result.spoken;
      let contacted: { trying: string[]; configured: boolean } | null = null;
      if (result.level === 'emergency') {
        contacted = alertEmergency(id, symptoms ?? '');
        const names = contacted.trying.join(' and ');
        if (contacted.trying.length) {
          spoken += contacted.configured
            ? ` I'm emailing ${names} now.`
            : ` I can't email ${names}, because email isn't set up on this server yet.`;
        }
      }
      return say(spoken, { ...result, spoken, contacted });
    },
  );

  /*
   * The one winter question with a body count attached.
   *
   * Ten minutes of shovelling takes a heart to about 97 percent of its maximum
   * rate, and the American Heart Association puts snow removal among the
   * activities that trigger heart attacks and sudden cardiac arrest, especially
   * in people who do not know they have coronary disease. Cold makes it worse:
   * it raises blood pressure and narrows the arteries while the work is going on.
   */
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
  server.registerTool(
    'somewhere_to_go',
    {
      title: 'Somewhere warm, or somewhere cool',
      description:
        'Find somewhere the customer can go when their home is too cold or too hot to stay in, usually after a power ' +
        'cut: open shelters from the federal shelter system near their address, whether each has a generator, step-free ' +
        'access or takes pets, and the 211 line for local warming and cooling centres. Call this when they say they have ' +
        'no heat, no power, no air conditioning, that the house is freezing or boiling, or ask where they can go.',
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

      if (found === null) {
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
        parts.push(`The nearest open shelter is ${first.name} in ${first.city}, ${away(first.milesAway ?? 0)}.`);
        // Only the details that decide whether this person can actually use it.
        const notes: string[] = [];
        if (powered && first.generator) notes.push('it has a generator, so equipment that needs power can run');
        // A blank in the feed is not a no, and for someone whose equipment needs
        // a socket the difference is the whole question. Say what we do not know.
        if (powered && !first.generator) notes.push('the list does not say whether it has a generator, so ask when you ring');
        if (older && first.accessible) notes.push('it is step-free');
        if (first.pets) notes.push(`pets: ${first.pets.toLowerCase()}`);
        if (notes.length) parts.push(`${notes.join(', ')}.`);
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
        parts.push(
          'While you are still at home, close off the rooms you are not using and wear a hat indoors. Never heat the ' +
            'house with an oven, a grill or a generator indoors or in the garage: that is carbon monoxide, and it ' +
            'kills people after storms who came through the storm fine.',
        );
      }

      return say(parts.join(' '), {
        cold,
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

  server.registerTool(
    'weather_warnings',
    {
      title: 'Are there any weather warnings for me',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Official National Weather Service watches, warnings and advisories for this customer\'s location, read with ' +
        'their medications and conditions in mind. Call this when someone asks about warnings, alerts, whether a ' +
        'storm is coming, or whether it is safe to travel. Read the answer aloud in full.',
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
      const named = person.privacy ? 'Something in your health profile' : profile.because ? `Being ${profile.because.replace(/^because of /, '')}` : null;
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
        'mentions losing power.',
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
      if (person.conditions.includes('diabetes')) {
        steps.push(
          'Insulin keeps best between 36 and 46 degrees. If the power goes, keep it as cool as you can without ' +
            'freezing it, because frozen insulin is finished. The FDA says insulin kept warmer than it should be can ' +
            'still be used in an emergency when there is nothing else, so do not go without: ring your pharmacist ' +
            'about replacing it once the power is back.',
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

      const opening = person.medications.length || person.conditions.length
        ? 'Here is what matters for you.'
        : "I don't know your medicines or conditions yet, so this is the general version. Tell me what you take and I can be specific.";

      const tail = solar ? ` ${spaceweather.speak(solar)}` : '';
      return say(`${lead}${opening} ${steps.join(' ')}${tail}`, {
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

  server.registerTool(
    'sun_check',
    {
      title: 'Will I burn faster today',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Whether today's UV plus the customer's medications raise their sunburn risk. Call this when asked about sun " +
        'exposure, sunburn, going to the beach or pool, or whether they need extra sunscreen today.',
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

  server.registerTool(
    'what_can_you_do',
    {
      title: 'What can this do',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Explain what this add-on is for. Call this when the customer asks what you can do, what this is, or opens with ' +
        'something too vague to route.',
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
