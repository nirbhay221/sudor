/**
 * Which medications change how your body handles heat, and how.
 *
 * Every entry below is drawn from the CDC's clinical guidance for
 * heat-and-medications (Heat Health, cdc.gov/heat-health/hcp/clinical-guidance),
 * which groups drugs by mechanism rather than by class name, because the
 * mechanism is what determines the danger and the guidance. This file keeps
 * that structure: a drug can appear under more than one mechanism, because
 * some genuinely act on more than one axis (thiazide diuretics disturb
 * electrolytes AND sensitise skin to the sun; that is not a data error).
 *
 * This is a static, hand-verified table, not a live drug-interaction API call.
 * Classifying a medication has to be instant and offline, because the tool
 * that uses it runs inside Alexa+'s 500 ms budget, and openFDA alone measured
 * 660 ms for a single label lookup. A wrong classification here is worse than
 * a missing one, so the table only contains what the CDC guidance states.
 */

export type Mechanism =
  /** Cannot sweat normally, so cannot shed heat. The most dangerous mechanism:
   *  heat stroke can arrive without the warning signs a sweating person gets. */
  | 'reduced_sweating'
  /** Sweats more than usual, which is a fluid-loss and dehydration risk, not a
   *  cooling failure. The opposite direction, and it needs the opposite advice. */
  | 'increased_sweating'
  /** Disturbs sodium, potassium or fluid balance, worse once heavy sweating starts. */
  | 'electrolyte_imbalance'
  | 'hyponatremia_risk'
  /** Blunts thirst or judgement, so the person does not notice they need water
   *  until they are already behind on it. */
  | 'reduced_thirst_or_sedation'
  /** Raises the body's own heat production, on top of whatever the day adds. */
  | 'increased_heat_production'
  /** Sensitises skin to UV. A sun-exposure risk, not a heat-illness risk, and it
   *  is tracked and reported separately for exactly that reason. */
  | 'photosensitivity'
  /**
   * Loses fluid by a route that has nothing to do with sweating.
   *
   * This needed its own mechanism rather than being folded into
   * `electrolyte_imbalance`, because the advice is different and so is the reason.
   *
   * A GLP-1 drug slows the stomach and causes nausea, vomiting or loose stools,
   * and the reported consequence is twofold: fluid goes out, and nausea makes the
   * person less willing to drink. The literature ties that to significant
   * dehydration and secondary acute kidney injury, and the standing advice is to
   * drink plenty to avoid volume depletion.
   *
   * An SGLT2 inhibitor does it a different way: glucose in the urine drives an
   * osmotic diuresis and free water goes with it. Volume depletion events are
   * measurably more common in patients over 75, which is most of this product's
   * audience, and the published note is explicit that people with type 2 diabetes
   * carry an increased risk of dehydration in hot weather.
   *
   * Neither is a cooling failure and neither is a salt problem, so telling somebody
   * to take something salty, which is right for a thiazide, is not the answer here.
   * Steady plain fluid is.
   */
  | 'fluid_loss';

/**
 * The same medicine cabinet, read for cold.
 *
 * StatPearls names the drugs that impair the body's response to cold directly:
 * "beta-blockers, clonidine, antipsychotic agents, sedative-hypnotics, ethanol,
 * and anesthetic medications". They act in three different ways, and the advice
 * differs by which, so they are separated rather than lumped into one warning.
 *
 * Source: StatPearls, Hypothermia. https://www.ncbi.nlm.nih.gov/books/NBK545239/
 */
export type ColdMechanism =
  /** Blunts the heart's response, so the body makes and moves less heat. Beta blockers. */
  | 'reduced_heat_production'
  /** Interferes with the body's thermostat and blunts shivering. Antipsychotics. */
  | 'impaired_shivering'
  /** Sedating, so the person does not notice the cold or act on it. */
  | 'reduced_awareness_cold';

export const COLD_MECHANISM_SAY: Record<ColdMechanism, string> = {
  reduced_heat_production: 'it blunts the heart\'s response, so your body makes heat more slowly than it loses it',
  impaired_shivering: 'it can interfere with the body\'s thermostat and blunt shivering, so you can get dangerously cold without feeling it',
  reduced_awareness_cold: 'it can make you drowsy, so you may not notice how cold you are getting',
};

export type Medication = {
  generic: string;
  /** What a person actually calls it, for matching speech. */
  aliases: string[];
  drugClass: string;
  mechanisms: Mechanism[];
  /** How it changes the body's response to cold, where a source says it does. */
  cold?: ColdMechanism[];
};

/**
 * "a" or "an" before drugClass, spoken aloud in the register_medication reply.
 * Deliberately an explicit table over the classes this file actually uses,
 * not a first-letter heuristic: ACE, ARB, SSRI and SNRI are said as letters
 * ("ay-see-ee", "ess-ess-are-eye"), which start with a vowel SOUND despite
 * starting with a consonant letter, and a heuristic would get every one of
 * them wrong. Since every class this file emits is enumerated below, there
 * is no reason to guess when the true answer can just be declared.
 */
const AN_CLASSES = new Set([
  'ACE inhibitor', 'ARB', 'anticholinergic antihistamine', 'antihistamine',
  'atypical antipsychotic', 'anticonvulsant', 'opiate', 'SSRI', 'SNRI', 'anticholinergic', 'antipsychotic',
]);
export function articleFor(drugClass: string): 'a' | 'an' {
  return AN_CLASSES.has(drugClass) ? 'an' : 'a';
}

/**
 * Source: CDC Heat and Medications, Guidance for Clinicians. Generic names as
 * given there. Brand names in `aliases` are the common US ones, added because
 * people say "my Lasix" or "my Zoloft", not the generic name on the bottle.
 */
export const MEDICATIONS: Medication[] = [
  // ---- Diuretics: electrolyte imbalance; thiazides also photosensitise ----
  { generic: 'furosemide', aliases: ['lasix'], drugClass: 'loop diuretic', mechanisms: ['electrolyte_imbalance'] },
  { generic: 'hydrochlorothiazide', aliases: ['hctz', 'microzide'], drugClass: 'thiazide diuretic', mechanisms: ['electrolyte_imbalance', 'hyponatremia_risk', 'photosensitivity'] },
  { generic: 'chlorthalidone', aliases: ['thalitone'], drugClass: 'thiazide-like diuretic', mechanisms: ['electrolyte_imbalance', 'hyponatremia_risk', 'photosensitivity'] },
  { generic: 'acetazolamide', aliases: ['diamox'], drugClass: 'diuretic', mechanisms: ['electrolyte_imbalance'] },

  // ---- Beta blockers: electrolyte imbalance AND reduced sweating ----
  { generic: 'atenolol', aliases: ['tenormin'], drugClass: 'beta blocker', mechanisms: ['electrolyte_imbalance', 'reduced_sweating'], cold: ['reduced_heat_production'] },
  { generic: 'metoprolol', aliases: ['lopressor', 'toprol'], drugClass: 'beta blocker', mechanisms: ['electrolyte_imbalance', 'reduced_sweating'], cold: ['reduced_heat_production'] },
  { generic: 'propranolol', aliases: ['inderal'], drugClass: 'beta blocker', mechanisms: ['electrolyte_imbalance', 'reduced_sweating'], cold: ['reduced_heat_production'] },

  // ---- Calcium channel blockers: electrolyte imbalance ----
  { generic: 'amlodipine', aliases: ['norvasc'], drugClass: 'calcium channel blocker', mechanisms: ['electrolyte_imbalance'] },
  { generic: 'felodipine', aliases: ['plendil'], drugClass: 'calcium channel blocker', mechanisms: ['electrolyte_imbalance'] },
  { generic: 'nifedipine', aliases: ['procardia'], drugClass: 'calcium channel blocker', mechanisms: ['electrolyte_imbalance'] },

  // ---- ACE inhibitors and ARBs: reduced thirst sensation ----
  { generic: 'lisinopril', aliases: ['prinivil', 'zestril'], drugClass: 'ACE inhibitor', mechanisms: ['reduced_thirst_or_sedation'] },
  { generic: 'enalapril', aliases: ['vasotec'], drugClass: 'ACE inhibitor', mechanisms: ['reduced_thirst_or_sedation'] },
  { generic: 'ramipril', aliases: ['altace'], drugClass: 'ACE inhibitor', mechanisms: ['reduced_thirst_or_sedation'] },
  { generic: 'losartan', aliases: ['cozaar'], drugClass: 'ARB', mechanisms: ['reduced_thirst_or_sedation'] },
  { generic: 'valsartan', aliases: ['diovan'], drugClass: 'ARB', mechanisms: ['reduced_thirst_or_sedation'] },

  // ---- GLP-1 receptor agonists: fluid out, and less willingness to put it back ----
  //
  // The most-prescribed new drug class in America, and absent from this table until
  // now, which was a real hole rather than a rounding error. The mechanism is not
  // sweating: delayed gastric emptying with nausea, vomiting or diarrhoea, which
  // loses fluid and simultaneously makes somebody not want to drink. Reported to
  // cause significant dehydration and secondary acute renal impairment.
  { generic: 'semaglutide', aliases: ['ozempic', 'wegovy', 'rybelsus'], drugClass: 'GLP-1 agonist', mechanisms: ['fluid_loss'] },
  { generic: 'tirzepatide', aliases: ['mounjaro', 'zepbound'], drugClass: 'GLP-1 and GIP agonist', mechanisms: ['fluid_loss'] },
  { generic: 'liraglutide', aliases: ['victoza', 'saxenda'], drugClass: 'GLP-1 agonist', mechanisms: ['fluid_loss'] },
  { generic: 'dulaglutide', aliases: ['trulicity'], drugClass: 'GLP-1 agonist', mechanisms: ['fluid_loss'] },
  { generic: 'exenatide', aliases: ['byetta', 'bydureon'], drugClass: 'GLP-1 agonist', mechanisms: ['fluid_loss'] },

  // ---- SGLT2 inhibitors: an osmotic diuresis nobody thinks of as a diuretic ----
  //
  // Glucose in the urine drags free water with it. Volume depletion events are
  // measurably more common over 75, which is much of this audience, and the
  // published guidance is explicit that type 2 diabetes already carries a raised
  // dehydration risk in hot weather. People do not describe these as water pills,
  // so they will not mention them when asked about diuretics.
  { generic: 'empagliflozin', aliases: ['jardiance'], drugClass: 'SGLT2 inhibitor', mechanisms: ['fluid_loss'] },
  { generic: 'dapagliflozin', aliases: ['farxiga', 'forxiga'], drugClass: 'SGLT2 inhibitor', mechanisms: ['fluid_loss'] },
  { generic: 'canagliflozin', aliases: ['invokana'], drugClass: 'SGLT2 inhibitor', mechanisms: ['fluid_loss'] },
  { generic: 'ertugliflozin', aliases: ['steglatro'], drugClass: 'SGLT2 inhibitor', mechanisms: ['fluid_loss'] },

  // ---- Anticholinergics: reduced sweating ----
  { generic: 'diphenhydramine', aliases: ['benadryl'], drugClass: 'anticholinergic antihistamine', mechanisms: ['reduced_sweating', 'photosensitivity'], cold: ['reduced_awareness_cold']  },
  { generic: 'doxylamine', aliases: ['unisom'], drugClass: 'anticholinergic antihistamine', mechanisms: ['reduced_sweating'], cold: ['reduced_awareness_cold']  },
  { generic: 'promethazine', aliases: ['phenergan'], drugClass: 'anticholinergic antihistamine', mechanisms: ['reduced_sweating', 'photosensitivity'], cold: ['reduced_awareness_cold']  },
  { generic: 'cetirizine', aliases: ['zyrtec'], drugClass: 'antihistamine', mechanisms: ['photosensitivity'] },
  { generic: 'loratadine', aliases: ['claritin'], drugClass: 'antihistamine', mechanisms: ['photosensitivity'] },

  // ---- Antipsychotics: reduced sweating ----
  { generic: 'haloperidol', aliases: ['haldol'], drugClass: 'typical antipsychotic', mechanisms: ['reduced_sweating'], cold: ['impaired_shivering']  },
  { generic: 'olanzapine', aliases: ['zyprexa'], drugClass: 'atypical antipsychotic', mechanisms: ['reduced_sweating'], cold: ['impaired_shivering']  },
  { generic: 'quetiapine', aliases: ['seroquel'], drugClass: 'atypical antipsychotic', mechanisms: ['reduced_sweating'], cold: ['impaired_shivering']  },
  { generic: 'risperidone', aliases: ['risperdal'], drugClass: 'atypical antipsychotic', mechanisms: ['reduced_sweating'], cold: ['impaired_shivering']  },

  // ---- Tricyclic antidepressants: reduced sweating ----
  { generic: 'amitriptyline', aliases: ['elavil'], drugClass: 'tricyclic antidepressant', mechanisms: ['reduced_sweating'], cold: ['reduced_awareness_cold']  },
  { generic: 'clomipramine', aliases: ['anafranil'], drugClass: 'tricyclic antidepressant', mechanisms: ['reduced_sweating'], cold: ['reduced_awareness_cold']  },

  // ---- SSRIs and SNRIs: increased sweating, and reduced thirst/sedation ----
  { generic: 'fluoxetine', aliases: ['prozac'], drugClass: 'SSRI', mechanisms: ['increased_sweating', 'hyponatremia_risk', 'reduced_thirst_or_sedation'] },
  { generic: 'sertraline', aliases: ['zoloft'], drugClass: 'SSRI', mechanisms: ['increased_sweating', 'hyponatremia_risk', 'reduced_thirst_or_sedation'] },
  { generic: 'duloxetine', aliases: ['cymbalta'], drugClass: 'SNRI', mechanisms: ['increased_sweating', 'reduced_thirst_or_sedation'] },
  { generic: 'venlafaxine', aliases: ['effexor'], drugClass: 'SNRI', mechanisms: ['increased_sweating', 'reduced_thirst_or_sedation'] },

  // ---- Anticonvulsants ----
  { generic: 'topiramate', aliases: ['topamax'], drugClass: 'anticonvulsant', mechanisms: ['reduced_sweating'] },
  { generic: 'oxcarbazepine', aliases: ['trileptal'], drugClass: 'anticonvulsant', mechanisms: ['increased_sweating'] },

  // ---- Opiates and benzodiazepines: reduced thirst / sedation ----
  { generic: 'oxycodone', aliases: ['oxycontin', 'percocet'], drugClass: 'opiate', mechanisms: ['reduced_thirst_or_sedation'], cold: ['reduced_awareness_cold']  },
  { generic: 'hydrocodone', aliases: ['vicodin', 'norco'], drugClass: 'opiate', mechanisms: ['reduced_thirst_or_sedation'], cold: ['reduced_awareness_cold']  },
  { generic: 'alprazolam', aliases: ['xanax'], drugClass: 'benzodiazepine', mechanisms: ['reduced_thirst_or_sedation'], cold: ['reduced_awareness_cold']  },
  { generic: 'lorazepam', aliases: ['ativan'], drugClass: 'benzodiazepine', mechanisms: ['reduced_thirst_or_sedation'], cold: ['reduced_awareness_cold']  },

  // ---- Lithium: electrolyte imbalance, narrow therapeutic window ----
  { generic: 'lithium', aliases: ['lithobid'], drugClass: 'mood stabiliser', mechanisms: ['electrolyte_imbalance'] },

  // ---- Stimulants: increased heat production ----
  { generic: 'methylphenidate', aliases: ['ritalin', 'concerta'], drugClass: 'stimulant', mechanisms: ['increased_heat_production'] },
  { generic: 'amphetamine', aliases: ['adderall'], drugClass: 'stimulant', mechanisms: ['increased_heat_production'] },
  { generic: 'lisdexamfetamine', aliases: ['vyvanse'], drugClass: 'stimulant', mechanisms: ['increased_heat_production'] },

  // ---- Thyroid replacement: increased sweating ----
  { generic: 'levothyroxine', aliases: ['synthroid'], drugClass: 'thyroid hormone', mechanisms: ['increased_sweating'] },

  // ---- Antibiotics: photosensitivity ----
  { generic: 'doxycycline', aliases: ['vibramycin'], drugClass: 'tetracycline antibiotic', mechanisms: ['photosensitivity'] },
  { generic: 'minocycline', aliases: ['minocin'], drugClass: 'tetracycline antibiotic', mechanisms: ['photosensitivity'] },
  { generic: 'ciprofloxacin', aliases: ['cipro'], drugClass: 'fluoroquinolone antibiotic', mechanisms: ['photosensitivity'] },
  { generic: 'levofloxacin', aliases: ['levaquin'], drugClass: 'fluoroquinolone antibiotic', mechanisms: ['photosensitivity'] },
  { generic: 'trimethoprim-sulfamethoxazole', aliases: ['bactrim', 'septra'], drugClass: 'sulfonamide antibiotic', mechanisms: ['electrolyte_imbalance', 'photosensitivity'] },

  // ---- Statins: photosensitivity ----
  { generic: 'simvastatin', aliases: ['zocor'], drugClass: 'statin', mechanisms: ['photosensitivity'] },
  { generic: 'atorvastatin', aliases: ['lipitor'], drugClass: 'statin', mechanisms: ['photosensitivity'] },
];

const byName = new Map<string, Medication>();
for (const m of MEDICATIONS) {
  byName.set(m.generic.toLowerCase(), m);
  for (const a of m.aliases) byName.set(a.toLowerCase(), m);
}

/** Loose match on what a person actually says: case-insensitive, trims dosage noise. */
export function findMedication(spoken: string): Medication | null {
  const clean = spoken
    .toLowerCase()
    .trim()
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return byName.get(clean) ?? byName.get(clean.split(' ')[0]) ?? null;
}

export const MECHANISM_LABEL: Record<Mechanism, string> = {
  reduced_sweating: 'blocks your sweating',
  hyponatremia_risk: 'can send your sodium too low',
  increased_sweating: 'makes you sweat more than usual',
  electrolyte_imbalance: 'disturbs your electrolytes',
  reduced_thirst_or_sedation: 'blunts your thirst or alertness',
  increased_heat_production: 'raises your own heat production',
  photosensitivity: 'makes your skin burn faster in the sun',
  fluid_loss: 'makes you lose fluid faster than you notice',
};

/** The same effects as verb phrases, for "your medications can also ...". */
export const MECHANISM_BASE: Record<Mechanism, string> = {
  reduced_sweating: 'block your sweating',
  increased_sweating: 'make you sweat more than usual',
  electrolyte_imbalance: 'disturb your electrolytes',
  hyponatremia_risk: 'send your sodium too low',
  reduced_thirst_or_sedation: 'blunt your thirst or alertness',
  increased_heat_production: 'raise your own heat production',
  photosensitivity: 'make your skin burn faster in the sun',
  fluid_loss: 'make you lose fluid faster than you notice',
};

/**
 * Known medications whose names are close to what was heard.
 *
 * For the case `findMedication` cannot serve: a name that is not an exact match
 * but is one or two characters away from something in the table. Drug names are
 * the hardest thing a speech system has to transcribe, and several in this table
 * differ by a syllable while doing opposite things in heat, so a near miss is
 * worth asking about and never worth assuming.
 *
 * Levenshtein rather than a phonetic key: the failure being corrected is usually
 * a transcription slip of one or two letters, not a homophone, and a phonetic
 * match would happily collapse names that need to stay apart.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

export function nearMatches(spoken: string, limit = 3): Medication[] {
  const want = spoken.toLowerCase().replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml)\b/g, '').replace(/\s+/g, ' ').trim();
  if (want.length < 4) return [];

  // One edit for a short name, two for a longer one. A flat threshold of two
  // would make four-letter names match most of the table.
  const budget = want.length <= 7 ? 1 : 2;

  const scored: { med: Medication; d: number }[] = [];
  const seen = new Set<string>();
  for (const med of MEDICATIONS) {
    for (const name of [med.generic, ...med.aliases]) {
      const d = editDistance(want, name.toLowerCase());
      if (d > 0 && d <= budget && !seen.has(med.generic)) {
        scored.push({ med, d });
        seen.add(med.generic);
        break;
      }
    }
  }
  return scored.sort((a, b) => a.d - b.d || a.med.generic.localeCompare(b.med.generic))
    .slice(0, limit)
    .map((s) => s.med);
}
