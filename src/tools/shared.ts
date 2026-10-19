/**
 * What every tool group needs.
 *
 * tools.ts reached 1,386 lines and eighteen tools in one function, which is past
 * the point where a reader can find anything and well past where a reviewer keeps
 * reading the diff. The tools are grouped by what they are for now, one file each,
 * and this holds what they all reach for: the response shape, the refusal
 * sentences, and the phrasing helpers that keep the same idea worded the same way
 * wherever it is said. That consistency matters more here than in most products,
 * because a person hears these sentences once.
 *
 * Nothing here changed in the move. It is the same code in a smaller room.
 */

import * as recallsuk from '../recallsuk.js';
import * as recallsca from '../recallsca.js';
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
import * as spaceweather from '../spaceweather.js';
import * as shelters from '../shelters.js';
import * as care from '../care.js';
import { coldByClass } from '../rxclass.js';
import * as labels from '../labels.js';

export const UI = 'ui://sudor/window.html';

/** The view for what is not the day strip: the profile, a contact being confirmed, and the 911 card. */
export const CARD = 'ui://sudor/card.html';

export const say = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  // Always present, so the declared outputSchema is true of every answer and a host that reads
  // structured data never has to fall back to parsing the text.
  structuredContent: { spoken: text, ...(structured ?? {}) },
});

export const NO_LOCATION =
  "I don't know where you are yet. Tell me your city and state, or a zip code, so I can check the heat where you are.";
/** Certification requires an actionable next step on every error, not a bare failure. */
export const WEATHER_DOWN =
  "I can't reach the weather service right now, so I won't guess at today's heat. It refreshes every twenty minutes, " +
  // Said in all twelve countries, so it names no one country's service: weather.gov was offered to people in Manchester.
  'so ask again shortly, or check your national weather service if you need an answer now.';
/**
 * Said whenever a medication is named as the risk. Stopping a heart or blood
 * pressure medicine because of a hot day can do more harm than the heat.
 */
// Short, because it is said in nearly every hot answer, and it is the one line that prevents a harm.
export const MEDICATION_CAUTION = 'Keep taking it unless your doctor says otherwise.';
/** Amazon's wording for medical information in an add-on, word for word. See policy-requirements. */
export const DISCLAIMER = 'This information is not a substitute for professional medical advice.';
/** Said once, the first time a health detail is kept: what it is for, how far it goes, and the disclaimer. */
export const HEALTH_PURPOSE = "I keep your health details only to tailor heat, cold and storm warnings for you, never tell your contacts what they are, and forget them whenever you say forget everything. " + DISCLAIMER;

export const CATEGORY_WORDS: Record<HeatCategory, string> = {
  none: 'not a heat concern',
  caution: 'caution',
  extreme_caution: 'extreme caution',
  danger: 'danger',
  extreme_danger: 'extreme danger',
};

/** How long to wait before asking the geocoder again when it did not answer. */
const GEOCODE_RETRIES_MS = [3_000, 20_000, 90_000];

/**
 * A spoken place is looked up in the background, because a geocoding call
 * measured 740 to 1000 ms against a 500 ms budget for the whole turn.
 * Exported so a server restart can finish a lookup that was cut off.
 */
export function resolveLocation(personId: string, place: string, attempt = 0): void {
  void geocode(place).catch((err) => {
    // The geocoder did not answer, which is not the same as there being no such place. Try again a little
    // later and keep saying "still looking"; only after the last try is the person asked to say it again.
    if (attempt < GEOCODE_RETRIES_MS.length) {
      const t = setTimeout(() => resolveLocation(personId, place, attempt + 1), GEOCODE_RETRIES_MS[attempt]);
      t.unref?.();
      return undefined;
    }
    console.error(`[geocode] gave up after ${attempt + 1} tries: ${String(err)}`);
    return null;
  }).then((found) => {
    if (found === undefined) return;
    store.update(personId, (p) => {
      // Someone may have set a different place while this one was being looked up.
      if (p.locationName !== place || p.locationStatus !== 'locating') return;
      if (found) {
        p.lat = found.lat;
        p.lon = found.lon;
        p.locationName = found.state ? `${found.name}, ${found.state}` : found.countryName && found.country !== 'US' ? `${found.name}, ${found.countryName}` : found.name;
        p.country = found.country;
        p.locationStatus = 'ready';
      } else {
        p.locationStatus = 'not_found';
      }
    });
    if (found) {
      weather.watch(found.lat, found.lon, !personId.startsWith('demo:'));
      care.watch(found.lat, found.lon, found.state ? `${found.name}, ${found.state}` : found.name);
      warnings.watch(found.lat, found.lon, found.country, found.name);
      // The US forecasts: the hurricane centre's cones also cover Mexico and the Caribbean. See outlook.ts.
      if (inUS(found.country) || ['MX', 'CU', 'DO', 'JM', 'BS', 'BZ', 'GT', 'HN', 'NI', 'CR', 'PA', 'SV', 'HT'].includes(found.country)) outlook.watch(found.lat, found.lon);
      if (found.country === 'CA') recallsca.start();
      if (found.country === 'GB') recallsuk.start();
    }
  });
}

/** Stop polling a place once no stored person is there. Called when somebody moves or is forgotten. */
export function releasePlace(lat: number | null, lon: number | null): void {
  if (lat == null || lon == null) return;
  const stillUsed = store.allEntries().some(([, p]) => p.lat === lat && p.lon === lon);
  if (!stillUsed) weather.unwatch(lat, lon);
}

/** How old a reading may be before it stops being "right now". Refreshed every twenty minutes when all is well. */
const TOO_OLD_MINUTES = 180;

export function locate(person: store.Person): { lat: number; lon: number } | string {
  if (person.locationStatus === 'locating') return `I'm still looking up ${person.locationName}. Ask me again in a moment.`;
  if (person.locationStatus === 'not_found') {
    return `I couldn't find ${person.locationName}. Tell me the city and the state, or the city and the country, or a US zip code.`;
  }
  if (person.lat == null || person.lon == null) return NO_LOCATION;
  return { lat: person.lat, lon: person.lon };
}

/**
 * Wait, briefly, for a place or its weather that is still on its way.
 *
 * The place is looked up in the background, and on the deployed server the first question asked straight after
 * setting it arrived a tenth of a second before the lookup finished and was told "ask me again in a moment".
 * Waiting up to two and a half seconds costs nothing when there is nothing pending, and answers that question.
 */
export async function settle(personId: string, waitMs = 2500): Promise<void> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const person = store.get(personId);
    const where = locate(person);
    if (typeof where === 'string' ? person.locationStatus !== 'locating' : weather.current(where.lat, where.lon)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function snapshotFor(person: store.Person, forAccount = false): weather.LocationSnapshot | string {
  const where = locate(person);
  if (typeof where === 'string') return where;
  const snap = weather.current(where.lat, where.lon);
  if (!snap) {
    weather.watch(where.lat, where.lon, forAccount);
    return `I'm pulling the weather for ${person.locationName ?? 'you'} now. Ask me again in a moment.`;
  }
  if (Number.isNaN(snap.tempF)) return WEATHER_DOWN;
  // When the weather service has been unreachable for hours the last reading is still held, and it used to
  // be spoken as "right now" however old it was. A heat answer built on this morning's temperature is a guess.
  const age = weather.ageMinutes(where.lat, where.lon);
  if (age != null && age > TOO_OLD_MINUTES) return WEATHER_DOWN;
  return snap;
}

/**
 * The one official warning that cannot be left out of an answer about going outside.
 *
 * Warnings were polled for every place and only spoken when somebody asked for them by name, so a person
 * under a hurricane warning who asked "is it safe outside" was told the heat index. This is the sentence
 * that closes that: the worst active alert, if it is a Warning (or the weather service rates it severe),
 * and it is not a heat or cold alert, which the answer is already about.
 */
export function officialWarning(person: store.Person, timeZone: string): { line: string; event: string } | null {
  if (person.lat == null || person.lon == null) return null;
  const held = warnings.current(person.lat, person.lon);
  if (!held || !held.length) return null;
  const top = warnings
    .rank(held)
    .find((a) => a.kind !== 'heat' && a.kind !== 'cold' && (/warning|emergency/i.test(a.event) || a.severity === 'Severe' || a.severity === 'Extreme'));
  if (!top) return null;
  const article = /^[aeiou]/i.test(top.event) ? 'an' : 'a';
  return { line: `There is ${article} ${top.event} where you are${warnings.until(top, timeZone)}. Ask me what to do before it arrives.`, event: top.event };
}

export const nowHour = (snap: weather.LocationSnapshot): weather.Hour => ({
  local: '',
  time: snap.fetchedAt,
  tempF: snap.tempF,
  humidityPct: snap.humidityPct,
  solarWm2: snap.solarWm2,
  wetBulbF: snap.wetBulbF,
  windMph: snap.windMph,
  uvIndex: snap.uvIndex,
  isDay: snap.isDay,
  aqi: snap.aqi,
});

/** What a medicine does in the cold: from the table when it is there, and from its class when it came from RxNorm. */
const coldOf = (taken: { generic: string; drugClass: string }): ColdMechanism[] =>
  MEDICATIONS.find((m) => m.generic === taken.generic)?.cold ?? coldByClass(taken.drugClass);

/** Everything a person's medicines do in the heat: what the table or the class says, and what the label itself states. */
export const mechanismsOf = (person: store.Person) => person.medications.flatMap((m) => [...new Set([...m.mechanisms, ...(m.label?.mechanisms ?? [])])]);

/**
 * Read the medicine's current FDA label, in the background, and keep what it states about heat.
 *
 * For a medicine already on the list this adds the label's own sentence and date. For a name nothing here
 * could classify, a label that states a heat risk outright moves it onto the list, judged on the label alone.
 */
export function checkLabel(personId: string, generic: string, spokenName: string): void {
  void labels.evidenceFor(generic).then((found) => {
    if (!found) return;
    store.update(personId, (p) => {
      const held = p.medications.find((m) => m.generic === generic);
      if (held) {
        held.label = found;
        return;
      }
      if (!found.mechanisms.length) return;
      const watched = p.recallWatch.some((m) => m.toLowerCase() === spokenName.toLowerCase());
      if (!watched || p.medications.length >= store.LIMITS.medications) return;
      p.medications.push({ spoken: spokenName, generic, drugClass: 'medicine', mechanisms: [], label: found });
      p.recallWatch = p.recallWatch.filter((m) => m.toLowerCase() !== spokenName.toLowerCase());
    });
  });
}
export const profileFor = (person: store.Person) =>
  profileOf(mechanismsOf(person), person.conditions, {
    outings: person.outings,
    private: person.privacy,
    coldSensitive: person.medications.some((taken) => coldOf(taken).length > 0),
  });

/**
 * Medicines that have to stay cold, which is what a power cut threatens.
 *
 * Insulin was only recognised through the diabetes condition, so somebody who said "I take insulin" and never
 * said "I have diabetes" was told nothing about their fridge. Insulin is not in the heat list (it does not
 * change how a body handles heat), so it arrives here as a name on the recall watch list.
 */
const NEEDS_FRIDGE = /insulin|humalog|novolog|lantus|levemir|tresiba|toujeo|basaglar|admelog|fiasp|lyumjev|semglee|apidra|humulin|novolin/i;
const FRIDGE_GENERICS = new Set(['semaglutide', 'liraglutide', 'dulaglutide', 'tirzepatide', 'exenatide']);
export function fridgeMedicines(person: store.Person): { insulin: boolean; injectables: string[] } {
  const names = [...person.medications.map((m) => m.spoken), ...person.medications.map((m) => m.generic), ...person.recallWatch];
  return {
    insulin: names.some((n) => NEEDS_FRIDGE.test(n)),
    injectables: [...new Set(person.medications.filter((m) => FRIDGE_GENERICS.has(m.generic)).map((m) => m.generic))],
  };
}

/**
 * The cold side of the same list.
 *
 * Medications carry their heat mechanisms in the person's record, but the cold
 * ones are looked up fresh from the table, so a medicine added before winter
 * existed still gets a winter answer.
 */
export const coldMechanismsOf = (person: store.Person): { mechanism: ColdMechanism; drugs: string[] }[] => {
  const byMechanism = new Map<ColdMechanism, string[]>();
  for (const taken of person.medications) {
    for (const mechanism of coldOf(taken)) {
      byMechanism.set(mechanism, [...(byMechanism.get(mechanism) ?? []), taken.generic]);
    }
  }
  return [...byMechanism].map(([mechanism, drugs]) => ({ mechanism, drugs }));
};

export const coldConditionsOf = (person: store.Person) =>
  CONDITIONS.filter((c) => person.conditions.includes(c.id) && c.cold);

/** "With the wind it feels like 18" when the wind is doing the work, "It is 41 degrees" when it is not. */
export const coldOpening = (tempF: number, feelsF: number): string =>
  feelsF < tempF - 1
    ? `With the wind it feels like ${Math.round(feelsF)} degrees, ${COLD_WORDS[coldCategory(feelsF)]}.`
    : `It's ${Math.round(tempF)} degrees, ${COLD_WORDS[coldCategory(feelsF)]}.`;

/** "a***@example.com", for reading an address back when others may be listening. */
export const maskEmail = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, '$1***$2');
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A fresh start is asked for twice.
 *
 * The Alexa+ functional requirements ask for two things that pull against each
 * other: clear all accumulated context when the customer explicitly requires a
 * fresh start, and require explicit confirmation before any high-consequence
 * action. A speaker mishearing one sentence should not wipe everything, so the
 * first ask says exactly what would go and the second one does it.
 */
export const CONFIRM_WINDOW_MS = 5 * 60 * 1000;
export const asked = (at?: string | null): boolean => !!at && Date.now() - new Date(at).getTime() < CONFIRM_WINDOW_MS;
export const andList = (parts: string[]): string =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
export const count = (n: number, one: string, many = `${one}s`): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function describeWhen(reasons: store.NotifyReason[]): string {
  const parts: string[] = [];
  if (reasons.includes('emergency')) parts.push('if signs of heat stroke are described');
  if (reasons.includes('hot_day')) parts.push('the evening before a day that stays too hot for you');
  // Asking for help reaches everybody who has agreed, whatever else they were added for.
  parts.push('when you ask me to get help');
  return parts.length > 2 ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}` : parts.join(', and ');
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
export const clean = (value: unknown, max = 80): string =>
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
export const REPEAT_WINDOW_MS = 2 * 60 * 1000;
export const justNow = (iso: string): boolean => Math.abs(Date.now() - new Date(iso).getTime()) < REPEAT_WINDOW_MS;
