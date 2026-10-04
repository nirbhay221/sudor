/**
 * Any medicine with a name, not only the fifty-seven in the table.
 *
 * meds.ts holds the drugs the CDC's clinical guidance on heat and medicines names one by one. A person does
 * not take "a beta blocker", though. They take bisoprolol, or Coreg, or whatever the pharmacy handed over,
 * and a table of fifty-seven names answers "I don't have that" to most of a real medicine cabinet.
 *
 * So a name the table does not know is looked up in RxNorm, the National Library of Medicine's drug
 * vocabulary, through its public RxClass service: free, no key, and it answers a brand name or a generic
 * with the ingredient and the class the World Health Organization's ATC system puts it in. The class is then
 * read against the same CDC guidance, which is written by class and by mechanism: every loop diuretic
 * disturbs electrolytes, every antipsychotic blunts sweating.
 *
 * What is real data and what is this project's reading of it, said plainly:
 *   - the name, the ingredient and the class come from the National Library of Medicine;
 *   - which mechanism a class carries comes from the CDC guidance and matches what meds.ts already says for
 *     the named members of that class;
 *   - applying a class's mechanism to a member the CDC did not name one by one is an inference, and the
 *     answer says "as a beta blocker", so the person hears what the judgement rests on.
 *
 * A class that mixes drugs with different effects (the "other antidepressants", the newer antihistamines) is
 * deliberately not in the table. An unrecognised medicine is better than a wrongly classified one.
 *
 * One lookup, when a medicine is added, with a short timeout. Never while answering about the weather.
 */

import type { Mechanism, ColdMechanism } from './meds.js';

export type Classified = {
  generic: string;
  drugClass: string;
  mechanisms: Mechanism[];
  cold: ColdMechanism[];
  /** The ATC class it was matched on, kept so the answer can be traced. */
  atc: string;
  source: 'rxnorm';
};

type Rule = { atc: string; drugClass: string; mechanisms: Mechanism[]; cold?: ColdMechanism[] };

/**
 * ATC class to mechanism. Longest prefix wins, so lithium (N05AN) is read before the rest of N05A.
 * Each line carries the same mechanisms meds.ts gives the named drugs of that class.
 */
export const RULES: Rule[] = [
  { atc: 'C03C', drugClass: 'loop diuretic', mechanisms: ['electrolyte_imbalance'] },
  { atc: 'C03A', drugClass: 'thiazide diuretic', mechanisms: ['electrolyte_imbalance', 'hyponatremia_risk', 'photosensitivity'] },
  { atc: 'C03B', drugClass: 'thiazide-like diuretic', mechanisms: ['electrolyte_imbalance', 'hyponatremia_risk', 'photosensitivity'] },
  { atc: 'C03D', drugClass: 'diuretic', mechanisms: ['electrolyte_imbalance'] },
  { atc: 'C03E', drugClass: 'diuretic', mechanisms: ['electrolyte_imbalance'] },
  { atc: 'C07', drugClass: 'beta blocker', mechanisms: ['electrolyte_imbalance', 'reduced_sweating'], cold: ['reduced_heat_production'] },
  { atc: 'C08', drugClass: 'calcium channel blocker', mechanisms: ['electrolyte_imbalance'] },
  { atc: 'C09A', drugClass: 'ACE inhibitor', mechanisms: ['reduced_thirst_or_sedation'] },
  { atc: 'C09B', drugClass: 'ACE inhibitor', mechanisms: ['reduced_thirst_or_sedation'] },
  { atc: 'C09C', drugClass: 'ARB', mechanisms: ['reduced_thirst_or_sedation'] },
  { atc: 'C09D', drugClass: 'ARB', mechanisms: ['reduced_thirst_or_sedation'] },
  { atc: 'A10BJ', drugClass: 'GLP-1 agonist', mechanisms: ['fluid_loss'] },
  { atc: 'A10BK', drugClass: 'SGLT2 inhibitor', mechanisms: ['fluid_loss'] },
  { atc: 'R06AA', drugClass: 'anticholinergic antihistamine', mechanisms: ['reduced_sweating'], cold: ['reduced_awareness_cold'] },
  { atc: 'R06AB', drugClass: 'anticholinergic antihistamine', mechanisms: ['reduced_sweating'], cold: ['reduced_awareness_cold'] },
  { atc: 'R06AD', drugClass: 'anticholinergic antihistamine', mechanisms: ['reduced_sweating'], cold: ['reduced_awareness_cold'] },
  { atc: 'N04A', drugClass: 'anticholinergic', mechanisms: ['reduced_sweating'] },
  { atc: 'G04BD', drugClass: 'anticholinergic', mechanisms: ['reduced_sweating'] },
  { atc: 'N05AN', drugClass: 'mood stabiliser', mechanisms: ['electrolyte_imbalance'] },
  { atc: 'N05A', drugClass: 'antipsychotic', mechanisms: ['reduced_sweating'], cold: ['impaired_shivering'] },
  { atc: 'N06AA', drugClass: 'tricyclic antidepressant', mechanisms: ['reduced_sweating'], cold: ['reduced_awareness_cold'] },
  { atc: 'N06AB', drugClass: 'SSRI', mechanisms: ['increased_sweating', 'hyponatremia_risk', 'reduced_thirst_or_sedation'] },
  { atc: 'N02A', drugClass: 'opiate', mechanisms: ['reduced_thirst_or_sedation'], cold: ['reduced_awareness_cold'] },
  { atc: 'N05BA', drugClass: 'benzodiazepine', mechanisms: ['reduced_thirst_or_sedation'], cold: ['reduced_awareness_cold'] },
  { atc: 'N05CD', drugClass: 'benzodiazepine', mechanisms: ['reduced_thirst_or_sedation'], cold: ['reduced_awareness_cold'] },
  { atc: 'N06BA', drugClass: 'stimulant', mechanisms: ['increased_heat_production'] },
  { atc: 'H03AA', drugClass: 'thyroid hormone', mechanisms: ['increased_sweating'] },
  { atc: 'J01AA', drugClass: 'tetracycline antibiotic', mechanisms: ['photosensitivity'] },
  { atc: 'J01MA', drugClass: 'fluoroquinolone antibiotic', mechanisms: ['photosensitivity'] },
  { atc: 'C10AA', drugClass: 'statin', mechanisms: ['photosensitivity'] },
];

/** The rule for an ATC class id, longest prefix first, or null when the class is not one the guidance covers. */
export function ruleFor(atcId: string): Rule | null {
  const id = atcId.toUpperCase();
  return [...RULES].sort((a, b) => b.atc.length - a.atc.length).find((r) => id.startsWith(r.atc)) ?? null;
}

/** What a medicine's class does in the cold, for a medicine that came from RxNorm and is not in meds.ts. */
export function coldByClass(drugClass: string): ColdMechanism[] {
  return RULES.find((r) => r.drugClass === drugClass)?.cold ?? [];
}

type Info = { minConcept?: { name?: unknown; tty?: unknown }; rxclassMinConceptItem?: { classId?: unknown } };

/**
 * Read an RxClass answer.
 *
 * Only single ingredients. "furosemide / potassium" is a combination product, and reading a combination as
 * one drug's class is how a wrong classification gets in. When the ingredients found fall into more than one
 * of our classes, the mechanisms are joined; when none does, the answer is null.
 */
export function parse(body: unknown): Classified | null {
  const list = (body as { rxclassDrugInfoList?: { rxclassDrugInfo?: unknown } } | null)?.rxclassDrugInfoList?.rxclassDrugInfo;
  if (!Array.isArray(list)) return null;
  const hits: { name: string; rule: Rule; atc: string }[] = [];
  for (const row of list as Info[]) {
    const name = typeof row.minConcept?.name === 'string' ? row.minConcept.name.toLowerCase().trim() : '';
    const atc = typeof row.rxclassMinConceptItem?.classId === 'string' ? row.rxclassMinConceptItem.classId : '';
    if (!name || !atc || row.minConcept?.tty !== 'IN' || name.includes('/')) continue;
    const rule = ruleFor(atc);
    if (rule) hits.push({ name, rule, atc });
  }
  if (!hits.length) return null;
  // One drug: the first ingredient named. A name that resolves to several different ingredients is ambiguous.
  const names = [...new Set(hits.map((h) => h.name))];
  if (names.length !== 1) return null;
  const mine = hits.filter((h) => h.name === names[0]);
  return {
    generic: names[0].slice(0, 60),
    drugClass: mine[0].rule.drugClass,
    mechanisms: [...new Set(mine.flatMap((h) => h.rule.mechanisms))],
    cold: [...new Set(mine.flatMap((h) => h.rule.cold ?? []))],
    atc: mine[0].atc,
    source: 'rxnorm',
  };
}

type Lookup = (name: string) => Promise<Classified | null>;

async function fetchClass(name: string, timeoutMs = 1500): Promise<Classified | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?drugName=${encodeURIComponent(name)}&relaSource=ATC`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return parse(await res.json());
  } catch {
    // Slow or down: the medicine is treated as unrecognised, which is the honest answer, not a guess.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let lookup: Lookup = (name) => fetchClass(name);

/** A spoken name to its class, or null. Only plain names are sent: nothing that could be anything but a drug name. */
export async function classify(spoken: string): Promise<Classified | null> {
  const name = spoken.toLowerCase().replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml)\b/g, '').replace(/\s+/g, ' ').trim();
  if (!/^[a-z][a-z0-9 -]{2,40}$/.test(name)) return null;
  return lookup(name);
}

export function configureForTest(fn: Lookup | null): void {
  lookup = fn ?? ((name) => fetchClass(name));
}
