/**
 * The equipment a hot day is dangerous without.
 *
 * `recalls.ts` watches openFDA's drug enforcement reports against the medicines
 * somebody takes. That covers half of what can be recalled out from under this
 * customer and misses the half that a power cut already makes dangerous.
 *
 * Sudor's own README makes the case: insulin that has to stay below 86F, an
 * oxygen concentrator that needs a socket, a dialysis chair that needs a working
 * clinic. Those are devices, and the FDA publishes device enforcement reports on
 * the same API, in the same shape, under a different endpoint. A Class I device
 * recall means a reasonable probability of serious injury or death, and an
 * insulin pump or a concentrator is exactly the kind of thing that carries one.
 *
 * Why this is a separate file from recalls.ts rather than a parameter to it.
 *
 * The matching problem is genuinely different. A drug has a generic name, and
 * openFDA indexes it in a structured field, so "lisinopril" is a precise query.
 * Devices have no equivalent: the only searchable text is
 * `product_description`, which is free text written by the manufacturer and
 * reads like "MAHURKAR 12 Fr High Pressure Triple Lumen Acute Dialysis
 * Catheter, 24 cm, Straight Extensions, IC Tray REF: 8888102004HP".
 *
 * Nobody says that to a voice assistant. They say "my oxygen concentrator".
 *
 * So this matches on equipment *category* rather than on a product, and is
 * explicit that it is doing so. It can say "there is an ongoing Class I recall
 * affecting oxygen concentrators, here is the firm and the reason, check whether
 * yours is one of them". It cannot say "your concentrator is recalled", and
 * pretending otherwise would either frighten somebody whose device is fine or
 * reassure somebody whose is not. The wording in `speak` is built around that
 * limit rather than apologising for it afterwards.
 *
 * Source: openFDA device enforcement reports,
 * https://open.fda.gov/apis/device/enforcement/
 */

const API = 'https://api.fda.gov/device/enforcement.json';

/** openFDA asks for no key below 1000 requests a day, which this is far under. */
const EVERY_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

/**
 * Equipment categories somebody might name, and the words that find them in a
 * manufacturer's product description.
 *
 * Each category carries why it belongs to a heat product, because that is the
 * only reason Sudor is allowed to be talking about devices at all: these are the
 * things whose failure, during heat or the power cut that follows it, is the
 * emergency rather than an inconvenience.
 */
export const CATEGORIES: Record<string, { terms: string[]; say: string; why: string }> = {
  oxygen_concentrator: {
    terms: ['oxygen concentrator', 'portable oxygen'],
    say: 'oxygen concentrators',
    why: 'it needs mains power, and a heat-driven outage takes it away',
  },
  insulin_pump: {
    terms: ['insulin pump', 'insulin infusion'],
    say: 'insulin pumps',
    why: 'insulin has to stay below 86 degrees and the pump is what delivers it',
  },
  glucose_monitor: {
    terms: ['glucose monitor', 'continuous glucose', 'blood glucose meter'],
    say: 'glucose monitors',
    why: 'heat changes how often blood sugar needs checking',
  },
  cpap: {
    terms: ['cpap', 'positive airway pressure', 'ventilator'],
    say: 'CPAP and ventilator equipment',
    why: 'it runs overnight on mains power, through the hottest nights',
  },
  dialysis: {
    terms: ['dialysis', 'hemodialysis catheter'],
    say: 'dialysis equipment',
    why: 'a missed session and a hot day compound each other',
  },
  infusion_pump: {
    terms: ['infusion pump'],
    say: 'infusion pumps',
    why: 'it delivers medication on a schedule that heat already complicates',
  },
  wheelchair: {
    terms: ['powered wheelchair', 'power wheelchair', 'mobility scooter'],
    say: 'powered wheelchairs and mobility scooters',
    why: 'losing it in the heat means losing the ability to reach shade',
  },
};

/** How each is said back to the person who owns one. */
export const OWN: Record<string, string> = {
  oxygen_concentrator: 'oxygen concentrator',
  insulin_pump: 'insulin pump',
  glucose_monitor: 'glucose monitor',
  cpap: 'breathing machine',
  dialysis: 'home dialysis machine',
  infusion_pump: 'infusion pump',
  wheelchair: 'powered wheelchair',
};

/** The ones that stop when the mains does, or run down within a day of it. */
export const NEEDS_POWER = ['oxygen_concentrator', 'cpap', 'dialysis', 'infusion_pump', 'wheelchair'];

export type DeviceRecall = {
  /** The category key this matched, not the product. */
  category: string;
  firm: string;
  description: string;
  reason: string;
  /** "Class I", "Class II", "Class III". */
  classification: string;
  status: string;
  /** YYYYMMDD as openFDA gives it. */
  initiated: string;
};

type Fetcher = (url: string) => Promise<unknown>;

const held = new Map<string, DeviceRecall[]>();
const checked = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setInterval>>();

let fetcher: Fetcher | null = null;

export function configureForTest(fn: Fetcher | null): void {
  fetcher = fn;
}

export function seedForTest(category: string, recalls: DeviceRecall[]): void {
  held.set(category, recalls);
  checked.set(category, Date.now());
}

export function resetForTest(): void {
  held.clear();
  checked.clear();
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
  fetcher = null;
}

async function getJson(url: string): Promise<unknown> {
  if (fetcher) return fetcher(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    // openFDA answers 404 for a search with no matches, which is a normal
    // outcome and not a fault: it means nothing in that category is recalled.
    if (res.status === 404) return { results: [] };
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve whatever the customer said to a category, or nothing.
 *
 * Deliberately generous on the way in, because the category list is closed and
 * short: it is better to match "my oxygen machine" to oxygen concentrators than
 * to tell somebody on home oxygen that their equipment is not something Sudor
 * knows about.
 */
export function categoryFor(spoken: string): string | null {
  const s = spoken.toLowerCase().trim();
  if (!s) return null;
  for (const [key, def] of Object.entries(CATEGORIES)) {
    if (s.includes(key.replace(/_/g, ' '))) return key;
    for (const term of def.terms) if (s.includes(term)) return key;
  }
  // A few things people actually say that no product description contains.
  if (/oxygen|concentrator/.test(s)) return 'oxygen_concentrator';
  if (/\bpump\b/.test(s) && /insulin|diabet/.test(s)) return 'insulin_pump';
  if (/sleep apnea|apnoea|breathing machine/.test(s)) return 'cpap';
  if (/kidney|renal/.test(s)) return 'dialysis';
  if (/scooter|wheelchair/.test(s)) return 'wheelchair';
  return null;
}

export async function refresh(category: string): Promise<void> {
  const def = CATEGORIES[category];
  if (!def) return;
  // One OR query across the category's terms, so a category costs one request
  // rather than one per phrase.
  const terms = def.terms.map((t) => `product_description:%22${encodeURIComponent(t)}%22`).join('+');
  const url = `${API}?search=(${terms})+AND+status:%22Ongoing%22&limit=10`;
  try {
    const body = (await getJson(url)) as { results?: Record<string, unknown>[] };
    const rows = body.results ?? [];
    held.set(
      category,
      rows.map((r) => ({
        category,
        firm: String(r.recalling_firm ?? 'an unnamed firm'),
        description: String(r.product_description ?? ''),
        reason: String(r.reason_for_recall ?? ''),
        classification: String(r.classification ?? ''),
        status: String(r.status ?? ''),
        initiated: String(r.recall_initiation_date ?? ''),
      })),
    );
    checked.set(category, Date.now());
  } catch {
    // Keep whatever was known. A recall that cannot be fetched is not a recall
    // that has been withdrawn, and saying nothing is the safe direction here
    // only because the previous answer is preserved rather than cleared.
  }
}

/** Follow a category on a slow timer. Recalls are published in days, not minutes. */
export function watch(category: string): void {
  if (!CATEGORIES[category] || timers.has(category)) return;
  void refresh(category);
  const t = setInterval(() => void refresh(category), EVERY_MS);
  t.unref?.();
  timers.set(category, t);
}

export function known(category: string): DeviceRecall[] | null {
  return held.get(category) ?? null;
}

export function checkedAt(category: string): number | null {
  return checked.get(category) ?? null;
}

/** Class I first: reasonable probability of serious injury or death. */
export function rank(recalls: DeviceRecall[]): DeviceRecall[] {
  const order = (c: string) => (c.includes('I I') || c === 'Class III' ? 3 : c === 'Class II' ? 2 : 1);
  return [...recalls].sort((a, b) => order(a.classification) - order(b.classification)
    || b.initiated.localeCompare(a.initiated));
}

/**
 * One recall, spoken.
 *
 * The category is always named and the product never claimed. "Affecting oxygen
 * concentrators" is true; "your oxygen concentrator is recalled" is not
 * something this data can support, and the difference matters most to exactly
 * the person least able to absorb a false alarm.
 */
export function speak(recall: DeviceRecall, brief = false): string {
  const def = CATEGORIES[recall.category];
  // "a Class one recall, which is the most serious grade, affecting oxygen
  // concentrators" puts the relative clause on the grade rather than on the
  // equipment, which is what it describes. Em-dashes keep it attached correctly
  // and still read aloud cleanly.
  const klass = recall.classification === 'Class I'
    ? 'a Class one recall, the most serious grade,'
    : `a ${recall.classification.toLowerCase()} recall`;

  // Manufacturer names routinely end in "Inc." or "Ltd.", and appending a full
  // stop to those gives "Inc..", which a speech engine reads as a pause it
  // should not take.
  const firm = recall.firm.replace(/\.+$/, '');
  const head = `There is ${klass} affecting some ${def?.say ?? 'equipment'} from ${firm}.`;
  if (brief) return head;

  const reason = recall.reason ? ` The reason given is: ${trim(recall.reason, 180)}` : '';
  return (
    `${head}${reason} That does not mean yours is affected. Check the model against the notice, ` +
    'or ask your supplier, before changing anything about how you use it.'
  );
}

function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean.endsWith('.') ? clean : `${clean}.`;
  return `${clean.slice(0, max).replace(/[,;\s]\S*$/, '')}.`;
}

/**
 * What to say about a person's registered equipment, or nothing.
 *
 * Only Class I is volunteered. The lower grades are real but they are not worth
 * interrupting a heat plan for, and this runs inside an answer about whether to
 * go outside.
 */
export function urgent(categories: string[]): string {
  for (const category of categories) {
    const list = rank(known(category) ?? []).filter((r) => r.classification === 'Class I');
    if (list.length) return speak(list[0], true) + ' Ask me about it when you have a moment.';
  }
  return '';
}
