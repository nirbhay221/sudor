/**
 * What the medicine's own label says about heat, read live.
 *
 * The heat table (meds.ts) and the class rules (rxclass.ts) are this project's reading of the CDC's guidance,
 * typed in on a particular day. A table like that goes stale: a label gains a warning, a new drug arrives.
 * So each medicine a person adds is also looked up in openFDA's drug label service, which serves the current
 * FDA-approved label for it, and the label is searched for the few phrases that state a heat risk outright:
 * "heat prostration due to decreased sweating", "oligohidrosis and hyperthermia", "photosensitivity
 * manifested by an exaggerated sunburn reaction", "volume depletion".
 *
 * What it is for:
 *   - a medicine nothing else here classifies, whose label states a heat risk, is treated as carrying it;
 *   - a medicine already classified gains the label's own sentence and date, so the judgement can be traced
 *     to a document somebody else wrote and keeps current.
 *
 * What it is deliberately not: a general reading of the label. Labels mention heat stroke and hyperthermia
 * in passing all the time, as things to tell apart from a rare reaction or as signs of an overdose. Tried
 * loosely, this said sertraline stops you sweating because its label lists hyperthermia under serotonin
 * syndrome. So the phrases are narrow, a sentence about a syndrome, an overdose or a differential diagnosis
 * is ignored, the adverse-reactions list is never read, and only a label for that one ingredient counts: a
 * combination product's label is about the other drug as much as this one.
 *
 * A label that says nothing is not evidence of safety, and never removes what the table says.
 *
 * In the background, once when a medicine is added. A label lookup measured about 660 ms.
 */

import type { Mechanism } from './meds.js';

export type LabelEvidence = {
  mechanisms: Mechanism[];
  /** The label's own sentence for each mechanism found, trimmed. */
  quotes: { mechanism: Mechanism; sentence: string }[];
  /** When this version of the label took effect, as the FDA gives it: "20260608". */
  effective: string | null;
  checkedAt: string;
};

const SECTIONS = ['boxed_warning', 'warnings', 'warnings_and_cautions', 'precautions', 'general_precautions', 'information_for_patients'] as const;

const PHRASES: [Mechanism, RegExp][] = [
  ['reduced_sweating', /heat prostration|oligohidrosis|anhidrosis|decreased sweating|body temperature regulation|ability to (reduce|regulate|lower) (core )?body temperature/i],
  ['photosensitivity', /photosensitivity (reactions?|manifested)|exaggerated sunburn|avoid (excessive |prolonged )?(exposure to )?(sunlight|sun exposure)/i],
  // Stated as something the medicine does. "Volume depletion" named as a condition the patient may already
  // have, which is how the lisinopril and lithium labels use it, is not a statement about this drug.
  ['fluid_loss', /may cause dehydration|excessive diuresis|causes? (intravascular )?volume (depletion|contraction)|^\(? ?\d[\d. ]*\)? ?volume depletion:/i],
];

/** A sentence about something else that happens to name heat. */
const IN_PASSING = /neuroleptic malignant|serotonin syndrome|differential diagnosis|overdos|malignant hyperthermia/i;

const sentencesOf = (text: string): string[] => text.split(/(?<=[.;:])\s+|\s{2,}/).map((s) => s.trim()).filter(Boolean);

type Label = Record<string, unknown> & { openfda?: { generic_name?: unknown }; effective_time?: unknown };

/** The label for exactly this ingredient, out of what the service returned, or null. */
export function pick(results: unknown, generic: string): Label | null {
  if (!Array.isArray(results)) return null;
  const want = generic.toLowerCase().trim();
  const exact = (r: Label) => {
    const names = Array.isArray(r.openfda?.generic_name) ? (r.openfda?.generic_name as unknown[]).map((n) => String(n).toLowerCase().trim()) : [];
    // "metoprolol tartrate" is metoprolol. "lisinopril and hydrochlorothiazide" is not lisinopril.
    return names.length === 1 && (names[0] === want || names[0].startsWith(`${want} `)) && !/ and |\/|,/.test(names[0]);
  };
  return (results as Label[]).find(exact) ?? null;
}

/** What one label states about heat, in its own words. */
export function read(label: Label | null, now = new Date()): LabelEvidence | null {
  if (!label) return null;
  const quotes: LabelEvidence['quotes'] = [];
  for (const section of SECTIONS) {
    const parts = Array.isArray(label[section]) ? (label[section] as unknown[]).map(String) : [];
    for (const sentence of parts.flatMap(sentencesOf)) {
      if (IN_PASSING.test(sentence)) continue;
      for (const [mechanism, phrase] of PHRASES) {
        if (quotes.some((q) => q.mechanism === mechanism) || !phrase.test(sentence)) continue;
        quotes.push({ mechanism, sentence: sentence.replace(/\s+/g, ' ').slice(0, 240) });
      }
    }
  }
  return {
    mechanisms: quotes.map((q) => q.mechanism),
    quotes,
    effective: typeof label.effective_time === 'string' ? label.effective_time : null,
    checkedAt: now.toISOString(),
  };
}

type Lookup = (generic: string) => Promise<LabelEvidence | null>;

async function fetchEvidence(generic: string, timeoutMs = 8000): Promise<LabelEvidence | null> {
  // Letters, spaces and hyphens only, so nothing typed can change the query.
  const name = generic.toLowerCase().replace(/[^a-z -]/g, '').trim();
  if (name.length < 3) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(`openfda.generic_name:"${name}"`)}&limit=10`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return read(pick(((await res.json()) as { results?: unknown }).results, name));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let lookup: Lookup = (generic) => fetchEvidence(generic);

export const evidenceFor: Lookup = (generic) => lookup(generic);

export function configureForTest(fn: Lookup | null): void {
  lookup = fn ?? ((generic) => fetchEvidence(generic));
}
