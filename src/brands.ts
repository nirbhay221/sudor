/**
 * Medicine names from outside the United States.
 *
 * The drug database Sudor asks (the National Library of Medicine's RxNorm) is American. Most generic names are
 * the same everywhere, but two kinds of name are not:
 *
 *   International names that differ from the American one. The WHO's International Nonproprietary Name and
 *   the United States Adopted Name are the same for almost every medicine, and different for a well known
 *   handful: salbutamol is albuterol, paracetamol is acetaminophen, frusemide is furosemide. Those are listed
 *   below, from the INN and USAN lists.
 *
 *   Brand names, which differ in every country. For India, which makes and exports a large share of the
 *   world's generic medicines, `assets/india-brands.json` holds about 174,000 brand names with their
 *   ingredients, built from the A-Z Medicine Dataset of India (CC BY-SA 4.0) by scripts/build-india-brands.py.
 *   A brand is kept only when every product under it has the same ingredients.
 *
 * The answer always says what a brand was read as ("Amlong is amlodipine"), so a wrong reading is heard.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** International name, or an older British or Indian spelling, to the name RxNorm and the CDC table use. */
const US_NAME: Record<string, string> = {
  salbutamol: 'albuterol',
  levosalbutamol: 'levalbuterol',
  paracetamol: 'acetaminophen',
  frusemide: 'furosemide',
  adrenaline: 'epinephrine',
  noradrenaline: 'norepinephrine',
  glibenclamide: 'glyburide',
  lignocaine: 'lidocaine',
  amoxycillin: 'amoxicillin',
  bendrofluazide: 'bendroflumethiazide',
  dothiepin: 'dosulepin',
  ciclosporin: 'cyclosporine',
  cyclosporin: 'cyclosporine',
  thyroxine: 'levothyroxine',
  levothyroxin: 'levothyroxine',
  oestradiol: 'estradiol',
  colecalciferol: 'cholecalciferol',
  mesalazine: 'mesalamine',
  sulphasalazine: 'sulfasalazine',
  isoprenaline: 'isoproterenol',
  chlorphenamine: 'chlorpheniramine',
  pethidine: 'meperidine',
  torasemide: 'torsemide',
  rifampicin: 'rifampin',
  valproic: 'valproate',
  aciclovir: 'acyclovir',
  cefalexin: 'cephalexin',
  clomifene: 'clomiphene',
  dicycloverine: 'dicyclomine',
  hyoscine: 'scopolamine',
  orciprenaline: 'metaproterenol',
  benzhexol: 'trihexyphenidyl',
  trihexyphenidyl: 'trihexyphenidyl',
  'glyceryl trinitrate': 'nitroglycerin',
  'sodium valproate': 'valproate',
  'valproic acid': 'valproate',
  'clavulanic acid': 'clavulanate',
};

/** The name to look up for something somebody said, after the international spellings. */
export function usName(spoken: string): string {
  const s = spoken.toLowerCase().trim().replace(/\s+/g, ' ');
  return US_NAME[s] ?? s;
}

/*
 * Brand lists, one per country, each from that country's own regulator (scripts/build-country-brands.py and
 * scripts/build-india-brands.py): India, Canada, France, Brazil and Italy. The person's own country is looked in
 * first, because the same name can be a different medicine elsewhere; then the others. Spain has no download,
 * so its regulator's search service is asked live (lookupSpain).
 */
const COUNTRIES = ['IN', 'CA', 'FR', 'BR', 'IT'];
const lists = new Map<string, Record<string, string[]>>();
function listFor(cc: string): Record<string, string[]> {
  const held = lists.get(cc);
  if (held) return held;
  let list: Record<string, string[]> = {};
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = cc === 'IN' ? 'india-brands.json' : `brands-${cc}.json`;
    list = (JSON.parse(readFileSync(resolve(here, '..', 'assets', file), 'utf8')) as { brands?: Record<string, string[]> }).brands ?? {};
  } catch {
    list = {};
  }
  lists.set(cc, list);
  return list;
}

/** Accents off, lower case: "Furosémide" and "furosemide" are the same word here. */
export const plain = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const english = new Map<string, string | null>();
/**
 * An ingredient in another language, "nifedipino", "furosémide", "levotiroxina", to the English name the drug
 * database and the CDC table use. Many are synonyms the National Library of Medicine already holds; for the
 * rest its approximate match is asked, and the answer is kept only when the English name is spelled within a
 * quarter of the word of what was said. That rule is what stops "nifedipine" with a French accent being read as
 * budipine, a different drug, which the approximate match alone returned.
 */
export async function englishName(name: string): Promise<string | null> {
  const bare = plain(name);
  // A name the international list already answers (paracétamol, salbutamol) needs no lookup.
  if (usName(bare) !== bare) return usName(bare);
  const said = bare;
  if (english.has(said)) return english.get(said) ?? null;
  let found: string | null = null;
  try {
    const q = new URLSearchParams({ term: said, maxEntries: '1' });
    const body = (await getJson(`https://rxnav.nlm.nih.gov/REST/approximateTerm.json?${q}`)) as { approximateGroup?: { candidate?: { rxcui?: string }[] } };
    const cui = body.approximateGroup?.candidate?.[0]?.rxcui;
    if (cui) {
      const props = (await getJson(`https://rxnav.nlm.nih.gov/REST/rxcui/${cui}/properties.json`)) as { properties?: { name?: string; tty?: string } };
      const en = props.properties?.tty === 'IN' ? props.properties.name : undefined;
      if (en && editDistance(said, plain(en)) <= Math.max(1, Math.floor(said.length / 4))) found = en.toLowerCase();
    }
  } catch {
    found = null;
  }
  english.set(said, found);
  if (english.size > 5000) english.delete(english.keys().next().value as string);
  return found;
}

/** Spain: the AEMPS search service, live. The first product whose name begins with what was said. */
export async function lookupSpain(spoken: string): Promise<string[] | null> {
  try {
    const q = new URLSearchParams({ nombre: spoken.trim(), pagina: '1' });
    const body = (await getJson(`https://cima.aemps.es/cima/rest/medicamentos?${q}`)) as { resultados?: { nombre?: string; vtm?: { nombre?: string } }[] };
    const hit = (body.resultados ?? []).find((r) => plain(r.nombre ?? '').startsWith(plain(spoken)) && r.vtm?.nombre);
    return hit?.vtm?.nombre ? hit.vtm.nombre.split(/\s*\+\s*|\s+y\s+/).map((x) => x.trim()).filter(Boolean) : null;
  } catch {
    return null;
  }
}

/**
 * A brand said aloud, "Amlong 5" or "Telma tablet", to its ingredients in the names the rest of Sudor uses.
 * Null when it is not a brand in the list, which is most of the time somebody says a generic name.
 */
export type BrandHit = { brand: string; ingredients: string[]; country: string; ambiguous?: { country: string; ingredients: string[] }[] };
export function ingredientsOf(spoken: string, country?: string | null): BrandHit | null {
  const s = spoken
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml)?\b/g, ' ')
    .replace(/\b(tablets?|tab|capsules?|cap|syrup|injection|drops|inhaler|xr|sr|er|cr|od|md|dt)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 3) return null;
  const own = (country ?? '').toUpperCase();
  // The person's own country decides when it has a list and the brand is on it.
  if (COUNTRIES.includes(own)) {
    const hit = listFor(own)[s] ?? listFor(own)[plain(s)];
    if (hit?.length) return { brand: s, ingredients: [...new Set(hit.map((i) => usName(i)))], country: own };
  }
  // Otherwise every list is asked, and a name that means different medicines in different countries is not
  // guessed: Triatec is ramipril in Italy and France and acetaminophen with codeine in Canada.
  const found = COUNTRIES.filter((cc) => cc !== own)
    .map((cc) => ({ cc, hit: listFor(cc)[s] ?? listFor(cc)[plain(s)] }))
    .filter((x): x is { cc: string; hit: string[] } => !!x.hit?.length);
  if (!found.length) return null;
  // Two lists mean the same medicine when their ingredients pair up, each spelled within a quarter of the word of
  // the other: "furosemida" and "furosemide", "anlodipino" and "amlodipine" are one drug in two spellings.
  const stem = (i: string) =>
    plain(usName(i))
      .replace(/\b(acido|acide|acid|erbumine|arginine|tert-?butylamine|trihydratee?|trihydrate|dihydrate|monohydrate|sodium|sodique|sodico|potassium|potassique|potassico|calcium|hydrochloride|chlorhydrate|cloridrato|maleate|besilate|besylate|mesylate|tartrate|succinate)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(e|a|o)$/, '');
  const same = (a: string[], b: string[]) => {
    const x = [...new Set(a.map(stem))].sort();
    const y = [...new Set(b.map(stem))].sort();
    return x.length === y.length && x.every((w) => y.some((v) => editDistance(w, v) <= Math.max(1, Math.floor(Math.max(w.length, v.length) / 4))));
  };
  const differ = found.some((f) => !same(f.hit, found[0].hit));
  if (differ) {
    return { brand: s, ingredients: [], country: '', ambiguous: found.map((f) => ({ country: f.cc, ingredients: [...new Set(f.hit.map((i) => usName(i)))] })) };
  }
  return { brand: s, ingredients: [...new Set(found[0].hit.map((i) => usName(i)))], country: found[0].cc };
}

export const brandCount = (): number => COUNTRIES.reduce((n, cc) => n + Object.keys(listFor(cc)).length, 0);
