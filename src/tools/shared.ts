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

export const UI = 'ui://sudor/window.html';

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
  'so ask again shortly, or check weather.gov if you need an answer now.';
/**
 * Said whenever a medication is named as the risk. Stopping a heart or blood
 * pressure medicine because of a hot day can do more harm than the heat.
 */
export const MEDICATION_CAUTION = "Don't stop or change a medication because of the heat without asking your doctor or pharmacist.";

export const CATEGORY_WORDS: Record<HeatCategory, string> = {
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
    if (found) weather.watch(found.lat, found.lon, !personId.startsWith('demo:'));
  });
}

export function locate(person: store.Person): { lat: number; lon: number } | string {
  if (person.locationStatus === 'locating') return `I'm still looking up ${person.locationName}. Ask me again in a moment.`;
  if (person.locationStatus === 'not_found') {
    return `I couldn't find ${person.locationName}. Tell me the city and state, or a zip code.`;
  }
  if (person.lat == null || person.lon == null) return NO_LOCATION;
  return { lat: person.lat, lon: person.lon };
}

export function snapshotFor(person: store.Person): weather.LocationSnapshot | string {
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

export const mechanismsOf = (person: store.Person) => person.medications.flatMap((m) => m.mechanisms);
export const profileFor = (person: store.Person) =>
  profileOf(mechanismsOf(person), person.conditions, { outings: person.outings, private: person.privacy });

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
    const known = MEDICATIONS.find((m) => m.generic === taken.generic);
    for (const mechanism of known?.cold ?? []) {
      byMechanism.set(mechanism, [...(byMechanism.get(mechanism) ?? []), taken.generic]);
    }
  }
  return [...byMechanism].map(([mechanism, drugs]) => ({ mechanism, drugs }));
};

export const coldConditionsOf = (person: store.Person) =>
  CONDITIONS.filter((c) => person.conditions.includes(c.id) && c.cold);

/** "Wind chill 18" when the wind is doing the work, "It is 41 degrees" when it is not. */
export const coldOpening = (tempF: number, feelsF: number): string =>
  feelsF < tempF - 1
    ? `Wind chill ${Math.round(feelsF)}, ${COLD_WORDS[coldCategory(feelsF)]}.`
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
